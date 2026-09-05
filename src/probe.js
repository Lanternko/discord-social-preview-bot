const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
  THREADS_PROBE_NODE,
  THREADS_PROBE_SCRIPT,
  THREADS_PROBE_TIMEOUT_MS,
  THREADS_PROBE_MAX_CONCURRENT,
  THREADS_METADATA_CACHE_TTL_MS,
} = require("./config");

const execFileAsync = promisify(execFile);

// Every probe is a full chromium. Unbounded, a busy channel starts a dozen at
// once and they starve each other's rendering — the page then reports zero
// media because the DOM hasn't been laid out yet, and a video post degrades to
// a still cover frame. Queue instead of racing: waiting a beat for a slot is
// cheaper than a probe that returns wrong metadata.
let activeProbes = 0;
const probeWaiters = [];

async function acquireProbeSlot() {
  if (activeProbes >= THREADS_PROBE_MAX_CONCURRENT) {
    await new Promise((resolve) => probeWaiters.push(resolve));
  }
  activeProbes += 1;
}

function releaseProbeSlot() {
  activeProbes -= 1;
  probeWaiters.shift()?.();
}

const threadsMetadataCache = new Map();

function cleanupThreadsMetadataCache() {
  const now = Date.now();
  for (const [url, entry] of threadsMetadataCache.entries()) {
    if (now - entry.cachedAt > THREADS_METADATA_CACHE_TTL_MS) {
      threadsMetadataCache.delete(url);
    }
  }
}

async function runProbe(url) {
  await acquireProbeSlot();
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      THREADS_PROBE_NODE,
      [THREADS_PROBE_SCRIPT, url],
      {
        timeout: THREADS_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    ));
  } finally {
    releaseProbeSlot();
  }
  if (stderr && stderr.trim()) {
    console.warn(`[probe] stderr ${url}: ${stderr.trim()}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const preview = stdout.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(
      `probe returned invalid JSON for ${url}: ${error.message} (stdout: ${preview})`,
    );
  }
}

// Threads serves a logged-out interstitial ("Threads • Log in" + a generic
// "Join Threads to share ideas..." description, no media) when it walls a probe
// — common on sensitive / flagged posts. Treat it as a probe failure so
// buildThreadsPayload falls through to the fixer chain (which CAN fetch the real
// content) instead of rendering a useless "Threads • Log in" card.
function isThreadsLoginWall(metadata) {
  if (!metadata) return false;
  const title = (metadata.title || "").trim();
  const description = (metadata.description || "").trim();
  return (
    /^threads\b.*\blog\s?in$/i.test(title) ||
    description.startsWith("Join Threads to share ideas")
  );
}

async function fetchThreadsMetadata(url) {
  cleanupThreadsMetadataCache();

  const cached = threadsMetadataCache.get(url);
  if (cached) {
    console.log(`[threads-meta] cache-hit ${url}`);
    return cached.metadata;
  }

  const metadata = await runProbe(url);

  if (isThreadsLoginWall(metadata)) {
    throw new Error(
      `Threads served a logged-out login wall (no public metadata) for ${url}`,
    );
  }

  console.log(
    `[threads-meta] metaTags=${metadata.metaTagCount} title=${metadata.title ? "yes" : "no"} desc=${metadata.description ? "yes" : "no"} image=${metadata.image ? "yes" : "no"} card=${metadata.twitterCard ?? "null"} imageCount=${metadata.imageCount ?? 0} imagesLen=${metadata.images?.length ?? 0} videoCount=${metadata.videoCount ?? 0} source=playwright-subprocess`,
  );

  const result = {
    title: metadata.title,
    description: metadata.description,
    image: metadata.image,
    images: metadata.images || [],
    twitterCard: metadata.twitterCard,
    video: metadata.video,
    imageCount: metadata.imageCount || 0,
    videoCount: metadata.videoCount || 0,
  };

  threadsMetadataCache.set(url, { metadata: result, cachedAt: Date.now() });
  return result;
}

async function fetchPageProbeMetadata(url) {
  return runProbe(url);
}

module.exports = {
  runProbe,
  fetchThreadsMetadata,
  fetchPageProbeMetadata,
  isThreadsLoginWall,
};

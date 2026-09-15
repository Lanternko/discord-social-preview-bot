const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { fetchThreadsGraphqlMetadata } = require("./threads-graphql");

const {
  THREADS_GRAPHQL_ENABLED,
  THREADS_PROBE_NODE,
  THREADS_PROBE_SCRIPT,
  THREADS_PROBE_TIMEOUT_MS,
  THREADS_PROBE_MAX_CONCURRENT,
  THREADS_PROBE_QUEUE_TIMEOUT_MS,
  THREADS_METADATA_CACHE_TTL_MS,
} = require("./config");

const execFileAsync = promisify(execFile);

// Every probe is a full chromium. Unbounded, a busy channel starts a dozen at
// once and they starve each other's rendering — the page then reports zero
// media because the DOM hasn't been laid out yet, and a video post degrades to
// a still cover frame. Queue instead of racing: waiting a beat for a slot is
// cheaper than a probe that returns wrong metadata.
//
// But the queue must never be the thing that makes a preview late. A probe can
// take THREADS_PROBE_TIMEOUT_MS, so an unbounded queue would put the 12th link
// in a burst minutes behind. Waiting past THREADS_PROBE_QUEUE_TIMEOUT_MS runs
// the probe anyway: under a flood we degrade to the old free-for-all (fast,
// occasionally wrong) rather than to a preview nobody is still looking at.
let activeProbes = 0;
const probeWaiters = new Set();

async function acquireProbeSlot() {
  if (activeProbes < THREADS_PROBE_MAX_CONCURRENT) {
    activeProbes += 1;
    return;
  }

  const admitted = await new Promise((resolve) => {
    const waiter = (value) => {
      if (!probeWaiters.delete(waiter)) return;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => waiter(false), THREADS_PROBE_QUEUE_TIMEOUT_MS);
    probeWaiters.add(waiter);
  });

  if (!admitted) {
    console.warn(
      `[probe] queue wait exceeded ${THREADS_PROBE_QUEUE_TIMEOUT_MS}ms (active=${activeProbes}) — running over the cap`,
    );
  }
  activeProbes += 1;
}

function releaseProbeSlot() {
  activeProbes -= 1;
  // Hand the slot to the next waiter; `activeProbes` is re-incremented by the
  // waiter itself, so a timed-out waiter that already left can't double-count.
  const next = probeWaiters.values().next().value;
  if (next) next(true);
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
// "Join Threads to share ideas...") when it walls a probe — common on sensitive
// / flagged posts. Never render that text: salvage the media if the DOM still
// has it, otherwise treat it as a probe failure (fixer chain + OG recovery).
function isThreadsLoginWall(metadata) {
  if (!metadata) return false;
  const title = (metadata.title || "").trim();
  const description = (metadata.description || "").trim();
  return (
    /^threads\b.*\blog\s?in$/i.test(title) ||
    description.startsWith("Join Threads to share ideas")
  );
}

// The single shape buildThreadsPayload reads, whichever source produced it.
function normalizeThreadsMetadata(metadata) {
  return {
    title: metadata.title,
    description: metadata.description,
    image: metadata.image,
    images: metadata.images || [],
    twitterCard: metadata.twitterCard,
    video: metadata.video,
    imageCount: metadata.imageCount || 0,
    videoCount: metadata.videoCount || 0,
    ancestors: metadata.ancestors || [],
    postText: metadata.postText || null,
  };
}

function logThreadsMetadata(metadata, source, extra = "") {
  console.log(
    `[threads-meta]${extra} title=${metadata.title ? "yes" : "no"} desc=${metadata.description ? "yes" : "no"} image=${metadata.image ? "yes" : "no"} card=${metadata.twitterCard ?? "null"} imageCount=${metadata.imageCount ?? 0} imagesLen=${metadata.images?.length ?? 0} videoCount=${metadata.videoCount ?? 0} ancestors=${metadata.ancestors?.length ?? 0} source=${source}`,
  );
}

// A walled post still hydrates its media into the logged-out DOM even though
// every meta tag is the login interstitial. The fixers get the same wall (vx
// unfurls "Threads • Log in"), so keep the media and drop the wall's text.
// Returns null when there is no media worth keeping.
function salvageLoginWallMedia(metadata, url) {
  const images = metadata.images || [];
  const hasVideo = Boolean(metadata.video) || metadata.videoCount > 0;
  if (!images.length && !hasVideo) return null;

  const handle = url.match(/\/@([A-Za-z0-9._]+)\/post\//)?.[1];
  return {
    ...metadata,
    title: handle ? `@${handle} 的 Threads 貼文` : "Threads 貼文",
    description: null,
    image: images[0] || null,
    twitterCard: images.length ? "summary_large_image" : null,
    imageCount: Math.max(metadata.imageCount || 0, images.length),
  };
}

async function fetchThreadsMetadataViaProbe(url) {
  const metadata = await runProbe(url);

  if (isThreadsLoginWall(metadata)) {
    const salvaged = salvageLoginWallMedia(metadata, url);
    if (!salvaged) {
      throw new Error(
        `Threads served a logged-out login wall (no public metadata) for ${url}`,
      );
    }
    logThreadsMetadata(salvaged, "playwright-subprocess", " login-wall-salvaged");
    return normalizeThreadsMetadata(salvaged);
  }

  logThreadsMetadata(
    metadata,
    "playwright-subprocess",
    ` metaTags=${metadata.metaTagCount}`,
  );
  return normalizeThreadsMetadata(metadata);
}

// GraphQL first, chromium second. The fast path returns null (never throws) on
// any miss — a walled post, a rotated doc_id, a share link we couldn't
// canonicalise — so the probe stays the safety net rather than being replaced.
async function resolveThreadsMetadata(url) {
  if (THREADS_GRAPHQL_ENABLED) {
    const metadata = await fetchThreadsGraphqlMetadata(url);
    if (metadata) {
      logThreadsMetadata(metadata, "graphql");
      return normalizeThreadsMetadata(metadata);
    }
    console.log(`[threads-meta] graphql miss → playwright ${url}`);
  }
  return fetchThreadsMetadataViaProbe(url);
}

async function fetchThreadsMetadata(url) {
  cleanupThreadsMetadataCache();

  const cached = threadsMetadataCache.get(url);
  if (cached) {
    console.log(`[threads-meta] cache-hit ${url}`);
    return cached.metadata;
  }

  const result = await resolveThreadsMetadata(url);

  threadsMetadataCache.set(url, { metadata: result, cachedAt: Date.now() });
  return result;
}

async function fetchPageProbeMetadata(url) {
  return runProbe(url);
}

module.exports = {
  runProbe,
  normalizeThreadsMetadata,
  fetchThreadsMetadata,
  fetchPageProbeMetadata,
  isThreadsLoginWall,
  salvageLoginWallMedia,
};

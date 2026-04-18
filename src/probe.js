const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
  THREADS_PROBE_NODE,
  THREADS_PROBE_SCRIPT,
  THREADS_PROBE_TIMEOUT_MS,
  THREADS_METADATA_CACHE_TTL_MS,
} = require("./config");

const execFileAsync = promisify(execFile);

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
  const { stdout, stderr } = await execFileAsync(
    THREADS_PROBE_NODE,
    [THREADS_PROBE_SCRIPT, url],
    {
      timeout: THREADS_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
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

async function fetchThreadsMetadata(url) {
  cleanupThreadsMetadataCache();

  const cached = threadsMetadataCache.get(url);
  if (cached) {
    console.log(`[threads-meta] cache-hit ${url}`);
    return cached.metadata;
  }

  const metadata = await runProbe(url);

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
};

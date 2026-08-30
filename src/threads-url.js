const THREADS_ORIGIN_HOSTS = new Set([
  "threads.com",
  "www.threads.com",
  "threads.net",
  "www.threads.net",
]);

const SHARE_PATH_PATTERN = /^\/share\/[A-Za-z0-9_-]{1,128}\/?$/;
const POST_PATH_PATTERN =
  /^\/@[A-Za-z0-9._]{1,64}\/post\/[A-Za-z0-9_-]{1,128}\/?$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESOLVE_TIMEOUT_MS = 2500;
const RESOLVE_MAX_CONCURRENT = 4;
const RESOLVE_CACHE_MAX = 512;
const POSITIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 30 * 1000;

const resolveCache = new Map();
const inflightResolves = new Map();
const waiters = [];
let activeResolves = 0;
let maxObservedConcurrency = 0;
let cacheHits = 0;
let cacheMisses = 0;
let networkRequests = 0;

function hasUnsafeExplicitAuthority(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const match = rawUrl.match(/^(?:https:)?\/\/([^/?#]+)/i);
  if (!match) return false;
  return match[1].includes("@") || match[1].includes(":");
}

function parseSafeThreadsUrl(rawUrl) {
  // WHATWG URL normalizes an explicit default :443 port to an empty `port`.
  // Inspect the raw authority first so the exact-host contract still rejects
  // every explicit port and userinfo form before normalization can hide it.
  if (hasUnsafeExplicitAuthority(rawUrl)) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !THREADS_ORIGIN_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    return null;
  }
  return parsed;
}

function exactThreadsShareUrl(rawUrl) {
  const parsed = parseSafeThreadsUrl(rawUrl);
  if (
    !parsed ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !SHARE_PATH_PATTERN.test(parsed.pathname)
  ) {
    return null;
  }
  return parsed.toString();
}

function canonicalizeThreadsPostUrl(rawUrl) {
  const parsed = parseSafeThreadsUrl(rawUrl);
  if (!parsed || parsed.hash !== "" || !POST_PATH_PATTERN.test(parsed.pathname)) {
    return null;
  }

  parsed.searchParams.delete("xmt");
  parsed.searchParams.delete("slof");
  if ([...parsed.searchParams.keys()].length > 0) return null;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function getCached(key) {
  const entry = resolveCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    resolveCache.delete(key);
    return undefined;
  }
  // Map insertion order doubles as a small LRU: refresh entries on access.
  resolveCache.delete(key);
  resolveCache.set(key, entry);
  cacheHits += 1;
  return entry.value;
}

function setCached(key, value) {
  resolveCache.delete(key);
  resolveCache.set(key, {
    value,
    expiresAt:
      Date.now() +
      (value === null ? NEGATIVE_CACHE_TTL_MS : POSITIVE_CACHE_TTL_MS),
  });
  while (resolveCache.size > RESOLVE_CACHE_MAX) {
    resolveCache.delete(resolveCache.keys().next().value);
  }
}

async function acquireResolveSlot() {
  if (activeResolves >= RESOLVE_MAX_CONCURRENT) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  activeResolves += 1;
  maxObservedConcurrency = Math.max(maxObservedConcurrency, activeResolves);
}

function releaseResolveSlot() {
  activeResolves -= 1;
  waiters.shift()?.();
}

async function fetchCanonicalLocation(shareUrl, fetchImpl) {
  await acquireResolveSlot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  let response;
  try {
    networkRequests += 1;
    response = await fetchImpl(shareUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "discord-social-preview-bot/threads-url-resolver",
      },
    });
    if (!REDIRECT_STATUSES.has(response.status)) return null;
    const location = response.headers.get("location");
    if (!location) return null;
    if (hasUnsafeExplicitAuthority(location)) return null;

    let resolvedLocation;
    try {
      resolvedLocation = new URL(location, shareUrl).toString();
    } catch {
      return null;
    }
    return canonicalizeThreadsPostUrl(resolvedLocation);
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn(`[threads-url] resolve failed ${shareUrl}: ${error.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
    if (response?.body && !response.bodyUsed) {
      try {
        await response.body.cancel();
      } catch {
        // The only required data is in the redirect headers.
      }
    }
    releaseResolveSlot();
  }
}

async function resolveThreadsUrl(rawUrl, options = {}) {
  const canonical = canonicalizeThreadsPostUrl(rawUrl);
  if (canonical) return canonical;

  const shareUrl = exactThreadsShareUrl(rawUrl);
  if (!shareUrl) return rawUrl;

  const cached = getCached(shareUrl);
  if (cached !== undefined) return cached || shareUrl;
  cacheMisses += 1;

  const pending = inflightResolves.get(shareUrl);
  if (pending) return (await pending) || shareUrl;

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== "function") return shareUrl;

  const resolvePromise = fetchCanonicalLocation(shareUrl, fetchImpl).then(
    (result) => {
      setCached(shareUrl, result);
      return result;
    },
  );
  inflightResolves.set(shareUrl, resolvePromise);
  try {
    return (await resolvePromise) || shareUrl;
  } finally {
    inflightResolves.delete(shareUrl);
  }
}

function resetThreadsUrlResolverForTests() {
  if (activeResolves !== 0 || inflightResolves.size !== 0) {
    throw new Error("cannot reset Threads URL resolver while requests are active");
  }
  resolveCache.clear();
  waiters.length = 0;
  cacheHits = 0;
  cacheMisses = 0;
  networkRequests = 0;
  maxObservedConcurrency = 0;
}

function getThreadsUrlResolverStats() {
  let positiveEntries = 0;
  let negativeEntries = 0;
  for (const entry of resolveCache.values()) {
    if (entry.value === null) negativeEntries += 1;
    else positiveEntries += 1;
  }
  return {
    cacheSize: resolveCache.size,
    positiveEntries,
    negativeEntries,
    inflight: inflightResolves.size,
    active: activeResolves,
    queued: waiters.length,
    maxObservedConcurrency,
    cacheHits,
    cacheMisses,
    networkRequests,
  };
}

module.exports = {
  THREADS_ORIGIN_HOSTS,
  SHARE_PATH_PATTERN,
  POST_PATH_PATTERN,
  RESOLVE_TIMEOUT_MS,
  RESOLVE_MAX_CONCURRENT,
  RESOLVE_CACHE_MAX,
  POSITIVE_CACHE_TTL_MS,
  NEGATIVE_CACHE_TTL_MS,
  hasUnsafeExplicitAuthority,
  exactThreadsShareUrl,
  canonicalizeThreadsPostUrl,
  resolveThreadsUrl,
  resetThreadsUrlResolverForTests,
  getThreadsUrlResolverStats,
};

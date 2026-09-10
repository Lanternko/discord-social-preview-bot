// Threads metadata over Meta's own GraphQL endpoint — the fast path that
// `fetchThreadsMetadata` tries before falling back to the Playwright probe.
//
// WHY this exists: the probe reads the DOM, and Threads mounts <video> ~0.3-1.5s
// AFTER DOMContentLoaded while serving no og:video at all. That race is the root
// cause of video posts degrading to a still cover frame (2026-09-06). GraphQL
// returns the post as data — media counts and the direct mp4 URL are fields, not
// something we have to wait for — so there is no race to lose, no chromium to
// launch, and no per-probe concurrency slot to queue for.
//
// This module ONLY fetches and shapes metadata. Deciding whether to use it (and
// what to do when it misses) belongs to probe.js.

const {
  THREADS_GRAPHQL_DOC_ID,
  THREADS_GRAPHQL_APP_ID,
  THREADS_GRAPHQL_LSD,
  THREADS_GRAPHQL_TIMEOUT_MS,
} = require("./config");

const GRAPHQL_ENDPOINT = "https://www.threads.com/api/graphql";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

// Threads shortcodes are base64 over this exact alphabet (Instagram's), so the
// numeric post id the API wants is a plain base-64 digit expansion of the code.
const SHORTCODE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function codeToPostId(code) {
  if (typeof code !== "string" || code.length === 0) return null;
  let postId = 0n;
  for (const character of code) {
    const digit = SHORTCODE_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    postId = postId * 64n + BigInt(digit);
  }
  return postId.toString();
}

// Only the canonical `/@user/post/<code>` form carries a shortcode. Share links
// (`/share/xxx`) are resolved to canonical by resolveThreadsUrl before we're
// called, so anything still non-canonical here is a miss, not an error.
function extractPostCode(url) {
  try {
    const { pathname } = new URL(url);
    const match = pathname.match(/\/@[^/]+\/post\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function buildRequestBody(postId) {
  const variables = JSON.stringify({
    check_for_unavailable_replies: true,
    first: 10,
    postID: postId,
    __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
    __relay_internal__pv__BarcelonaIsThreadContextHeaderEnabledrelayprovider: false,
    __relay_internal__pv__BarcelonaIsThreadContextHeaderFollowButtonEnabledrelayprovider: false,
    __relay_internal__pv__BarcelonaUseCometVideoPlaybackEnginerelayprovider: false,
    __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: false,
    __relay_internal__pv__BarcelonaIsViewCountEnabledrelayprovider: false,
    __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: false,
  });
  return new URLSearchParams({
    variables,
    doc_id: THREADS_GRAPHQL_DOC_ID,
    lsd: THREADS_GRAPHQL_LSD,
  }).toString();
}

// The response holds the whole thread in order, so the linked post is the node
// whose shortcode matches and everything BEFORE it is what that post is replying
// to. Same semantics the DOM probe derives from permalink position — see
// `ancestors` in threads-probe.cjs — so buildReplyDescription reads either
// source without caring which produced it.
function findThread(json, code) {
  const items = json?.data?.data?.edges?.[0]?.node?.thread_items;
  if (!Array.isArray(items) || items.length === 0) return null;

  const targetIndex = items.findIndex((item) => item?.post?.code === code);
  if (targetIndex < 0) {
    // Thread came back but not the post we asked for: previewing the root
    // instead would quietly show the wrong content, so treat it as a miss.
    return null;
  }
  return {
    post: items[targetIndex].post,
    ancestors: items.slice(0, targetIndex).map((item) => ({
      author: item?.post?.user?.username || null,
      text: item?.post?.caption?.text || null,
    })),
  };
}

function firstUrl(candidates) {
  const url = candidates?.[0]?.url;
  return typeof url === "string" && url.startsWith("http") ? url : null;
}

// Match the og:title Threads itself serves ("周立軒 (@victor31429) on Threads"),
// so switching to this path doesn't visibly change the embed heading.
function buildTitle(user) {
  const username = user?.username;
  if (!username) return null;
  const fullName = (user.full_name || "").trim();
  return fullName
    ? `${fullName} (@${username}) on Threads`
    : `@${username} on Threads`;
}

// A carousel slide is either a video (with a cover frame in image_versions2) or
// a plain image. Keeping the cover in `images` matches what the DOM probe used
// to report and is what makes a MIXED post stay a carousel in buildPreviewPayloads.
function collectMedia(post) {
  const images = [];
  const videos = [];

  if (Array.isArray(post.carousel_media) && post.carousel_media.length > 0) {
    for (const item of post.carousel_media) {
      const video = firstUrl(item?.video_versions);
      if (video) videos.push(video);
      const image = firstUrl(item?.image_versions2?.candidates);
      if (image) images.push(image);
    }
    return { images, videos };
  }

  const video = firstUrl(post.video_versions);
  if (video) videos.push(video);
  const image = firstUrl(post.image_versions2?.candidates);
  if (image) images.push(image);
  return { images, videos };
}

function buildMetadata(post, code, ancestors = []) {
  const { images, videos } = collectMedia(post);
  const description = post?.caption?.text || null;
  const hasMedia = images.length > 0 || videos.length > 0;

  return {
    title: buildTitle(post?.user),
    description,
    image: images[0] || null,
    images,
    // buildThreadsPayload reads this to force a text-only post into the compact
    // embed, so it has to mirror the card Threads would have served.
    twitterCard: hasMedia ? "summary_large_image" : "summary",
    video: videos[0] || null,
    imageCount: images.length,
    videoCount: videos.length,
    // Reply context (see buildReplyDescription in platforms/threads.js). The
    // caption is both `description` and `postText` here because GraphQL has one
    // text field — the probe needs two only because og:description and the DOM
    // body can disagree.
    ancestors,
    postText: description,
    code,
  };
}

// Fetch metadata for a canonical Threads post URL. Returns null on any miss
// (non-canonical URL, API error, walled post, malformed payload) — the caller
// falls back to the Playwright probe. Never throws.
async function fetchThreadsGraphqlMetadata(url) {
  const code = extractPostCode(url);
  if (!code) return null;
  const postId = codeToPostId(code);
  if (!postId) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THREADS_GRAPHQL_TIMEOUT_MS);
  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": BROWSER_UA,
        "X-Fb-Lsd": THREADS_GRAPHQL_LSD,
        "X-Ig-App-Id": THREADS_GRAPHQL_APP_ID,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: buildRequestBody(postId),
    });
    if (!response.ok) {
      console.log(`[threads-gql] http ${response.status} ${url}`);
      return null;
    }

    const json = await response.json();
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      // "Not Logged In" / "limit exceeded" / rate-block all land here. We have
      // no session to escalate to, so this is a miss — the fixer chain and the
      // probe are both better at walled posts than a doomed retry would be.
      const summary = json.errors[0]?.summary || json.errors[0]?.message || "?";
      console.log(`[threads-gql] api error "${summary}" ${url}`);
      return null;
    }

    const thread = findThread(json, code);
    if (!thread) {
      console.log(`[threads-gql] no post node ${url}`);
      return null;
    }
    return buildMetadata(thread.post, code, thread.ancestors);
  } catch (error) {
    console.log(`[threads-gql] fetch failed: ${error.message} ${url}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  codeToPostId,
  extractPostCode,
  findThread,
  buildMetadata,
  fetchThreadsGraphqlMetadata,
};

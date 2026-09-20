const { TWEET_SPOILER_MAX_IMAGES } = require("../config");

const TWEET_LOOKUP_TIMEOUT_MS = 3000;
const LOOKUP_RETRY_DELAY_MS = 400;

// Twitter serves every size off the same media URL. `orig` is the full upload
// (2-4 MB is common); `large` caps the long edge at 2048px, which looks the
// same inside a Discord attachment at a quarter of the bytes.
function toLargePhotoUrl(url) {
  return `${String(url).split("?")[0]}?name=large`;
}

// What fxtwitter's JSON API knows about a post, for the two things the unfurl
// can't tell us: whether the post has media at all (fxtwitter sometimes strips
// it, leaving a card that looks like a text-only tweet), and whether it is
// marked sensitive (which routes it to the bot's own spoilered card).
// Resolves null when unknown (non-status URL, API miss, timeout); never throws.
async function fetchTweetMeta(url) {
  const statusId = new URL(url).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1];
  if (!statusId) return null;
  // Retried once: the API answers empty now and then, and a miss on a
  // sensitive post means its image goes out through a fixer, unblurred.
  const first = await lookupTweet(statusId);
  if (first) return first;
  await new Promise((resolve) => setTimeout(resolve, LOOKUP_RETRY_DELAY_MS));
  return await lookupTweet(statusId);
}

async function lookupTweet(statusId) {
  try {
    const response = await fetch(
      `https://api.fxtwitter.com/status/${statusId}`,
      { signal: AbortSignal.timeout(TWEET_LOOKUP_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const tweet = (await response.json())?.tweet;
    if (!tweet) return null;
    const media = tweet.media?.all || [];
    return {
      hasMedia: media.length > 0,
      sensitive: tweet.possibly_sensitive === true,
      // Photos only: a spoilered video would have to be downloaded whole to
      // hide a thumbnail, so sensitive video posts keep the fixer chain.
      photos: media
        .filter((item) => item.type === "photo")
        .slice(0, TWEET_SPOILER_MAX_IMAGES)
        .map((item) => toLargePhotoUrl(item.url)),
      photoCount: media.filter((item) => item.type === "photo").length,
      hasNonPhotoMedia: media.some((item) => item.type !== "photo"),
      text: tweet.text || "",
      authorName: tweet.author?.name || "",
      authorHandle: tweet.author?.screen_name || "",
      authorAvatar: tweet.author?.avatar_url || null,
    };
  } catch (error) {
    console.warn(`[twitter] lookup failed ${statusId}: ${error.message}`);
    return null;
  }
}

module.exports = { fetchTweetMeta, toLargePhotoUrl };

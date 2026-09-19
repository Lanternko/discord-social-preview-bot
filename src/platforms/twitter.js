const TWEET_MEDIA_LOOKUP_TIMEOUT_MS = 3000;

// Does this post carry media? Answered by fxtwitter's JSON API, because
// fxtwitter's own unfurl sometimes strips the media from an image post and
// leaves a card that is just "Name (@handle)" (or the text with no picture) —
// which, from the embed alone, looks exactly like a text-only tweet.
// Resolves true / false, or null when unknown (non-status URL, API miss,
// timeout). Never rejects.
async function fetchTweetHasMedia(url) {
  const statusId = new URL(url).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1];
  if (!statusId) return null;
  try {
    const response = await fetch(
      `https://api.fxtwitter.com/status/${statusId}`,
      { signal: AbortSignal.timeout(TWEET_MEDIA_LOOKUP_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const tweet = (await response.json())?.tweet;
    if (!tweet) return null;
    return (tweet.media?.all?.length ?? 0) > 0;
  } catch (error) {
    console.warn(`[twitter] media lookup failed ${statusId}: ${error.message}`);
    return null;
  }
}

module.exports = { fetchTweetHasMedia };

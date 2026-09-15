const { chromium } = require("playwright");

const PLAYWRIGHT_GOTO_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_GOTO_TIMEOUT_MS || "8000",
  10,
);
const PLAYWRIGHT_META_WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_META_WAIT_TIMEOUT_MS || "1500",
  10,
);
// How long to keep polling for the post's media to mount after the first read
// came back empty. Bounded so an image-only post costs at most this much.
const PLAYWRIGHT_MEDIA_WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_MEDIA_WAIT_TIMEOUT_MS || "2500",
  10,
);

const THREADS_HOSTS = new Set([
  "threads.net",
  "www.threads.net",
  "threads.com",
  "www.threads.com",
]);
const BAHAMUT_HOSTS = new Set([
  "forum.gamer.com.tw",
  "m.gamer.com.tw",
]);
const PTT_HOSTS = new Set([
  "ptt.cc",
  "www.ptt.cc",
]);
const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
]);

function trimText(text, limit) {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

async function openPage(browser, url) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  });

  const hostname = new URL(url).hostname;
  if (PTT_HOSTS.has(hostname)) {
    await context.addCookies([
      { name: "over18", value: "1", domain: "www.ptt.cc", path: "/" },
      { name: "over18", value: "1", domain: "ptt.cc", path: "/" },
    ]);
  }

  if (process.env.PROBE_COOKIES) {
    await context.addCookies(JSON.parse(process.env.PROBE_COOKIES));
  }

  const page = await context.newPage();
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: PLAYWRIGHT_GOTO_TIMEOUT_MS,
  });

  await Promise.race([
    page.waitForLoadState("networkidle", {
      timeout: PLAYWRIGHT_META_WAIT_TIMEOUT_MS,
    }),
    page.waitForTimeout(PLAYWRIGHT_META_WAIT_TIMEOUT_MS),
  ]).catch(() => null);

  return { context, page };
}

async function readThreadsMetadata(page) {
  const readMetadata = () =>
    page.evaluate(() => {
      const getMeta = (attribute, name) => {
        const selector = `meta[${attribute}="${name}"]`;
        const element = document.head.querySelector(selector);
        return element?.getAttribute("content")?.trim() || null;
      };

      const getBestSrc = (img) => {
        if (img.srcset) {
          const candidates = img.srcset.split(",")
            .map((s) => { const p = s.trim().split(/\s+/); return { url: p[0], w: parseInt(p[1]) || 0 }; })
            .filter((c) => c.url.startsWith("http"))
            .sort((a, b) => b.w - a.w);
          if (candidates.length > 0) return candidates[0].url;
        }
        return img.currentSrc || img.src || img.getAttribute("src") || null;
      };

      // 只取主貼文範圍的圖（viewport 內）；留言在 viewport 以下
      const viewportHeight = window.innerHeight;
      const mediaContainer = document.querySelector("article") || document.body;
      const candidateImages = Array.from(
        mediaContainer.querySelectorAll("img"),
      ).filter((img) => {
        const rect = img.getBoundingClientRect();
        if (rect.top >= viewportHeight) return false; // 留言區
        const src = getBestSrc(img);
        return src && rect.width >= 160 && rect.height >= 160;
      });

      const inMainPost = (element) => {
        const rect = element.getBoundingClientRect();
        if (rect.top >= viewportHeight) return false;
        return rect.width >= 160 && rect.height >= 160;
      };

      // A shared Threads link very often points at a REPLY, and og:description
      // then carries only the punchline — the post it answers is nowhere in the
      // preview. The thread page renders every ancestor post above the target
      // in DOM order, so locate the target by its own permalink (the page
      // auto-scrolls it to the top, but that scroll is async — position would
      // be a race, the permalink is not) and take everything before it as the
      // ancestor chain.
      const postContainers = Array.from(
        document.querySelectorAll('div[data-pressable-container="true"]'),
      );
      const permalinkOf = (container) => {
        const href = container
          .querySelector("time")
          ?.closest("a")
          ?.getAttribute("href");
        return href ? href.split("?")[0].replace(/\/$/, "") : null;
      };
      const handleOf = (container) =>
        permalinkOf(container)?.match(/^\/@([A-Za-z0-9._]+)\//)?.[1] || null;
      // Threads' class names are obfuscated and rotate per build, so identify
      // the post body by role instead: it is the only dir="auto" span that is
      // neither inside a link (author name), nor a timestamp wrapper (that span
      // is the PARENT of its <a>, so closest("a") misses it), nor inside an
      // interaction button (the like/repost counters).
      const bodyTextOf = (container) => {
        const spans = Array.from(
          container.querySelectorAll('span[dir="auto"]'),
        ).filter(
          (span) =>
            !span.closest("a") &&
            !span.closest('[role="button"]') &&
            !span.querySelector("time"),
        );
        const outermost = spans.filter(
          (span) =>
            !spans.some((other) => other !== span && other.contains(span)),
        );
        // innerText would be ideal but a body span also holds the "Translate" /
        // "See more" buttons; walk instead so those subtrees can be dropped
        // while <br> still becomes a real line break.
        const collect = (node) => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent;
          if (node.nodeType !== Node.ELEMENT_NODE) return "";
          if (node.getAttribute("role") === "button") return "";
          if (node.tagName === "BR") return "\n";
          return Array.from(node.childNodes).map(collect).join("");
        };
        return (
          outermost.map(collect).join("\n").replace(/\n{3,}/g, "\n\n").trim() ||
          null
        );
      };

      const targetPath = location.pathname.replace(/\/$/, "");
      const targetIndex = postContainers.findIndex(
        (container) => permalinkOf(container) === targetPath,
      );
      const ancestors =
        targetIndex > 0
          ? postContainers.slice(0, targetIndex).map((container) => ({
              author: handleOf(container),
              text: bodyTextOf(container),
            }))
          : [];

      const candidateVideos = Array.from(
        mediaContainer.querySelectorAll("video"),
      ).filter(inMainPost);
      const videoPlayerMarkers = Array.from(
        mediaContainer.querySelectorAll('[role="group"], [aria-label]'),
      ).filter((element) => {
        const ariaLabel = element.getAttribute("aria-label") || "";
        if (!ariaLabel.toLowerCase().includes("video player")) return false;
        return inMainPost(element);
      });

      return {
        title: getMeta("property", "og:title") || document.title || null,
        description:
          getMeta("property", "og:description") ||
          getMeta("name", "description") ||
          null,
        image:
          getMeta("property", "og:image") ||
          getMeta("name", "twitter:image") ||
          null,
        twitterCard: getMeta("name", "twitter:card"),
        video:
          getMeta("property", "og:video") ||
          getMeta("property", "og:video:url") ||
          getMeta("name", "twitter:player:stream") ||
          candidateVideos[0]?.getAttribute("src") ||
          null,
        // A walled post redirects a logged-out browser to the home feed ("/"),
        // whose DOM is full of OTHER people's media. Anything read off a page
        // that isn't a post permalink must not be attributed to this link.
        onPostPage: /\/post\//.test(location.pathname),
        ancestors,
        postText:
          targetIndex >= 0 ? bodyTextOf(postContainers[targetIndex]) : null,
        images: candidateImages.map((img) => getBestSrc(img)).filter(Boolean),
        imageCount: candidateImages.length,
        videoCount: Math.max(
          candidateVideos.length,
          videoPlayerMarkers.length > 0 ? 1 : 0,
        ),
        metaTagCount: document.head.querySelectorAll("meta").length,
      };
    });

  let metadata = await readMetadata();

  // Threads mounts the <video> element ~0.3-1.5s AFTER DOMContentLoaded, and
  // serves NO og:video — the DOM is the only place a direct mp4 URL exists. The
  // old code read once and blindly retried +1500ms, so a slow render (the host
  // is busy, several probes are competing) silently produced videoCount=0 and a
  // null video, and the post degraded to a still cover frame that LOOKS like a
  // successful preview. Poll for the media instead of guessing at a delay.
  //
  // Only media posts (og:image present / summary_large_image) can wait: a
  // text-only post has nothing to wait for and must not pay the deadline.
  if (
    (metadata.twitterCard === "summary_large_image" || metadata.image) &&
    !metadata.video &&
    metadata.videoCount === 0
  ) {
    await page
      .waitForFunction(
        () => {
          const viewportHeight = window.innerHeight;
          const mediaContainer =
            document.querySelector("article") || document.body;
          const inMainPost = (element) => {
            const rect = element.getBoundingClientRect();
            if (rect.top >= viewportHeight) return false;
            return rect.width >= 160 && rect.height >= 160;
          };
          // Settle as soon as a playable <video src> exists, or as soon as the
          // post is provably image-only: Threads renders the video element and
          // its "video player" aria marker together, so a laid-out cover image
          // with neither marker nor <video> after the grace period is a real
          // image post, not a race we should keep waiting on.
          const video = Array.from(
            mediaContainer.querySelectorAll("video"),
          ).filter(inMainPost)[0];
          if (video?.getAttribute("src")) return true;
          return Boolean(
            Array.from(mediaContainer.querySelectorAll('[aria-label]')).find(
              (element) =>
                (element.getAttribute("aria-label") || "")
                  .toLowerCase()
                  .includes("video player") && inMainPost(element),
            ),
          );
        },
        null,
        { timeout: PLAYWRIGHT_MEDIA_WAIT_TIMEOUT_MS, polling: 150 },
      )
      .catch(() => null); // genuine image-only post — fall through and re-read
    metadata = await readMetadata();
  }

  return metadata;
}

async function readBahamutMetadata(page) {
  return page.evaluate(() => {
    const getMeta = (attribute, name) => {
      const selector = `meta[${attribute}="${name}"]`;
      const element = document.head.querySelector(selector);
      return element?.getAttribute("content")?.trim() || null;
    };

    const bodyText = document.body.innerText || "";
    const restricted =
      document.title.includes("兒少保護警示") ||
      bodyText.includes("如要閱覽請先登入") ||
      bodyText.includes("兒少保護");

    // The post header is a block of chrome — 樓主 / 暱稱 / 自訂頭銜 / 帳號 /
    // GP / BP — and its textContent glues all of it into one line. Discord
    // renders that above the title, so it eats more vertical space than the
    // article itself. Pull the two fields that identify the poster and drop
    // the rest.
    const header = document.querySelector(".c-post__header__author");
    const username = header?.querySelector(".username")?.textContent?.trim() || null;
    const userid = header?.querySelector(".userid")?.textContent?.trim() || null;
    const author =
      (username && userid && username !== userid
        ? `${username} (${userid})`
        : username || userid) || null;

    const articleText =
      document.querySelector(".c-article__content")?.innerText ||
      document.querySelector("#BH-master")?.innerText ||
      bodyText;

    // The article's own media never reaches og:*: a post with a YouTube embed
    // advertises the video thumbnail, and a post whose punchline is a GIF
    // advertises nothing at all. Read both out of the article so the preview
    // can show the picture people actually posted (an animated GIF stays
    // animated in an embed) and hand the video URL to Discord's own player.
    const article = document.querySelector(".c-article__content");
    const articleImages = Array.from(article?.querySelectorAll("img") || [])
      .map((img) =>
        (img.getAttribute("data-src") || img.getAttribute("src") || "").trim(),
      )
      // Emoticons and avatars are chrome, not content.
      .filter((src) => /^https?:\/\//.test(src) && !/\/(?:emotion|avatar)\//i.test(src));

    const videoUrls = Array.from(
      new Set(
        Array.from(article?.querySelectorAll("iframe") || [])
          .map((frame) =>
            (frame.getAttribute("src") || frame.getAttribute("data-src") || "").match(
              /(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,20})/,
            )?.[1],
          )
          .filter(Boolean)
          .map((id) => `https://www.youtube.com/watch?v=${id}`),
      ),
    );

    const candidateImage = Array.from(document.querySelectorAll("img")).find((img) => {
      const src = img.getAttribute("src") || "";
      if (!src) return false;
      const rect = img.getBoundingClientRect();
      return rect.width >= 160 && rect.height >= 160;
    });

    // og:title is the browser-tab title: "<標題> @<板名> 哈啦板 - 巴哈姆特".
    // The footer already says 巴哈姆特, so that tail only makes the title wrap
    // an extra line. Require the site suffix before cutting, so a title that
    // legitimately ends in "@某某" survives.
    const stripSiteSuffix = (title) => {
      if (!title) return null;
      const trimmed = title
        .replace(/\s*@[^@]{1,80}?[-–—]\s*巴哈姆特\s*$/, "")
        .replace(/\s*[-–—]\s*巴哈姆特\s*$/, "")
        .trim();
      return trimmed || title;
    };

    return {
      title: stripSiteSuffix(getMeta("property", "og:title") || document.title),
      description:
        getMeta("property", "og:description") ||
        getMeta("name", "description") ||
        articleText ||
        null,
      image:
        getMeta("property", "og:image") ||
        getMeta("name", "thumbnail") ||
        candidateImage?.getAttribute("src") ||
        null,
      images: articleImages.slice(0, 10),
      videoUrls: videoUrls.slice(0, 3),
      author,
      restricted,
      metaTagCount: document.head.querySelectorAll("meta").length,
    };
  });
}

async function readPttMetadata(page) {
  return page.evaluate(() => {
    const getMeta = (attribute, name) => {
      const selector = `meta[${attribute}="${name}"]`;
      const element = document.head.querySelector(selector);
      return element?.getAttribute("content")?.trim() || null;
    };

    const values = Array.from(document.querySelectorAll(".article-meta-value")).map((node) =>
      node.textContent?.trim() || "",
    );
    const mainContent = document.querySelector("#main-content");
    let body = mainContent?.innerText || document.body.innerText || "";

    body = body
      .replace(/^作者.*\n看板.*\n標題.*\n時間.*\n?/m, "")
      .replace(/\n--\n[\s\S]*$/, "")
      .trim();

    const imageMatch = body.match(/https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)/i);

    return {
      title:
        values[2] ||
        getMeta("property", "og:title") ||
        document.title ||
        null,
      description:
        getMeta("property", "og:description") ||
        getMeta("name", "description") ||
        body ||
        null,
      image: imageMatch?.[0] || null,
      author: values[0] || null,
      metaTagCount: document.head.querySelectorAll("meta").length,
    };
  });
}

async function readInstagramMetadata(page) {
  return page.evaluate(() => {
    const getMeta = (attribute, name) => {
      const selector = `meta[${attribute}="${name}"]`;
      const element = document.head.querySelector(selector);
      return element?.getAttribute("content")?.trim() || null;
    };

    return {
      title: getMeta("property", "og:title") || document.title || null,
      description: getMeta("property", "og:description") || null,
      image: getMeta("property", "og:image") || null,
      metaTagCount: document.head.querySelectorAll("meta").length,
    };
  });
}

async function main() {
  const url = process.argv[2];

  if (!url) {
    throw new Error("Missing URL");
  }

  const hostname = new URL(url).hostname;
  const browser = await chromium.launch({ headless: true });

  try {
    const { context, page } = await openPage(browser, url);

    try {
      let metadata;

      if (THREADS_HOSTS.has(hostname)) {
        metadata = await readThreadsMetadata(page);
      } else if (BAHAMUT_HOSTS.has(hostname)) {
        metadata = await readBahamutMetadata(page);
      } else if (PTT_HOSTS.has(hostname)) {
        metadata = await readPttMetadata(page);
      } else if (INSTAGRAM_HOSTS.has(hostname)) {
        metadata = await readInstagramMetadata(page);
      } else {
        throw new Error(`Unsupported probe host: ${hostname}`);
      }

      metadata.title = trimText(metadata.title, 256);
      metadata.description = trimText(metadata.description, 4000);
          // Discord's embed author is a single line; anything multi-line arrives
      // as one run-on string. Collapse here so a site layout change can't
      // smuggle a whole header block back into the preview.
      metadata.author = trimText(
        metadata.author ? metadata.author.replace(/\s+/g, " ") : null,
        256,
      );
      process.stdout.write(JSON.stringify(metadata));
    } finally {
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});

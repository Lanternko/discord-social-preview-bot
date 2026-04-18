const { chromium } = require("playwright");

const PLAYWRIGHT_GOTO_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_GOTO_TIMEOUT_MS || "8000",
  10,
);
const PLAYWRIGHT_META_WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_META_WAIT_TIMEOUT_MS || "1500",
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

  if (
    metadata.twitterCard === "summary_large_image" &&
    !metadata.video &&
    metadata.videoCount === 0
  ) {
    await page.waitForTimeout(1500).catch(() => null);
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

    const author =
      document.querySelector(".c-article__content .userid")?.textContent?.trim() ||
      document.querySelector(".c-post__header__author")?.textContent?.trim() ||
      null;

    const articleText =
      document.querySelector(".c-article__content")?.innerText ||
      document.querySelector("#BH-master")?.innerText ||
      bodyText;

    const candidateImage = Array.from(document.querySelectorAll("img")).find((img) => {
      const src = img.getAttribute("src") || "";
      if (!src) return false;
      const rect = img.getBoundingClientRect();
      return rect.width >= 160 && rect.height >= 160;
    });

    return {
      title: getMeta("property", "og:title") || document.title || null,
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
      metadata.author = trimText(metadata.author, 256);
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

const { chromium } = require("playwright");

const PLAYWRIGHT_GOTO_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_GOTO_TIMEOUT_MS || "8000",
  10,
);
const PLAYWRIGHT_META_WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_META_WAIT_TIMEOUT_MS || "1500",
  10,
);

async function main() {
  const url = process.argv[2];

  if (!url) {
    throw new Error("Missing Threads URL");
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PLAYWRIGHT_GOTO_TIMEOUT_MS,
      });

      await Promise.race([
        page.waitForFunction(
          () =>
            document.head.querySelector('meta[property="og:title"]') ||
            document.head.querySelector('meta[name="twitter:card"]') ||
            document.querySelector("video") ||
            Array.from(document.querySelectorAll("[aria-label]")).some((node) =>
              (node.getAttribute("aria-label") || "")
                .toLowerCase()
                .includes("video player"),
            ),
          { timeout: PLAYWRIGHT_META_WAIT_TIMEOUT_MS },
        ),
        page.waitForLoadState("networkidle", {
          timeout: PLAYWRIGHT_META_WAIT_TIMEOUT_MS,
        }),
      ]).catch(() => null);

      const readMetadata = () =>
        page.evaluate(() => {
        const getMeta = (attribute, name) => {
          const selector = `meta[${attribute}="${name}"]`;
          const element = document.head.querySelector(selector);
          return element?.getAttribute("content")?.trim() || null;
        };

        const mediaContainer = document.querySelector("article") || document.body;
        const candidateImages = Array.from(
          mediaContainer.querySelectorAll("img"),
        ).filter((img) => {
          const rect = img.getBoundingClientRect();
          const src = img.getAttribute("src") || "";

          if (!src) {
            return false;
          }

          return rect.width >= 160 && rect.height >= 160;
        });

        const candidateVideos = Array.from(document.querySelectorAll("video"));
        const videoPlayerMarkers = Array.from(
          document.querySelectorAll('[role="group"], [aria-label]'),
        ).filter((element) => {
          const ariaLabel = element.getAttribute("aria-label") || "";
          return ariaLabel.toLowerCase().includes("video player");
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

      process.stdout.write(JSON.stringify(metadata));
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});

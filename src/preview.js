const {
  isThreadsUrl,
  isInstagramUrl,
  isBilibiliUrl,
  isBahamutUrl,
  isPttUrl,
  buildFallbackUrl,
} = require("./url-routing");
const { buildBahamutPayload } = require("./platforms/bahamut");
const { buildPttPayload } = require("./platforms/ptt");
const { buildInstagramPayload } = require("./platforms/instagram");
const { buildBilibiliPayload } = require("./platforms/bilibili");
const { buildThreadsPayload } = require("./platforms/threads");

async function buildPreviewPayloads(urls) {
  const payloads = [];

  for (const url of urls) {
    if (isBahamutUrl(url)) {
      payloads.push(await buildBahamutPayload(url));
      continue;
    }
    if (isPttUrl(url)) {
      payloads.push(await buildPttPayload(url));
      continue;
    }
    if (isInstagramUrl(url)) {
      payloads.push(await buildInstagramPayload(url));
      continue;
    }
    if (isBilibiliUrl(url)) {
      payloads.push(await buildBilibiliPayload(url));
      continue;
    }
    if (isThreadsUrl(url)) {
      payloads.push(await buildThreadsPayload(url));
      continue;
    }

    console.log(`[preview] fixer non-threads ${url}`);
    payloads.push({ content: buildFallbackUrl(url) });
  }

  return payloads;
}

module.exports = { buildPreviewPayloads };

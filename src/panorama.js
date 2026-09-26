const sharp = require("sharp");
const {
  VIDEO_ATTACHMENT_TIMEOUT_MS,
  VIDEO_ATTACHMENT_MAX_CONCURRENT,
} = require("./config");
const {
  effectiveMaxBytes,
  isGuildVideoAllowed,
  readCapped,
} = require("./video");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const PANORAMA_NAME = "panorama.jpg";
// Discord shows an attachment at most ~4096px wide; past that is wasted bytes.
const MAX_OUTPUT_WIDTH = 4096;
// A true seam differs from its neighbours about as much as any two adjacent
// columns inside one picture (measured 1.2-1.7x); unrelated images placed side
// by side land at 10-20x. The +2 absorbs JPEG noise on very smooth edges.
const SEAM_RATIO = 4;
const SEAM_NOISE_FLOOR = 2;
// An edge column this flat (e.g. a screenshot's white margin) matches any other
// flat edge, so it proves nothing either way.
const MIN_EDGE_TEXTURE = 6;

let inFlight = 0;

// Cheap pre-filter from the API's sizes, before downloading anything: an
// artist who slices one wide picture into a post uploads 2-4 equal slices.
// Discord's album lays 4 images out 2x2, which breaks the picture apart.
function isPanoramaCandidate(sizes) {
  if (!Array.isArray(sizes) || sizes.length < 2 || sizes.length > 4)
    return false;
  const [first] = sizes;
  if (!first?.width || !first?.height) return false;
  return sizes.every(
    (size) => size.width === first.width && size.height === first.height,
  );
}

function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function stdDev(column) {
  let mean = 0;
  for (const value of column) mean += value;
  mean /= column.length;
  let variance = 0;
  for (const value of column) variance += (value - mean) ** 2;
  return Math.sqrt(variance / column.length);
}

// The two outermost columns on each side of a greyscale image.
function edgeColumns({ data, width, height }) {
  const column = (x) => {
    const values = new Float32Array(height);
    for (let y = 0; y < height; y += 1) values[y] = data[y * width + x];
    return values;
  };
  return {
    left: [column(0), column(1)],
    right: [column(width - 1), column(width - 2)],
  };
}

// Whether the images, in post order, continue into one another at every seam.
// Each seam compares the right edge of one slice with the left edge of the
// next; a textured seam must match, and at least one seam must be textured —
// otherwise equal-size screenshots with blank margins would pass.
function seamsAreContinuous(greyImages) {
  const edges = greyImages.map(edgeColumns);
  let informative = 0;
  for (let i = 0; i < edges.length - 1; i += 1) {
    const [a0, a1] = edges[i].right;
    const [b0, b1] = edges[i + 1].left;
    const seam = meanAbsDiff(a0, b0);
    const inner = (meanAbsDiff(a0, a1) + meanAbsDiff(b0, b1)) / 2;
    const textured =
      stdDev(a0) >= MIN_EDGE_TEXTURE && stdDev(b0) >= MIN_EDGE_TEXTURE;
    if (seam > inner * SEAM_RATIO + SEAM_NOISE_FLOOR) return false;
    if (textured) informative += 1;
  }
  return informative > 0;
}

// Decide on image buffers already in memory: returns the stitched JPEG, or
// null when the slices don't line up (different sizes, or seams that break).
async function stitchPanorama(buffers) {
  const decoded = await Promise.all(
    buffers.map((buffer) =>
      sharp(buffer)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data, info }) => ({
          data,
          width: info.width,
          height: info.height,
        })),
    ),
  );
  const [first] = decoded;
  const sameSize = decoded.every(
    (image) => image.width === first.width && image.height === first.height,
  );
  if (!sameSize || !seamsAreContinuous(decoded)) return null;

  // sharp resizes before it composites within one pipeline, so the canvas is
  // flattened to raw pixels first and scaled + encoded in a second pass.
  const canvasWidth = first.width * buffers.length;
  const { data, info } = await sharp({
    create: {
      width: canvasWidth,
      height: first.height,
      channels: 3,
      background: "#000",
    },
  })
    .composite(
      buffers.map((input, index) => ({
        input,
        left: index * first.width,
        top: 0,
      })),
    )
    .raw()
    .toBuffer({ resolveWithObject: true });
  return await sharp(data, { raw: info })
    .resize({ width: MAX_OUTPUT_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

// Download a post's slices and stitch them into one wide image for upload, or
// return null so the caller keeps its gallery. Shares the video attachment
// gates (enabled / guild allow-list / concurrency / timeout / upload cap).
// Never throws.
async function fetchPanoramaAttachment(urls, guild) {
  if (!Array.isArray(urls) || urls.length < 2) return null;
  if (!isGuildVideoAllowed(guild)) return null;
  if (inFlight >= VIDEO_ATTACHMENT_MAX_CONCURRENT) {
    console.log(
      `[panorama] skip (concurrency ${inFlight}/${VIDEO_ATTACHMENT_MAX_CONCURRENT}) → 相簿`,
    );
    return null;
  }

  const maxBytes = effectiveMaxBytes(guild);
  inFlight += 1;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    VIDEO_ATTACHMENT_TIMEOUT_MS,
  );
  try {
    const buffers = [];
    for (const url of urls) {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": BROWSER_UA },
      });
      if (!response.ok || !response.body) {
        console.log(`[panorama] fetch ${response.status} → 相簿`);
        return null;
      }
      const buffer = await readCapped(response, maxBytes);
      if (!buffer) {
        console.log(`[panorama] slice over the upload cap → 相簿`);
        return null;
      }
      buffers.push(buffer);
    }
    const stitched = await stitchPanorama(buffers);
    if (!stitched) {
      console.log(`[panorama] seams don't line up → 相簿`);
      return null;
    }
    if (stitched.length > maxBytes) {
      console.log(`[panorama] stitched over the upload cap → 相簿`);
      return null;
    }
    console.log(
      `[panorama] stitched slices=${buffers.length} bytes=${stitched.length}`,
    );
    return { buffer: stitched, name: PANORAMA_NAME };
  } catch (error) {
    console.log(`[panorama] failed: ${error.message} → 相簿`);
    return null;
  } finally {
    clearTimeout(timer);
    inFlight -= 1;
  }
}

module.exports = {
  fetchPanoramaAttachment,
  isPanoramaCandidate,
  stitchPanorama,
};

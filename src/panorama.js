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
// Thresholds tuned on 171 synthetic slices of real pixiv illustrations (95%
// stitched), 56 real equal-size multi-page works and 3192 random pairings of
// unrelated pictures (0 stitched). Every seam must pass all four tests.
//
// 1. Continuity: a true seam differs from its neighbours about as much as any
//    two adjacent columns inside one picture (1.2-1.7x); unrelated images land
//    at 10-20x. The +2 absorbs JPEG noise on very smooth edges.
const SEAM_RATIO = 4;
const SEAM_NOISE_FLOOR = 2;
// 2. Texture: a flat edge (a screenshot's white margin) matches any other flat
//    edge, so it proves nothing.
const MIN_EDGE_TEXTURE = 6;
// 3. Not a frame: when a slice's right edge also matches its own left edge,
//    the seam "matches" because both pages share a border or a backdrop, not
//    because the picture continues. The seam must beat that clearly.
const FRAME_RATIO = 2;
const FRAME_MARGIN = 3;
// 4. Aligned: nudging one edge up or down must make the match worse — real
//    detail lines up at exactly one offset; a smooth gradient lines up at all.
const MISALIGN_OFFSETS = [-16, -8, -4, 4, 8, 16];
const MISALIGN_RATIO = 1.2;

let inFlight = 0;

// Cheap pre-filter from the API's sizes, before downloading anything: an
// artist who slices one wide picture into a post (X, pixiv) uploads 2-4 equal
// slices. Discord's album lays 4 images out 2x2, which breaks the picture
// apart.
function isPanoramaCandidate(sizes) {
  if (!Array.isArray(sizes) || sizes.length < 2 || sizes.length > 4)
    return false;
  const [first] = sizes;
  if (!first?.width || !first?.height) return false;
  return sizes.every(
    (size) => size.width === first.width && size.height === first.height,
  );
}

// Mean |a[y] - b[y + offset]| over the rows both columns cover.
function meanAbsDiff(a, b, offset = 0) {
  let sum = 0;
  let count = 0;
  for (
    let y = Math.max(0, -offset);
    y < a.length && y + offset < b.length;
    y += 1
  ) {
    sum += Math.abs(a[y] - b[y + offset]);
    count += 1;
  }
  return sum / count;
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

// Whether the right edge of one slice continues into the left edge of the
// next — see the four tests above.
function seamContinues(a, b) {
  const [a0, a1] = a.right;
  const [b0, b1] = b.left;
  const seam = meanAbsDiff(a0, b0);
  const inner = (meanAbsDiff(a0, a1) + meanAbsDiff(b0, b1)) / 2;
  if (seam > inner * SEAM_RATIO + SEAM_NOISE_FLOOR) return false;
  if (Math.min(stdDev(a0), stdDev(b0)) < MIN_EDGE_TEXTURE) return false;
  const selfWrap = Math.min(
    meanAbsDiff(a0, a.left[0]),
    meanAbsDiff(b.right[0], b0),
  );
  if (selfWrap < seam * FRAME_RATIO + FRAME_MARGIN) return false;
  const misaligned = Math.min(
    ...MISALIGN_OFFSETS.map((offset) => meanAbsDiff(a0, b0, offset)),
  );
  return misaligned >= seam * MISALIGN_RATIO;
}

// Whether the images, in post order, form one picture: every seam must
// continue. A miss only costs the stitch (the album goes out instead), while a
// false stitch glues unrelated pages together — so all seams must agree.
function seamsAreContinuous(greyImages) {
  const edges = greyImages.map(edgeColumns);
  for (let i = 0; i < edges.length - 1; i += 1)
    if (!seamContinues(edges[i], edges[i + 1])) return false;
  return true;
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
// return null so the caller keeps its gallery (X / pixiv). Shares the video attachment
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

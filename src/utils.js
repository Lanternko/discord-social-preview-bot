function trimDescription(text, limit) {
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;
const COLLAPSE_SPACES_RE = / {2,}/g;
const NAME_MAX_LEN = 50;

function sanitizeName(raw) {
  if (!raw || typeof raw !== "string") return "未知";
  return raw
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/"/g, "＂")
    .replace(COLLAPSE_SPACES_RE, " ")
    .trim()
    .slice(0, NAME_MAX_LEN);
}

module.exports = { trimDescription, pickRandom, sanitizeName };

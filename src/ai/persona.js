const { sanitizeName, trimDescription } = require("../utils");

const REFERENCE_SNIPPET_MAX = 200;

// Format the message a user is replying to / forwarding into a short context
// note prepended to their turn. Pure: takes already-fetched fields, returns ""
// when there's nothing worth quoting. The async fetch lives in chain.js.
function formatReferenceContext(ref) {
  if (!ref) return "";
  const snippet = trimDescription(
    String(ref.content || "").replace(/\s+/g, " ").trim(),
    REFERENCE_SNIPPET_MAX,
  );
  if (!snippet) return "";
  if (ref.isForward) {
    return `（這則轉發了一段訊息：「${snippet}」）`;
  }
  const who = ref.authorName ? `${sanitizeName(ref.authorName)} ` : "";
  return `（這則在回覆 ${who}說的：「${snippet}」，對方多半在針對這段跟你說話）`;
}

function buildUserTurn(message, userText, referenceContext = "") {
  const raw =
    message.member?.displayName ||
    message.author?.globalName ||
    message.author?.username ||
    "使用者";
  const username = sanitizeName(raw);
  const refLine = referenceContext ? `${referenceContext}\n` : "";
  return userText
    ? `<sender name="${username}"/>\n${refLine}${userText}`
    : `<sender name="${username}"/>\n${refLine}（這個人 @ 了你但沒打字，可能想打招呼。）`;
}

function buildOpenAIMessages(turns, persona) {
  return [{ role: "system", content: persona }, ...turns];
}

function buildGeminiContents(turns) {
  return turns.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }],
  }));
}

module.exports = {
  buildUserTurn,
  formatReferenceContext,
  buildOpenAIMessages,
  buildGeminiContents,
};

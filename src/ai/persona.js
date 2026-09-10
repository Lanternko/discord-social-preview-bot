const { sanitizeName } = require("../utils");

function buildUserTurn(message, userText, extraNote = "") {
  const raw =
    message.member?.displayName ||
    message.author?.globalName ||
    message.author?.username ||
    "使用者";
  const username = sanitizeName(raw);
  // extraNote (currently the attached-image note from vision.js) goes AFTER the
  // user's own words: it is context about the message, not part of what they
  // said, and the vision path finds it by suffix when it swaps in the seeing
  // variant.
  const body = userText || "（這個人 @ 了你但沒打字，可能想打招呼。）";
  return `<sender name="${username}"/>\n${body}${extraNote}`;
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
  buildOpenAIMessages,
  buildGeminiContents,
};

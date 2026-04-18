function buildUserTurn(message, userText) {
  const username =
    message.member?.displayName ||
    message.author?.globalName ||
    message.author?.username ||
    "使用者";
  return userText
    ? `<sender name="${username}"/>\n${userText}`
    : `<sender name="${username}"/>\n（這個人 @ 了你但沒打字，可能想打招呼。）`;
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

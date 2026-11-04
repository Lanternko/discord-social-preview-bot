// 投票題 — an optional two-option opinion poll posted after the bedtime story
// ("你覺得亂源是誰？"). Same shape as story-quiz: written in the SAME model
// call as the story (zero extra API calls), split off by parseStoryPoll, and
// sent as a second message. 西寶 then reacts 1️⃣ 2️⃣ on it herself so members
// vote by tapping the reaction. Unlike the quiz there is no right answer.

const { t } = require("./system-text");

const POLL_MARKER = "【投票】";
const OPTION_MAX_CHARS = 40;
const POLL_EMOJIS = ["1️⃣", "2️⃣"];
// Added to the story's display budget on poll nights (~80 字 of poll).
const POLL_EXTRA_TOKENS = 250;

function buildStoryPollBlock() {
  return [
    "",
    "【故事寫完後，另外出一題投票】",
    `故事結束後空一行，寫一行「${POLL_MARKER}」，接著照下面格式寫，不要多寫別的：`,
    "題目：（一個讓大家想表態的問句）",
    "選項：（第一個選項）",
    "選項：（第二個選項）",
    "出題規則：",
    "- 問的是意見、不是知識：「你覺得亂源是誰？」「這鍋該怪誰？」「最該被罰的是哪一個？」（只是示範題型，不是今晚的素材）",
    "- 兩個選項都要是故事裡真的出場的人物／東西，各自都說得出理由，讓大家有得吵。不要有一個明顯的標準答案。",
    "- 選項是短答案（人名或幾個字），不要加 1／2／A／B 編號。",
  ].join("\n");
}

function cleanOption(line) {
  return line.replace(/^[（(]?([A-Ba-b12１２]|[1-2]️⃣)[)）.．、:：]?\s*/, "").trim();
}

// Returns { story, poll } — poll is null when the block is missing or fails
// validation; the story never carries the block either way.
function parseStoryPoll(text) {
  if (!text || typeof text !== "string") return { story: text, poll: null };
  const at = text.indexOf(POLL_MARKER);
  if (at < 0) return { story: text, poll: null };

  const story = text
    .slice(0, at)
    .replace(/(\s*\n)?\s*(-{3,}|\*{3,}|_{3,})\s*$/, "")
    .replace(/\s+$/, "");
  const lines = text
    .slice(at + POLL_MARKER.length)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);

  let question = "";
  const options = [];
  for (const line of lines) {
    const m = line.match(/^(題目|選項)\s*[:：]\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "題目") question = question || m[2].trim();
    else options.push(cleanOption(m[2]));
  }

  const valid =
    question &&
    options.length === POLL_EMOJIS.length &&
    options.every((o) => o && [...o].length <= OPTION_MAX_CHARS) &&
    new Set(options).size === options.length;
  if (!valid) {
    console.warn(
      `[story-poll] dropped malformed poll question=${Boolean(question)} options=${options.length}`,
    );
    return { story, poll: null };
  }
  return { story, poll: { question, options } };
}

function formatStoryPoll(poll) {
  return [
    t("poll.header"),
    poll.question,
    "",
    ...poll.options.map((option, i) => `${POLL_EMOJIS[i]} ${option}`),
  ].join("\n");
}

// Best effort: a failed reaction (missing AddReactions permission, deleted
// message) must not take down the story that already went out.
async function addPollReactions(message) {
  for (const emoji of POLL_EMOJIS) {
    try {
      await message.react(emoji);
    } catch (err) {
      console.warn(`[story-poll] react ${emoji} failed: ${err.message}`);
      return false;
    }
  }
  return true;
}

module.exports = {
  POLL_MARKER,
  POLL_EMOJIS,
  POLL_EXTRA_TOKENS,
  buildStoryPollBlock,
  parseStoryPoll,
  formatStoryPoll,
  addPollReactions,
};

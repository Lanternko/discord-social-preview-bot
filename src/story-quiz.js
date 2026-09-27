// 閱讀測驗 — an optional multiple-choice question posted after the bedtime
// story. Written in the SAME model call as the story (zero extra API calls):
// the prompt asks for a marked block after the story, parseStoryQuiz splits it
// off, and the quiz goes out as a second message with the answer in a spoiler.
//
// The model marks which option is right (正解 / 誤) instead of writing A–D
// itself; we shuffle locally. Models put the answer on B/C far more often
// than chance, and a quiz whose answer is always C stops being a quiz.

const QUIZ_MARKER = "【閱讀測驗】";
const OPTION_MAX_CHARS = 80;
const LETTERS = ["A", "B", "C", "D"];
// Added to the story's display budget on quiz nights (~150 字 of quiz).
const QUIZ_EXTRA_TOKENS = 400;

function buildStoryQuizBlock() {
  return [
    "",
    "【故事寫完後，另外出一題閱讀測驗】",
    `故事結束後空一行，寫一行「${QUIZ_MARKER}」，接著照下面格式寫，不要多寫別的：`,
    "題目：（一個直接的問句）",
    "正解：（唯一正確的答案）",
    "誤：（錯誤答案）",
    "誤：（錯誤答案）",
    "誤：（錯誤答案）",
    "出題規則：",
    "- 直接問故事裡的一件事：關鍵動作是誰做的、誰說了那句暴論、某人為什麼要那樣做、他用什麼東西／喜歡什麼。例如「把磚窯推倒的是誰？」「海豹為什麼把麵吐回鍋裡？」「照故事的說法，寫小說要用什麼軟體？」（只是示範題型，不是今晚的素材）",
    "- 不要出「下列何者敘述正確／錯誤」這種題型，不要把四句情節描述丟給讀者比對。",
    "- 問的要是這個故事的笑點或關鍵轉折本身——讀完會記得、答對會笑的那件事。不要問誰拿了什麼道具、誰做了哪個順手的小動作、數字、顏色這種細節。",
    "- 選項是短答案，跟題目同一類：問「誰」就四個人名，問「用什麼」就四樣東西，問「為什麼」就四個簡短的理由。不要加 A/B/C/D 編號。",
    "- 正解必須能在故事裡直接找到根據，讀過的人不會有爭議。",
    "- 錯誤答案要像真的：問人就用故事裡真的出場的其他人，問東西就用故事裡出現過或同類的東西，問理由就用故事裡別人的說法或因果顛倒的版本。可以有一個是好笑的。",
    "- 四個選項長度差不多，正解不要是最長、最具體的那個。",
  ].join("\n");
}

function cleanOption(line) {
  return line.replace(/^[（(]?[A-Da-d][)）.．、:：]\s*/, "").trim();
}

// Returns { story, quiz } — quiz is null when the block is missing or fails
// validation. The story never carries the block either way: a malformed quiz
// is dropped silently, it must not leak into (or sink) the story.
function parseStoryQuiz(text) {
  if (!text || typeof text !== "string") return { story: text, quiz: null };
  const at = text.indexOf(QUIZ_MARKER);
  if (at < 0) return { story: text, quiz: null };

  // Models sometimes draw a `---` rule before the marker; it's a divider for
  // the quiz, not part of the story.
  const story = text
    .slice(0, at)
    .replace(/(\s*\n)?\s*(-{3,}|\*{3,}|_{3,})\s*$/, "")
    .replace(/\s+$/, "");
  const lines = text
    .slice(at + QUIZ_MARKER.length)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);

  let question = "";
  let correct = "";
  const wrong = [];
  for (const line of lines) {
    const m = line.match(/^(題目|正解|誤)\s*[:：]\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "題目") question = question || m[2].trim();
    else if (m[1] === "正解") correct = correct || cleanOption(m[2]);
    else wrong.push(cleanOption(m[2]));
  }

  const options = [correct, ...wrong];
  const valid =
    question &&
    correct &&
    wrong.length === 3 &&
    options.every((o) => o && [...o].length <= OPTION_MAX_CHARS) &&
    new Set(options).size === 4;
  if (!valid) {
    console.warn(
      `[story-quiz] dropped malformed quiz question=${Boolean(question)} correct=${Boolean(correct)} wrong=${wrong.length}`,
    );
    return { story, quiz: null };
  }
  return { story, quiz: { question, correct, wrong } };
}

function shuffleQuizOptions(quiz, rng = Math.random) {
  const options = [quiz.correct, ...quiz.wrong];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { options, answer: LETTERS[options.indexOf(quiz.correct)] };
}

function formatStoryQuiz(quiz, rng = Math.random) {
  const { options, answer } = shuffleQuizOptions(quiz, rng);
  return [
    "📝 **閱讀測驗**",
    quiz.question,
    "",
    ...options.map((option, i) => `${LETTERS[i]}. ${option}`),
    "",
    `正確答案：||${answer}||`,
  ].join("\n");
}

module.exports = {
  QUIZ_MARKER,
  QUIZ_EXTRA_TOKENS,
  buildStoryQuizBlock,
  parseStoryQuiz,
  shuffleQuizOptions,
  formatStoryQuiz,
};

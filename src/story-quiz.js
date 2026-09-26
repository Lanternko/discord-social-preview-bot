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
    "題目：（一句話的題幹，例如「根據〈標題〉，下列何者敘述正確？」，也可以直接問故事裡的某件事）",
    "正解：（唯一正確的選項）",
    "誤：（錯誤選項）",
    "誤：（錯誤選項）",
    "誤：（錯誤選項）",
    "出題規則：",
    "- 正解必須能在故事裡直接找到根據，讀過的人不會有爭議。",
    "- 三個錯誤選項都要跟故事裡明寫的內容矛盾（張冠李戴誰做了什麼、因果顛倒、改掉結局），不能只是「故事沒提到」——沒提到的東西會變成兩個答案都說得通。",
    "- 錯誤選項要像真的，最好用故事裡真的出現過的人和東西去錯配，讓只掃過一眼的人會猶豫。可以有一個選項是好笑的。",
    "- 四個選項長度差不多，每個一句話，不要加 A/B/C/D 編號。",
    "- 題目考的是故事的關鍵情節或笑點，不要考數字、顏色這種細節。",
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

  const story = text.slice(0, at).replace(/\s+$/, "");
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

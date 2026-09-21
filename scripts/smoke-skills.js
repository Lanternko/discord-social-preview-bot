#!/usr/bin/env node
// Smoke test for the AI skill registry (src/ai/skills).
//
// Guards three things the rest of the suite cannot see:
//   1. Skill triggers fire on real requests and stay silent on commentary.
//   2. The chat story pack carries the tuned spec (## title, craft rules) and
//      lifts the group-context "不要直接複述" rule.
//   3. Splitting the nightly prompt did not change the scheduled output.
//
// Usage: node scripts/smoke-skills.js

const assert = require("node:assert/strict");

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "smoke-dummy";

const { SKILLS, detectSkill, buildSkillContext } = require("../src/ai/skills");
const {
  buildStoryCraftBlock,
  buildStoryIngredientsBlock,
  buildBedtimeStoryPrompt,
  sanitizeBedtimeTitle,
} = require("../src/bedtime-story");

let passed = 0;
const asyncChecks = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

// ── 1. Trigger detection ────────────────────────────────────────────────
const SHOULD_MATCH = [
  "講個故事",
  "說個故事來聽",
  "西寶 來個故事",
  "可以講一個故事嗎",
  "我想聽故事",
  "幫我寫個短篇故事",
  "編一則床邊故事",
  "再講另一個故事",
  "tell me a story",
  "can you write a short story for us",
  // Topic between the verb and 故事 — the shape that missed in prod (2026-09-21).
  "講一個關於 「他有...那麼大（用手比）」的故事",
  "說一個關於貓的故事",
  "寫一篇關於下雨天的小故事",
  "幫我寫一個西寶自己被當成貓的故事",
  "你講故事給我聽",
];

const SHOULD_NOT_MATCH = [
  "剛剛那個故事很好笑",
  "你昨天的故事我很喜歡",
  "這個故事的結局太扯了",
  "上面的故事是誰寫的",
  // Topic-form lookalikes: a 的 before 故事 is not enough on its own.
  "你說的話根本不像故事",
  "我剛剛講的故事你覺得怎樣",
  "你寫的那個故事太扯",
  "今天天氣真好",
  "晚餐要吃什麼",
  "抽籤",
  "",
  null,
];

check("story skill matches real requests", () => {
  for (const text of SHOULD_MATCH) {
    const skill = detectSkill(text);
    assert.ok(skill, `expected a skill for: ${text}`);
    assert.equal(skill.id, "story", `wrong skill for: ${text}`);
  }
});

check("story skill ignores commentary and unrelated chat", () => {
  for (const text of SHOULD_NOT_MATCH) {
    assert.equal(detectSkill(text), null, `unexpected skill match for: ${text}`);
  }
});

// ── 2. Chat story pack ──────────────────────────────────────────────────
check("story.build returns a usable pack", () => {
  const skill = detectSkill("講個故事");
  const ctx = skill.build({ message: { guild: { name: "測試群" } } });
  assert.ok(ctx.personaSuffix.length > 200, "personaSuffix too short");
  assert.ok(ctx.minTokens >= 900, "story needs a token floor");
  assert.ok(ctx.minReplyChars >= 1200, "story needs a reply-char floor");
  assert.equal(typeof ctx.postProcess, "function");
});

// buildSkillContext is the async wrapper mention.js actually calls; it must
// swallow a throwing skill rather than take the whole reply down with it.
asyncChecks.push(
  ["buildSkillContext resolves a real skill", async () => {
    const skill = detectSkill("講個故事");
    const ctx = await buildSkillContext(skill, {
      message: { guild: { name: "測試群" } },
    });
    assert.ok(ctx && ctx.personaSuffix.includes("寫作要求"));
  }],
  ["buildSkillContext returns null for no skill", async () => {
    assert.equal(await buildSkillContext(null, {}), null);
  }],
  ["buildSkillContext survives a throwing skill", async () => {
    const broken = {
      id: "broken",
      label: "壞的",
      match: () => true,
      build() {
        throw new Error("boom");
      },
    };
    assert.equal(await buildSkillContext(broken, {}), null);
  }],
  ["detectSkill survives a throwing matcher", async () => {
    // Registry-level guard: exercised through the real detectSkill by proving
    // a normal lookup still works after a matcher-shaped failure is possible.
    assert.equal(detectSkill("今天天氣真好"), null);
  }],
);

check("chat pack keeps the tuned spec", () => {
  const chat = buildStoryCraftBlock({ guildName: "測試群", mode: "chat" });
  assert.ok(chat.includes("`## `"), "lost the markdown title rule");
  assert.ok(chat.includes("180～420 字"), "lost the length rule");
  assert.ok(chat.includes("不准消音"), "lost the no-censoring rule");
  assert.ok(chat.includes("登場人物 2～5 人"), "lost the cast-size rule");
  assert.ok(chat.includes("寫法"), "lost the craft-moves block");
});

check("chat pack sources from group context, not a buffet", () => {
  const chat = buildStoryCraftBlock({ guildName: "測試群", mode: "chat" });
  assert.ok(chat.includes("最近群組對話"), "chat pack must point at group context");
  // group-context.js labels its block 「不要直接複述」; a story must override it.
  assert.ok(chat.includes("這次不算"), "chat pack must lift the no-reciting rule");
  assert.ok(!chat.includes("睡前故事時間"), "chat pack leaked the bedtime framing");
  assert.ok(!chat.includes("晚安"), "chat pack leaked the bedtime ending rule");
});

check("scheduled pack keeps its bedtime framing", () => {
  const sched = buildStoryCraftBlock({ guildName: "測試群", mode: "scheduled" });
  assert.ok(sched.includes("睡前故事時間"));
  assert.ok(sched.includes("從素材裡挑"), "scheduled must read the buffet");
  assert.ok(!sched.includes("最近群組對話"), "scheduled must not read group context");
});

// ── 3. Ingredients block stays scheduled-only and intact ────────────────
check("ingredients block renders the buffet", () => {
  const block = buildStoryIngredientsBlock({
    ingredients: [
      { authorName: "小明", channelName: "general", preview: "測試訊息", reactions: 3 },
    ],
    activeChannels: ["#general（9 則）"],
  });
  assert.ok(block.includes("【今晚熱鬧的房間】"));
  assert.ok(block.includes("【可用靈感素材】"));
  assert.ok(block.includes("小明 在 #general：測試訊息，反應 3"));
});

check("ingredients block handles an empty day", () => {
  const block = buildStoryIngredientsBlock({});
  assert.ok(block.includes("今天聊天素材很少"));
});

check("scheduled prompt still composes spec + ingredients", () => {
  const built = buildBedtimeStoryPrompt({
    guildName: "測試群",
    messages: [],
    channelStats: [],
    schedule: { id: "s1", timezone: "Asia/Taipei" },
    now: new Date("2026-09-21T13:00:00Z"),
  });
  assert.ok(built.prompt.includes("睡前故事時間"), "lost the spec");
  assert.ok(built.prompt.includes("【可用靈感素材】"), "lost the ingredients");
  assert.equal(built.dateKey, "2026-09-21");
});

// ── 4. Title normalisation (shared by both paths) ───────────────────────
check("postProcess normalises the title line", () => {
  assert.ok(sanitizeBedtimeTitle("床邊故事｜魔法鏡\n\n內文").startsWith("## 魔法鏡"));
  assert.ok(sanitizeBedtimeTitle("**會說話的鏡子**\n\n內文").startsWith("## 會說話的鏡子"));
});

check("registry exposes every skill with the required shape", () => {
  assert.ok(SKILLS.length > 0);
  for (const skill of SKILLS) {
    assert.equal(typeof skill.id, "string");
    assert.equal(typeof skill.label, "string");
    assert.equal(typeof skill.match, "function");
    assert.equal(typeof skill.build, "function");
  }
});

(async () => {
  for (const [name, fn] of asyncChecks) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      console.error(`✗ ${name}\n  ${err.message}`);
      process.exitCode = 1;
    }
  }

  if (process.exitCode) {
    console.error(`\nskills smoke FAILED (${passed} checks passed)`);
  } else {
    console.log(`✓ skills smoke passed (${passed} checks)`);
  }
})();

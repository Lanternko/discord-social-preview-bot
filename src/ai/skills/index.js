// Skill registry — per-situation prompt packs 西寶 can reach from normal chat.
//
// A "skill" is a tuned prompt that already exists for some scheduled task, made
// reachable by asking in natural language. Each one owns: how to recognise the
// request (`match`), and what to add to the call (`build`). Detection is a
// cheap local regex, so a skill costs ZERO extra API calls — the pack is folded
// into the single reply call that was going to happen anyway.
//
// Scope: generation-shaped requests that need a specific prompt. Hardcoded
// rule-based replies (抽籤/運勢, 道歉) stay in mention.js — they are not prompts
// and must never reach a model.
//
// Adding a skill: drop a module here exporting { id, label, match, build } and
// list it below. Order matters — first match wins, so put the narrow ones first.

const story = require("./story");

const SKILLS = [story];

// Returns the first skill whose trigger the text matches, or null.
function detectSkill(text) {
  for (const skill of SKILLS) {
    try {
      if (skill.match(text)) return skill;
    } catch (err) {
      // A broken matcher must never take down a normal reply.
      console.warn(`[skill] matcher failed id=${skill.id}: ${err.message}`);
    }
  }
  return null;
}

// Resolve a skill into the options generateAIReply understands. Returns null on
// any failure so the caller falls straight back to an ordinary reply.
async function buildSkillContext(skill, ctx) {
  if (!skill) return null;
  try {
    const built = await skill.build(ctx);
    if (!built || !built.personaSuffix) return null;
    return built;
  } catch (err) {
    console.warn(`[skill] build failed id=${skill.id}: ${err.message}`);
    return null;
  }
}

module.exports = { SKILLS, detectSkill, buildSkillContext };

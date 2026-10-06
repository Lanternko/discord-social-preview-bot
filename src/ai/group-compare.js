// Group-wide comparison context for 「群組裡誰最…」/「給出排名」 requests.
//
// The long-term memory block in chain.js only describes the CURRENT speaker,
// and target-context.js only pulls in third parties that are @mentioned or
// named under imitation intent. A question about the whole group therefore
// reached the model with zero profiles: 西寶 ranked people by message count
// and whatever happened to be in the last 15 lines. This module detects the
// comparison intent and surfaces short profile snippets for the most active
// members so the ranking can lean on what she actually remembers.
//
// Detection is recall-first (see skill-trigger notes): a false positive only
// costs a few hundred prompt tokens, a miss is silent.

const { sanitizeName } = require("../utils");

const MAX_PEOPLE = 12; // cap so a big guild can't balloon the prompt
const SNIPPET_LEN = 200; // per-person profile chars

function detectGroupCompareIntent(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.normalize("NFC");
  if (/排名|排行|排序|名次|前[三五十]名|top\s*\d|\brank/i.test(t)) return true;
  // 「誰最像」「誰比較會」「哪個人最」「誰是群裡最…」
  if (/(誰|哪[個位一]人?)(才)?(是)?(最|比較|更)/.test(t)) return true;
  // 「群組裡誰…」「大家之中誰…」— a "who" question scoped to the group
  if (/(群組|群裡|群內|這群|伺服器|大家|我們|你們|群友).{0,8}(誰|哪[個位])/.test(t)) return true;
  return false;
}

// Pick people to describe: most active first (roster is sorted by count), then
// anyone in the recent channel window the roster missed. Only people with a
// usable profile text make the cut — a bare name adds nothing over the roster.
function selectCompareCandidates({ roster, groupEntries, profileTextFor, excludeIds, max = MAX_PEOPLE }) {
  const exclude = new Set(excludeIds || []);
  const seen = new Set();
  const out = [];
  const consider = (userId, name) => {
    if (!userId || seen.has(userId) || exclude.has(userId)) return;
    seen.add(userId);
    const profile = (profileTextFor(userId) || "").trim();
    if (!profile) return;
    out.push({ userId, name: name || null, profile });
  };
  for (const r of roster || []) {
    if (out.length >= max) break;
    consider(r.userId, r.name);
  }
  for (const e of groupEntries || []) {
    if (out.length >= max) break;
    consider(e.userId, e.displayName);
  }
  return out;
}

// The rendered profile leads with 說話風格, which says nothing a ranking can
// use; topics and habits do. Drop the style line when anything else is left so
// the snippet budget goes to the useful fields.
function compactProfile(profile) {
  const lines = String(profile).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const useful = lines.filter((l) => !l.startsWith("說話風格"));
  return (useful.length > 0 ? useful : lines).join("；").slice(0, SNIPPET_LEN);
}

function buildGroupCompareBlock(people) {
  if (!people || people.length === 0) return "";
  const lines = [
    "## 群友印象（比較／排名題用）",
    "這則訊息在問群裡的人之間的比較或排名。下面是你對幾位常出現的群友的長期印象，" +
      "排的時候拿這些具體的話題、習慣、口頭禪當理由，而不是只看誰講得多。" +
      "印象裡沒有直接根據的事（尤其是性癖、性取向這類），不要說成事實——" +
      "可以從他們常聊的東西硬凹、開玩笑，但要讓人看得出是你在凹。不用每個人都提，挑有梗的就好。",
  ];
  for (const p of people) {
    lines.push(`- ${sanitizeName(p.name || "未知")}：${compactProfile(p.profile)}`);
  }
  return lines.join("\n");
}

module.exports = {
  MAX_PEOPLE,
  detectGroupCompareIntent,
  compactProfile,
  selectCompareCandidates,
  buildGroupCompareBlock,
};

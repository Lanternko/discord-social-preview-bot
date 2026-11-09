// Regenerates src/s2t-map.json from OpenCC's character dictionaries.
//
//   node scripts/build-s2t-map.js
//
// The map holds only Simplified characters it is SAFE to rewrite one at a time
// in a 繁體 reply (see src/traditional.js for why it is per-character):
//   - exactly one Traditional counterpart in STCharacters. 历→歷/曆, 发→發/髮,
//     复→復/複/覆 need the surrounding word, so they stay out — unless listed
//     in PREFER, where the first form is the only one Taiwan chat really uses.
//   - not itself a Traditional character (TSCharacters key or an ST value):
//     a 繁體 text that already uses it must come through untouched.
//   - not in KEEP: characters Taiwan writes as-is or that turn up in names.
// Targets then go through TWVariants (爲→為, 裏→裡...).
const fs = require("fs");
const path = require("path");

const TAG = "ver.1.1.9";
const BASE = `https://raw.githubusercontent.com/BYVoid/OpenCC/${TAG}/data/dictionary`;

// One-to-many entries whose first form is safe in a modern chat reply.
const PREFER = {
  个: "個", 万: "萬", 当: "當", 种: "種", 确: "確", 证: "證", 党: "黨",
  别: "別", 尽: "盡", 极: "極", 获: "獲", 药: "藥", 虫: "蟲", 胜: "勝",
  据: "據", 挂: "掛", 恶: "惡", 汇: "匯", 摆: "擺", 参: "參", 叶: "葉",
  广: "廣", 厂: "廠", 尝: "嘗", 宁: "寧", 愿: "願", 杰: "傑", 链: "鏈",
  针: "針", 钥: "鑰", 铲: "鏟", 镰: "鐮", 闲: "閒", 饥: "飢", 毁: "毀",
  柜: "櫃", 筑: "築", 炼: "煉", 卤: "滷", 叹: "嘆", 涌: "湧", 荡: "蕩",
  荐: "薦", 苹: "蘋", 腊: "臘", 迹: "跡", 鉴: "鑑", 录: "錄", 弥: "彌",
  纤: "纖", 钻: "鑽", 丰: "豐", 仑: "侖", 坛: "壇", 坝: "壩", 术: "術",
  杠: "槓",
};

// Never rewritten even when the dictionary says one-to-one: Taiwan writes
// these as-is in common words (台灣, 公里, 准), or they are Japanese
// shinjitai that show up in anime/idol names (恋鐘).
const KEEP = new Set([..."台里准干斗伙丑栗恋只松系冲板面发谷适苏范御致志周咸游朴签团回占托叙岩凶虱划借蒙克才表云咨卷升胡娘尸几余征舍折刮价沈于了雇"]);

async function fetchDict(name) {
  const res = await fetch(`${BASE}/${name}.txt`);
  if (!res.ok) throw new Error(`${name}: http ${res.status}`);
  return (await res.text())
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [k, v] = l.split("\t");
      return [k, v.split(" ")];
    });
}

async function main() {
  const [st, ts, twv] = await Promise.all(
    ["STCharacters", "TSCharacters", "TWVariants"].map(fetchDict),
  );
  const tsKeys = new Set(ts.map(([k]) => k));
  const tradValues = new Set(st.flatMap(([, v]) => v));
  const twVariant = new Map(twv.map(([k, v]) => [k, v[0]]));

  const map = {};
  for (const [s, targets] of st) {
    if ([...s].length !== 1) continue;
    const cp = s.codePointAt(0);
    if (cp < 0x4e00 || cp > 0x9fff) continue;
    if (KEEP.has(s)) continue;
    const t = PREFER[s] ?? (targets.length === 1 ? targets[0] : null);
    if (!t || t === s) continue;
    if (!PREFER[s] && (tradValues.has(s) || tsKeys.has(s))) continue;
    // 群→羣→群, 床→牀→床: TWVariants folds OpenCC's old forms back, so these
    // are already the Taiwan form and must not be counted as conversions.
    const tw = twVariant.get(t) || t;
    if (tw !== s) map[s] = tw;
  }
  const out = path.join(__dirname, "..", "src", "s2t-map.json");
  fs.writeFileSync(out, JSON.stringify(map) + "\n");
  console.log(`wrote ${Object.keys(map).length} entries to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

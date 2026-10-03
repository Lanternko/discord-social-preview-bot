// Offline classification eval; labels are editorial judgments, not LLM scores.
const fs = require('node:fs');
const path = require('node:path');
const { isForeignPost } = require('../src/translation-preview');
const corpus = require('../docs/translation-real-tweets-2026-10-04.json');
const controls = [
  { id: 'url-only', text: 'https://example.com', expectedDisplay: false },
  { id: 'tags-only', text: '#ブルアカ #BlueArchive @Blue_ArchiveJP', language: 'ja', expectedDisplay: false },
  { id: 'emoji-only', text: '😭🎉💙', language: 'ja', expectedDisplay: false },
  { id: 'cn-only', text: '今天維護已結束，記得領取補償！', expectedDisplay: false },
  { id: 'cn-brand', text: '今天玩 Blue Archive，還有 AI agents 的研究。', language: 'zh', expectedDisplay: false },
  { id: 'cn-en-clause', text: '不要漏看公告，以下是需要留意的退款條件：Tickets are not refundable after purchase.', language: 'zh', expectedDisplay: true },
  { id: 'cn-ja-clause', text: '剛剛看到官方這樣說：メンテナンスが終わりました！', language: 'zh', expectedDisplay: true },
  { id: 'short-ja', text: 'お渡しするよー！', expectedDisplay: true },
  { id: 'short-ko', text: '안녕하세요!', expectedDisplay: true },
  { id: 'short-en', text: 'No refunds.', expectedDisplay: true },
  { id: 'one-name', text: 'アロナ #ブルアカ', language: 'ja', expectedDisplay: false },
  { id: 'one-word-label', text: 'Release', language: 'en', expectedDisplay: false },
];
function evaluate(cases, omitLanguage = false) {
  const rows = cases.map(c => ({ id: c.id, sourceUrl: c.sourceUrl, expected: c.expectedDisplay,
    actual: isForeignPost({ text: c.text, language: omitLanguage ? '' : c.language }) }));
  const tp = rows.filter(r => r.expected && r.actual).length;
  const fp = rows.filter(r => !r.expected && r.actual).length;
  const fn = rows.filter(r => r.expected && !r.actual).length;
  const tn = rows.filter(r => !r.expected && !r.actual).length;
  return { total: rows.length, tp, fp, fn, tn, precision: tp / (tp + fp), recall: tp / (tp + fn), rows };
}
const report = { testedAt: new Date().toISOString(), notes: 'Real corpus and synthetic edge controls are reported separately. No paid API calls. Ground-truth labels reflect useful foreign prose for a Taiwan-Chinese reader. Purposeful small sample, not a population estimate.',
  realWithMetadata: evaluate(corpus.cases), realWithoutMetadata: evaluate(corpus.cases, true), syntheticControls: evaluate(controls) };
const target = path.join(__dirname, '../data/translation-filter-eval.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(report, null, 2));
for (const [mode, result] of Object.entries(report)) {
  if (!result.rows) continue;
  console.log(`${mode}: ${result.total} cases TP=${result.tp} FP=${result.fp} FN=${result.fn} TN=${result.tn}`);
  for (const r of result.rows.filter(r => r.actual !== r.expected)) console.log(`  mismatch ${r.id}: expected=${r.expected} actual=${r.actual}`);
}

const {
  getUserProfile,
  getPendingInteractions,
  clearPending,
  appendObservations,
  setProfileItems,
  listPendingBacklog,
  listUserProfiles,
  confirmedAliases,
  isStableEvidence,
  isItemStale,
  mergeEvidenceNewest,
  fieldByKeyOrLabel,
  sanitizeItems,
  capByPriority,
  freshObservations,
  detailsOf,
  tokenSimilarity,
  PROFILE_FIELDS,
  ITEM_TEXT_MAX_LEN,
  STABLE_MIN_DISTINCT_MESSAGES,
  STABLE_TIME_GAP_MS,
} = require("../user-profile-store");
const {
  getGuildProfile,
  getPendingContexts,
  clearPendingContexts,
  appendObservations: appendGuildObservations,
  setGuildProfileItems,
  GUILD_FIELDS,
  GUILD_ITEM_TEXT_MAX_LEN,
  isGuildStableEvidence,
  guildFieldOf,
  isGuildItemStale,
  sanitizeGuildItems,
} = require("../guild-profile-store");

const EXTRACT_MIN_COUNT = 5;
const EXTRACT_MIN_COUNT_TIME = 2;
const EXTRACT_MAX_TOTAL_CHARS = 2000;
const EXTRACT_TIME_THRESHOLD_MS = 30 * 60 * 1000;
const EXTRACT_MAX_TOKENS = 300;
const EXTRACT_MAX_OBSERVATIONS = 3;

const CONSOLIDATE_MIN_COUNT = 12;
const CONSOLIDATE_MAX_TOTAL_CHARS = 1200;
const CONSOLIDATE_MIN_COUNT_TIME = 5;
const CONSOLIDATE_TIME_THRESHOLD_MS = 24 * 60 * 60 * 1000;
// A full structured file (up to 12 items × field/text/from) runs ~600 tokens
// of JSON, and reasoning models spend 2-3k thinking first; 500 truncated it
// mid-array and the parse failed.
const CONSOLIDATE_MAX_TOKENS = 1500;
// A truncated/garbled answer is retried once — reasoning length varies run to
// run, so the second try usually fits. Never salvage a truncated array: every
// item cut off would read as "uncited" and silently vanish from the profile.
const CONSOLIDATE_ATTEMPTS = 2;

const extractInFlight = new Set();
const consolidateInFlight = new Set();

const EXTRACTION_PERSONA = `你是一個中立的行為紀錄助手。你的工作是從對話紀錄中提取使用者的**穩定人格特徵**，並為每一條標註依據。

## 資料格式
對話紀錄逐條編號。【直接互動】是使用者直接對西寶說的話（含西寶回覆）；【旁聽片段】是使用者在群組裡的一般發言，只是被旁聽到，**證據力較低**。

## 規則
- 只記錄**穩定偏好、性格傾向、說話語氣、常聊話題、興趣、互動偏好**（例如：常用特定口頭禪、對某話題持續有興趣、說話語氣特徵）
- 用中性、可驗證的行為描述（例：「常用『欠扁』開玩笑」「多次聊到棒球」）；**不要**寫評價式或討好式形容（例：幽默、擅長、很有魅力），也不要貶低
- 特徵主要須由【直接互動】支持；【旁聽片段】只能當輔助，或同一特徵出現在多則**不同編號**的旁聽時才可採用
- **不記錄**：單次情緒、暫時狀態、敏感推測（政治傾向、健康、性取向、宗教、真實身份）
- 顯示名稱／暱稱裡的裝飾字（版本後綴、tag、稱號）不是人格證據，不要當成「自稱」記錄
- 不確定就回空 observations
- 每條 observation 不超過 30 字
- evidence 必填：支持該條觀察的對話編號（數字陣列）；找不到依據的條目不要輸出
- confidence 0~1，同一特徵出現在越多**不同編號**才能給越高

## 輸出格式
嚴格回傳 JSON，不要加任何其他文字：
{"observations":[{"text":"觀察內容","confidence":0.7,"evidence":[1,3]}]}

最多 3 條。沒有值得記的就回：
{"observations":[]}`;

function shouldExtract(guildId, userId) {
  const entry = getUserProfile(guildId, userId);
  const pending = entry?.pendingInteractions ?? [];
  if (pending.length === 0) return false;

  if (pending.length >= EXTRACT_MIN_COUNT) return true;

  const totalChars = pending.reduce(
    (sum, p) => sum + (p.userText?.length ?? 0) + (p.assistantText?.length ?? 0),
    0,
  );
  if (totalChars >= EXTRACT_MAX_TOTAL_CHARS) return true;

  if (pending.length >= EXTRACT_MIN_COUNT_TIME) {
    const last = entry.lastExtractedAt ?? 0;
    if (Date.now() - last >= EXTRACT_TIME_THRESHOLD_MS) return true;
  }

  return false;
}

// Old records predate the source field: a recorded assistant reply means the
// user talked to 西寶 directly, an empty one means a passively scooped
// group-context line.
function pendingSource(p) {
  if (p?.source === "passive" || p?.source === "direct") return p.source;
  return p?.assistantText ? "direct" : "passive";
}

function buildExtractionTurns(pending) {
  const lines = pending.map((p, i) => {
    const n = i + 1;
    if (pendingSource(p) === "passive") {
      return `#${n}【旁聽片段】${p.userText || "（空）"}`;
    }
    return `#${n}【直接互動】使用者：${p.userText || "（空）"}\n西寶：${p.assistantText || "（空）"}`;
  });
  return [
    {
      role: "user",
      content: `以下是最近的對話紀錄（逐條編號），請從中提取使用者的穩定人格特徵，並在 evidence 附上依據的編號：\n\n${lines.join("\n\n")}`,
    },
  ];
}

function parseEvidenceIndices(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const v of value) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function parseExtractionResult(text) {
  if (!text) return [];
  const cleaned = text.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed?.observations)) return [];
    return parsed.observations
      .filter((o) => o?.text && typeof o.text === "string")
      .slice(0, EXTRACT_MAX_OBSERVATIONS)
      .map((o) => ({
        text: o.text.slice(0, 120),
        confidence: o.confidence,
        evidence: parseEvidenceIndices(o.evidence),
      }));
  } catch {
    console.warn("[observation-extractor] failed to parse LLM output");
    return [];
  }
}

// Confidence is code-enforced, not LLM-trusted: resolve the model's evidence
// indices to real {messageId, at, source} records, then cap confidence by
// what the evidence actually supports. Passive-only evidence can never carry
// a high-confidence trait on its own.
const EVIDENCE_CAP_NO_MESSAGE = 0.3;
const EVIDENCE_CAP_SINGLE_MESSAGE = 0.4;
const EVIDENCE_CAP_PASSIVE_ONLY = 0.5;

function attachEvidence(observations, pending) {
  return observations.map((o) => {
    const evidence = [];
    const seen = new Set();
    for (const idx of o.evidence || []) {
      const p = pending[idx - 1];
      if (!p?.messageId || seen.has(p.messageId)) continue;
      seen.add(p.messageId);
      evidence.push({
        messageId: p.messageId,
        at: typeof p.at === "number" ? p.at : null,
        source: pendingSource(p),
      });
    }
    let confidence =
      typeof o.confidence === "number" && Number.isFinite(o.confidence)
        ? o.confidence
        : 0.5;
    if (evidence.length === 0) {
      confidence = Math.min(confidence, EVIDENCE_CAP_NO_MESSAGE);
    } else if (evidence.length === 1) {
      confidence = Math.min(confidence, EVIDENCE_CAP_SINGLE_MESSAGE);
    }
    if (evidence.length > 0 && evidence.every((e) => e.source === "passive")) {
      confidence = Math.min(confidence, EVIDENCE_CAP_PASSIVE_ONLY);
    }
    return { ...o, confidence, evidence };
  });
}

// Stability bar lives in the store (items share it); see isStableEvidence.
function isStableObservation(obs) {
  return isStableEvidence(obs?.evidence);
}

async function maybeExtractObservations(guildId, userId, displayName, runChain) {
  if (!guildId || !userId || !runChain) return;
  if (!shouldExtract(guildId, userId)) return;

  const key = `${guildId}:${userId}`;
  if (extractInFlight.has(key)) return;
  extractInFlight.add(key);

  try {
    const pending = getPendingInteractions(guildId, userId);
    if (pending.length === 0) return;

    const turns = buildExtractionTurns(pending);
    const result = await runChain(
      turns,
      EXTRACTION_PERSONA,
      EXTRACT_MAX_TOKENS,
    );

    if (!result) {
      console.warn("[observation-extractor] chain exhausted, skipping extraction");
      return;
    }

    const observations = attachEvidence(parseExtractionResult(result.text), pending);
    console.log(
      `[observation-extractor] user=${userId} provider=${result.provider.label} extracted=${observations.length} from=${pending.length} pending evidence=${observations.map((o) => o.evidence.length).join(",") || "-"}`,
    );

    if (observations.length > 0) {
      appendObservations(guildId, userId, displayName, observations);
    }
    clearPending(guildId, userId);

    maybeConsolidateProfile(guildId, userId, runChain).catch(() => {});
  } catch (err) {
    console.warn(`[observation-extractor] error: ${err.message}`);
  } finally {
    extractInFlight.delete(key);
  }
}

// --- Consolidation ---

const FIELD_LIST_TEXT = PROFILE_FIELDS.map((f) => `${f.key}（${f.label}，最多 ${f.max} 條）`).join("、");

const CONSOLIDATION_PERSONA = `你是一個中立的人格資料整理助手。你的工作是維護一份「條列式」人格檔案：固定欄位、每欄幾條短條目，每條都要標出處。

## 欄位
${FIELD_LIST_TEXT}
- style：說話方式、口頭禪、語氣
- topics：常聊的話題、興趣
- interaction：怎麼跟人/西寶互動
- notes：相處時值得知道的具體習慣（選填）

## 條目來源與權重
- 【既有條目 I*】是舊印象：沒被新觀察推翻就原樣保留（text 照抄、from 填它自己的編號）
- 新觀察和既有條目矛盾時，**以新觀察為準**：刪掉或改寫舊條目
- 既有條目裡帶評價、且沒有觀察支持的（例：強詞奪理、靈魂人物），改寫成具體行為或刪掉
- 【新觀察 O*】可以新增條目，也可以補強既有條目（from 同時填 I 和 O）
- 【細節 D*】是這個人長期累積的細節庫（大綱放不下的都在這裡，不會因為沒進大綱就消失）：不用硬塞；但某個細節佐證多、最近還在出現、比現有條目更能代表這個人時，可以拿它新增條目、補強或取代既有條目
- 「證據不足」的觀察也可以寫，程式會自動標成「或許」——**不要自己在 text 裡寫「或許」「有時」**
- 欄位裝不下時，留下佐證最多、最近還在出現的；「舊版摘要轉入，無個別佐證」的舊條目最先讓位給有佐證的新觀察

## 規則
- 每條 text 是一個短句，不超過 ${ITEM_TEXT_MAX_LEN} 字、只講一件事；不要把一串話題塞進同一條
- 每條都必須在 from 列出至少一個來源編號；沒有出處的條目會被程式丟掉
- 用中性、行為式描述（說了什麼、常聊什麼、怎麼互動）；**禁止**吹捧詞（靈魂人物、觀察精準、擅長、高情商）和貶低性判詞（強詞奪理、耍賴）
- 西寶的反應不是這個人的特徵：「西寶慌張」「被西寶吐槽」這類只描述西寶的內容不要寫
- 暱稱只是 Discord 顯示名稱（可能含玩笑裝飾）：不要寫成「自稱」，也不要從暱稱推斷人格或身份
- 合併重複或相似的條目，保留最具體的描述
- **不寫**：敏感推測（政治傾向、健康、性取向、宗教、真實身份）、單次情緒、「某天說過什麼」流水帳

## 輸出格式
嚴格回傳 JSON，不要加任何其他文字。回傳**完整的新檔案**（要保留的舊條目也要列出）：
{"items":[{"field":"topics","text":"越南、泰國旅遊","from":["I2","O1"]},{"field":"style","text":"常夾日文口語","from":["I1"]}]}

如果沒什麼可更新的，回（會保留原檔案）：
{"items":[]}`;

function shouldConsolidate(guildId, userId) {
  const entry = getUserProfile(guildId, userId);
  const obs = freshObservations(entry?.observations);
  if (obs.length === 0) return false;

  if (obs.length >= CONSOLIDATE_MIN_COUNT) return true;

  const totalChars = obs.reduce((sum, o) => sum + (o.text?.length ?? 0), 0);
  if (totalChars >= CONSOLIDATE_MAX_TOTAL_CHARS) return true;

  if (obs.length >= CONSOLIDATE_MIN_COUNT_TIME) {
    const last = entry.profileAt ?? 0;
    if (Date.now() - last >= CONSOLIDATE_TIME_THRESHOLD_MS) return true;
  }

  return false;
}

function describeObservationEvidence(obs) {
  const evidence = Array.isArray(obs?.evidence) ? obs.evidence : [];
  const ids = new Set(evidence.map((e) => e?.messageId).filter(Boolean));
  if (ids.size === 0) return "無訊息佐證";
  return `${ids.size} 則訊息佐證`;
}

function formatDay(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "?";
  return new Date(ms).toISOString().slice(0, 10);
}

// Pre-items profiles were one string, field-per-line, clauses joined with
// 「；」. Each clause becomes one source item (no per-item evidence — it
// predates that), which the model then rewrites into short items citing it.
// lastSeenAt = when that string was written, so migrated impressions still age
// out unless a new observation re-confirms them. Clauses the old profile
// already hedged (或許/可能/有時…) stay tentative, so a migration can't
// promote a guess into an assertion.
const LEGACY_HEDGE_RE = /^(或許|也許|可能|有時候?|偶爾)[，,、\s]*/;

function legacySourceItems(entry) {
  const lines = (entry?.profile || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const at = typeof entry?.profileAt === "number" ? entry.profileAt : Date.now();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([^:：]{1,8})[:：]\s*(.+)$/);
    const field = (m && fieldByKeyOrLabel(m[1])) || PROFILE_FIELDS[PROFILE_FIELDS.length - 1];
    const clauses = (m ? m[2] : line).split(/[；;]/).map((c) => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      const hedged = LEGACY_HEDGE_RE.test(clause);
      out.push({
        field: field.key,
        text: hedged ? clause.replace(LEGACY_HEDGE_RE, "") : clause,
        evidence: [],
        firstAt: at,
        lastSeenAt: at,
        tentative: hedged,
        legacy: true,
      });
    }
  }
  return out;
}

// The outline is distilled from the detail pool too: the best-supported
// details not already on the table as a new observation. Capped so a big pool
// can't balloon the consolidation prompt.
const DETAIL_CONSOLIDATION_OFFER = 12;

function detailCandidates(entry, now = Date.now()) {
  const obsTexts = (entry?.observations || []).map((o) => o.text);
  const fresh = detailsOf(entry, now).filter((d) =>
    !obsTexts.some((t) => t === d.text || tokenSimilarity(t, d.text) >= 0.6));
  return capByPriority(fresh, DETAIL_CONSOLIDATION_OFFER);
}

// Numbered sources the consolidation model may cite: live items as I1…, new
// observations as O1…. Stale items are left out entirely — not showing them is
// how they get dropped.
function collectConsolidationSources(entry, now = Date.now()) {
  const items = [];
  if (entry?.items) {
    for (const f of PROFILE_FIELDS) {
      for (const it of entry.items[f.key] || []) {
        if (!it?.text || isItemStale(it, now)) continue;
        items.push({ ...it, field: f.key });
      }
    }
  } else if (entry?.profile) {
    items.push(...legacySourceItems(entry));
  }
  const byId = new Map();
  items.forEach((it, i) => byId.set(`I${i + 1}`, { kind: "item", ...it }));
  (entry?.observations || []).forEach((o, i) => {
    byId.set(`O${i + 1}`, { kind: "obs", ...o, stable: isStableObservation(o) });
  });
  detailCandidates(entry, now).forEach((d, i) => {
    byId.set(`D${i + 1}`, { kind: "detail", ...d, stable: isStableEvidence(d.evidence) });
  });
  return byId;
}

function buildConsolidationTurns(entry, now = Date.now()) {
  const sources = collectConsolidationSources(entry, now);
  const parts = [];
  const labelOf = (key) => fieldByKeyOrLabel(key)?.label || key;

  const itemLines = [];
  const stableLines = [];
  const weakLines = [];
  const detailLines = [];
  for (const [id, src] of sources) {
    if (src.kind === "detail") {
      detailLines.push(`[${id}] ${src.text}（${describeObservationEvidence(src)}，最後出現 ${formatDay(src.lastSeenAt)}）`);
    } else if (src.kind === "item") {
      const support = src.legacy
        ? `舊版摘要轉入，無個別佐證${src.tentative ? "；原本就只是推測" : ""}`
        : `${new Set((src.evidence || []).map((e) => e?.messageId).filter(Boolean)).size} 則佐證，最後確認 ${formatDay(src.lastSeenAt)}`;
      itemLines.push(`[${id}] ${labelOf(src.field)}｜${src.text}（${support}）`);
    } else {
      const line = `[${id}] ${src.text}（信心 ${src.confidence}，${describeObservationEvidence(src)}）`;
      (src.stable ? stableLines : weakLines).push(line);
    }
  }

  if (itemLines.length > 0) {
    parts.push(`## 既有條目（舊印象——與新觀察矛盾時以新觀察為準）\n${itemLines.join("\n")}`);
  }
  parts.push(`## 暱稱（Discord 顯示名稱，可能含玩笑裝飾，僅供稱呼）\n${entry.name || "未知"}`);
  if (stableLines.length > 0) {
    parts.push(`## 新觀察：已達證據門檻\n${stableLines.join("\n")}`);
  }
  if (weakLines.length > 0) {
    parts.push(`## 新觀察：證據不足（寫進檔案會被標成「或許」）\n${weakLines.join("\n")}`);
  }
  if (detailLines.length > 0) {
    parts.push(`## 細節庫 D*（長期累積，挑真正有代表性的進大綱）\n${detailLines.join("\n")}`);
  }
  return [
    {
      role: "user",
      content: `請根據以下資料，輸出更新後的條列式人格檔案：\n\n${parts.join("\n\n")}`,
    },
  ];
}

function parseConsolidationResult(text) {
  if (!text) return null;
  const cleaned = text.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed?.items)) return null;
    const items = parsed.items
      .filter((it) => it && typeof it.text === "string" && it.text.trim())
      .map((it) => ({
        field: typeof it.field === "string" ? it.field : "",
        text: it.text.trim(),
        from: Array.isArray(it.from) ? it.from.map((v) => String(v).trim().toUpperCase()) : [],
      }));
    return items.length > 0 ? items : null;
  } catch {
    console.warn(`[consolidate] failed to parse LLM output len=${text.length} tail=${JSON.stringify(text.slice(-60))}`);
    return null;
  }
}

function latestEvidenceAt(evidence) {
  const ats = (evidence || []).map((e) => e?.at).filter((v) => typeof v === "number");
  return ats.length > 0 ? Math.max(...ats) : null;
}

function earliestEvidenceAt(evidence) {
  const ats = (evidence || []).map((e) => e?.at).filter((v) => typeof v === "number");
  return ats.length > 0 ? Math.min(...ats) : null;
}

// Code-enforced provenance: an item survives only if it cites at least one
// real source. Its evidence is the union of what it cites; lastSeenAt only
// moves forward when a NEW observation backs it (carrying an old item forward
// verbatim does not re-confirm it — that's what lets impressions decay); and
// it is hedged as 或許 unless the pooled evidence clears the stability bar or
// it inherits from a source that already had. `schema` swaps in the guild
// profile's fields / stability bar; the provenance rules are the same.
const USER_ITEM_SCHEMA = {
  fields: PROFILE_FIELDS,
  fieldOf: fieldByKeyOrLabel,
  isStable: isStableEvidence,
  sanitize: sanitizeItems,
};

// Resolves the model's answer into items AND reports which offered
// observations made it into a surviving item (`cited`, by text) — the rest
// are carried to the next consolidation instead of silently discarded.
function selectConsolidatedItems(parsed, sources, now = Date.now(), schema = USER_ITEM_SCHEMA) {
  const offered = [...sources.values()].filter((s) => s.kind === "obs").map((s) => s.text);
  if (!Array.isArray(parsed)) return { items: null, offered, cited: [] };
  const out = {};
  for (const f of schema.fields) out[f.key] = [];

  for (const it of parsed) {
    const field = schema.fieldOf(it.field);
    if (!field) continue;
    const cited = [...new Set(it.from)].map((id) => sources.get(id)).filter(Boolean);
    if (cited.length === 0) continue;

    const evidence = mergeEvidenceNewest(...cited.map((c) => c.evidence || []));
    const obsCited = cited.filter((c) => c.kind === "obs");
    // Observations and details both carry real message evidence, so either
    // can re-confirm an item; re-citing an old item cannot.
    const evCited = cited.filter((c) => c.kind !== "item");
    const itemCited = cited.filter((c) => c.kind === "item");

    let lastSeenAt;
    if (evCited.length > 0) {
      lastSeenAt = Math.max(
        ...evCited.map((o) => latestEvidenceAt(o.evidence) ?? o.lastSeenAt ?? (typeof o.at === "number" ? o.at : now)),
      );
    } else {
      lastSeenAt = Math.max(...itemCited.map((c) => c.lastSeenAt ?? 0));
    }
    const firstCandidates = [
      ...itemCited.map((c) => c.firstAt),
      ...evCited.map((o) => earliestEvidenceAt(o.evidence) ?? o.firstAt ?? o.at),
    ].filter((v) => typeof v === "number");
    const firstAt = firstCandidates.length > 0 ? Math.min(...firstCandidates) : now;

    const sourceTentative = (c) => (c.kind === "item" ? Boolean(c.tentative) : !c.stable);
    const tentative = !schema.isStable(evidence) && cited.every(sourceTentative);

    out[field.key].push({
      text: it.text, evidence, firstAt, lastSeenAt, tentative,
      obsTexts: obsCited.map((o) => o.text),
    });
  }

  // Cap here (same rule sanitize applies) so we know which items — and so
  // which observations — actually survive.
  const cited = new Set();
  for (const f of schema.fields) {
    out[f.key] = capByPriority(out[f.key], f.max, schema.isStable);
    for (const it of out[f.key]) for (const t of it.obsTexts) cited.add(t);
  }

  const clean = schema.sanitize(out);
  const total = schema.fields.reduce((n, f) => n + clean[f.key].length, 0);
  return { items: total > 0 ? clean : null, offered, cited: [...cited] };
}

function resolveConsolidatedItems(parsed, sources, now = Date.now(), schema = USER_ITEM_SCHEMA) {
  return selectConsolidatedItems(parsed, sources, now, schema).items;
}

function describeConsumed(consumed) {
  if (!consumed) return "";
  return ` cited=${consumed.cited.length}/${consumed.offered.length} obs`;
}

// Single consolidation pass: build → call → resolve. Returns the items map (or
// null) plus `consumed` = { offered, cited } observation texts for
// setProfileItems. Shared with scripts/redistill-profiles.js.
async function runConsolidation(entry, runChain, extraTurns = []) {
  const now = Date.now();
  const sources = collectConsolidationSources(entry, now);
  const turns = [...buildConsolidationTurns(entry, now), ...extraTurns];
  let result = null;
  for (let attempt = 1; attempt <= CONSOLIDATE_ATTEMPTS; attempt++) {
    result = await runChain(turns, CONSOLIDATION_PERSONA, CONSOLIDATE_MAX_TOKENS);
    if (!result) return { result: null, items: null, consumed: null };
    const parsed = parseConsolidationResult(result.text);
    if (parsed) {
      const { items, offered, cited } = selectConsolidatedItems(parsed, sources, now);
      return { result, items, consumed: { offered, cited } };
    }
  }
  return { result, items: null, consumed: null };
}

function countItems(items) {
  return items ? PROFILE_FIELDS.reduce((n, f) => n + (items[f.key]?.length ?? 0), 0) : 0;
}

async function maybeConsolidateProfile(guildId, userId, runChain) {
  if (!guildId || !userId || !runChain) return;
  if (!shouldConsolidate(guildId, userId)) return;

  const key = `${guildId}:${userId}`;
  if (consolidateInFlight.has(key)) return;
  consolidateInFlight.add(key);

  try {
    const entry = getUserProfile(guildId, userId);
    if (!entry || (entry.observations?.length ?? 0) === 0) return;

    const { result, items, consumed } = await runConsolidation(entry, runChain);
    if (!result) {
      console.warn("[consolidate] chain exhausted, skipping consolidation");
      return;
    }

    console.log(
      `[consolidate] user=${userId} provider=${result.provider.label} items=${countItems(items)} from=${entry.observations.length} obs${describeConsumed(consumed)}`,
    );

    if (items) {
      setProfileItems(guildId, userId, items, consumed);
    }
  } catch (err) {
    console.warn(`[consolidate] error: ${err.message}`);
  } finally {
    consolidateInFlight.delete(key);
  }
}

// --- Guild memory ---

const GUILD_EXTRACT_MIN_COUNT = 5;
const GUILD_EXTRACT_MIN_COUNT_TIME = 3;
const GUILD_EXTRACT_TIME_THRESHOLD_MS = 60 * 60 * 1000;
const GUILD_CONSOLIDATE_MIN_COUNT = 12;
const GUILD_CONSOLIDATE_MIN_COUNT_TIME = 5;
const GUILD_CONSOLIDATE_TIME_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const guildExtractInFlight = new Set();
const guildConsolidateInFlight = new Set();

const GUILD_EXTRACT_MAX_OBSERVATIONS = 3;

const GUILD_EXTRACTION_PERSONA = `你是一個觀察力很強的助手。你的工作是從 Discord 群組的聊天紀錄中提取**群組整體的穩定特徵**，並為每一條標註依據。

## 資料格式
聊天紀錄逐行編號（L1、L2…），格式是「[暱稱]: 內容」；[連結預覽] 是群友貼的外部連結內容。

## 規則
- 只記錄群組整體的廣泛、非私人特徵：常聊話題、互動風格、常見梗/用語
- **不記錄**：個人私事、敏感推測（政治傾向、健康、性取向、宗教）、單次情緒、吵架
- **不記錄「某人怎樣」**——這是群組記憶，不是個人記憶；不要出現任何人的暱稱或綽號，梗也不能是「拿某人開玩笑」
- **不記錄群友怎麼用西寶／機器人**（叫她講故事、要貼圖、出題、問功能、用連結預覽）——那是 bot 的使用紀錄，不是群的氣氛
- 同一件事要在**不同行**出現才算特徵；只出現一次的不要寫
- 不確定就回空 observations
- 每條 observation 不超過 30 字，只講一件事
- evidence 必填：支持該條觀察的行號數字（例如 [3,17]）；找不到依據的條目不要輸出
- confidence 0~1，只有多次出現的特徵才給高 confidence

## 輸出格式
嚴格回傳 JSON，不要加任何其他文字：
{"observations":[{"text":"觀察內容","confidence":0.7,"evidence":[3,17]}]}

最多 ${GUILD_EXTRACT_MAX_OBSERVATIONS} 條。沒有值得記的就回：
{"observations":[]}`;

const GUILD_FIELD_LIST_TEXT = GUILD_FIELDS.map((f) => `${f.key}（${f.label}，最多 ${f.max} 條）`).join("、");

const GUILD_CONSOLIDATION_PERSONA = `你是一個擅長整理資料的助手。你的工作是維護一份「條列式」的群組印象：固定欄位、每欄幾條短條目，每條都要標出處。

## 欄位
${GUILD_FIELD_LIST_TEXT}
- topics：群裡反覆在聊的話題、遊戲、作品（一條一個話題，直接寫名稱，不要加「常聊」）
- style：大家怎麼互動（吐槽、接龍、貼圖大戰…）、整體氣氛
- memes：群內反覆出現的梗、口頭禪、用語

## 條目來源與權重
- 【既有條目 I*】是舊印象：沒被新觀察推翻就原樣保留（text 照抄、from 填它自己的編號）
- 新觀察和既有條目矛盾時，**以新觀察為準**
- 【新觀察 O*】可以新增條目，也可以補強既有條目（from 同時填 I 和 O）
- 「證據不足」的觀察也可以寫，程式會自動標成「或許」——**不要自己在 text 裡寫「或許」「有時」**

## 規則
- 每條 text 是一個短句，不超過 ${GUILD_ITEM_TEXT_MAX_LEN} 字、只講一件事；**不要把一串話題塞進同一條**
- 每條都必須在 from 列出至少一個來源編號；沒有出處的條目會被程式丟掉
- 欄位裝不下時，留下佐證最多、最近還在出現的
- **不寫**：任何人的暱稱或綽號、「某人怎樣」、群友怎麼使用西寶／機器人（要貼圖、叫她出題、用連結預覽）、敏感推測、單次事件

## 輸出格式
嚴格回傳 JSON，不要加任何其他文字。回傳**完整的新檔案**（要保留的舊條目也要列出）：
{"items":[{"field":"topics","text":"英雄聯盟賽事","from":["I2","O1"]},{"field":"memes","text":"愛用「貴爛」感嘆","from":["O3"]}]}

如果沒什麼可更新的，回（會保留原檔案）：
{"items":[]}`;

const GUILD_ITEM_SCHEMA = {
  fields: GUILD_FIELDS,
  fieldOf: guildFieldOf,
  isStable: isGuildStableEvidence,
  sanitize: sanitizeGuildItems,
};

// Code-side backstop for the two things the prose summary kept smuggling in:
// notes about how people use the bot, and a named person. The prompts ask
// for neither; this drops whatever gets through anyway.
const GUILD_BOT_META_RE = /西寶|機器人|\bbots?\b|vx\w+|fx\w+|連結預覽/i;
const SPEAKER_NAME_MIN_LEN = 2;

function isGuildTextAllowed(text, speakerNames = []) {
  if (!text || GUILD_BOT_META_RE.test(text)) return false;
  return !speakerNames.some((n) => n.length >= SPEAKER_NAME_MIN_LEN && text.includes(n));
}

function shouldGuildExtract(guildId) {
  const entry = getGuildProfile(guildId);
  const pending = entry?.pendingContexts ?? [];
  if (pending.length === 0) return false;

  if (pending.length >= GUILD_EXTRACT_MIN_COUNT) return true;

  if (pending.length >= GUILD_EXTRACT_MIN_COUNT_TIME) {
    const last = entry.lastExtractedAt ?? 0;
    if (Date.now() - last >= GUILD_EXTRACT_TIME_THRESHOLD_MS) return true;
  }

  return false;
}

// Flattens pending snapshots into one numbered line list. Snapshots stored
// before lines carried messageIds only have `text`; those lines are shown but
// can't back an observation (no messageId → no evidence).
function flattenGuildPending(pendingContexts) {
  const out = [];
  const seen = new Set();
  for (const snap of pendingContexts || []) {
    const lines = Array.isArray(snap.lines)
      ? snap.lines
      : String(snap.text || "").split("\n").filter(Boolean).map((text) => ({ text }));
    for (const l of lines) {
      if (l.messageId) {
        if (seen.has(l.messageId)) continue;
        seen.add(l.messageId);
      }
      out.push({ ...l, at: typeof l.at === "number" ? l.at : (snap.at ?? null) });
    }
  }
  return out;
}

function buildGuildExtractionTurns(lines) {
  const numbered = lines.map((l, i) => `L${i + 1} ${l.text}`);
  return [
    {
      role: "user",
      content: `以下是 Discord 群組最近的聊天紀錄（逐行編號），請從中提取群組整體的穩定特徵，並在 evidence 附上依據的行號：\n\n${numbered.join("\n")}`,
    },
  ];
}

function attachGuildEvidence(observations, lines) {
  const speakers = [...new Set(lines.map((l) => l.speaker).filter(Boolean))];
  const out = [];
  for (const o of observations) {
    if (!isGuildTextAllowed(o.text, speakers)) continue;
    const evidence = [];
    const seen = new Set();
    for (const idx of o.evidence || []) {
      const l = lines[idx - 1];
      if (!l?.messageId || seen.has(l.messageId)) continue;
      seen.add(l.messageId);
      evidence.push({ messageId: l.messageId, at: l.at ?? null, source: "passive" });
    }
    let confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0.5;
    if (evidence.length === 0) confidence = Math.min(confidence, EVIDENCE_CAP_NO_MESSAGE);
    else if (evidence.length === 1) confidence = Math.min(confidence, EVIDENCE_CAP_SINGLE_MESSAGE);
    out.push({ ...o, confidence, evidence });
  }
  return out;
}

function shouldGuildConsolidate(guildId) {
  const entry = getGuildProfile(guildId);
  const obs = freshObservations(entry?.observations);
  if (obs.length === 0) return false;

  if (obs.length >= GUILD_CONSOLIDATE_MIN_COUNT) return true;

  const totalChars = obs.reduce((sum, o) => sum + (o.text?.length ?? 0), 0);
  if (totalChars >= 1200) return true;

  if (obs.length >= GUILD_CONSOLIDATE_MIN_COUNT_TIME) {
    const last = entry.profileAt ?? 0;
    if (Date.now() - last >= GUILD_CONSOLIDATE_TIME_THRESHOLD_MS) return true;
  }

  return false;
}

// The prose summary predates items: each sentence becomes one tentative
// source (no evidence), aged from when the prose was written — so the old
// summary survives only as far as new observations re-confirm it.
function legacyGuildSourceItems(entry) {
  const at = typeof entry?.profileAt === "number" ? entry.profileAt : Date.now();
  return String(entry?.profile || "")
    .split(/[。；;\n]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((text) => ({
      field: "style",
      text,
      evidence: [],
      firstAt: at,
      lastSeenAt: at,
      tentative: true,
      legacy: true,
    }));
}

function collectGuildConsolidationSources(entry, now = Date.now()) {
  const items = [];
  if (entry?.items) {
    for (const f of GUILD_FIELDS) {
      for (const it of entry.items[f.key] || []) {
        if (!it?.text || isGuildItemStale(it, now)) continue;
        items.push({ ...it, field: f.key });
      }
    }
  } else if (entry?.profile) {
    items.push(...legacyGuildSourceItems(entry));
  }
  const byId = new Map();
  items.forEach((it, i) => byId.set(`I${i + 1}`, { kind: "item", ...it }));
  (entry?.observations || []).forEach((o, i) => {
    byId.set(`O${i + 1}`, { kind: "obs", ...o, stable: isGuildStableEvidence(o.evidence) });
  });
  return byId;
}

function buildGuildConsolidationTurns(entry, now = Date.now()) {
  const sources = collectGuildConsolidationSources(entry, now);
  const itemLines = [];
  const stableLines = [];
  const weakLines = [];
  for (const [id, src] of sources) {
    if (src.kind === "item") {
      const support = src.legacy
        ? "舊版摘要轉入，無個別佐證"
        : `${new Set((src.evidence || []).map((e) => e?.messageId).filter(Boolean)).size} 則佐證，最後確認 ${formatDay(src.lastSeenAt)}`;
      itemLines.push(`[${id}] ${src.legacy ? "舊摘要" : guildFieldOf(src.field)?.label}｜${src.text}（${support}）`);
    } else {
      const line = `[${id}] ${src.text}（信心 ${src.confidence}，${describeObservationEvidence(src)}）`;
      (src.stable ? stableLines : weakLines).push(line);
    }
  }
  const parts = [];
  if (itemLines.length > 0) {
    parts.push(`## 既有條目（舊印象——與新觀察矛盾時以新觀察為準）\n${itemLines.join("\n")}`);
  }
  if (stableLines.length > 0) parts.push(`## 新觀察：已在不同時段出現\n${stableLines.join("\n")}`);
  if (weakLines.length > 0) parts.push(`## 新觀察：證據不足（寫進檔案會被標成「或許」）\n${weakLines.join("\n")}`);
  return [
    {
      role: "user",
      content: `請根據以下資料，輸出更新後的條列式群組印象：\n\n${parts.join("\n\n")}`,
    },
  ];
}

// Members 西寶 already knows here — display names plus confirmed aliases —
// so an item naming a person is caught even when it came from old prose,
// where there are no speaker labels to check against.
function knownMemberNames(guildId) {
  if (!guildId) return [];
  const names = new Set();
  for (const p of listUserProfiles(guildId)) {
    if (p.name) names.add(p.name);
    for (const a of confirmedAliases(p, Date.now(), Infinity)) names.add(a);
  }
  return [...names];
}

function dropDisallowedGuildItems(items, memberNames = []) {
  if (!items) return null;
  let total = 0;
  for (const f of GUILD_FIELDS) {
    items[f.key] = (items[f.key] || []).filter((it) => isGuildTextAllowed(it.text, memberNames));
    total += items[f.key].length;
  }
  return total > 0 ? items : null;
}

// Shared with scripts/redistill-guild-profiles.js.
async function runGuildConsolidation(entry, runChain, extraTurns = [], guildId = null) {
  const now = Date.now();
  const sources = collectGuildConsolidationSources(entry, now);
  const turns = [...buildGuildConsolidationTurns(entry, now), ...extraTurns];
  let result = null;
  for (let attempt = 1; attempt <= CONSOLIDATE_ATTEMPTS; attempt++) {
    result = await runChain(turns, GUILD_CONSOLIDATION_PERSONA, CONSOLIDATE_MAX_TOKENS);
    if (!result) return { result: null, items: null, consumed: null };
    const parsed = parseConsolidationResult(result.text);
    if (parsed) {
      // Observations cited only by a disallowed item still count as cited:
      // re-offering them would just re-produce the same disallowed item.
      const { items, offered, cited } = selectConsolidatedItems(parsed, sources, now, GUILD_ITEM_SCHEMA);
      return {
        result,
        items: dropDisallowedGuildItems(items, knownMemberNames(guildId)),
        consumed: { offered, cited },
      };
    }
  }
  return { result, items: null, consumed: null };
}

function countGuildItems(items) {
  return items ? GUILD_FIELDS.reduce((n, f) => n + (items[f.key]?.length ?? 0), 0) : 0;
}

async function maybeGuildExtract(guildId, guildName, runChain) {
  if (!guildId || !runChain) return;
  if (!shouldGuildExtract(guildId)) return;

  if (guildExtractInFlight.has(guildId)) return;
  guildExtractInFlight.add(guildId);

  try {
    const pending = getPendingContexts(guildId);
    if (pending.length === 0) return;

    const lines = flattenGuildPending(pending);
    const turns = buildGuildExtractionTurns(lines);
    const result = await runChain(turns, GUILD_EXTRACTION_PERSONA, EXTRACT_MAX_TOKENS);

    if (!result) {
      console.warn("[guild-extract] chain exhausted, skipping");
      return;
    }

    const parsed = parseExtractionResult(result.text).slice(0, GUILD_EXTRACT_MAX_OBSERVATIONS);
    const observations = attachGuildEvidence(parsed, lines);
    console.log(
      `[guild-extract] guild=${guildId} provider=${result.provider.label} extracted=${observations.length} dropped=${parsed.length - observations.length} from=${lines.length} lines evidence=${observations.map((o) => o.evidence.length).join(",") || "-"}`,
    );

    if (observations.length > 0) {
      appendGuildObservations(guildId, guildName, observations);
    }
    clearPendingContexts(guildId);

    maybeGuildConsolidate(guildId, runChain).catch(() => {});
  } catch (err) {
    console.warn(`[guild-extract] error: ${err.message}`);
  } finally {
    guildExtractInFlight.delete(guildId);
  }
}

async function maybeGuildConsolidate(guildId, runChain) {
  if (!guildId || !runChain) return;
  if (!shouldGuildConsolidate(guildId)) return;

  if (guildConsolidateInFlight.has(guildId)) return;
  guildConsolidateInFlight.add(guildId);

  try {
    const entry = getGuildProfile(guildId);
    if (!entry || (entry.observations?.length ?? 0) === 0) return;

    const { result, items, consumed } = await runGuildConsolidation(entry, runChain, [], guildId);
    if (!result) {
      console.warn("[guild-consolidate] chain exhausted, skipping");
      return;
    }

    console.log(
      `[guild-consolidate] guild=${guildId} provider=${result.provider.label} items=${countGuildItems(items)} from=${entry.observations.length} obs${describeConsumed(consumed)}`,
    );

    if (items) {
      setGuildProfileItems(guildId, items, consumed);
    }
  } catch (err) {
    console.warn(`[guild-consolidate] error: ${err.message}`);
  } finally {
    guildConsolidateInFlight.delete(guildId);
  }
}

// --- Backlog sweep ---
// Extraction normally piggybacks on the user's OWN next successful AI reply.
// Passively-scooped users (active in channel, rarely @ the bot) never hit
// that trigger, so their pending backlog only ever grows. The sweep drains
// it on a timer instead: a few users per pass, oldest-starved first, and
// only when their backlog has been quiet for a while (not mid-conversation).

const BACKLOG_SWEEP_MAX_USERS = 3;
const BACKLOG_SWEEP_MIN_IDLE_MS = 10 * 60 * 1000;

function selectBacklogUsers(backlog, options = {}) {
  const {
    now = Date.now(),
    maxUsers = BACKLOG_SWEEP_MAX_USERS,
    minIdleMs = BACKLOG_SWEEP_MIN_IDLE_MS,
  } = options;
  return backlog
    .filter((b) => now - (b.lastPendingAt || 0) >= minIdleMs)
    .sort((a, b) => (a.lastExtractedAt || 0) - (b.lastExtractedAt || 0))
    .slice(0, maxUsers);
}

async function sweepPendingBacklog(buildRunChain, options = {}) {
  if (typeof buildRunChain !== "function") return 0;
  const backlog = listPendingBacklog(EXTRACT_MIN_COUNT);
  const picked = selectBacklogUsers(backlog, options);
  let processed = 0;
  for (const item of picked) {
    try {
      const runChain = buildRunChain(item.guildId);
      if (!runChain) continue;
      await maybeExtractObservations(item.guildId, item.userId, item.name, runChain);
      processed++;
    } catch (err) {
      console.warn(
        `[backlog-sweep] guild=${item.guildId} user=${item.userId} error: ${err.message}`,
      );
    }
  }
  if (backlog.length > 0) {
    console.log(
      `[backlog-sweep] backlog=${backlog.length} eligible=${picked.length} processed=${processed}`,
    );
  }
  return processed;
}

function resetForTests() {
  extractInFlight.clear();
  consolidateInFlight.clear();
  guildExtractInFlight.clear();
  guildConsolidateInFlight.clear();
}

module.exports = {
  EXTRACT_MIN_COUNT,
  EXTRACT_MIN_COUNT_TIME,
  EXTRACT_MAX_TOTAL_CHARS,
  EXTRACT_TIME_THRESHOLD_MS,
  EXTRACTION_PERSONA,
  CONSOLIDATE_MIN_COUNT,
  CONSOLIDATE_MIN_COUNT_TIME,
  CONSOLIDATE_MAX_TOTAL_CHARS,
  CONSOLIDATE_TIME_THRESHOLD_MS,
  CONSOLIDATE_MAX_TOKENS,
  CONSOLIDATION_PERSONA,
  collectConsolidationSources,
  resolveConsolidatedItems,
  selectConsolidatedItems,
  runConsolidation,
  countItems,
  STABLE_MIN_DISTINCT_MESSAGES,
  STABLE_TIME_GAP_MS,
  BACKLOG_SWEEP_MAX_USERS,
  BACKLOG_SWEEP_MIN_IDLE_MS,
  shouldExtract,
  buildExtractionTurns,
  parseExtractionResult,
  parseEvidenceIndices,
  attachEvidence,
  isStableObservation,
  describeObservationEvidence,
  selectBacklogUsers,
  sweepPendingBacklog,
  maybeExtractObservations,
  shouldConsolidate,
  buildConsolidationTurns,
  parseConsolidationResult,
  maybeConsolidateProfile,
  GUILD_EXTRACT_MIN_COUNT,
  GUILD_EXTRACT_MIN_COUNT_TIME,
  GUILD_CONSOLIDATE_MIN_COUNT,
  GUILD_CONSOLIDATE_MIN_COUNT_TIME,
  GUILD_EXTRACTION_PERSONA,
  GUILD_CONSOLIDATION_PERSONA,
  shouldGuildExtract,
  flattenGuildPending,
  buildGuildExtractionTurns,
  attachGuildEvidence,
  isGuildTextAllowed,
  shouldGuildConsolidate,
  collectGuildConsolidationSources,
  buildGuildConsolidationTurns,
  runGuildConsolidation,
  countGuildItems,
  maybeGuildExtract,
  maybeGuildConsolidate,
  resetForTests,
};

const {
  getUserProfile,
  getPendingInteractions,
  clearPending,
  appendObservations,
  setConsolidatedProfile,
  PROFILE_MAX_LEN,
} = require("../user-profile-store");
const {
  getGuildProfile,
  getPendingContexts,
  clearPendingContexts,
  appendObservations: appendGuildObservations,
  setConsolidatedProfile: setGuildConsolidatedProfile,
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
const CONSOLIDATE_MAX_TOKENS = 500;

const extractInFlight = new Set();
const consolidateInFlight = new Set();

const EXTRACTION_PERSONA = `你是一個觀察力很強的助手。你的工作是從對話紀錄中提取使用者的**穩定人格特徵**。

## 規則
- 只記錄**穩定偏好、性格傾向、說話語氣、常聊話題、興趣、互動偏好**（例如：常用特定口頭禪、對某話題持續有興趣、說話語氣特徵）
- 可根據使用者直接 @ 西寶的內容，以及非常近的群組脈絡判斷；不要用太遠的群聊片段替個人下結論
- **不記錄**：單次情緒、暫時狀態、敏感推測（政治傾向、健康、性取向、宗教、真實身份）
- 不確定就回空 observations
- 每條 observation 不超過 30 字
- confidence 0~1，只有多次出現的特徵才給高 confidence

## 輸出格式
嚴格回傳 JSON，不要加任何其他文字：
{"observations":[{"text":"觀察內容","confidence":0.7}]}

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

function buildExtractionTurns(pending) {
  const lines = pending.map(
    (p) => `使用者：${p.userText || "（空）"}\n西寶：${p.assistantText || "（空）"}`,
  );
  return [
    {
      role: "user",
      content: `以下是最近的對話紀錄，請從中提取使用者的穩定人格特徵：\n\n${lines.join("\n\n")}`,
    },
  ];
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
      }));
  } catch {
    console.warn("[observation-extractor] failed to parse LLM output");
    return [];
  }
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

    const observations = parseExtractionResult(result.text);
    console.log(
      `[observation-extractor] user=${userId} provider=${result.provider.label} extracted=${observations.length} from=${pending.length} pending`,
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

const CONSOLIDATION_PERSONA = `你是一個擅長整理人格資料的助手。你的工作是把零散的觀察合併成一段簡潔的人格摘要。

## 規則
- 合併重複或相似的觀察，保留最有代表性的描述
- 只保留穩定、可用於日常互動的資訊（說話風格、興趣、互動偏好）
- **不寫**：敏感推測（政治傾向、健康、性取向、宗教、真實身份）、單次情緒、「某天說過什麼」流水帳
- 如果觀察不足以形成有意義的摘要，就保留舊 profile 原文
- 摘要用繁體中文，自然口語，不要條列式

## 輸出格式
嚴格回傳 JSON，不要加任何其他文字：
{"profile":"整合後的人格摘要，最多 300 字"}

如果觀察不足、沒什麼可更新的，回：
{"profile":""}`;

function shouldConsolidate(guildId, userId) {
  const entry = getUserProfile(guildId, userId);
  const obs = entry?.observations ?? [];
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

function buildConsolidationTurns(entry) {
  const parts = [];
  if (entry.profile) {
    parts.push(`## 既有人格摘要\n${entry.profile}`);
  }
  parts.push(`## 暱稱\n${entry.name || "未知"}`);
  const obsLines = (entry.observations || [])
    .map((o) => `- ${o.text}（信心 ${o.confidence}）`)
    .join("\n");
  parts.push(`## 新觀察\n${obsLines}`);
  return [
    {
      role: "user",
      content: `請根據以下資料，整合成一段簡潔的人格摘要：\n\n${parts.join("\n\n")}`,
    },
  ];
}

function parseConsolidationResult(text) {
  if (!text) return null;
  const cleaned = text.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed?.profile !== "string") return null;
    const trimmed = parsed.profile.trim();
    return trimmed || null;
  } catch {
    console.warn("[consolidate] failed to parse LLM output");
    return null;
  }
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

    const turns = buildConsolidationTurns(entry);
    const result = await runChain(
      turns,
      CONSOLIDATION_PERSONA,
      CONSOLIDATE_MAX_TOKENS,
    );

    if (!result) {
      console.warn("[consolidate] chain exhausted, skipping consolidation");
      return;
    }

    const profile = parseConsolidationResult(result.text);
    console.log(
      `[consolidate] user=${userId} provider=${result.provider.label} profile=${profile ? profile.length : 0}chars from=${entry.observations.length} obs`,
    );

    if (profile) {
      setConsolidatedProfile(guildId, userId, profile);
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

const GUILD_EXTRACTION_PERSONA = `你是一個觀察力很強的助手。你的工作是從 Discord 群組的聊天紀錄中提取**群組整體的穩定特徵**。

## 規則
- 只記錄群組整體的廣泛、非私人特徵：常聊話題、互動風格、常見梗/用語、群內氣氛
- **不記錄**：個人私事、敏感推測（政治傾向、健康、性取向、宗教）、單次情緒、吵架
- **不記錄「某人怎樣」**——這是群組記憶，不是個人記憶；如果片段提到個人，只能抽象成群組話題或用語
- 不確定就回空 observations
- 每條 observation 不超過 30 字
- confidence 0~1，只有多次出現的特徵才給高 confidence

## 輸出格式
嚴格回傳 JSON，不要加任何其他文字：
{"observations":[{"text":"觀察內容","confidence":0.7}]}

最多 3 條。沒有值得記的就回：
{"observations":[]}`;

const GUILD_CONSOLIDATION_PERSONA = `你是一個擅長整理資料的助手。你的工作是把零散的群組觀察合併成一段簡潔的群組氛圍摘要。

## 規則
- 合併重複或相似的觀察
- 只保留穩定、能描述群組氣氛的資訊（常聊話題、互動風格、群內梗）
- **不寫**：個人私事、敏感推測、單次事件
- 如果觀察不足，保留舊 profile 原文
- 摘要用繁體中文，自然口語，不要條列式

## 輸出格式
嚴格回傳 JSON，不要加任何其他文字：
{"profile":"整合後的群組氛圍摘要，最多 300 字"}

沒什麼可更新的就回：
{"profile":""}`;

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

function buildGuildExtractionTurns(pendingContexts) {
  const blocks = pendingContexts.map((p, i) => `--- 片段 ${i + 1} ---\n${p.text}`);
  return [
    {
      role: "user",
      content: `以下是 Discord 群組最近幾次的聊天紀錄片段，請從中提取群組整體的穩定特徵：\n\n${blocks.join("\n\n")}`,
    },
  ];
}

function shouldGuildConsolidate(guildId) {
  const entry = getGuildProfile(guildId);
  const obs = entry?.observations ?? [];
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

function buildGuildConsolidationTurns(entry) {
  const parts = [];
  if (entry.profile) {
    parts.push(`## 既有群組摘要\n${entry.profile}`);
  }
  const obsLines = (entry.observations || [])
    .map((o) => `- ${o.text}（信心 ${o.confidence}）`)
    .join("\n");
  parts.push(`## 新觀察\n${obsLines}`);
  return [
    {
      role: "user",
      content: `請根據以下資料，整合成一段簡潔的群組氛圍摘要：\n\n${parts.join("\n\n")}`,
    },
  ];
}

async function maybeGuildExtract(guildId, guildName, runChain) {
  if (!guildId || !runChain) return;
  if (!shouldGuildExtract(guildId)) return;

  if (guildExtractInFlight.has(guildId)) return;
  guildExtractInFlight.add(guildId);

  try {
    const pending = getPendingContexts(guildId);
    if (pending.length === 0) return;

    const turns = buildGuildExtractionTurns(pending);
    const result = await runChain(turns, GUILD_EXTRACTION_PERSONA, EXTRACT_MAX_TOKENS);

    if (!result) {
      console.warn("[guild-extract] chain exhausted, skipping");
      return;
    }

    const observations = parseExtractionResult(result.text);
    console.log(
      `[guild-extract] guild=${guildId} provider=${result.provider.label} extracted=${observations.length} from=${pending.length} snapshots`,
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

    const turns = buildGuildConsolidationTurns(entry);
    const result = await runChain(turns, GUILD_CONSOLIDATION_PERSONA, CONSOLIDATE_MAX_TOKENS);

    if (!result) {
      console.warn("[guild-consolidate] chain exhausted, skipping");
      return;
    }

    const profile = parseConsolidationResult(result.text);
    console.log(
      `[guild-consolidate] guild=${guildId} provider=${result.provider.label} profile=${profile ? profile.length : 0}chars from=${entry.observations.length} obs`,
    );

    if (profile) {
      setGuildConsolidatedProfile(guildId, profile);
    }
  } catch (err) {
    console.warn(`[guild-consolidate] error: ${err.message}`);
  } finally {
    guildConsolidateInFlight.delete(guildId);
  }
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
  CONSOLIDATION_PERSONA,
  shouldExtract,
  buildExtractionTurns,
  parseExtractionResult,
  maybeExtractObservations,
  shouldConsolidate,
  buildConsolidationTurns,
  parseConsolidationResult,
  maybeConsolidateProfile,
  GUILD_EXTRACT_MIN_COUNT,
  GUILD_EXTRACT_MIN_COUNT_TIME,
  GUILD_CONSOLIDATE_MIN_COUNT,
  GUILD_CONSOLIDATE_MIN_COUNT_TIME,
  shouldGuildExtract,
  buildGuildExtractionTurns,
  shouldGuildConsolidate,
  buildGuildConsolidationTurns,
  maybeGuildExtract,
  maybeGuildConsolidate,
  resetForTests,
};

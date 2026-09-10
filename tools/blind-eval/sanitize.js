'use strict';

const { createHash } = require('node:crypto');
const { SCHEMA_VERSION, assertPublicCase } = require('./schemas');

const MAX_CASES = 20;
const MAX_QUESTION_CHARS = 1000;
const SNOWFLAKE = /\b\d{17,20}\b/g;
const RESIDUAL_LONG_NUMBER = /\b\d{9,20}\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const OPAQUE_HEX_ID = /\b[0-9a-f]{24,64}\b/gi;
const MENTION = /<@!?\d+>|<@&\d+>|<#\d+>/g;
const DISCORD_TIMESTAMP = /<t:\d+(?::[tTdDfFR])?>/g;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)(?:\+?\d[\d .()\-]{7,}\d)(?!\d)/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const INVITE = /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/gi;
const COMMAND = /^\s*[!/.][A-Za-z0-9_-]+(?:\s|$)/;
const SECRET_PATTERNS = [
  // AWS access keys (long-lived/temporary), STS bearer/context credentials,
  // and the legacy access-key form are fixed-format, high-confidence matches.
  /\b(?:(?:ABIA|ACCA|AKIA|ASIA)[A-Z0-9]{16}|A3T[A-Z0-9]{17})\b/,
  /\b(?:AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /["']?(?:api[_ -]?key|access[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|password|passwd|pwd|secret(?:[_ -]?key)?)["']?\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[A-Za-z0-9_./+@:=~-]{8,})/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/i,
  /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/,
];
const SENSITIVE_PATTERNS = [
  /(?:身分證|身份證|護照|信用卡|銀行帳號|病歷|診斷|住址)/i,
  /\b(?:credit card|passport|social security|medical record|bank account)\b/i,
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeDisplayNames(names) {
  return [...new Set((names || []).filter((name) => typeof name === 'string' && name.trim().length >= 2))]
    .sort((a, b) => b.length - a.length);
}

function sanitizeQuestion(raw, options = {}) {
  if (typeof raw !== 'string') return { accepted: false, reason: 'not-string' };
  const trimmed = raw.trim();
  if (!trimmed) return { accepted: false, reason: 'empty' };
  if (trimmed.length > MAX_QUESTION_CHARS) return { accepted: false, reason: 'too-long' };
  if (COMMAND.test(trimmed)) return { accepted: false, reason: 'command' };
  if (SECRET_PATTERNS.some((pattern) => pattern.test(trimmed))) return { accepted: false, reason: 'sensitive-secret' };
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) return { accepted: false, reason: 'sensitive-content' };

  const urlChars = [...trimmed.matchAll(new RegExp(`${URL.source}|${INVITE.source}`, 'gi'))]
    .reduce((sum, match) => sum + match[0].length, 0);
  if (urlChars / trimmed.length > 0.45) return { accepted: false, reason: 'url-dominant' };

  let clean = trimmed
    .replace(INVITE, '〔邀請連結已移除〕')
    .replace(URL, '〔網址已移除〕')
    .replace(EMAIL, '〔電子郵件已移除〕')
    .replace(PHONE, '〔電話已移除〕')
    .replace(DISCORD_TIMESTAMP, '〔時間已移除〕')
    .replace(ISO_TIMESTAMP, '〔時間已移除〕');

  const aliases = new Map();
  const pseudonymSalt = String(options.pseudonymSalt || 'standalone-sanitizer');
  const aliasFor = (value) => {
    if (!aliases.has(value)) aliases.set(value, `〔人物-${sha256(`${pseudonymSalt}\0${value}`).slice(0, 6)}〕`);
    return aliases.get(value);
  };
  clean = clean.replace(MENTION, (value) => aliasFor(value));
  for (const name of normalizeDisplayNames(options.displayNames)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp(escaped, 'giu'), () => aliasFor(`name:${name}`));
  }
  clean = clean
    .replace(UUID, '〔識別碼已移除〕')
    .replace(OPAQUE_HEX_ID, '〔識別碼已移除〕')
    .replace(SNOWFLAKE, '〔識別碼已移除〕')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean || clean.replace(/〔[^〕]+〕/g, '').trim().length < 4) return { accepted: false, reason: 'not-substantive' };
  if (hasResidualIdentifier(clean, options.displayNames)) return { accepted: false, reason: 'residual-identifier' };
  return { accepted: true, question: clean };
}

function hasResidualIdentifier(value, displayNames = []) {
  const contains = (pattern) => new RegExp(pattern.source, pattern.flags.replaceAll('g', '')).test(value);
  if (contains(MENTION) || contains(DISCORD_TIMESTAMP) || contains(EMAIL) || contains(URL) || contains(INVITE) || contains(UUID) || contains(OPAQUE_HEX_ID)) return true;
  if (RESIDUAL_LONG_NUMBER.test(value) || SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  const lower = value.toLocaleLowerCase('zh-Hant');
  return normalizeDisplayNames(displayNames).some((name) => lower.includes(name.toLocaleLowerCase('zh-Hant')));
}

function extractCases(messages, options) {
  if (!Array.isArray(messages)) throw new TypeError('fixture messages must be an array');
  if (!options || typeof options.guildId !== 'string' || !/^\d{17,20}$/.test(options.guildId)) {
    throw new Error('an exact Discord guild snowflake is required');
  }
  if (typeof options.caseSalt !== 'string' || options.caseSalt.length < 16) throw new Error('an explicit case salt of at least 16 characters is required');
  const salt = options.caseSalt;
  const sorted = [...messages].sort((a, b) => Number(new Date(b.createdAt || 0)) - Number(new Date(a.createdAt || 0)));
  const seen = new Set();
  const publicCases = [];
  const privateMapping = [];
  const rejected = [];

  for (const message of sorted) {
    if (publicCases.length >= MAX_CASES) break;
    if (!message || String(message.guildId) !== options.guildId || message.role !== 'user') continue;
    const result = sanitizeQuestion(message.content, {
      displayNames: message.displayNames || options.displayNames,
      pseudonymSalt: `${salt}\0${String(message.id || '')}`,
    });
    if (!result.accepted) {
      rejected.push({ sourceHash: sha256(`${salt}\0${String(message.id || '')}`), reason: result.reason });
      continue;
    }
    const duplicateKey = sha256(result.question.normalize('NFKC').toLocaleLowerCase('zh-Hant'));
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    const caseId = sha256(`${salt}\0${duplicateKey}`).slice(0, 16);
    const publicCase = { schemaVersion: SCHEMA_VERSION, caseId, question: result.question };
    assertPublicCase(publicCase);
    publicCases.push(publicCase);
    privateMapping.push({
      schemaVersion: SCHEMA_VERSION,
      caseId,
      sourceHash: sha256(`${salt}\0${String(message.id || '')}`),
    });
  }
  return { schemaVersion: SCHEMA_VERSION, publicCases, privateMapping, rejected };
}

module.exports = {
  MAX_CASES, MAX_QUESTION_CHARS, extractCases, hasResidualIdentifier, sanitizeQuestion, sha256,
};

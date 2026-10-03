const { isDeepSeekPeak } = require('./peak-hours');
const meter = require('./rate-limiter');
const { AI_FREE_DAILY_LIMIT, AI_OWNER_DAILY_LIMIT, DEEPSEEK_PREMIUM_GUILD_IDS } = require('../config');

const KEY_NAMES = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', gateway: 'AI_GATEWAY_API_KEY', gemini: 'GEMINI_API_KEY' };
function hasKey(route, env) { return Boolean(env[KEY_NAMES[route.provider]]); }

function selectTranslationRoute({ exhausted = false, now = new Date(), env = process.env } = {}) {
  // A guild's exhausted allowance always selects the cheaper model; neither
  // the clock nor a manually selected premium provider may bypass that rule.
  if (exhausted) return { provider: 'gateway', model: 'alibaba/qwen3.7-flash', tier: 'overflow' };
  const provider = env.TRANSLATION_PROVIDER || 'auto';
  if (provider !== 'auto') return { provider, model: env.TRANSLATION_MODEL || ({ deepseek: 'deepseek-flash', openai: 'gpt-6-luna', gateway: 'alibaba/qwen3.7-flash', gemini: 'gemini-3.1-flash-lite' }[provider]), tier: 'standard' };
  const holiday = (env.TRANSLATION_DEEPSEEK_OFFPEAK_DATES || '').split(',').includes(new Date(now).toISOString().slice(0, 10));
  const offPeak = holiday || !isDeepSeekPeak(new Date(now));
  // Only enable the timed DeepSeek route after its translation quality passes.
  // Current same-corpus testing does not establish an advantage over Luna.
  if (env.TRANSLATION_DEEPSEEK_OFFPEAK_ENABLED === 'true' && offPeak && env.DEEPSEEK_API_KEY) return { provider: 'deepseek', model: 'deepseek-flash', tier: 'standard' };
  return { provider: 'openai', model: 'gpt-6-luna', tier: 'standard' };
}

function translationAvailable(env = process.env) {
  if (env.X_TRANSLATION_ENABLED !== 'true') return false;
  return hasKey(selectTranslationRoute({ env }), env);
}

function reserveTranslation(guildId, deps = {}) {
  if (!guildId) throw new Error('Guild required');
  const env = deps.env || process.env;
  const now = deps.now ?? Date.now();
  const usage = deps.meter || meter;
  const guildLimit = deps.guildLimit ?? AI_FREE_DAILY_LIMIT;
  const ownerLimit = deps.ownerLimit ?? AI_OWNER_DAILY_LIMIT;
  const whitelist = deps.whitelist || DEEPSEEK_PREMIUM_GUILD_IDS;
  if (ownerLimit > 0 && usage.getUsage(meter.OWNER_TOTAL_KEY, now).count >= ownerLimit) throw new Error('Translation owner limit');
  const exempt = whitelist.includes(guildId);
  let exhausted = !exempt && guildLimit > 0 && usage.getUsage(guildId, now).count >= guildLimit;
  let route = selectTranslationRoute({ exhausted, now, env });
  if (!hasKey(route, env)) throw new Error('Translation provider unavailable');
  // One synchronous reservation before I/O: concurrent clicks at the limit
  // cannot both consume the last standard slot. Failed calls also consume it,
  // matching the existing chat meter, since an API attempt may incur cost.
  if (!exempt && !exhausted && !usage.checkAndIncrement(guildId, guildLimit, now).allowed) {
    exhausted = true;
    route = selectTranslationRoute({ exhausted, now, env });
    if (!hasKey(route, env)) throw new Error('Translation provider unavailable');
  }
  if (!usage.checkAndIncrementOwnerTotal(ownerLimit, now).allowed) throw new Error('Translation owner limit');
  return route;
}

module.exports = { selectTranslationRoute, translationAvailable, reserveTranslation };

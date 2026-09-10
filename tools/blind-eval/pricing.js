'use strict';

const PRICING_VERSION = 'xibe-pricing-2026-09-10-v2';

// USD per one million tokens. These values are intentionally pinned metadata,
// never silently refreshed. A future live phase must re-approve any changes.
const PRICING = Object.freeze({
  version: PRICING_VERSION,
  effectiveDate: '2026-09-10',
  currency: 'USD',
  units: 'per-1m-tokens',
  providers: Object.freeze({
    openai: Object.freeze({ uncachedInput: 0.25, cachedInput: 0.025, cacheWrite: 0, output: 2.0, reasoning: 2.0 }),
    // deepseek-flash (V4.1 Flash), PEAK rates from
    // https://api-docs.deepseek.com/quick_start/pricing (2026-09-10):
    // uncached input 0.30, cached input 0.006, output 1.20 per 1M.
    // Peak — not off-peak — on purpose: the runner reserves the projected cost
    // before each call, so the guard must never under-estimate. An off-peak run
    // simply comes in under budget. DeepSeek bills no separate cache write, so
    // cacheWrite mirrors uncached input rather than claiming a free field.
    deepseek: Object.freeze({ uncachedInput: 0.3, cachedInput: 0.006, cacheWrite: 0.3, output: 1.2, reasoning: 1.2 }),
  }),
});

const USAGE_FIELDS = ['uncachedInputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'];

function normalizeUsage(usage) {
  const normalized = {};
  for (const key of USAGE_FIELDS) {
    const value = usage?.[key] ?? 0;
    if (!Number.isInteger(value) || value < 0) throw new Error(`malformed usage field: ${key}`);
    normalized[key] = value;
  }
  return normalized;
}

function calculateCost(provider, usage, pricing = PRICING) {
  const rates = pricing.providers[provider];
  if (!rates) throw new Error(`no pinned pricing for ${provider}`);
  const u = normalizeUsage(usage);
  const components = {
    uncachedInput: u.uncachedInputTokens * rates.uncachedInput / 1_000_000,
    cachedInput: u.cachedInputTokens * rates.cachedInput / 1_000_000,
    cacheWrite: u.cacheWriteTokens * rates.cacheWrite / 1_000_000,
    output: u.outputTokens * rates.output / 1_000_000,
    reasoning: u.reasoningTokens * rates.reasoning / 1_000_000,
  };
  return { pricingVersion: pricing.version, components, totalUsd: Object.values(components).reduce((a, b) => a + b, 0) };
}

module.exports = { PRICING, PRICING_VERSION, USAGE_FIELDS, calculateCost, normalizeUsage };

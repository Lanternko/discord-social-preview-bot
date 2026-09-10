'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PRICING_VERSION, calculateCost } = require('../pricing');
const { aggregate, evaluateVote, scorePersona } = require('../aggregate');

const scores = { voice: 5, consistency: 4, naturalTraditionalChinese: 4, directness: 4, emotionalFit: 3, hardConstraints: 5, standaloneUnderstanding: 4 };

test('pinned pricing formula separates all five token components reproducibly', () => {
  const result = calculateCost('deepseek', { uncachedInputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 1_000_000 });
  assert.equal(result.pricingVersion, PRICING_VERSION);
  assert.deepEqual(result.components, { uncachedInput: 0.3, cachedInput: 0.006, cacheWrite: 0.3, output: 1.2, reasoning: 1.2 });
  // Tolerance, not equality: the flash rates sum through binary floats that
  // land on 3.0060000000000002.
  assert.ok(Math.abs(result.totalUsd - 3.006) < 1e-9, `unexpected total ${result.totalUsd}`);
  assert.throws(() => calculateCost('openai', { uncachedInputTokens: -1 }), /malformed usage/);
});

test('persona weights and pass gate are exact', () => {
  assert.equal(scorePersona(scores), 4.25);
  assert.deepEqual(evaluateVote({ scores, hardViolation: false }), { persona: 4.25, understanding: 4, passed: true });
  assert.equal(evaluateVote({ scores, hardViolation: true }).passed, false);
});

test('incomplete pairs are excluded from quality while all attempt costs count', () => {
  const result = aggregate([
    { caseId: 'one', completed: true, vote: { scores, hardViolation: false } },
    { caseId: 'two', completed: false },
  ], [{ cost: { totalUsd: 0.1 } }, { cost: { totalUsd: 0.2 } }]);
  assert.equal(result.completedPairs, 1);
  assert.equal(result.excludedIncompletePairs, 1);
  assert.equal(result.passRate, 1);
  assert.ok(Math.abs(result.totalCostUsd - 0.3) < Number.EPSILON * 4);
});

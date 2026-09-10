'use strict';

const PERSONA_WEIGHTS = Object.freeze({
  voice: 30,
  consistency: 20,
  naturalTraditionalChinese: 20,
  directness: 15,
  emotionalFit: 10,
  hardConstraints: 5,
});

function scorePersona(scores) {
  let total = 0;
  for (const [key, weight] of Object.entries(PERSONA_WEIGHTS)) {
    const value = scores?.[key];
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`invalid 1-5 score: ${key}`);
    total += value * weight;
  }
  return total / 100;
}

function evaluateVote(vote) {
  const persona = scorePersona(vote.scores);
  const understanding = vote.scores.standaloneUnderstanding;
  if (!Number.isInteger(understanding) || understanding < 1 || understanding > 5) throw new Error('invalid standalone understanding score');
  return {
    persona,
    understanding,
    passed: persona >= 4 && understanding >= 4 && vote.hardViolation !== true,
  };
}

function aggregate(completedPairs, attempts = []) {
  const completed = (completedPairs || []).filter((pair) => pair && pair.completed === true);
  const quality = completed.map((pair) => ({ caseId: pair.caseId, ...evaluateVote(pair.vote) }));
  const totalCostUsd = (attempts || []).reduce((sum, attempt) => sum + Number(attempt?.cost?.totalUsd || 0), 0);
  return {
    completedPairs: quality.length,
    excludedIncompletePairs: (completedPairs || []).length - quality.length,
    personaMean: quality.length ? quality.reduce((sum, row) => sum + row.persona, 0) / quality.length : null,
    understandingMean: quality.length ? quality.reduce((sum, row) => sum + row.understanding, 0) / quality.length : null,
    passRate: quality.length ? quality.filter((row) => row.passed).length / quality.length : null,
    totalCostUsd,
  };
}

module.exports = { PERSONA_WEIGHTS, aggregate, evaluateVote, scorePersona };

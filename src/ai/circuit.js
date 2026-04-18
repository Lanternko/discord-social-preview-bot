const providerCircuitState = new Map();

function getCooldownMs(failure) {
  switch (failure.kind) {
    case "queue_exceeded":
      return 30_000;
    case "rate_limit":
      return failure.retryAfterMs ?? 60_000;
    case "timeout":
    case "network":
    case "server":
      return 60_000;
    case "auth":
      return 10 * 60_000;
    case "empty":
      return 0;
    default:
      return 30_000;
  }
}

function isProviderAvailable(label, now = Date.now()) {
  const state = providerCircuitState.get(label);
  if (!state) return true;
  return now >= state.cooldownUntil;
}

function recordProviderSuccess(label) {
  providerCircuitState.delete(label);
}

function recordProviderFailure(label, failure, now = Date.now()) {
  const cooldownMs = getCooldownMs(failure);
  if (cooldownMs <= 0) {
    return cooldownMs;
  }
  const prev = providerCircuitState.get(label);
  providerCircuitState.set(label, {
    cooldownUntil: now + cooldownMs,
    lastFailureKind: failure.kind,
    lastFailureAt: now,
    failCount: (prev?.failCount ?? 0) + 1,
  });
  return cooldownMs;
}

function getCircuitSnapshot(now = Date.now()) {
  return Array.from(providerCircuitState.entries()).map(([label, state]) => ({
    label,
    available: now >= state.cooldownUntil,
    cooldownRemainingMs: Math.max(0, state.cooldownUntil - now),
    lastFailureKind: state.lastFailureKind,
    failCount: state.failCount,
  }));
}

function resetCircuitState() {
  providerCircuitState.clear();
}

module.exports = {
  providerCircuitState,
  getCooldownMs,
  isProviderAvailable,
  recordProviderSuccess,
  recordProviderFailure,
  getCircuitSnapshot,
  resetCircuitState,
};

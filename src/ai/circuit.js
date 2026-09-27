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

// One timeout is not an outage. Chat providers time out because a single
// request overthought (flash can spend 4000+ reasoning tokens on a story at
// ~190 tok/s), not because the endpoint is down — yet a 60 s cooldown on the
// owner's flash label benched it for EVERY guild and shipped the next minute of
// replies to the fallback. So the first timeout is only a strike; a second one
// in a row (no success in between, within TIMEOUT_STRIKE_WINDOW_MS) cools down.
const TIMEOUT_STRIKE_WINDOW_MS = 5 * 60_000;

function isTimeoutStrikeOnly(prev, failure, now) {
  if (failure.kind !== "timeout") return false;
  const lastWasTimeout = prev?.lastFailureKind === "timeout"
    && now - prev.lastFailureAt <= TIMEOUT_STRIKE_WINDOW_MS;
  return !lastWasTimeout;
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
  const strikeOnly = isTimeoutStrikeOnly(prev, failure, now);
  providerCircuitState.set(label, {
    cooldownUntil: strikeOnly ? now : now + cooldownMs,
    lastFailureKind: failure.kind,
    lastFailureAt: now,
    failCount: (prev?.failCount ?? 0) + 1,
  });
  return strikeOnly ? 0 : cooldownMs;
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
  TIMEOUT_STRIKE_WINDOW_MS,
  getCooldownMs,
  isProviderAvailable,
  recordProviderSuccess,
  recordProviderFailure,
  getCircuitSnapshot,
  resetCircuitState,
};

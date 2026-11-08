// Decision models on Vercel AI Gateway (OpenAI-compatible /decisions): ask
// typed questions about an input and get probabilities back, no generated
// text. Used as cheap yes/no gates in front of the background memory
// extractors (alias-extractor.js, observation-extractor.js): a Jev call is
// ~$0.00002, an extraction LLM call is 30x that.

const {
  AI_GATEWAY_API_KEY,
  DECISIONS_BASE_URL,
  DECISIONS_TIMEOUT_MS,
  MEMORY_GATE_MODE,
  MEMORY_GATE_MODEL,
  MEMORY_GATE_THRESHOLD,
  MEMORY_GATE_AUDIT_EVERY,
} = require("../config");

// questions: [{ type: "predicate", name, instructions }]. Returns
// { answers, costUsd, inputTokens } or null on any failure — callers treat a
// missing answer as "no signal", never as "no".
async function callDecision({ model, input, questions, timeoutMs = DECISIONS_TIMEOUT_MS }) {
  if (!AI_GATEWAY_API_KEY || !model) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DECISIONS_BASE_URL}/decisions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        questions,
        // Group chat of people who never opted in: don't let a provider keep it.
        providerOptions: { gateway: { zeroDataRetention: true } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(`[decision] model=${model} http=${response.status} ${detail.slice(0, 200)}`);
      return null;
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.answers)) return null;
    const cost = Number(payload?.provider_metadata?.gateway?.cost);
    return {
      answers: payload.answers,
      costUsd: Number.isFinite(cost) ? cost : null,
      inputTokens: payload?.usage?.input_tokens ?? null,
    };
  } catch (err) {
    console.warn(`[decision] model=${model} failed: ${err.name === "AbortError" ? "timeout" : err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Probability of the named predicate, or null when it was refused / missing.
function predicateProbability(result, name) {
  const answer = result?.answers?.find((a) => a?.name === name);
  return answer?.type === "predicate" && Number.isFinite(answer.probability)
    ? answer.probability
    : null;
}

const skipCounts = new Map(); // kind -> below-threshold verdicts so far

// One gate verdict for one batch. Fails open: no key, a dead endpoint, a
// refusal or a throw all give verdict "na" and the LLM runs as before.
// verdict: pass | skip | audit (below threshold, run anyway to sample what
// skips lose) | would_skip (shadow) | na. Returns null when the gate is off.
// opts overrides config (tests): { decide, mode, model, threshold, auditEvery }.
async function runGate(kind, question, input, opts = {}) {
  const mode = opts.mode ?? MEMORY_GATE_MODE;
  if (mode !== "enforce" && mode !== "shadow") return null;
  const decide = opts.decide || callDecision;
  const threshold = opts.threshold ?? MEMORY_GATE_THRESHOLD;
  const auditEvery = opts.auditEvery ?? MEMORY_GATE_AUDIT_EVERY;
  const started = Date.now();
  let result = null;
  try {
    result = await decide({ model: opts.model || MEMORY_GATE_MODEL, input, questions: [question] });
  } catch {
    result = null;
  }
  const probability = predicateProbability(result, question.name);
  const gate = { probability, costUsd: result?.costUsd ?? null, ms: Date.now() - started, verdict: "pass" };
  if (probability == null) {
    gate.verdict = "na";
  } else if (probability < threshold) {
    if (mode === "shadow") {
      gate.verdict = "would_skip";
    } else {
      const n = (skipCounts.get(kind) ?? 0) + 1;
      skipCounts.set(kind, n);
      gate.verdict = auditEvery > 0 && n % auditEvery === 0 ? "audit" : "skip";
    }
  }
  return gate;
}

function gateSkips(gate) {
  return gate?.verdict === "skip";
}

function formatGate(gate) {
  if (!gate) return "";
  const p = gate.probability == null ? "na" : gate.probability.toFixed(3);
  const cost = gate.costUsd == null ? "" : ` gate_cost=${gate.costUsd}`;
  return ` gate=${gate.verdict} gate_p=${p} gate_ms=${gate.ms}${cost}`;
}

function resetGateForTests() {
  skipCounts.clear();
}

module.exports = {
  callDecision,
  predicateProbability,
  runGate,
  gateSkips,
  formatGate,
  resetGateForTests,
};

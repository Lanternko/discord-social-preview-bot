'use strict';

const SCHEMA_VERSION = 'xibe-blind-eval/v1';

const SCHEMAS = Object.freeze({
  publicCase: Object.freeze({
    $id: `${SCHEMA_VERSION}/public-case`,
    required: ['schemaVersion', 'caseId', 'question'],
    additionalProperties: false,
  }),
  privateCase: Object.freeze({
    $id: `${SCHEMA_VERSION}/private-case`,
    required: ['schemaVersion', 'caseId', 'sourceHash'],
    additionalProperties: false,
  }),
  attempt: Object.freeze({
    $id: `${SCHEMA_VERSION}/attempt`,
    required: [
      'schemaVersion', 'caseId', 'provider', 'configId', 'personaHash',
      'questionHash', 'status', 'latencyMs', 'usage',
    ],
    additionalProperties: false,
  }),
  vote: Object.freeze({
    $id: `${SCHEMA_VERSION}/vote`,
    required: ['schemaVersion', 'caseId', 'preference', 'scores', 'attribution', 'fabrication'],
    additionalProperties: false,
  }),
});

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertPublicCase(value) {
  assertPlainObject(value, 'public case');
  const allowed = new Set(['schemaVersion', 'caseId', 'question']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected public case field: ${key}`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported schema version');
  if (!/^[a-f0-9]{16}$/.test(value.caseId)) throw new Error('invalid caseId');
  if (typeof value.question !== 'string' || !value.question.trim()) throw new Error('invalid question');
  return value;
}

module.exports = { SCHEMA_VERSION, SCHEMAS, assertPlainObject, assertPublicCase };

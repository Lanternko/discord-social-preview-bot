#!/usr/bin/env node
'use strict';

// Serves a completed run's blinded pairs on 127.0.0.1 so a human can vote.
// Reads the public cases/answers and the private mapping; the mapping never
// leaves the process until the voter locks a vote (the server reveals it then).
//
// Usage: node tools/blind-eval/serve.js --run <id>

const fs = require('node:fs');
const path = require('node:path');

const { createBlindServer } = require('./server');
const { RUN_BASE } = require('./cli');

function loadRun(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) throw new Error('unsafe run ID');
  const runDir = path.join(RUN_BASE, runId);
  const read = (...parts) => JSON.parse(fs.readFileSync(path.join(runDir, ...parts), 'utf8'));
  const questions = new Map(read('public', 'cases.json').map((item) => [item.caseId, item.question]));
  const mapping = new Map(read('private', 'mapping.json').map((item) => [item.caseId, { A: item.A, B: item.B }]));
  return read('public', 'answers.json').map((answer) => {
    const question = questions.get(answer.caseId);
    const pairMapping = mapping.get(answer.caseId);
    if (!question || !pairMapping) throw new Error(`run is missing the question or mapping for a case`);
    return { caseId: answer.caseId, question, answers: { A: answer.A, B: answer.B }, mapping: pairMapping };
  });
}

async function main(argv) {
  const runIndex = argv.indexOf('--run');
  if (runIndex < 0 || !argv[runIndex + 1]) throw new Error('--run <id> is required');
  const pairs = loadRun(argv[runIndex + 1]);
  const instance = createBlindServer({ pairs });
  const origin = await instance.listen();
  process.stdout.write(`${JSON.stringify({ mode: 'serve', pairs: pairs.length, origin })}\n`);
  return instance;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { loadRun, main };

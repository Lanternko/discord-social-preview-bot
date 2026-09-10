'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBlindServer, HOST } = require('../server');

const voteBody = {
  caseId: 'aaaaaaaaaaaaaaaa', preference: 'A', attribution: 'none', fabrication: 'none', hardViolation: false,
  scores: { voice: 5, consistency: 4, naturalTraditionalChinese: 4, directness: 4, emotionalFit: 4, hardConstraints: 5, standaloneUnderstanding: 4 },
};

test('server is loopback-only and resists pre-vote mapping/config/cost/token/latency/model discovery', async (t) => {
  const blind = createBlindServer({
    pairs: [{ caseId: 'aaaaaaaaaaaaaaaa', question: '今天要做什麼？', answers: { A: '先休息一下。', B: '列出三件小事。' }, mapping: { A: 'openai', B: 'deepseek' } }],
    attempts: [{ cost: { totalUsd: 0.01 } }],
  });
  t.after(() => blind.close());
  const location = await blind.listen();
  assert.equal(location.host, HOST);
  assert.equal(blind.server.address().address, '127.0.0.1');

  const homeResponse = await fetch(location.url);
  const cookie = homeResponse.headers.get('set-cookie');
  const html = await homeResponse.text();
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const token = /be_session=([^;]+)/.exec(cookie)[1];
  assert.doesNotMatch(html, new RegExp(token));
  assert.doesNotMatch(html, /openai|deepseek|gpt-5\.6|v4-pro|configId|latencyMs|totalCostUsd/i);
  assert.match(html, /外部供應商保留政策未知/);

  const js = await (await fetch(`${location.url}/app.js`)).text();
  assert.doesNotMatch(js, /innerHTML|openai|deepseek|gpt-5\.6|v4-pro|configId|latencyMs|totalCostUsd/i);
  assert.match(js, /textContent/);
  const casePayloadText = await (await fetch(`${location.url}/api/case`)).text();
  assert.doesNotMatch(casePayloadText, /openai|deepseek|gpt-5\.6|v4-pro|mapping|config|cost|token|latency|model/i);
  const casePayload = JSON.parse(casePayloadText);
  assert.deepEqual(Object.keys(casePayload.answers), ['A', 'B']);

  const headers = { 'content-type': 'application/json', cookie: cookie.split(';')[0] };
  let response = await fetch(`${location.url}/api/vote`, { method: 'POST', headers: { ...headers, origin: 'http://evil.test' }, body: JSON.stringify(voteBody) });
  assert.equal(response.status, 403);
  response = await fetch(`${location.url}/api/vote`, { method: 'POST', headers: { 'content-type': 'application/json', origin: location.url, cookie: 'be_session=wrong' }, body: JSON.stringify(voteBody) });
  assert.equal(response.status, 403);

  response = await fetch(`${location.url}/api/vote`, { method: 'POST', headers: { ...headers, origin: location.url }, body: JSON.stringify(voteBody) });
  assert.equal(response.status, 200);
  const reveal = await response.json();
  assert.deepEqual(reveal.mapping, { A: 'openai', B: 'deepseek' });
  assert.equal(reveal.aggregate.completedPairs, 1);
  assert.equal(reveal.aggregate.totalCostUsd, 0.01);

  response = await fetch(`${location.url}/api/vote`, { method: 'POST', headers: { ...headers, origin: location.url }, body: JSON.stringify(voteBody) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /already locked/);
  const exported = await (await fetch(`${location.url}/api/export`, { headers: { cookie: cookie.split(';')[0] } })).json();
  assert.deepEqual(exported.completed[0].mapping, { A: 'openai', B: 'deepseek' });
});

test('vote validation rejects unanchored or malformed values without reveal', async (t) => {
  const blind = createBlindServer({ pairs: [{ caseId: 'aaaaaaaaaaaaaaaa', question: 'q', answers: { A: 'a', B: 'b' }, mapping: { A: 'one', B: 'two' } }] });
  t.after(() => blind.close());
  const location = await blind.listen();
  const response = await fetch(location.url);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const bad = structuredClone(voteBody);
  bad.scores.voice = 6;
  const vote = await fetch(`${location.url}/api/vote`, { method: 'POST', headers: { 'content-type': 'application/json', origin: location.url, cookie }, body: JSON.stringify(bad) });
  assert.equal(vote.status, 400);
  assert.doesNotMatch(await vote.text(), /one|two/);
  const stillAvailable = await (await fetch(`${location.url}/api/case`)).json();
  assert.equal(stillAvailable.caseId, voteBody.caseId);
});

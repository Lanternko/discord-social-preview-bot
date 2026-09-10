'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { aggregate } = require('./aggregate');

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 32 * 1024;
const SCORE_KEYS = Object.freeze([
  'voice', 'consistency', 'naturalTraditionalChinese', 'directness',
  'emotionalFit', 'hardConstraints', 'standaloneUnderstanding',
]);
const KNOWN_MODEL_IDENTIFIER = /\b(?:openai|deepseek|gpt-5\.6-luna|deepseek-v4-pro)\b/i;

function html() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>喜寶盲測</title><style>body{font-family:system-ui;max-width:900px;margin:auto;padding:2rem}article{white-space:pre-wrap;border:1px solid #bbb;padding:1rem;margin:.5rem 0}label{display:block;margin:.4rem 0}button{margin:.4rem}.muted{color:#555}</style></head><body><h1>喜寶盲測</h1><p id="progress"></p><h2>問題</h2><article id="question"></article><h2>回答 A</h2><article id="answerA"></article><h2>回答 B</h2><article id="answerB"></article><form id="vote"><fieldset><legend>偏好</legend><label><input type="radio" name="preference" value="A" required>A</label><label><input type="radio" name="preference" value="B">B</label><label><input type="radio" name="preference" value="tie">平手</label></fieldset><div id="scores"></div><label>歸因判斷 <select name="attribution"><option value="none">無法判斷</option><option value="A">A</option><option value="B">B</option><option value="both">兩者</option></select></label><label>是否有捏造 <select name="fabrication"><option value="none">沒有</option><option value="A">A</option><option value="B">B</option><option value="both">兩者</option></select></label><label><input type="checkbox" name="hardViolation">違反硬限制</label><button type="submit">鎖定投票並揭曉</button></form><section id="reveal" hidden><h2>揭曉</h2><p id="mapping"></p><p id="aggregate"></p><button id="next" type="button">下一題</button><button id="export" type="button">匯出結果</button></section><p class="muted">清除只會移除本機資料；外部供應商保留政策未知，本工具無法代為清除。</p><script src="/app.js"></script></body></html>`;
}

function clientJs() {
  return `'use strict';const scoreNames={voice:'聲線貼合',consistency:'一致性',naturalTraditionalChinese:'自然繁體中文',directness:'直接度',emotionalFit:'情緒契合',hardConstraints:'硬限制遵循',standaloneUnderstanding:'獨立問題理解'};const anchors=['1－嚴重不符','2－明顯不符','3－普通','4－明顯符合','5－高度符合'];let current=null;const scores=document.getElementById('scores');const voteForm=document.getElementById('vote');for(const [key,label] of Object.entries(scoreNames)){const row=document.createElement('label');row.textContent=label+' ';const select=document.createElement('select');select.name=key;for(let n=1;n<=5;n++){const option=document.createElement('option');option.value=String(n);option.textContent=anchors[n-1];select.appendChild(option)}select.value='3';row.appendChild(select);scores.appendChild(row)}async function load(){const response=await fetch('/api/case');if(response.status===204){document.getElementById('progress').textContent='全部完成';voteForm.hidden=true;return}current=await response.json();document.getElementById('progress').textContent=current.progress;document.getElementById('question').textContent=current.question;document.getElementById('answerA').textContent=current.answers.A;document.getElementById('answerB').textContent=current.answers.B}voteForm.addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);const body={caseId:current.caseId,preference:form.get('preference'),attribution:form.get('attribution'),fabrication:form.get('fabrication'),hardViolation:form.get('hardViolation')==='on',scores:{}};for(const key of Object.keys(scoreNames))body.scores[key]=Number(form.get(key));const response=await fetch('/api/vote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const reveal=await response.json();if(!response.ok){alert(reveal.error);return}document.getElementById('mapping').textContent='A：'+reveal.mapping.A+'；B：'+reveal.mapping.B;document.getElementById('aggregate').textContent=JSON.stringify(reveal.aggregate);document.getElementById('reveal').hidden=false;event.currentTarget.querySelectorAll('input,select,button').forEach((node)=>node.disabled=true)});document.getElementById('next').addEventListener('click',async()=>{document.getElementById('reveal').hidden=true;voteForm.reset();voteForm.querySelectorAll('input,select,button').forEach((node)=>node.disabled=false);await load()});document.getElementById('export').addEventListener('click',async()=>{const response=await fetch('/api/export');const blob=await response.blob();const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='blind-eval-results.json';link.click();URL.revokeObjectURL(link.href)});load();`;
}

function json(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((pair) => pair.trim().split('=')).filter((parts) => parts.length === 2));
}

function secureEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function validateVote(body, expectedCaseId) {
  if (!body || body.caseId !== expectedCaseId) throw new Error('case mismatch');
  if (!['A', 'B', 'tie'].includes(body.preference)) throw new Error('invalid preference');
  if (!['none', 'A', 'B', 'both'].includes(body.attribution)) throw new Error('invalid attribution');
  if (!['none', 'A', 'B', 'both'].includes(body.fabrication)) throw new Error('invalid fabrication');
  if (typeof body.hardViolation !== 'boolean') throw new Error('invalid hard violation');
  const scores = {};
  for (const key of SCORE_KEYS) {
    if (!Number.isInteger(body.scores?.[key]) || body.scores[key] < 1 || body.scores[key] > 5) throw new Error(`invalid score: ${key}`);
    scores[key] = body.scores[key];
  }
  return { preference: body.preference, attribution: body.attribution, fabrication: body.fabrication, hardViolation: body.hardViolation, scores };
}

function validatePairs(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error('pairs must contain 1-20 completed pairs');
  const seen = new Set();
  return input.map((pair) => {
    if (!pair || !/^[a-f0-9]{16}$/.test(pair.caseId) || seen.has(pair.caseId)) throw new Error('invalid or duplicate blind case ID');
    seen.add(pair.caseId);
    if (typeof pair.question !== 'string' || !pair.question.trim() || typeof pair.answers?.A !== 'string' || !pair.answers.A.trim() || typeof pair.answers?.B !== 'string' || !pair.answers.B.trim()) throw new Error('blind question and answers must be non-empty strings');
    if (typeof pair.mapping?.A !== 'string' || typeof pair.mapping?.B !== 'string' || pair.mapping.A === pair.mapping.B) throw new Error('invalid private mapping');
    const forbidden = [pair.mapping.A, pair.mapping.B].filter((value) => value.length >= 2).map((value) => value.toLocaleLowerCase());
    for (const value of [pair.question, pair.answers.A, pair.answers.B]) {
      const lower = value.toLocaleLowerCase();
      if (KNOWN_MODEL_IDENTIFIER.test(value) || forbidden.some((identifier) => lower.includes(identifier))) throw new Error('model identifier would break blinding');
    }
    return { ...pair, answers: { A: pair.answers.A, B: pair.answers.B }, mapping: { A: pair.mapping.A, B: pair.mapping.B } };
  });
}

function createBlindServer(options) {
  const sessionToken = randomBytes(32).toString('base64url');
  const pairs = validatePairs(options?.pairs);
  const votes = new Map();
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method === 'GET' && req.url === '/') {
      const body = Buffer.from(html());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'set-cookie': `be_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/` });
      res.end(body); return;
    }
    if (req.method === 'GET' && req.url === '/app.js') {
      const body = Buffer.from(clientJs());
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' }); res.end(body); return;
    }
    if (req.method === 'GET' && req.url === '/api/case') {
      const pair = pairs.find((item) => !votes.has(item.caseId));
      if (!pair) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
      json(res, 200, { caseId: pair.caseId, progress: `${votes.size + 1}/${pairs.length}`, question: pair.question, answers: { A: pair.answers.A, B: pair.answers.B } }); return;
    }
    if (req.method === 'POST' && req.url === '/api/vote') {
      if (req.headers.origin !== origin) { json(res, 403, { error: 'origin rejected' }); return; }
      if (!secureEqual(parseCookies(req).be_session, sessionToken)) { json(res, 403, { error: 'session rejected' }); return; }
      if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') { json(res, 415, { error: 'JSON content type required' }); return; }
      try {
        const body = await readJson(req);
        const pair = pairs.find((item) => item.caseId === body.caseId);
        if (!pair || votes.has(body.caseId)) throw new Error('vote unavailable or already locked');
        const vote = validateVote(body, pair.caseId);
        votes.set(pair.caseId, vote);
        const completedPairs = pairs.filter((item) => votes.has(item.caseId)).map((item) => ({ caseId: item.caseId, completed: true, vote: votes.get(item.caseId) }));
        json(res, 200, { mapping: pair.mapping, aggregate: aggregate(completedPairs, options.attempts || []) });
      } catch (error) { json(res, 400, { error: error.message }); }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/export') {
      if (!secureEqual(parseCookies(req).be_session, sessionToken)) { json(res, 403, { error: 'session rejected' }); return; }
      const completed = pairs.filter((item) => votes.has(item.caseId)).map((item) => ({ caseId: item.caseId, vote: votes.get(item.caseId), mapping: item.mapping }));
      json(res, 200, { completed, aggregate: aggregate(completed.map((item) => ({ ...item, completed: true })), options.attempts || []) }, { 'content-disposition': 'attachment; filename="blind-eval-results.json"' }); return;
    }
    json(res, 404, { error: 'not found' });
  });
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
      const port = server.address().port;
      origin = `http://${HOST}:${port}`;
      return { host: HOST, port, url: origin };
    },
    async close() { if (server.listening) await new Promise((resolve) => server.close(resolve)); },
  };
}

module.exports = { HOST, MAX_BODY_BYTES, SCORE_KEYS, createBlindServer, validatePairs, validateVote };

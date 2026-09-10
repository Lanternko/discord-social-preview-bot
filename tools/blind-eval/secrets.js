'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function openSecureRegularFile(filePath, { expectedUid, requireMode = 0o600 } = {}) {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('secret path must be a regular file');
  if ((before.mode & 0o777) !== requireMode) throw new Error('secret file mode must be 0600');
  if (expectedUid !== undefined && before.uid !== expectedUid) throw new Error('secret file owner mismatch');
  const fd = fs.openSync(filePath, OPEN_FLAGS);
  const after = fs.fstatSync(fd);
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
    fs.closeSync(fd);
    throw new Error('secret file changed during open');
  }
  return fd;
}

function validateSecret(value, label) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} is not plausibly formatted`);
  }
  return value;
}

function readEphemeralKey(filePath, expectedUid = 1005) {
  const fd = openSecureRegularFile(filePath, { expectedUid });
  let buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < 12 || stat.size > 1024) throw new Error('OpenAI key file size is implausible');
    buffer = Buffer.alloc(stat.size);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return validateSecret(buffer.subarray(0, bytes).toString('utf8').trim(), 'OpenAI key');
  } finally {
    if (buffer) buffer.fill(0);
    fs.closeSync(fd);
  }
}

function parseExactEnvLine(line) {
  const match = /^DEEPSEEK_API_KEY\s*=\s*(.*)$/.exec(line);
  if (!match) return null;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return validateSecret(value, 'DeepSeek key');
}

async function readDeepSeekKey(envPath) {
  const fd = openSecureRegularFile(envPath);
  let found = null;
  try {
    const stream = fs.createReadStream(envPath, { fd, autoClose: false, encoding: 'utf8', highWaterMark: 1024 });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const value = parseExactEnvLine(line);
      if (value !== null) {
        if (found !== null) throw new Error('duplicate DEEPSEEK_API_KEY entries');
        found = value;
      }
    }
    if (found === null) throw new Error('DEEPSEEK_API_KEY is missing');
    return found;
  } finally {
    fs.closeSync(fd);
  }
}

function unlinkEphemeralKey(filePath) {
  try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

module.exports = { openSecureRegularFile, parseExactEnvLine, readDeepSeekKey, readEphemeralKey, unlinkEphemeralKey, validateSecret };

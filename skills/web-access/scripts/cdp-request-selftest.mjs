#!/usr/bin/env node
// Exercise the real PowerShell client against local fake responses. No Edge,
// real broker, browser authorization or user token is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('./cdp-request.ps1', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-request-selftest-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY8sAAAAASUVORK5CYII=', 'base64');
let fixture = { status: 200, type: 'image/png', bytes: png };
const server = http.createServer((request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${'x'.repeat(48)}`);
  response.writeHead(fixture.status, { 'Content-Type': fixture.type });
  response.end(fixture.bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
fs.writeFileSync(path.join(root, `${port}.token`), 'x'.repeat(48));

async function run(outFile, endpoint = '/screenshot') {
  const args = ['-NoProfile', '-NonInteractive', '-File', wrapper, '-Path', endpoint, '-Owner', 'request-selftest', '-Port', String(port)];
  if (outFile) args.push('-OutFile', outFile);
  const child = spawn('pwsh', args, { windowsHide: true, env: { ...process.env, CDP_PROXY_TOKEN_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(fs.readdirSync(root).filter(name => name.startsWith('.cdp-response-')).length, 0, 'temporary response leaked');
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

try {
  const destination = path.join(root, '截图.png');
  let result = await run(destination);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(destination), png);
  const errorJson = JSON.stringify({ ok: false, error: { code: 'cdp_timeout' } });
  fixture = { status: 504, type: 'application/json', bytes: errorJson };
  result = await run(destination);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'cdp_timeout');
  assert.deepEqual(fs.readFileSync(destination), png, 'HTTP error overwrote an existing screenshot');
  const missing = path.join(root, 'missing.png');
  assert.equal((await run(missing)).code, 1);
  assert.equal(fs.existsSync(missing), false, 'HTTP error created a fake screenshot');
  for (const type of ['application/json', 'image/png']) {
    fixture = { status: 200, type, bytes: errorJson };
    result = await run(destination);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'screenshot_invalid_response');
    assert.deepEqual(fs.readFileSync(destination), png, 'non-image body overwrote a screenshot');
  }
  fixture = { status: 200, type: 'application/json', bytes: '{"ok":true}' };
  result = await run(null, '/targets');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const jsonFile = path.join(root, 'targets.json');
  assert.equal((await run(jsonFile, '/targets')).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).ok, true);
  const multilingual = { ok: true, text: '中文正文、转发附言、Música、🚀', post_url: 'https://example.com/post/123' };
  fixture = { status: 200, type: 'application/json; charset=utf-8', bytes: JSON.stringify(multilingual) };
  result = await run(null, '/targets');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), multilingual, 'PowerShell stdout corrupted Unicode text');
  assert.equal(result.stdout.includes('\uFFFD'), false);
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]);
  fixture = { status: 200, type: 'image/jpeg', bytes: jpeg };
  assert.equal((await run(destination, '/screenshot?format=jpeg')).code, 0);
  assert.deepEqual(fs.readFileSync(destination), jpeg);
  console.log('cdp-request self-test passed: PNG/JPEG save, HTTP/JSON rejection, existing-file preservation, temporary cleanup, JSON compatibility, UTF-8 Chinese/accent/emoji pipe roundtrip');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

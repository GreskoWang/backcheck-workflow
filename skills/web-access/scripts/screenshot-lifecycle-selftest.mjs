import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./cdp-proxy.mjs', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
class BrokerError extends Error {
  constructor(code, message, details) { super(message); Object.assign(this, { code, details }); }
}
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}
function fixture() {
  const sent = [], quarantine = new Map();
  const context = {
    Date, Buffer, BrokerError, BUDGETS: { screenshot: 15000 }, quarantinedTargets: quarantine,
    ensureSession: async () => 'session',
    sendCdp: async (method, params) => { sent.push({ method, params }); return { data: Buffer.from('fixture').toString('base64') }; },
    quarantineTimedOutTarget: async (target, session, error) => quarantine.set(target, { code: error.code }),
    isOutcomeUnknownError: () => false, isSessionInvalidError: () => false,
  };
  const api = vm.runInNewContext(
    section('async function targetCommandUnlocked(', 'function validateOwner(') +
    section('let lastScreenshot = null;', 'async function handleHttpRequest(') +
    '\n({captureScreenshotUnlocked, targetCommandUnlocked, last:()=>lastScreenshot})', context);
  return { context, sent, quarantine, api };
}
for (const code of ['cdp_timeout', 'request_timeout', 'request_aborted']) {
  await test(`${code} preserves uncertain screenshot state without replay`, async () => {
    const f = fixture(); let calls = 0;
    f.context.sendCdp = async () => { calls++; throw new BrokerError(code, 'synthetic failure', { method: 'Page.captureScreenshot' }); };
    await assert.rejects(f.api.captureScreenshotUnlocked('page', 'jpeg', {}), e => e.code === code);
    assert.equal(calls, 1); assert.equal(f.quarantine.get('page').code, code);
    assert.equal(f.api.last().status, 'failed'); assert.equal(f.api.last().stage, 'edge_response');
    assert.equal(f.api.last().quarantined, true);
  });
}
for (const format of ['jpeg', 'png']) {
  await test(`${format} returns viewport bytes and content-free timing`, async () => {
    const f = fixture();
    assert.equal((await f.api.captureScreenshotUnlocked('page', format, {})).toString(), 'fixture');
    assert.equal(f.sent[0].method, 'Page.captureScreenshot');
    assert.equal(f.sent[0].params.captureBeyondViewport, false);
    assert.equal(f.sent[0].params.fromSurface, true);
    assert.equal(f.api.last().status, 'complete'); assert.equal(f.api.last().byteLength, 7);
    assert.ok(!('data' in f.api.last())); assert.ok(!('url' in f.api.last()));
  });
}
await test('empty image is a failed capture, never complete', async () => {
  const f = fixture(); f.context.sendCdp = async () => ({ data: '' });
  await assert.rejects(f.api.captureScreenshotUnlocked('page', 'jpeg', {}), e => e.code === 'screenshot_failed');
  assert.equal(f.api.last().status, 'failed');
});
await test('ordinary protocol rejection does not trigger a recovery or another screenshot', async () => {
  const f = fixture(); let calls = 0;
  f.context.sendCdp = async () => { calls++; throw new BrokerError('cdp_error', 'invalid parameter'); };
  await assert.rejects(f.api.captureScreenshotUnlocked('page', 'jpeg', {}), e => e.code === 'cdp_error');
  assert.equal(calls, 1); assert.equal(f.quarantine.size, 0);
});
console.log(JSON.stringify({ passed: results.filter(x => x.pass).length, total: results.length, results }, null, 2));
if (results.some(x => !x.pass)) process.exitCode = 1;

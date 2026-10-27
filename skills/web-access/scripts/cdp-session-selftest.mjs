#!/usr/bin/env node
// Real PowerShell holder + existing HTTP wrapper, against a loopback fake only.
// No Edge, live broker, browser credential or user page is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp-session.ps1');
let lastCase = null;
const ordinaryRequestBudgetMs = 10000; // Includes fresh PowerShell process startup.
// A deliberately stalled request must still leave normal process startup and
// cleanup enough time. The fixture withholds the response until this bound.
const deliberateTimeoutBudgetMs = ordinaryRequestBudgetMs;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-session-test-'));
const fakeBearer = 'b'.repeat(48), lease = 'synthetic-lease-' + 'l'.repeat(40), manage = 'synthetic-manage-' + 'm'.repeat(40);
let mode = 'normal', requests = [], newResults = new Map(), opened = 0, closed = 0;
const sockets = new Set();
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  const url = new URL(request.url, 'http://127.0.0.1');
  requests.push({ route: url.pathname, url: request.url, key: request.headers['x-cdp-request-id'], body });
  assert.equal(request.headers.authorization, `Bearer ${fakeBearer}`);
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/new') {
    if (mode === 'new-failed') return json({ error: { code: 'task_page_limit_reached', details: { requestId: request.headers['x-cdp-request-id'] } } }, 409);
    const key = request.headers['x-cdp-request-id'];
    if (!newResults.has(key)) { opened++; newResults.set(key, { ready: true, targetId: `fixture-target-${opened}`, leaseToken: lease, manageToken: manage }); }
    if (mode === 'new-lost-once' && requests.filter(x => x.route === '/new').length === 1) return request.socket.destroy();
    return json(newResults.get(key));
  }
  if (url.pathname === '/acquire') {
    if (mode === 'resume-lost' && requests.filter(x => x.route === '/acquire').length === 1) return request.socket.destroy();
    return json({ targetId: 'existing-target', leaseToken: lease });
  }
  assert.equal(request.headers['x-cdp-lease'], lease);
  assert.equal(request.headers['x-cdp-manage'], mode.startsWith('resume') ? undefined : manage);
  if (url.pathname === '/release') return json({ released: true, closed: false });
  if (url.pathname === '/info' && mode === 'resume-wrong-url') return json({ page: { url: 'https://example.com/changed' } });
  if (url.pathname === '/info' && mode === 'resume-timeout') return json({ error: { code: 'cdp_timeout' } }, 504);
  if (url.pathname === '/finalize') {
    if (mode === 'close-failed') return json({ closed: false, error: { code: 'close_failed', details: { leaseToken: lease, manageToken: manage } } });
    if (mode === 'close-unknown') return json({ error: { code: 'outcome_unknown', details: { requestId: request.headers['x-cdp-request-id'] } } }, 502);
    closed++; return json({ closed: true });
  }
  if (url.pathname === '/screenshot') {
    if (mode === 'shot-timeout' || mode === 'disconnect-active') return;
    return json({ error: { code: 'cdp_timeout', details: { leaseToken: lease, manageToken: manage, requestId: request.headers['x-cdp-request-id'] } } }, 504);
  }
  if (url.pathname === '/dom/query' && mode === 'query-failed') return json({ error: { code: 'fixture_error', details: { authorization: `Bearer ${fakeBearer}`, leaseToken: lease } } }, 500);
  if (url.pathname === '/click' && mode === 'click-safe-reason') return json({ error: { code: 'element_not_found', details: { reason: 'text_mismatch', authorization: `Bearer ${fakeBearer}`, leaseToken: lease } } }, 404);
  if (url.pathname === '/click' && mode === 'click-unsafe-reason') return json({ error: { code: 'element_not_found', details: { reason: `Bearer ${fakeBearer}`, leaseToken: lease } } }, 404);
  if (url.pathname === '/dom/query') return json({ found: true, text: '中文正文、Música、🚀', truncated: false });
  return json({ page: { url: 'https://example.com/', scrollY: 2800, readyState: 'complete' }, targetId: url.searchParams.get('target') });
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
fs.writeFileSync(path.join(root, `${port}.token`), fakeBearer);

function reset(nextMode) { mode = nextMode; requests = []; newResults = new Map(); opened = 0; closed = 0; }
function launch({ timeout = ordinaryRequestBudgetMs, wrapper, resume = false, used = 1 } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-File', script, ...(resume ? ['-ExistingTarget', 'existing-target', '-ExpectedUrl', 'https://example.com/', '-RecoveryAttemptsUsed', String(used)] : ['-InitialUrl', 'https://example.com/']), '-Owner', 'session-selftest', '-Port', String(port), '-RequestTimeoutMilliseconds', String(timeout)];
  if (wrapper) args.push('-RequestScript', wrapper);
  const child = spawn('pwsh', args, { windowsHide: true, env: { ...process.env, CDP_PROXY_TOKEN_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', pending = '';
  const lines = []; const listeners = new Set();
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk; pending += chunk;
    while (pending.includes('\n')) { const at = pending.indexOf('\n'), text = pending.slice(0, at).trim(); pending = pending.slice(at + 1); if (!text) continue; const value = JSON.parse(text); lines.push(value); for (const fn of listeners) fn(value); }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  const watchdog = setTimeout(() => child.kill(), 60000);
  const wait = predicate => {
    const existing = lines.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('fixture event timeout')); }, 15000); const listener = value => { if (predicate(value)) { clearTimeout(timer); listeners.delete(listener); resolve(value); } }; listeners.add(listener); });
  };
  return { child, lines, wait, send: value => child.stdin.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n'),
    end: value => child.stdin.end(value), finish: async () => { const code = await done; clearTimeout(watchdog); const all = stdout + stderr; for (const secret of [fakeBearer, lease, manage, ...requests.map(x => x.key).filter(Boolean)]) assert.equal(all.includes(secret), false, 'capability leaked to output'); assert.equal(JSON.stringify(child.spawnargs).includes(lease), false); assert.equal(JSON.stringify(child.spawnargs).includes(manage), false); lastCase = { mode, code, requestBudgetMs:timeout, routes:requests.map(x=>x.route), lines:lines.map(({type,action,ok,ready,existingTarget,recoveryAttemptsUsed,error,released,closed}) => ({type,action,ok,ready,existingTarget,recoveryAttemptsUsed,error,released,closed})) }; return { code, stdout, stderr, lines }; } };
}

try {
  let holder, result;
  if (!process.argv.includes('--resume-only')) {
  reset('normal');
  holder = launch(); holder.end('  \n\n'); result = await holder.finish();
  assert.equal(result.code, 0); assert.equal(opened, 0); assert.equal(requests.length, 0); assert.equal(result.lines[0].created, false);

  reset('normal');
  holder = launch(); holder.send({ action: 'query', body: { kind: 'text', selector: 'main', maxChars: 2000 } });
  await holder.wait(x => x.action === 'query'); holder.send('\n'); holder.send('{bad-json}\n'); holder.send({ action: 'info' });
  await holder.wait(x => x.action === 'info'); holder.end(JSON.stringify({ action: 'finish' }) + '\n'); result = await holder.finish();
  assert.equal(result.code, 0); assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(result.lines.filter(x => x.type === 'cleanup').length, 1);
  assert.equal(result.lines.find(x => x.action === 'query').data.text, '中文正文、Música、🚀');

  reset('shot-error');
  const destination = path.join(root, 'existing.jpg'); const prior = Buffer.from([255, 216, 255, 217]); fs.writeFileSync(destination, prior);
  holder = launch(); holder.send({ action: 'shot', path: destination }); await holder.wait(x => x.action === 'shot');
  holder.send({ action: 'info' }); await holder.wait(x => x.action === 'info'); holder.end(); result = await holder.finish();
  assert.equal(result.code, 0); assert.equal(result.lines.find(x => x.action === 'shot').ok, false); assert.deepEqual(fs.readFileSync(destination), prior); assert.equal(closed, 1);

  reset('shot-timeout');
  holder = launch({ timeout: deliberateTimeoutBudgetMs }); holder.send({ action: 'shot', path: path.join(root, 'timed-out.jpg') }); await holder.wait(x => x.type === 'ready');
  // An outer caller gives up waiting, without signalling or owning the holder.
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(holder.child.exitCode, null);
  const shot = await holder.wait(x => x.action === 'shot'); assert.equal(shot.error.code, 'request_timeout');
  assert.equal(holder.child.exitCode, null); holder.send({ action: 'info' }); await holder.wait(x => x.action === 'info');
  holder.end(JSON.stringify({ action: 'finish' }) + '\n'); result = await holder.finish(); assert.equal(result.code, 0); assert.equal(closed, 1); assert.equal(opened, 1);

  reset('disconnect-active');
  holder = launch({ timeout: deliberateTimeoutBudgetMs }); holder.send({ action: 'shot', path: path.join(root, 'disconnect.jpg') }); await holder.wait(x => x.type === 'ready');
  holder.end(); result = await holder.finish(); assert.equal(result.code, 0); assert.equal(closed, 1); assert.equal(result.lines.at(-1).reason, 'eof');

  reset('query-failed');
  holder = launch(); holder.send({ action: 'query', body: { kind: 'text', selector: 'main' } }); await holder.wait(x => x.action === 'query');
  holder.send({ action: 'info' }); await holder.wait(x => x.action === 'info'); holder.end(); result = await holder.finish(); assert.equal(result.code, 0); assert.equal(closed, 1);

  for (const reasonMode of ['click-safe-reason', 'click-unsafe-reason']) {
    reset(reasonMode); holder = launch(); holder.send({ action: 'click', body: { selector: 'div', index: 40, expectedText: '답변' } });
    const click = await holder.wait(x => x.action === 'click');
    assert.equal(click.error.code, 'element_not_found');
    assert.equal(JSON.parse(requests.find(x => x.route === '/click').body).expectedText, '답변', 'Korean input changed before the HTTP request');
    assert.equal(click.error.reason, reasonMode === 'click-safe-reason' ? 'text_mismatch' : undefined);
    assert.deepEqual(Object.keys(click.error).sort(), reasonMode === 'click-safe-reason' ? ['code', 'exitCode', 'reason'] : ['code', 'exitCode']);
    holder.end(); result = await holder.finish(); assert.equal(result.code, 0); assert.equal(closed, 1);
  }

  reset('new-lost-once');
  holder = launch(); holder.end(JSON.stringify({ action: 'info' }) + '\n'); result = await holder.finish();
  assert.equal(result.code, 0); assert.equal(opened, 1); assert.equal(closed, 1);
  const creates = requests.filter(x => x.route === '/new'); assert.equal(creates.length, 2); assert.equal(creates[0].key, creates[1].key); assert.equal(creates[0].url, creates[1].url);

  reset('new-failed');
  holder = launch(); holder.end(JSON.stringify({ action: 'info' }) + '\n'); result = await holder.finish();
  assert.equal(result.code, 1); assert.equal(requests.filter(x => x.route === '/new').length, 1); assert.equal(opened, 0);

  for (const failMode of ['close-failed', 'close-unknown']) {
    reset(failMode); holder = launch(); holder.end(JSON.stringify({ action: 'info' }) + '\n'); result = await holder.finish();
    assert.equal(result.code, 1); assert.equal(result.lines.at(-1).closed, false); assert.equal(result.lines.at(-1).error.code, 'cleanup_unconfirmed'); assert.equal(requests.filter(x => x.route === '/finalize').length, 1, 'unconfirmed close must not be replayed');
  }
  }
  for (const resumeMode of ['resume-normal', 'resume-lost', 'resume-wrong-url', 'resume-timeout']) {
    reset(resumeMode); holder = launch({ resume: true });
    holder.end(JSON.stringify({ action: 'recover' }) + '\n' + JSON.stringify({ action: 'query', body: { kind: 'text', selector: 'main' } }) + '\n');
    result = await holder.finish();
    assert.equal(opened, 0); assert.equal(closed, 0);
    assert.equal(requests.some(x => ['/new', '/navigate', '/finalize', '/recover'].includes(x.route)), false);
    assert.equal(requests.filter(x => x.route === '/release').length, 1);
    assert.equal(result.lines.at(-1).released, true);
    assert.equal(result.lines.at(-1).recoveryAttemptsUsed, 1);
    if (resumeMode === 'resume-wrong-url' || resumeMode === 'resume-timeout') {
      assert.equal(result.code, 1); assert.equal(requests.some(x => x.route === '/dom/query'), false);
    } else {
      assert.equal(result.code, 0); assert.equal(result.lines.find(x => x.action === 'recover').error.code, 'recovery_budget_exhausted');
      assert.equal(result.lines.find(x => x.action === 'query').ok, true);
    }
    if (resumeMode === 'resume-lost') {
      const gets = requests.filter(x => x.route === '/acquire'); assert.equal(gets.length, 2); assert.equal(gets[0].key, gets[1].key);
    }
  }
  reset('resume-normal'); holder = launch({ resume: true, used: 0 });
  holder.end(JSON.stringify({ action: 'recover' }) + '\n' + JSON.stringify({ action: 'recover' }) + '\n'); result = await holder.finish();
  assert.equal(requests.filter(x => x.route === '/recover').length, 1); assert.equal(result.lines.at(-1).recoveryAttemptsUsed, 1);
  console.log('cdp-session PASS (' + (process.argv.includes('--resume-only') ? 'resume only' : 'full') + '): original-target acquire, production info.page contract, exact URL verification, release-only cleanup, lost acquire same-key replay, failure preserves page, recovery budget preserved and enforced.');
} catch (error) {
  console.error(JSON.stringify({fixtureFailure:true,lastCase,activeMode:mode,receivedRoutes:requests.map(x=>x.route)}));
  throw error;
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  // This is an exact temporary fixture directory created above, never user data.
  fs.rmSync(root, { recursive: true, force: true });
}

#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectBatch, replayItems, loadItems, buildResult, saveJson } from './research-batch-runtime.mjs';
import { assertResearchRecipe } from './research-dom-recipes.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const KNOWN_SECRETS = new Set([process.env.CDP_LEASE, process.env.CDP_MANAGE].filter(Boolean));
const tokenDirectory = () => process.env.CDP_PROXY_TOKEN_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'cdp-proxy');
const recoveryGate = () => path.join(tokenDirectory(), 'research-lock-recovery.lock');
const targetLockFile = state => path.join(tokenDirectory(), 'research-target-locks', createHash('sha256').update(`${state.port}:${state.target}`).digest('hex') + '.json');
function infoUrl(info) { return info.page?.url || info.url || info.value?.url; }
function safeMessage(error) {
  let value = String(error?.message || error);
  for (const secret of KNOWN_SECRETS) value = value.split(secret).join('[redacted]');
  return value.replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [redacted]').slice(0, 500);
}
function gateBelongsToOtherProcess() {
  return fs.existsSync(recoveryGate()) && readJson(recoveryGate()).pid !== process.pid;
}
function takeLock(file, details = {}) {
  if (gateBelongsToOtherProcess()) throw new Error('Lock recovery is active; retry after it completes');
  if (fs.existsSync(file)) {
    const previous = readJson(file);
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid worker lock; preserve it for recovery');
    try { process.kill(previous.pid, 0); throw new Error('Another live worker owns this job or target'); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      throw new Error('Stale lock preserved; resume the original job to recover it explicitly');
    }
  }
  const lock = fs.openSync(file, 'wx');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ...details }));
  fs.closeSync(lock);
  if (gateBelongsToOtherProcess()) { releaseLock(file); throw new Error('Lock recovery began during startup; retry after it completes'); }
}
function releaseLock(file) {
  try { if (readJson(file).pid === process.pid) fs.unlinkSync(file); } catch {}
}
function recoverKnownJobLocks(directory, state) {
  const gate = recoveryGate();
  const handle = fs.openSync(gate, 'wx');
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, job_id: state.id }));
  fs.closeSync(handle);
  try {
    for (const file of [path.join(directory, 'worker.lock'), path.join(directory, 'launch.lock'), targetLockFile(state)]) {
      if (!fs.existsSync(file)) continue;
      const previous = readJson(file);
      if (previous.job_id !== state.id || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Lock ownership is not this job; preserve it for review');
      try { process.kill(previous.pid, 0); throw new Error('A worker or launcher is still alive'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.unlinkSync(file);
    }
  } finally { releaseLock(gate); }
}
function readCurrentCache(directory) {
  for (let attempt = 0; ; attempt += 1) {
    try { return loadItems(directory, readJson(path.join(directory, 'job.json'))); }
    catch (error) {
      let active = false;
      try { process.kill(readJson(path.join(directory, 'worker.lock')).pid, 0); active = true; } catch {}
      if (!active || !error.message.startsWith('Interrupted final cache record') || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * (attempt + 1));
    }
  }
}
function options(argv) {
  const result = { command: argv.shift() || 'help' };
  while (argv.length) {
    const key = argv.shift();
    if (!key.startsWith('--') || !argv.length || argv[0].startsWith('--')) throw new Error(`Expected --key value: ${key}`);
    if (Object.hasOwn(result, key.slice(2))) throw new Error(`Duplicate option ${key}`);
    result[key.slice(2)] = argv.shift();
  }
  return result;
}
function integer(raw, fallback, minimum, maximum) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Integer outside ${minimum}..${maximum}`);
  return value;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')); }
function createClient({ port, owner, target }) {
  if (!process.env.CDP_LEASE) throw new Error('CDP_LEASE must be supplied in the process environment');
  const tokenDir = process.env.CDP_PROXY_TOKEN_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'cdp-proxy');
  const token = fs.readFileSync(path.join(tokenDir, `${port}.token`), 'utf8').trim();
  KNOWN_SECRETS.add(token);
  const headers = { Authorization: `Bearer ${token}`, 'X-CDP-Owner': owner, 'X-CDP-Lease': process.env.CDP_LEASE };
  return async function request(route, method = 'GET', body, signal) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (route.startsWith('/screenshot?') && response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.headers.get('content-type')?.startsWith('image/jpeg') || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('Screenshot response is not JPEG');
      return { screenshot: bytes };
    }
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      const error = new Error(safeMessage(data.error?.message || `Broker HTTP ${response.status}`));
      error.code = data.error?.code || 'broker_request_failed';
      throw error;
    }
    return data;
  };
}

export async function runWorker(directory) {
  const lockPath = path.join(directory, 'worker.lock');
  const originalState = readJson(path.join(directory, 'job.json'));
  takeLock(lockPath, { job_id: originalState.id, directory });
  let targetLock;
  try {
  const state = readJson(path.join(directory, 'job.json'));
  const tokenDir = process.env.CDP_PROXY_TOKEN_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'cdp-proxy');
  const lockDirectory = path.join(tokenDir, 'research-target-locks');
  fs.mkdirSync(lockDirectory, { recursive: true });
  targetLock = targetLockFile(state);
  takeLock(targetLock, { job_id: state.id, directory });
  saveJson(path.join(directory, 'started.json'), { pid: process.pid, id: state.id });
  const request = createClient(state);
  const query = `target=${encodeURIComponent(state.target)}`;
  const current = await request(`/info?${query}`);
  const currentUrl = infoUrl(current);
  if (currentUrl && currentUrl !== state.target_url) {
    const before = new URL(state.target_url), after = new URL(currentUrl);
    before.hash = ''; after.hash = ''; before.searchParams.sort(); after.searchParams.sort();
    if (before.toString() !== after.toString()) throw new Error('Target changed; refusing resume');
  }
  const health = await request('/health');
  state.compatibility = !health.capabilities?.includes('research-dom-snapshot-v1');
  const scroll = (direction, amount, signal) => request(`/scroll?${query}&direction=${direction}&y=${amount}`, 'POST', undefined, signal);
  let stopped = false;
  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });
  const cancelled = () => stopped || (fs.existsSync(path.join(directory, 'control.json')) && readJson(path.join(directory, 'control.json')).cancel === true);
  let capturePending = true;
  const visualIndexPath = path.join(directory, 'visual-read-index.json');
  const visualFrames = state.capture_visual_frames === true && fs.existsSync(visualIndexPath) ? readJson(visualIndexPath).frames : [];
  let capturedThisRun = 0;
  const expandedCounts = new Map();
  const result = await collectBatch({
    state, directory, cancelled,
    snapshot: async signal => {
      if (!state.compatibility) {
        let value = (await request(`/research/snapshot?${query}`, 'POST', { recipe: state.recipe }, signal)).value;
        if ((state.expand_visible_x_text === true || state.expand_visible_youtube_text === true) && state.recipe === 'generic-posts') {
          for (let attempt = 0; attempt < 2; attempt++) {
            const control = value.page_state?.visible_expand_controls?.find(control =>
              ((state.expand_visible_x_text === true && /^https:\/\/x\.com\/FIIO_official\/status\/\d+$/i.test(control.post_url || '')) ||
               (state.expand_visible_youtube_text === true && control.author === 'FIIO' && /^https:\/\/www\.youtube\.com\/post\/Ug[A-Za-z0-9_-]{16,70}$/.test(control.post_url || '')))
              && (expandedCounts.get(control.post_url) || 0) < 2);
            if (!control) break;
            const clicked = await request(`/click?${query}`, 'POST', { selector: control.selector, index: control.index, expectedText: control.expected_text }, signal);
            expandedCounts.set(control.post_url, (expandedCounts.get(control.post_url) || 0) + 1);
            if (!clicked.clicked) break;
            const after = await request(`/info?${query}`, 'GET', undefined, signal);
            if (infoUrl(after) !== state.target_url) throw new Error('Text expansion changed page; collection stopped');
            const next = (await request(`/research/snapshot?${query}`, 'POST', { recipe: state.recipe }, signal)).value;
            if (JSON.stringify(next.items) === JSON.stringify(value.items)) break;
            value = next;
          }
        }
        if (state.capture_visual_frames === true && capturePending && value.items?.some(item => item.media?.items?.length)) {
          if (capturedThisRun >= 40) { const error = new Error('Forty viewport frames are ready for reading'); error.code = 'visual_batch_ready'; throw error; }
          const shot = await request(`/screenshot?${query}&format=jpeg`, 'GET', undefined, signal);
          const filename = `visual-${String(visualFrames.length + 1).padStart(5, '0')}.jpg`;
          fs.writeFileSync(path.join(directory, filename), shot.screenshot, { flag: 'wx' });
          visualFrames.push({ file: filename, sources: value.items.map(item => ({ source_id: item.source_id, post_url: item.post_url })), scope: 'viewport_only' });
          saveJson(visualIndexPath, { frames: visualFrames });
          capturedThisRun++; capturePending = false;
        }
        return value;
      }
      const info = await request(`/info?${query}`, 'GET', undefined, signal);
      let text = (await request(`/dom/query?${query}`, 'POST', { kind: 'text', selector: 'main', maxChars: 16000 }, signal)).value;
      if (!text?.found) text = (await request(`/dom/query?${query}`, 'POST', { kind: 'text', selector: 'body', maxChars: 16000 }, signal)).value;
      return { url: infoUrl(info), text };
    },
    advance: async (page, signal) => {
      if (!state.compatibility && page.pagination?.verified && page.pagination.next) {
        const locator = page.pagination.next;
        // Resolve the visible button afresh using the public query grammar.
        // Recipe selectors may contain attribute-value tests rejected by /click.
        const buttons = (await request(`/dom/query?${query}`, 'POST', { kind: 'elements', selector: 'button', visibility: 'rendered', limit: 50, fields: ['text'] }, signal)).value;
        const wanted = String(locator.expected_text || '').replace(/\s+/gu, ' ').trim();
        const matches = (buttons?.items || []).map((button, index) => ({ text: String(button.text || '').replace(/\s+/gu, ' ').trim(), index })).filter(button => button.text === wanted);
        if (!wanted || buttons?.truncated || matches.length !== 1) throw new Error('Registered next-page button is missing, ambiguous, or outside bounded query');
        const result = await request(`/click?${query}`, 'POST', { selector: 'button', expectedText: wanted, index: matches[0].index }, signal);
        if (!result.clicked) throw new Error('Registered next-page control did not activate');
      } else await scroll('down', 700, signal);
      capturePending = true;
    },
    recover: async signal => { await scroll('up', 350, signal); await scroll('down', 700, signal); },
  });
  return result;
  } catch (error) {
    const file = path.join(directory, 'job.json');
    const state = readJson(file);
    state.state = 'needs_review'; state.stop_reason = 'worker_initialization_error';
    state.updated_at = new Date().toISOString(); state.worker_pid = process.pid;
    state.error = { code: error.code || 'initialization_error', message: safeMessage(error) };
    saveJson(file, state);
    throw error;
  } finally {
    releaseLock(lockPath);
    if (targetLock) releaseLock(targetLock);
  }
}

async function main() {
  const opts = options(process.argv.slice(2));
  const allowed = new Set(['command', 'out', 'owner', 'target', 'recipe', 'port', 'max-seconds', 'max-steps', 'interval-ms', 'plateau-steps']);
  for (const key of Object.keys(opts)) if (!allowed.has(key)) throw new Error(`Unknown option --${key}; capabilities use environment only`);
  if (opts.command === 'help') {
    console.log('research-batch.mjs start --out DIR --owner NAME --target ID --recipe NAME [--max-seconds 900] [--interval-ms 2000]\nstatus|read|cancel|resume --out DIR\nCapabilities stay in CDP_LEASE environment; read exports result.json, never declares reviewed.');
    return;
  }
  if (!opts.out) throw new Error('--out is required');
  const directory = path.resolve(opts.out);
  const stateFile = path.join(directory, 'job.json');
  if (opts.command === 'status') { const value = readJson(stateFile); delete value.target; console.log(JSON.stringify(value)); return; }
  if (opts.command === 'read') {
    const state = readJson(stateFile);
    const value = state.storage_mode === 'single_snapshot_v2'
      ? readJson(path.join(directory, 'result.json')) : buildResult(state, readCurrentCache(directory));
    if (state.storage_mode !== 'single_snapshot_v2') saveJson(path.join(directory, 'result.json'), value);
    console.log(JSON.stringify({ file: path.join(directory, 'result.json'), items: value.items.length, coverage: value.coverage, conclusion: value.conclusion }));
    return;
  }
  if (opts.command === 'cancel') { saveJson(path.join(directory, 'control.json'), { cancel: true }); console.log('cancel_requested'); return; }
  if (opts.command === '_worker') {
    await runWorker(directory);
    return;
  }
  if (!['start', 'resume'].includes(opts.command)) throw new Error('Unknown command');
  if (opts.command === 'start') {
    if (!opts.owner || !opts.target || !opts.recipe) throw new Error('--owner, --target and --recipe are required');
    assertResearchRecipe(opts.recipe);
    const port = integer(opts.port || process.env.CDP_PROXY_PORT, 3456, 1024, 65535);
    const request = createClient({ port, owner: opts.owner, target: opts.target });
    const info = await request(`/info?target=${encodeURIComponent(opts.target)}`);
    const targetUrl = infoUrl(info);
    if (!targetUrl || !/^https?:\/\//u.test(targetUrl)) throw new Error('A readable leased HTTP(S) target is required');
    if (fs.existsSync(directory)) throw new Error('Output directory already exists; use resume for the same task');
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.mkdirSync(directory);
    saveJson(stateFile, { schema_version: 1, storage_mode: 'single_snapshot_v2', id: randomUUID(), state: 'created', recipe: opts.recipe,
      owner: opts.owner, target: opts.target, target_url: targetUrl, port,
      max_seconds: integer(opts['max-seconds'], 900, 1, 3600), max_steps: integer(opts['max-steps'], 2000, 1, 10000),
      interval_ms: integer(opts['interval-ms'], 2000, 750, 10000), plateau_steps: integer(opts['plateau-steps'], 4, 2, 20),
      starting_position: 'current_page', iterations: 0 });
  }
  if (opts.command === 'resume') recoverKnownJobLocks(directory, readJson(stateFile));
  const launchLock = path.join(directory, 'launch.lock');
  takeLock(launchLock, { job_id: readJson(stateFile).id, directory });
  try {
  if (opts.command === 'resume') {
    const current = readJson(stateFile);
    if (fs.existsSync(path.join(directory, 'worker.lock'))) {
      const lock = readJson(path.join(directory, 'worker.lock'));
      try { process.kill(lock.pid, 0); throw new Error('Worker is still alive; cancel and wait before resume'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (current.worker_pid) {
      try { process.kill(current.worker_pid, 0); throw new Error('Recorded worker is still alive; cancel and wait before resume'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    createClient(current);
    loadItems(directory, current);
    if (opts['max-steps'] !== undefined) current.max_steps = integer(opts['max-steps'], current.max_steps, current.iterations + 1, 10000);
    if (opts['max-seconds'] !== undefined) current.max_seconds = integer(opts['max-seconds'], current.max_seconds, 1, 3600);
    saveJson(stateFile, current);
    saveJson(path.join(directory, 'control.json'), { cancel: false });
  }
  const log = fs.openSync(path.join(directory, 'worker.log'), 'a');
  const child = spawn(process.execPath, [SCRIPT, '_worker', '--out', directory], {
    env: { ...process.env }, cwd: path.dirname(SCRIPT), detached: true, windowsHide: true, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  child.unref();
  const startedFile = path.join(directory, 'started.json');
  let started = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fs.existsSync(startedFile) && readJson(startedFile).pid === child.pid) { started = true; break; }
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!started) throw new Error('Worker did not confirm exclusive startup; inspect job.json and worker.log');
  const value = readJson(stateFile);
  console.log(JSON.stringify({ id: value.id, pid: child.pid, out: directory, state: 'starting', note: 'Collection does not imply reading or completion' }));
  } finally { releaseLock(launchLock); }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT;
if (direct) main().catch(error => { console.error(JSON.stringify({ error: error.code || 'batch_error', message: safeMessage(error) })); process.exitCode = 1; });

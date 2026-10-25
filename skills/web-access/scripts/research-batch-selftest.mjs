// Offline regression only: fixtures and a loopback fake broker, never a browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { normalizeSnapshot, mergeItem, collectBatch, replayItems, loadItems } from './research-batch-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'research-batch.mjs');
const PYTHON = process.env.RESEARCH_BATCH_TEST_PYTHON || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const COVERAGE = process.env.RESEARCH_BATCH_TEST_COVERAGE || path.join(process.env.BACKGROUND_CHECK_WORKSPACE || path.resolve(HERE, '..', '..', '..'), 'tools', 'research-batch', 'coverage', 'validate.py');
const URL_A = 'https://www.facebook.com/profile.php?id=1001';
const URL_B = 'https://www.facebook.com/profile.php?id=1002';

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'research-batch-offline-')); }
function cleanup(directory) {
  const actual = fs.realpathSync(directory), root = fs.realpathSync(os.tmpdir());
  assert.ok(actual.startsWith(root + path.sep) && path.basename(actual).startsWith('research-batch-offline-'));
  fs.rmSync(actual, { recursive: true, force: true });
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function item(id = 'post-1', text = '完整正文') {
  return { source_id: id, post_url: `https://example.com/posts/${id}`, stable_deduplication: true,
    own_visible_text: text, repost: [], media: { items: [], declared_count: 0 },
    truncation: {}, expansion: {}, warnings: [] };
}
function snapshot(items = [item()], page = {}) {
  return { items, page_state: { url: URL_A, loading: false, route_matches_recipe: true,
    verification_hints: [], login_hints: [], explicit_end_hints: [], extraction_truncated: false, ...page } };
}
function state(extra = {}) {
  return { id: 'fixture-job', recipe: 'generic-posts', target_url: URL_A,
    max_seconds: 60, max_steps: 100, interval_ms: 0, plateau_steps: 2,
    compatibility: false, starting_position: 'current_page', iterations: 0, ...extra };
}

test('compact collector stores one cache and resumes without a journal', async () => inRuntime(async directory => {
  const initial = state({storage_mode: 'single_snapshot_v2', max_steps: 3, recovery_used: 1});
  await collectBatch({state: initial, directory, snapshot: async () => snapshot([item()]),
    advance: async () => {}, recover: async () => {}, cancelled: () => false, wait: async () => {}});
  assert.equal(fs.existsSync(path.join(directory, 'items.ndjson')), false);
  assert.equal(loadItems(directory, initial).size, 1);
  initial.max_steps = 4;
  const result = await collectBatch({state: initial, directory, snapshot: async () => snapshot([item(), item('post-2')]),
    advance: async () => {}, recover: async () => {}, cancelled: () => false, wait: async () => {}});
  assert.equal(result.items.length, 2);
  assert.equal(initial.recovery_used, 1);
  assert.equal(fs.existsSync(path.join(directory, 'items.ndjson')), false);
}));

test('compact missing or mismatched cache preserves checkpoint and rejects resume', async () => inRuntime(async directory => {
  const checkpoint = state({storage_mode: 'single_snapshot_v2', item_count: 2});
  assert.throws(() => loadItems(directory, checkpoint), /missing/);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({job: {id: 'wrong-job'}, items: []}));
  assert.throws(() => loadItems(directory, checkpoint), /identity mismatch/);
  assert.equal(checkpoint.item_count, 2);
}));
async function inRuntime(callback) {
  const directory = temporary();
  try { return await callback(directory); } finally { cleanup(directory); }
}
function execute(binary, args, env = process.env, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Fixture command timed out: ${args[0]}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function waitFor(read, predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = read(); if (predicate(last)) return last; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture wait timed out: ${JSON.stringify(last)}`);
}

test('normalize preserves long text and quoted text without slice', () => {
  const long = ('长文😀\n' + '正文'.repeat(50)).repeat(1000);
  const raw = item('long', long);
  raw.repost = [{ author: '原作者', text: long }];
  const normalized = normalizeSnapshot(snapshot([raw]));
  assert.equal(normalized.items[0].text, long);
  assert.equal(normalized.items[0].quoted_text, `原作者: ${long}`);
  assert.equal(normalized.items[0].text_truncated, false);
});

test('normalize preserves unresolved source, expansion and gallery gaps', () => {
  const raw = item();
  delete raw.source_id;
  raw.stable_deduplication = false;
  raw.truncation.list_summary = true;
  raw.media = { items: [{ url: 'https://example.com/1.jpg', kind: 'image' }], declared_count: 3, gap: true };
  const normalized = normalizeSnapshot(snapshot([raw]), { sequence: 2 }).items[0];
  assert.equal(normalized.source_id, 'unresolved-2-0');
  assert.equal(normalized.needs_expansion, true);
  assert.equal(normalized.media_count, 3);
  assert.ok(normalized.warnings.includes('unstable_source_identity'));
  assert.ok(normalized.warnings.includes('unexpanded_gallery'));
});

test('merge keeps the fullest text and quoted fields independently', () => {
  const previous = normalizeSnapshot(snapshot([item()])).items[0];
  previous.text = '旧'; previous.quoted_text = '很长的转发原文'.repeat(30);
  const current = structuredClone(previous);
  current.text = '新完整正文'.repeat(100); current.quoted_text = '短摘要';
  const combined = mergeItem(previous, current);
  assert.equal(combined.text, current.text);
  assert.equal(combined.quoted_text, previous.quoted_text);
});

test('identical attributed unresolved observations deduplicate across ten snapshots without becoming post IDs', async () => inRuntime(async directory => {
  const raw = item(); raw.source_id = null; raw.post_url = null; raw.stable_deduplication = false;
  raw.author = '公开作者'; raw.date = '2023-10-27';
  const first = normalizeSnapshot(snapshot([raw]), { sequence: 1 }).items[0];
  const tenth = normalizeSnapshot(snapshot([raw]), { sequence: 10 }).items[0];
  assert.equal(first.source_id, tenth.source_id);
  assert.equal(first.observation_identity, 'content_fingerprint_not_post_id');
  assert.ok(first.warnings.includes('unstable_source_identity'));
  const result = await collectBatch({ state: state({ max_steps: 10, plateau_steps: 20 }), directory, cancelled: () => false,
    snapshot: async () => snapshot([raw]), advance: async () => {}, recover: async () => {}, wait: async () => {} });
  assert.equal(result.items.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'items.ndjson'), 'utf8').trim().split('\n').length, 1);
  assert.equal(result.coverage.collection_complete, false);
}));

test('unresolved fingerprint keeps different authors, dates and media separate', () => {
  const raw = { ...item(), source_id: null, post_url: null, stable_deduplication: false, author: '甲', date: '2023-10-27' };
  const variants = [raw, { ...raw, author: '乙' }, { ...raw, date: '2023-10-28' }, { ...raw, media: { items: [{ kind: 'image', url: 'https://example.com/different.jpg' }] } }];
  assert.equal(new Set(normalizeSnapshot(snapshot(variants)).items.map(x => x.source_id)).size, 4);
});

test('same isolated-world DOM observation merges lazy media without merging another card', () => {
  const raw = { ...item(), source_id:null, post_url:null, stable_deduplication:false,
    author:'飞傲FiiO',date:'2025年7月9日',dom_observation_id:'dom-live-epoch123:1',media:{items:[]} };
  const page = values => ({...snapshot(values),recipe:'bilibili-dynamic'});
  const first = normalizeSnapshot(page([raw])).items[0];
  const loaded = normalizeSnapshot(page([{...raw,media:{items:[{kind:'image',url:'https://i1.hdslb.com/bfs/new_dyn/photo.jpg'}]}}])).items[0];
  const separate = normalizeSnapshot(page([{...raw,dom_observation_id:'dom-live-epoch123:2'}])).items[0];
  assert.equal(first.source_id,loaded.source_id);
  assert.equal(first.observation_identity,'dom_observation_not_post_id');
  assert.notEqual(first.source_id,separate.source_id);
  assert.equal(mergeItem(first,loaded).media.length,1);
  assert.ok(loaded.warnings.includes('unstable_source_identity'));
});

test('anonymous empty media and exhausted snapshots stop before scrolling', async () => inRuntime(async directory => {
  let advances = 0;
  const raw = { ...item(), source_id: null, post_url: null, stable_deduplication: false, own_visible_text: '', media: { items: [{ kind: 'image', url: 'https://example.com/unattributed.jpg' }] } };
  const result = await collectBatch({ state: state(), directory, cancelled: () => false,
    snapshot: async () => snapshot([raw]), advance: async () => { advances++; }, recover: async () => { throw Error('must not retry broken snapshots'); }, wait: async () => {} });
  assert.equal(result.coverage.stop_reason, 'unattributed_empty_card');
  assert.equal(advances, 0);
  assert.equal(result.items[0].media.length, 1);
  const second = await inRuntime(async other => collectBatch({ state: state(), directory: other, cancelled: () => false,
    snapshot: async () => snapshot([item()], { extraction_truncated: true }), advance: async () => { advances++; }, recover: async () => {}, wait: async () => {} }));
  assert.equal(second.coverage.stop_reason, 'extraction_truncated');
  assert.equal(advances, 0);
}));

test('partial reread preserves known attribution and original checkpoint journal', async () => inRuntime(async directory => {
  const previous = normalizeSnapshot(snapshot([item()])).items[0];
  previous.account = '甲'; previous.date = '2023-10-27';
  const current = { ...previous, text: '', post_url: null, account: null, date: null, text_truncated: true };
  const combined = mergeItem(previous, current);
  assert.equal(combined.account, previous.account); assert.equal(combined.date, previous.date);
  assert.equal(combined.post_url, previous.post_url); assert.equal(combined.text, previous.text);
  const journal = path.join(directory, 'items.ndjson'), original = JSON.stringify(previous) + '\n';
  fs.writeFileSync(journal, original);
  await collectBatch({ state: state(), directory, cancelled: () => true,
    snapshot: async () => { throw Error('cancelled checkpoint must not fetch'); }, advance: async () => {}, recover: async () => {} });
  assert.equal(fs.readFileSync(journal, 'utf8'), original);
}));

test('merge rejects or marks same source identity attached to different post URL', () => {
  const previous = normalizeSnapshot(snapshot([item()])).items[0];
  const current = structuredClone(previous);
  current.post_url = 'https://example.com/posts/other-person';
  let rejected = false;
  try {
    const combined = mergeItem(previous, current);
    rejected = combined.warnings.some(warning => /identity|source|url/iu.test(warning));
  } catch { rejected = true; }
  assert.equal(rejected, true);
});

test('verified visible endpoint collects, never confirms reading', async () => inRuntime(async directory => {
  const result = await collectBatch({ state: state(), directory, cancelled: () => false,
    snapshot: async () => snapshot([item()], { explicit_end_hints: ['没有更多'] }),
    advance: async () => {}, recover: async () => {}, wait: async () => {} });
  assert.equal(result.coverage.collection_complete, true);
  assert.equal(result.coverage.text_review_complete, false);
  assert.equal(result.items.length, 1);
  assert.equal(json(path.join(directory, 'job.json')).state, 'collected');
}));

test('stalled list uses one up/down recovery and remains incomplete', async () => inRuntime(async directory => {
  let recoveries = 0;
  const result = await collectBatch({ state: state(), directory, cancelled: () => false,
    snapshot: async () => snapshot(), advance: async () => {}, recover: async () => { recoveries += 1; }, wait: async () => {} });
  assert.equal(recoveries, 1);
  assert.equal(result.coverage.stop_reason, 'stall');
  assert.equal(result.coverage.collection_complete, false);
  assert.equal(result.items.length, 1);
}));

test('opt-in loaded-card scrolling advances past a persistent loader without claiming completion', async () => inRuntime(async directory => {
  let advances = 0;
  const result = await collectBatch({ state: state({ max_steps: 5, plateau_steps: 20, scroll_with_loaded_items: true }), directory, cancelled: () => false,
    snapshot: async () => snapshot([item(`post-${advances}`)], { loading: true }),
    advance: async () => { advances += 1; }, recover: async () => {}, wait: async () => {} });
  assert.ok(advances >= 2);
  assert.ok(result.items.length >= 2);
  assert.equal(result.coverage.collection_complete, false);
}));

test('opt-in loaded-card scrolling does not push an empty loading shell', async () => inRuntime(async directory => {
  let advances = 0;
  await collectBatch({ state: state({ max_steps: 5, plateau_steps: 20, scroll_with_loaded_items: true }), directory, cancelled: () => false,
    snapshot: async () => snapshot([], { loading: true }),
    advance: async () => { advances += 1; }, recover: async () => {}, wait: async () => {} });
  assert.equal(advances, 0);
}));

test('empty snapshots and failed snapshots are not endpoints', async () => {
  for (const scenario of ['empty', 'error']) {
    await inRuntime(async directory => {
      const result = await collectBatch({ state: state(), directory, cancelled: () => false,
        snapshot: async () => { if (scenario === 'error') throw new Error('synthetic failure'); return snapshot([]); },
        advance: async () => {}, recover: async () => {}, wait: async () => {} });
      assert.equal(result.coverage.collection_complete, false);
      assert.equal(result.coverage.stop_reason, scenario === 'empty' ? 'empty_response' : 'error');
    });
  }
});

test('login and verification pages stop without adding their articles', async () => {
  for (const key of ['login_hints', 'verification_hints']) {
    await inRuntime(async directory => {
      const result = await collectBatch({ state: state(), directory, cancelled: () => false,
        snapshot: async () => snapshot([item('login-ad')], { [key]: ['required'] }),
        advance: async () => {}, recover: async () => {}, wait: async () => {} });
      assert.equal(result.items.length, 0);
      assert.equal(result.coverage.collection_complete, false);
    });
  }
});

test('source URL query changes cannot substitute another profile or search', async () => {
  for (const [before, after] of [[URL_A, URL_B], ['https://x.com/search?q=authorA&f=live', 'https://x.com/search?q=authorB&f=live']]) {
    await inRuntime(async directory => {
      const result = await collectBatch({ state: state({ target_url: before }), directory, cancelled: () => false,
        snapshot: async () => snapshot([item('wrong-subject')], { url: after, explicit_end_hints: ['End'] }),
        advance: async () => {}, recover: async () => {}, wait: async () => {} });
      assert.equal(result.coverage.collection_complete, false);
      assert.equal(result.items.length, 0);
      assert.equal(result.coverage.stop_reason, 'target_changed');
    });
  }
});

test('cancel arriving during snapshot cannot mark a collected endpoint', async () => inRuntime(async directory => {
  let cancel = false;
  const result = await collectBatch({ state: state(), directory, cancelled: () => cancel,
    snapshot: async () => { cancel = true; return snapshot([item()], { explicit_end_hints: ['End'] }); },
    advance: async () => {}, recover: async () => {}, wait: async () => {} });
  assert.equal(result.job.state, 'paused');
  assert.equal(result.coverage.collection_complete, false);
}));

test('deadline arriving during snapshot cannot mark a collected endpoint', async () => inRuntime(async directory => {
  let now = 0;
  const result = await collectBatch({ state: state({ max_seconds: 1 }), directory, cancelled: () => false, now: () => now,
    snapshot: async () => { now = 1500; return snapshot([item()], { explicit_end_hints: ['End'] }); },
    advance: async () => {}, recover: async () => {}, wait: async () => {} });
  assert.equal(result.coverage.collection_complete, false);
  assert.equal(result.coverage.stop_reason, 'limit');
}));

test('hanging snapshot is bounded by the configured deadline', async () => inRuntime(async directory => {
  const started = Date.now();
  const result = await collectBatch({ state: state({ max_seconds: 1 }), directory, cancelled: () => false,
    snapshot: async () => new Promise(() => {}),
    advance: async () => {}, recover: async () => {} });
  assert.equal(result.coverage.stop_reason, 'limit');
  assert.ok(Date.now() - started < 2500, 'Deadline should abort the operation, not wait for a broker timeout');
}));

test('cancel preserves accumulated cache, resume deduplicates and completes', async () => inRuntime(async directory => {
  let cancel = false;
  const runtimeState = state();
  const first = await collectBatch({ state: runtimeState, directory, cancelled: () => cancel,
    snapshot: async () => snapshot([item('cached')]), advance: async () => { cancel = true; }, recover: async () => {}, wait: async () => {} });
  assert.equal(first.job.state, 'paused');
  assert.equal(replayItems(path.join(directory, 'items.ndjson')).size, 1);
  const second = await collectBatch({ state: json(path.join(directory, 'job.json')), directory, cancelled: () => false,
    snapshot: async () => snapshot([item('cached'), item('new')], { explicit_end_hints: ['End'] }),
    advance: async () => {}, recover: async () => {}, wait: async () => {} });
  assert.equal(second.items.length, 2);
  assert.equal(second.coverage.collection_complete, true);
}));

test('updated duplicate is appended once and replay keeps the fuller version', async () => inRuntime(async directory => {
  let pass = 0;
  const result = await collectBatch({ state: state(), directory, cancelled: () => false,
    snapshot: async () => { pass += 1; return snapshot([item('same', pass === 1 ? '短' : '完整正文'.repeat(100))], pass > 1 ? { explicit_end_hints: ['End'] } : {}); },
    advance: async () => {}, recover: async () => {}, wait: async () => {} });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, '完整正文'.repeat(100));
  assert.equal(replayItems(path.join(directory, 'items.ndjson')).get('same').text, result.items[0].text);
}));

test('collected cache connects to text export and explicit coverage confirmation', async () => inRuntime(async directory => {
  const body = ('完整正文😀\n' + '长'.repeat(80)).repeat(1000);
  await collectBatch({ state: state(), directory, cancelled: () => false,
    snapshot: async () => snapshot([item('long', body)], { explicit_end_hints: ['End'] }),
    advance: async () => {}, recover: async () => {}, wait: async () => {} });
  const resultFile = path.join(directory, 'result.json');
  const readDir = path.join(directory, 'read');
  const exported = await execute(PYTHON, ['-X', 'utf8', COVERAGE, resultFile, '--export-text', readDir, '--max-chars', '4096']);
  assert.equal(exported.code, 0, exported.stdout + exported.stderr);
  assert.equal(JSON.parse(exported.stdout).coverage_complete, false);
  const reviewFile = path.join(readDir, 'review.json');
  const review = json(reviewFile);
  assert.ok(review.text_batches.length > 10);
  assert.ok(review.text_batches.every(batch => batch.reviewed === false));
  review.reviewer = 'fixture-reader';
  for (const batch of review.text_batches) batch.reviewed = true;
  fs.writeFileSync(reviewFile, JSON.stringify(review), 'utf8');
  const confirmed = await execute(PYTHON, ['-X', 'utf8', COVERAGE, resultFile, '--review', reviewFile, '--require-complete']);
  assert.equal(confirmed.code, 0, confirmed.stdout + confirmed.stderr);
  assert.equal(JSON.parse(confirmed.stdout).coverage_complete, true);
}));

async function withBroker(callback) {
  const root = temporary();
  const tokenDir = path.join(root, 'token'); fs.mkdirSync(tokenDir);
  const token = 'fixture-bearer-secret-never-log';
  const lease = 'fixture-lease-secret-never-log';
  const owner = 'offline-test';
  const requests = [];
  const fixture = { endpoint: false, error: null, healthError: null, url: URL_A, active: 0, maxActive: 0 };
  const server = http.createServer(async (req, res) => {
    fixture.active += 1; fixture.maxActive = Math.max(fixture.maxActive, fixture.active);
    res.once('close', () => { fixture.active -= 1; });
    let body = ''; for await (const part of req) body += part;
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ route: url.pathname, method: req.method, body: body ? JSON.parse(body) : undefined });
    const authorized = req.headers.authorization === `Bearer ${token}` && req.headers['x-cdp-lease'] === lease && req.headers['x-cdp-owner'] === owner;
    if (!authorized) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'fixture_auth' } })); return; }
    const reply = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/info') return reply({ ok: true, targetId: 'fake-target',
      page: { url: fixture.url, title: 'Offline research fixture' }, contextVersion: 1 });
    if (url.pathname === '/health') return fixture.healthError
      ? reply({ ok: false, error: { code: 'fixture_health_error', message: fixture.healthError } })
      : reply({ capabilities: ['research-dom-snapshot-v1'] });
    if (url.pathname === '/research/snapshot') {
      if (fixture.error) return reply({ ok: false, error: { code: 'fixture_error', message: fixture.error } });
      return reply({ value: snapshot([item('local-fixture')], { url: fixture.url, ...(fixture.endpoint ? { explicit_end_hints: ['End'] } : {}) }) });
    }
    if (url.pathname === '/scroll') return reply({ ok: true });
    if (url.pathname === '/click') return reply({ ok: true, clicked: true });
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'fixture_route' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(tokenDir, `${port}.token`), token, 'utf8');
  const env = { ...process.env, CDP_LEASE: lease, CDP_PROXY_TOKEN_DIR: tokenDir, CDP_PROXY_PORT: String(port) };
  const out = path.join(root, 'job');
  const cli = args => execute(process.execPath, [CLI, ...args], env);
  const start = extra => cli(['start', '--out', out, '--owner', owner, '--target', 'fake-target', '--recipe', 'generic-posts', '--port', String(port), '--interval-ms', '750', '--max-seconds', '15', ...(extra || [])]);
  try { await callback({ root, out, fixture, cli, start, requests, token, lease, tokenDir, port }); }
  finally {
    for (const name of fs.readdirSync(root)) {
      const directory = path.join(root, name);
      if (!fs.statSync(directory).isDirectory() || !fs.existsSync(path.join(directory, 'job.json'))) continue;
      try { await cli(['cancel', '--out', directory]); } catch {}
      const worker = json(path.join(directory, 'job.json')).worker_pid;
      if (worker) { try { process.kill(worker, 'SIGTERM'); } catch {} }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => server.close(resolve));
    cleanup(root);
  }
}

test('CLI fake broker start/status/read/cancel/resume retains data and hides capabilities', async () => withBroker(async ({ out, fixture, cli, start, token, lease }) => {
  const started = await start();
  assert.equal(started.code, 0, started.stderr);
  await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'running' && value.item_count >= 1);
  const status = await cli(['status', '--out', out]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(Object.hasOwn(JSON.parse(status.stdout), 'target'), false);
  const read = await cli(['read', '--out', out]);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).items, 1);
  assert.equal(JSON.parse(read.stdout).coverage.collection_complete, false);
  assert.equal((await cli(['cancel', '--out', out])).code, 0);
  const paused = await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'paused');
  await waitFor(() => { try { process.kill(paused.worker_pid, 0); return true; } catch { return false; } }, alive => !alive);
  fixture.endpoint = true;
  const resumed = await cli(['resume', '--out', out]);
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'collected');
  assert.equal(json(path.join(out, 'result.json')).items.length, 1);
  for (const file of fs.readdirSync(out)) {
    if (!fs.statSync(path.join(out, file)).isFile()) continue;
    const content = fs.readFileSync(path.join(out, file), 'utf8');
    assert.equal(content.includes(token), false, file);
    assert.equal(content.includes(lease), false, file);
  }
}));

test('CLI redacts reflected bearer/lease secrets from broker error caches and logs', async () => withBroker(async ({ out, fixture, start, token, lease }) => {
  fixture.error = `Synthetic broker error ${token} ${lease}`;
  const started = await start();
  assert.equal(started.code, 0, started.stderr);
  await waitFor(() => json(path.join(out, 'job.json')), value => ['needs_review', 'failed'].includes(value.state));
  for (const file of fs.readdirSync(out)) {
    if (!fs.statSync(path.join(out, file)).isFile()) continue;
    const content = fs.readFileSync(path.join(out, file), 'utf8');
    assert.equal(content.includes(token), false, file);
    assert.equal(content.includes(lease), false, file);
  }
}));

test('CLI consumes the production info page.url envelope', async () => withBroker(async ({ out, fixture, start }) => {
  fixture.endpoint = true;
  const started = await start();
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const terminal = await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'collected');
  assert.equal(terminal.target_url, URL_A);
  assert.equal(json(path.join(out, 'result.json')).coverage.collection_complete, true);
}));

test('CLI worker initialization failure becomes a visible terminal status', async () => withBroker(async ({ out, fixture, start, token, lease }) => {
  fixture.healthError = `Synthetic initialization error ${token} ${lease}`;
  const started = await start();
  assert.equal(started.code, 0, started.stderr);
  const result = await waitFor(() => json(path.join(out, 'job.json')), value => ['needs_review', 'failed'].includes(value.state));
  assert.equal(result.stop_reason, 'worker_initialization_error');
  for (const file of fs.readdirSync(out)) {
    if (!fs.statSync(path.join(out, file)).isFile()) continue;
    const content = fs.readFileSync(path.join(out, file), 'utf8');
    assert.equal(content.includes(token), false, file);
    assert.equal(content.includes(lease), false, file);
  }
}));

test('CLI concurrent resume admits only one worker for the task', async () => withBroker(async ({ out, fixture, cli, start }) => {
  assert.equal((await start()).code, 0);
  await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'running' && value.item_count >= 1);
  assert.equal((await cli(['cancel', '--out', out])).code, 0);
  const paused = await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'paused');
  await waitFor(() => { try { process.kill(paused.worker_pid, 0); return true; } catch { return false; } }, alive => !alive);
  fixture.endpoint = false;
  const outcomes = await Promise.all([cli(['resume', '--out', out]), cli(['resume', '--out', out])]);
  assert.equal(outcomes.filter(value => value.code === 0).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter(value => value.code !== 0).length, 1, JSON.stringify(outcomes));
  await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'running');
}));

test('CLI another output directory cannot start a second sampler on the same target', async () => withBroker(async ({ root, out, cli, start }) => {
  assert.equal((await start()).code, 0);
  await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'running' && value.item_count >= 1);
  const duplicate = await cli(['start', '--out', path.join(root, 'other-job'), '--owner', 'offline-test',
    '--target', 'fake-target', '--recipe', 'generic-posts', '--interval-ms', '750', '--max-seconds', '15']);
  assert.notEqual(duplicate.code, 0, duplicate.stdout + duplicate.stderr);
}));

async function pauseAndWait(out, cli) {
  await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'running' && value.item_count >= 1);
  assert.equal((await cli(['cancel', '--out', out])).code, 0);
  const paused = await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'paused');
  await waitFor(() => { try { process.kill(paused.worker_pid, 0); return true; } catch { return false; } }, alive => !alive);
  return paused;
}
function targetLockFile(tokenDir, port) {
  return path.join(tokenDir, 'research-target-locks', createHash('sha256').update(`${port}:fake-target`).digest('hex') + '.json');
}

test('CLI concurrent recovery of dead same-job locks still admits one worker', async () => withBroker(async ({ out, cli, start, tokenDir, port }) => {
  assert.equal((await start()).code, 0);
  const paused = await pauseAndWait(out, cli);
  const stale = { pid: paused.worker_pid, job_id: paused.id, directory: out };
  for (const file of [path.join(out, 'launch.lock'), path.join(out, 'worker.lock'), targetLockFile(tokenDir, port)]) {
    fs.writeFileSync(file, JSON.stringify(stale), 'utf8');
  }
  const outcomes = await Promise.all([cli(['resume', '--out', out]), cli(['resume', '--out', out])]);
  assert.equal(outcomes.filter(value => value.code === 0).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter(value => value.code !== 0).length, 1, JSON.stringify(outcomes));
  await waitFor(() => json(path.join(out, 'job.json')), value => value.state === 'running');
  const actual = json(targetLockFile(tokenDir, port));
  assert.equal(actual.job_id, paused.id);
  assert.notEqual(actual.pid, paused.worker_pid);
}));

test('CLI refuses to reclaim a dead target lock belonging to another job', async () => withBroker(async ({ root, out, cli, start, tokenDir, port }) => {
  assert.equal((await start()).code, 0);
  const paused = await pauseAndWait(out, cli);
  const lockFile = targetLockFile(tokenDir, port);
  const foreign = { pid: paused.worker_pid, job_id: 'different-job-id', directory: path.join(root, 'foreign-job') };
  fs.writeFileSync(lockFile, JSON.stringify(foreign), 'utf8');
  const outcome = await cli(['resume', '--out', out]);
  assert.notEqual(outcome.code, 0, outcome.stdout + outcome.stderr);
  assert.deepEqual(json(lockFile), foreign);
  assert.equal(json(path.join(out, 'job.json')).state, 'paused');
}));

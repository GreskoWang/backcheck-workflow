import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DETAIL_RECIPES, parseDetailSource, collectDetail, createDetailClient, takeDetailLock, targetLockPath } from './research-detail.mjs';
import { validateDomQuery, validateClickSpec } from './cdp-proxy.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = process.env.RESEARCH_WORKSPACE || process.env.BACKGROUND_CHECK_WORKSPACE || path.resolve(directory, '..', '..', '..');
const python = process.env.RESEARCH_PYTHON || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const coverageScript = path.join(workspace, 'tools', 'research-batch', 'coverage', 'validate.py');
const pipelineScript = path.join(workspace, 'tools', 'research-batch', 'pipeline', 'prepare.py');
function execute(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 30_000, ...options }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') reject(error);
    else resolve({ code: error?.code || 0, stdout, stderr });
  }));
}
const BASE = { target: 'TEST-DETAIL', owner: 'detail-selftest', recipe: 'weibo-detail', subject: '1000000135', post: 'A00000001' };
function model(changes = {}) {
  const state = { url: 'https://weibo.com/1000000135/A00000001', authorHref: 'https://weibo.com/u/1000000135', body: '本人发布的完整正文。', roots: 1, expand: false, clicks: 0, quotes: [], media: [], ...changes };
  const operations = [];
  const config = DETAIL_RECIPES[state.recipe || BASE.recipe];
  const client = async (route, method, spec) => {
    operations.push({ route, method, spec });
    if (route.startsWith('/info?')) return { page: { url: state.url } };
    if (route.startsWith('/click?')) {
      validateClickSpec(JSON.stringify(spec));
      state.clicks++;
      state.expand = false;
      state.body = state.afterBody || '本人发布的完整正文，点击展开后取得更长的原文。';
      if (state.afterUrl) state.url = state.afterUrl;
      return { clicked: true };
    }
    assert.ok(route.startsWith('/dom/query?'), 'Only registered broker routes are used');
    validateDomQuery(spec);
    if (spec.kind === 'text') {
      if (spec.selector === config.bodies[0]) return { value: { found: true, text: state.body, truncated: Boolean(state.bodyTruncated) } };
      if (spec.selector === config.quotes[0]) return { value: { found: true, text: state.quotes[0]?.text || '', truncated: Boolean(state.quoteTruncated) } };
      return { value: { found: false, text: null } };
    }
    let items = [];
    if (spec.selector === config.roots[0]) items = Array.from({ length: state.roots }, () => ({ tag: 'ARTICLE' }));
    else if (spec.selector === config.bodies[0] && !state.missingBody) items = Array.from({ length: state.bodies || 1 }, () => ({ tag: 'DIV', text: state.body.slice(0, 1000) }));
    else if (spec.selector === config.authors[0] && state.authorHref) items = state.authorProfiles || [{ text: '作者', href: state.authorHref }];
    else if (spec.selector === config.controls[0] && state.expand) items = [{ text: '普通链接', tag: 'A' }, { text: '展开全文', tag: 'A' }];
    else if (spec.selector === config.quotes[0]) items = state.quotes;
    else if (spec.selector === config.dates[0]) items = state.dates || [{ text: '2024-12-09 10:30', dateTime: '2024-12-09T10:30:00+08:00' }];
    else if (spec.selector === config.dateObservationOnly?.[0]) items = state.wideDates || [];
    else if (spec.selector === config.titles?.[0]) items = [{ text: state.title || '视频／笔记的实际标题' }];
    else if (spec.selector === config.media[0]) items = state.media;
    return { value: { items, returned: items.length, truncated: Boolean(state.truncatedSelector === spec.selector) } };
  };
  return { state, operations, client };
}
async function run(changes = {}, options = {}) {
  const fixture = model(changes);
  const result = await collectDetail({ ...BASE, client: fixture.client, wait: async () => {}, ...options });
  return { ...fixture, result };
}

test('All fixed recipe selectors and click bodies satisfy the current broker schema', () => {
  for (const config of Object.values(DETAIL_RECIPES)) {
    for (const key of ['roots', 'bodies', 'titles', 'authors', 'quotes', 'dates', 'dateObservationOnly', 'controls', 'media']) {
      for (const selector of config[key] || []) {
        assert.doesNotThrow(() => validateDomQuery({ kind: 'elements', selector, limit: 50, fields: ['text', 'href'] }), selector);
        if (key === 'controls') assert.doesNotThrow(() => validateClickSpec(JSON.stringify({ selector, index: 0, expectedText: '展开全文' })));
      }
    }
  }
});

test('Registered details are accepted and all profile/list/search routes are rejected', () => {
  for (const [recipe, url, id] of [
    ['weibo-detail', 'https://weibo.com/1000000135/A00000001', 'A00000001'],
    ['weibo-detail', 'https://m.weibo.cn/status/A00000001', 'A00000001'],
    ['bilibili-dynamic', 'https://t.bilibili.com/1000000000000000123', '1000000000000000123'],
    ['bilibili-dynamic', 'https://www.bilibili.com/opus/1000000000000000123', '1000000000000000123'],
    ['bilibili-video', 'https://www.bilibili.com/video/BV1000000014/', 'BV1000000014'],
    ['x-post', 'https://x.com/Example/status/12345678', '12345678'],
    ['xiaohongshu-detail', 'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01', 'abcdef0123456789abcdef01'],
  ]) assert.equal(parseDetailSource(recipe, url).post_id, id);
  for (const url of ['https://weibo.com/u/1000000135', 'https://weibo.com/1000000135', 'https://s.weibo.com/weibo?q=x', 'http://weibo.com/1000000135/a', 'https://example.com/1000000135/a', 'https://user:pass@weibo.com/1000000135/a']) assert.throws(() => parseDetailSource('weibo-detail', url));
});

test('Exact body, source and actor are collected; review and account completion remain false', async () => {
  const { result } = await run();
  assert.equal(result.own.text, '本人发布的完整正文。');
  assert.equal(result.subject.verified, true);
  assert.equal(result.coverage.text_collection_complete, true);
  assert.equal(result.coverage.text_review_complete, false);
  assert.equal(result.coverage.media_review_complete, false);
  assert.equal(result.coverage.whole_account_completion_inferred, false);
  assert.equal(result.items[0].source_id, BASE.post);
  assert.equal(result.items[0].text, result.own.text);
  assert.equal(result.coverage.stop_reason, 'scope_boundary');
  assert.equal(result.scope.kind, 'single_post_detail');
  assert.equal(result.scope.boundary.verified, true);
  assert.equal(result.items[0].media_extraction_complete, false);
  assert.equal(result.conclusion, 'incomplete');
});

test('Expansion queries current controls, uses exact rendered index/text and rereads source', async () => {
  const { result, state, operations } = await run({ expand: true });
  assert.equal(state.clicks, 1);
  assert.equal(result.actions.expansions, 1);
  const click = operations.find(operation => operation.route.startsWith('/click?'));
  assert.deepEqual(click.spec, { selector: DETAIL_RECIPES['weibo-detail'].controls[0], index: 1, expectedText: '展开全文' });
  assert.match(result.own.text, /更长/);
  assert.equal(result.coverage.text_collection_complete, true);
});

test('A click and vanished control without additional text do not prove expansion', async () => {
  const { result, state } = await run({ expand: true, afterBody: '本人发布的完整正文。' });
  assert.equal(state.clicks, 1);
  assert.ok(result.coverage.gaps.includes('expansion_did_not_change_text'));
  assert.equal(result.coverage.text_collection_complete, false);
});

test('Wrong subject prevents every expansion and refuses own attribution', async () => {
  const { state, result } = await run({ expand: true }, { subject: '9999999' });
  assert.equal(state.clicks, 0);
  assert.equal(result.own.text, '');
  assert.ok(result.coverage.gaps.includes('subject_identity_unverified'));
  assert.ok(result.coverage.gaps.includes('unresolved_expand_control'));
});

test('Contradicting author link cannot be overridden by the URL actor', async () => {
  const { result, state } = await run({ authorHref: 'https://weibo.com/u/9999999', expand: true });
  assert.equal(state.clicks, 0);
  assert.ok(result.coverage.gaps.includes('subject_identity_conflict'));
  assert.equal(result.coverage.text_collection_complete, false);
});

test('A matching URL actor does not replace actual visible author verification', async () => {
  const { result, state } = await run({ authorHref: undefined, expand: true });
  assert.equal(state.clicks, 0);
  assert.equal(result.subject.verified, false);
  assert.equal(result.own.text, '');
  const missingExpected = await run({ expand: true }, { subject: undefined });
  assert.equal(missingExpected.state.clicks, 0);
  assert.equal(missingExpected.result.subject.verified, false);
});

test('Matching avatar anchors do not hide the nonempty author name for the same stable UID', async () => {
  const profiles = [
    { text: '', href: 'https://m.weibo.cn/profile/1000000135' },
    { text: '   ', href: 'https://m.weibo.cn/profile/1000000135' },
    { text: '合成作者', href: 'https://m.weibo.cn/profile/1000000135' },
  ];
  const named = await run({ authorProfiles: profiles });
  assert.equal(named.result.subject.verified, true);
  assert.equal(named.result.items[0].account, '合成作者');
  const avatarOnly = await run({ authorProfiles: profiles.slice(0, 1) });
  assert.equal(avatarOnly.result.subject.verified, true);
  assert.equal(avatarOnly.result.items[0].account, null);
});

test('A visible publication date plus video duration does not create two publication dates', async () => {
  const { result } = await run({ dates: [{ text: '2022-1-21' }, { text: '6:09' }] });
  assert.deepEqual(result.observations.dates, [{ text: '2022-1-21' }]);
  assert.equal(result.coverage.text_collection_complete, true);
  const durationOnly = await run({ dates: [{ text: '6:09' }] });
  assert.ok(durationOnly.result.coverage.gaps.includes('date_not_unique_or_missing'));
  assert.equal(durationOnly.result.items[0].needs_expansion, false);
  assert.equal(durationOnly.result.items[0].needs_detail_review, true);
});

test('Navigation to a different post after expansion invalidates collection', async () => {
  const { result } = await run({ expand: true, afterUrl: 'https://weibo.com/1000000135/DIFFERENT' });
  assert.ok(result.coverage.gaps.includes('detail_source_changed'));
  assert.equal(result.coverage.text_collection_complete, false);
});

test('Profile/list page never becomes detail text and causes no DOM requests or clicks', async () => {
  const { result, state, operations } = await run({ url: 'https://weibo.com/u/1000000135', expand: true });
  assert.equal(state.clicks, 0);
  assert.equal(operations.length, 1);
  assert.ok(result.coverage.gaps.includes('not_registered_detail_route'));
  assert.equal(result.own.text, '');
});

test('Unknown or multiple body nodes never upgrade a listing summary to own text', async () => {
  for (const changes of [{ missingBody: true }, { bodies: 2 }, { roots: 2, expand: true }]) {
    const { result, state } = await run(changes);
    assert.equal(result.coverage.text_collection_complete, false);
    assert.equal(result.own.text, '');
    if (changes.roots) assert.equal(state.clicks, 0);
  }
});

test('Truncated own or quoted text cannot pass collection', async () => {
  const own = await run({ bodyTruncated: true });
  assert.equal(own.result.coverage.text_collection_complete, false);
  const quoted = await run({ quotes: [{ text: '第三方原文' }], quoteTruncated: true });
  assert.equal(quoted.result.coverage.text_collection_complete, false);
  assert.ok(quoted.result.coverage.gaps.includes('quote_text_truncated'));
});

test('Own and quoted text remain distinct; overlap never promotes quotation to own speech', async () => {
  const clean = await run({ quotes: [{ text: '第三方原文' }] });
  assert.equal(clean.result.own.text, '本人发布的完整正文。');
  assert.equal(clean.result.quoted[0].text, '第三方原文');
  assert.equal(clean.result.items[0].quoted_text, '第三方原文');
  const mixed = await run({ body: '本人前言 第三方原文', quotes: [{ text: '第三方原文' }] });
  assert.equal(mixed.result.own.text, '');
  assert.equal(mixed.result.items[0].text, '');
  assert.equal(mixed.result.items[0].needs_expansion, false);
  assert.equal(mixed.result.items[0].needs_detail_review, true);
  assert.ok(mixed.result.coverage.gaps.includes('own_quote_separation_unverified'));
});

test('Bilibili and XHS require the supplied actor to match the exact visible profile link', async () => {
  for (const [recipe, url, subject, authorHref] of [
    ['bilibili-dynamic', 'https://t.bilibili.com/123456789', '10000139', 'https://space.bilibili.com/10000139'],
    ['bilibili-video', 'https://www.bilibili.com/video/BV1000000014', '10000139', 'https://space.bilibili.com/10000139'],
    ['xiaohongshu-detail', 'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01', 'abcdef0123456789abcdef02', 'https://www.xiaohongshu.com/user/profile/abcdef0123456789abcdef02'],
  ]) {
    const fixture = model({ recipe, url, authorHref });
    const good = await collectDetail({ ...BASE, recipe, subject, post: undefined, client: fixture.client, wait: async () => {} });
    assert.equal(good.subject.verified, true);
    assert.equal(good.coverage.text_collection_complete, true);
    const missing = await collectDetail({ ...BASE, recipe, subject: undefined, post: undefined, client: fixture.client, wait: async () => {} });
    assert.equal(missing.subject.verified, false);
  }
});

test('X text remains unassigned because bounded schema cannot rule out modern quote cards', async () => {
  const fixture = model({ recipe: 'x-post', url: 'https://x.com/example/status/123456789', body: '可见帖子与引用文字', expand: true });
  const result = await collectDetail({ ...BASE, recipe: 'x-post', subject: 'example', post: undefined, client: fixture.client });
  assert.equal(fixture.state.clicks, 0);
  assert.equal(result.own.text, '');
  assert.ok(result.coverage.gaps.includes('own_quote_separation_unverified'));
});

test('Media URLs are observations, never image viewing or video/comment completion', async () => {
  const { result } = await run({ media: [{ tag: 'IMG', src: 'https://cdn.example/image.jpg?signature=SECRET', alt: '公开配图' }, { tag: 'VIDEO', poster: 'https://cdn.example/poster.jpg' }] });
  assert.equal(result.media[0].url, 'https://cdn.example/image.jpg');
  assert.ok(result.media.every(item => item.review_state === 'not_reviewed'));
  assert.ok(result.coverage.gaps.includes('media_visual_review_pending'));
  assert.equal(result.coverage.media_review_complete, false);
  assert.equal(result.coverage.comments_review_complete, false);
  assert.ok(result.media.every(item => item.attribution_verified === false));
});

test('Video title and description are labeled separately and do not imply video viewing', async () => {
  const fixture = model({ recipe: 'bilibili-video', url: 'https://www.bilibili.com/video/BV1000000018', authorHref: 'https://space.bilibili.com/100000141/', body: '-', title: '合成视频标题' });
  const result = await collectDetail({ ...BASE, recipe: 'bilibili-video', subject: '100000141', post: 'BV1000000018', client: fixture.client });
  assert.equal(result.observations.title, fixture.state.title);
  assert.equal(result.items[0].title, fixture.state.title);
  assert.equal(result.own.text, '-');
  assert.equal(result.items[0].text, '-');
  assert.equal(result.own.kind, 'video_description_only');
  assert.equal(result.coverage.text_collection_complete, true);
  assert.equal(result.coverage.media_review_complete, false);
});

test('XHS uses the verified body date selector; comment dates are observation-only, never fallback attribution', async () => {
  const opts = { ...BASE, recipe: 'xiaohongshu-detail', subject: 'abcdef0123456789abcdef02', post: 'abcdef0123456789abcdef01' };
  const setup = { recipe: opts.recipe, url: 'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01', authorHref: 'https://www.xiaohongshu.com/user/profile/abcdef0123456789abcdef02', dates: [{ text: '3小时前 四川' }], wideDates: [{ text: '3小时前 四川' }, { text: '09-27 上海' }, { text: '38分钟前 上海' }] };
  const good = model(setup);
  const result = await collectDetail({ ...opts, client: good.client });
  assert.equal(result.items[0].date, '3小时前 四川');
  assert.equal(result.coverage.text_collection_complete, true);
  assert.equal(result.items[0].needs_expansion, false);
  assert.ok(!good.operations.some(operation => operation.spec?.selector === '.note-container .date'));
  const missing = model({ ...setup, dates: [], wideDates: [{ text: '09-27 上海' }] });
  const unassigned = await collectDetail({ ...opts, client: missing.client });
  assert.equal(unassigned.items[0].date, null);
  assert.equal(unassigned.items[0].needs_expansion, false);
  assert.ok(unassigned.coverage.gaps.includes('date_not_unique_or_missing'));
  assert.equal(unassigned.observations.unassigned_date_observations.items[0].text, '09-27 上海');
  assert.equal(unassigned.observations.unassigned_date_observations.attribution_verified, false);
});

test('Redacted signed image URLs remain unavailable candidates, never guessed download URLs', async () => {
  const { result } = await run({ media: [{ tag: 'IMG', src: 'https://sns-webpic-qc.xhscdn.com/202610151257/[redacted]/image.webp' }] });
  assert.equal(result.media[0].url, null);
  assert.equal(result.items[0].media[0].url, null);
  assert.equal(result.items[0].media[0].candidate, true);
  assert.equal(result.items[0].media[0].attribution_verified, false);
  assert.equal(result.items[0].media[0].review_state, 'not_reviewed');
  assert.ok(result.coverage.gaps.includes('media_url_unavailable_or_placeholder'));
});

test('Target lock interoperates with batch workers and preserves stale or foreign locks', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'research-detail-lock-'));
  const options = { port: 3456, target: 'mock-target', tokenDirectory: temporary, directory: temporary };
  const lock = targetLockPath(options);
  const release = takeDetailLock(options);
  assert.throws(() => takeDetailLock(options), /Stop the background worker/);
  release();
  fs.writeFileSync(lock, JSON.stringify({ pid: 99999999, job_id: 'old-job' }));
  assert.throws(() => takeDetailLock(options));
  assert.ok(fs.existsSync(lock));
  fs.unlinkSync(lock);
  fs.rmdirSync(path.dirname(lock));
  fs.rmdirSync(temporary);
});

test('Cancellation and native timeout codes remain explicit incomplete states', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const cancelled = await collectDetail({ ...BASE, signal: controller.signal, client: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.ok(cancelled.coverage.gaps.includes('cancelled'));
  const timedOut = await collectDetail({ ...BASE, client: async () => { throw new DOMException('Timed out', 'TimeoutError'); } });
  assert.ok(timedOut.coverage.gaps.includes('detail_request_timeout'));
  assert.ok(timedOut.coverage.gaps.every(reason => typeof reason === 'string'));
});

test('Real loopback HTTP and CLI retain capabilities in headers and redact them from evidence', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'research-detail-http-'));
  const brokerToken = 'fixture-broker-capability-123456789';
  const lease = 'fixture-lease-capability-987654321';
  const detailOptions = { ...BASE, recipe: 'bilibili-video', subject: '100000141', post: 'BV1000000018' };
  const fixture = model({ recipe: detailOptions.recipe, url: 'https://www.bilibili.com/video/BV1000000018', authorHref: 'https://space.bilibili.com/100000141/', title: '视频标题需要独立完整阅读', body: `简介中含测试值 ${brokerToken} ${lease}` });
  const seen = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${brokerToken}`);
      assert.equal(request.headers['x-cdp-lease'], lease);
      assert.equal(request.headers['x-cdp-owner'], BASE.owner);
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push(request.url.split('?')[0]);
      const data = await fixture.client(request.url, request.method, body);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
    } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: { code: 'fixture_failure', message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const tokenFile = path.join(temporary, `${port}.token`);
  fs.writeFileSync(tokenFile, brokerToken);
  const output = path.join(temporary, 'cli-output');
  try {
    const client = createDetailClient({ port, owner: BASE.owner, target: BASE.target, tokenDirectory: temporary, lease });
    const result = await collectDetail({ ...detailOptions, client });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(brokerToken)); assert.ok(!serialized.includes(lease));
    await assert.rejects(client('/eval?target=x', 'POST', '1'), /detail_route_not_allowed/);
    const child = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(directory, 'research-detail.mjs'), '--target', BASE.target, '--owner', BASE.owner, '--recipe', detailOptions.recipe, '--subject', detailOptions.subject, '--post', detailOptions.post, '--out', output, '--port', String(port)], { env: { ...process.env, CDP_PROXY_TOKEN_DIR: temporary, CDP_LEASE: lease }, timeout: 30_000 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
    assert.equal(child.stderr, '');
    const saved = fs.readFileSync(path.join(output, 'result.json'), 'utf8');
    assert.equal(JSON.parse(saved).schema_version, 1);
    for (const value of [saved, child.stdout]) { assert.ok(!value.includes(brokerToken)); assert.ok(!value.includes(lease)); }
    assert.ok(seen.every(route => ['/info', '/dom/query'].includes(route)));
    assert.equal(JSON.parse(saved).conclusion, 'incomplete');
    // Exercise the actual CLI output with the existing lightweight consumers.
    // This is offline only: do not pass --fetch-public to the pipeline.
    assert.ok(fs.existsSync(python), 'Bundled Python or RESEARCH_PYTHON is required for consumer integration');
    assert.ok(fs.existsSync(coverageScript)); assert.ok(fs.existsSync(pipelineScript));
    const evidenceRoot = process.env.RESEARCH_DETAIL_EVIDENCE_DIR || path.join(workspace, 'process', 'adapt-20261015', 'detail-client');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'contract-'));
    const source = path.join(evidence, 'detail-cli-result.json');
    fs.writeFileSync(source, saved);
    const exported = await execute(python, ['-X', 'utf8', coverageScript, source, '--export-text', path.join(evidence, 'coverage-text'), '--max-chars', '6000']);
    fs.writeFileSync(path.join(evidence, 'coverage-cli.json'), exported.stdout);
    assert.equal(exported.code, 0, exported.stdout + exported.stderr);
    const assessment = JSON.parse(exported.stdout);
    assert.equal(assessment.format_valid, true);
    assert.equal(assessment.coverage_complete, false);
    assert.equal(assessment.conclusion, 'incomplete');
    const review = JSON.parse(fs.readFileSync(path.join(evidence, 'coverage-text', 'review.json'), 'utf8'));
    assert.ok(review.text_batches.length > 0);
    assert.ok(review.text_batches.every(batch => batch.reviewed === false));
    assert.ok(review.text_batches.some(batch => batch.segments.some(segment => segment.field === 'title')), 'Video title must enter its independent unread coverage segments');
    assert.ok(review.text_batches.some(batch => batch.segments.some(segment => segment.field === 'text')), 'Video description remains independent from title');
    const allCoverageText = review.text_batches.map(batch => fs.readFileSync(path.join(evidence, 'coverage-text', `${batch.batch_id}.txt`), 'utf8')).join('\n');
    assert.ok(allCoverageText.includes(fixture.state.title));
    const prepared = await execute(python, ['-X', 'utf8', pipelineScript, 'prepare', source, '--out', path.join(evidence, 'pipeline'), '--max-chars', '6000']);
    fs.writeFileSync(path.join(evidence, 'pipeline-cli.json'), prepared.stdout);
    assert.ok([0, 2].includes(prepared.code), prepared.stdout + prepared.stderr);
    const receipt = JSON.parse(prepared.stdout);
    assert.equal(receipt.status, 'prepared');
    assert.equal(receipt.review_status, 'not_reviewed');
    assert.equal(receipt.coverage_complete, false);
    assert.equal(receipt.surface_completion, false);
    const pipelineReview = JSON.parse(fs.readFileSync(path.join(receipt.revision_directory, 'text', 'review.json'), 'utf8'));
    assert.ok(pipelineReview.text_batches.every(batch => batch.reviewed === false));
    assert.ok(pipelineReview.text_batches.some(batch => batch.segments.some(segment => segment.field === 'title')), 'Pipeline must preserve the independent unread video title');
    assert.ok(fs.existsSync(path.join(receipt.revision_directory, 'media-manifest.json')));
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ source: 'real_loopback_broker_fixture_to_detail_CLI_to_coverage_export_to_offline_pipeline_CLI', schema_version: 1, coverage_exit: exported.code, preparation_exit: prepared.code, format_valid: true, coverage_complete: false, network_media_requests: 0, review_confirmations_written: 0 }, null, 2));
    const lock = targetLockPath({ port, target: BASE.target, tokenDirectory: temporary });
    assert.ok(!fs.existsSync(lock));
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const file of [path.join(output, 'result.json'), tokenFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(output)) fs.rmdirSync(output);
    const lockDirectory = path.join(temporary, 'research-target-locks');
    if (fs.existsSync(lockDirectory)) fs.rmdirSync(lockDirectory);
    fs.rmdirSync(temporary);
  }
});

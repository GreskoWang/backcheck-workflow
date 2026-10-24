#!/usr/bin/env node
// Client-only detail/expansion adapter for the existing leased broker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DETAIL_RECIPES = Object.freeze({
  'weibo-detail': {
    roots: ['article', '.card9', '.WB_feed_type'],
    bodies: ['.detail_wbtext_4CRf9', '.WB_text', '.weibo-text'],
    authors: ['.weibo-top a[href]', '.head_name_24eEB', 'article header a[href]', '.WB_info a[href]', '.card9 .m-text-cut a[href]'],
    quotes: ['article .WB_feed_expand', '.card9 .WB_feed_expand', '.WB_feed_type .WB_feed_expand', 'article blockquote'],
    dates: ['.weibo-top .time', '.head-info_time_6sFQg', 'article time', '.WB_from a[href]', '.card9 .time'],
    controls: ['.weibo-text button,.weibo-text a', '.WB_text button,.WB_text a', '.detail_wbtext_4CRf9 button,.detail_wbtext_4CRf9 a'],
    media: ['article img,article video', '.card9 img,.card9 video', '.WB_feed_type img,.WB_feed_type video'],
  },
  'bilibili-dynamic': {
    roots: ['.opus-detail', '.bili-dyn-item', '.dyn-card'],
    bodies: ['.bili-dyn-content__orig__desc', '.bili-rich-text', '.dyn-card-text', '.opus-para'],
    authors: ['.opus-module-author a[href]', '.bili-dyn-title a[href]', '.dyn-card-user a[href]'],
    quotes: ['.opus-detail .bili-dyn-item__orig', '.bili-dyn-item .bili-dyn-item__orig', '.dyn-card .dyn-orig', '.opus-detail blockquote'],
    dates: ['.opus-module-author .pub-time', '.bili-dyn-time', '.dyn-card-time', 'main time'],
    controls: ['.bili-dyn-content__orig__desc button,.bili-dyn-content__orig__desc a', '.bili-rich-text button,.bili-rich-text a', '.bili-dyn-item .bili-dyn-more__btn', '.opus-detail .expand-btn'],
    media: ['.opus-detail img,.opus-detail video', '.bili-dyn-item img,.bili-dyn-item video'],
  },
  'bilibili-video': {
    roots: ['.video-container-v1', '.video-info-container', 'main'],
    bodies: ['.desc-info-text', '.video-desc', '.video-desc-container .desc'],
    titles: ['h1.video-title', 'h1'], ownKind: 'video_description_only',
    authors: ['.up-info-container .up-name', '.up-info-container a[href]', '.up-info .name[href]', '.video-owner .up-name'],
    quotes: ['.video-desc-container blockquote'],
    dates: ['.video-info-detail .pubdate-text', '.pubdate-text', '.video-info-detail-list', '.video-info-detail', 'main time'],
    controls: ['.video-desc-container button,.video-desc-container a', '.basic-desc-info button,.basic-desc-info a'],
    media: ['.bpx-player-video-wrap video', '.bpx-player-video-area video', '.video-container-v1 video', 'main video'],
  },
  'x-post': {
    roots: ['article'], bodies: ['article [lang]'],
    authors: [], quotes: ['article blockquote'], dates: ['article time'],
    controls: ['article button,article a'], media: ['article img,article video'],
    strictSingleRoot: true,
    // Modern X quote cards are not reliably identifiable through the bounded
    // schema. Keep attribution unverified rather than calling their text own.
    attributionUnverified: true,
  },
  'xiaohongshu-detail': {
    roots: ['.note-container', '#noteContainer'], bodies: ['#detail-desc', '.note-container .desc'],
    titles: ['#detail-title'],
    authors: ['.author-container a[href]', '.note-container .author a[href]'],
    quotes: ['.note-container blockquote'], dates: ['.bottom-container .date'],
    dateObservationOnly: ['.note-container .date'],
    controls: ['#detail-desc button,#detail-desc a', '.note-container .desc button,.note-container .desc a', '.note-container .expand-btn'], media: ['.media-container img,.media-container video', '.note-container img,.note-container video'],
  },
});

const SECRET_VALUES = new Set();
const cleanText = value => String(value || '').replace(/\s+/gu, ' ').trim();
function redact(value) {
  let text = String(value);
  for (const secret of SECRET_VALUES) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [redacted]');
}
function publicUrl(raw) {
  try {
    if (/\[redacted\]|%5bredacted%5d/iu.test(String(raw))) return null;
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = ''; url.search = '';
    return url.href;
  } catch { return null; }
}
function fail(code, message = code) { return Object.assign(new Error(message), { code }); }
function infoUrl(data) { return data?.page?.url || data?.url || data?.value?.url || null; }
function identityUrl(url) { return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/u, '')}`; }

export function parseDetailSource(recipe, raw) {
  if (!Object.hasOwn(DETAIL_RECIPES, recipe)) throw fail('invalid_detail_recipe');
  let url;
  try { url = new URL(raw); } catch { throw fail('invalid_detail_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw fail('invalid_detail_url');
  const host = url.hostname.toLowerCase();
  let match, subject = null;
  if (recipe === 'weibo-detail' && ['weibo.com', 'www.weibo.com'].includes(host)) {
    match = url.pathname.match(/^\/(\d{5,})\/([A-Za-z0-9]+)\/?$/u);
    if (match) { subject = match[1]; match = [match[0], match[2]]; }
    else match = url.pathname.match(/^\/(?:detail|status)\/([A-Za-z0-9]+)\/?$/u);
  } else if (recipe === 'weibo-detail' && host === 'm.weibo.cn') {
    match = url.pathname.match(/^\/(?:detail|status)\/([A-Za-z0-9]+)\/?$/u);
  } else if (recipe === 'bilibili-dynamic' && host === 't.bilibili.com') {
    match = url.pathname.match(/^\/(\d+)\/?$/u);
  } else if (recipe === 'bilibili-dynamic' && ['bilibili.com', 'www.bilibili.com'].includes(host)) {
    match = url.pathname.match(/^\/(?:opus|dynamic|dynamic\/detail)\/(\d+)\/?$/u);
  } else if (recipe === 'bilibili-video' && ['bilibili.com', 'www.bilibili.com'].includes(host)) {
    match = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]+)\/?$/u);
  } else if (recipe === 'x-post' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)) {
    match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/u);
    if (match) { subject = match[1].toLowerCase(); match = [match[0], match[2]]; }
  } else if (recipe === 'xiaohongshu-detail' && ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(host)) {
    match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/iu);
    if (!match) {
      const profileNote = url.pathname.match(/^\/user\/profile\/([a-f0-9]{24})\/([a-f0-9]{24})\/?$/iu);
      if (profileNote) { subject = profileNote[1].toLowerCase(); match = [profileNote[0], profileNote[2]]; }
    }
  }
  if (!match) throw fail('not_registered_detail_route', 'Expected a registered detail page, never a profile/list/search');
  return { post_id: match[1], route_subject: subject, post_url: publicUrl(url.href), route: identityUrl(url) };
}

function profileSubject(recipe, raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (recipe === 'weibo-detail' && ['weibo.com', 'www.weibo.com', 'm.weibo.cn'].includes(host)) return url.pathname.match(/^\/(?:u\/|profile\/)?(\d{5,})\/?$/u)?.[1] || null;
  if (recipe.startsWith('bilibili-') && host === 'space.bilibili.com') return url.pathname.match(/^\/(\d+)\/?$/u)?.[1] || null;
  if (recipe === 'xiaohongshu-detail' && ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(host)) return url.pathname.match(/^\/user\/profile\/([a-f0-9]{24})\/?$/iu)?.[1]?.toLowerCase() || null;
  return null;
}

function assertSameSource(before, after, recipe) {
  const current = parseDetailSource(recipe, after);
  if (current.post_id !== before.post_id || current.route !== before.route) throw fail('detail_source_changed');
  return current;
}

export function targetLockPath({ port, target, tokenDirectory }) {
  return path.join(tokenDirectory, 'research-target-locks', createHash('sha256').update(`${port}:${target}`).digest('hex') + '.json');
}

export function takeDetailLock({ port, target, tokenDirectory, directory }) {
  const gate = path.join(tokenDirectory, 'research-lock-recovery.lock');
  if (fs.existsSync(gate)) throw fail('worker_lock_recovery_active');
  const lockFile = targetLockPath({ port, target, tokenDirectory });
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let descriptor;
  try { descriptor = fs.openSync(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail('target_worker_lock_present', 'Stop the background worker and wait for its lock release; stale locks require original-job recovery');
    throw error;
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, job_id: `detail-${process.pid}`, directory }));
  fs.closeSync(descriptor);
  const release = () => {
    try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === process.pid) fs.unlinkSync(lockFile); } catch {}
  };
  if (fs.existsSync(gate)) { release(); throw fail('worker_lock_recovery_active'); }
  return release;
}

export function createDetailClient({ port = 3456, owner, target, tokenDirectory, lease = process.env.CDP_LEASE }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw fail('invalid_broker_port');
  if (!/^[A-Za-z0-9._:@-]{1,120}$/u.test(owner || '') || !/^[A-Za-z0-9._:-]{1,160}$/u.test(target || '')) throw fail('invalid_owner_or_target');
  if (!lease || /[\r\n]/u.test(lease)) throw fail('missing_or_invalid_lease');
  const token = fs.readFileSync(path.join(tokenDirectory, `${port}.token`), 'utf8').trim();
  if (!token || /[\r\n]/u.test(token)) throw fail('missing_or_invalid_broker_token');
  SECRET_VALUES.add(token); SECRET_VALUES.add(lease); SECRET_VALUES.add(process.env.CDP_MANAGE);
  return async (route, method = 'GET', body, signal) => {
    if (!/^\/(?:info|dom\/query|click|scroll)\?target=/u.test(route)) throw fail('detail_route_not_allowed');
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'X-CDP-Owner': owner, 'X-CDP-Lease': lease, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    let data;
    try { data = await response.json(); } catch { throw fail('invalid_broker_json'); }
    if (!response.ok || data.ok === false) throw fail(data.error?.code || 'broker_request_failed', redact(data.error?.message || `Broker HTTP ${response.status}`));
    return data;
  };
}

// A fixed detail recipe is a bounded collector, not a risk/media reviewer.
export async function collectDetail({ target, owner, recipe, subject, post, client, maxExpand = 2, signal, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const config = DETAIL_RECIPES[recipe];
  if (!config) throw fail('invalid_detail_recipe');
  if (!Number.isSafeInteger(maxExpand) || maxExpand < 0 || maxExpand > 2) throw fail('invalid_expansion_budget');
  if (subject !== undefined && !/^[A-Za-z0-9_]{1,64}$/u.test(subject)) throw fail('invalid_subject');
  if (post !== undefined && !/^[A-Za-z0-9]{1,64}$/u.test(post)) throw fail('invalid_expected_post');
  const started = now();
  const query = `target=${encodeURIComponent(target)}`;
  const operations = [], gaps = [];
  let source, finalUrl, body, title = null, quotes = [], author = {}, dates = [], dateObservations = null, media = [], controls = [], expansions = 0, rootCount = 0, finalSourceChecked = false;
  const ask = async (route, method = 'GET', payload) => {
    if (signal?.aborted) throw fail('cancelled');
    if (now() - started > 90_000 || operations.length >= 75) throw fail('detail_budget_exhausted');
    const deadline = AbortSignal.timeout(Math.max(1, 90_000 - (now() - started)));
    const result = await client(route, method, payload, signal ? AbortSignal.any([signal, deadline]) : deadline);
    operations.push({ route: route.split('?')[0], kind: payload?.kind || null, selector: payload?.selector || null });
    return result;
  };
  const elements = async (selector, fields = ['tag', 'text', 'href'], limit = 50) => (await ask(`/dom/query?${query}`, 'POST', { kind: 'elements', selector, visibility: 'rendered', fields, limit })).value;
  const text = async selector => (await ask(`/dom/query?${query}`, 'POST', { kind: 'text', selector, visibility: 'rendered', maxChars: 16000 })).value;
  const check = async () => {
    finalUrl = infoUrl(await ask(`/info?${query}`));
    if (!source) { source = parseDetailSource(recipe, finalUrl); if (post && source.post_id !== post) throw fail('unexpected_detail_post'); }
    else assertSameSource(source, finalUrl, recipe);
  };
  const readFirst = async (selectors, fields) => {
    for (const selector of selectors) {
      const value = await elements(selector, fields);
      if (value?.items?.length) return { selector, ...value };
      if (value?.truncated) return { selector, ...value };
    }
    return { items: [], truncated: false, selector: null };
  };
  const readBody = async () => {
    for (const selector of config.bodies) {
      const count = await elements(selector, ['tag', 'text'], 50);
      if (!count?.items?.length) continue;
      if (count.items.length !== 1 || count.truncated) return { selector, observed: count.items.map(item => item.text || '').join('\n'), text: '', complete: false, reason: 'ambiguous_or_multiple_body_nodes' };
      const value = await text(selector);
      return { selector, text: value?.text || '', observed: value?.text || '', complete: value?.found === true && value?.truncated === false && Boolean(cleanText(value.text)), reason: value?.truncated ? 'body_text_truncated' : null };
    }
    return { selector: null, text: '', observed: '', complete: false, reason: 'unknown_detail_body_layout' };
  };
  const readAuthor = async () => {
    const data = await readFirst(config.authors, ['text', 'href']);
    const identities = [...new Set(data.items.map(item => profileSubject(recipe, item.href)).filter(Boolean))];
    const expected = subject?.toLowerCase() || null;
    const actual = identities.length === 1 ? identities[0] : null;
    const conflict = identities.length > 1 || Boolean(source.route_subject && identities.length && identities.some(id => id !== source.route_subject));
    return { expected: expected || null, observed_ids: identities, observed_profiles: data.items.filter(item => profileSubject(recipe, item.href)).map(item => ({ name: item.text || null, profile_url: publicUrl(item.href), subject_id: profileSubject(recipe, item.href) })), route_subject: source.route_subject, verified: Boolean(expected && actual === expected && !conflict && !data.truncated), conflict, selector: data.selector };
  };
  const readControls = async () => {
    const data = await readFirst(config.controls, ['text', 'tag']);
    return { ...data, matches: data.items.map((item, index) => ({ index, text: cleanText(item.text) })).filter(item => /^(?:展开(?:全文|更多|全部)?|全文|查看全文|查看更多|更多|show more|read more)(?:\s*[>›»…]*)?$/iu.test(item.text)) };
  };
  try {
    await check();
    const root = await readFirst(config.roots, ['tag']);
    rootCount = root.items.length;
    if (root.truncated || rootCount !== 1) gaps.push('detail_root_not_unique');
    if (!rootCount) gaps.push('unknown_detail_root_layout');
    author = await readAuthor();
    body = await readBody();
    if (config.titles) {
      const titleData = await readFirst(config.titles, ['text', 'title']);
      if (titleData.items.length === 1 && !titleData.truncated) title = titleData.items[0].text || titleData.items[0].title || null;
      else gaps.push('detail_title_missing_or_ambiguous');
    }
    let controlData = await readControls();
    // Never activate controls until page, subject and unique container agree.
    while (rootCount === 1 && !root.truncated && author.verified && !config.attributionUnverified && controlData.matches.length === 1 && !controlData.truncated && expansions < maxExpand) {
      const selected = controlData.matches[0];
      await check();
      const before = body.observed;
      const clicked = await ask(`/click?${query}`, 'POST', { selector: controlData.selector, index: selected.index, expectedText: selected.text });
      if (clicked.clicked !== true) { gaps.push('expansion_click_unconfirmed'); break; }
      expansions++;
      await wait(1200);
      await check();
      author = await readAuthor();
      if (!author.verified) { gaps.push('subject_changed_after_expansion'); break; }
      body = await readBody();
      controlData = await readControls();
      if (body.observed === before) { gaps.push('expansion_did_not_change_text'); break; }
    }
    controls = controlData.matches;
    if (controlData.truncated) gaps.push('control_list_truncated');
    if (controls.length) gaps.push('unresolved_expand_control');
    for (const selector of config.quotes) {
      const data = await elements(selector, ['text', 'href']);
      if (data.truncated) gaps.push('quote_nodes_truncated');
      if (data.items.length) {
        if (data.items.length === 1) {
          const value = await text(selector);
          quotes.push({ text: value.text || '', post_url: publicUrl(data.items[0].href), author: null, attribution: 'observed_quote_container', author_attribution_verified: false, selector, complete: value.found === true && value.truncated === false });
          if (value.truncated) gaps.push('quote_text_truncated');
        } else { gaps.push('multiple_quote_nodes'); quotes.push(...data.items.map(item => ({ text: item.text || '', post_url: publicUrl(item.href), author: null, attribution: 'observed_quote_container', author_attribution_verified: false, selector, complete: false }))); }
        break;
      }
    }
    const dateData = await readFirst(config.dates, ['text', 'dateTime', 'title']);
    // A bare 6:09 can be video duration, never a publication date.
    dates = dateData.items.filter(item => item.dateTime || /\d{1,4}[-年/.月]\d{1,2}|\d+\s*(?:秒|分钟?|小时|天)前|昨天|今天|[A-Za-z]{3}\s+\d/u.test(item.text || item.title || ''));
    if (dateData.truncated || dates.length !== 1) gaps.push('date_not_unique_or_missing');
    if (dates.length !== 1 && config.dateObservationOnly) {
      const observed = await readFirst(config.dateObservationOnly, ['text', 'dateTime', 'title']);
      dateObservations = { selector: observed.selector, items: observed.items, truncated: observed.truncated, attribution_verified: false };
    }
    const mediaData = await readFirst(config.media, ['tag', 'src', 'poster', 'alt']);
    media = mediaData.items.map(item => ({ kind: item.tag?.toLowerCase() === 'video' ? 'video_candidate' : 'image_candidate', url: publicUrl(item.src), poster: publicUrl(item.poster), alt: item.alt || null, source_selector: mediaData.selector, attribution_verified: false, review_state: 'not_reviewed' }));
    if (mediaData.truncated) gaps.push('media_nodes_truncated');
    if (media.some(item => !item.url && !item.poster)) gaps.push('media_url_unavailable_or_placeholder');
    if (media.length) gaps.push('media_visual_review_pending', 'media_attribution_unverified');
    await check();
    author = await readAuthor();
    finalSourceChecked = true;
  } catch (error) {
    gaps.push(signal?.aborted ? 'cancelled' : ['AbortError', 'TimeoutError'].includes(error.name) ? 'detail_request_timeout' : typeof error.code === 'string' ? error.code : 'detail_request_failed');
  }
  if (!author.verified) gaps.push(author.conflict ? 'subject_identity_conflict' : 'subject_identity_unverified');
  if (!body?.complete) gaps.push(body?.reason || 'body_not_collected');
  const overlap = Boolean(body?.text && quotes.some(quote => quote.text && cleanText(body.text).includes(cleanText(quote.text))));
  if (overlap || config.attributionUnverified) gaps.push('own_quote_separation_unverified');
  const quoteComplete = !quotes.some(quote => !quote.complete);
  const ownVerified = Boolean(body?.complete && author.verified && !overlap && !config.attributionUnverified && rootCount === 1);
  const uniqueGaps = [...new Set(gaps)];
  const textGaps = uniqueGaps.filter(reason => !['media_visual_review_pending', 'media_attribution_unverified', 'media_url_unavailable_or_placeholder', 'media_nodes_truncated'].includes(reason));
  const textComplete = ownVerified && quoteComplete && !textGaps.length;
  const sourceChanged = uniqueGaps.some(reason => ['detail_source_changed', 'unexpected_detail_post', 'not_registered_detail_route', 'invalid_detail_url'].includes(reason));
  const boundaryVerified = Boolean(source && finalSourceChecked && !sourceChanged);
  const stopReason = uniqueGaps.includes('cancelled') ? 'cancelled' : uniqueGaps.includes('detail_request_timeout') ? 'timeout' : sourceChanged ? 'navigation' : boundaryVerified ? 'scope_boundary' : 'invalid_response';
  const standardItems = source ? [{
    source_id: source.post_id, post_url: source.post_url,
    account: author.verified ? cleanText(author.observed_profiles?.find(profile => profile.subject_id === author.expected && cleanText(profile.name))?.name) || null : null,
    account_id: author.verified ? author.expected : null, date: dates.length === 1 ? dates[0].dateTime || dates[0].text || dates[0].title || null : null,
    text: ownVerified ? body.text : '', quoted_text: quotes.map(quote => quote.text).filter(Boolean).join('\n\n'),
    ...(typeof title === 'string' && cleanText(title) ? { title } : {}),
    own_attribution_verified: ownVerified, quoted_author_attribution_verified: false,
    text_kind: config.ownKind || 'post_text', text_truncated: !body?.complete || !quoteComplete,
    needs_expansion: Boolean(controls.length || uniqueGaps.some(reason => ['expansion_click_unconfirmed', 'expansion_did_not_change_text'].includes(reason))),
    needs_detail_review: Boolean(!ownVerified || !quoteComplete || textGaps.length),
    media: media.map((entry, index) => ({ ...entry, kind: entry.kind === 'video_candidate' ? 'video' : 'image', candidate: true,
      post_source_id: source.post_id, media_id: `${source.post_id}:detail-media:${index + 1}` })),
    media_count: media.length, media_count_basis: 'observed_candidates_not_declared_post_count', media_extraction_complete: false,
    warnings: uniqueGaps,
  }] : [];
  const result = {
    schema_version: 1, adapter: 'research-detail-v1', recipe, target, owner,
    job: { id: `detail:${recipe}:${source?.post_id || 'unresolved'}`, recipe, state: 'needs_review', reason: stopReason, target_url: source?.post_url || null },
    source: source || null, subject: author,
    own: { text: ownVerified ? body.text : '', kind: config.ownKind || 'post_text', attribution_verified: ownVerified, selector: body?.selector || null },
    quoted: quotes,
    observations: { title, body_text: body?.observed || '', body_selector: body?.selector || null, root_count: rootCount, dates, unassigned_date_observations: dateObservations, remaining_expand_controls: controls },
    media,
    items: standardItems,
    scope: { kind: 'single_post_detail', source_ids: standardItems.map(item => item.source_id), whole_account_completion_inferred: false,
      boundary: { verified: boundaryVerified, reason: boundaryVerified ? `Client requested only detail post ${source.post_id}; verified this detail URL. This scope never completes its profile or platform.` : 'Detail source boundary could not be verified' } },
    coverage: { collection_complete: textComplete, stop_reason: stopReason, visible_endpoint_verified: boundaryVerified,
      observed_count: standardItems.length, unresolved: [...uniqueGaps.map(reason => ({ source_id: source?.post_id || null, reason })), { source_id: source?.post_id || null, reason: 'media_extraction_and_attribution_unverified' }],
      detail_route_verified: Boolean(source), text_collection_complete: textComplete, text_review_complete: false, media_review_complete: false, media_absence_proven: false, comments_review_complete: false, whole_account_completion_inferred: false, gaps: uniqueGaps },
    actions: { expansions, operations, elapsed_ms: now() - started }, conclusion: 'incomplete',
  };
  return JSON.parse(JSON.stringify(result, (key, value) => typeof value === 'string' ? redact(value) : value));
}

async function main() {
  const opts = {};
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') {
    console.log('research-detail.mjs --target ID --owner NAME --recipe weibo-detail|bilibili-dynamic|bilibili-video|x-post|xiaohongshu-detail --out NEW_DIR [--subject ACCOUNT_ID] [--post POST_ID] [--max-expand 2] [--port 3456]\nStop and await the target background worker first. CDP_LEASE stays in environment. Incomplete collection never means no risk.'); return;
  }
  const allowed = new Set(['target', 'owner', 'recipe', 'out', 'subject', 'post', 'max-expand', 'port']);
  while (args.length) {
    const key = args.shift();
    if (!key.startsWith('--') || !allowed.has(key.slice(2)) || !args.length || args[0].startsWith('--') || Object.hasOwn(opts, key.slice(2))) throw fail('invalid_cli_option');
    opts[key.slice(2)] = args.shift();
  }
  for (const key of ['target', 'owner', 'recipe', 'out']) if (!opts[key]) throw fail('missing_cli_option', `--${key} required`);
  if (!Object.hasOwn(DETAIL_RECIPES, opts.recipe)) throw fail('invalid_detail_recipe');
  const port = opts.port === undefined ? 3456 : Number(opts.port);
  const maxExpand = opts['max-expand'] === undefined ? 2 : Number(opts['max-expand']);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(maxExpand) || maxExpand < 0 || maxExpand > 2) throw fail('invalid_numeric_option');
  const directory = path.resolve(opts.out);
  if (fs.existsSync(directory)) throw fail('output_directory_exists', 'Use a new output directory; existing evidence is preserved');
  const tokenDirectory = process.env.CDP_PROXY_TOKEN_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'cdp-proxy');
  const client = createDetailClient({ port, owner: opts.owner, target: opts.target, tokenDirectory });
  const release = takeDetailLock({ port, target: opts.target, tokenDirectory, directory });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    fs.mkdirSync(directory, { recursive: true });
    const result = await collectDetail({ target: opts.target, owner: opts.owner, recipe: opts.recipe, subject: opts.subject, post: opts.post, maxExpand, client, signal: cancellation.signal });
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ schema_version: 1, result: path.join(directory, 'result.json'), text_collection_complete: result.coverage.text_collection_complete, gaps: result.coverage.gaps, conclusion: result.conclusion }));
    if (result.coverage.gaps.some(code => ['detail_source_changed', 'unexpected_detail_post', 'not_registered_detail_route', 'invalid_detail_url', 'detail_request_failed', 'detail_request_timeout', 'cancelled'].includes(code))) process.exitCode = 1;
  } finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); release(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(JSON.stringify({ error: error.code || 'detail_failed', message: redact(error.message).slice(0, 500) })); process.exitCode = 1; });

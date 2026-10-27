#!/usr/bin/env node
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
function argument(name) { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; }
const repo = path.resolve(argument('--repo') || '.');
const sourceFile = path.join(repo, 'skills/web-access/scripts/research-dom-recipes.mjs');
const { buildResearchReadFunctionDeclaration } = await import(pathToFileURL(sourceFile));
class Text {
  constructor(value, { forbidden = false } = {}) { this.nodeType = 3; this.parentElement = null; this.value = value; this.forbidden = forbidden; }
  get nodeValue() { if (this.forbidden) throw new Error('hidden/private text was accessed'); return this.value; }
}
class Element {
  constructor(tag = 'div', attrs = {}, children = [], style = {}) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs; this.childNodes = [];
    this.parentElement = null; this.style = style; this.hidden = attrs.hidden !== undefined;
    this.isContentEditable = attrs.contenteditable !== undefined; this.scrollHeight = 20; this.clientHeight = 20;
    this.disabled = attrs.disabled !== undefined;
    for (const child of children) this.append(typeof child === 'string' ? new Text(child) : child);
  }
  append(child) { child.parentElement = this; this.childNodes.push(child); return child; }
  getAttribute(name) {
    if (['value', 'data-token', 'data-auth', 'nonce'].includes(name)) throw new Error('private attribute was accessed');
    return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null;
  }
  getBoundingClientRect() { if (this.parentElement) return this.parentElement.getBoundingClientRect(); return { width: 400, height: 20, top: 0, left: 0, right: 400, bottom: 20 }; }
  contains(node) { for (let candidate = node; candidate; candidate = candidate.parentElement) if (candidate === this) return true; return false; }
  matches(selector) { return selector.split(',').some(part => matchPath(this, splitParts(part.trim()))); }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.childNodes) if (child.nodeType === 1) { if (child.matches(selector)) result.push(child); visit(child); } };
    visit(this); return result;
  }
  get innerText() { throw new Error('unfiltered aggregate text was accessed'); }
  get textContent() { throw new Error('unfiltered aggregate text was accessed'); }
}
function splitParts(selector) {
  const parts = []; let depth = 0, current = '';
  for (const char of selector) {
    if (char === '[') depth++;
    if (char === ']') depth--;
    if (/\s/.test(char) && !depth) { if (current) { parts.push(current); current = ''; } }
    else current += char;
  }
  if (current) parts.push(current);
  return parts;
}
function matchPath(node, parts) {
  if (!parts.length || !matchSimple(node, parts.at(-1))) return false;
  let cursor = node.parentElement;
  for (let index = parts.length - 2; index >= 0; index--) {
    while (cursor && !matchSimple(cursor, parts[index])) cursor = cursor.parentElement;
    if (!cursor) return false;
    cursor = cursor.parentElement;
  }
  return true;
}
function matchSimple(node, selector) {
  const tag = selector.match(/^[a-zA-Z][\w-]*/)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const id of selector.matchAll(/#([\w-]+)/g)) if (node.attrs.id !== id[1]) return false;
  const withoutAttributes = selector.replace(/\[[^\]]+\]/g, '');
  for (const cls of withoutAttributes.matchAll(/\.([\w-]+)/g)) if (!String(node.attrs.class || '').split(/\s+/).includes(cls[1])) return false;
  for (const found of selector.matchAll(/\[([\w-]+)(?:(\*=|=)"([^"]*)")?\]/g)) {
    const [, key, operator, expected] = found;
    if (!Object.hasOwn(node.attrs, key)) return false;
    if (operator === '=' && String(node.attrs[key]) !== expected) return false;
    if (operator === '*=' && !String(node.attrs[key]).includes(expected)) return false;
  }
  return true;
}
const el = (tag, attrs = {}, children = [], style = {}) => new Element(tag, attrs, children, style);
const a = (href, text = '') => el('a', { href }, [text]);
const p = (text, attrs = {}) => el('p', attrs, [text]);
function createRunner(recipe, children, url = 'https://weibo.com/u/123456') {
  const body = el('body', {}, children), html = el('html', {}, [body]);
  const document = { body, baseURI: url, location: { href: url }, title: 'Public profile', querySelectorAll: selector => html.querySelectorAll(selector) };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('cookies were accessed'); } });
  const reject = () => { throw new Error('network/storage must not be accessed'); };
  const context = {
    document, URL, Element, innerWidth: 1000, innerHeight: 800, getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', ...node.style }),
    fetch: reject, localStorage: new Proxy({}, { get: reject }), sessionStorage: new Proxy({}, { get: reject }),
  };
  vm.createContext(context);
  const read = () => JSON.parse(JSON.stringify(vm.runInContext(`(${buildResearchReadFunctionDeclaration(recipe)})`, context)()));
  read.context = context;
  return read;
}
function run(...args) { return createRunner(...args)(); }

const cases = [];
function test(name, fn) {
  try { fn(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: { name: error.name, message: error.message } }); }
}
const listUrls = {
  'weibo-feed': 'https://weibo.com/u/123456',
  'douyin-posts': 'https://www.douyin.com/user/example',
  'xiaohongshu-notes': 'https://www.xiaohongshu.com/user/profile/5f5140b50000000001004d8b',
};
function position(node, top, height = 100) {
  node.getBoundingClientRect = () => ({ width: 400, height, top, bottom: top + height, left: 0, right: 400 });
  return node;
}
function makeCard(recipe, number, text) {
  if (recipe === 'weibo-feed') return el('article', {}, [a(`https://weibo.com/123456/Source${number}`), p(text, { class: 'detail_wbtext_a' })]);
  if (recipe === 'douyin-posts') return el('li', {}, [a(`https://www.douyin.com/video/${1000000000000000000n + BigInt(number)}`), p(text, { 'data-e2e': 'video-desc' })]);
  return el('section', { class: 'note-item' }, [a(`https://www.xiaohongshu.com/explore/${number.toString(16).padStart(24, '0')}`), p(text, { class: 'title' })]);
}
for (const recipe of Object.keys(listUrls)) {
  const url = listUrls[recipe];
  test(`${recipe}: 300 retained old bodies are never read before the visible new card`, () => {
    const old = Array.from({ length: 300 }, (_, i) => {
      const card = position(makeCard(recipe, i + 1, 'old private-for-fixture body'), -100000);
      card.childNodes.at(-1).childNodes[0].forbidden = true;
      return card;
    });
    const current = makeCard(recipe, 9999, 'CURRENT_BODY_END');
    const out = run(recipe, [...old, current], url);
    assert.equal(out.items.length, 1);
    assert.ok(out.items[0].own_visible_text.endsWith('CURRENT_BODY_END'));
    assert.equal(out.page_state.rendered_card_count, 301);
    assert.equal(out.page_state.extraction_truncated, false);
    assert.equal(out.page_state.collection_window, 'viewport_plus_one_screen');
    assert.equal(out.page_state.historical_completion_proven, false);
  });
  test(`${recipe}: current viewport is read before expensive overlap cards`, () => {
    const overlap = Array.from({ length: 5 }, (_, i) => position(makeCard(recipe, i + 1, 'x'.repeat(1100000)), -400));
    const current = makeCard(recipe, 9999, 'CURRENT_BEFORE_OVERLAP');
    const out = run(recipe, [...overlap, current], url);
    assert.ok(out.items[0].own_visible_text.endsWith('CURRENT_BEFORE_OVERLAP'));
    assert.equal(out.page_state.extraction_truncated, true);
    assert.equal(out.page_state.historical_completion_proven, false);
  });
  test(`${recipe}: detail body is not viewport limited`, () => {
    const card = position(makeCard(recipe, 33, 'DETAIL_BODY_END'), -100000);
    const out = run(recipe, [card], card.childNodes[0].getAttribute('href'));
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].card_kind, 'post_detail');
    assert.ok(out.items[0].own_visible_text.endsWith('DETAIL_BODY_END'));
    assert.equal(out.page_state.windowed, false);
  });
  test(`${recipe}: overlap preserves public identity across successive windows`, () => {
    const first = position(makeCard(recipe, 11, 'FIRST'), 20);
    const second = position(makeCard(recipe, 22, 'SECOND'), 1000);
    const read = createRunner(recipe, [first, second], url);
    const initial = read();
    position(first, -600); position(second, 300);
    const next = read();
    assert.equal(initial.items.length, 2); assert.equal(next.items.length, 2);
    const identities = value => value.items.map(item => `${item.source_id}:${item.post_url}`).sort();
    assert.deepEqual(identities(initial), identities(next));
    assert.ok(next.items[0].own_visible_text.endsWith('SECOND'));
    assert.equal(next.page_state.historical_completion_proven, false);
  });
  test(`${recipe}: offscreen endpoint and loading markers do not stop the current list`, () => {
    const end = position(el('footer', {}, ['没有更多']), 20000);
    const loading = position(el('div', { class: 'loading' }, ['加载中']), 20000);
    const out = run(recipe, [makeCard(recipe, 33, 'CURRENT'), end, loading], url);
    assert.equal(out.page_state.endpoint_hint_observed, false);
    assert.equal(out.page_state.loading, false);
    assert.equal(out.page_state.historical_completion_proven, false);
  });
  test(`${recipe}: unavailable viewport refuses extraction rather than claiming an empty complete list`, () => {
    const read = createRunner(recipe, [makeCard(recipe, 33, 'CURRENT')], url);
    read.context.innerHeight = 0;
    const out = read();
    assert.equal(out.items.length, 0);
    assert.equal(out.page_state.extraction_truncated, true);
    assert.equal(out.page_state.truncation_reason, 'viewport_unavailable');
    assert.equal(out.page_state.historical_completion_proven, false);
  });
}
test('Bilibili video pagination still reads the whole rendered page', () => {
  const old = position(el('div', { class: 'bili-video-card' }, [a('https://www.bilibili.com/video/BV1000000021', 'old page card')]), -100000);
  const current = el('div', { class: 'bili-video-card' }, [a('https://www.bilibili.com/video/BV1000000022', 'current page card')]);
  const out = run('bilibili-video', [old, current], 'https://space.bilibili.com/123456/upload/video');
  assert.equal(out.items.length, 2); assert.equal(out.page_state.windowed, false);
  assert.equal(out.page_state.collection_window, 'rendered_dom');
});
test('generic article geometry is not assumed to follow a known infinite feed', () => {
  const article = position(el('article', {}, [a('/posts/1234'), p('GENERIC_BODY')]), -100000);
  const out = run('generic-posts', [article], 'https://example.test/list');
  assert.equal(out.items.length, 1); assert.equal(out.page_state.windowed, false);
  assert.equal(out.page_state.historical_completion_proven, false);
});
const passed = cases.filter(c => c.passed).length;
const report = { suite: 'registered-infinite-feed-viewport', runtime: process.version, platform: process.platform,
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'),
  tests: cases.length, passed, failed: cases.length - passed, cases,
  liveBrowserUsed: false, externalNetworkRequests: 0, scope: 'synthetic visible DOM behavior, not real platform layout coverage' };
const out = argument('--out');
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
process.exitCode = passed === cases.length ? 0 : 1;

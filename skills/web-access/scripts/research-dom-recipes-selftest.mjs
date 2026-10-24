#!/usr/bin/env node
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { RESEARCH_DOM_RECIPES, assertResearchRecipe, buildResearchReadFunctionDeclaration } from './research-dom-recipes.mjs';

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
  getBoundingClientRect() { return { width: 400, height: 20, top: 0, left: 0, right: 400, bottom: 20 }; }
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
  return () => JSON.parse(JSON.stringify(vm.runInContext(`(${buildResearchReadFunctionDeclaration(recipe)})`, context)()));
}
function run(...args) { return createRunner(...args)(); }
const tests = [];
function test(name, fn) { fn(); tests.push(name); }
function weiboCard(id, text, extras = []) { return el('article', {}, [a(`https://weibo.com/123456/${id}`, '2026-10-14'), p(text, { class: 'detail_wbtext_a' }), ...extras]); }

test('fixed allowlist rejects caller code, selectors, object and inherited names', () => {
  assert.equal(RESEARCH_DOM_RECIPES.length, 6);
  for (const value of ['document.cookie', 'article', '__proto__', 'toString', {}, null]) assert.throws(() => assertResearchRecipe(value), { code: 'invalid_research_recipe' });
  for (const recipe of RESEARCH_DOM_RECIPES) assert.equal(typeof buildResearchReadFunctionDeclaration(recipe), 'string');
});
test('long visible body is complete, including middle and last characters', () => {
  const long = '原文起点' + '完整正文无关键词也必须保留。'.repeat(12000) + '原文终点';
  const out = run('weibo-feed', [weiboCard('AbCd123', long)]);
  assert.equal(out.items[0].own_visible_text, long);
  assert.ok(out.items[0].full_visible_text.endsWith('原文终点'));
  assert.equal(out.items[0].truncation.text_collection_truncated, false);
});
test('repost authorship is separate and original text is not keyword-filtered', () => {
  const original = el('div', { class: 'Feed_retweet_abc' }, [a('https://weibo.com/654321/Orig987', '原帖'), el('a', { class: 'head_name_x', href: '/u/654321' }, ['原作者']), p('原作者完整观点，末尾也保留。')]);
  const out = run('weibo-feed', [weiboCard('Own1234', '本人附言。', [original])]);
  assert.equal(out.items[0].source_id, 'Own1234');
  assert.equal(out.items[0].own_visible_text, '本人附言。');
  assert.equal(out.items[0].repost[0].source_id, 'Orig987');
  assert.equal(out.items[0].repost[0].author, '原作者');
  assert.ok(out.items[0].repost[0].text.includes('原作者完整观点，末尾也保留。'));
});
test('duplicate source IDs merge longer text and media', () => {
  const one = weiboCard('AbCd123', '短文', [el('img', { src: 'https://img.test/one.jpg' })]);
  const two = weiboCard('AbCd123', '完整正文加后半段', [el('img', { src: 'https://img.test/two.jpg' })]);
  const out = run('weibo-feed', [one, two]);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].duplicate_observations, 2);
  assert.equal(out.items[0].own_visible_text, '完整正文加后半段');
  assert.equal(out.items[0].media.urls.length, 2);
});
test('hidden private text, fields, storage, scripts and authentication attributes are never read', () => {
  const hidden = el('span', { hidden: '' }, [new Text('private', { forbidden: true })]);
  const nestedHidden = el('div', {}, [el('span', {}, [new Text('private', { forbidden: true })])], { display: 'none' });
  const input = el('input', { value: 'password', 'data-token': 'secret' }, [new Text('private', { forbidden: true })]);
  const script = el('script', {}, [new Text('private', { forbidden: true })]);
  const editable = el('div', { contenteditable: '' }, [new Text('private', { forbidden: true })]);
  const transparent = el('div', {}, [new Text('private', { forbidden: true })], { opacity: '0.0' });
  const skippedRendering = el('div', {}, [new Text('private', { forbidden: true })], { contentVisibility: 'hidden' });
  const out = run('weibo-feed', [weiboCard('AbCd123', '公开正文', [hidden, nestedHidden, input, script, editable, transparent, skippedRendering])]);
  assert.ok(out.items[0].full_visible_text.includes('公开正文'));
  assert.ok(!out.items[0].full_visible_text.includes('private'));
});
test('expand controls and line clamp flag visible text as needing detail', () => {
  const body = p('尚未展开的正文', { class: 'detail_wbtext_a' });
  body.style.webkitLineClamp = '3'; body.scrollHeight = 200; body.clientHeight = 60;
  const card = el('article', {}, [a('/123456/AbCd123'), body, el('button', {}, ['展开全文'])]);
  const out = run('weibo-feed', [card]);
  assert.equal(out.items[0].expansion.needed, true);
  assert.equal(out.items[0].truncation.visual_ellipsis_detected, true);
  assert.equal(out.page_state.expansion_count, 1);
});
test('image placeholders, declared gallery count and visible media gap remain explicit', () => {
  const card = weiboCard('AbCd123', '图集', [el('img', { src: 'https://img.test/photo.jpg' }), el('img', { src: 'https://img.test/placeholder.png' }), el('div', { class: 'media-count' }, ['共9张图片'])]);
  const out = run('weibo-feed', [card]);
  assert.equal(out.items[0].media.visible_image_count, 1);
  assert.equal(out.items[0].media.declared_count, 9);
  assert.equal(out.items[0].media.placeholder_count, 1);
  assert.equal(out.items[0].media.gap, true);
});
test('virtual list absence and no movement never imply history complete', () => {
  const one = run('weibo-feed', [weiboCard('AbCd123', '当前虚拟卡片')]);
  const next = run('weibo-feed', [weiboCard('ZyXw987', '替换后的虚拟卡片')]);
  assert.equal(one.items.length, 1); assert.equal(next.items.length, 1);
  assert.equal(one.page_state.completion, 'visible_dom_only');
  assert.equal(next.page_state.historical_completion_proven, false);
  assert.equal(next.page_state.endpoint_hint_observed, false);
});
test('post quotations and nested status/login/captcha content cannot become page walls or endpoints', () => {
  const out = run('weibo-feed', [weiboCard('AbCd123', '讨论验证码和登录后查看', [el('div', { role: 'status' }, ['没有更多了']), el('div', { class: 'login-panel' }, ['登录后查看']), el('div', { class: 'captcha' }, ['安全验证'])])]);
  assert.equal(out.page_state.endpoint_hint_observed, false);
  assert.deepEqual(out.page_state.login_hints, []);
  assert.deepEqual(out.page_state.verification_hints, []);
});
test('standalone visible status is only endpoint hint and loading/login/captcha are reported', () => {
  const out = run('weibo-feed', [weiboCard('AbCd123', '正文'), el('div', { role: 'status' }, ['没有更多了']), el('div', { class: 'loading' }, ['正在加载']), el('div', { class: 'login-modal' }, ['请先登录']), el('div', { id: 'captcha' }, ['安全验证'])]);
  assert.equal(out.page_state.endpoint_hint_observed, true);
  assert.equal(out.page_state.historical_completion_proven, false);
  assert.equal(out.page_state.loading, true);
  assert.deepEqual(out.page_state.login_hints, ['请先登录']);
  assert.deepEqual(out.page_state.verification_hints, ['安全验证']);
});
test('Bilibili dynamic extraction retains own body and public ID', () => {
  const card = el('div', { class: 'bili-dyn-list__item' }, [a('https://t.bilibili.com/12345678901234'), p('完整动态正文', { class: 'bili-rich-text' }), el('time', { datetime: '2026-10-14T12:00:00+08:00' }, ['今天'])]);
  const out = run('bilibili-dynamic', [card], 'https://space.bilibili.com/123456/dynamic');
  assert.equal(out.items[0].source_id, '12345678901234');
  assert.equal(out.items[0].own_visible_text, '完整动态正文');
});
test('Bilibili video pagination only comes from fixed container and supports disabled next', () => {
  const card = el('div', { class: 'bili-video-card' }, [a('https://www.bilibili.com/video/BV1000000021', '标题'), el('time', { datetime: '2026-10-14' }, ['2026-10-14'])]);
  const next = el('button', { class: 'be-pager-next' }, ['下一页']);
  const pager = el('div', { class: 'be-pager' }, [next]);
  const out = run('bilibili-video', [card, pager], 'https://space.bilibili.com/123456/upload/video');
  assert.equal(out.items[0].date, '2026-10-14');
  assert.equal(out.items[0].truncation.list_summary, true);
  assert.deepEqual(out.page_state.pagination.next, { selector: '.be-pager .be-pager-next', expected_text: '下一页', index: 0 });
  next.attrs.disabled = ''; next.disabled = true;
  const last = run('bilibili-video', [card, pager], 'https://space.bilibili.com/123456/upload/video');
  assert.equal(last.page_state.pagination.at_last_page, true);
  assert.equal(last.page_state.historical_completion_proven, false);
  const rogue = run('bilibili-video', [card, el('button', {}, ['下一页'])], 'https://space.bilibili.com/123456/upload/video');
  assert.equal(rogue.page_state.pagination.observed, false);
});
test('Douyin list text remains full visible text and never derives date from ID', () => {
  const out = run('douyin-posts', [el('li', {}, [a('/video/7532432199876543210'), p('超过九十五字的完整标题'.repeat(40))])], 'https://www.douyin.com/user/public-user');
  assert.ok(out.items[0].own_visible_text.length > 95);
  assert.equal(out.items[0].date, null);
  assert.equal(out.items[0].truncation.needs_detail, true);
});
test('Xiaohongshu list covers do not masquerade as note body or full gallery', () => {
  const id = '6a575c8a000000002103cca9';
  const out = run('xiaohongshu-notes', [el('section', { class: 'note-item' }, [a(`/explore/${id}?xsec_token=private-signature`), p('可见标题', { class: 'title' }), el('img', { src: 'https://img.test/cover.jpg' })])], 'https://www.xiaohongshu.com/user/profile/5f5140b50000000001004d8b');
  assert.equal(out.items[0].source_id, id);
  assert.equal(out.items[0].media.items[0].kind, 'cover');
  assert.equal(out.items[0].media.requires_detail, true);
  assert.equal(out.items[0].truncation.list_summary, true);
});
test('host mismatch is rejected and empty DOM is not account absence', () => {
  const mismatch = run('weibo-feed', [weiboCard('AbCd123', '正文')], 'https://evil.test/');
  assert.equal(mismatch.items.length, 0);
  assert.equal(mismatch.page_state.route_matches_recipe, false);
  const empty = run('weibo-feed', []);
  assert.equal(empty.page_state.historical_completion_proven, false);
  assert.ok(empty.page_state.warnings.some(value => value.includes('not proof of no posts')));
});
test('generic article supports full body and quoted attribution without invoking any page code', () => {
  const out = run('generic-posts', [el('article', {}, [a('/posts/public-123'), p('本人正文'), el('blockquote', {}, [a('/posts/original-456'), p('引用正文')])])], 'https://example.test/profile');
  assert.equal(out.items[0].source_id, 'public-123');
  assert.equal(out.items[0].own_visible_text, '本人正文');
  assert.equal(out.items[0].repost[0].source_id, 'original-456');
});
test('known visible cards without source links are retained as unresolved instead of silently dropped', () => {
  const out = run('weibo-feed', [el('article', {}, [p('链接尚未加载，公开正文仍需保留')])]);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].source_id, null);
  assert.equal(out.items[0].stable_deduplication, false);
  assert.equal(out.page_state.unresolved_source_count, 1);
  const generic = run('generic-posts', [el('article', {}, [a('/people/writer', '作者'), p('无固定链接的可见文章')])], 'https://example.test/list');
  assert.equal(generic.items.length, 1);
  assert.equal(generic.items[0].post_url, null, 'author URL must not become source URL');
});
test('detail page identity takes precedence over linked related posts and retains full visible body', () => {
  const longDescription = '视频说明全文'.repeat(100);
  const out = run('bilibili-video', [el('main', {}, [a('/video/BVRelated123', '关联作品'), el('h1', {}, ['本条标题']), p(longDescription)])], 'https://www.bilibili.com/video/BV1000000021');
  assert.equal(out.items[0].source_id, 'BV1000000021');
  assert.ok(out.items[0].own_visible_text.endsWith(longDescription));
  assert.equal(out.items[0].card_kind, 'post_detail');
});
test('large extraction budget explicitly marks truncation rather than claiming complete body', () => {
  const out = run('weibo-feed', [weiboCard('Budget123', '长'.repeat(4000100))]);
  assert.equal(out.items[0].truncation.text_collection_truncated, true);
  assert.equal(out.page_state.extraction_truncated, true);
  assert.equal(out.page_state.historical_completion_proven, false);
});
test('visible image emojis retain alt text in the body without becoming post-media images', () => {
  const out = run('weibo-feed', [el('article', {}, [a('/123456/Emoji123'), el('p', { class: 'detail_wbtext_x' }, ['本人态度', el('img', { class: 'emoji', alt: '[doge]', src: 'https://img.test/emoji/doge.png' }), '正文结束'])])]);
  assert.equal(out.items[0].own_visible_text, '本人态度[doge]正文结束');
  assert.equal(out.items[0].media.visible_image_count, 0);
});
test('Bilibili retained old cards cannot consume the current window text budget', () => {
  const old = Array.from({ length: 750 }, () => {
    const card = el('div', { class: 'bili-dyn-item' }, [p('old '.repeat(10000), { class: 'bili-rich-text' })]);
    card.getBoundingClientRect = () => ({ width: 400, height: 100, top: -100000, bottom: -99900, left: 0, right: 400 });
    return card;
  });
  const current = el('div', { class: 'bili-dyn-item' }, [el('span', { class: 'bili-dyn-title__text' }, ['作者']), el('span', { class: 'bili-dyn-time' }, ['2023年10月27日']), p('NEW '.repeat(400) + 'END_MARKER', { class: 'bili-rich-text' })]);
  const out = run('bilibili-dynamic', [...old, current], 'https://space.bilibili.com/123456/dynamic');
  assert.equal(out.page_state.rendered_card_count, 751);
  assert.equal(out.page_state.visible_card_count, 1);
  assert.equal(out.page_state.collection_window, 'viewport_plus_one_screen');
  assert.equal(out.page_state.extraction_truncated, false);
  assert.ok(out.items[0].own_visible_text.endsWith('END_MARKER'));
  assert.equal(out.items[0].author, '作者');
  assert.equal(out.items[0].date, '2023年10月27日');
});
test('one oversized card is flagged without blanking subsequent card metadata or text', () => {
  const huge = el('div', { class: 'bili-dyn-item' }, [p('字'.repeat(1100000), { class: 'bili-rich-text' })]);
  const tail = el('div', { class: 'bili-dyn-item' }, [el('span', { class: 'bili-dyn-title__text' }, ['作者']), el('span', { class: 'bili-dyn-time' }, ['2023年10月27日']), p('完整尾卡', { class: 'bili-rich-text' })]);
  const out = run('bilibili-dynamic', [huge, tail], 'https://space.bilibili.com/123456/dynamic');
  assert.equal(out.page_state.extraction_truncated, true);
  assert.equal(out.page_state.truncation_reason, 'card_budget');
  assert.equal(out.items[1].own_visible_text, '完整尾卡');
  assert.equal(out.items[1].date, '2023年10月27日');
});
test('snapshot budget stops before inventing empty records for unvisited cards', () => {
  const cards = Array.from({ length: 8 }, () => el('div', { class: 'bili-dyn-item' }, [p('字'.repeat(1100000), { class: 'bili-rich-text' })]));
  const out = run('bilibili-dynamic', cards, 'https://space.bilibili.com/123456/dynamic');
  assert.equal(out.page_state.extraction_truncated, true);
  assert.equal(out.page_state.truncation_reason, 'snapshot_budget');
  assert.ok(out.items.length < cards.length);
});
test('Bilibili endpoint or loading controls outside the viewport do not stop current cards', () => {
  const end = el('footer', {}, ['没有更多']);
  const loading = el('div', { class: 'loading' }, ['加载中']);
  for (const node of [end, loading]) node.getBoundingClientRect = () => ({ width: 400, height: 20, left: 0, right: 400, top: 20000, bottom: 20020 });
  const card = el('div', { class: 'bili-dyn-item' }, [p('当前正文', { class: 'bili-rich-text' })]);
  const out = run('bilibili-dynamic', [card, end, loading], 'https://space.bilibili.com/123456/dynamic');
  assert.equal(out.page_state.loading, false);
  assert.equal(out.page_state.endpoint_hint_observed, false);
});
test('Bilibili orig content is the current author body, not automatically a repost', () => {
  const card = el('div', { class: 'bili-dyn-item' }, [
    el('span', { class: 'bili-dyn-title__text' }, ['飞傲FiiO']),
    el('div', { class: 'bili-dyn-time' }, ['2023年10月27日']),
    el('button', {}, ['关注']),
    el('div', { class: 'bili-dyn-content__orig' }, [el('span', {}, ['LS-4.4B现已开售，售价为99元！'])]),
    el('footer', {}, ['转发 评论 13']),
  ]);
  const out = run('bilibili-dynamic', [card], 'https://space.bilibili.com/319623712/search/dynamic?keyword=LS-4.4B');
  assert.equal(out.items[0].author, '飞傲FiiO');
  assert.equal(out.items[0].own_visible_text, 'LS-4.4B现已开售，售价为99元！');
  assert.equal(out.items[0].repost.length, 0);
});

test('Bilibili span full-text control marks a quoted article incomplete', () => {
  const quote = el('div', { class: 'bili-dyn-content__orig reference' }, [
    el('div', { class: 'bili-dyn-content__orig__author' }, [
      el('span', {}, ['原作者']), el('span', {}, ['投稿了文章']),
    ]),
    p('文章摘要...'), el('span', {}, ['全文']),
  ]);
  const card = el('div', { class: 'bili-dyn-item' }, [
    el('span', { class: 'bili-dyn-title__text' }, ['转发者']),
    p('本人附言', { class: 'bili-rich-text' }), quote,
  ]);
  const out = run('bilibili-dynamic', [card], 'https://space.bilibili.com/319623712/dynamic');
  assert.equal(out.items[0].own_visible_text, '本人附言');
  assert.equal(out.items[0].repost.length, 1);
  assert.equal(out.items[0].author, '转发者');
  assert.equal(out.items[0].repost[0].author, '原作者');
  assert.ok(out.items[0].repost[0].text.includes('文章摘要...'));
  assert.equal(out.items[0].expansion.needed, true);
  assert.equal(out.items[0].truncation.needs_detail, true);
});

test('Bilibili public face CDN avatar is excluded while article images remain', () => {
  const avatar = el('img', { src: 'https://i1.hdslb.com/bfs/face/avatar.jpg@40w_40h.webp' });
  avatar.getBoundingClientRect = () => ({width:40,height:40,left:0,top:0,right:40,bottom:40});
  const out = run('bilibili-dynamic', [el('div', { class: 'bili-dyn-item' }, [
    p('本人正文', { class: 'bili-rich-text' }),
    avatar,
    el('img', { src: 'https://i1.hdslb.com/bfs/article/poster.jpg' }),
    el('img', { src: 'https://i1.hdslb.com/bfs/face/full-size-portrait.jpg' }),
  ])], 'https://space.bilibili.com/319623712/dynamic');
  assert.equal(out.items[0].media.visible_image_count, 2);
  assert.ok(out.items[0].media.items[0].url.includes('/bfs/article/'));
});
test('Bilibili DOM observation survives lazy media but not recycled content or distinct cards', () => {
  const body = el('span',{},['同一正文']);
  const card = el('div',{class:'bili-dyn-item'},[
    el('span',{class:'bili-dyn-title__text'},['作者']),el('div',{class:'bili-dyn-time'},['2023年10月27日']),
    el('div',{class:'bili-dyn-content__orig'},[body]),
  ]);
  const read = createRunner('bilibili-dynamic',[card],'https://space.bilibili.com/319623712/search?keyword=LS-4.4B');
  const first=read().items[0].dom_observation_id;
  const image=card.append(el('img',{src:'https://i1.hdslb.com/bfs/new_dyn/one.jpg'}));
  assert.equal(read().items[0].dom_observation_id,first);
  image.attrs.src='https://i1.hdslb.com/bfs/new_dyn/different.jpg';
  const replaced=read().items[0].dom_observation_id;
  assert.notEqual(replaced,first);
  body.childNodes[0].value='回收节点换了正文';
  assert.notEqual(read().items[0].dom_observation_id,replaced);
  const other=run('bilibili-dynamic',[card],'https://space.bilibili.com/319623712/search?keyword=LS-4.4B');
  assert.notEqual(other.items[0].dom_observation_id,first,'new isolated world cannot reuse old observation identity');
});
test('X photo readiness uses visible photo-page source images, with loaded/broken/pending states', () => {
  const image=(name,complete,width,style={})=>Object.assign(el('img',{src:`https://pbs.twimg.com/media/${name}.jpg`},[],style),{complete,naturalWidth:width,naturalHeight:width?600:0});
  const ready=image('ready',true,800), broken=image('broken',true,0), pending=image('pending',false,0);
  const hidden=image('hidden',true,800,{display:'none'}), background=image('background',true,800,{display:'none'});
  const avatar=Object.assign(el('img',{src:'https://pbs.twimg.com/profile_images/avatar.jpg'}),{complete:true,naturalWidth:100,naturalHeight:100});
  const out=run('generic-posts',[background,el('div',{role:'dialog'},[ready,broken,pending,hidden,avatar])],'https://x.com/example/status/1234567890123456789/photo/1');
  const state=out.page_state.photo_readiness;
  assert.equal(state.version,1); assert.equal(state.items.length,3); assert.equal(state.truncated,false);
  assert.equal(state.items[0].imageState.naturalWidth,800);
  assert.equal(state.items[1].imageState.naturalWidth,0);
  assert.equal(state.items[2].imageState.complete,false);
  assert.equal(state.visual_review_required,true);
});
test('X photo readiness is route bound and caps candidate inspection', () => {
  const images=Array.from({length:2001},(_,i)=>Object.assign(el('img',{src:`https://pbs.twimg.com/media/${i}.jpg`}),{complete:true,naturalWidth:10,naturalHeight:10}));
  const modal=el('div',{role:'dialog'},images);
  const out=run('generic-posts',[modal],'https://x.com/example/status/1234567890123456789/photo/2');
  assert.equal(out.page_state.photo_readiness.items.length,1999);
  assert.equal(out.page_state.photo_readiness.truncated,true);
  assert.equal(run('generic-posts',[modal],'https://example.test/example/status/1234567890123456789/photo/2').page_state.photo_readiness,undefined);
});
test('X visible CSS image outside the dialog requires a matching loaded backing image', () => {
  const url='https://pbs.twimg.com/media/public.jpg';
  const bitmap=Object.assign(el('img',{src:url},[],{opacity:'0'}),{complete:true,naturalWidth:1600,naturalHeight:2400});
  const visible=el('div',{},[],{backgroundImage:`url("${url}")`});
  const absent=el('div',{},[],{backgroundImage:'url("https://pbs.twimg.com/media/unloaded.jpg")'});
  const modal=el('div',{},[el('div',{},[visible,bitmap,absent])]);
  const state=run('generic-posts',[modal],'https://x.com/example/status/1234567890123456789/photo/1').page_state.photo_readiness;
  assert.equal(state.items.length,2);
  assert.equal(state.items[0].representation,'visible_css_background');
  assert.equal(state.items[0].imageState.naturalWidth,1600);
  assert.equal(state.items[1].imageState.complete,false);
});
console.log(`research DOM recipes: ${tests.length}/${tests.length} passed`);
for (const name of tests) console.log(`  PASS ${name}`);

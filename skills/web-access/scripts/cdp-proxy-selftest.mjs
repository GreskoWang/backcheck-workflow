#!/usr/bin/env node

import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  BrokerError,
  DOM_QUERY_FUNCTION,
  MAX_ACTIVE_TASK_PAGES,
  acquireLease,
  activeTaskPageCount,
  assertCdpMethodAllowed,
  deadlineAfter,
  isHeavySpa,
  queueForTarget,
  requireLease,
  sanitizePublicUrl,
  validateDomQuery,
  validateBrowserWsUrl,
  validateOwner,
  validateSelector,
} from './cdp-proxy.mjs';

function expectCode(fn, code) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof BrokerError, `expected BrokerError ${code}`);
  assert.equal(caught.code, code);
}

assert.equal(validateBrowserWsUrl('ws://127.0.0.1:9222/devtools/browser/x'), 'ws://127.0.0.1:9222/devtools/browser/x');
assert.equal(validateBrowserWsUrl('ws://localhost:9222/devtools/browser/x', 9222), 'ws://127.0.0.1:9222/devtools/browser/x');
expectCode(() => validateBrowserWsUrl('wss://example.com/devtools/browser/x'), 'unsafe_browser_endpoint');
expectCode(() => validateBrowserWsUrl('ws://192.168.1.9:9222/devtools/browser/x'), 'unsafe_browser_endpoint');
for (const endpoint of [
  'ws://127.0.0.1:9223/devtools/browser/x',
  'ws://127.0.0.1:9222/devtools/page/x',
  'ws://127.0.0.1:9222/devtools/browser/x?source=other',
  'ws://127.0.0.1:9222/devtools/browser/x#fragment',
  'ws://user:password@127.0.0.1:9222/devtools/browser/x',
]) expectCode(() => validateBrowserWsUrl(endpoint, 9222), 'unsafe_browser_endpoint');

assert.equal(validateOwner('thread-1:youtube'), 'thread-1:youtube');
expectCode(() => validateOwner('owner with spaces'), 'owner_required');

const lease = acquireLease('selftest-target', 'owner-a');
assert.equal(requireLease('selftest-target', 'owner-a', lease.token).owner, 'owner-a');
expectCode(() => acquireLease('selftest-target', 'owner-b'), 'lease_conflict');
expectCode(() => requireLease('selftest-target', 'owner-b', lease.token), 'lease_conflict');
expectCode(() => requireLease('selftest-target', 'owner-a', 'wrong-capability-token-000000'), 'lease_conflict');
lease.lastUsedAt = 0;
expectCode(() => requireLease('selftest-target', 'owner-a', lease.token), 'lease_expired');

assert.equal(MAX_ACTIVE_TASK_PAGES, 5);
const capacityLeases = Array.from({ length: MAX_ACTIVE_TASK_PAGES - 1 }, (_, index) => acquireLease(`capacity-target-${index}`, `owner-${index}`));
assert.equal(activeTaskPageCount(), MAX_ACTIVE_TASK_PAGES);
expectCode(() => acquireLease('capacity-target-overflow', 'owner-overflow'), 'task_page_limit_reached');
for (const capacityLease of capacityLeases) capacityLease.lastUsedAt = 0;

assertCdpMethodAllowed('Runtime.callFunctionOn');
expectCode(() => assertCdpMethodAllowed('Network.getAllCookies'), 'cdp_method_not_allowed');
expectCode(() => assertCdpMethodAllowed('Fetch.enable'), 'cdp_method_not_allowed');

assert.equal(validateSelector('ytd-video-renderer a#video-title[href]'), 'ytd-video-renderer a#video-title[href]');
for (const selector of ['input[value^="a"]', 'a[href*="access_token"]', 'meta[content^="eyJ"]', '\\76 alue', 'div:has(input)', '[data-token]']) {
  expectCode(() => validateSelector(selector), 'unsafe_selector');
}
assert.deepEqual(validateDomQuery({ kind: 'document' }), { kind: 'document' });
assert.deepEqual(validateDomQuery({ kind: 'text', selector: 'main', maxChars: 100 }), { kind: 'text', selector: 'main', visibility: 'rendered', maxChars: 100 });
assert.equal(validateDomQuery({ kind: 'elements', selector: 'a[href]', fields: ['text', 'href'] }).limit, 30);
for (const [query, code] of [
  [{ kind: 'text', selector: 'main', expression: 'document.cookie' }, 'unknown_query_field'],
  [JSON.parse('{"kind":"document","__proto__":{"polluted":true}}'), 'unknown_query_field'],
  [{ kind: 'document', constructor: 'bad' }, 'unknown_query_field'],
  [{ kind: 'elements', selector: 'a', fields: ['value'] }, 'invalid_element_fields'],
  [{ kind: 'elements', selector: 'a', fields: ['id'] }, 'invalid_element_fields'],
  [{ kind: 'elements', selector: 'a', fields: ['name'] }, 'invalid_element_fields'],
  [{ kind: 'elements', selector: 'a', limit: 51 }, 'invalid_element_limit'],
  [{ kind: 'text', selector: 'main', maxChars: 16001 }, 'invalid_max_chars'],
]) expectCode(() => validateDomQuery(query), code);

class MockElement {}
const sensitiveElement = new MockElement();
Object.assign(sensitiveElement, {
  tagName: 'DIV', isContentEditable: false, hidden: false, parentElement: null,
  getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
  getAttribute: (name) => name === 'title' ? 'Authorization=Bearer opaque-value' : name === 'aria-hidden' ? null : null,
});
const domQuery = vm.runInNewContext(`(${DOM_QUERY_FUNCTION})`, {
  URL, Element: MockElement, NodeFilter: { SHOW_TEXT: 4 }, innerHeight: 100, innerWidth: 100,
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  document: { baseURI: 'https://example.test/', querySelectorAll: () => [sensitiveElement] },
});
assert.equal(domQuery({ kind: 'elements', selector: 'div', visibility: 'rendered', limit: 1, fields: ['title'] }).items[0].title, null);

assert.equal(sanitizePublicUrl('https://www.youtube.com/watch?v=abc&access_token=secret#fragment'), 'https://www.youtube.com/watch?v=abc');
assert.equal(sanitizePublicUrl('https://example.test/search?q=oncology+results&id=0123456789abcdef0123456789abcdef'), 'https://example.test/search');
assert.equal(sanitizePublicUrl('https://example.test/share/0123456789abcdef0123456789abcdef'), 'https://example.test/share/[redacted]');
assert.equal(sanitizePublicUrl('https://example.test/share/token%3Dsecret-value'), 'https://example.test/share/[redacted]');

const xhsPublicId = '6a575c8a000000002103cca9';
const xhsPublicUser = '5f5140b50000000001004d8b';
const xhsPublicRoutes = [
  `/explore/${xhsPublicId}`,
  `/discovery/item/${xhsPublicId}`,
  `/user/profile/${xhsPublicUser}`,
  `/user/profile/${xhsPublicUser}/${xhsPublicId}`,
];
for (const host of ['xiaohongshu.com', 'www.xiaohongshu.com']) {
  for (const route of xhsPublicRoutes) {
    const expected = `https://${host}${route}`;
    assert.equal(sanitizePublicUrl(`${expected}?xsec_token=secret&access_token=secret#fragment`), expected);
  }
}
const xhsPrivateOrUnknownRoutes = [
  `https://evil.xiaohongshu.com/explore/${xhsPublicId}`,
  `https://www.xiaohongshu.com.evil.test/explore/${xhsPublicId}`,
  `https://www.xiaohongshu.com:8443/explore/${xhsPublicId}`,
  `http://www.xiaohongshu.com/explore/${xhsPublicId}`,
  `https://www.xiaohongshu.com/oauth/${xhsPublicId}`,
  `https://www.xiaohongshu.com/EXPLORE/${xhsPublicId}`,
  `https://www.xiaohongshu.com/explore/${xhsPublicId}/auth`,
  `https://www.xiaohongshu.com/user/profile/${xhsPublicUser}/token`,
  'https://www.xiaohongshu.com/explore/0123456789abcdef0123456789abcdef',
];
for (const raw of xhsPrivateOrUnknownRoutes) assert.ok(sanitizePublicUrl(raw).includes('[redacted]'), raw);

const publicAnchor = new MockElement();
Object.assign(publicAnchor, {
  tagName: 'A', isContentEditable: false, hidden: false, parentElement: null,
  getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
  getAttribute: (name) => name === 'href' ? `/user/profile/${xhsPublicUser}/${xhsPublicId}?xsec_token=secret` : null,
});
const xhsDomQuery = vm.runInNewContext(`(${DOM_QUERY_FUNCTION})`, {
  URL, Element: MockElement, NodeFilter: { SHOW_TEXT: 4 }, innerHeight: 100, innerWidth: 100,
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  document: { baseURI: 'https://www.xiaohongshu.com/', querySelectorAll: () => [publicAnchor] },
});
assert.equal(xhsDomQuery({ kind: 'elements', selector: 'a', visibility: 'rendered', limit: 1, fields: ['href'] }).items[0].href,
  `https://www.xiaohongshu.com/user/profile/${xhsPublicUser}/${xhsPublicId}`);
for (const host of ['xiaohongshu.com', 'www.xiaohongshu.com']) {
  for (const route of xhsPublicRoutes) {
    const expected = `https://${host}${route}`;
    publicAnchor.getAttribute = name => name === 'href' ? `${expected}?xsec_token=secret&access_token=secret#fragment` : null;
    assert.equal(xhsDomQuery({ kind: 'elements', selector: 'a', visibility: 'rendered', limit: 1, fields: ['href'] }).items[0].href, expected);
  }
}
for (const raw of xhsPrivateOrUnknownRoutes) {
  publicAnchor.getAttribute = name => name === 'href' ? raw : null;
  const href = xhsDomQuery({ kind: 'elements', selector: 'a', visibility: 'rendered', limit: 1, fields: ['href'] }).items[0].href;
  assert.ok(href.includes('[redacted]'), raw);
}

// Reproduce public identity/search locators lost by the former YouTube-only
// query allowlist. DOM links and broker responses must use the same registry.
const publicQueryRoutes = [
  ['https://pbs.twimg.com/media/EXAMPLEpublicPhoto?format=jpg&name=large&token=secret', 'https://pbs.twimg.com/media/EXAMPLEpublicPhoto?format=jpg&name=large'],
  ['https://pbs.twimg.com/media/EXAMPLEpublicPhoto?format=secret&name=token', 'https://pbs.twimg.com/media/EXAMPLEpublicPhoto'],
  ['https://pbs.twimg.com/auth/EXAMPLEpublicPhoto?format=jpg&name=large', 'https://pbs.twimg.com/[redacted]/EXAMPLEpublicPhoto'],
  ['https://pbs.twimg.com.evil.test/media/EXAMPLEpublicPhoto?format=jpg', 'https://pbs.twimg.com.evil.test/media/EXAMPLEpublicPhoto'],
  ['https://www.youtube.com/post/UgkxEXAMPLEpublicCommunityPost123456789?token=secret', 'https://www.youtube.com/post/UgkxEXAMPLEpublicCommunityPost123456789'],
  ['https://www.youtube.com/auth/UgkxEXAMPLEpublicCommunityPost123456789', 'https://www.youtube.com/[redacted]/[redacted]'],
  ['https://www.youtube.com.evil.test/post/UgkxEXAMPLEpublicCommunityPost123456789', 'https://www.youtube.com.evil.test/post/[redacted]'],
  ['https://space.bilibili.com/319623712/search?keyword=LS-4.4B&token=secret', 'https://space.bilibili.com/319623712/search?keyword=LS-4.4B'],
  ['https://space.bilibili.com/319623712/search/dynamic?keyword=LS-4.4B&session=secret', 'https://space.bilibili.com/319623712/search/dynamic?keyword=LS-4.4B'],
  ['https://space.bilibili.com/319623712/search?keyword=token%3Dsecret', 'https://space.bilibili.com/319623712/search'],
  ['https://space.bilibili.com/319623712/search?keyword=0123456789abcdef0123456789abcdef', 'https://space.bilibili.com/319623712/search'],
  ['https://space.bilibili.com/319623712/oauth?keyword=LS-4.4B', 'https://space.bilibili.com/319623712/oauth'],
  ['https://space.bilibili.com.evil.test/319623712/search?keyword=LS-4.4B', 'https://space.bilibili.com.evil.test/319623712/search'],
  ['https://space.bilibili.com:8443/319623712/search?keyword=LS-4.4B', 'https://space.bilibili.com:8443/319623712/search'],
  ['https://www.facebook.com/profile.php?id=100012345678901&access_token=secret#fragment', 'https://www.facebook.com/profile.php?id=100012345678901'],
  ['https://m.facebook.com/permalink.php?story_fbid=123456789012345&id=100012345678901&fbclid=tracking', 'https://m.facebook.com/permalink.php?story_fbid=123456789012345&id=100012345678901'],
  ['https://www.facebook.com/photo.php?fbid=123456789012345&token=secret', 'https://www.facebook.com/photo.php?fbid=123456789012345'],
  ['https://www.facebook.com/watch/?v=123456789012345', 'https://www.facebook.com/watch/?v=123456789012345'],
  ['https://x.com/search?q=%E8%A8%80%E9%85%B1&f=live&src=typed_query&auth=secret', 'https://x.com/search?q=%E8%A8%80%E9%85%B1&f=live'],
  ['https://www.instagram.com/explore/search/keyword/?q=%E9%85%8D%E9%9F%B3&session=secret', 'https://www.instagram.com/explore/search/keyword/?q=%E9%85%8D%E9%9F%B3'],
  ['https://www.skland.com/article?id=3555659&token=secret', 'https://www.skland.com/article?id=3555659'],
  ['https://www.youtube.com/results?search_query=voice+actor&token=secret', 'https://www.youtube.com/results?search_query=voice+actor'],
  ['https://www.facebook.com/profile.php?id=token%3Dsecret', 'https://www.facebook.com/profile.php'],
  ['https://www.facebook.com/profile.php?id=0123456789abcdef0123456789abcdef', 'https://www.facebook.com/profile.php'],
  ['https://evil.facebook.com/profile.php?id=123', 'https://evil.facebook.com/profile.php'],
  ['https://www.facebook.com.evil.test/profile.php?id=123', 'https://www.facebook.com.evil.test/profile.php'],
  ['https://www.facebook.com/oauth?id=123', 'https://www.facebook.com/oauth'],
  ['https://www.facebook.com:8443/profile.php?id=123', 'https://www.facebook.com:8443/profile.php'],
  ['https://x.com/oauth?q=public', 'https://x.com/oauth'],
];
for (const [raw, expected] of publicQueryRoutes) {
  assert.equal(sanitizePublicUrl(raw), expected);
  publicAnchor.getAttribute = name => name === 'href' ? raw : null;
  assert.equal(xhsDomQuery({ kind: 'elements', selector: 'a', visibility: 'rendered', limit: 1, fields: ['href'] }).items[0].href, expected);
}

assert.equal(isHeavySpa('https://www.youtube.com/watch?v=x'), true);
assert.equal(isHeavySpa('https://example.com/'), false);

const order = [];
let active = 0;
let maxActive = 0;
const sameTarget = [1, 2, 3].map((number) => queueForTarget('queue-target', deadlineAfter(2000), async () => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  order.push(`start-${number}`);
  await new Promise((resolve) => setTimeout(resolve, 15));
  order.push(`end-${number}`);
  active -= 1;
}));
await Promise.all(sameTarget);
assert.equal(maxActive, 1);
assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);

active = 0;
maxActive = 0;
await Promise.all(['a', 'b'].map((target) => queueForTarget(`parallel-${target}`, deadlineAfter(2000), async () => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise((resolve) => setTimeout(resolve, 25));
  active -= 1;
})));
assert.equal(maxActive, 2);

const stalledHead = queueForTarget('blocked-target', deadlineAfter(80), () => new Promise(() => {}));
await assert.rejects(
  queueForTarget('blocked-target', deadlineAfter(30), async () => true),
  (error) => error instanceof BrokerError && error.code === 'request_timeout',
);
await assert.rejects(stalledHead, (error) => error instanceof BrokerError && error.code === 'target_lane_stalled');
await assert.rejects(
  queueForTarget('blocked-target', deadlineAfter(100), async () => true),
  (error) => error instanceof BrokerError && error.code === 'target_lane_stalled',
);

console.log('cdp-proxy self-test: security, lease, timeout, and queue checks passed');

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CLICK_FUNCTION } from './cdp-proxy.mjs';

class Element {
  constructor(text, options = {}) {
    Object.assign(this, { innerText: text, tagName: 'P', parentElement: null, hidden: false,
      isContentEditable: false, style: {}, rect: { x: 20, y: 20, width: 150, height: 30 }, clicks: 0, scrolls: 0 }, options);
  }
  getAttribute(name) { return this[name] ?? null; }
  getBoundingClientRect() { return this.rect; }
  scrollIntoView() { this.scrolls++; this.rect = { ...this.rect, y: 20 }; }
  contains(node) { return node === this; }
  click() { this.clicks++; }
}
function fixture(nodes, { occluded = false } = {}) {
  return vm.runInNewContext(`(${CLICK_FUNCTION})`, {
    Element, URL, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: element => ({ display: 'block', visibility: 'visible', opacity: '1', ...element.style }),
    document: { baseURI: 'https://www.douyin.com/search/example', querySelectorAll: () => nodes,
      elementFromPoint: () => occluded ? new Element('overlay') : nodes.find(node => node.scrolls) },
  });
}
// Responsive pages retain an invisible copy before the visible search result.
for (const hiddenOptions of [{ hidden: true }, { 'aria-hidden': 'true' }, { style: { display: 'none' } },
  { style: { visibility: 'hidden' } }, { style: { opacity: '0' } },
  { parentElement: new Element('hidden parent', { hidden: true }) },
  { rect: { x: 0, y: 0, width: 0, height: 0 } }]) {
  const hidden = new Element('hidden account', hiddenOptions);
  const visible = new Element('visible account');
  assert.equal(fixture([hidden, visible])('a > p', true).text, 'visible account');
  assert.equal(hidden.clicks + hidden.scrolls, 0);
  assert.equal(visible.clicks, 1);
}
const earlier = new Element('earlier post', { rect: { x: 0, y: 1400, width: 120, height: 20 } });
const current = new Element('current post');
assert.equal(fixture([earlier, current])('p', false).text, 'current post');
assert.equal(earlier.scrolls, 0);
assert.equal(current.clicks, 0, 'locating must not activate the element');
const outside = new Element('offscreen only', { rect: { x: 0, y: 1400, width: 120, height: 20 } });
assert.equal(fixture([outside])('p', true).text, 'offscreen only');
assert.equal(outside.clicks, 1);
const covered = new Element('covered');
assert.equal(fixture([covered], { occluded: true })('p', true).error, 'occluded');
assert.equal(covered.clicks, 0);
for (const options of [{ tagName: 'INPUT' }, { isContentEditable: true },
  { parentElement: new Element('editable parent', { isContentEditable: true }) }]) {
  const blocked = new Element('blocked', options);
  assert.equal(fixture([blocked])('p', true).error, 'not_visible');
  assert.equal(blocked.clicks + blocked.scrolls, 0);
}
assert.equal(fixture([])('p', true).error, 'not_found');
const link = new Element('profile', { tagName: 'A', target: '_blank', href: '/user/public-account' });
const label = new Element('profile label', { parentElement: link });
assert.equal(fixture([label])('a > p', true).navigationUrl, 'https://www.douyin.com/user/public-account');
assert.equal(label.clicks + link.clicks, 0, 'a new-tab link must not spawn an unleased popup');
for (const href of [null, '', 'javascript:alert(1)', 'file:///C:/private', 'https://user:password@example.test/']) {
  const unsafe = new Element('unsafe', { tagName: 'A', target: '_blank', href });
  assert.equal(fixture([unsafe])('a', true).error, 'unsupported_link');
  assert.equal(unsafe.clicks, 0);
}
console.log('click regression tests passed: hidden clones, ancestor visibility, viewport selection, offscreen fallback, occlusion, editable exclusions and same-page public-link following');

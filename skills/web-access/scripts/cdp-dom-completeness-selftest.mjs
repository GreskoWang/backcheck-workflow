// Offline public-DOM fixtures only; imports never start the broker.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DOM_QUERY_FUNCTION } from './cdp-proxy.mjs';

class Element {
  constructor() { this.tagName = 'ARTICLE'; this.parentElement = null; }
  getAttribute() { return null; }
  getBoundingClientRect() { return { width: 300, height: 100, left: 0, top: 0, right: 300, bottom: 100 }; }
}
function fixture(texts) {
  const root = new Element();
  const document = { baseURI: 'https://example.test/', querySelector: () => root, querySelectorAll: () => [root],
    createTreeWalker: () => { let i = 0; return { nextNode: () => i < texts.length ? { parentElement: root, nodeValue: texts[i++] } : null }; } };
  Object.defineProperty(document, 'cookie', { get() { throw Error('private content must not be read'); } });
  return vm.runInNewContext(`(${DOM_QUERY_FUNCTION})`, { document, Element, URL, NodeFilter: { SHOW_TEXT: 4 },
    innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
}
const elements = { kind: 'elements', selector: 'article', visibility: 'rendered', limit: 5, fields: ['text'] };
const read = fixture(['START ' + 'x'.repeat(1500) + ' END_MARKER']);
const short = read(elements);
assert.equal(short.items[0].text.length, 1000);
assert.equal(short.items[0].text_truncated, true);
assert.equal(short.truncated, true);
const full = read({ kind: 'text', selector: 'article', visibility: 'rendered', maxChars: 2000 });
assert.equal(full.truncated, false);
assert.ok(full.text.endsWith('END_MARKER'));
const manyNodes = fixture(Array.from({ length: 201 }, () => '字'))(elements);
assert.equal(manyNodes.items[0].text_truncated, true);
assert.equal(manyNodes.truncated, true);
const brief = fixture(['完整短文'])(elements);
assert.equal(brief.items[0].text_truncated, false);
assert.equal(brief.truncated, false);
assert.equal(brief.items[0].text, '完整短文');
console.log('DOM completeness PASS: character limit, node limit, bounded full text and complete short text');

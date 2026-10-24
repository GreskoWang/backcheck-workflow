import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BrokerError, SCROLL_FUNCTION, scrollPositionUnlocked, validateSelector } from './cdp-proxy.mjs';

function fixture({ inner = true, end = false, hidden = false, editable = false } = {}) {
  const root = { scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 900 };
  const pane = {
    tagName: 'DIV', parentElement: root, scrollTop: end ? 1500 : 0, scrollLeft: 0,
    scrollHeight: 2100, clientHeight: 600, hidden, isContentEditable: editable,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 700, height: 600 }),
    scrollTo: ({ top }) => { pane.scrollTop = top; },
  };
  const leaf = {
    tagName: 'P', parentElement: pane, scrollHeight: 100, clientHeight: 100,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 600, height: 100 }),
  };
  const run = vm.runInNewContext(`(${SCROLL_FUNCTION})`, {
    innerWidth: 1900, innerHeight: 900, scrollX: 0,
    document: { scrollingElement: root, documentElement: root, elementFromPoint: () => inner ? leaf : root },
    getComputedStyle: el => ({ overflowY: el === pane ? 'auto' : 'visible', display: 'block', visibility: 'visible', opacity: '1' }),
    window: { scrollTo: ({ top }) => { root.scrollTop = top; } },
  });
  return { root, pane, run };
}
const nested = fixture();
assert.equal(nested.run('down', 650).y, 650);
assert.equal(nested.root.scrollTop, 0, 'nested content must move without scrolling the window');
assert.equal(nested.run('up', 300).y, 350);
const bottom = nested.run('down', 5000);
assert.equal(bottom.y, 1500);
assert.equal(bottom.atEnd, true);
assert.equal(nested.run('down', 650).moved, false);
assert.equal(nested.root.scrollTop, 0, 'do not fall through to another pane at the end');
const ordinary = fixture({ inner: false });
assert.equal(ordinary.run('down', 650).target, 'window');
assert.equal(ordinary.root.scrollTop, 650);
for (const opts of [{ hidden: true }, { editable: true }]) {
  const f = fixture(opts);
  assert.equal(f.run('down', 650).target, 'window');
  assert.equal(f.pane.scrollTop, 0);
}
assert.equal(ordinary.run('top', 650).atStart, true);
console.log('scroll regression tests passed: nested pane, direction, bounds, no fallthrough, ordinary page, hidden/editable exclusion');

function iframeFixture({ hidden = false, obscured = false, editable = false, hiddenAncestor = false,
  outerScrollable = false, paneAtEnd = false } = {}) {
  let frameDomReads = 0;
  const root = { tagName: 'HTML', parentElement: null, scrollTop: 0, scrollLeft: 0,
    scrollHeight: outerScrollable ? 1800 : 900, clientHeight: 900, getAttribute: () => null };
  const parent = { tagName: 'DIV', parentElement: root, scrollTop: paneAtEnd ? 500 : 0, scrollLeft: 0,
    scrollHeight: paneAtEnd ? 1000 : 800, clientHeight: paneAtEnd ? 500 : 800,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 900, height: 800 }),
    scrollTo: ({top}) => { parent.scrollTop = top; } };
  const frame = { tagName: 'IFRAME', parentElement: parent, hidden, isContentEditable: editable,
    scrollHeight: 800, clientHeight: 800, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 900, width: 1000, height: 900 }) };
  for (const property of ['contentDocument', 'contentWindow']) Object.defineProperty(frame, property, {
    get() { frameDomReads++; throw new Error('must never enter frame DOM'); },
  });
  const overlay = { tagName: 'DIV', parentElement: root, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 1000, height: 900 }) };
  const run = vm.runInNewContext(`(${SCROLL_FUNCTION})`, {
    innerWidth: 1000, innerHeight: 900, scrollX: 0,
    document: { scrollingElement: root, documentElement: root, elementFromPoint: () => obscured ? overlay : frame },
    getComputedStyle: el => ({ overflowY: el === parent && paneAtEnd ? 'auto' : 'visible',
      display: el === parent && hiddenAncestor ? 'none' : 'block', visibility: 'visible', opacity: '1' }),
    window: { scrollTo: ({top}) => { root.scrollTop = top; } },
  });
  return { run, get frameDomReads() { return frameDomReads; } };
}

const iframe = iframeFixture();
const candidate = JSON.parse(JSON.stringify(iframe.run('down', 600)));
assert.deepEqual(candidate.iframeWheelCandidate, {x: 500, y: 450, viewportWidth: 1000, viewportHeight: 900});
assert.equal(iframe.frameDomReads, 0);
for (const options of [{hidden: true}, {obscured: true}, {editable: true}, {hiddenAncestor: true},
  {outerScrollable: true}, {paneAtEnd: true}]) {
  const guarded = iframeFixture(options);
  assert.equal(guarded.run('down', 600).iframeWheelCandidate, undefined);
  assert.equal(guarded.frameDomReads, 0);
}

for (const direction of ['down', 'up']) {
  const calls = [];
  const position = await scrollPositionUnlocked('owned-fixture', direction, 600, {
    deadline: {},
    fixedFunction: async (target, fixed, args, options) => {
      assert.equal(target, 'owned-fixture'); assert.equal(fixed, SCROLL_FUNCTION);
      assert.deepEqual(args, [direction, 600]); assert.equal(options.retrySession, false);
      return {result: {value: candidate}};
    },
    command: async (target, method, params, options) => {
      calls.push({target, method, params});
      assert.equal(options.sideEffect, true); assert.equal(options.retrySession, false);
    },
  });
  assert.deepEqual(calls, [{target: 'owned-fixture', method: 'Input.dispatchMouseEvent',
    params: {type: 'mouseWheel', x: 500, y: 450, deltaX: 0, deltaY: direction === 'up' ? -600 : 600}}]);
  assert.equal(position.target, 'iframe'); assert.equal(position.moved, null);
  assert.equal(position.motionConfirmed, false); assert.equal(position.wheelDispatched, true);
  for (const key of ['x', 'y', 'atStart', 'atEnd']) assert.equal(position[key], null);
  assert.equal(position.iframeWheelCandidate, undefined, 'private wheel point must not become client coordinates');
}

for (const [direction, amount] of [['top', 600], ['bottom', 600], ['down', 801]]) {
  let dispatched = 0;
  await assert.rejects(scrollPositionUnlocked('owned-fixture', direction, amount, {
    fixedFunction: async () => ({result: {value: candidate}}), command: async () => dispatched++,
  }), error => error instanceof BrokerError && error.code === 'iframe_requires_incremental_scroll');
  assert.equal(dispatched, 0);
}
let ordinaryDispatches = 0;
const ordinaryPosition = {target: 'window', x: 0, y: 600, moved: true, atStart: false, atEnd: false};
assert.deepEqual(await scrollPositionUnlocked('owned-fixture', 'down', 600, {
  fixedFunction: async () => ({result: {value: ordinaryPosition}}), command: async () => ordinaryDispatches++,
}), ordinaryPosition);
assert.equal(ordinaryDispatches, 0);
let uncertainDispatches = 0;
await assert.rejects(scrollPositionUnlocked('owned-fixture', 'down', 600, {
  fixedFunction: async () => ({result: {value: candidate}}), command: async () => {
    uncertainDispatches++; throw new BrokerError('outcome_unknown', 'fixture response lost');
  },
}), error => error.code === 'outcome_unknown');
assert.equal(uncertainDispatches, 1, 'uncertain wheel must never be replayed');
let invalidPointDispatches = 0;
await assert.rejects(scrollPositionUnlocked('owned-fixture', 'down', 600, {
  fixedFunction: async () => ({result: {value: {...candidate,
    iframeWheelCandidate: {...candidate.iframeWheelCandidate, x: 1}}}}),
  command: async () => invalidPointDispatches++,
}), error => error.code === 'invalid_scroll_point');
assert.equal(invalidPointDispatches, 0);
console.log('iframe scroll regression tests passed: visible fixed center only; no frame DOM; guards; single bounded native wheel; unknown motion; no retry or client coordinates');

function selectorFixture({ matches = 'one', hidden = false, hiddenAncestor = false, editable = false,
  scrollable = true, outerScrollable = false } = {}) {
  let centerReads = 0, scrollCalls = 0;
  const element = (tagName, parentElement, options = {}) => ({
    tagName, parentElement, scrollTop: 0, scrollLeft: 0, scrollHeight: 200, clientHeight: 200,
    hidden: false, isContentEditable: false, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 600, height: 200 }), ...options,
  });
  const root = element('HTML', null, { scrollHeight: outerScrollable ? 4000 : 900, clientHeight: 900 });
  const good = element('DIV', root, { scrollHeight: scrollable ? 2100 : 600, clientHeight: 600,
    hidden: hiddenAncestor });
  good.scrollTo = ({ top }) => { scrollCalls++; good.scrollTop = top; };
  // Reproduce the original wrong center pane: scrollTo is ineffective there.
  const wrong = element('DIV', root, { scrollHeight: 2100, clientHeight: 600 });
  wrong.scrollTo = () => { scrollCalls++; };
  const selected = element('DIV', good, { hidden, isContentEditable: editable });
  const other = element('DIV', good);
  const leaf = element('SPAN', wrong);
  const items = matches === 'none' ? [] : matches === 'many' ? [selected, other]
    : matches === 'limit' ? Array(2001).fill(selected) : [selected];
  const run = vm.runInNewContext(`(${SCROLL_FUNCTION})`, {
    innerWidth: 1900, innerHeight: 900, scrollX: 0,
    document: {
      scrollingElement: root, documentElement: root,
      elementFromPoint: () => { centerReads++; return leaf; },
      querySelectorAll: selector => { assert.equal(selector, '.results'); if (matches === 'invalid') throw new SyntaxError('fixture invalid CSS'); return items; },
    },
    getComputedStyle: node => ({ overflowY: node === good || node === wrong ? 'auto' : 'visible',
      display: 'block', visibility: 'visible', opacity: '1' }),
    window: { scrollTo: ({ top }) => { scrollCalls++; root.scrollTop = top; } },
  });
  return { run, root, good, wrong, stats: () => ({ centerReads, scrollCalls }) };
}
const selectedPane = selectorFixture();
const selectedPosition = selectedPane.run('down', 650, '.results');
assert.equal(selectedPosition.target, 'element');
assert.equal(selectedPosition.y, 650);
assert.equal(selectedPane.good.scrollTop, 650);
assert.equal(selectedPane.wrong.scrollTop + selectedPane.root.scrollTop, 0);
assert.equal(selectedPane.stats().centerReads, 0, 'explicit selector must not probe the viewport center');
assert.equal(selectedPane.run('up', 300, '.results').y, 350);
selectedPane.run('down', 5000, '.results');
assert.equal(selectedPane.run('down', 650, '.results').moved, false, 'keep selected pane at its end');
assert.equal(selectedPane.root.scrollTop, 0);
for (const [options, code] of [
  [{ matches: 'none' }, 'scroll_target_not_found'],
  [{ matches: 'many' }, 'scroll_target_ambiguous'],
  [{ hidden: true }, 'scroll_target_not_found'],
  [{ hiddenAncestor: true }, 'scroll_target_not_found'],
  [{ editable: true }, 'scroll_target_not_found'],
  [{ scrollable: false }, 'scroll_target_not_scrollable'],
  [{ matches: 'limit' }, 'scroll_selector_limit'],
  [{ matches: 'invalid' }, 'scroll_selector_invalid'],
]) {
  const invalid = selectorFixture(options);
  assert.equal(invalid.run('down', 650, '.results').error, code);
  assert.deepEqual(invalid.stats(), { centerReads: 0, scrollCalls: 0 }, 'failed selector never falls back or mutates');
}
const outerSelector = selectorFixture({ scrollable: false, outerScrollable: true });
assert.equal(outerSelector.run('down', 650, '.results').target, 'window');
assert.equal(outerSelector.root.scrollTop, 650, 'selected subtree can use its scrollable document ancestor');
const defaultWrongPane = selectorFixture();
assert.equal(defaultWrongPane.run('down', 650).moved, false);
assert.equal(defaultWrongPane.stats().centerReads, 1, 'default center behavior remains unchanged');
assert.equal(defaultWrongPane.good.scrollTop, 0);
for (const sensitive of ['iframe', 'input', 'script', 'div[data-token]', 'div:has(input)']) {
  assert.throws(() => validateSelector(sensitive), error => error instanceof BrokerError && error.code === 'unsafe_selector');
}
assert.equal(validateSelector('body > div > div > div > div'), 'body > div > div > div > div');
let selectorCommands = 0;
assert.equal((await scrollPositionUnlocked('owned-fixture', 'down', 650, {
  selector: '.results', fixedFunction: async (_target, _fixed, args) => {
    assert.deepEqual(args, ['down', 650, '.results']);
    return { result: { value: selectedPosition } };
  }, command: async () => selectorCommands++,
})).y, 650);
for (const errorCode of ['scroll_target_not_found', 'scroll_target_ambiguous', 'scroll_target_not_scrollable']) {
  await assert.rejects(scrollPositionUnlocked('owned-fixture', 'down', 650, {
    selector: '.results', fixedFunction: async () => ({ result: { value: { error: errorCode } } }),
    command: async () => selectorCommands++,
  }), error => error.code === errorCode);
}
await assert.rejects(scrollPositionUnlocked('owned-fixture', 'down', 650, {
  selector: '.results', fixedFunction: async () => ({ result: { value: candidate } }),
  command: async () => selectorCommands++,
}), error => error.code === 'scroll_selector_unsafe_result');
assert.equal(selectorCommands, 0, 'selector branch must never dispatch native iframe input');
console.log('selector scroll regression tests passed: unique visible target selects correct ancestor pane; no/multiple/hidden/editable/unscrollable/oversized/invalid matches fail closed; sensitive selectors rejected; no center fallback or iframe input; default paths retained');

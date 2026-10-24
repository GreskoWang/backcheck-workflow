import assert from 'node:assert/strict';
import test from 'node:test';

import { newRequestId, parseCommand } from '../src/commands.mjs';
import { config } from '../src/config.mjs';

test('accepts only explicit background-check commands', () => {
  assert.deepEqual(parseCommand('背调 张三 https://example.com'), {
    kind: 'request',
    body: '张三 https://example.com',
  });
  assert.equal(parseCommand('帮我查一下张三').kind, 'unknown');
  assert.equal(parseCommand('删除 O:\\背调').kind, 'unknown');
});

test('accepts a complete team dispatch header without an extra command prefix', () => {
  const body = '【背调需求9.28】\nddl9.29下午五点前\nts-ts5\n1、KeG';
  assert.deepEqual(parseCommand(body), { kind: 'request', body });
  assert.equal(parseCommand('今天有背调需求，稍后发送').kind, 'unknown');
});

test('accepts a dispatch after a test preface and marks it scope-only', () => {
  const text = '派单测试\n【背调需求9.28】\n每人两个\n1、甲';
  assert.deepEqual(parseCommand(text), {
    kind: 'request',
    body: '【背调需求9.28】\n每人两个\n1、甲',
    scopeOnly: true,
  });
});

test('accepts CRLF and a normalized rich-text bold dispatch heading', () => {
  const parsed = parseCommand('说明\r\n**【背调需求9.29】**\r\nTS-TS1\r\n1、甲');
  assert.equal(parsed.kind, 'request');
  assert.match(parsed.body, /【背调需求9\.29】/);
  assert.equal(parseCommand('这是引用【背调需求9.29】，不是一条派单').kind, 'unknown');
});

test('parses pairing and status commands', () => {
  assert.deepEqual(parseCommand('绑定背调群 2345ABCD'), { kind: 'pair', code: '2345ABCD' });
  assert.deepEqual(parseCommand('状态 rq-20260929-120000-abcd'), {
    kind: 'status',
    requestId: 'RQ-20260929-120000-ABCD',
  });
});

test('rejects oversized requests and creates stable-shaped ids', () => {
  assert.equal(parseCommand(`背调 ${'x'.repeat(11)}`, 10).kind, 'invalid');
  assert.equal(
    newRequestId(new Date(2026, 8, 29, 12, 34, 56), 'a1b2'),
    'RQ-20260929-123456-A1B2',
  );
  const first = newRequestId(new Date(2026, 8, 29, 12, 34, 56));
  const second = newRequestId(new Date(2026, 8, 29, 12, 34, 56));
  assert.match(first, /^RQ-20260929-123456-[0-9A-F]{24}$/u);
  assert.notEqual(first, second);
});

test('configured request limit accepts a large normalized rich-text team dispatch', () => {
  const row = '对象 [https://example.com/account](https://example.com/account)\n';
  const body = `【背调需求9.30】\nTS-TS9\n${row.repeat(100)}`;
  assert.ok(body.length > 6000);
  assert.ok(body.length < config.maxRequestChars);
  assert.equal(parseCommand(body, config.maxRequestChars).kind, 'request');
});

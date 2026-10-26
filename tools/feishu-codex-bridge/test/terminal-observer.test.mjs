import { windowsFixturePath } from './fixture-paths.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProbeTerminalObserver,
  detectTrustConfirmation,
  redactDiagnosticLine,
  redactTerminalScreen,
  renderAnsiScreen,
} from '../src/terminal-observer.mjs';

test('ANSI clear and cursor moves reconstruct the current screen, not erased secrets', () => {
  const raw = [
    `\x1b[2J\x1b[1;1Hsecret@example.com ${windowsFixturePath('private', 'token.txt')}`,
    '\x1b[2J\x1b[3;1H\x1b[32m› Ask Codex to do anything\x1b[0m',
    '\x1b[36;1HRQ-PROBE-TEST',
  ].join('');
  const screen = renderAnsiScreen(raw).join('\n');
  assert.ok(screen.includes('Ask Codex to do anything'));
  assert.ok(screen.includes('RQ-PROBE-TEST'));
  assert.ok(!screen.includes('secret@example.com'));
  const safe = redactTerminalScreen(raw, { requestId: 'RQ-PROBE-TEST' });
  assert.match(safe, /输入编辑器/u);
  assert.match(safe, /编辑器附近可见本次空任务文本/u);
  assert.ok(!safe.includes('RQ-PROBE-TEST'));
});

test('only the full official folder picker is treated as a trust confirmation', () => {
  const workspace = windowsFixturePath('feishu-empty-thread-probe-ABC');
  const picker = [
    '\x1b[2J\x1b[4;1HFolder access',
    `\x1b[5;1H${workspace}`,
    '\x1b[9;1HTrust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
    '\x1b[10;1HFolder settings can run code automatically, even without a model request.',
    '\x1b[11;1HYour trust decision will be saved.',
    '\x1b[13;1H1. Trust and continue',
    '\x1b[14;1H2. Quit',
  ].join('');
  assert.equal(detectTrustConfirmation(picker, { workspace })?.trustTarget, workspace);
  const safe = redactTerminalScreen(picker, { requestId: 'RQ-PROBE-TEST', workspace });
  assert.match(safe, /工作区信任确认/u);
  assert.ok(safe.includes(`画面确认目标：${workspace}`));
  assert.match(safe, /文件夹设置可能在没有模型请求时自动运行代码/u);

  const quoted = '\x1b[2J\x1b[3;1H用户说不要信任目录，引用 Trust this folder?\x1b[35;1HAsk Codex to do anything';
  assert.equal(detectTrustConfirmation(quoted), null);
  assert.doesNotMatch(redactTerminalScreen(quoted, { requestId: 'RQ-PROBE-TEST' }), /工作区信任确认/u);
  assert.equal(detectTrustConfirmation(`${picker}\x1b[2J\x1b[35;1HAsk Codex to do anything`), null);
});

test('authentication and QR screens are hidden in their entirety', () => {
  const raw = '\x1b[2J\x1b[1;1HSign in to Codex\nScan QR code https://login.example.test/ABCD-EFGH\nDevice code ABCD-EFGH\nname@example.com';
  const safe = redactTerminalScreen(raw, { requestId: 'RQ-PROBE-TEST' });
  assert.equal(safe, '登录/授权阻塞（认证画面已整体隐藏）');
  for (const secret of ['login.example.test', 'ABCD-EFGH', 'name@example.com']) {
    assert.ok(!safe.includes(secret));
  }
});

test('unknown content, paths, tokens, and business text never leave the allowlist', () => {
  const observer = new ProbeTerminalObserver('RQ-PROBE-TEST');
  observer.push(`\x1b[2J\x1b[1;1H客户姓名 张三 ${windowsFixturePath('secret', 'contract.docx')} token_12345678901234567890`);
  observer.push('\x1b[2;1Hnetwork error https://example.test/private?key=abc');
  const safe = observer.snapshot();
  assert.match(safe, /非诊断画面文字已隐藏/u);
  assert.match(safe, /诊断：network error \[URL\]/u);
  for (const secret of ['张三', 'contract.docx', 'token_12345678901234567890', 'example.test']) {
    assert.ok(!safe.includes(secret));
  }
});

test('network, model, permission, and HTTP diagnostics keep actionable text and codes', () => {
  const examples = [
    ['Error: failed to send request for url https://api.openai.com/v1/responses: HTTP 429 Too Many Requests',
      /Error: failed to send request for url \[URL\].*HTTP 429 Too Many Requests/u],
    ['Warning: model gpt-5.6-luna is not available for this account',
      /Warning: model gpt-5\.6-luna is not available for this account/u],
    [`Error: Permission denied (os error 5) opening ${windowsFixturePath('John Doe', 'auth.json')}`,
      /Error: Permission denied \(os error 5\) opening \[PATH AND TAIL REDACTED\]/u],
    ['Error: authorization failed: HTTP 401 Unauthorized',
      /Error: authorization failed: HTTP 401 Unauthorized/u],
  ];
  for (const [input, expected] of examples) {
    assert.match(redactDiagnosticLine(input), expected);
  }
});

test('sensitive fields inside an error are replaced while status remains readable', () => {
  const input = `Error: unauthorized HTTP 401 for name@example.com at ${windowsFixturePath('John Doe', 'auth.json')} token=sk-1234567890abcdef ABCD-EFGH`;
  const safe = redactDiagnosticLine(input);
  assert.match(safe, /Error: unauthorized HTTP 401/u);
  for (const secret of ['name@example.com', 'John Doe', 'auth.json', 'sk-1234567890abcdef', 'ABCD-EFGH']) {
    assert.ok(!safe.includes(secret));
  }
  assert.equal(redactDiagnosticLine('Error: HTTP 403 token="short secret value"'),
    'Error: HTTP 403 token=[REDACTED]');
  assert.equal(redactDiagnosticLine('Error: OPENAI_API_KEY=abc123'),
    'Error: OPENAI_API_KEY=[REDACTED]');
});

test('ANSI rows preserve a wrapped error while an echoed reply marker is not called model output', () => {
  const raw = [
    '\x1b[2J\x1b[10;1HRQ-PROBE-TEST FEISHU_BATCH_RQ-PROBE-TEST_abcd',
    '\x1b[11;1HBATCH_THREAD_READY_abcd',
    '\x1b[14;1HError: failed to connect to api.example.test',
    '\x1b[15;1H  because TLS certificate verify failed',
  ].join('');
  const safe = redactTerminalScreen(raw, { requestId: 'RQ-PROBE-TEST' });
  assert.match(safe, /固定回复标记出现在画面中（可能只是提示词回显，不能认定模型已回复）/u);
  assert.match(safe, /Error: failed to connect to \[HOST\]/u);
  assert.match(safe, /TLS certificate verify failed/u);
  assert.ok(!safe.includes('api.example.test'));
});

test('authorization error is reported while an authentication page remains hidden', () => {
  const error = redactTerminalScreen('\x1b[2J\x1b[14;1HError: authorization failed HTTP 401', {
    requestId: 'RQ-PROBE-TEST',
  });
  assert.match(error, /authorization failed HTTP 401/u);
  const page = redactTerminalScreen('\x1b[2J\x1b[1;1HSign in to Codex\nDevice code ABCD-EFGH', {
    requestId: 'RQ-PROBE-TEST',
  });
  assert.equal(page, '登录/授权阻塞（认证画面已整体隐藏）');
});

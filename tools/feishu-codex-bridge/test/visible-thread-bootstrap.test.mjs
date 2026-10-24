import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  VisibleThreadBootstrapper,
  classifyCliStartup,
  createStandaloneCodexEnv,
  isVisibleCliSessionMeta,
  visibleThreadVersions,
} from '../src/visible-thread-bootstrap.mjs';

function officialTrustScreen(workspace) {
  return [
    '\x1b[2J\x1b[4;1HFolder access',
    `\x1b[5;1H${workspace}`,
    '\x1b[9;1HTrust this folder? Codex can read, edit, and run files here.',
    '\x1b[13;1H1. Trust and continue',
    '\x1b[14;1H2. Quit',
  ].join('');
}

test('startup classifier never treats sign-in or trust confirmation as a ready composer', () => {
  assert.equal(classifyCliStartup('\x1b[2JWelcome\nAsk Codex to do anything'), 'composer');
  assert.equal(classifyCliStartup('Sign in to Codex\nAsk Codex to do anything'), 'sign_in');
  assert.equal(classifyCliStartup(`${officialTrustScreen('C:\\Temp\\probe')}\x1b[35;1HAsk Codex to do anything`), 'trust_confirmation');
  assert.equal(classifyCliStartup('quoted Trust this folder?\nAsk Codex to do anything'), 'composer');
  assert.equal(classifyCliStartup(`${officialTrustScreen('C:\\Temp\\probe')}\x1b[2J\x1b[35;1HAsk Codex to do anything`), 'composer');
  assert.equal(classifyCliStartup('Loading Codex'), 'loading');
  const update = '\x1b[2J\x1b[4;1HUpdate available 0.158.0 -> 0.159.0' +
    '\x1b[8;1H1. Update now\x1b[9;1H2. Skip\x1b[10;1H3. Skip until next version';
  assert.equal(classifyCliStartup(update), 'update_confirmation');
  assert.equal(classifyCliStartup(`${update}\x1b[2J\x1b[35;1HAsk Codex to do anything`), 'composer');
});

test('argv bootstrap verifies a CLI session without ever writing PTY input', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-no-keys-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionsRoot);
  const writes = [];
  let exitHandler;
  let receivedArgs;
  const threadId = '00000000-0ea7-7000-8000-14ebf2ed466e';
  const fakeChild = {
    onData() { return { dispose() {} }; },
    onExit(handler) { exitHandler = handler; return { dispose() {} }; },
    write(value) { writes.push(value); },
    kill() { exitHandler?.({ exitCode: 1 }); },
  };
  const bootstrapper = new VisibleThreadBootstrapper({
    sessionsRoot,
    spawn(_file, args) {
      receivedArgs = args;
      const prompt = args.at(-1);
      const marker = prompt.match(/FEISHU_BATCH_[A-Z0-9-]+_[0-9a-f]{16}/u)?.[0];
      const reply = prompt.match(/BATCH_THREAD_READY_[0-9a-f]{16}/u)?.[0];
      assert.ok(marker && reply);
      setTimeout(() => fs.writeFileSync(path.join(sessionsRoot, 'fake.jsonl'), [
        JSON.stringify({ type: 'session_meta', payload: {
          id: threadId, source: 'cli', originator: 'codex-tui', cli_version: '0.158.0', cwd: process.cwd(),
        } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: marker } }),
        JSON.stringify({ type: 'turn_context', payload: {
          cwd: process.cwd(), approval_policy: 'on-request', approvals_reviewer: 'user',
          sandbox_policy: { type: 'read-only' },
        } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: reply } }),
      ].join('\n')), 10);
      return fakeChild;
    },
  });
  const result = await bootstrapper.bootstrap({
    requestId: 'RQ-NO-KEYS', threadTitle: 'fixed probe', workspace: process.cwd(),
    inputMode: 'startup_argument_no_keys', timeoutMs: 3_000,
  });
  assert.equal(result.threadId, threadId);
  assert.equal(result.titleApplied, false);
  assert.equal(result.cliExitMethod, 'pty.kill after verified response');
  assert.deepEqual(writes, []);
  assert.ok(receivedArgs.includes('on-request'));
  assert.ok(receivedArgs.includes('approvals_reviewer="user"'));
  assert.ok(receivedArgs.includes('mcp_servers.node_repl.enabled=false'));
  assert.ok(receivedArgs.includes('mcp_servers.feishu.enabled=false'));
  assert.ok(receivedArgs.includes('notify=[]'));
});

test('argv bootstrap stops at update, trust, and sign-in pages without PTY input', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-protected-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const screens = [
    ['update_confirmation', '\x1b[2JUpdate available\n1. Update now\n2. Skip'],
    ['trust_confirmation', officialTrustScreen(process.cwd())],
    ['sign_in', '\x1b[2JSign in to Codex\nChoose a sign-in method'],
  ];
  for (const [state, screen] of screens) {
    const sessionsRoot = path.join(root, state);
    fs.mkdirSync(sessionsRoot);
    const writes = [];
    let exitHandler;
    let killed = false;
    const child = {
      onData(handler) { setTimeout(() => handler(screen), 10); return { dispose() {} }; },
      onExit(handler) { exitHandler = handler; return { dispose() {} }; },
      write(value) { writes.push(value); },
      kill() { killed = true; exitHandler?.({ exitCode: 1 }); },
    };
    const bootstrapper = new VisibleThreadBootstrapper({ sessionsRoot, spawn: () => child });
    await assert.rejects(bootstrapper.bootstrap({
      requestId: `RQ-${state.toUpperCase()}`, threadTitle: 'fixed probe', workspace: process.cwd(),
      inputMode: 'startup_argument_no_keys', timeoutMs: 2_000,
    }), (error) => error.bootstrapDiagnostics?.cliStartupState === state &&
      error.bootstrapDiagnostics?.enterSent === false);
    assert.equal(killed, true);
    assert.deepEqual(writes, []);
  }
});

test('argv bootstrap treats an idle composer as failure and still sends no key', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-idle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes = [];
  let exitHandler;
  const child = {
    onData(handler) { setTimeout(() => handler('Ask Codex to do anything'), 10); return { dispose() {} }; },
    onExit(handler) { exitHandler = handler; return { dispose() {} }; },
    write(value) { writes.push(value); },
    kill() { exitHandler?.({ exitCode: 1 }); },
  };
  const bootstrapper = new VisibleThreadBootstrapper({ sessionsRoot: root, spawn: () => child });
  await assert.rejects(bootstrapper.bootstrap({
    requestId: 'RQ-IDLE-NO-KEYS', threadTitle: 'fixed probe', workspace: process.cwd(),
    inputMode: 'startup_argument_no_keys', timeoutMs: 750,
  }), (error) => /timed out waiting for the source=cli session marker/u.test(error.message) &&
    error.bootstrapDiagnostics?.enterSent === false);
  assert.deepEqual(writes, []);
});

test('bootstrap waits for the composer and submits exactly one turn through ConPTY', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bootstrap-test-'));
  const sessionsRoot = path.join(tempRoot, 'sessions');
  fs.mkdirSync(sessionsRoot);
  const threadId = '00000000-1aef-7000-8000-02f54ca31c1c';
  const writes = [];
  let dataHandler;
  let exitHandler;
  let pendingPrompt = '';
  let promptReadyAt = 0;
  let modalOpen = false;
  let exiting = false;
  let receivedArgs;
  const emit = (value) => dataHandler?.(value);
  const fakeChild = {
    onData(handler) {
      dataHandler = handler;
      setTimeout(() => emit('Ask Codex to do anything'), 10);
      return { dispose() {} };
    },
    onExit(handler) { exitHandler = handler; return { dispose() {} }; },
    write(value) {
      writes.push(value);
      if (value === '/rename') { modalOpen = true; return; }
      if (value === '/exit') { exiting = true; return; }
      if (value !== '\r') {
        pendingPrompt = value;
        if (value.startsWith('飞书背调批次')) {
          // Model Codex's Windows paste-burst behavior: Enter sent before the
          // last characters settle becomes a newline instead of a submission.
          promptReadyAt = Date.now() + 250;
          setTimeout(() => emit(value), 250);
        }
        return;
      }
      if (exiting) { setTimeout(() => exitHandler?.({ exitCode: 0 }), 5); return; }
      if (modalOpen) {
        modalOpen = false;
        emit('Name thread\nType a name and press Enter');
        return;
      }
      if (pendingPrompt.startsWith('飞书背调批次')) {
        if (Date.now() < promptReadyAt + 120) return;
        const marker = pendingPrompt.match(/FEISHU_BATCH_[A-Z0-9-]+_[0-9a-f]{16}/u)?.[0];
        const reply = pendingPrompt.match(/BATCH_THREAD_READY_[0-9a-f]{16}/u)?.[0];
        assert.ok(marker && reply);
        fs.writeFileSync(path.join(sessionsRoot, 'fake.jsonl'), [
          JSON.stringify({ type: 'session_meta', payload: {
            id: threadId, source: 'cli', originator: 'codex-tui', cli_version: '0.158.0', cwd: process.cwd(),
          } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: marker } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: reply } }),
        ].join('\n'));
      } else {
        emit('Ask Codex to do anything');
      }
    },
    kill() { exitHandler?.({ exitCode: 1 }); },
  };
  try {
    const bootstrapper = new VisibleThreadBootstrapper({
      spawn(_file, args) { receivedArgs = args; return fakeChild; }, sessionsRoot,
    });
    const statuses = [];
    const result = await bootstrapper.bootstrap({
      requestId: 'RQ-OFFLINE-TEST', threadTitle: '飞书背调 离线测试',
      workspace: process.cwd(), timeoutMs: 10_000,
      onStatus(status) { statuses.push(status); },
    });
    assert.equal(result.threadId, threadId);
    assert.ok(receivedArgs.includes('--no-daemon'));
    assert.equal(receivedArgs.some((arg) => String(arg).includes('RQ-OFFLINE-TEST')), false);
    assert.equal(writes.filter((value) => value.startsWith('飞书背调批次')).length, 1);
    assert.ok(statuses.indexOf('composer_ready') < statuses.indexOf('prompt_written'));
    assert.ok(statuses.indexOf('prompt_written') < statuses.indexOf('prompt_echo_settled'));
    assert.ok(statuses.indexOf('prompt_echo_settled') < statuses.indexOf('enter_sent'));
    assert.ok(statuses.indexOf('enter_sent') < statuses.indexOf('session_discovered'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a real folder trust picker aborts early and failure cleanup never presses Enter', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-test-'));
  const sessionsRoot = path.join(workspace, 'sessions');
  fs.mkdirSync(sessionsRoot);
  const writes = [];
  const statuses = [];
  let dataHandler;
  let exitHandler;
  let killed = false;
  const fakeChild = {
    onData(handler) {
      dataHandler = handler;
      setTimeout(() => dataHandler?.('Ask Codex to do anything'), 10);
      return { dispose() {} };
    },
    onExit(handler) { exitHandler = handler; return { dispose() {} }; },
    write(value) {
      writes.push(value);
      if (value.startsWith('飞书背调批次')) dataHandler?.(value);
      if (value === '\r') dataHandler?.(officialTrustScreen(workspace));
    },
    kill() { killed = true; exitHandler?.({ exitCode: 1 }); },
  };
  try {
    const bootstrapper = new VisibleThreadBootstrapper({ spawn: () => fakeChild, sessionsRoot });
    await assert.rejects(bootstrapper.bootstrap({
      requestId: 'RQ-TRUST-TEST', threadTitle: '飞书背调 临时目录',
      workspace, timeoutMs: 5_000,
      onStatus(status) { statuses.push(status); },
    }), (error) => /folder trust confirmation is required/u.test(error.message) &&
      error.bootstrapDiagnostics?.trustConfirmationSeen === true &&
      error.bootstrapDiagnostics?.cliStartupState === 'trust_confirmation');
    assert.equal(killed, true);
    assert.equal(writes.filter((value) => value === '\r').length, 1);
    assert.equal(writes.includes('/exit'), false);
    assert.ok(statuses.includes('trust_confirmation_detected'));
  } finally {
    fs.rmdirSync(sessionsRoot);
    fs.rmdirSync(workspace);
  }
});

test('standalone environment removes parent Codex identity but preserves CODEX_HOME', () => {
  const env = createStandaloneCodexEnv({
    Path: 'C:\\bin',
    CODEX_THREAD_ID: 'parent-thread',
    CODEX_SESSION_ID: 'parent-session',
    CODEX_APP_TOOLS_PIPE_PATH: 'pipe',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
    CODEX_HOME: 'D:\\codex-home',
    OPENAI_API_KEY: 'test-value',
  });
  assert.deepEqual(env, {
    Path: 'C:\\bin',
    CODEX_HOME: 'D:\\codex-home',
    OPENAI_API_KEY: 'test-value',
  });
  assert.equal(createStandaloneCodexEnv({ Path: 'C:\\bin' }).CODEX_HOME,
    path.join(os.homedir(), '.codex'));
});

test('only the exact standalone source=cli metadata is accepted', () => {
  const valid = {
    id: '00000000-1aef-7000-8000-02f54ca31c1c',
    source: 'cli',
    originator: 'codex-tui',
    cli_version: '0.158.0',
    cwd: 'O:\\背调',
  };
  assert.equal(isVisibleCliSessionMeta(valid, { workspace: 'O:\\背调' }), true);
  assert.equal(isVisibleCliSessionMeta({ ...valid, source: { subagent: {} } }, {
    workspace: 'O:\\背调',
  }), false);
  assert.equal(isVisibleCliSessionMeta({ ...valid, source: 'exec' }, {
    workspace: 'O:\\背调',
  }), false);
  assert.equal(isVisibleCliSessionMeta({ ...valid, cli_version: '0.159.0' }, {
    workspace: 'O:\\背调',
  }), false);
  assert.equal(isVisibleCliSessionMeta({ ...valid, cwd: 'O:\\其他' }, {
    workspace: 'O:\\背调',
  }), false);
  assert.deepEqual(visibleThreadVersions, {
    cli: '0.158.0', sdk: '0.158.0', pty: '1.1.0',
  });
});

test('shutdown aborts and kills an active ConPTY bootstrap', async () => {
  let exitHandler;
  let killCount = 0;
  const fakeChild = {
    onData() { return { dispose() {} }; },
    onExit(handler) { exitHandler = handler; return { dispose() {} }; },
    write() {},
    kill() {
      killCount += 1;
      exitHandler?.({ exitCode: 1 });
    },
  };
  const bootstrapper = new VisibleThreadBootstrapper({ spawn: () => fakeChild });
  const pending = bootstrapper.bootstrap({
    requestId: 'RQ-SHUTDOWN-TEST',
    threadTitle: '飞书背调 测试',
    workspace: process.cwd(),
    model: 'gpt-5.6-luna',
    timeoutMs: 30_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bootstrapper.shutdown('test shutdown');
  await assert.rejects(pending, /aborted|did not exit cleanly/iu);
  assert.ok(killCount >= 1);
});

test('an early CLI exit reports bounded, non-secret startup diagnostics', async () => {
  let exitHandler;
  const statuses = [];
  const fakeChild = {
    onData() { return { dispose() {} }; },
    onExit(handler) {
      exitHandler = handler;
      setTimeout(() => exitHandler?.({ exitCode: 1 }), 5);
      return { dispose() {} };
    },
    write() {},
    kill() {},
  };
  const bootstrapper = new VisibleThreadBootstrapper({ spawn: () => fakeChild });
  await assert.rejects(
    bootstrapper.bootstrap({
      requestId: 'RQ-EARLY-EXIT',
      threadTitle: '飞书背调 空任务',
      workspace: process.cwd(),
      timeoutMs: 2_000,
      onStatus(status) { statuses.push(status); },
    }),
    (error) => /exited before its composer was ready/u.test(error.message) &&
      error.bootstrapDiagnostics?.cliExitedBeforeSession === true &&
      error.bootstrapDiagnostics?.cliStartupState === 'loading' &&
      typeof error.bootstrapDiagnostics?.newSessionFileCount === 'number',
  );
  assert.deepEqual(statuses, ['cli_spawned']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildProductionResumeArgs, classifyCliScreen, classifyProtectedCliScreen, digestCliSessionRecords,
  executeBoundCliThread, inspectBoundCliSession,
  inspectProductionTurn,
} from '../src/cli-thread-execution.mjs';

const threadId = '00000000-6890-7000-8000-ca07e33e97e0';
const requestId = 'RQ-CLI-OFFLINE';
const prompt = 'Research only this verified batch.';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-cli-test-'));
  const workspace = path.join(root, 'workspace');
  const sessionsRoot = path.join(root, 'sessions');
  const sessionDir = path.join(sessionsRoot, '2026', '10', '03');
  fs.mkdirSync(workspace);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `rollout-${threadId}.jsonl`);
  const initial = [
    { type: 'session_meta', payload: {
      id: threadId, cwd: workspace, source: 'cli', originator: 'codex-tui', cli_version: '0.158.0',
    } },
    { type: 'response_item', payload: { role: 'user', content: [
      { type: 'input_text', text: `FEISHU_BATCH_${requestId}_a1b2c3` },
    ] } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'BATCH_THREAD_READY_a1b2c3' } },
  ];
  fs.writeFileSync(sessionPath, initial.map((item) => JSON.stringify(item)).join('\n') + '\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, sessionsRoot, sessionPath, initial };
}

function appendTurn(f, { approval = 'on-request', reviewer = 'user', sandbox = 'workspace-write' } = {}) {
  const added = [
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { type: 'turn_context', payload: {
      cwd: f.workspace, approval_policy: approval, approvals_reviewer: reviewer,
      sandbox_policy: { type: sandbox },
    } },
    { type: 'response_item', payload: { type: 'function_call', name: 'allowed_research_tool' } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '报告已完成' } },
  ];
  fs.appendFileSync(f.sessionPath, added.map((item) => JSON.stringify(item)).join('\n') + '\n');
}

function fakeSpawn(capture, action) {
  return (_binary, args, options) => {
    capture.args = args;
    capture.options = options;
    const child = {
      onData(callback) { capture.data = callback; return { dispose() {} }; },
      onExit(callback) { capture.exit = callback; return { dispose() {} }; },
      write() { throw new Error('PTY input is prohibited'); },
      kill() { capture.kills = (capture.kills || 0) + 1; },
    };
    setTimeout(() => action(capture), 2);
    return child;
  };
}

test('production resume pins exact UUID, workspace sandbox, user approval, and no automatic network', () => {
  const args = buildProductionResumeArgs({ threadId, workspace: 'O:\\背调', prompt });
  assert.equal(args[1], 'resume');
  assert.ok(args.includes('--no-daemon'));
  assert.deepEqual(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2), ['-s', 'workspace-write']);
  assert.deepEqual(args.slice(args.indexOf('-a'), args.indexOf('-a') + 2), ['-a', 'on-request']);
  assert.ok(args.includes('approvals_reviewer="user"'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(args.at(-2), threadId);
  assert.equal(args.at(-1), prompt);
  assert.equal(args.filter((value) => value === threadId).length, 1);
  assert.throws(() => buildProductionResumeArgs({ threadId, workspace: 'O:\\背调', prompt, sandboxMode: 'danger-full-access' }));
});

test('production CLI resumes a verified bound session and allows research tools without PTY keys', async (t) => {
  const f = fixture(t);
  const capture = {};
  const phases = [];
  const result = await executeBoundCliThread({
    ...f, threadId, requestId, prompt, pollMs: 1,
    spawn: fakeSpawn(capture, () => appendTurn(f)),
    onPhase: (phase) => phases.push(phase),
  });
  assert.deepEqual(result, { threadId, finalResponse: '报告已完成' });
  assert.equal(capture.args.at(-2), threadId);
  assert.equal(capture.options.cwd, f.workspace);
  assert.ok(capture.kills >= 1);
  assert.deepEqual(phases, [
    'preflight_starting', 'preflight_verified', 'pty_spawning', 'pty_spawned',
    'prompt_recorded', 'runtime_permissions_verified', 'turn_completed',
  ]);
});

test('production CLI rejects wrong request marker and duplicate session before spawn', async (t) => {
  const f = fixture(t);
  let spawned = false;
  const spawn = () => { spawned = true; throw new Error('unexpected spawn'); };
  await assert.rejects(executeBoundCliThread({ ...f, threadId, requestId: 'RQ-OTHER', prompt, spawn }),
    /not bound/u);
  fs.copyFileSync(f.sessionPath, path.join(path.dirname(f.sessionPath), `copy-${threadId}.jsonl`));
  await assert.rejects(executeBoundCliThread({ ...f, threadId, requestId, prompt, spawn }),
    /no unique session/u);
  assert.equal(spawned, false);
});

test('session changes after an audited preflight are rejected before PTY spawn', async (t) => {
  const f = fixture(t);
  const baseline = inspectBoundCliSession({ ...f, threadId, requestId });
  const expectedBaselineDigest = digestCliSessionRecords(baseline);
  fs.appendFileSync(f.sessionPath, JSON.stringify({ type: 'event_msg',
    payload: { type: 'thread_settings_applied' } }) + '\n');
  let spawned = false;
  await assert.rejects(executeBoundCliThread({ ...f, threadId, requestId, prompt,
    expectedBaselineDigest,
    spawn: () => { spawned = true; throw new Error('must not spawn'); },
  }), (error) => error.reasonCode === 'CLI_BASELINE_CHANGED');
  assert.equal(spawned, false);
});

test('production CLI rejects weakened runtime permissions and modified prompt', (t) => {
  const f = fixture(t);
  const before = inspectBoundCliSession({ ...f, threadId, requestId });
  appendTurn(f, { approval: 'never' });
  const current = fs.readFileSync(f.sessionPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.throws(() => inspectProductionTurn({ before, current, prompt, workspace: f.workspace }), /permissions/u);
  const changed = structuredClone(current);
  changed[before.length].payload.content[0].text = 'different prompt';
  assert.throws(() => inspectProductionTurn({ before, current: changed, prompt, workspace: f.workspace }), /prompt/u);
});

test('production CLI stops on trust or approval screen and never sends PTY input', async (t) => {
  const f = fixture(t);
  for (const screen of [
    'Folder access\nTrust this folder?\nTrust and continue\nQuit',
    'Would you like to run\nYes, proceed\nNo, cancel',
    'Sign in to Codex\nChoose a sign-in method\nSign in with ChatGPT',
  ]) {
    const capture = {};
    const phases = [];
    const snapshots = [];
    await assert.rejects(executeBoundCliThread({
      ...f, threadId, requestId, prompt, pollMs: 1, timeoutMs: 100,
      spawn: fakeSpawn(capture, ({ data }) => data(screen)),
      onPhase: (phase, details) => phases.push({ phase, details }),
      onTerminalSnapshot: (snapshot) => snapshots.push(snapshot),
    }), (error) => {
      assert.match(error.message, /manual/u);
      assert.equal(error.reasonCode, 'CLI_PROTECTED_SCREEN');
      return true;
    });
    assert.equal(phases.at(-1).phase, 'protected_screen');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].event, 'protected_screen');
    assert.equal(snapshots[0].classification,
      screen.startsWith('Folder') ? 'trust_confirmation' :
        screen.startsWith('Would') ? 'approval_required' : 'sign_in');
    assert.ok(capture.kills >= 1);
  }
});

test('protected-screen classification ignores cleared scrollback and quoted trust text', () => {
  assert.equal(classifyProtectedCliScreen('Trust this folder?'), null);
  assert.equal(classifyProtectedCliScreen('Approval required\x1b[2J\x1b[HWorking'), null);
  assert.equal(classifyProtectedCliScreen(
    'Folder access\nTrust this folder?\nTrust and continue\nQuit'), 'trust_confirmation');
  assert.equal(classifyProtectedCliScreen('Approval required\nApprove\nDeny'), 'approval_required');
  assert.equal(classifyProtectedCliScreen('Research sign in to accounts and authorization'), null);
  assert.equal(classifyProtectedCliScreen('Log in to continue\nAsk Codex to do anything'), null);
  assert.equal(classifyProtectedCliScreen(
    'Sign in to Codex\nChoose a sign-in method\nSign in with ChatGPT'), 'sign_in');
  assert.equal(classifyCliScreen(''), 'empty');
  assert.equal(classifyCliScreen('Ask Codex to do anything'), 'composer');
  assert.equal(classifyCliScreen('Working'), 'working_or_thinking');
  assert.equal(classifyCliScreen('loading'), 'loading_or_other');
});

test('an ambiguous login phrase is redacted but only the prompt deadline stops it', async (t) => {
  const f = fixture(t);
  const capture = {};
  const phases = [];
  const snapshots = [];
  await assert.rejects(executeBoundCliThread({ ...f, threadId, requestId, prompt,
    pollMs: 1, timeoutMs: 100, promptRecordTimeoutMs: 10,
    spawn: fakeSpawn(capture, ({ data }) => data('Log in to continue\nAsk Codex to do anything')),
    onPhase: (phase) => phases.push(phase),
    onTerminalSnapshot: (snapshot) => snapshots.push(snapshot),
  }), (error) => {
    assert.equal(error.reasonCode, 'CLI_PROMPT_NOT_RECORDED');
    return true;
  });
  assert.equal(phases.at(-1), 'prompt_not_recorded');
  assert.equal(snapshots.at(-1).classification, 'auth_sensitive_text');
  assert.equal(snapshots.at(-1).event, 'prompt_not_recorded');
  assert.ok(capture.kills >= 1);
});

test('an idle composer without a recorded prompt stops at a bounded startup deadline', async (t) => {
  const f = fixture(t);
  const phases = [];
  const snapshots = [];
  await assert.rejects(executeBoundCliThread({ ...f, threadId, requestId, prompt,
    pollMs: 1, timeoutMs: 100, promptRecordTimeoutMs: 10,
    spawn: fakeSpawn({}, ({ data }) => data('Ask Codex to do anything')),
    onPhase: (phase) => phases.push(phase),
    onTerminalSnapshot: (snapshot) => snapshots.push(snapshot),
  }), (error) => {
    assert.equal(error.reasonCode, 'CLI_PROMPT_NOT_RECORDED');
    return true;
  });
  assert.equal(phases.at(-1), 'prompt_not_recorded');
  assert.equal(snapshots.at(-1).event, 'prompt_not_recorded');
  assert.equal(snapshots.at(-1).classification, 'composer');
});

test('production CLI exits or times out without retry', async (t) => {
  const f = fixture(t);
  const early = {};
  const phases = [];
  const snapshots = [];
  await assert.rejects(executeBoundCliThread({
    ...f, threadId, requestId, prompt, pollMs: 1,
    spawn: fakeSpawn(early, ({ exit }) => exit({ exitCode: 1 })),
    onPhase: (phase, details) => phases.push({ phase, details }),
    onTerminalSnapshot: (snapshot) => snapshots.push(snapshot),
  }), (error) => {
    assert.match(error.message, /exited/u);
    assert.equal(error.reasonCode, 'CLI_CHILD_EXITED');
    return true;
  });
  assert.deepEqual(phases.at(-1), { phase: 'pty_exited', details: { exitCode: 1 } });
  assert.equal(snapshots.at(-1).event, 'child_exited');
  assert.equal(snapshots.at(-1).classification, 'empty');
  assert.equal(early.args.filter((value) => value === threadId).length, 1);
  const timeout = {};
  await assert.rejects(executeBoundCliThread({
    ...f, threadId, requestId, prompt, pollMs: 1, timeoutMs: 20,
    spawn: fakeSpawn(timeout, () => {}),
  }), /timed out/u);
  assert.ok(timeout.kills >= 1);
});

test('PTY spawn failure reports a distinct safe phase and subcode', async (t) => {
  const f = fixture(t);
  const phases = [];
  await assert.rejects(executeBoundCliThread({ ...f, threadId, requestId, prompt,
    spawn: () => { const error = new Error('private path'); error.code = 'ENOENT'; throw error; },
    onPhase: (phase, details) => phases.push({ phase, details }),
  }), (error) => {
    assert.equal(error.reasonCode, 'CLI_PTY_SPAWN_FAILED');
    assert.ok(!error.message.includes('private path'));
    return true;
  });
  assert.deepEqual(phases.at(-1), {
    phase: 'pty_spawn_failed', details: { systemCode: 'ENOENT' },
  });
});

test('runtime permission mismatch emits its own phase before stopping', async (t) => {
  const f = fixture(t);
  const phases = [];
  await assert.rejects(executeBoundCliThread({ ...f, threadId, requestId, prompt,
    pollMs: 1, spawn: fakeSpawn({}, () => appendTurn(f, { sandbox: 'read-only' })),
    onPhase: (phase) => phases.push(phase),
  }), (error) => {
    assert.equal(error.reasonCode, 'CLI_PERMISSION_MISMATCH');
    return true;
  });
  assert.equal(phases.at(-1), 'runtime_permissions_mismatch');
});

test('early exit exposes exit code and a redacted current-screen classification', async (t) => {
  const f = fixture(t);
  const phases = [];
  const snapshots = [];
  await assert.rejects(executeBoundCliThread({ ...f, threadId, requestId, prompt,
    pollMs: 1,
    spawn: fakeSpawn({}, ({ data, exit }) => {
      data('Error token=never-output');
      exit({ exitCode: 7 });
    }),
    onPhase: (phase, details) => phases.push({ phase, details }),
    onTerminalSnapshot: (snapshot) => snapshots.push(snapshot),
  }), (error) => {
    assert.equal(error.reasonCode, 'CLI_CHILD_EXITED');
    return true;
  });
  assert.deepEqual(phases.at(-1), { phase: 'pty_exited', details: { exitCode: 7 } });
  assert.equal(snapshots.at(-1).event, 'child_exited');
  assert.equal(snapshots.at(-1).classification, 'loading_or_other');
  assert.ok(!JSON.stringify(snapshots).includes('never-output'));
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DesktopNativeDispatcher,
  buildCodexNewDeepLink,
  buildDesktopNativePrompt,
  createDesktopNativeMarker,
  findDesktopNativeSession,
  isDesktopNativeSessionMeta,
} from '../src/desktop-native-dispatch.mjs';

function makeSession(root, {
  id = '00000000-3538-7000-8000-46c9a76ce73d',
  sessionId = id,
  marker = 'FEISHU-NATIVE-RQ-20260930-TEST-abc123',
  prompt = `Native prompt ${marker}`,
  workspace = 'O:\\背调',
  originator = 'codex_work_desktop',
  source = 'vscode',
  threadSource = 'user',
  timestamp = '2026-09-30T13:15:08.131Z',
  recordedAt = '2026-09-30T13:15:08.500Z',
  completed = false,
  unrelatedMarker = false,
} = {}) {
  const file = path.join(root, `rollout-${id}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: recordedAt,
      type: 'session_meta',
      payload: {
        id,
        session_id: sessionId,
        cwd: workspace,
        originator,
        source,
        thread_source: threadSource,
        timestamp,
      },
    }),
  ];
  if (unrelatedMarker) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        output: `unrelated ${marker}`,
      },
    }));
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `base instructions ${marker}` }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ['agents_md.instructions'],
        },
      },
    }));
  }
  lines.push(JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `${prompt}\n` }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['user.text'],
      },
    },
  }));
  if (completed) {
    lines.push(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: `OK ${marker}`, turn_id: 'turn-1' },
    }));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

test('marker avoids Markdown-sensitive underscores', () => {
  const marker = createDesktopNativeMarker('RQ-20260930-TEST', 'abc_123');
  assert.equal(marker, 'FEISHU-NATIVE-RQ-20260930-TEST-abc123');
  assert.equal(marker.includes('_'), false);
});

test('native prompt and deep link preserve the batch identity', () => {
  const instruction = 'O:\\背调\\state\\native\\RQ-TEST.md';
  const digest = crypto.createHash('sha256').update('task').digest('hex');
  const prompt = buildDesktopNativePrompt({
    requestId: 'RQ-TEST',
    threadTitle: '飞书背调测试',
    marker: 'FEISHU-NATIVE-RQ-TEST-abc123',
    instructionPath: instruction,
    instructionSha256: digest,
  });
  assert.match(prompt, /FEISHU-NATIVE-RQ-TEST-abc123/u);
  assert.match(prompt, /RQ-TEST\.md/u);
  const deepLink = buildCodexNewDeepLink({ workspace: 'O:\\背调', prompt });
  assert.match(deepLink, /^codex:\/\/new\?/u);
  assert.equal(new URL(deepLink).searchParams.get('prompt'), prompt);
});

test('session metadata accepts only a desktop-owned user thread in the workspace', () => {
  const base = {
    id: '00000000-3538-7000-8000-46c9a76ce73d',
    cwd: 'O:\\背调',
    originator: 'codex_work_desktop',
    source: 'vscode',
    thread_source: 'user',
    timestamp: '2026-09-30T13:15:08.131Z',
  };
  assert.equal(isDesktopNativeSessionMeta(base, { workspace: 'O:\\背调' }), true);
  assert.equal(isDesktopNativeSessionMeta({ ...base, originator: 'Codex Desktop' }, {
    workspace: 'O:\\背调',
  }), true);
  assert.equal(isDesktopNativeSessionMeta({ ...base, originator: 'codex-tui' }, {
    workspace: 'O:\\背调',
  }), false);
  assert.equal(isDesktopNativeSessionMeta({ ...base, source: 'exec' }, {
    workspace: 'O:\\背调',
  }), false);
  assert.equal(isDesktopNativeSessionMeta({ ...base, cwd: 'C:\\wrong' }, {
    workspace: 'O:\\背调',
  }), false);
  assert.equal(isDesktopNativeSessionMeta({
    ...base,
    session_id: '00000000-8a54-7000-8000-ec6ec458b987',
  }, { workspace: 'O:\\背调' }), false);
});

test('recovery discovery ignores marked historical files written before the draft opened', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-recovery-date-test-'));
  const marker = 'FEISHU-NATIVE-RQ-20260930-TEST-abc123';
  const prompt = `Native prompt ${marker}`;
  try {
    const old = makeSession(root, {
      id: '00000000-db0f-7000-8000-2954bbc8f2c3', marker, prompt: 'old wrong prompt',
    });
    fs.utimesSync(old, new Date('2026-09-30T12:00:00Z'), new Date('2026-09-30T12:00:00Z'));
    makeSession(root, {
      id: '00000000-2810-7000-8000-2b5ab74f6a8a', marker, prompt,
      originator: 'Codex Desktop',
    });
    const found = findDesktopNativeSession({
      sessionsRoot: root, marker, expectedPrompt: prompt, workspace: 'O:\\背调',
      notBeforeMs: Date.parse('2026-09-30T13:15:08Z'),
    });
    assert.equal(found.meta.id, '00000000-2810-7000-8000-2b5ab74f6a8a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous UI acknowledgement never invokes Send again and requires session evidence', async () => {
  const marker = 'FEISHU-NATIVE-RQ-20260930-TEST-abc123';
  const base = {
    requestId: 'RQ-20260930-TEST', threadTitle: 'Native test', workspace: 'O:\\背调',
    instructionPath: 'O:\\背调\\state\\native\\RQ-TEST.md',
    instructionSha256: 'a'.repeat(64), marker,
    sessionsRoot: 'unused', discoveryTimeoutMs: 1,
  };
  for (const errorText of [
    'draft was not loaded', 'Send button is disabled', 'guarded window changed',
  ]) {
    let launches = 0;
    let submissions = 0;
    const dispatcher = new DesktopNativeDispatcher({
      launch: async () => { launches += 1; },
      submit: async () => { submissions += 1; throw new Error(errorText); },
      listSessions: () => [], findSession: () => null, wait: async () => {},
    });
    await assert.rejects(dispatcher.dispatch(base), /inspect the draft before retrying/u);
    assert.equal(launches, 1);
    assert.equal(submissions, 1);
  }
  let submissions = 0;
  const recovered = new DesktopNativeDispatcher({
    launch: async () => {},
    submit: async () => { submissions += 1; throw new Error('acknowledgement lost'); },
    listSessions: () => [],
    findSession: () => ({
      meta: {
        id: '00000000-21ff-7000-8000-b6aac0d6660b', source: 'vscode',
        originator: 'Codex Desktop', thread_source: 'user',
      },
      filePath: 'verified-session.jsonl',
    }),
  });
  const result = await recovered.dispatch(base);
  assert.equal(submissions, 1);
  assert.equal(result.ui.recoveredAfterSubmitError, true);
});

test('session discovery fails closed on an invalid or duplicate marked session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-test-'));
  const marker = 'FEISHU-NATIVE-RQ-20260930-TEST-abc123';
  const expectedPrompt = `Native prompt ${marker}`;
  try {
    makeSession(root, { marker, prompt: expectedPrompt });
    const found = findDesktopNativeSession({
      sessionsRoot: root,
      marker,
      expectedPrompt,
      workspace: 'O:\\背调',
      notBeforeMs: Date.parse('2026-09-30T13:15:08.000Z'),
    });
    assert.equal(found.meta.originator, 'codex_work_desktop');

    makeSession(root, {
      id: '00000000-8a54-7000-8000-ec6ec458b987',
      marker,
      prompt: expectedPrompt,
    });
    assert.throws(() => findDesktopNativeSession({
      sessionsRoot: root,
      marker,
      expectedPrompt,
      workspace: 'O:\\背调',
    }), /appeared in 2 Codex sessions/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session discovery rejects a marker outside the submitted user prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-marker-test-'));
  const marker = 'FEISHU-NATIVE-RQ-20260930-TEST-abc123';
  const expectedPrompt = `Native prompt ${marker}`;
  try {
    makeSession(root, {
      marker,
      prompt: 'an unrelated user prompt',
      unrelatedMarker: true,
    });
    assert.throws(() => findDesktopNativeSession({
      sessionsRoot: root,
      marker,
      expectedPrompt,
      workspace: 'O:\\背调',
    }), /invalid Codex session/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session discovery rejects a wrong full prompt and mismatched metadata ids', () => {
  const marker = 'FEISHU-NATIVE-RQ-20260930-TEST-abc123';
  const expectedPrompt = `Native prompt ${marker}`;

  const wrongPromptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-prompt-test-'));
  try {
    makeSession(wrongPromptRoot, { marker, prompt: `${expectedPrompt} altered` });
    assert.throws(() => findDesktopNativeSession({
      sessionsRoot: wrongPromptRoot,
      marker,
      expectedPrompt,
      workspace: 'O:\\背调',
    }), /invalid Codex session/u);
  } finally {
    fs.rmSync(wrongPromptRoot, { recursive: true, force: true });
  }

  const mismatchedIdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-id-test-'));
  try {
    makeSession(mismatchedIdRoot, {
      marker,
      prompt: expectedPrompt,
      sessionId: '00000000-8a54-7000-8000-ec6ec458b987',
    });
    assert.throws(() => findDesktopNativeSession({
      sessionsRoot: mismatchedIdRoot,
      marker,
      expectedPrompt,
      workspace: 'O:\\背调',
    }), /invalid Codex session/u);
  } finally {
    fs.rmSync(mismatchedIdRoot, { recursive: true, force: true });
  }
});

test('dispatcher launches, submits, binds the unique native session, then reads completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-dispatch-test-'));
  const marker = 'FEISHU-NATIVE-RQ-20260930-TEST-abc123';
  const calls = [];
  let sessionPath;
  try {
    const dispatcher = new DesktopNativeDispatcher({
      launch: async (deepLink) => { calls.push(['launch', deepLink]); },
      submit: async ({ prompt, marker: submittedMarker }) => {
        calls.push(['submit', submittedMarker, prompt]);
        sessionPath = makeSession(root, { marker, prompt, completed: true });
        return { invoked: true, marker: submittedMarker };
      },
      wait: async () => {},
      now: () => Date.parse('2026-09-30T13:15:08.000Z'),
    });
    const result = await dispatcher.dispatch({
      requestId: 'RQ-20260930-TEST',
      threadTitle: '飞书背调测试',
      workspace: 'O:\\背调',
      instructionPath: 'O:\\背调\\state\\native\\RQ-TEST.md',
      instructionSha256: 'a'.repeat(64),
      marker,
      sessionsRoot: root,
      discoveryTimeoutMs: 1_000,
    });
    assert.equal(result.threadId, '00000000-3538-7000-8000-46c9a76ce73d');
    assert.deepEqual(calls.map(([name]) => name), ['launch', 'submit']);
    const completion = await dispatcher.waitForCompletion({
      sessionPath,
      marker,
      timeoutMs: 1_000,
    });
    assert.equal(completion.finalResponse, `OK ${marker}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

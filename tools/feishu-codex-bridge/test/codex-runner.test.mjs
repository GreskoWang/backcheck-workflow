import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildExecutionPrompt,
  buildExecutionThreadTitle,
  formatAcceptanceReply,
  formatCompletedJobReply,
  formatDispatchScope,
  formatFailedJobReply,
  getExecutionThreadPlan,
  isThreadRecoveryError,
  runBackgroundCheck,
} from '../src/codex-runner.mjs';

test('creates a recognizable per-request title and embeds the batch boundary', () => {
  const job = {
    requestId: 'RQ-20260929-000000-SYNTH663DC615',
    requestText: 'dispatch body',
    createdAt: '2026-09-29T13:54:03.168Z',
  };
  const scope = {
    decision: 'execute',
    assignments: [
      { code: 'TS', itemNumbers: ['1'], subject: '合成主体020' },
      { code: 'TS1', itemNumbers: ['1'], subject: "she's green" },
      { code: '临A', itemNumbers: ['3'], subject: '合成主体002' },
      { code: '临H', itemNumbers: ['3'], subject: '合成主体016' },
    ],
  };
  const title = buildExecutionThreadTitle(job, scope);
  assert.equal(
    title,
    "飞书背调 2026-09-29｜合成主体020、she's green 等4项｜RQ-20260929-000000-SYNTH663DC615",
  );
  const prompt = buildExecutionPrompt(job, scope, { threadTitle: title });
  assert.match(prompt, /^# 飞书背调 2026-09-29/u);
  assert.match(prompt, /本对话只允许处理请求 RQ-20260929-000000-SYNTH663DC615/u);
  assert.match(prompt, /任何其他 requestId 都必须由桥接器创建新的 Codex 对话/u);
  assert.match(prompt, /mcp__codex_app__set_thread_title/u);
  assert.match(prompt, new RegExp(job.requestId, 'u'));
});

test('thread title count follows assignment rows even when subjects repeat', () => {
  const title = buildExecutionThreadTitle({
    requestId: 'RQ-20260930-000000-SYNTH88CE4552',
  }, {
    assignments: [
      { code: 'TS', subject: '同一对象' },
      { code: 'TS', subject: '同一对象' },
      { code: 'TS1', subject: '第三对象' },
    ],
  });
  assert.equal(
    title,
    '飞书背调 2026-09-30｜同一对象、同一对象 等3项｜RQ-20260930-000000-SYNTH88CE4552',
  );
});

test('only resumes a thread whose persisted owner is the same request id', () => {
  assert.deepEqual(getExecutionThreadPlan({
    requestId: 'RQ-NEW',
    codexThreadId: null,
    codexThreadRequestId: 'RQ-NEW',
  }), {
    requestId: 'RQ-NEW', threadId: null, resuming: false,
  });
  assert.deepEqual(getExecutionThreadPlan({
    requestId: 'RQ-SAME',
    codexThreadId: 'thread-same',
    codexThreadRequestId: 'RQ-SAME',
  }), {
    requestId: 'RQ-SAME', threadId: 'thread-same', resuming: true,
  });
  assert.throws(
    () => getExecutionThreadPlan({
      requestId: 'RQ-NEXT',
      codexThreadId: 'thread-old',
      codexThreadRequestId: 'RQ-OLD',
    }),
    /cannot resume thread owned by RQ-OLD/,
  );
  assert.throws(
    () => getExecutionThreadPlan({
      requestId: 'RQ-UNVERIFIED',
      codexThreadId: 'thread-unverified',
    }),
    /has no verified ownership/,
  );
});

test('acceptance is the only group-facing job message and lists every owned request', () => {
  const text = formatAcceptanceReply({
    decision: 'execute',
    assignments: [
      { code: 'TS', itemNumbers: ['1'], subject: '合成主体020' },
      { code: 'TS1', itemNumbers: ['1'], subject: "she's green" },
      { code: '临A', itemNumbers: ['3'], subject: '合成主体002' },
      { code: '临H', itemNumbers: ['3'], subject: '合成主体016' },
    ],
  }, 'RQ-ACCEPT');
  assert.match(text, /^已接单：RQ-ACCEPT/);
  assert.match(text, /全组派单（代号 → 编号 → 对象）：/);
  assert.match(text, /TS → 1 → 合成主体020/);
  assert.match(text, /TS1 → 1 → she's green/);
  assert.match(text, /临A → 3 → 合成主体002/);
  assert.match(text, /临H → 3 → 合成主体016/);
  assert.doesNotMatch(text, /已完成|执行失败|仍在执行/);
});

test('acceptance lists the full team map while execution assignments remain owned-only', () => {
  const scope = {
    decision: 'execute',
    assignments: [{ code: 'TS', itemNumbers: ['1'], subject: '合成主体020' }],
    receiptAssignments: [
      { code: 'TS', itemNumbers: ['1'], subject: '合成主体020' },
      { code: 'TS2', itemNumbers: ['1'], subject: '合成主体015' },
      { code: '小谢', itemNumbers: ['3'], subject: '合成主体014' },
      { code: '临J', itemNumbers: ['5'], subject: '合成主体012' },
    ],
  };
  const text = formatAcceptanceReply(scope, 'RQ-FULL');
  assert.match(text, /TS → 1 → 合成主体020/);
  assert.match(text, /TS2 → 1 → 合成主体015/);
  assert.match(text, /小谢 → 3 → 合成主体014/);
  assert.match(text, /临J → 5 → 合成主体012/);
  assert.deepEqual(scope.assignments.map((item) => item.subject), ['合成主体020']);
});

test('formats every numbered owned object as a separate mapping row', () => {
  const text = formatDispatchScope({
    decision: 'execute',
    requestMode: 'team_dispatch',
    assignments: [
      { code: 'TS', itemNumbers: ['1'], subject: '甲', anchors: [], sourceBlock: '第一块' },
      { code: 'TS', itemNumbers: ['2'], subject: '乙', anchors: [], sourceBlock: '第一块' },
      { code: 'TS1', itemNumbers: ['3'], subject: '丙', anchors: [], sourceBlock: '第一块' },
    ],
    ambiguousItems: [],
    deadline: '',
    reason: '每人两个',
  }, 'RQ-1');
  assert.match(text, /TS → 1 → 甲/);
  assert.match(text, /TS → 2 → 乙/);
  assert.match(text, /TS1 → 3 → 丙/);
});

test('a validated no-owned scope exits before research and reports no Goal', async () => {
  const dispatchScope = {
    decision: 'no_owned_assignment',
    requestMode: 'team_dispatch',
    assignments: [],
    ambiguousItems: [],
    deadline: '9.29 17:00 前',
    reason: 'TS6-TS9 均不属于本机。',
  };
  let receivedScope;
  const result = await runBackgroundCheck({
    requestId: 'RQ-2',
    requestText: 'TS6-TS9',
    dispatchScope,
  }, {}, {
    onScopeResolved(scope) { receivedScope = scope; },
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(receivedScope, { ...dispatchScope, receiptAssignments: [] });
  assert.match(result.finalResponse, /未创建 Goal、未启动背调/);
});

test('scope-only dispatch returns the mapping without starting research', async () => {
  const dispatchScope = {
    decision: 'execute',
    requestMode: 'team_dispatch',
    assignments: [{
      code: '临A', itemNumbers: ['9'], subject: '合成主体011', anchors: [], sourceBlock: '第一块',
    }],
    ambiguousItems: [],
    deadline: '',
    reason: '显式范围展开。',
  };
  const result = await runBackgroundCheck({
    requestId: 'RQ-TEST',
    requestText: '派单测试',
    scopeOnly: true,
    dispatchScope,
  }, {});
  assert.equal(result.skipped, true);
  assert.equal(result.testOnly, true);
  assert.match(result.finalResponse, /临A → 9 → 合成主体011/);
  assert.match(result.finalResponse, /未创建 Goal、未启动调查/);
});

test('the single completed reply lists every owned code and request before links', () => {
  const scope = {
    decision: 'execute',
    assignments: [
      { code: 'TS', itemNumbers: ['1'], subject: '合成主体020' },
      { code: 'TS1', itemNumbers: ['1'], subject: "she's green" },
      { code: '临A', itemNumbers: ['3'], subject: '合成主体002' },
      { code: '临H', itemNumbers: ['3'], subject: '合成主体016' },
    ],
  };
  const text = formatCompletedJobReply(scope, 'RQ-3', '核心结论\nhttps://example.feishu.cn/docx/abc123');
  assert.match(text, /^RQ-3 已完成。/);
  assert.match(text, /TS → 1 → 合成主体020/);
  assert.match(text, /TS1 → 1 → she's green/);
  assert.match(text, /临A → 3 → 合成主体002/);
  assert.match(text, /临H → 3 → 合成主体016/);
  assert.match(text, /https:\/\/example\.feishu\.cn\/docx\/abc123/);
  for (const row of [
    'TS → 1 → 合成主体020',
    "TS1 → 1 → she's green",
    '临A → 3 → 合成主体002',
    '临H → 3 → 合成主体016',
  ]) {
    assert.equal(text.split(row).length - 1, 1);
  }
});

test('the single failure reply still lists resolved owned requests', () => {
  const scope = {
    decision: 'execute',
    assignments: [{ code: 'TS', itemNumbers: ['1'], subject: '合成主体020' }],
  };
  const text = formatFailedJobReply(scope, 'RQ-4', 'temporary failure');
  assert.match(text, /TS → 1 → 合成主体020/);
  assert.match(text, /原因：temporary failure/);
});

test('completion requires a Feishu artifact link', () => {
  const scope = {
    decision: 'execute',
    assignments: [{ code: 'TS', itemNumbers: ['1'], subject: '合成主体020' }],
  };
  assert.throws(
    () => formatCompletedJobReply(scope, 'RQ-5', '研究结束但没有链接'),
    /未返回可交付的飞书成品链接/,
  );
});

test('non-execution terminal replies always include a mapping section', () => {
  const noOwned = formatDispatchScope({
    decision: 'no_owned_assignment', assignments: [], ambiguousItems: [], reason: '无本机任务',
  }, 'RQ-6');
  assert.match(noOwned, /TS → — → 无任务/);
  assert.match(noOwned, /BK2 → — → 无任务/);

  const failed = formatFailedJobReply(null, 'RQ-7', 'preflight error');
  assert.match(failed, /— → — → 预检失败，未能建立映射/);
});

function executionScope() {
  return {
    decision: 'execute',
    requestMode: 'team_dispatch',
    assignments: [{
      code: 'TS', itemNumbers: ['1'], subject: '测试对象', anchors: [], sourceBlock: '第一块',
    }],
    receiptAssignments: [{
      code: 'TS', itemNumbers: ['1'], subject: '测试对象', sourceBlock: '第一块',
    }],
    ambiguousItems: [],
    deadline: '',
    reason: 'test',
  };
}

function nativeConfig(stateDir) {
  return {
    workspace: 'O:\\背调',
    stateDir,
    codexDispatchMode: 'desktop_native_v1',
    codexSandboxMode: 'danger-full-access',
    codexReasoningEffort: 'max',
    codexNativeDiscoveryTimeoutMs: 1_000,
    codexNativeCompletionTimeoutMs: 1_000,
  };
}

test('new requests bind and monitor one desktop-owned native thread', async () => {
  const calls = [];
  const threadId = '00000000-1aef-7000-8000-02f54ca31c1c';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runner-new-'));
  try {
    const result = await runBackgroundCheck({
      requestId: 'RQ-20260930-000000-SYNTH43366841',
      requestText: '测试派单',
      dispatchScope: executionScope(),
      codexThreadId: null,
      codexThreadRequestId: 'RQ-20260930-000000-SYNTH43366841',
    }, nativeConfig(stateDir), {
      onThreadBootstrapStarting(_scope, metadata) {
        calls.push('native-start');
        assert.equal(metadata.creationMode, 'desktop_native_v1');
        assert.equal(fs.existsSync(metadata.instructionPath), true);
      },
      onThreadBootstrapped(boundThreadId, metadata) {
        assert.equal(boundThreadId, threadId);
        assert.equal(metadata.originator, 'codex_work_desktop');
        calls.push(`bind:${boundThreadId}`);
      },
      onExecutionStarting() { calls.push('execution-start'); },
      desktopDispatcher: {
        async dispatch(options) {
          calls.push('dispatch');
          assert.match(options.marker, /^FEISHU-NATIVE-RQ-20260930-000000-SYNTH43366841-/u);
          return {
            threadId,
            sessionPath: 'C:\\sessions\\native.jsonl',
            source: 'vscode',
            originator: 'codex_work_desktop',
            threadSource: 'user',
            marker: options.marker,
          };
        },
        async waitForCompletion() {
          calls.push('monitor');
          return {
            finalResponse: '完成 https://x.feishu.cn/docx/abc',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    });

    assert.equal(result.threadId, threadId);
    assert.deepEqual(calls, [
      'native-start',
      'dispatch',
      `bind:${threadId}`,
      'execution-start',
      'monitor',
    ]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('same-request native recovery only monitors the already bound desktop thread', async () => {
  const calls = [];
  const threadId = '00000000-0ea7-7000-8000-14ebf2ed466e';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runner-recovery-'));
  try {
    await runBackgroundCheck({
      requestId: 'RQ-RECOVERY',
      requestText: '恢复',
      dispatchScope: executionScope(),
      codexThreadId: threadId,
      codexThreadRequestId: 'RQ-RECOVERY',
      codexThreadCreationMode: 'desktop_native_v1',
      codexThreadSource: 'vscode',
      codexThreadOriginator: 'codex_work_desktop',
      codexNativeSessionPath: 'C:\\sessions\\native.jsonl',
      codexNativeDispatchMarker: 'FEISHU-NATIVE-RQ-RECOVERY-abc123',
    }, nativeConfig(stateDir), {
      desktopDispatcher: {
        async dispatch() { throw new Error('recovery must not dispatch'); },
        async waitForCompletion(options) {
          calls.push(`monitor:${options.sessionPath}`);
          return { finalResponse: '完成 https://x.feishu.cn/docx/def' };
        },
      },
    });
    assert.deepEqual(calls, ['monitor:C:\\sessions\\native.jsonl']);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a verified legacy CLI thread resumes only its own request through the CLI', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-runner-legacy-'));
  const threadId = '00000000-8033-7000-8000-2a056200c4a3';
  try {
    const result = await runBackgroundCheck({
      requestId: 'RQ-LEGACY', requestText: '恢复', dispatchScope: executionScope(),
      codexThreadId: threadId, codexThreadRequestId: 'RQ-LEGACY',
      codexThreadSource: 'cli', codexThreadOriginator: 'codex-tui',
      codexCliSessionPath: 'C:\\sessions\\legacy.jsonl',
    }, nativeConfig(stateDir), {
      bootstrapVisibleThread() { throw new Error('must not create a second thread'); },
      executeBoundCliThread({ threadId: id, requestId, prompt, sessionPath }) {
        assert.equal(id, threadId);
        assert.equal(requestId, 'RQ-LEGACY');
        assert.equal(sessionPath, 'C:\\sessions\\legacy.jsonl');
        assert.match(prompt, /RQ-LEGACY/u);
        return { threadId, finalResponse: '报告 https://x.feishu.cn/docx/abc' };
      },
    });
    assert.equal(result.threadId, threadId);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('new requests bind a CLI thread durably before CLI continuation', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-runner-new-'));
  const threadId = '00000000-89d1-7000-8000-1b9f8b31589b';
  const calls = [];
  try {
    const result = await runBackgroundCheck({
      requestId: 'RQ-CLI-NEW', requestText: '团队派单',
      dispatchScope: executionScope(), codexThreadRequestId: 'RQ-CLI-NEW',
    }, { ...nativeConfig(stateDir), codexDispatchMode: 'cli_visible_v1' }, {
      onThreadBootstrapStarting() { calls.push('starting'); },
      bootstrapVisibleThread({ inputMode }) {
        assert.equal(inputMode, 'startup_argument_no_keys');
        calls.push('bootstrap');
        return { threadId, sessionPath: 'C:\\sessions\\cli.jsonl', source: 'cli', originator: 'codex-tui' };
      },
      onThreadBootstrapped(id) { assert.equal(id, threadId); calls.push('bound'); },
      onExecutionStarting() { calls.push('executing'); },
      executeBoundCliThread({ threadId: id, sessionPath, prompt }) {
        assert.equal(id, threadId);
        assert.equal(sessionPath, 'C:\\sessions\\cli.jsonl');
        assert.match(prompt, /review-evidence/u);
        calls.push('resume');
        return { threadId, finalResponse: '报告 https://x.feishu.cn/docx/abc' };
      },
    });
    assert.equal(result.threadId, threadId);
    assert.deepEqual(calls, ['starting', 'bootstrap', 'bound', 'executing', 'resume']);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('CLI continuation failure after binding requires local review', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-runner-timeout-'));
  const threadId = '00000000-e9da-7000-8000-37c763bab99f';
  try {
    await assert.rejects(runBackgroundCheck({
      requestId: 'RQ-CLI-TIMEOUT', requestText: '团队派单',
      dispatchScope: executionScope(), codexThreadId: threadId,
      codexThreadRequestId: 'RQ-CLI-TIMEOUT',
      codexThreadSource: 'cli', codexThreadOriginator: 'codex-tui',
      codexCliSessionPath: 'C:\\sessions\\timeout.jsonl',
    }, { ...nativeConfig(stateDir), codexDispatchMode: 'cli_visible_v1' }, {
      bootstrapVisibleThread() { throw new Error('must not create another thread'); },
      executeBoundCliThread({ threadId: id }) {
        assert.equal(id, threadId);
        throw new Error('simulated timeout');
      },
    }), (error) => error.code === 'CLI_EXECUTION_REVIEW_REQUIRED');
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});
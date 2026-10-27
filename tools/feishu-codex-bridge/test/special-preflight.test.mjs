import { fixturePath } from './fixture-paths.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { prepareSpecialIncoming, validateSpecialResearchJob, SPECIAL_EXTRACTION_SCHEMA } from '../src/special-preflight.mjs';
import { buildExecutionPrompt, runBackgroundCheck } from '../src/codex-runner.mjs';

const chatId = 'oc_19936593f3ad5a63b1e86ee0f8c44fc8';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const extraction = () => ({ decision: 'ready', requestType: 'public_video_research', subjects: ['游戏甲', '游戏乙'],
  requirements: { objective: '审阅指定公开视频并整理事实和时间点', deliverables: ['事实表', '时间点表'],
    sourceUrls: ['https://example.com/public-video'], timeframe: '用户指定视频', constraints: ['逐个视频'], reviewNeeds: ['事实与时间点对应'] },
  unreadableImageIndexes: [], ambiguities: [], publicSourcesOnly: true });

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'special-preflight-'));
  try {
    const groupPolicy = { chatId, role: 'special_dispatch', enabled: true, activationFromMs: 1000,
      researchEnabled: true, authorizationRef: 'user-special-group',
      defaultOwner: { id: 'wangshukun', name: '王书鲲', authorizationRef: 'user-20261026-024021-special-default-owner' } };
    const message = { chatId, messageId: 'om_special', createTime: 2000, rawContentType: 'post', content: '【特殊背调】',
      resources: [{ type: 'image', fileKey: 'img_one' }, { type: 'image', fileKey: 'img_two' }] };
    const calls = { downloads: [], starts: [], runs: [], factories: [] };
    const client = { im: { v1: { messageResource: { async get(args) {
      calls.downloads.push(args); return { getReadableStream: () => Readable.from([png]) };
    } } } } };
    const createCodex = (options) => {
      calls.factories.push(options);
      return { startThread(options) {
        calls.starts.push(options);
        return { async run(input, options) { calls.runs.push({ input, options });
          return { finalResponse: JSON.stringify(extraction()), items: [{ type: 'agent_message' }], usage: { input_tokens: 100 } }; } };
      } };
    };
    await run({ root, groupPolicy, message, client, createCodex, calls,
      args: { message, groupPolicy, stateDir: root, client, createCodex, preflightModel: 'test-structured-model' } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function makeJob(prepared, message) {
  return { requestId: 'RQ-SPECIAL-TEST', workflowKind: 'special_research', chatId,
    sourceMessageId: message.messageId, sourceMessageCreatedAtMs: message.createTime,
    requestText: prepared.requestText, specialIntake: prepared.specialIntake,
    specialOwnership: prepared.specialOwnership, pricing: prepared.pricing,
    codexThreadId: null, codexThreadRequestId: 'RQ-SPECIAL-TEST' };
}

test('reads every actual image through the original message resource endpoint and submits local_image inputs', async () => fixture(async (f) => {
  const result = await prepareSpecialIncoming(f.args);
  assert.equal(result.status, 'ready');
  assert.equal(result.workflowKind, 'special_research');
  assert.equal(result.pricing.status, 'pending_pricing');
  assert.equal(result.scope.assignments.length, 2);
  assert.ok(result.scope.assignments.every((item) => item.code === 'SPECIAL_OWNER'));
  assert.deepEqual(f.calls.downloads.map((x) => [x.path.message_id, x.path.file_key, x.params.type]), [
    ['om_special', 'img_one', 'image'], ['om_special', 'img_two', 'image'],
  ]);
  assert.equal(f.calls.runs[0].input.filter((item) => item.type === 'local_image').length, 2);
  assert.equal(f.calls.runs[0].options.outputSchema, SPECIAL_EXTRACTION_SCHEMA);
  assert.equal(f.calls.starts[0].sandboxMode, 'read-only');
  assert.equal(f.calls.starts[0].networkAccessEnabled, false);
  assert.equal(f.calls.starts[0].webSearchMode, 'disabled');
  assert.ok(f.calls.factories[0].configOverrides.includes('features.shell_tool=false'));
  assert.ok(f.calls.factories[0].configOverrides.includes('mcp_servers={}'));
  const expectedHash = crypto.createHash('sha256').update(png).digest('hex');
  assert.ok(result.attachments.every((item) => item.sha256 === expectedHash && fs.existsSync(item.localPath)));
  const validated = validateSpecialResearchJob(makeJob(result, f.message), { groupPolicies: [f.groupPolicy], stateDir: f.root });
  assert.equal(validated.scope.assignments[0].ownerId, 'wangshukun');
}));

test('a failed image read holds the entire image-dependent request and never invokes the model', async () => fixture(async (f) => {
  f.client.im.v1.messageResource.get = async ({ path: request }) => {
    if (request.file_key === 'img_two') throw new Error('simulated missing access');
    return { getReadableStream: () => Readable.from([png]) };
  };
  const result = await prepareSpecialIncoming(f.args);
  assert.equal(result.status, 'held');
  assert.equal(result.reasons[0].code, 'special_attachment_read_failed');
  assert.equal(f.calls.runs.length, 0);
  assert.equal(result.downloadedAttachments.length, 1);
}));

test('old or inactive special messages cause neither downloads nor model work', async () => fixture(async (f) => {
  f.message.createTime = 999;
  const result = await prepareSpecialIncoming(f.args);
  assert.equal(result.status, 'held');
  assert.equal(result.reasons[0].code, 'special_policy_unverified');
  assert.equal(f.calls.downloads.length, 0);
  assert.equal(f.calls.runs.length, 0);
}));

test('model-reported unreadable images or tool activity never become executable scope', async () => fixture(async (f) => {
  for (const type of ['unreadable', 'tool']) {
    const data = extraction();
    if (type === 'unreadable') data.unreadableImageIndexes = [1];
    const result = await prepareSpecialIncoming({ ...f.args, createCodex: () => ({ startThread: () => ({
      run: async () => ({ finalResponse: JSON.stringify(data), items: type === 'tool' ? [{ type: 'command_execution' }] : [] }),
    }) }) });
    assert.equal(result.status, 'held');
    assert.equal(result.scope, null);
    assert.equal(result.reasons[0].code, type === 'tool' ? 'special_preflight_tool_activity' : 'special_scope_needs_clarification');
  }
}));

test('tampered image bytes or mismatched default owner blocks execution before any dispatch', async () => fixture(async (f) => {
  const result = await prepareSpecialIncoming(f.args);
  const job = makeJob(result, f.message);
  assert.throws(() => validateSpecialResearchJob(job, { stateDir: f.root,
    groupPolicies: [{ ...f.groupPolicy, defaultOwner: { ...f.groupPolicy.defaultOwner, id: 'other' } }] }), /ownership is unverified/u);
  fs.writeFileSync(result.attachments[0].localPath, 'changed bytes');
  assert.throws(() => validateSpecialResearchJob(job, { stateDir: f.root, groupPolicies: [f.groupPolicy] }), /evidence changed/u);
}));

test('special video research executes its dedicated prompt with pending pricing and preserves final review gate', async () => fixture(async (f) => {
  const prepared = await prepareSpecialIncoming(f.args);
  const job = makeJob(prepared, f.message);
  let prompt, scopeSeen;
  const result = await runBackgroundCheck(job, { stateDir: f.root, workspace: f.root,
    groupPolicies: [f.groupPolicy], codexDispatchMode: 'desktop_native_v1' }, {
    onScopeResolved: (scope) => { scopeSeen = scope; },
    onThreadBootstrapped: async () => {},
    desktopDispatcher: {
      dispatch: async ({ instructionPath }) => { prompt = fs.readFileSync(instructionPath, 'utf8');
        return { threadId: 'special-thread', sessionPath: path.join(f.root, 'fake-session.jsonl') }; },
      waitForCompletion: async () => ({ finalResponse: '公开视频研究与两份表格已整理，等待专项成果审阅。' }),
    },
  });
  assert.ok(scopeSeen.assignments.every((assignment) => assignment.code === 'SPECIAL_OWNER'));
  assert.match(prompt, /public_video_research/u);
  assert.match(prompt, /不把游戏／视频任务改成十四平台人物背调/u);
  assert.match(prompt, /pending_pricing 不影响明确研究/u);
  assert.match(prompt, /本研究对话不得向任何飞书群发送消息/u);
  assert.match(prompt, /sourceDigest/u);
  assert.equal(result.skipped, false);
  assert.equal(result.deliveryEligible, undefined);
  assert.equal(result.deliveryReviewMode, 'special_artifacts_v1');
  assert.equal(result.deliveryReviewStatus, 'pending_specialized_review');
}));

test('ordinary prompt preserves its workflow and adds exact report assignment mapping', () => {
  const prompt = buildExecutionPrompt({ requestId: 'RQ-REGULAR', chatId: 'oc_regular', sourceMessageId: 'om_regular', requestText: '普通背调' },
    { decision: 'execute', assignments: [{ code: 'TS', itemNumbers: ['1'], subject: '主体', sourceBlock: '第1个需求' }] },
    { reviewPath: fixturePath('review.json') });
  assert.match(prompt, /十四平台检查/u);
  assert.match(prompt, /"sourceMessageId":"om_regular"/u);
  assert.match(prompt, /"assignment":\{"sourceBlock"/u);
  assert.match(prompt, /不回填结果群目标文件/u);
});

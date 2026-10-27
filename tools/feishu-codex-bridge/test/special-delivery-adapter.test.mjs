import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { deliveryHash, assignmentKey, SPECIAL_DELIVERY_CHAT } from '../src/delivery-policy.mjs';
import { deliverSpecialCompletedJob } from '../src/delivery-router.mjs';
import { createSpecialDeliveryAdapters } from '../src/special-delivery-adapter.mjs';
import { specialArtifactSourceDigest, assertSpecialArtifactReview, readSpecialRemoteArtifact } from '../src/special-artifacts.mjs';

const now = Date.parse('2026-10-26T06:00:00Z');
const iso = new Date(now).toISOString();
const audience = deliveryHash('approved-synthetic-members');
const changedAudience = deliveryHash('different-synthetic-members');
const hostname = 'synthetic.feishu.cn';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// A real minimal, uncompressed OOXML workbook. Artifact review is injected;
// upload, byte comparison, durable checkpoints and routing are production code.
function workbookBytes() {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Table" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Reviewed value</t></is></c><c r="B1"><v>3</v></c></row></sheetData></worksheet>',
  };
  function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  }
  const body = [], directory = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(content), checksum = crc(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    body.push(local, filename, bytes); directory.push(central, filename); offset += local.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, central, end]);
}

function reviewResult(job, identity) {
  const sourceDigest = specialArtifactSourceDigest(job), manifestDigest = deliveryHash('synthetic-manifest');
  const semanticReview = { verdict: 'PASS', summary: 'Synthetic injected review completed.', issues: [],
    reviewedArtifactIds: ['A1'], reviewedSourceIds: ['U1'], calculations: [], calculationCompleteness: 'no_aggregates', visualChecks: [],
    coverage: job.specialIntake.scope.assignments.flatMap(assignment => job.specialIntake.structuredRequest.requirements.deliverables.map((_, i) => ({
      artifactId: 'A1', deliverableId: `D${i + 1}`, assignmentKey: assignmentKey(assignment), verdict: 'PASS',
      locations: [{ artifactId: 'A1', sheet: 'Table', range: 'A1', blockId: '' }], sourceRefs: ['U1'], reason: 'Synthetic fixture content reviewed.' }))) };
  const semanticDigest = deliveryHash(semanticReview);
  const material = { artifactId: 'A1', ...identity, sourceDigest, manifestDigest,
    assignments: structuredClone(job.specialIntake.scope.assignments) };
  const receipt = { kind: 'special_artifact_review_v1', artifactId: 'A1', verdict: 'PASS',
    ...(material.artifactSha256 ? { artifactSha256: material.artifactSha256 } : {}),
    contentDigest: material.contentDigest,
    materialDigest: deliveryHash({ artifactId: material.artifactId, kind: material.kind, localPath: material.localPath,
      url: material.url, token: material.token, revisionId: material.revisionId, artifactSha256: material.artifactSha256,
      contentDigest: material.contentDigest, assignments: material.assignments }),
    sourceDigest, manifestDigest, semanticDigest,
    reviewModel: 'synthetic-review-model', reviewThreadId: 'synthetic-review-thread', reviewedAt: iso };
  receipt.receiptId = deliveryHash({ ...receipt, receiptId: undefined }); material.receiptId = receipt.receiptId;
  const result = { schemaVersion: 1, verdict: 'PASS', requestId: job.requestId, sourceChatId: job.chatId,
    sourceMessageId: job.sourceMessageId, sourceDigest, manifestDigest, semanticDigest,
    semanticReview, materials: [material], receipts: [receipt] };
  assertSpecialArtifactReview(result, job); // Actual pure validator, never mocked.
  return result;
}

async function fixture(t, kind = 'local_csv') {
  const workspace = fs.mkdtempSync(path.join(process.env.BRIDGE_TEST_TMP || os.tmpdir(), 'special-delivery-'));
  const stateDir = path.join(workspace, 'state'); fs.mkdirSync(stateDir);
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let store = new DeliveryStore(stateDir);
  const assignment = { sourceBlock: '专项需求', code: 'SPECIAL_OWNER', itemNumbers: [], subject: 'Synthetic public game videos' };
  const job = { requestId: 'RQ-SYNTHETIC-SPECIAL', sourceMessageId: 'om_synthetic_order', sourceMessageCreatedAtMs: now,
    chatId: SPECIAL_DELIVERY_CHAT, status: 'completed', codexThreadId: 'synthetic-research-thread', codexThreadRequestId: 'RQ-SYNTHETIC-SPECIAL',
    deliveryKind: 'special', deliveryReviewMode: 'special_artifacts_v1', deliveryEligible: true,
    dispatchScope: { assignments: [assignment] },
    specialOwnership: { ownerId: 'synthetic-owner', authorization: 'synthetic-owner-rule', sourceChatId: SPECIAL_DELIVERY_CHAT,
      sourceMessageId: 'om_synthetic_order', verified: true },
    specialIntake: { scope: { assignments: [assignment] }, attachments: [], attachmentIdentity: deliveryHash([]),
      preflightProof: { digest: deliveryHash('synthetic-preflight') },
      structuredRequest: { requestType: 'public_video_research', sourceText: 'Synthetic table request', requirements: { deliverables: ['A verified table'] } } } };
  const policy = { enabled: true, chatId: SPECIAL_DELIVERY_CHAT, activationFromMs: now - 1000, authorization: 'synthetic-explicit-route',
    tenantKey: 'synthetic-tenant', expectedExternal: true, allowedHostnames: [hostname], allowedAudienceFingerprints: [audience],
    owner: { id: 'synthetic-owner', name: 'Synthetic owner', authorization: 'synthetic-owner-rule' } };
  const config = { delivery: { special: policy }, stateDir, workspace,
    specialArtifactReview: { enabled: true, model: 'synthetic-review-model', allowedHostnames: [hostname] } };
  const counts = { upload: 0, send: 0, download: 0, appRead: 0, userRead: 0, review: 0, group: 0 };
  const state = { audience, sent: [], uploadBytes: null, sendMode: 'normal', uploadMode: 'normal', visible: true,
    wrongResource: false, groupAfterUpload: null, remoteChanged: false, unexpectedMember: false, noRemoteAccess: false };
  const group = () => ({ chatId: SPECIAL_DELIVERY_CHAT, tenantKey: 'synthetic-tenant', external: true,
    canSend: true, membersComplete: true, memberCount: 1, audienceFingerprint: state.audience,
    members: [{ member_id: 'ou_synthetic_member' }], observedAt: iso });
  const rawRemoteRead = async ({ url, method, params }) => {
    assert.equal(method, 'GET'); counts.userRead++;
    if (url === '/open-apis/sheets/v3/spreadsheets/SyntheticSheet') return { code: 0, data: { spreadsheet: { title: 'Synthetic table' } } };
    if (url.endsWith('/sheets/query')) return { code: 0, data: { sheets: [{ sheet_id: 'S1', title: 'Table', grid_properties: { row_count: 1, column_count: 1 } }] } };
    if (url.includes('/values/')) {
      assert.ok(['Formula','UnformattedValue'].includes(params.valueRenderOption));
      return { code: 0, data: { revision: 17, valueRange: { values: [[state.remoteChanged ? 'Changed' : 'Reviewed value']] } } };
    }
    if (url.endsWith('/public')) return { code: 0, data: { permission_public: { link_share_entity: 'tenant_readable', external_access_entity: 'open' } } };
    if (url.endsWith('/members')) return { code: 0, data: { has_more: false, items: [
      ...(state.noRemoteAccess ? [] : [{ member_type: 'openchat', member_id: SPECIAL_DELIVERY_CHAT, perm: 'view' }]),
      ...(state.unexpectedMember ? [{ member_type: 'openid', member_id: 'ou_unexpected_external', perm: 'view' }] : []),
    ] } };
    throw new Error(`Unexpected readonly mock endpoint ${url}`);
  };
  let identity;
  if (kind === 'feishu_sheet') {
    const remote = await readSpecialRemoteArtifact({ artifact: { artifactType: 'feishu_sheet', url: `https://${hostname}/sheets/SyntheticSheet` },
      config, client: { request: rawRemoteRead } });
    const { snapshot, ...fields } = remote; identity = fields; counts.userRead = 0;
  } else {
    const bytes = kind === 'local_xlsx' ? workbookBytes() : Buffer.from('source,value\nhttps://example.invalid/public-video,3\n');
    const localPath = path.join(workspace, kind === 'local_xlsx' ? 'result.xlsx' : 'result.csv'); fs.writeFileSync(localPath, bytes);
    identity = { kind, localPath, artifactSha256: sha(bytes), contentDigest: deliveryHash('parsed synthetic table') };
  }
  let reviewed = reviewResult(job, identity);
  const appClient = {
    im: { v1: { file: { create: async ({ data }) => {
      counts.upload++;
      const intents = Object.values(store.read().intents); assert.equal(intents.length, 1);
      assert.ok(intents[0].adapterUploadAttemptedAt, 'durable upload attempt precedes external call');
      assert.equal(data.file_type, kind === 'local_xlsx' ? 'xls' : 'stream');
      assert.ok(data.file_name.startsWith(job.requestId)); assert.ok(Buffer.isBuffer(data.file));
      state.uploadBytes = Buffer.from(data.file);
      if (state.groupAfterUpload) state.audience = state.groupAfterUpload;
      if (state.uploadMode === 'lost') throw new Error('Synthetic upload response lost');
      return { code: 0, data: { file_key: 'file_synthetic_uploaded' } };
    } }, messageResource: { get: async ({ path: resource, params }) => {
      counts.download++; assert.equal(params.type, 'file'); assert.equal(resource.file_key, 'file_synthetic_uploaded');
      assert.ok(state.sent.some(item => item.message_id === resource.message_id));
      return { getReadableStream: () => Readable.from([state.wrongResource ? Buffer.from('different bytes') : state.uploadBytes]) };
    } } } },
    request: async input => {
      if (input.method === 'POST') {
        counts.send++; assert.equal(input.url, '/open-apis/im/v1/messages');
        assert.equal(input.params.receive_id_type, 'chat_id'); assert.equal(input.data.receive_id, SPECIAL_DELIVERY_CHAT);
        assert.equal(input.data.msg_type, kind === 'feishu_sheet' ? 'text' : 'file');
        const intent = Object.values(store.read().intents)[0]; assert.ok(intent.adapterMutationAttemptedAt);
        assert.ok(input.data.uuid);
        const item = { message_id: `om_synthetic_result_${counts.send}`, chat_id: SPECIAL_DELIVERY_CHAT, deleted: false,
          msg_type: input.data.msg_type, sender: { sender_type: 'app', id: 'cli_synthetic' }, body: { content: input.data.content } };
        state.sent.push(item);
        if (state.sendMode === 'lost') throw new Error('Synthetic message response lost');
        return { code: 0, data: { message_id: item.message_id } };
      }
      counts.appRead++; assert.equal(input.method, 'GET');
      assert.ok(input.url.startsWith('/open-apis/im/v1/messages'));
      if (input.url === '/open-apis/im/v1/messages') assert.equal(input.params.container_id, SPECIAL_DELIVERY_CHAT);
      return { code: 0, data: { has_more: false, items: state.visible ? structuredClone(state.sent) : [] } };
    },
  };
  let adapters;
  function rebuild() {
    store = new DeliveryStore(stateDir);
    adapters = createSpecialDeliveryAdapters({ baseAdapters: {
      inspectSpecialGroup: async ({ chatId }) => { counts.group++; assert.equal(chatId, SPECIAL_DELIVERY_CHAT); return group(); },
      readBackIntent: async () => { throw new Error('Artifact must not use base readback'); },
    }, appClient, appId: 'cli_synthetic', botOpenId: 'ou_synthetic_bot', config, deliveryStore: store, stateDir, workspace,
    dependencies: { now: () => now, currentToken: async () => 'synthetic-token-never-used-outside-mock',
      reviewSpecialArtifacts: async () => { counts.review++; return structuredClone(reviewed); },
      request: async input => { assert.ok(input.url.startsWith('https://open.feishu.cn/open-apis/'));
        return { status: 200, data: await rawRemoteRead({ ...input, url: new URL(input.url).pathname }) }; } } });
  }
  rebuild();
  return { job, config, state, counts, identity, workspace, stateDir, rebuild,
    run: () => deliverSpecialCompletedJob({ job, config: config.delivery, store, adapters, now: () => now }),
    captureRun: () => { const capturedStore = store, capturedAdapters = adapters;
      return () => deliverSpecialCompletedJob({ job, config: config.delivery, store: capturedStore, adapters: capturedAdapters, now: () => now }); },
    intent: () => Object.values(store.read().intents)[0],
    get reviewed() { return reviewed; }, set reviewed(value) { reviewed = value; } };
}

for (const kind of ['local_csv', 'local_xlsx']) test(`${kind} uploads reviewed bytes, sends one fixed-group file and confirms resource hash`, async t => {
  const f = await fixture(t, kind);
  assert.equal((await f.run()).status, 'delivered');
  assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 1); assert.equal(f.counts.download, 1);
  assert.equal(f.intent().status, 'delivered'); assert.equal(f.intent().adapterUploadedSha256, f.identity.artifactSha256);
  f.rebuild(); assert.equal((await f.run()).status, 'delivered');
  assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 1);
});
test('lost send response reconciles by exact message and downloaded bytes without replay', async t => {
  const f = await fixture(t); f.state.sendMode = 'lost';
  assert.equal((await f.run()).status, 'delivered');
  assert.equal(f.intent().adapterCandidateMessageId, undefined); assert.ok(f.intent().deliveredMessageId);
  f.rebuild(); assert.equal((await f.run()).status, 'delivered');
  assert.equal(f.counts.send, 1); assert.equal(f.counts.upload, 1);
});
test('concurrent router attempts for one durable intent cannot upload or send twice', async t => {
  const f = await fixture(t);
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.counts.upload, 1, 'a concurrent duplicate cannot upload a second file');
  assert.equal(f.counts.send, 1, 'a concurrent duplicate cannot send a second visible message');
  assert.equal((await f.run()).status, 'delivered');
});
test('independent wrappers sharing durable state cannot concurrently upload or send twice', async t => {
  const f = await fixture(t), firstRun = f.captureRun();
  f.rebuild();
  await Promise.all([firstRun(), f.run()]);
  assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 1);
  assert.equal((await f.run()).status, 'delivered');
});
test('absent uncertain message is never resent and can later be read back', async t => {
  const f = await fixture(t); f.state.sendMode = 'lost'; f.state.visible = false;
  assert.equal((await f.run()).status, 'uncertain');
  f.rebuild(); assert.equal((await f.run()).status, 'uncertain');
  assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 1);
  f.state.visible = true; assert.equal((await f.run()).status, 'delivered'); assert.equal(f.counts.send, 1);
});
test('uploaded but never sent resumes only the send after the approved audience is restored', async t => {
  const f = await fixture(t); f.state.groupAfterUpload = changedAudience;
  assert.equal((await f.run()).status, 'uncertain');
  assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 0);
  assert.ok(f.intent().adapterUploadedFileKey); assert.equal(f.intent().adapterMutationAttemptedAt, undefined);
  f.state.audience = audience; f.state.groupAfterUpload = null; f.rebuild();
  assert.equal((await f.run()).status, 'delivered'); assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 1);
});
test('a fresh valid review of unchanged content can resume an uploaded but unsent artifact', async t => {
  const f = await fixture(t); f.state.groupAfterUpload = changedAudience;
  assert.equal((await f.run()).status, 'uncertain'); assert.equal(f.counts.send, 0);
  const receipt = f.reviewed.receipts[0];
  receipt.reviewThreadId = 'synthetic-review-thread-second-pass';
  receipt.reviewedAt = new Date(now + 1000).toISOString();
  receipt.receiptId = deliveryHash({ ...receipt, receiptId: undefined });
  f.reviewed.materials[0].receiptId = receipt.receiptId;
  assertSpecialArtifactReview(f.reviewed, f.job);
  f.state.audience = audience; f.state.groupAfterUpload = null; f.rebuild();
  assert.equal((await f.run()).status, 'delivered');
  assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 1);
});
test('uncertain upload has no blind retry or message send after restart', async t => {
  const f = await fixture(t); f.state.uploadMode = 'lost';
  assert.equal((await f.run()).status, 'uncertain'); f.rebuild();
  assert.equal((await f.run()).status, 'uncertain');
  assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 0);
});
test('download hash mismatch leaves delivery uncertain and never duplicates the send', async t => {
  const f = await fixture(t); f.state.wrongResource = true;
  assert.equal((await f.run()).status, 'uncertain');
  f.rebuild(); assert.equal((await f.run()).status, 'uncertain');
  assert.equal(f.counts.upload, 1); assert.equal(f.counts.send, 1);
  f.state.wrongResource = false; assert.equal((await f.run()).status, 'delivered');
});
test('changed artifact bytes after review cause no upload or send', async t => {
  const f = await fixture(t); fs.appendFileSync(f.identity.localPath, 'unreviewed change');
  assert.notEqual((await f.run()).status, 'delivered');
  assert.equal(f.counts.upload, 0); assert.equal(f.counts.send, 0);
});
test('unapproved audience is blocked before external mutation', async t => {
  const f = await fixture(t); f.state.audience = changedAudience;
  assert.equal((await f.run()).status, 'held'); assert.equal(f.counts.upload, 0); assert.equal(f.counts.send, 0);
});
test('wrong owner provenance or wrong source group never enters review or upload', async t => {
  const f = await fixture(t); f.job.specialOwnership.sourceMessageId = 'om_other_order';
  assert.equal((await f.run()).reason, 'special_owner_provenance_mismatch');
  assert.equal(f.counts.review, 0); assert.equal(f.counts.upload, 0); assert.equal(f.counts.send, 0);
  const g = await fixture(t); g.job.chatId = 'oc_other_group';
  assert.equal((await g.run()).reason, 'special_source_unverified'); assert.equal(g.counts.review, 0);
});
test('missing/forged review receipts are rejected by the real pure assertion', async t => {
  for (const mutate of [r => { r.receipts = []; }, r => { r.receipts[0].receiptId = 'forged'; },
    r => { r.verdict = 'BLOCKED'; }, r => { r.sourceMessageId = 'om_other_order'; },
    r => { r.materials[0].localPath += '.unreviewed'; }]) {
    const f = await fixture(t); mutate(f.reviewed);
    assert.equal((await f.run()).status, 'held'); assert.equal(f.counts.upload, 0); assert.equal(f.counts.send, 0);
  }
});
test('unverified review model stops before even injected review execution', async t => {
  const f = await fixture(t); f.config.specialArtifactReview.model = '';
  assert.equal((await f.run()).reason, 'special_artifact_review_model_unverified');
  assert.equal(f.counts.review, 0); assert.equal(f.counts.send, 0);
});
test('remote sheet is read-only revalidated and linked only to the authorized special group', async t => {
  const f = await fixture(t, 'feishu_sheet');
  assert.equal((await f.run()).status, 'delivered'); assert.equal(f.counts.upload, 0); assert.equal(f.counts.send, 1);
  assert.ok(f.counts.userRead >= 6); assert.equal(f.state.sent[0].msg_type, 'text');
  assert.ok(JSON.parse(f.state.sent[0].body.content).text.includes('/sheets/SyntheticSheet'));
  f.rebuild(); assert.equal((await f.run()).status, 'delivered'); assert.equal(f.counts.send, 1);
});
test('changed remote content or unapproved recipients prevents link delivery', async t => {
  for (const change of ['remoteChanged', 'unexpectedMember', 'noRemoteAccess']) {
    const f = await fixture(t, 'feishu_sheet'); f.state[change] = true;
    assert.notEqual((await f.run()).status, 'delivered'); assert.equal(f.counts.upload, 0); assert.equal(f.counts.send, 0);
  }
});
test('readback requires exactly one matching bot message in the fixed group', async t => {
  const f = await fixture(t); f.state.sendMode = 'lost'; f.state.visible = false;
  assert.equal((await f.run()).status, 'uncertain');
  f.state.visible = true;
  for (const mutate of [item => { item.sender.sender_type = 'user'; }, item => { item.chat_id = 'oc_other_group'; },
    item => { item.sender.id = 'cli_unrelated_app'; },
    item => { item.body.content = JSON.stringify({ file_key: 'wrong_file_key' }); }]) {
    const saved = structuredClone(f.state.sent); mutate(f.state.sent[0]);
    assert.equal((await f.run()).status, 'uncertain'); f.state.sent = saved;
  }
  f.state.sent.push(structuredClone(f.state.sent[0])); assert.equal((await f.run()).status, 'uncertain');
  assert.equal(f.counts.send, 1); assert.equal(f.counts.upload, 1);
});

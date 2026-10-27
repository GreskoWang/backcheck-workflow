import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createFeishuImageTransfer } from '../src/feishu-image-transfer.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { deliveryHash, REGULAR_DELIVERY_CHAT } from '../src/delivery-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../test-temp');
fs.mkdirSync(root, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK/0AAAAASUVORK5CYII=', 'base64');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t, overrides = {}) {
  const workspace = fs.mkdtempSync(path.join(root, 'image-transfer-')), stateDir = path.join(workspace, 'state');
  t.after(() => { assert.equal(path.dirname(path.resolve(workspace)), root); fs.rmSync(workspace, { recursive: true, force: true }); });
  const store = new DeliveryStore(stateDir), intentId = deliveryHash('image-intent'), planHash = deliveryHash('reviewed-plan');
  const args = { intentId, stageId: 'body', sourceDocumentId: 'sourceDoc', sourceBlockId: 'sourceImage', sourceImageToken: 'sourceToken',
    targetDocumentId: 'targetDoc', targetBlockId: 'newImage', expectedRevisionId: 9,
    sourceSnapshotHash: deliveryHash('reviewed-snapshot'), expectedAudienceFingerprint: deliveryHash('approved-audience'), slotId: 'approvedSlot', planHash };
  const beforeSnapshot = { token: 'targetDoc', revisionId: 8, blocks: [{ block_id: 'targetDoc', block_type: 1, children: ['approvedSlot', 'oldImage'] },
    { block_id: 'approvedSlot', block_type: 4 }, { block_id: 'oldImage', block_type: 27, image: { token: 'oldToken' } }] };
  store.claimIntent({ id: intentId, payloadHash: deliveryHash('payload'), kind: 'regular', requestId: 'RQ-test', sourceMessageId: 'sourceMessage',
    targetToken: 'targetDoc', reportToken: 'sourceDoc', reportRevisionId: 4, slotId: 'approvedSlot', recipientAudienceFingerprint: args.expectedAudienceFingerprint });
  store.updateIntent(intentId, { riskMergeSteps: { body: { attemptedAt: new Date().toISOString(), planHash, expectedRevisionId: 8,
    mediaAuthorization: { planHash, sourceSnapshotHash: args.sourceSnapshotHash, sourceDocumentId: 'sourceDoc', sourceRevisionId: 4,
      slotId: 'approvedSlot', expectedAudienceFingerprint: args.expectedAudienceFingerprint, beforeSnapshot, placeholderRevisionId: 9,
      images: [{ sourceBlockId: 'sourceImage', sourceImageToken: 'sourceToken', targetBlockId: 'newImage' }] } } } });
  const remote = { sourceRevision: 4, targetRevision: 9, sourceToken: 'sourceToken', image: { token: '', width: 640, height: 480, align: 2 },
    oldImage: { token: 'oldToken' }, uploadedBytes: null, downloadedBytes: png };
  const calls = { upload: 0, replace: 0, download: 0, reads: 0 };
  function journal() { const dir = path.join(stateDir, 'delivery-image-transfer'); const names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); return names.length ? JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8')) : null; }
  const dependencies = {
    async inspectAudience() { calls.reads++; assert.ok(journal().events.some(e => e.operation === 'audience_read')); return args.expectedAudienceFingerprint; },
    async readDocument(id) { calls.reads++; return { document_id: id, revision_id: id === 'sourceDoc' ? remote.sourceRevision : remote.targetRevision }; },
    async readBlock(doc, id) { calls.reads++; return { block_id: id, block_type: 27, parent_id: doc,
      image: structuredClone(doc === 'sourceDoc' ? { token: remote.sourceToken } : remote.image) }; },
    async downloadImage(doc) { calls.download++; return doc === 'sourceDoc' ? png : remote.downloadedBytes; },
    async uploadImage(input) { calls.upload++; assert.equal(journal().steps.upload.status, 'outcome_uncertain');
      assert.equal(input.targetBlockId, 'newImage'); assert.equal(input.targetDocumentId, 'targetDoc'); assert.deepEqual(input.bytes, png);
      remote.uploadedBytes = input.bytes; return 'newToken'; },
    async replaceImage(input) { calls.replace++; assert.equal(journal().steps.replace.status, 'outcome_uncertain');
      assert.equal(input.targetBlockId, 'newImage'); assert.equal(input.expectedRevisionId, remote.targetRevision);
      assert.deepEqual(input.imageStyle, { width: 640, height: 480, align: 2 });
      remote.image.token = input.imageToken; remote.targetRevision++; return { document_revision_id: remote.targetRevision }; },
    ...overrides,
  };
  const make = () => createFeishuImageTransfer({ client: {}, getUserToken: async () => 'FAKE-ONLY', stateDir, workspace, dependencies });
  return { args, workspace, stateDir, store, remote, calls, dependencies, journal, make };
}
test('copies reviewed source bytes to a new token and verifies the target download, preserving old image', async t => {
  const f = fixture(t), result = await f.make().transferImage(f.args);
  assert.equal(result.status, 'confirmed'); assert.equal(result.sourceSha256, hash(png)); assert.equal(result.targetSha256, hash(png));
  assert.equal(result.targetImageToken, 'newToken'); assert.equal(result.proof.planHash, f.args.planHash);
  assert.equal(result.revisionId, 10); assert.deepEqual(f.remote.oldImage, { token: 'oldToken' });
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.replace, 1);
  assert.equal(f.journal().status, 'confirmed'); assert.equal(JSON.stringify(f.journal()).includes('FAKE-ONLY'), false);
  const repeated = await f.make().transferImage({ ...f.args, expectedRevisionId: 10 });
  assert.equal(repeated.status, 'confirmed'); assert.equal(f.calls.upload, 1); assert.equal(f.calls.replace, 1);
});
test('refuses arbitrary source token, target placeholder, slot, or plan before network', async t => {
  for (const patch of [{ sourceImageToken: 'arbitrary' }, { targetBlockId: 'oldImage' }, { slotId: 'otherSlot' }, { planHash: deliveryHash('other') }]) {
    const f = fixture(t); await assert.rejects(f.make().transferImage({ ...f.args, ...patch }), /image_/u);
    assert.equal(f.calls.reads, 0); assert.equal(f.calls.upload, 0);
  }
});
test('old target block cannot be authorized by merely adding it to a list', async t => {
  const f = fixture(t); f.store.transact(s => { s.intents[f.args.intentId].riskMergeSteps.body.mediaAuthorization.images[0].targetBlockId = 'oldImage'; });
  await assert.rejects(f.make().transferImage({ ...f.args, targetBlockId: 'oldImage' }), /image_target_is_not_new/u);
  assert.equal(f.calls.upload, 0);
});
test('rejects changed reviewed source revision/token and preexisting target image', async t => {
  for (const mutate of [f => f.remote.sourceRevision++, f => f.remote.sourceToken = 'changed', f => f.remote.image.token = 'humanImage']) {
    const f = fixture(t); mutate(f); await assert.rejects(f.make().transferImage(f.args), /image_(reviewed_source|existing_target)/u);
    assert.equal(f.calls.upload, 0); assert.equal(f.calls.replace, 0);
  }
});
test('unknown upload is not retried across restart; only reads may follow', async t => {
  const f = fixture(t); f.dependencies.uploadImage = async () => { f.calls.upload++; throw new Error('lost response with private request'); };
  assert.equal((await f.make().transferImage(f.args)).status, 'uncertain');
  assert.equal((await f.make().transferImage(f.args)).status, 'uncertain');
  assert.equal((await f.make().readBackTransfer(f.args)).status, 'uncertain');
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.replace, 0); assert.equal(JSON.stringify(f.journal()).includes('private request'), false);
});
test('lost patch response reconciles exact downloaded bytes without another mutation', async t => {
  const f = fixture(t), replace = f.dependencies.replaceImage;
  f.dependencies.replaceImage = async input => { await replace(input); throw new Error('network lost'); };
  assert.equal((await f.make().transferImage(f.args)).status, 'confirmed');
  assert.equal((await f.make().readBackTransfer({ ...f.args, expectedRevisionId: 10 })).status, 'confirmed');
  assert.equal(f.calls.replace, 1); assert.equal(f.calls.upload, 1);
});
test('unobserved patch outcome remains uncertain and never repeats patch', async t => {
  const f = fixture(t); f.dependencies.replaceImage = async () => { f.calls.replace++; throw new Error('network lost'); };
  assert.equal((await f.make().transferImage(f.args)).status, 'uncertain');
  assert.equal((await f.make().transferImage(f.args)).status, 'uncertain'); assert.equal(f.calls.replace, 1);
});
test('hash mismatch and target token conflict cannot become a confirmed proof', async t => {
  for (const kind of ['hash', 'token']) {
    const f = fixture(t), replace = f.dependencies.replaceImage;
    f.dependencies.replaceImage = async input => { const r = await replace(input);
      if (kind === 'hash') f.remote.downloadedBytes = Buffer.concat([png, Buffer.from('different')]); else f.remote.image.token = 'humanToken'; return r; };
    const result = await f.make().transferImage(f.args); assert.equal(result.status, 'uncertain'); assert.equal(result.proof, undefined);
    await f.make().readBackTransfer(f.args); assert.equal(f.calls.replace, 1);
  }
});
test('concurrent target change after upload prevents replace and preserves its content', async t => {
  const f = fixture(t), upload = f.dependencies.uploadImage;
  f.dependencies.uploadImage = async input => { const token = await upload(input); f.remote.targetRevision++; f.remote.image.token = 'humanToken'; return token; };
  await assert.rejects(f.make().transferImage(f.args), /image_target_changed_before_replace/u); assert.equal(f.calls.replace, 0);
  assert.equal(f.remote.image.token, 'humanToken');
});
test('audience drift prevents upload; readback alone cannot start a transfer', async t => {
  const f = fixture(t); const pending = await f.make().readBackTransfer(f.args); assert.equal(pending.reason, 'image_transfer_not_attempted');
  assert.equal(pending.status, 'pending_steps'); assert.equal(pending.canContinue, true);
  f.dependencies.inspectAudience = async () => deliveryHash('changed');
  await assert.rejects(f.make().transferImage(f.args), /image_audience_changed/u); assert.equal(f.calls.upload, 0);
});
test('successful upload resumes only an unattempted replacement after an intervening read failure', async t => {
  const f = fixture(t); let count = 0, fail = true;
  f.dependencies.inspectAudience = async () => { if (++count === 2 && fail) throw new Error('read failed'); return f.args.expectedAudienceFingerprint; };
  await assert.rejects(f.make().transferImage(f.args), /image_transport_failed/u);
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.replace, 0); fail = false;
  const pending = await f.make().readBackTransfer(f.args); assert.equal(pending.status, 'pending_steps'); assert.equal(pending.canContinue, true);
  assert.equal((await f.make().transferImage(f.args)).status, 'confirmed'); assert.equal(f.calls.upload, 1); assert.equal(f.calls.replace, 1);
});
test('same image concurrent caller cannot duplicate upload', async t => {
  const f = fixture(t), original = f.dependencies.uploadImage; let release;
  const gate = new Promise(resolve => { release = resolve; }); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.dependencies.uploadImage = async input => { entered(); await gate; return original(input); };
  const first = f.make().transferImage(f.args); await started;
  await assert.rejects(f.make().transferImage(f.args), /image_transfer_in_flight/u); release();
  assert.equal((await first).status, 'confirmed'); assert.equal(f.calls.upload, 1);
});
test('bounded image-only payload rejects arbitrary data without upload', async t => {
  const f = fixture(t); f.dependencies.downloadImage = async () => Buffer.from('<html>not an image</html>');
  await assert.rejects(f.make().transferImage(f.args), /image_format_unsupported/u); assert.equal(f.calls.upload, 0);
});
test('default SDK route uses UAT, parent block binding and revision-guarded replace_image', async t => {
  const f = fixture(t), seen = [];
  const client = { docx: { v1: { document: { get: async p => ({ code: 0, data: { document: await f.dependencies.readDocument(p.path.document_id) } }) },
    documentBlock: { get: async p => ({ code: 0, data: { block: await f.dependencies.readBlock(p.path.document_id, p.path.block_id) } }),
      patch: async (p, opts) => { seen.push({ kind: 'patch', p, hasOptions: Boolean(opts) });
        assert.equal(p.params.document_revision_id, 9); assert.equal(p.data.replace_image.token, 'freshSDKToken');
        f.remote.image.token = 'freshSDKToken'; f.remote.targetRevision++; return { code: 0, data: { document_revision_id: 10 } }; } } } },
    drive: { v1: { media: { download: async (p, opts) => { seen.push({ kind: 'download', p, hasOptions: Boolean(opts) });
      return { getReadableStream: () => Readable.from([png]) }; }, uploadAll: async (p, opts) => {
      seen.push({ kind: 'upload', p: { ...p, data: { ...p.data, file: undefined } }, hasOptions: Boolean(opts) });
      assert.equal(p.data.parent_type, 'docx_image'); assert.equal(p.data.parent_node, 'newImage');
      assert.deepEqual(JSON.parse(p.data.extra), { drive_route_token: 'targetDoc' }); assert.deepEqual(p.data.file, png); return { file_token: 'freshSDKToken' }; } } } } };
  const transfer = createFeishuImageTransfer({ client, getUserToken: async () => 'TEST-UAT', stateDir: f.stateDir, workspace: f.workspace,
    dependencies: { inspectAudience: f.dependencies.inspectAudience } });
  assert.equal((await transfer.transferImage(f.args)).status, 'confirmed'); assert.ok(seen.every(s => s.hasOptions));
  assert.equal(seen.filter(s => s.kind === 'upload').length, 1); assert.equal(JSON.stringify(f.journal()).includes('TEST-UAT'), false);
});
test('state outside workspace is rejected before it is created', t => {
  const f = fixture(t), outside = path.join(root, `outside-${crypto.randomUUID()}`);
  assert.throws(() => createFeishuImageTransfer({ client: {}, getUserToken: async () => '', workspace: f.workspace, stateDir: outside }), /image_state_outside_workspace/u);
  assert.equal(fs.existsSync(outside), false);
});
test('default audience read uses bounded pagination and the adapter canonical fingerprint', async t => {
  const f = fixture(t);
  const group = deliveryHash({ chatId: REGULAR_DELIVERY_CHAT, external: true,
    members: [{ id: 'member1', tenant: 'tenant1', type: 'open_id' }, { id: 'member2', tenant: 'tenant2', type: 'open_id' }], tenantKey: 'tenant1' });
  const permission = { external_access_entity: 'open', link_share_entity: 'tenant_readable' };
  const members = [{ member_id: REGULAR_DELIVERY_CHAT, member_type: 'openchat', perm: 'full_access' }];
  f.args.expectedAudienceFingerprint = deliveryHash({ groups: [{ chatId: REGULAR_DELIVERY_CHAT, fingerprint: group }], members, permission });
  f.store.transact(s => { const i = s.intents[f.args.intentId]; i.recipientAudienceFingerprint = f.args.expectedAudienceFingerprint;
    i.riskMergeSteps.body.mediaAuthorization.expectedAudienceFingerprint = f.args.expectedAudienceFingerprint; });
  let paged = 0;
  const client = { request: async (req, opts) => {
    assert.ok(f.journal().events.at(-1).operation.startsWith('audience_')); assert.equal(f.journal().events.at(-1).status, 'reading');
    if (req.url.endsWith('/public')) { assert.ok(opts); return { code: 0, data: { permission_public: permission } }; }
    if (req.url.includes('/permissions/')) { assert.ok(opts); return { code: 0, data: { items: members, has_more: false } }; }
    assert.equal(opts, undefined);
    if (!req.url.endsWith('/members')) return { code: 0, data: { tenant_key: 'tenant1', external: true } };
    paged++;
    return req.params.page_token ? { code: 0, data: { items: [{ member_id: 'member2', member_id_type: 'open_id', tenant_key: 'tenant2' }], has_more: false } }
      : { code: 0, data: { items: [{ member_id: 'member1', member_id_type: 'open_id', tenant_key: 'tenant1' }], has_more: true, page_token: 'next' } };
  } };
  const dependencies = { ...f.dependencies }; delete dependencies.inspectAudience;
  const transfer = createFeishuImageTransfer({ client, getUserToken: async () => 'TEST-UAT', workspace: f.workspace, stateDir: f.stateDir, dependencies });
  assert.equal((await transfer.transferImage(f.args)).status, 'confirmed'); assert.equal(paged, 6);
});
test('blank user identity never falls back to the app identity for upload', async t => {
  const f = fixture(t); let network = 0;
  const transfer = createFeishuImageTransfer({ client: { docx: { v1: { document: { get() { network++; } } } } },
    getUserToken: async () => '', stateDir: f.stateDir, workspace: f.workspace });
  await assert.rejects(transfer.transferImage(f.args), /image_user_identity_missing/u); assert.equal(network, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeishuDeliveryAdapters, groupAudienceFingerprint, documentAudienceFingerprint } from '../src/feishu-delivery-adapters.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { handleDeliveryMessage } from '../src/delivery-router.mjs';
import { createSharedDeliveryReviewer } from '../src/shared-delivery-review.mjs';
import { deliveryHash, assignmentKey, REGULAR_DELIVERY_CHAT, SPECIAL_DELIVERY_CHAT, REGULAR_DISPATCH_CHAT } from '../src/delivery-policy.mjs';

const NOW = Date.parse('2026-10-26T03:00:00Z');
const owner = { member_id: 'ou_y', member_id_type: 'open_id', name: 'Yvonne', tenant_key: 'ownerTenant' };
const members = [owner, { member_id: 'ou_reader', member_id_type: 'open_id', name: 'Reader', tenant_key: 'readerTenant' }];
const permission = { link_share_entity: 'tenant_readable', external_access_entity: 'open', share_entity: 'anyone' };
const acl = [{ member_id: 'ou_y', member_type: 'openid', perm: 'full_access', type: 'user' },
  { member_id: REGULAR_DELIVERY_CHAT, member_type: 'openchat', perm: 'full_access', type: 'chat' }];
const text = value => ({ elements: [{ text_run: { content: value } }] });
const assignment = { subject: 'Subject', code: 'TS', itemNumbers: ['1'], sourceBlock: '第1个需求' };
const sourceBlocks = [
  { block_id: 'Source', block_type: 1, children: ['basic', 'paragraph'], page: text('Report-Subject') },
  { block_id: 'basic', parent_id: 'Source', block_type: 5, heading3: text('基本信息') },
  { block_id: 'paragraph', parent_id: 'Source', block_type: 2, text: text('Reviewed facts') },
];
const initialTargetBlocks = [
  { block_id: 'Target', block_type: 1, children: ['heading', 'next'], page: text('Shared') },
  { block_id: 'heading', parent_id: 'Target', block_type: 4, heading2: text('Subject') },
  { block_id: 'next', parent_id: 'Target', block_type: 4, heading2: text('Other person') },
];
function fixture(t, options = {}) {
  const base = process.env.BRIDGE_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(base, 'delivery-adapter-'));
  t.after(() => { assert.ok(workspace.startsWith(path.resolve(base) + path.sep)); fs.rmSync(workspace, { recursive: true, force: true }); });
  const stateDir = path.join(workspace, 'state'); fs.mkdirSync(path.join(stateDir, 'review-evidence'), { recursive: true });
  const sourceSnapshotPath = path.join(workspace, 'source.json');
  const sourceSnapshot = { requestId: 'RQ-ALPHA', document: { document_id: 'Source', revision_id: 3, title: 'Report-Subject' },
    block_list: { items: structuredClone(sourceBlocks), has_more: false }, review_context: { risk_groups: [] } };
  fs.writeFileSync(sourceSnapshotPath, JSON.stringify(sourceSnapshot));
  const manifestPath = path.join(stateDir, 'review-evidence', 'RQ-ALPHA.json');
  const manifest = { requestId: 'RQ-ALPHA', sourceMessageId: 'om_source',
    documents: [{ url: 'https://my.feishu.cn/docx/Source', snapshotPath: sourceSnapshotPath, assignment: structuredClone(assignment) }] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const job = { requestId: 'RQ-ALPHA', sourceMessageId: 'om_source', chatId: REGULAR_DISPATCH_CHAT, status: 'completed',
    codexThreadId: 'thread', codexThreadRequestId: 'RQ-ALPHA', finalResponse: 'https://my.feishu.cn/docx/Source',
    dispatchScope: { assignments: [structuredClone(assignment)], receiptAssignments: [structuredClone(assignment)] } };
  const message = { messageId: 'om_delivery', chatId: REGULAR_DELIVERY_CHAT, createTime: NOW,
    content: 'RQ-ALPHA\nTS：https://my.feishu.cn/docx/Target' };
  const groups = {
    [REGULAR_DELIVERY_CHAT]: { chatId: REGULAR_DELIVERY_CHAT, tenantKey: 'groupTenant', external: true },
    [SPECIAL_DELIVERY_CHAT]: { chatId: SPECIAL_DELIVERY_CHAT, tenantKey: 'specialTenant', external: true },
  };
  const config = { regular: { allowedHostnames: ['my.feishu.cn'], associationBindings: [] }, special: { allowedHostnames: ['my.feishu.cn'] } };
  const state = { revision: 8, blocks: structuredClone(initialTargetBlocks), sourceRevision: 3,
    messages: [], calls: [], appCalls: [], writes: 0, sends: 0, members: structuredClone(members), acl: structuredClone(acl), permission: structuredClone(permission) };
  const userResponse = data => ({ status: 200, data: { code: 0, data } });
  const appResponse = data => ({ code: 0, data });
  async function request(args) {
    state.calls.push(structuredClone({ url: args.url, method: args.method, params: args.params, data: args.data }));
    if (options.transportError) throw new Error('Authorization: Bearer NEVER_EXPOSE_THIS');
    const url = new URL(args.url), p = url.pathname;
    if (p === '/open-apis/drive/v1/metas/batch_query') return userResponse({ metas: [{ doc_token: 'Target', doc_type: 'docx', owner_id: 'ou_y', title: 'Shared' }] });
    if (p.endsWith('/members/auth')) return userResponse({ auth_result: options.canEdit !== false });
    if (p.endsWith('/public')) return userResponse({ permission_public: state.permission });
    if (p.includes('/permissions/') && p.endsWith('/members')) return userResponse({ items: state.acl, has_more: false });
    if (p.endsWith('/Source')) return userResponse({ document: { document_id: 'Source', revision_id: state.sourceRevision, title: 'Report-Subject' } });
    if (p.endsWith('/Target')) return userResponse({ document: { document_id: 'Target', revision_id: state.revision, title: 'Shared' } });
    if (p.endsWith('/Target/raw_content')) return userResponse({ content: 'Shared\nSubject\nReviewed facts\nOther person' });
    if (p.endsWith('/Target/blocks')) {
      if (options.badPagination) return userResponse({ items: state.blocks.slice(0, 1), has_more: true });
      if (options.paginateBlocks && !args.params?.page_token) return userResponse({ items: state.blocks.slice(0, 1), has_more: true, page_token: 'next-page' });
      return userResponse({ items: options.paginateBlocks ? state.blocks.slice(1) : state.blocks, has_more: false });
    }
    if (p.endsWith('/descendant')) {
      state.writes += 1;
      if (args.params.document_revision_id !== state.revision) return { status: 400, data: { code: 1770003 } };
      if (options.insertTimeoutBeforeCommit) throw new Error('socket lost before commit');
      const relations = args.data.descendants.map((block, i) => ({ temporary_block_id: block.block_id, block_id: `created_${state.writes}_${i}` }));
      const lookup = Object.fromEntries(relations.map(item => [item.temporary_block_id, item.block_id]));
      const parent = Object.fromEntries(args.data.descendants.flatMap(block => (block.children || []).map(child => [child, lookup[block.block_id]])));
      for (const block of args.data.descendants) state.blocks.push({ ...block, block_id: lookup[block.block_id], parent_id: parent[block.block_id] || 'Target',
        ...(block.children ? { children: block.children.map(id => lookup[id]) } : {}) });
      state.blocks[0].children.splice(args.data.index, 0, ...args.data.children_id.map(id => lookup[id]));
      state.revision += 1;
      if (options.insertTimeoutAfterCommit || options.insertTimeoutAtWrite === state.writes) throw new Error('socket lost after commit');
      return userResponse({ document_revision_id: state.revision, block_id_relations: relations });
    }
    throw new Error(`unexpected mocked URL ${p}`);
  }
  const appClient = { async request(args) {
    state.appCalls.push(structuredClone(args));
    const p = args.url;
    if (args.method === 'POST') {
      state.sends += 1;
      const item = { message_id: 'om_sent', chat_id: SPECIAL_DELIVERY_CHAT, msg_type: 'text', sender: { sender_type: 'app', id: 'bot' },
        body: { content: args.data.content }, create_time: String(NOW) };
      state.messages.push(item);
      if (options.sendTimeoutAfterCommit) throw new Error('uncertain send');
      return appResponse({ message_id: item.message_id });
    }
    if (p.endsWith('/members')) return appResponse({ items: state.members, has_more: false });
    if (p.includes('/chats/')) { const group = groups[p.split('/').at(-1)]; return appResponse({ tenant_key: group.tenantKey, external: group.external }); }
    if (p.endsWith('/om_delivery')) return appResponse({ items: [{ message_id: message.messageId, chat_id: message.chatId, create_time: String(message.createTime),
      sender: { id: 'ou_y', id_type: 'open_id', tenant_key: 'ownerTenant', sender_type: 'user' }, body: { content: JSON.stringify({ text: message.content }) } }] });
    if (p.endsWith('/om_sent')) return appResponse({ items: state.messages });
    if (p === '/open-apis/im/v1/messages') return appResponse({ items: state.messages, has_more: false });
    throw new Error(`unexpected mocked app URL ${p}`);
  } };
  const receipt = (token = 'Source', revision = 3) => ({ verdict: 'PASS', token, revision_id: revision, script_version: 'test', reviewer_id: 'reviewer', layout_fingerprint: 'layout', generated_at: new Date(NOW).toISOString() });
  const runAudit = async file => {
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (options.snapshotChangesDuringAudit) fs.writeFileSync(file, JSON.stringify({ ...snapshot, changedDuringAudit: true }));
    if (options.manifestChangesDuringAudit) fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, changedDuringAudit: true }));
    return { verdict: 'PASS', visual: { verdict: 'PASS' }, stats: { errors: 0, blocked: 0 }, business_risk_review: { confirmed_hits: options.risk ? 1 : 0 },
      document: { token: snapshot.document.document_id, revision_id: snapshot.document.revision_id }, receipt: receipt(snapshot.document.document_id, snapshot.document.revision_id) };
  };
  const deliveryStore = new DeliveryStore(stateDir);
  const imageProofs = new Map(); state.imageTransfers = 0;
  const imageTransfer = options.mockImageTransfer ? {
    async transferImage(binding) {
      state.imageTransfers += 1; assert.equal(binding.expectedRevisionId, state.revision);
      const block = state.blocks.find(b => b.block_id === binding.targetBlockId);
      assert.equal(Boolean(block.image.token), false);
      const saved = deliveryStore.getIntent(binding.intentId).riskMergeSteps[binding.stageId].mediaAuthorization;
      assert.ok(saved.images.some(i => i.targetBlockId === binding.targetBlockId));
      block.image.token = `Uploaded${state.imageTransfers}`; state.revision += 1;
      const proof = { ...binding, status: 'confirmed', targetImageToken: block.image.token, sourceSha256: 'a'.repeat(64),
        targetSha256: 'a'.repeat(64), sha256: 'a'.repeat(64), revisionId: state.revision };
      imageProofs.set(binding.targetBlockId, proof);
      if (options.imageResponseLost) throw new Error('image result lost');
      return proof;
    },
    async readBackTransfer(binding) { return imageProofs.get(binding.targetBlockId) || { status: 'pending_steps', canContinue: true }; },
  } : undefined;
  const classifier = options.actualSlotClassifier ? createSharedDeliveryReviewer({ stateDir, workspace }).classifySlot
    : async () => ({ decision: 'append_safe', conflicts: [], reviewerId: 'test-reviewer', reason: 'test reference classification' });
  const adapters = createFeishuDeliveryAdapters({ appClient, appId: 'app', botOpenId: 'bot', config, deliveryStore, stateDir, workspace,
    dependencies: { request, currentToken: async () => 'NEVER_EXPOSE_THIS', runAudit, now: () => NOW, imageTransfer,
      sharedReviewer: { classifySlot: classifier,
        review: async () => { throw Object.assign(new Error('shared_review_evidence_missing'), { name: 'DeliveryHold', code: 'shared_review_evidence_missing' }); } } } });
  return { adapters, state, config, workspace, stateDir, deliveryStore, job, message, manifest, manifestPath, sourceSnapshot, sourceSnapshotPath, groups };
}
async function regularPlan(f) {
  const file = { token: 'Target', type: 'docx', hostname: 'my.feishu.cn', url: 'https://my.feishu.cn/docx/Target', label: 'TS' };
  const target = await f.adapters.inspectTarget({ file, message: f.message });
  const association = (await f.adapters.resolveRegularAssociations({ message: f.message, target, jobs: [f.job] })).matches[0];
  const receipts = await f.adapters.verifyCompletedReports({ job: f.job });
  const material = await f.adapters.readReviewedReport({ job: f.job, association, receipts });
  const slot = await f.adapters.inspectSlot({ target, association });
  const id = deliveryHash(['test', f.job.requestId]);
  const payloadHash = deliveryHash([material.token, material.revisionId, material.contentHash]);
  f.deliveryStore.claimIntent({ id, kind: 'regular', requestId: f.job.requestId, sourceMessageId: f.job.sourceMessageId, payloadHash,
    targetToken: 'Target', slotId: association.slotId, assignment, reportToken: material.token, reportRevisionId: material.revisionId,
    contentHash: material.contentHash, recipientAudienceFingerprint: target.audience.fingerprint });
  const args = { intentId: id, idempotencyKey: id, requestId: f.job.requestId, documentToken: 'Target', slotId: association.slotId,
    expectedRevisionId: target.revisionId, expectedSlotHash: slot.slotHash, expectedAudienceFingerprint: target.audience.fingerprint,
    blocks: material.blocks, payloadHash, contentHash: material.contentHash, operation: 'insert_only', requireServerRevisionGuard: true };
  return { id, target, association, material, slot, args };
}
async function specialPlan(f) {
  const text = '专项背调已完成\nSubject\nhttps://my.feishu.cn/docx/Source';
  const id = deliveryHash(['special-test']);
  const group = await f.adapters.inspectSpecialGroup({ chatId: SPECIAL_DELIVERY_CHAT });
  f.deliveryStore.claimIntent({ id, kind: 'special', requestId: f.job.requestId, sourceMessageId: 'om_source', chatId: SPECIAL_DELIVERY_CHAT,
    text, payloadHash: deliveryHash(text), reports: [{ token: 'Source', revisionId: 3 }] });
  return { id, args: { intentId: id, idempotencyKey: id, requestId: f.job.requestId, chatId: SPECIAL_DELIVERY_CHAT, text,
    messageType: 'text', payloadHash: deliveryHash(text), expectedAudienceFingerprint: group.audienceFingerprint } };
}

test('sender identity is bound to original message metadata and unchanged text', async t => {
  const f = fixture(t);
  const identity = await f.adapters.resolveSenderIdentity({ message: f.message });
  assert.equal(identity.id, 'ou_y'); assert.equal(identity.fromMessageMetadata, true);
  await assert.rejects(f.adapters.resolveSenderIdentity({ message: { ...f.message, content: 'forged' } }), /source_message_changed/u);
});
test('token inspection completes pagination, checks edit authorization and records exact-token selection', async t => {
  const f = fixture(t, { paginateBlocks: true });
  const target = await f.adapters.inspectTarget({ file: { token: 'Target', hostname: 'my.feishu.cn', url: 'https://my.feishu.cn/docx/Target' } });
  assert.equal(target.canWrite, true); assert.equal(target.ownerTenantKey, 'ownerTenant');
  assert.equal(target.identitySelection, 'exact_token'); assert.equal(target.audience.permissionsComplete, true);
  assert.equal(f.state.calls.filter(call => call.url.endsWith('/blocks')).length, 2);
  assert.equal(target.audience.fingerprint, documentAudienceFingerprint(permission, acl, [{ chatId: REGULAR_DELIVERY_CHAT,
    fingerprint: groupAudienceFingerprint(f.groups[REGULAR_DELIVERY_CHAT], members) }]));
});
test('incomplete pagination and unexpected recipient groups fail closed', async t => {
  const f = fixture(t, { badPagination: true });
  await assert.rejects(f.adapters.inspectTarget({ file: { token: 'Target', hostname: 'my.feishu.cn', url: 'https://my.feishu.cn/docx/Target' } }), /pagination_incomplete/u);
  const other = fixture(t); other.state.acl.push({ member_id: 'oc_unapproved', member_type: 'openchat', perm: 'view' });
  await assert.rejects(other.adapters.inspectTarget({ file: { token: 'Target', hostname: 'my.feishu.cn', url: 'https://my.feishu.cn/docx/Target' } }), /unexpected_group_collaborator/u);
});
test('audience fingerprint ignores display-name changes but includes stable membership and ACL changes', () => {
  const group = { chatId: REGULAR_DELIVERY_CHAT, tenantKey: 'groupTenant', external: true };
  const expected = groupAudienceFingerprint(group, members);
  assert.equal(groupAudienceFingerprint(group, members.toReversed().map(member => ({ ...member, name: 'changed' }))), expected);
  assert.notEqual(groupAudienceFingerprint(group, members.slice(0, 1)), expected);
  assert.notEqual(documentAudienceFingerprint(permission, acl, []), documentAudienceFingerprint({ ...permission, link_share_entity: 'anyone_readable' }, acl, []));
});
test('mapping requires immutable request identity or a reviewed binding, never a filename/date guess', async t => {
  const f = fixture(t);
  await assert.rejects(f.adapters.resolveDeliveryLinkScope({ file: { token: 'Target' }, message: { ...f.message, content: '10.26 Subject https://my.feishu.cn/docx/Target' }, jobs: [f.job] }));
  const result = await f.adapters.resolveDeliveryLinkScope({ file: { token: 'Target' }, message: f.message, jobs: [f.job] });
  assert.deepEqual(result.sources, [{ requestId: f.job.requestId, sourceMessageId: f.job.sourceMessageId, sourceBlock: assignment.sourceBlock }]);
});
test('source manifest needs exact assignment/source bindings and genuine current audit before copying', async t => {
  const f = fixture(t);
  const receipts = await f.adapters.verifyCompletedReports({ job: f.job });
  f.manifest.documents[0].assignment.subject = 'wrong';
  fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(f.adapters.readReviewedReport({ job: f.job, association: assignment, receipts }), /source_manifest_changed_or_unreviewed/u);
});
test('snapshot or manifest edits during audit cannot become reviewed material', async t => {
  for (const option of ['snapshotChangesDuringAudit', 'manifestChangesDuringAudit']) {
    const f = fixture(t, { [option]: true });
    await assert.rejects(f.adapters.verifyCompletedReports({ job: f.job }), error => {
      if (option === 'snapshotChangesDuringAudit') {
        assert.equal(error.code, 'review_audit_error');
        assert.equal(error.reviewStatus, 'ERROR');
        assert.equal(error.cause?.code, 'source_snapshot_changed_during_review');
      } else {
        assert.equal(error.code, 'source_manifest_changed_during_review');
      }
      return true;
    });
    assert.equal(f.state.writes, 0);
  }
});
test('target URL identity must match its token and hostname before any API request', async t => {
  const f = fixture(t);
  await assert.rejects(f.adapters.inspectTarget({ file: { token: 'Different', hostname: 'my.feishu.cn', url: 'https://my.feishu.cn/docx/Target' } }), /target_link_identity_mismatch/u);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.appCalls.length, 0);
});
test('risk-bearing material cannot bypass the dedicated summary planner', async t => {
  const f = fixture(t, { risk: true });
  await assert.rejects(regularPlan(f), /risk_source_groups_missing/u); assert.equal(f.state.writes, 0);
});
function riskScenario(f) {
  f.sourceSnapshot.review_context.risk_groups = [{ title: 'Observed risk' }];
  f.sourceSnapshot.block_list.items[0].children.unshift('risk', 'pin');
  f.sourceSnapshot.block_list.items.push({ block_id: 'risk', parent_id: 'Source', block_type: 5, heading3: text('风险摘要') },
    { block_id: 'pin', parent_id: 'Source', block_type: 2, text: { elements: [{ text_run: { content: 'Observed risk',
      text_element_style: { link: { url: 'https://my.feishu.cn/docx/Source#paragraph' } } } }] } });
  fs.writeFileSync(f.sourceSnapshotPath, JSON.stringify(f.sourceSnapshot));
  f.state.blocks[0].children.unshift('risk-head', 'body-head');
  f.state.blocks.push({ block_id: 'risk-head', parent_id: 'Target', block_type: 3, heading1: text('风险摘要') },
    { block_id: 'body-head', parent_id: 'Target', block_type: 3, heading1: text('基本信息和背调详情') });
}
test('risk adapter executes body then ordered summary and binds summary links to actual created IDs', async t => {
  const f = fixture(t, { risk: true }); riskScenario(f); const p = await regularPlan(f);
  await f.adapters.insertOwnedBlocks(p.args);
  const intent = f.deliveryStore.getIntent(p.id);
  assert.equal(intent.riskMergeSteps.body.status, 'confirmed'); assert.equal(intent.riskMergeSteps.summary.status, 'confirmed');
  assert.equal(f.state.writes, 2);
  const actualParagraph = f.state.blocks.find(b => b.text?.elements?.[0]?.text_run?.content === 'Reviewed facts');
  const pin = f.state.blocks.find(b => b.text?.elements?.[0]?.text_run?.content === 'Observed risk');
  assert.equal(pin.text.elements[0].text_run.text_element_style.link.url, `https://my.feishu.cn/docx/Target#${actualParagraph.block_id}`);
  const result = await f.adapters.readBackIntent({ intent }); assert.equal(result.status, 'confirmed'); assert.ok(result.riskProjection);
});
test('uncertain body commit reads back and continues only the never-attempted summary', async t => {
  const f = fixture(t, { risk: true, insertTimeoutAtWrite: 1 }); riskScenario(f); const p = await regularPlan(f);
  await assert.rejects(f.adapters.insertOwnedBlocks(p.args), /uncertain/u);
  let intent = f.deliveryStore.getIntent(p.id);
  assert.equal((await f.adapters.readBackIntent({ intent })).status, 'pending_steps'); assert.equal(f.state.writes, 1);
  await f.adapters.continueOwnedDelivery({ intent }); intent = f.deliveryStore.getIntent(p.id);
  assert.equal((await f.adapters.readBackIntent({ intent })).status, 'confirmed'); assert.equal(f.state.writes, 2);
});
test('an uncertain uncommitted stage is never replayed or advanced to its dependent summary', async t => {
  const f = fixture(t, { risk: true, insertTimeoutBeforeCommit: true }); riskScenario(f); const p = await regularPlan(f);
  await assert.rejects(f.adapters.insertOwnedBlocks(p.args), /uncertain/u);
  const intent = f.deliveryStore.getIntent(p.id);
  assert.equal((await f.adapters.readBackIntent({ intent })).status, 'unconfirmed');
  assert.equal((await f.adapters.continueOwnedDelivery({ intent })).status, 'unconfirmed'); assert.equal(f.state.writes, 1);
});
test('risk image placeholders use the actual transfer module contract before summary and final confirmation', async t => {
  const f = fixture(t, { risk: true, mockImageTransfer: true }); riskScenario(f);
  f.sourceSnapshot.block_list.items[0].children.push('source-image');
  f.sourceSnapshot.block_list.items.push({ block_id: 'source-image', parent_id: 'Source', block_type: 27, image: { token: 'SourceImage', width: 640, height: 480 } });
  fs.writeFileSync(f.sourceSnapshotPath, JSON.stringify(f.sourceSnapshot));
  const p = await regularPlan(f); await f.adapters.insertOwnedBlocks(p.args);
  const intent = f.deliveryStore.getIntent(p.id);
  assert.equal(f.state.imageTransfers, 1); assert.equal(intent.adapterMediaProofs.length, 1);
  assert.equal((await f.adapters.readBackIntent({ intent })).status, 'confirmed'); assert.equal(f.state.writes, 2);
});
test('lost image result is recovered by media readback and never repeats an image transfer', async t => {
  const f = fixture(t, { risk: true, mockImageTransfer: true, imageResponseLost: true }); riskScenario(f);
  f.sourceSnapshot.block_list.items[0].children.push('source-image');
  f.sourceSnapshot.block_list.items.push({ block_id: 'source-image', parent_id: 'Source', block_type: 27, image: { token: 'SourceImage', width: 640, height: 480 } });
  fs.writeFileSync(f.sourceSnapshotPath, JSON.stringify(f.sourceSnapshot));
  const p = await regularPlan(f); await assert.rejects(f.adapters.insertOwnedBlocks(p.args), /image result lost/u);
  const intent = f.deliveryStore.getIntent(p.id);
  assert.equal((await f.adapters.readBackIntent({ intent })).status, 'pending_steps');
  await f.adapters.continueOwnedDelivery({ intent });
  assert.equal((await f.adapters.readBackIntent({ intent })).status, 'confirmed'); assert.equal(f.state.imageTransfers, 1); assert.equal(f.state.writes, 2);
});
test('an identical reviewed report already in its exact section is reviewed without another insertion', async t => {
  const f = fixture(t, { actualSlotClassifier: true });
  f.state.blocks[0].children.splice(1, 0, 'old-basic', 'old-paragraph');
  f.state.blocks.push({ ...structuredClone(sourceBlocks[1]), block_id: 'old-basic', parent_id: 'Target' },
    { ...structuredClone(sourceBlocks[2]), block_id: 'old-paragraph', parent_id: 'Target' });
  const p = await regularPlan(f); await f.adapters.insertOwnedBlocks(p.args);
  const intent = f.deliveryStore.getIntent(p.id); assert.equal(intent.adapterNoop, true);
  assert.equal((await f.adapters.readBackIntent({ intent })).status, 'confirmed'); assert.equal(f.state.writes, 0);
});
test('empty exact H2 section inserts once with server revision guard and proves outside content unchanged', async t => {
  const f = fixture(t); const p = await regularPlan(f);
  await f.adapters.insertOwnedBlocks(p.args);
  const write = f.state.calls.find(call => call.method === 'POST' && call.url.endsWith('/descendant'));
  assert.equal(write.params.document_revision_id, 8); assert.equal(write.params.client_token, p.id);
  assert.equal(f.state.writes, 1); assert.equal(f.state.blocks.find(block => block.block_id === 'next').heading2.elements[0].text_run.content, 'Other person');
  const readback = await f.adapters.readBackIntent({ intent: f.deliveryStore.getIntent(p.id) });
  assert.equal(readback.status, 'confirmed'); assert.equal(readback.externalBlocksUnchanged, true);
  await assert.rejects(f.adapters.insertOwnedBlocks(p.args), /mutation_already_attempted/u); assert.equal(f.state.writes, 1);
});
test('nonempty target sections are never cleared, deleted, or overwritten', async t => {
  const f = fixture(t); const p = await regularPlan(f);
  f.state.blocks[0].children.splice(1, 0, 'human'); f.state.blocks.push({ block_id: 'human', parent_id: 'Target', block_type: 2, text: text('Human content') });
  await assert.rejects(f.adapters.insertOwnedBlocks(p.args), /target_slot_changed/u);
  assert.equal(f.state.writes, 0); assert.ok(f.state.blocks.some(block => textOfTest(block) === 'Human content'));
});
function textOfTest(block) { return (block.text?.elements || []).map(element => element.text_run?.content || '').join(''); }
test('concurrent revision and modified source content are blocked before any mutation', async t => {
  const f = fixture(t); const p = await regularPlan(f); f.state.revision += 1;
  await assert.rejects(f.adapters.insertOwnedBlocks(p.args), /target_changed_before_mutation/u); assert.equal(f.state.writes, 0);
  const other = fixture(t); const q = await regularPlan(other); q.args.blocks[0].heading3.elements[0].text_run.content = 'tampered';
  await assert.rejects(other.adapters.insertOwnedBlocks(q.args), /mutation_source_unbound/u); assert.equal(other.state.writes, 0);
});
test('transport uncertainty after insertion is resolved by readback without replay', async t => {
  const f = fixture(t, { insertTimeoutAfterCommit: true }); const p = await regularPlan(f);
  await assert.rejects(f.adapters.insertOwnedBlocks(p.args), /mutation_transport_uncertain/u);
  const readback = await f.adapters.readBackIntent({ intent: f.deliveryStore.getIntent(p.id) });
  assert.equal(readback.status, 'confirmed');
  await assert.rejects(f.adapters.insertOwnedBlocks(p.args), /mutation_already_attempted/u); assert.equal(f.state.writes, 1);
});
test('outside concurrent edits make readback uncertain, never a successful delivery', async t => {
  const f = fixture(t); const p = await regularPlan(f); await f.adapters.insertOwnedBlocks(p.args);
  f.state.blocks.find(block => block.block_id === 'next').heading2 = text('Changed by another user');
  const result = await f.adapters.readBackIntent({ intent: f.deliveryStore.getIntent(p.id) });
  assert.equal(result.status, 'unconfirmed'); assert.equal(f.state.writes, 1);
});
test('known mutation block IDs must match the exact readback subtree', async t => {
  const f = fixture(t); const p = await regularPlan(f); await f.adapters.insertOwnedBlocks(p.args);
  f.deliveryStore.updateIntent(p.id, { adapterCreatedBlockIds: ['not_the_returned_blocks'] });
  const result = await f.adapters.readBackIntent({ intent: f.deliveryStore.getIntent(p.id) });
  assert.equal(result.status, 'unconfirmed'); assert.equal(f.state.writes, 1);
});
test('real adapter and router integration inserts once but cannot invent shared-target review', async t => {
  const f = fixture(t);
  const audience = documentAudienceFingerprint(permission, acl, [{ chatId: REGULAR_DELIVERY_CHAT,
    fingerprint: groupAudienceFingerprint(f.groups[REGULAR_DELIVERY_CHAT], members) }]);
  Object.assign(f.config.regular, { enabled: true, authorization: 'test-only authorization', chatId: REGULAR_DELIVERY_CHAT,
    activationFromMs: NOW - 1000, tenantKey: 'ownerTenant', expectedExternal: true, allowedAudienceFingerprints: [audience],
    sender: { verified: true, id: 'ou_y', idType: 'open_id', tenantKey: 'ownerTenant', proofMessageId: 'om_verified' } });
  const result = await handleDeliveryMessage({ message: f.message, jobs: [f.job], config: f.config,
    store: f.deliveryStore, adapters: f.adapters, now: () => NOW });
  assert.equal(result.status, 'pending'); assert.equal(f.state.writes, 1);
  const second = await handleDeliveryMessage({ message: f.message, jobs: [f.job], config: f.config,
    store: f.deliveryStore, adapters: f.adapters, now: () => NOW });
  assert.equal(second.status, 'pending'); assert.equal(f.state.writes, 1);
  assert.equal(result.results[0].reason, 'shared_target_review_failed');
});
test('shared document review requires real current team-merge evidence and is never fabricated', async t => {
  const f = fixture(t); const p = await regularPlan(f); await f.adapters.insertOwnedBlocks(p.args);
  const intent = f.deliveryStore.getIntent(p.id), readback = await f.adapters.readBackIntent({ intent });
  await assert.rejects(f.adapters.reviewSharedTarget({ intent, readback }), /shared_review_evidence_missing/u);
  const folder = path.join(f.stateDir, 'delivery-review'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, `${p.id}.json`), JSON.stringify({ requestId: f.job.requestId, document: { document_id: 'Target', revision_id: 1 }, review_context: { document_mode: 'team_merge' } }));
  await assert.rejects(f.adapters.reviewSharedTarget({ intent, readback }), /shared_review_evidence_missing/u);
});
test('special result uses exact group, bounded text, deterministic UUID and authoritative readback', async t => {
  const f = fixture(t); const p = await specialPlan(f);
  await f.adapters.sendSpecialResult(p.args);
  const mutation = f.state.appCalls.find(call => call.method === 'POST');
  assert.equal(mutation.data.receive_id, SPECIAL_DELIVERY_CHAT); assert.ok(mutation.data.uuid.length <= 50);
  assert.equal((await f.adapters.readBackIntent({ intent: f.deliveryStore.getIntent(p.id) })).status, 'confirmed');
  await assert.rejects(f.adapters.sendSpecialResult(p.args), /mutation_already_attempted/u); assert.equal(f.state.sends, 1);
});
test('special recipients or audience changes are blocked without sending', async t => {
  const f = fixture(t); const p = await specialPlan(f);
  await assert.rejects(f.adapters.sendSpecialResult({ ...p.args, chatId: REGULAR_DELIVERY_CHAT }), /special_send_payload_mismatch/u);
  f.state.members.push({ member_id: 'ou_new', member_id_type: 'open_id', tenant_key: 'newTenant' });
  await assert.rejects(f.adapters.sendSpecialResult(p.args), /special_audience_changed/u); assert.equal(f.state.sends, 0);
});
test('uncertain special sends read back exact bot content and never resend', async t => {
  const f = fixture(t, { sendTimeoutAfterCommit: true }); const p = await specialPlan(f);
  await assert.rejects(f.adapters.sendSpecialResult(p.args), /special_send_outcome_uncertain/u);
  assert.equal((await f.adapters.readBackIntent({ intent: f.deliveryStore.getIntent(p.id) })).status, 'confirmed');
  f.state.messages.push({ ...f.state.messages[0], message_id: 'om_duplicate' });
  assert.equal((await f.adapters.readBackIntent({ intent: f.deliveryStore.getIntent(p.id) })).status, 'unconfirmed');
  await assert.rejects(f.adapters.sendSpecialResult(p.args), /mutation_already_attempted/u); assert.equal(f.state.sends, 1);
});
test('adapter errors never include raw authentication headers or transport payloads', async t => {
  const f = fixture(t, { transportError: true });
  await assert.rejects(f.adapters.readLatestTargetRevision({ token: 'Target' }), error => {
    assert.equal(error.code, 'delivery_read_transport_failed'); assert.ok(!String(error).includes('NEVER_EXPOSE_THIS')); return true;
  });
});

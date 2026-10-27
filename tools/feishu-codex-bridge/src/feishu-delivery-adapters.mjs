import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { currentToken } from './accounting-client.mjs';
import { verifyCompletedReports, runReadOnlyAudit, reviewManifestPath } from './delivery-review.mjs';
import { replyUuid } from './reply-policy.mjs';
import { createSharedDeliveryReviewer, proveAdditiveInsertion } from './shared-delivery-review.mjs';
import { resolveRegularAssociations as resolveDatedAssociations, resolveRegularLinkScope } from './regular-association.mjs';
import { planRiskMerge, riskAppendPrefixEvidence, prepareRiskMergeStage, confirmRiskMergeStage,
  inspectRiskMergePlaceholders, verifyRiskMergeProjection } from './risk-merge-plan.mjs';
import { RiskMergeJournal } from './risk-merge-journal.mjs';
import {
  DeliveryHold, requireDelivery, deliveryHash, assignmentKey, parseDeliveryFile,
  SPECIAL_DELIVERY_CHAT, REGULAR_DELIVERY_CHAT, REGULAR_DISPATCH_CHAT, parseDeliveryFiles,
} from './delivery-policy.mjs';

const ID = /^[A-Za-z0-9_-]+$/u;
const MAX_PAGES = 100;
const MAX_BLOCKS = 20000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
function ident(value) { requireDelivery(typeof value === 'string' && ID.test(value), 'invalid_resource_identity'); return value; }
function nowISO(now) { return new Date(now()).toISOString(); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function digest(value) { return deliveryHash(stable(value)); }
function textOf(block) {
  const payload = Object.values(block || {}).find(value => value && typeof value === 'object' && Array.isArray(value.elements));
  return (payload?.elements || []).map(element => element.text_run?.content || '').join('');
}
function bodyText(item) {
  try { return JSON.parse(item?.body?.content || '{}').text || ''; } catch { return ''; }
}
function checkedData(result, operation) {
  requireDelivery(result?.code === 0, `${operation}_failed_${Number.isInteger(result?.code) ? result.code : 'unknown'}`);
  return result.data || {};
}
function localJson(workspace, file) {
  requireDelivery(path.isAbsolute(file || ''), 'evidence_path_invalid');
  const root = fs.realpathSync(workspace), candidate = fs.realpathSync(file);
  const relative = path.relative(root, candidate);
  requireDelivery(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'evidence_outside_workspace');
  const stat = fs.statSync(candidate);
  requireDelivery(stat.isFile() && stat.size <= MAX_FILE_BYTES, 'evidence_file_unbounded');
  return JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/u, ''));
}
function tree(blocks, token) {
  requireDelivery(Array.isArray(blocks) && blocks.length > 0 && blocks.length <= MAX_BLOCKS, 'block_tree_unbounded');
  const by = new Map(blocks.map(block => [block.block_id, block]));
  requireDelivery(by.size === blocks.length && by.get(token)?.block_type === 1, 'block_tree_invalid');
  const visited = new Set();
  function visit(id, parent) {
    const block = by.get(id);
    requireDelivery(block && !visited.has(id) && (!parent || block.parent_id === parent), 'block_tree_invalid');
    visited.add(id);
    for (const child of block.children || []) visit(child, id);
  }
  visit(token, null);
  requireDelivery(visited.size === blocks.length, 'block_tree_incomplete');
  return { by, root: by.get(token) };
}
function canonicalSubtrees(by, ids) {
  const visit = id => {
    const input = by.get(id);
    requireDelivery(input, 'block_tree_incomplete');
    const output = structuredClone(input);
    delete output.block_id; delete output.parent_id;
    if (input.children) output.children = input.children.map(visit);
    return stable(output);
  };
  return ids.map(visit);
}
function sourceSectionProjection(by, ids) {
  let number = 0;
  function convert(node) {
    let output = structuredClone(node);
    if (output.block_type === 13) {
      number += 1;
      output = { block_type: 2, text: { elements: [{ text_run: {
        content: `${number}. ${textOf(output)}`,
        text_element_style: { bold: false, inline_code: false, italic: false, strikethrough: false, underline: false },
      } }], style: { align: 1, folded: false } } };
    }
    for (const value of Object.values(output)) {
      if (value?.style?.indentation_level === 'NoIndent') delete value.style.indentation_level;
    }
    if (node.children) output.children = node.children.map(convert);
    return stable(output);
  }
  return canonicalSubtrees(by, ids).map(convert);
}
function descendantsOf(by, ids) {
  const found = new Set();
  function visit(id) { found.add(id); for (const child of by.get(id)?.children || []) visit(child); }
  ids.forEach(visit); return found;
}
function flattenWriteBlocks(blocks, { allowImages = false } = {}) {
  const descendants = [], children_id = [];
  function visit(node) {
    const block_id = `insert_${descendants.length + 1}`, block = structuredClone(node), children = block.children;
    delete block.children;
    requireDelivery(![1, 20, 21, 22, 23, 28, 31, 32, 33, 34, 35, 36, 37, 38, 39].includes(block.block_type), 'source_block_clone_unsupported');
    if (block.block_type === 27) {
      requireDelivery(allowImages && (!block.image?.token || block.image.token === ''), 'image_transfer_plan_required');
      delete block.image.token;
    }
    block.block_id = block_id; descendants.push(block); if (children) block.children = children.map(visit); return block_id;
  }
  blocks.forEach(block => children_id.push(visit(block)));
  requireDelivery(descendants.length > 0 && descendants.length <= 1000, 'source_block_count_unsupported');
  return { children_id, descendants };
}
function section(snapshot, slotId, subject) {
  const { by, root } = tree(snapshot.blocks, snapshot.token);
  const ids = root.children || [];
  const start = ids.indexOf(slotId);
  requireDelivery(start >= 0 && by.get(slotId)?.block_type === 4 && textOf(by.get(slotId)) === subject, 'subject_slot_mismatch');
  const following = ids.findIndex((id, index) => index > start && by.get(id)?.block_type === 4);
  const next = following < 0 ? ids.length : following;
  const ownIds = ids.slice(start + 1, next);
  const own = descendantsOf(by, ownIds);
  const outside = snapshot.blocks.filter(block => !own.has(block.block_id) && block.block_id !== snapshot.token);
  const rootWithoutChildren = { ...root }; delete rootWithoutChildren.children;
  return {
    by, root, start, next, ownIds, nextHeadingId: ids[next] || null,
    slotHash: digest([snapshot.token, snapshot.revisionId, slotId, ids[next], canonicalSubtrees(by, ownIds)]),
    outsideHash: digest([rootWithoutChildren, ids.slice(0, start + 1), ids.slice(next), outside]),
  };
}

export function groupAudienceFingerprint(chat, members) {
  return digest({ chatId: chat.chatId, tenantKey: chat.tenantKey, external: chat.external,
    members: members.map(member => ({ id: member.member_id, type: member.member_id_type,
      tenant: member.tenant_key || null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
}
export function documentAudienceFingerprint(permission, members, groupAudiences) {
  return digest({ permission, members: members.map(member => stable(member))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  groups: [...groupAudiences].sort((a, b) => a.chatId.localeCompare(b.chatId)) });
}

/** Narrow production adapter. The only mutation endpoints are a revision-
 * guarded descendant insertion and a fixed special-group text message. There
 * is no share, delete, replace, generic URL write, or automatic write retry. */
export function createFeishuDeliveryAdapters({
  appClient, appId, config, deliveryStore, stateDir, workspace, botOpenId, reviewModel,
  dependencies = {},
}) {
  requireDelivery(appClient && appId && deliveryStore && stateDir && workspace, 'delivery_adapter_configuration_missing');
  const now = dependencies.now || Date.now;
  const getToken = dependencies.currentToken || currentToken;
  const transport = dependencies.request || (options => axios.request(options));
  const audit = dependencies.runAudit || runReadOnlyAudit;
  const snapshots = new Map(), auditCache = new Map(), manifestCache = new Map(), materials = new Map();
  const slotReviews = new Map();
  const sharedReviewer = dependencies.sharedReviewer || createSharedDeliveryReviewer({ stateDir, workspace, model: reviewModel,
    dependencies: { ...(dependencies.sharedReview || {}), now } });
  const inFlight = new Set();
  const riskJournal = new RiskMergeJournal(deliveryStore, now);
  let imageTransfer = dependencies.imageTransfer;
  async function imageClient() {
    if (!imageTransfer) {
      const { createFeishuImageTransfer } = await import('./feishu-image-transfer.mjs');
      imageTransfer = createFeishuImageTransfer({ client: appClient, getUserToken: () => getToken(appId), stateDir, workspace,
        dependencies: { inspectAudience: async targetDocumentId => (await inspectTarget({ file: {
          token: targetDocumentId, hostname: config.regular.allowedHostnames[0], url: `https://${config.regular.allowedHostnames[0]}/docx/${targetDocumentId}` } })).audience.fingerprint } });
    }
    return imageTransfer;
  }
  async function appRead(url, params) {
    try { return checkedData(await appClient.request({ url, method: 'GET', params }), 'feishu_read'); }
    catch (error) { if (error instanceof DeliveryHold) throw error; throw new DeliveryHold(`feishu_read_failed_${error?.response?.data?.code || 'transport'}`); }
  }
  async function userRequest(url, { method = 'GET', params, data, mutation = false } = {}) {
    requireDelivery(url.startsWith('/open-apis/') && !url.includes('..'), 'endpoint_not_allowed');
    if (mutation) requireDelivery(method === 'POST' && /^\/open-apis\/docx\/v1\/documents\/[A-Za-z0-9_-]+\/blocks\/[A-Za-z0-9_-]+\/descendant$/u.test(url), 'mutation_endpoint_not_allowed');
    else requireDelivery(method === 'GET' || (method === 'POST' && url === '/open-apis/drive/v1/metas/batch_query'), 'readonly_endpoint_not_allowed');
    let response;
    try {
      const token = await getToken(appId);
      response = await transport({ url: `https://open.feishu.cn${url}`, method, params, data,
        timeout: 20000, maxRedirects: 0, validateStatus: () => true,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    } catch { throw new DeliveryHold(mutation ? 'delivery_mutation_transport_uncertain' : 'delivery_read_transport_failed'); }
    requireDelivery(response.status === 200, `delivery_api_http_${Number(response.status) || 'unknown'}`);
    return checkedData(response.data, mutation ? 'delivery_mutation' : 'delivery_read');
  }
  async function paged(fetch, name, limit = MAX_BLOCKS) {
    const items = [], seenTokens = new Set(); let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await fetch(cursor);
      requireDelivery(Array.isArray(data.items), `${name}_items_missing`);
      items.push(...data.items);
      requireDelivery(items.length <= limit, `${name}_too_large`);
      if (data.has_more !== true) return items;
      requireDelivery(typeof data.page_token === 'string' && data.page_token && !seenTokens.has(data.page_token), `${name}_pagination_incomplete`);
      cursor = data.page_token; seenTokens.add(cursor);
    }
    throw new DeliveryHold(`${name}_pagination_incomplete`);
  }
  async function groupInfo(chatId) {
    requireDelivery([REGULAR_DELIVERY_CHAT, SPECIAL_DELIVERY_CHAT].includes(chatId), 'group_not_allowlisted');
    const info = await appRead(`/open-apis/im/v1/chats/${ident(chatId)}`);
    const members = await paged(cursor => appRead(`/open-apis/im/v1/chats/${chatId}/members`,
      { member_id_type: 'open_id', page_size: 100, ...(cursor ? { page_token: cursor } : {}) }), 'members', 2000);
    requireDelivery(members.length > 0 && members.every(member => member.member_id && member.member_id_type && member.tenant_key), 'group_members_incomplete');
    const group = { chatId, tenantKey: info.tenant_key, external: info.external,
      membersComplete: true, memberCount: members.length, members, canSend: true, observedAt: nowISO(now) };
    requireDelivery(typeof group.tenantKey === 'string' && typeof group.external === 'boolean', 'group_metadata_incomplete');
    group.audienceFingerprint = groupAudienceFingerprint(group, members);
    return group;
  }
  async function documentSnapshot(token) {
    ident(token);
    const before = (await userRequest(`/open-apis/docx/v1/documents/${token}`)).document;
    requireDelivery(before?.document_id === token && Number.isSafeInteger(before.revision_id) && before.revision_id > 0, 'document_identity_missing');
    const blocks = await paged(cursor => userRequest(`/open-apis/docx/v1/documents/${token}/blocks`, {
      params: { page_size: 500, document_revision_id: before.revision_id, ...(cursor ? { page_token: cursor } : {}) },
    }), 'blocks');
    const after = (await userRequest(`/open-apis/docx/v1/documents/${token}`)).document;
    requireDelivery(after?.revision_id === before.revision_id, 'document_changed_during_inspection');
    tree(blocks, token);
    return { token, revisionId: before.revision_id, title: before.title, document: before, blocks };
  }
  function associationBindings(message, file, jobs) {
    const configured = (config?.regular?.associationBindings || []).filter(binding =>
      binding.deliveryMessageId === message.messageId && binding.targetToken === file.token && binding.authorization);
    if (configured.length) return configured;
    // Request IDs are immutable bridge batch keys, not names or approximate
    // dates. A posting without one requires a separately reviewed binding.
    const explicit = jobs.filter(job => job.chatId === REGULAR_DISPATCH_CHAT &&
      new RegExp(`(^|[^A-Z0-9-])${job.requestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9-])`, 'u').test(message.content));
    requireDelivery(explicit.length === 1, explicit.length ? 'batch_mapping_ambiguous' : 'batch_mapping_evidence_missing');
    return (explicit[0].dispatchScope?.assignments || []).map(assignment => ({ ...assignment,
      requestId: explicit[0].requestId, sourceMessageId: explicit[0].sourceMessageId,
      targetToken: file.token, deliveryMessageId: message.messageId, authorization: 'explicit_request_id_in_verified_delivery_message' }));
  }
  function assertBinding(binding, jobs) {
    const found = jobs.filter(job => job.requestId === binding.requestId && job.sourceMessageId === binding.sourceMessageId && job.chatId === REGULAR_DISPATCH_CHAT);
    requireDelivery(found.length === 1, 'binding_source_order_ambiguous');
    requireDelivery((found[0].dispatchScope?.assignments || []).filter(assignment => assignmentKey(assignment) === assignmentKey(binding)).length === 1,
      'binding_assignment_mismatch');
    return found[0];
  }
  async function inspectTarget({ file }) {
    const policy = config.regular;
    const parsed = parseDeliveryFile(file.url, policy);
    requireDelivery(parsed.token === file.token && parsed.hostname === file.hostname, 'target_link_identity_mismatch');
    const [snapshot, metadata, permission, audience, edit, view, group] = await Promise.all([
      documentSnapshot(file.token),
      userRequest('/open-apis/drive/v1/metas/batch_query', { method: 'POST', data: { request_docs: [{ doc_token: file.token, doc_type: 'docx' }], with_url: true }, params: { user_id_type: 'open_id' } }),
      userRequest(`/open-apis/drive/v2/permissions/${ident(file.token)}/public`, { params: { type: 'docx' } }),
      paged(cursor => userRequest(`/open-apis/drive/v1/permissions/${file.token}/members`, { params: { type: 'docx', fields: '*', ...(cursor ? { page_token: cursor } : {}) } }), 'permissions', 2000),
      userRequest(`/open-apis/drive/v1/permissions/${file.token}/members/auth`, { params: { type: 'docx', action: 'edit' } }),
      userRequest(`/open-apis/drive/v1/permissions/${file.token}/members/auth`, { params: { type: 'docx', action: 'view' } }),
      groupInfo(REGULAR_DELIVERY_CHAT),
    ]);
    const meta = metadata.metas?.filter(item => item.doc_token === file.token && item.doc_type === 'docx');
    requireDelivery(meta?.length === 1 && meta[0].title === snapshot.title, 'target_metadata_mismatch');
    const owner = group.members.filter(member => member.member_id === meta[0].owner_id);
    requireDelivery(owner.length === 1 && owner[0].tenant_key, 'target_owner_organization_unknown');
    requireDelivery(audience.length > 0 && audience.every(member => member.member_id && member.member_type && member.perm), 'target_permissions_incomplete');
    const groupMembers = audience.filter(member => member.member_type === 'openchat');
    requireDelivery(groupMembers.every(member => member.member_id === REGULAR_DELIVERY_CHAT), 'unexpected_group_collaborator');
    const p = permission.permission_public;
    requireDelivery(p && typeof p.link_share_entity === 'string' && typeof p.external_access_entity === 'string', 'public_permissions_incomplete');
    const target = { token: file.token, type: 'docx', hostname: file.hostname, title: snapshot.title,
      ownerId: meta[0].owner_id, tenantKey: owner[0].tenant_key, ownerTenantKey: owner[0].tenant_key,
      organizationEvidence: 'owner_id_and_chat_member_tenant', identitySelection: 'exact_token',
      canRead: view.auth_result === true, canWrite: edit.auth_result === true, revisionId: snapshot.revisionId,
      audience: { external: p.external_access_entity === 'open', public: /anyone/u.test(p.link_share_entity), permissionsComplete: true,
        fingerprint: documentAudienceFingerprint(p, audience, groupMembers.map(() => ({ chatId: group.chatId, fingerprint: group.audienceFingerprint }))) },
      observedAt: nowISO(now) };
    snapshots.set(file.token, snapshot);
    return target;
  }
  function verifyIntent(intentId, kind, args) {
    const intent = deliveryStore.getIntent(intentId);
    requireDelivery(intent && intent.kind === kind && intent.payloadHash === args.payloadHash && intent.requestId === args.requestId,
      'mutation_intent_mismatch');
    requireDelivery(!intent.adapterMutationAttemptedAt && !inFlight.has(intentId), 'mutation_already_attempted');
    return intent;
  }
  function evidencePath(intentId, suffix) {
    requireDelivery(/^[a-f0-9]{64}$/u.test(intentId), 'delivery_intent_invalid');
    const directory = path.join(stateDir, 'delivery-evidence');
    fs.mkdirSync(directory, { recursive: true });
    return path.join(directory, `${intentId}-${suffix}.json`);
  }
  function writeEvidence(intentId, suffix, value) {
    const target = evidencePath(intentId, suffix);
    requireDelivery(!fs.existsSync(target), 'delivery_evidence_already_exists');
    const fd = fs.openSync(target, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return target;
  }
  function updateRiskStep(intentId, stageId, patch) {
    deliveryStore.transact(state => { const step = state.intents[intentId]?.riskMergeSteps?.[stageId];
      requireDelivery(step, 'risk_stage_journal_missing'); Object.assign(step, structuredClone(patch)); });
  }
  async function verifyRiskContinuation(intent, prepared) {
    requireDelivery(prepared.riskPlan?.requestId === intent.requestId && prepared.sourceSnapshotPath &&
      deliveryHash(fs.readFileSync(prepared.sourceSnapshotPath)) === prepared.sourceSnapshotHash, 'risk_source_snapshot_changed');
    await adapters.verifyCompletedReports({ job: prepared.job });
    const file = { token: intent.targetToken, hostname: config.regular.allowedHostnames[0], url: `https://${config.regular.allowedHostnames[0]}/docx/${intent.targetToken}` };
    const target = await inspectTarget({ file });
    requireDelivery(target.canWrite && target.audience.fingerprint === intent.recipientAudienceFingerprint, 'risk_recipient_changed');
    return snapshots.get(intent.targetToken);
  }
  async function advanceRiskDelivery(intent, prepared, { readOnly }) {
    const plan = prepared.riskPlan;
    let snapshot = readOnly ? await documentSnapshot(intent.targetToken) : await verifyRiskContinuation(intent, prepared);
    let mediaProofs = deliveryStore.getIntent(intent.id).adapterMediaProofs || [];
    for (const { stageId } of plan.stages) {
      let entry = deliveryStore.getIntent(intent.id).riskMergeSteps?.[stageId];
      if (entry?.status === 'confirmed') continue;
      if (!entry) {
        if (readOnly) return { status: 'pending_steps' };
        const stage = prepareRiskMergeStage({ plan, stageId, snapshot, mediaProofs });
        entry = riskJournal.prepare(intent.id, stage).step;
      }
      const stage = entry.stage;
      if (stage.status === 'insert' && !entry.attemptedAt) {
        if (readOnly) return { status: 'pending_steps' };
        // Source and destination are rechecked immediately before each new
        // mutation; the server also enforces the exact expected revision.
        snapshot = await verifyRiskContinuation(intent, prepared);
        requireDelivery(snapshot.revisionId === stage.expectedRevisionId, 'risk_revision_changed_before_stage');
        const claim = riskJournal.claimAttempt(intent.id, stageId);
        requireDelivery(claim.mayMutate, 'risk_stage_already_attempted');
        deliveryStore.updateIntent(intent.id, { adapterMutationAttemptedAt: deliveryStore.getIntent(intent.id).adapterMutationAttemptedAt || nowISO(now) });
        const data = await userRequest(`/open-apis/docx/v1/documents/${ident(intent.targetToken)}/blocks/${ident(intent.targetToken)}/descendant`, {
          method: 'POST', mutation: true, params: { document_revision_id: stage.expectedRevisionId, client_token: claim.step.clientToken },
          data: { index: stage.index, ...flattenWriteBlocks(stage.writeBlocks, { allowImages: true }) },
        });
        updateRiskStep(intent.id, stageId, { candidateBlockIds: (data.block_id_relations || []).map(item => item.block_id).filter(Boolean) });
        snapshot = await documentSnapshot(intent.targetToken);
      }
      // Recover media proofs before asking the planner to compare image tokens.
      // A committed replace may have lost its response and local parent proof.
      const savedMedia = deliveryStore.getIntent(intent.id).riskMergeSteps[stageId].mediaAuthorization;
      if (savedMedia) {
        const transfers = await imageClient();
        for (const image of savedMedia.images) {
          if (mediaProofs.some(p => p.sourceBlockId === image.sourceBlockId && p.targetBlockId === image.targetBlockId)) continue;
          const binding = { ...image, intentId: intent.id, stageId, planHash: plan.planHash, slotId: intent.slotId,
            sourceDocumentId: plan.sourceToken, targetDocumentId: plan.targetToken, expectedRevisionId: snapshot.revisionId,
            sourceRevisionId: plan.sourceRevisionId, sourceSnapshotHash: prepared.sourceSnapshotHash,
            expectedAudienceFingerprint: intent.recipientAudienceFingerprint };
          const recovered = await transfers.readBackTransfer(binding);
          if (recovered.status === 'confirmed') {
            mediaProofs.push(recovered); deliveryStore.updateIntent(intent.id, { adapterMediaProofs: mediaProofs });
          } else if (recovered.status !== 'pending_steps') return { status: 'unconfirmed' };
        }
      }
      let placeholder;
      try { placeholder = inspectRiskMergePlaceholders({ plan, stage, snapshot, mediaProofs }); }
      catch { return { status: 'unconfirmed' }; }
      const currentStep = deliveryStore.getIntent(intent.id).riskMergeSteps[stageId];
      if (currentStep.candidateBlockIds?.length && !sameIds(currentStep.candidateBlockIds, placeholder.createdBlockIds)) return { status: 'unconfirmed' };
      if (placeholder.images.length) {
        if (!currentStep.mediaAuthorization) updateRiskStep(intent.id, stageId, { mediaAuthorization: {
          planHash: plan.planHash, sourceSnapshotHash: prepared.sourceSnapshotHash, sourceDocumentId: plan.sourceToken,
          sourceRevisionId: plan.sourceRevisionId, slotId: intent.slotId, expectedAudienceFingerprint: intent.recipientAudienceFingerprint,
          images: placeholder.images.map(image => ({ sourceBlockId: image.sourceBlockId, sourceImageToken: image.sourceImageToken, targetBlockId: image.targetBlockId })),
          beforeSnapshot: stage.beforeSnapshot, placeholderRevisionId: snapshot.revisionId,
        } });
        const transfers = await imageClient();
        for (const image of placeholder.images) {
          const binding = { ...image, intentId: intent.id, expectedRevisionId: snapshot.revisionId,
            sourceRevisionId: plan.sourceRevisionId, sourceSnapshotHash: prepared.sourceSnapshotHash,
            expectedAudienceFingerprint: intent.recipientAudienceFingerprint };
          const result = readOnly ? await transfers.readBackTransfer(binding) : await transfers.transferImage(binding);
          if (result.status !== 'confirmed') return { status: result.status === 'pending_steps' ? 'pending_steps' : 'unconfirmed' };
          requireDelivery(result.sourceBlockId === image.sourceBlockId && result.targetBlockId === image.targetBlockId, 'image_transfer_identity_mismatch');
          mediaProofs = [...mediaProofs.filter(p => p.sourceBlockId !== image.sourceBlockId || p.targetBlockId !== image.targetBlockId), { ...result, ...image }];
          deliveryStore.updateIntent(intent.id, { adapterMediaProofs: mediaProofs });
          snapshot = await documentSnapshot(intent.targetToken);
        }
      }
      const proof = confirmRiskMergeStage({ plan, stage, snapshot, mediaProofs });
      riskJournal.confirm(intent.id, proof);
    }
    const projection = verifyRiskMergeProjection({ plan, snapshot, mediaProofs });
    return { status: 'confirmed', projection, snapshot };
  }
  function sameIds(a, b) { return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
  const adapters = {
    capabilities: { atomicRevisionGuard: true, incrementalInsertOnly: true },
    async resolveSenderIdentity({ message }) {
      requireDelivery(message.chatId === REGULAR_DELIVERY_CHAT, 'sender_group_not_allowlisted');
      const data = await appRead(`/open-apis/im/v1/messages/${ident(message.messageId)}`);
      const candidates = (data.items || []).filter(item => item.message_id === message.messageId && item.chat_id === message.chatId && !item.deleted);
      requireDelivery(candidates.length === 1, 'source_message_identity_ambiguous');
      const item = candidates[0], sender = item.sender;
      requireDelivery(bodyText(item) === message.content && Number(item.create_time) === Number(message.createTime), 'source_message_changed');
      return { verified: true, fromMessageMetadata: true, id: sender?.id, idType: sender?.id_type,
        tenantKey: sender?.tenant_key, senderType: sender?.sender_type, messageId: item.message_id, chatId: item.chat_id };
    },
    inspectTarget,
    async inspectArtifactAccess({ file, expectedChatId }) {
      requireDelivery(expectedChatId === SPECIAL_DELIVERY_CHAT && ['docx', 'sheet'].includes(file?.type), 'artifact_scope_unsupported');
      const url = new URL(file.url);
      requireDelivery(url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        config.special.allowedHostnames.includes(url.hostname) && file.hostname === url.hostname &&
        url.pathname === `/${file.type === 'sheet' ? 'sheets' : 'docx'}/${ident(file.token)}`, 'artifact_link_identity_mismatch');
      const [metadata, permission, audience, view, group] = await Promise.all([
        userRequest('/open-apis/drive/v1/metas/batch_query', { method: 'POST', data: { request_docs: [{ doc_token: file.token, doc_type: file.type }], with_url: true }, params: { user_id_type: 'open_id' } }),
        userRequest(`/open-apis/drive/v2/permissions/${file.token}/public`, { params: { type: file.type } }),
        paged(cursor => userRequest(`/open-apis/drive/v1/permissions/${file.token}/members`, { params: { type: file.type, fields: '*', ...(cursor ? { page_token: cursor } : {}) } }), 'permissions', 2000),
        userRequest(`/open-apis/drive/v1/permissions/${file.token}/members/auth`, { params: { type: file.type, action: 'view' } }),
        groupInfo(SPECIAL_DELIVERY_CHAT),
      ]);
      const meta = metadata.metas?.filter(item => item.doc_token === file.token && item.doc_type === file.type);
      requireDelivery(meta?.length === 1 && meta[0].owner_id, 'artifact_metadata_mismatch');
      const p = permission.permission_public, groups = audience.filter(m => m.member_type === 'openchat');
      requireDelivery(p && typeof p.link_share_entity === 'string' && typeof p.external_access_entity === 'string' &&
        audience.length > 0 && audience.every(m => m.member_id && m.member_type && m.perm), 'artifact_permissions_incomplete');
      requireDelivery(groups.length === 1 && groups[0].member_id === SPECIAL_DELIVERY_CHAT, 'artifact_recipient_access_unverified');
      const owner = group.members.filter(m => m.member_id === meta[0].owner_id);
      requireDelivery(owner.length === 1 && owner[0].tenant_key, 'artifact_owner_organization_unknown');
      requireDelivery(view.auth_result === true && !/anyone/u.test(p.link_share_entity), 'artifact_public_or_unreadable');
      return { token: file.token, type: file.type, hostname: url.hostname, title: meta[0].title, ownerId: meta[0].owner_id,
        ownerTenantKey: owner[0].tenant_key, tenantKey: owner[0].tenant_key, canRead: true,
        recipientChatId: SPECIAL_DELIVERY_CHAT, recipientCanRead: true, observedAt: nowISO(now),
        audience: { permissionsComplete: true, external: p.external_access_entity === 'open', public: false,
          fingerprint: documentAudienceFingerprint(p, audience, [{ chatId: group.chatId, fingerprint: group.audienceFingerprint }]) } };
    },
    async resolveDeliveryLinkScope({ file, message, jobs }) {
      let bindings;
      try { bindings = associationBindings(message, file, jobs); }
      catch (error) {
        if (!(error instanceof DeliveryHold) || error.code !== 'batch_mapping_evidence_missing') throw error;
        const resolved = resolveRegularLinkScope({ message, file, jobs });
        requireDelivery(resolved.status === 'matched', resolved.reasons?.[0]?.code || resolved.reasons?.[0] || 'batch_mapping_evidence_missing');
        return resolved;
      }
      const sources = bindings.map(binding => { assertBinding(binding, jobs); return { requestId: binding.requestId, sourceMessageId: binding.sourceMessageId, sourceBlock: binding.sourceBlock }; });
      return { status: 'matched', deliveryMessageId: message.messageId, fileToken: file.token,
        sources: [...new Map(sources.map(source => [JSON.stringify(source), source])).values()] };
    },
    async resolveRegularAssociations({ message, target, jobs }) {
      const snapshot = snapshots.get(target.token);
      requireDelivery(snapshot?.revisionId === target.revisionId, 'target_inspection_missing');
      let bindings;
      try { bindings = associationBindings(message, { token: target.token }, jobs); }
      catch (error) {
        if (!(error instanceof DeliveryHold) || error.code !== 'batch_mapping_evidence_missing') throw error;
        const file = parseDeliveryFiles(message.content, config.regular).find(item => item.token === target.token);
        const resolved = resolveDatedAssociations({ message, file, target, snapshot, jobs,
          subjectEvidence: config.regular.subjectEvidence || [] });
        requireDelivery(resolved.status === 'matched', resolved.reasons?.[0]?.code || resolved.reasons?.[0] || 'order_mapping_ambiguous');
        return resolved;
      }
      const matches = [];
      for (const binding of bindings) {
        const job = assertBinding(binding, jobs);
        const headings = snapshot.blocks.filter(block => block.block_type === 4 && textOf(block) === binding.subject && (!binding.slotId || block.block_id === binding.slotId));
        if (!headings.length) continue;
        requireDelivery(headings.length === 1, 'subject_slot_ambiguous');
        matches.push({ ...binding, batchId: job.batchId || job.requestId, targetToken: target.token, slotId: headings[0].block_id,
          evidence: { kind: 'source_and_target', deliveryMessageId: message.messageId, sourceMessageId: job.sourceMessageId,
            documentToken: target.token, targetRevisionId: target.revisionId, matchingRequestCount: 1, matchingSubjectCount: 1, matchingSlotCount: 1 } });
      }
      return { status: matches.length ? 'matched' : 'unmatched', matches };
    },
    async verifyCompletedReports({ job }) {
      const manifestPath = reviewManifestPath(stateDir, job.requestId);
      const manifestDigest = deliveryHash(fs.readFileSync(manifestPath));
      const verified = new Map();
      const receipts = await verifyCompletedReports({ requestId: job.requestId, finalResponse: job.finalResponse, stateDir, workspace,
        readLatestRevision: token => adapters.readLatestTargetRevision({ token }),
        runAudit: async file => {
          const before = deliveryHash(fs.readFileSync(file));
          const result = await audit(file);
          requireDelivery(before === deliveryHash(fs.readFileSync(file)), 'source_snapshot_changed_during_review');
          verified.set(fs.realpathSync(file), { result, digest: before });
          return result;
        } });
      requireDelivery(manifestDigest === deliveryHash(fs.readFileSync(manifestPath)), 'source_manifest_changed_during_review');
      for (const [file, value] of verified) auditCache.set(file, value);
      manifestCache.set(job.requestId, manifestDigest);
      return receipts;
    },
    async readReviewedReport({ job, association, receipts }) {
      const manifestPath = reviewManifestPath(stateDir, job.requestId);
      const manifest = localJson(workspace, manifestPath);
      requireDelivery(manifestCache.get(job.requestId) === deliveryHash(fs.readFileSync(manifestPath)), 'source_manifest_changed_or_unreviewed');
      requireDelivery(manifest.requestId === job.requestId && manifest.sourceMessageId === job.sourceMessageId && Array.isArray(manifest.documents), 'source_manifest_identity_missing');
      const documents = manifest.documents.filter(item => assignmentKey(item.assignment || item) === assignmentKey(association));
      requireDelivery(documents.length === 1, 'source_report_assignment_ambiguous');
      const item = documents[0], snapshot = localJson(workspace, item.snapshotPath);
      const cached = auditCache.get(fs.realpathSync(item.snapshotPath));
      requireDelivery(cached?.result?.verdict === 'PASS' && cached.digest === deliveryHash(fs.readFileSync(item.snapshotPath)), 'source_snapshot_changed_or_unreviewed');
      const token = snapshot.document?.document_id, revision = snapshot.document?.revision_id;
      requireDelivery(receipts.some(receipt => receipt.token === token && Number(receipt.revision_id) === revision), 'source_snapshot_receipt_mismatch');
      const policy = job.chatId === SPECIAL_DELIVERY_CHAT ? config.special : config.regular;
      requireDelivery(parseDeliveryFile(item.url, policy).token === token, 'source_url_mismatch');
      requireDelivery(snapshot.block_list?.has_more === false, 'source_snapshot_incomplete');
      const { by, root } = tree(snapshot.block_list.items, token);
      const basic = (root.children || []).filter(id => by.get(id)?.block_type === 5 && textOf(by.get(id)) === '基本信息');
      const material = { ...structuredClone(association), requestId: job.requestId, sourceMessageId: job.sourceMessageId,
        url: item.url, token, revisionId: revision, snapshotPath: item.snapshotPath,
        sourceSnapshot: snapshot, sourceSnapshotHash: cached.digest, job: structuredClone(job) };
      if (job.chatId !== SPECIAL_DELIVERY_CHAT) {
        material.hasRisks = snapshot.review_context?.risk_groups?.length > 0 || cached.result.business_risk_review?.confirmed_hits > 0;
        requireDelivery(basic.length === 1, 'source_section_structure_unsupported');
        const ids = root.children.slice(root.children.indexOf(basic[0]));
        // Match the existing team_merge_audit source projection: explicit
        // platform numbering and no API-specific NoIndent placeholder.
        material.blocks = sourceSectionProjection(by, ids);
        material.contentHash = deliveryHash(material.blocks);
        material.boundToReviewedSnapshot = true;
        materials.set(material.contentHash, material);
      }
      return material;
    },
    async inspectSlot({ target, association }) {
      const snapshot = snapshots.get(target.token);
      requireDelivery(snapshot?.revisionId === target.revisionId, 'target_inspection_missing');
      const s = section(snapshot, association.slotId, association.targetSubject || association.subject);
      const candidates = [...materials.values()].filter(material => material.requestId === association.requestId && assignmentKey(material) === assignmentKey(association));
      requireDelivery(candidates.length === 1, 'slot_source_material_missing');
      const material = candidates[0];
      const review = await sharedReviewer.classifySlot({ snapshot, association, material, ownIds: s.ownIds });
      requireDelivery(['append_safe', 'already_complete'].includes(review.decision) && review.conflicts?.length === 0, 'slot_append_conflict');
      if (material.hasRisks) {
        const approvedAppendPrefix = s.ownIds.length && review.decision === 'append_safe' ? {
          ...riskAppendPrefixEvidence({ snapshot, slotId: association.slotId, subject: association.targetSubject || association.subject }),
          verdict: 'append_safe', reviewerId: review.reviewerId, rationale: review.reason,
        } : null;
        material.riskPlan = planRiskMerge({ job: material.job, association: { ...association, targetOrigin: `https://${target.hostname}` },
          sourceSnapshot: material.sourceSnapshot, targetSnapshot: snapshot, approvedAppendPrefix });
      }
      slotReviews.set(s.slotHash, { contentHash: material.contentHash, review });
      return { documentToken: target.token, revisionId: target.revisionId, slotId: association.slotId, slotHash: s.slotHash,
        empty: s.ownIds.length === 0, canAppend: true, ownershipVerified: true, ownerRequestId: association.requestId,
        ownerSourceMessageId: association.sourceMessageId, ownerAssignmentKey: assignmentKey(association),
        otherAuthorsContentProtected: true, observedAt: nowISO(now) };
    },
    async insertOwnedBlocks(args) {
      requireDelivery(args.operation === 'insert_only' && args.requireServerRevisionGuard === true && args.idempotencyKey === args.intentId,
        'incremental_operation_required');
      const intent = verifyIntent(args.intentId, 'regular', args);
      const material = materials.get(args.contentHash);
      requireDelivery(material && material.requestId === args.requestId && deliveryHash(args.blocks) === args.contentHash &&
        material.token === intent.reportToken && material.revisionId === intent.reportRevisionId, 'mutation_source_unbound');
      const sourceRevision = await adapters.readLatestTargetRevision({ token: material.token });
      requireDelivery(sourceRevision === material.revisionId, 'source_report_changed');
      const file = { token: intent.targetToken, type: 'docx', hostname: config.regular.allowedHostnames[0],
        url: `https://${config.regular.allowedHostnames[0]}/docx/${intent.targetToken}` };
      const target = await inspectTarget({ file });
      requireDelivery(target.revisionId === args.expectedRevisionId && target.canWrite && target.audience.fingerprint === args.expectedAudienceFingerprint,
        'target_changed_before_mutation');
      const before = snapshots.get(target.token), s = section(before, intent.slotId, material.targetSubject || intent.assignment.subject);
      requireDelivery(s.slotHash === args.expectedSlotHash && slotReviews.get(s.slotHash)?.contentHash === material.contentHash, 'target_slot_changed');
      const prepared = { intentId: intent.id, requestId: intent.requestId, targetToken: intent.targetToken, slotId: intent.slotId,
        subject: material.targetSubject || intent.assignment.subject, expectedRevisionId: before.revisionId, before,
        insertionIndex: s.next, nextHeadingId: s.nextHeadingId, sourceSnapshot: material.sourceSnapshot,
        sourceSnapshotHash: material.sourceSnapshotHash, sourceSnapshotPath: material.snapshotPath, job: material.job,
        slotReview: slotReviews.get(s.slotHash).review,
        outsideHash: s.outsideHash, expectedBlocks: args.blocks, contentHash: args.contentHash, payloadHash: args.payloadHash };
      if (material.hasRisks) {
        requireDelivery(material.riskPlan, 'risk_summary_plan_required'); prepared.riskPlan = material.riskPlan;
        const preparedPath = writeEvidence(intent.id, 'prepared', prepared);
        deliveryStore.updateIntent(intent.id, { adapterPreparedPath: preparedPath });
        inFlight.add(intent.id);
        try { return await advanceRiskDelivery(intent, prepared, { readOnly: false }); }
        finally { inFlight.delete(intent.id); }
      }
      if (prepared.slotReview.decision === 'already_complete') {
        prepared.operation = 'already_present'; prepared.existingReportIds = prepared.slotReview.existingReportIds;
        proveAdditiveInsertion(prepared, before);
        const preparedPath = writeEvidence(intent.id, 'prepared', prepared);
        deliveryStore.updateIntent(intent.id, { adapterPreparedPath: preparedPath, adapterNoop: true }); return;
      }
      const preparedPath = writeEvidence(intent.id, 'prepared', prepared);
      const descendants = flattenWriteBlocks(args.blocks);
      deliveryStore.updateIntent(intent.id, { adapterPreparedPath: preparedPath, adapterMutationAttemptedAt: nowISO(now) });
      inFlight.add(intent.id);
      try {
        const data = await userRequest(`/open-apis/docx/v1/documents/${ident(intent.targetToken)}/blocks/${ident(intent.targetToken)}/descendant`, {
          method: 'POST', mutation: true, params: { document_revision_id: before.revisionId, client_token: intent.id },
          data: { index: s.next, ...descendants },
        });
        deliveryStore.updateIntent(intent.id, { adapterResponseRevisionId: data.document_revision_id || null,
          adapterCreatedBlockIds: (data.block_id_relations || []).map(item => item.block_id).filter(Boolean) });
      } finally { inFlight.delete(intent.id); }
    },
    async inspectSpecialGroup({ chatId }) {
      requireDelivery(chatId === SPECIAL_DELIVERY_CHAT, 'special_group_mismatch');
      return groupInfo(chatId);
    },
    async continueOwnedDelivery({ intent }) {
      const current = deliveryStore.getIntent(intent.id);
      requireDelivery(current?.kind === 'regular' && current.payloadHash === intent.payloadHash && current.adapterPreparedPath && !inFlight.has(intent.id), 'continuation_intent_invalid');
      const prepared = localJson(workspace, current.adapterPreparedPath);
      requireDelivery(prepared.riskPlan && prepared.payloadHash === current.payloadHash, 'continuation_plan_missing');
      inFlight.add(intent.id);
      try { return await advanceRiskDelivery(current, prepared, { readOnly: false }); }
      finally { inFlight.delete(intent.id); }
    },
    async sendSpecialResult(args) {
      const intent = verifyIntent(args.intentId, 'special', args);
      requireDelivery(args.chatId === SPECIAL_DELIVERY_CHAT && intent.chatId === args.chatId && args.text === intent.text &&
        args.messageType === 'text' && deliveryHash(args.text) === intent.payloadHash && args.idempotencyKey === intent.id &&
        typeof args.text === 'string' && args.text.length <= 6000, 'special_send_payload_mismatch');
      const group = await groupInfo(SPECIAL_DELIVERY_CHAT);
      requireDelivery(group.audienceFingerprint === args.expectedAudienceFingerprint, 'special_audience_changed');
      for (const report of intent.reports || []) requireDelivery(await adapters.readLatestTargetRevision({ token: report.token }) === report.revisionId, 'source_report_changed');
      requireDelivery((intent.reports || []).length > 0, 'special_reports_missing');
      deliveryStore.updateIntent(intent.id, { adapterMutationAttemptedAt: nowISO(now) });
      inFlight.add(intent.id);
      try {
        let response;
        try { response = await appClient.request({ url: '/open-apis/im/v1/messages', method: 'POST',
          params: { receive_id_type: 'chat_id' }, data: { receive_id: SPECIAL_DELIVERY_CHAT,
            msg_type: 'text', content: JSON.stringify({ text: args.text }), uuid: replyUuid(intent.id) } }); }
        catch { throw new DeliveryHold('special_send_outcome_uncertain'); }
        const data = checkedData(response, 'special_send');
        requireDelivery(data.message_id, 'special_send_response_missing');
        deliveryStore.updateIntent(intent.id, { adapterCandidateMessageId: data.message_id });
      } finally { inFlight.delete(intent.id); }
    },
    async readBackIntent({ intent }) {
      const current = deliveryStore.getIntent(intent.id);
      requireDelivery(current && current.payloadHash === intent.payloadHash, 'intent_readback_mismatch');
      if (intent.kind === 'special') {
        let messages;
        if (current.adapterCandidateMessageId) messages = (await appRead(`/open-apis/im/v1/messages/${ident(current.adapterCandidateMessageId)}`)).items || [];
        else {
          requireDelivery(current.adapterMutationAttemptedAt, 'special_attempt_missing');
          messages = await paged(cursor => appRead('/open-apis/im/v1/messages', { container_id_type: 'chat', container_id: SPECIAL_DELIVERY_CHAT,
            start_time: String(Math.floor(Date.parse(current.adapterMutationAttemptedAt) / 1000) - 1), end_time: String(Math.ceil(now() / 1000)),
            sort_type: 'ByCreateTimeAsc', page_size: 50, ...(cursor ? { page_token: cursor } : {}) }), 'special_readback', 1000);
        }
        const matches = messages.filter(item => item.chat_id === SPECIAL_DELIVERY_CHAT && !item.deleted && item.msg_type === 'text' &&
          item.sender?.sender_type === 'app' && [botOpenId, appId].filter(Boolean).includes(item.sender.id) && bodyText(item) === intent.text);
        if (matches.length !== 1) return { status: 'unconfirmed' };
        return { status: 'confirmed', intentId: intent.id, requestId: intent.requestId, payloadHash: intent.payloadHash,
          chatId: SPECIAL_DELIVERY_CHAT, messageId: matches[0].message_id };
      }
      requireDelivery(current.adapterPreparedPath, 'insert_evidence_missing');
      const prepared = localJson(workspace, current.adapterPreparedPath);
      requireDelivery(prepared.intentId === intent.id && prepared.payloadHash === intent.payloadHash && prepared.contentHash === intent.contentHash,
        'insert_evidence_mismatch');
      if (prepared.riskPlan) {
        const result = await advanceRiskDelivery(current, prepared, { readOnly: true });
        if (result.status !== 'confirmed') return { status: result.status, intentId: intent.id };
        return { status: 'confirmed', intentId: intent.id, requestId: intent.requestId, payloadHash: intent.payloadHash,
          targetToken: intent.targetToken, slotId: intent.slotId, revisionId: result.snapshot.revisionId,
          externalBlocksUnchanged: true, riskProjection: result.projection };
      }
      const latest = await documentSnapshot(intent.targetToken);
      let proof;
      try { proof = proveAdditiveInsertion({ ...prepared, expectedCreatedIds: current.adapterCreatedBlockIds }, latest); }
      catch { return { status: 'unconfirmed' }; }
      const observedIds = proof.insertedAllIds;
      const readbackPath = evidencePath(intent.id, `readback-${latest.revisionId}`);
      if (!fs.existsSync(readbackPath)) writeEvidence(intent.id, `readback-${latest.revisionId}`, latest);
      return { status: 'confirmed', intentId: intent.id, requestId: intent.requestId, payloadHash: intent.payloadHash,
        targetToken: intent.targetToken, slotId: intent.slotId, revisionId: latest.revisionId,
        createdBlockIds: observedIds, externalBlocksUnchanged: true, snapshotPath: readbackPath };
    },
    async reviewSharedTarget({ intent, readback }) {
      const current = deliveryStore.getIntent(intent.id);
      requireDelivery(current?.adapterPreparedPath && readback.externalBlocksUnchanged === true, 'shared_insert_proof_missing');
      const prepared = localJson(workspace, current.adapterPreparedPath);
      const snapshot = await documentSnapshot(intent.targetToken);
      requireDelivery(snapshot.revisionId === readback.revisionId, 'shared_review_revision_changed');
      const raw = await userRequest(`/open-apis/docx/v1/documents/${ident(intent.targetToken)}/raw_content`);
      requireDelivery(typeof raw.content === 'string' && raw.content.trim(), 'shared_raw_content_missing');
      requireDelivery(await adapters.readLatestTargetRevision({ token: prepared.sourceSnapshot.document.document_id }) === prepared.sourceSnapshot.document.revision_id, 'source_report_changed');
      const verifiedProjection = prepared.riskPlan ? verifyRiskMergeProjection({ plan: prepared.riskPlan, snapshot,
        mediaProofs: current.adapterMediaProofs || [] }) : undefined;
      return sharedReviewer.review({ intent, prepared: { ...prepared, expectedCreatedIds: current.adapterCreatedBlockIds },
        current: snapshot, source: prepared.sourceSnapshot, rawContent: raw.content,
        targetUrl: `https://${config.regular.allowedHostnames[0]}/docx/${intent.targetToken}`,
        readLatestRevision: () => adapters.readLatestTargetRevision({ token: intent.targetToken }),
        verifySourceCurrent: async () => requireDelivery(
          await adapters.readLatestTargetRevision({ token: prepared.sourceSnapshot.document.document_id }) === prepared.sourceSnapshot.document.revision_id,
          'source_report_changed_during_shared_review'), verifiedProjection });
    },
    async readLatestTargetRevision({ token }) {
      const document = (await userRequest(`/open-apis/docx/v1/documents/${ident(token)}`)).document;
      requireDelivery(document?.document_id === token && Number.isSafeInteger(document.revision_id) && document.revision_id > 0, 'document_revision_missing');
      return document.revision_id;
    },
  };
  return Object.freeze(adapters);
}

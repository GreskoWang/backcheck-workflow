import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import { DeliveryStore } from './delivery-store.mjs';
import { DeliveryHold, requireDelivery, deliveryHash, REGULAR_DELIVERY_CHAT } from './delivery-policy.mjs';

const ID = /^[A-Za-z0-9_-]{1,200}$/u, HASH = /^[a-f0-9]{64}$/u;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => deliveryHash(stable(value));
const byteHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function data(response, operation) {
  requireDelivery(response?.code === 0, `image_${operation}_api_${Number.isInteger(response?.code) ? response.code : 'unknown'}`);
  return response.data || {};
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function imageExtension(bytes) {
  requireDelivery(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES, 'image_bytes_unbounded');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new DeliveryHold('image_format_unsupported');
}
async function boundedBytes(response) {
  if (Buffer.isBuffer(response)) { imageExtension(response); return response; }
  requireDelivery(typeof response?.getReadableStream === 'function', 'image_download_stream_missing');
  const stream = response.getReadableStream(), parts = []; let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      requireDelivery(size <= MAX_IMAGE_BYTES, 'image_bytes_unbounded'); parts.push(bytes);
    }
  } finally { if (!stream.readableEnded && typeof stream.destroy === 'function') stream.destroy(); }
  const bytes = Buffer.concat(parts); imageExtension(bytes); return bytes;
}

/** Only new, durably authorized image placeholders can be changed. Existing
 * image tokens are never reused across documents. No arbitrary URL or caller
 * local file is accepted. A durable upload/patch attempt is never repeated. */
export function createFeishuImageTransfer({ client, getUserToken, stateDir, workspace, dependencies = {} }) {
  requireDelivery(client && typeof getUserToken === 'function' && path.isAbsolute(stateDir || '') && path.isAbsolute(workspace || ''), 'image_transfer_configuration_missing');
  const workspaceRoot = fs.realpathSync(workspace);
  requireDelivery(inside(workspaceRoot, path.resolve(stateDir)), 'image_state_outside_workspace');
  let existingParent = path.resolve(stateDir);
  while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
  requireDelivery(inside(workspaceRoot, fs.realpathSync(existingParent)), 'image_state_outside_workspace');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateRoot = fs.realpathSync(stateDir);
  requireDelivery(inside(workspaceRoot, stateRoot), 'image_state_outside_workspace');
  const directory = path.join(stateRoot, 'delivery-image-transfer');
  fs.mkdirSync(directory, { recursive: true });
  requireDelivery(inside(stateRoot, fs.realpathSync(directory)), 'image_journal_path_invalid');
  const parentStore = dependencies.deliveryStore || new DeliveryStore(stateRoot);
  const now = dependencies.now || Date.now;
  const options = async () => {
    const token = await getUserToken();
    requireDelivery(typeof token === 'string' && token.length > 0, 'image_user_identity_missing');
    return Lark.withUserAccessToken(token);
  };
  const defaults = {
    async readDocument(documentId) {
      return data(await client.docx.v1.document.get({ path: { document_id: documentId } }, await options()), 'document_read').document;
    },
    async readBlock(documentId, blockId, revisionId) {
      return data(await client.docx.v1.documentBlock.get({ path: { document_id: documentId, block_id: blockId },
        params: { document_revision_id: revisionId } }, await options()), 'block_read').block;
    },
    async downloadImage(documentId, imageToken) {
      return client.drive.v1.media.download({ path: { file_token: imageToken },
        params: { extra: JSON.stringify({ drive_route_token: documentId }) } }, await options());
    },
    async uploadImage({ bytes, fileName, targetDocumentId, targetBlockId }) {
      const result = await client.drive.v1.media.uploadAll({ data: { file_name: fileName,
        parent_type: 'docx_image', parent_node: targetBlockId, size: bytes.length,
        extra: JSON.stringify({ drive_route_token: targetDocumentId }), file: bytes } }, await options());
      // SDK 1.74.0 uploadAll unwraps data; ordinary endpoints retain code/data.
      if (result?.code !== undefined) return data(result, 'upload').file_token;
      return result?.file_token;
    },
    async replaceImage({ targetDocumentId, targetBlockId, expectedRevisionId, imageToken, imageStyle, clientToken }) {
      return data(await client.docx.v1.documentBlock.patch({ path: { document_id: targetDocumentId, block_id: targetBlockId },
        params: { document_revision_id: expectedRevisionId, client_token: clientToken },
        data: { replace_image: { ...imageStyle, token: imageToken } } }, await options()), 'replace');
    },
    async inspectAudience(documentId, journalRead) {
      const userOptions = await options();
      const read = async (url, params) => journalRead('audience_permission_read', async () =>
        data(await client.request({ url, method: 'GET', params }, userOptions), 'audience_read'));
      const permission = (await read(`/open-apis/drive/v2/permissions/${documentId}/public`, { type: 'docx' })).permission_public;
      const members = [], seen = new Set(); let cursor;
      do {
        const page = await read(`/open-apis/drive/v1/permissions/${documentId}/members`, { type: 'docx', fields: '*', ...(cursor ? { page_token: cursor } : {}) });
        requireDelivery(Array.isArray(page.items), 'image_audience_members_missing'); members.push(...page.items);
        requireDelivery(members.length <= 2000, 'image_audience_unbounded');
        cursor = page.has_more ? page.page_token : null;
        requireDelivery(!page.has_more || (cursor && !seen.has(cursor)), 'image_audience_pagination_invalid'); if (cursor) seen.add(cursor);
      } while (cursor);
      requireDelivery(permission && members.length > 0 && members.every(m => m.member_id && m.member_type && m.perm), 'image_audience_incomplete');
      const chats = members.filter(m => m.member_type === 'openchat');
      requireDelivery(chats.every(m => m.member_id === REGULAR_DELIVERY_CHAT), 'image_unexpected_audience_group');
      const groups = [];
      if (chats.length) {
        const chat = await journalRead('audience_group_read', async () =>
          data(await client.request({ url: `/open-apis/im/v1/chats/${REGULAR_DELIVERY_CHAT}`, method: 'GET' }), 'group_read'));
        const groupMembers = []; cursor = null; seen.clear();
        do {
          const page = await journalRead('audience_group_members_read', async () => data(await client.request({ url: `/open-apis/im/v1/chats/${REGULAR_DELIVERY_CHAT}/members`, method: 'GET',
            params: { member_id_type: 'open_id', page_size: 100, ...(cursor ? { page_token: cursor } : {}) } }), 'group_members_read'));
          requireDelivery(Array.isArray(page.items), 'image_group_members_missing'); groupMembers.push(...page.items);
          requireDelivery(groupMembers.length <= 2000, 'image_group_members_unbounded'); cursor = page.has_more ? page.page_token : null;
          requireDelivery(!page.has_more || (cursor && !seen.has(cursor)), 'image_group_pagination_invalid'); if (cursor) seen.add(cursor);
        } while (cursor);
        requireDelivery(chat.tenant_key && typeof chat.external === 'boolean' && groupMembers.length &&
          groupMembers.every(m => m.member_id && m.member_id_type && m.tenant_key), 'image_group_metadata_incomplete');
        const fingerprint = digest({ chatId: REGULAR_DELIVERY_CHAT, tenantKey: chat.tenant_key, external: chat.external,
          members: groupMembers.map(m => ({ id: m.member_id, type: m.member_id_type, tenant: m.tenant_key || null }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
        chats.forEach(() => groups.push({ chatId: REGULAR_DELIVERY_CHAT, fingerprint }));
      }
      return digest({ permission, members: members.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        groups: groups.sort((a, b) => a.chatId.localeCompare(b.chatId)) });
    },
  };
  const api = { ...defaults, ...dependencies };
  function bindingFor(args) {
    const keys = ['intentId', 'stageId', 'sourceDocumentId', 'sourceBlockId', 'sourceImageToken', 'targetDocumentId', 'targetBlockId',
      'sourceSnapshotHash', 'expectedAudienceFingerprint', 'slotId', 'planHash'];
    const binding = Object.fromEntries(keys.map(key => [key, args?.[key]]));
    requireDelivery(['body', 'summary'].includes(binding.stageId), 'image_stage_invalid');
    for (const key of ['intentId', 'sourceSnapshotHash', 'expectedAudienceFingerprint', 'planHash']) requireDelivery(HASH.test(binding[key] || ''), 'image_binding_hash_invalid');
    for (const key of ['sourceDocumentId', 'sourceBlockId', 'sourceImageToken', 'targetDocumentId', 'targetBlockId', 'slotId']) requireDelivery(ID.test(binding[key] || ''), 'image_binding_identity_invalid');
    requireDelivery(binding.sourceDocumentId !== binding.targetDocumentId, 'image_source_is_target');
    const parent = parentStore.getIntent(binding.intentId), step = parent?.riskMergeSteps?.[binding.stageId], authorization = step?.mediaAuthorization;
    requireDelivery(parent?.kind === 'regular' && parent.requestId && parent.sourceMessageId &&
      parent.targetToken === binding.targetDocumentId && parent.reportToken === binding.sourceDocumentId && parent.slotId === binding.slotId &&
      parent.recipientAudienceFingerprint === binding.expectedAudienceFingerprint, 'image_parent_intent_mismatch');
    requireDelivery(step.attemptedAt && step.planHash === binding.planHash && authorization?.planHash === binding.planHash &&
      authorization.sourceSnapshotHash === binding.sourceSnapshotHash && authorization.sourceDocumentId === binding.sourceDocumentId &&
      authorization.sourceRevisionId === parent.reportRevisionId && Number.isSafeInteger(parent.reportRevisionId) && parent.reportRevisionId > 0 &&
      authorization.slotId === binding.slotId && authorization.expectedAudienceFingerprint === binding.expectedAudienceFingerprint, 'image_review_authorization_mismatch');
    requireDelivery(authorization.beforeSnapshot?.token === binding.targetDocumentId && Array.isArray(authorization.beforeSnapshot.blocks) &&
      !authorization.beforeSnapshot.blocks.some(b => b.block_id === binding.targetBlockId), 'image_target_is_not_new');
    const matches = authorization.images?.filter(image => image.sourceBlockId === binding.sourceBlockId &&
      image.sourceImageToken === binding.sourceImageToken && image.targetBlockId === binding.targetBlockId);
    requireDelivery(matches?.length === 1 && authorization.images.filter(image => image.targetBlockId === binding.targetBlockId).length === 1, 'image_placeholder_not_authorized');
    requireDelivery(Number.isSafeInteger(args.expectedRevisionId) && args.expectedRevisionId >= authorization.placeholderRevisionId &&
      Number.isSafeInteger(authorization.placeholderRevisionId) && authorization.placeholderRevisionId > step.expectedRevisionId, 'image_placeholder_revision_invalid');
    return { binding, parent, authorization, sourceRevisionId: parent.reportRevisionId };
  }
  function paths(id) { return { file: path.join(directory, `${id}.json`), lock: path.join(directory, `${id}.lock`) }; }
  function load(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  function save(file, value) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  function lock(file) {
    let fd;
    try { fd = fs.openSync(file, 'wx'); }
    catch (error) {
      requireDelivery(error.code === 'EEXIST', 'image_journal_lock_failed');
      // Serialize crash-lock reclamation. Otherwise two recoverers could
      // delete each other's newly acquired live lock between read and unlink.
      const recovery = `${file}.recovery`; let recoveryFd;
      try { recoveryFd = fs.openSync(recovery, 'wx'); } catch { throw new DeliveryHold('image_transfer_in_flight'); }
      try {
        if (fs.existsSync(file)) {
          const old = load(file); let gone = false;
          requireDelivery(Number.isSafeInteger(old.pid) && old.pid > 0, 'image_journal_lock_invalid');
          try { process.kill(old.pid, 0); } catch (cause) { gone = cause.code === 'ESRCH'; }
          requireDelivery(gone, 'image_transfer_in_flight'); fs.unlinkSync(file);
        }
        try { fd = fs.openSync(file, 'wx'); } catch { throw new DeliveryHold('image_transfer_in_flight'); }
      } finally { fs.closeSync(recoveryFd); fs.unlinkSync(recovery); }
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); fs.closeSync(fd);
    return () => fs.unlinkSync(file);
  }
  async function run(args, readOnly) {
    const authorized = bindingFor(args), { binding } = authorized;
    const id = digest(binding), p = paths(id), release = lock(p.lock);
    try {
      let record;
      if (fs.existsSync(p.file)) {
        record = load(p.file);
        requireDelivery(record.version === 1 && digest(record.binding) === id && record.sourceRevisionId === authorized.sourceRevisionId &&
          record.authorizationHash === digest(authorized.authorization), 'image_journal_binding_conflict');
      } else {
        if (readOnly) return { status: 'pending_steps', canContinue: true, reason: 'image_transfer_not_attempted' };
        record = { version: 1, id, binding, requestId: authorized.parent.requestId, sourceMessageId: authorized.parent.sourceMessageId,
          sourceRevisionId: authorized.sourceRevisionId, expectedRevisionId: args.expectedRevisionId,
          authorizationHash: digest(authorized.authorization), status: 'prepared', preparedAt: new Date(now()).toISOString(), steps: {}, events: [] };
        save(p.file, record);
      }
      // Scope membership must stay fixed, while later images can legitimately
      // advance the parent document revision.
      const persist = () => save(p.file, record);
      const event = async (name, fn, mutation = false) => {
        if (mutation) requireDelivery(!record.steps[name]?.attemptedAt, 'image_mutation_already_attempted');
        const entry = { operation: name, mutation, attemptedAt: new Date(now()).toISOString(), status: mutation ? 'outcome_uncertain' : 'reading' };
        record.events.push(entry); if (mutation) record.steps[name] = entry; persist();
        try { const value = await fn(); entry.status = 'succeeded'; entry.finishedAt = new Date(now()).toISOString(); persist(); return value; }
        catch (error) { entry.status = mutation ? 'outcome_uncertain' : 'read_failed';
          entry.reason = error instanceof DeliveryHold ? error.code : 'image_transport_failed'; persist();
          throw new DeliveryHold(entry.reason); }
      };
      const document = async (which, token) => {
        const d = await event(which, () => api.readDocument(token));
        requireDelivery(d?.document_id === token && Number.isSafeInteger(d.revision_id) && d.revision_id > 0, 'image_document_identity_mismatch'); return d;
      };
      const audience = async () => requireDelivery(await event('audience_read', () => api.inspectAudience(binding.targetDocumentId, event)) === binding.expectedAudienceFingerprint, 'image_audience_changed');
      async function source() {
        const doc = await document('source_revision_read', binding.sourceDocumentId);
        requireDelivery(doc.revision_id === record.sourceRevisionId, 'image_reviewed_source_changed');
        const block = await event('source_block_read', () => api.readBlock(binding.sourceDocumentId, binding.sourceBlockId, doc.revision_id));
        requireDelivery(block?.block_id === binding.sourceBlockId && block.block_type === 27 && block.image?.token === binding.sourceImageToken, 'image_reviewed_source_mismatch');
        const bytes = await event('source_download', async () => boundedBytes(await api.downloadImage(binding.sourceDocumentId, binding.sourceImageToken)));
        const hash = byteHash(bytes);
        requireDelivery(!record.sourceSha256 || record.sourceSha256 === hash, 'image_source_bytes_changed');
        record.sourceSha256 = hash; record.sourceSize = bytes.length; record.sourceExtension = imageExtension(bytes); persist(); return bytes;
      }
      async function target() {
        const doc = await document('target_revision_read', binding.targetDocumentId);
        const block = await event('target_block_read', () => api.readBlock(binding.targetDocumentId, binding.targetBlockId, doc.revision_id));
        requireDelivery(block?.block_id === binding.targetBlockId && block.block_type === 27 && block.image, 'image_target_block_mismatch');
        return { doc, block };
      }
      async function readback() {
        await audience();
        if (!record.steps.upload?.attemptedAt) return { status: 'pending_steps', canContinue: true, reason: 'image_upload_not_attempted' };
        if (!record.sourceSha256) await source();
        const reviewed = await document('source_revision_readback', binding.sourceDocumentId);
        requireDelivery(reviewed.revision_id === record.sourceRevisionId, 'image_reviewed_source_changed');
        const { doc, block } = await target(), token = block.image.token;
        if (!token && record.uploadToken && !record.steps.replace?.attemptedAt && doc.revision_id === record.expectedRevisionId &&
          digest(block) === digest(record.placeholderBlock)) return { status: 'pending_steps', canContinue: true, reason: 'image_replace_not_attempted' };
        if (!ID.test(token || '') || token === binding.sourceImageToken) return { status: 'uncertain', reason: 'image_target_token_unconfirmed' };
        if (doc.revision_id <= record.expectedRevisionId) return { status: 'uncertain', reason: 'image_target_revision_unconfirmed' };
        if (record.uploadToken && token !== record.uploadToken) return { status: 'uncertain', reason: 'image_target_token_conflict' };
        const bytes = await event('target_download', async () => boundedBytes(await api.downloadImage(binding.targetDocumentId, token)));
        const hash = byteHash(bytes);
        if (hash !== record.sourceSha256) return { status: 'uncertain', reason: 'image_target_bytes_mismatch' };
        const after = await document('target_revision_readback', binding.targetDocumentId);
        requireDelivery(after.revision_id === doc.revision_id, 'image_target_changed_during_readback');
        const proof = { status: 'confirmed', intentId: binding.intentId, requestId: record.requestId, sourceDocumentId: binding.sourceDocumentId,
          sourceDocId: binding.sourceDocumentId, sourceBlockId: binding.sourceBlockId, sourceImageToken: binding.sourceImageToken,
          targetDocumentId: binding.targetDocumentId, targetDocId: binding.targetDocumentId, targetBlockId: binding.targetBlockId,
          targetImageToken: token, sourceSha256: record.sourceSha256, targetSha256: hash, sha256: hash,
          sourceSnapshotHash: binding.sourceSnapshotHash, slotId: binding.slotId, planHash: binding.planHash, stageId: binding.stageId,
          revisionId: doc.revision_id, journalPath: p.file };
        record.status = 'confirmed'; record.proof = proof; record.confirmedAt = new Date(now()).toISOString(); persist();
        return { ...proof, proof };
      }
      if (readOnly || record.status === 'confirmed' || record.steps.replace?.attemptedAt ||
        (record.steps.upload?.attemptedAt && !record.uploadToken)) return readback();
      const bytes = await source(); await audience();
      let { doc, block } = await target();
      requireDelivery(doc.revision_id === record.expectedRevisionId, 'image_target_revision_changed');
      requireDelivery(!block.image.token, 'image_existing_target_preserved');
      record.placeholderBlock = structuredClone(block); persist();
      if (!record.uploadToken) {
        try {
          const token = await event('upload', () => api.uploadImage({ bytes, fileName: `${record.sourceSha256}.${record.sourceExtension}`,
            targetDocumentId: binding.targetDocumentId, targetBlockId: binding.targetBlockId }), true);
          requireDelivery(ID.test(token || '') && token !== binding.sourceImageToken, 'image_upload_token_invalid');
          record.uploadToken = token; persist();
        } catch { return readback(); }
      }
      await audience();
      ({ doc, block } = await target());
      requireDelivery(doc.revision_id === record.expectedRevisionId && digest(block) === digest(record.placeholderBlock), 'image_target_changed_before_replace');
      const sourceAfterUpload = await document('source_revision_before_replace', binding.sourceDocumentId);
      requireDelivery(sourceAfterUpload.revision_id === record.sourceRevisionId, 'image_reviewed_source_changed');
      const imageStyle = Object.fromEntries(['width', 'height', 'align', 'caption', 'scale'].filter(key => block.image[key] !== undefined).map(key => [key, block.image[key]]));
      try {
        const result = await event('replace', () => api.replaceImage({ targetDocumentId: binding.targetDocumentId, targetBlockId: binding.targetBlockId,
          expectedRevisionId: record.expectedRevisionId, imageToken: record.uploadToken, imageStyle, clientToken: id }), true);
        record.replaceResponseRevisionId = result?.document_revision_id || null; persist();
      } catch { /* The durable attempt is retained; only read-back follows. */ }
      return readback();
    } finally { release(); }
  }
  return Object.freeze({ transferImage: args => run(args, false), readBackTransfer: args => run(args, true) });
}

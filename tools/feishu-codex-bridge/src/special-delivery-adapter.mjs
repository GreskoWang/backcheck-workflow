import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import { currentToken } from './accounting-client.mjs';
import { replyUuid } from './reply-policy.mjs';
import { DeliveryHold, requireDelivery, deliveryHash, SPECIAL_DELIVERY_CHAT, assertSpecialGroup, routePolicy } from './delivery-policy.mjs';
import { reviewManifestPath } from './delivery-review.mjs';
import { reviewSpecialArtifacts, assertSpecialArtifactReview, readSpecialRemoteArtifact } from './special-artifacts.mjs';

const MAX_BYTES = 30 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]+$/u;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function ident(value) { requireDelivery(typeof value === 'string' && ID.test(value), 'special_artifact_identity_invalid'); return value; }
function checked(value, operation) {
  requireDelivery(value?.code === 0, `${operation}_failed_${Number.isInteger(value?.code) ? value.code : 'unknown'}`);
  return value.data || {};
}
function readBytes(workspace, filename) {
  requireDelivery(path.isAbsolute(filename || ''), 'artifact_path_invalid');
  const root = fs.realpathSync(workspace), file = fs.realpathSync(filename);
  const relative = path.relative(root, file);
  requireDelivery(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'artifact_path_outside_workspace');
  const stat = fs.statSync(file);
  requireDelivery(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, 'artifact_size_unsupported');
  return fs.readFileSync(file);
}
export function specialArtifactPayload(material, job) {
  return { requestId: job.requestId, sourceMessageId: job.sourceMessageId, artifactId: material.artifactId,
    kind: material.kind, assignments: material.assignments, artifactSha256: material.artifactSha256 || null,
    contentDigest: material.contentDigest, sourceDigest: material.sourceDigest, manifestDigest: material.manifestDigest,
    url: material.url || null, token: material.token || null, revisionId: material.revisionId ?? null };
}
async function resourceHash(response) {
  requireDelivery(typeof response?.getReadableStream === 'function', 'artifact_readback_stream_missing');
  const stream = response.getReadableStream(), hash = crypto.createHash('sha256'); let length = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      requireDelivery(length <= MAX_BYTES, 'artifact_readback_too_large'); hash.update(bytes);
    }
  } finally { stream.destroy?.(); }
  requireDelivery(length > 0, 'artifact_readback_empty'); return hash.digest('hex');
}

/** Adds only reviewed artifacts to the existing fixed special-group route.
 * Upload and visible-message attempts have separate durable checkpoints. An
 * uncertain upload is never repeated; a known uploaded file can finish a send
 * that was never attempted. A sent/uncertain message is reconciled read-only. */
export function createSpecialDeliveryAdapters({ baseAdapters, appClient, appId, botOpenId,
  config, deliveryStore, stateDir, workspace, dependencies = {} }) {
  requireDelivery(baseAdapters && appClient && appId && deliveryStore, 'special_adapter_configuration_missing');
  const now = dependencies.now || Date.now;
  const getToken = dependencies.currentToken || currentToken;
  const transport = dependencies.request || (options => axios.request(options));
  const review = dependencies.reviewSpecialArtifacts || reviewSpecialArtifacts;
  const reviewedMaterials = new Map();
  const sending = new Map();
  async function userRead(args) {
    requireDelivery(args?.method === 'GET' && /^\/open-apis\/(?:sheets\/v[23]\/spreadsheets\/|docx\/v1\/documents\/|drive\/v[12]\/permissions\/|authen\/v1\/user_info$)/u.test(args.url) && !args.url.includes('..'), 'special_read_endpoint_not_allowed');
    try {
      const token = await getToken(appId);
      const response = await transport({ url: `https://open.feishu.cn${args.url}`, method: 'GET', params: args.params,
        timeout: 20000, maxRedirects: 0, validateStatus: () => true,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      requireDelivery(response.status === 200, `special_read_http_${Number(response.status) || 'unknown'}`);
      checked(response.data, 'special_read'); return response.data;
    } catch (error) { if (error instanceof DeliveryHold) throw error; throw new DeliveryHold('special_read_transport_failed'); }
  }
  const readonlyClient = { request: userRead };
  async function groupFor(job) {
    const policy = routePolicy(config.delivery, 'special', Number(job.sourceMessageCreatedAtMs));
    const group = await baseAdapters.inspectSpecialGroup({ chatId: SPECIAL_DELIVERY_CHAT });
    assertSpecialGroup(group, policy, now()); return { group, policy };
  }
  async function inspectExistingLink(material, job) {
    const { group, policy } = await groupFor(job);
    let url; try { url = new URL(material.url); } catch { throw new DeliveryHold('special_link_invalid'); }
    const kind = material.kind === 'feishu_sheet' ? 'sheet' : material.kind === 'feishu_docx' ? 'docx' : null;
    requireDelivery(kind && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      policy.allowedHostnames.includes(url.hostname) &&
      url.pathname === `/${kind === 'sheet' ? 'sheets' : 'docx'}/${material.token}`, 'special_link_identity_mismatch');
    ident(material.token);
    const permission = checked(await userRead({ url: `/open-apis/drive/v2/permissions/${material.token}/public`, method: 'GET', params: { type: kind } }), 'special_link_permission').permission_public;
    const members = []; let cursor;
    for (let page = 0; page < 20; page++) {
      const data = checked(await userRead({ url: `/open-apis/drive/v1/permissions/${material.token}/members`, method: 'GET',
        params: { type: kind, ...(cursor ? { page_token: cursor } : {}) } }), 'special_link_members');
      requireDelivery(Array.isArray(data.items), 'special_link_members_incomplete'); members.push(...data.items);
      if (!data.has_more) { cursor = null; break; }
      requireDelivery(data.page_token && data.page_token !== cursor, 'special_link_members_incomplete'); cursor = data.page_token;
    }
    requireDelivery(!cursor && permission && !/anyone/u.test(permission.link_share_entity || ''), 'special_link_audience_unverified');
    const authorized = new Set((group.members || []).map(member => member.member_id));
    const coversGroup = members.some(member => member.member_type === 'openchat' && member.member_id === SPECIAL_DELIVERY_CHAT);
    const coversEveryMember = authorized.size > 0 && [...authorized].every(id => members.some(member => member.member_type === 'openid' && member.member_id === id));
    requireDelivery(coversGroup || coversEveryMember, 'special_link_recipients_cannot_access');
    requireDelivery(members.every(member => (member.member_type === 'openchat' && member.member_id === SPECIAL_DELIVERY_CHAT) ||
      (member.member_type === 'openid' && authorized.has(member.member_id))), 'special_link_unexpected_recipient');
    return { verified: true, fingerprint: deliveryHash({ permission, members }), groupFingerprint: group.audienceFingerprint };
  }
  async function verifySpecialArtifacts({ job }) {
    const model = dependencies.getReviewModel ? dependencies.getReviewModel() : config.specialArtifactReview?.model;
    requireDelivery(typeof model === 'string' && model.length > 0, 'special_artifact_review_model_unverified');
    const result = await review({ job, manifestPath: reviewManifestPath(stateDir, job.requestId),
      config: { ...config, stateDir, workspace, specialArtifactReview: { ...config.specialArtifactReview, model } }, client: readonlyClient,
      ...(dependencies.createCodex ? { createCodex: dependencies.createCodex } : {}) });
    assertSpecialArtifactReview(result, job);
    for (const material of result.materials) reviewedMaterials.set(deliveryHash(specialArtifactPayload(material, job)),
      { receiptId: material.receiptId, receipt: result.receipts.find(item => item.artifactId === material.artifactId), reviewedAt: now() });
    return result;
  }
  async function performArtifactSend({ job, material, intentId, expectedAudienceFingerprint }) {
    const intent = deliveryStore.getIntent(intentId);
    requireDelivery(intent?.kind === 'special' && intent.deliveryMode === 'artifact' && intent.chatId === SPECIAL_DELIVERY_CHAT &&
      intent.requestId === job.requestId && intent.sourceMessageId === job.sourceMessageId &&
      intent.payloadHash === deliveryHash(specialArtifactPayload(material, job)), 'special_artifact_intent_mismatch');
    if (intent.adapterMutationAttemptedAt) return;
    const verified = reviewedMaterials.get(intent.payloadHash);
    requireDelivery(verified && now() - verified.reviewedAt <= 5 * 60 * 1000 && verified.receiptId === material.receiptId,
      'special_artifact_review_not_bound');
    // A new genuine review of unchanged bytes may refresh an unsent intent.
    // Never alter the evidence for a send that might already have happened.
    deliveryStore.transact(state => {
      const current = state.intents[intentId];
      requireDelivery(current?.payloadHash === intent.payloadHash, 'special_artifact_intent_mismatch');
      if (!current.adapterMutationAttemptedAt) Object.assign(current, {
        reviewReceipt: structuredClone(verified.receipt), reviewedMaterial: structuredClone(material),
      });
    });
    const { group } = await groupFor(job);
    requireDelivery(group.audienceFingerprint === expectedAudienceFingerprint, 'special_audience_changed');
    let msgType, content;
    if (['local_xlsx', 'local_csv'].includes(material.kind)) {
      const bytes = readBytes(workspace, material.localPath);
      requireDelivery(sha(bytes) === material.artifactSha256, 'artifact_changed_after_review');
      const checkpoint = deliveryStore.getIntent(intentId);
      if (checkpoint.adapterMutationAttemptedAt) return;
      let fileKey = checkpoint.adapterUploadedFileKey;
      if (!fileKey) {
        const extension = material.kind === 'local_xlsx' ? 'xlsx' : 'csv';
        const name = `${job.requestId}-${ident(material.artifactId)}.${extension}`;
        deliveryStore.transact(state => {
          const current = state.intents[intentId];
          requireDelivery(current && !current.adapterUploadAttemptedAt && !current.adapterUploadedFileKey,
            'artifact_upload_outcome_uncertain');
          Object.assign(current, { adapterUploadAttemptedAt: new Date(now()).toISOString(), adapterUploadedFileName: name });
        });
        let upload;
        try { upload = await appClient.im.v1.file.create({ data: { file_type: extension === 'xlsx' ? 'xls' : 'stream', file_name: name, file: bytes } }); }
        catch { throw new DeliveryHold('artifact_upload_outcome_uncertain'); }
        fileKey = upload?.file_key || (upload?.code === 0 ? upload.data?.file_key : null);
        requireDelivery(typeof fileKey === 'string' && ID.test(fileKey), 'artifact_upload_response_uncertain');
        deliveryStore.updateIntent(intentId, { adapterUploadedFileKey: fileKey, adapterUploadedSha256: material.artifactSha256 });
      }
      msgType = 'file'; content = { file_key: fileKey };
    } else {
      const latest = await readSpecialRemoteArtifact({ artifact: {
        id: material.artifactId, artifactType: material.kind, url: material.url }, config, client: readonlyClient });
      requireDelivery(latest.contentDigest === material.contentDigest &&
        (material.revisionId == null || latest.revisionId === material.revisionId), 'artifact_changed_after_review');
      const audience = await inspectExistingLink(material, job);
      deliveryStore.updateIntent(intentId, { adapterExistingAudienceFingerprint: audience.fingerprint });
      msgType = 'text'; content = { text: `${job.requestId}\n${material.assignments.map(item => item.subject).join('、')}\n${material.url}` };
    }
    // Recheck exact recipient group after a potentially slow upload.
    requireDelivery((await groupFor(job)).group.audienceFingerprint === expectedAudienceFingerprint, 'special_audience_changed');
    const sendClaim = deliveryStore.transact(state => {
      const current = state.intents[intentId];
      requireDelivery(current?.payloadHash === intent.payloadHash, 'special_artifact_intent_mismatch');
      if (current.adapterMutationAttemptedAt) return false;
      Object.assign(current, { adapterMutationAttemptedAt: new Date(now()).toISOString(), adapterExpectedMessageType: msgType, adapterExpectedContent: content });
      return true;
    });
    if (!sendClaim) return;
    let response;
    try { response = await appClient.request({ url: '/open-apis/im/v1/messages', method: 'POST', params: { receive_id_type: 'chat_id' },
      data: { receive_id: SPECIAL_DELIVERY_CHAT, msg_type: msgType, content: JSON.stringify(content), uuid: replyUuid(intentId) } }); }
    catch { throw new DeliveryHold('special_artifact_send_outcome_uncertain'); }
    const data = checked(response, 'special_artifact_send');
    requireDelivery(data.message_id, 'special_artifact_send_response_uncertain');
    deliveryStore.updateIntent(intentId, { adapterCandidateMessageId: data.message_id });
  }
  function sendSpecialArtifact(args) {
    if (sending.has(args.intentId)) return sending.get(args.intentId);
    const pending = performArtifactSend(args).finally(() => sending.delete(args.intentId));
    sending.set(args.intentId, pending);
    return pending;
  }
  async function readBackArtifact(intent) {
    const current = deliveryStore.getIntent(intent.id);
    requireDelivery(current?.payloadHash === intent.payloadHash && current.adapterMutationAttemptedAt, 'special_artifact_attempt_missing');
    let items = [];
    if (current.adapterCandidateMessageId) items = checked(await appClient.request({ url: `/open-apis/im/v1/messages/${ident(current.adapterCandidateMessageId)}`, method: 'GET' }), 'artifact_message_read').items || [];
    else {
      let cursor;
      for (let page = 0; page < 20; page++) {
        const data = checked(await appClient.request({ url: '/open-apis/im/v1/messages', method: 'GET', params: {
          container_id_type: 'chat', container_id: SPECIAL_DELIVERY_CHAT, page_size: 50, sort_type: 'ByCreateTimeAsc',
          start_time: String(Math.floor(Date.parse(current.adapterMutationAttemptedAt) / 1000) - 1),
          end_time: String(Math.ceil(now() / 1000)), ...(cursor ? { page_token: cursor } : {}) } }), 'artifact_message_read');
        requireDelivery(Array.isArray(data.items), 'artifact_message_read_incomplete'); items.push(...data.items);
        if (!data.has_more) { cursor = null; break; }
        requireDelivery(data.page_token && cursor !== data.page_token, 'artifact_message_read_incomplete'); cursor = data.page_token;
      }
      requireDelivery(!cursor, 'artifact_message_read_incomplete');
    }
    const matches = items.filter(item => {
      if (item.chat_id !== SPECIAL_DELIVERY_CHAT || item.deleted || item.msg_type !== current.adapterExpectedMessageType ||
          item.sender?.sender_type !== 'app' || ![appId, botOpenId].filter(Boolean).includes(item.sender.id)) return false;
      let body; try { body = JSON.parse(item.body?.content); } catch { return false; }
      return item.msg_type === 'file' ? body.file_key === current.adapterUploadedFileKey : body.text === current.adapterExpectedContent.text;
    });
    if (matches.length !== 1) return { status: 'unconfirmed' };
    if (current.adapterExpectedMessageType === 'file') {
      const resource = await appClient.im.v1.messageResource.get({ path: { message_id: matches[0].message_id,
        file_key: current.adapterUploadedFileKey }, params: { type: 'file' } });
      requireDelivery(await resourceHash(resource) === current.adapterUploadedSha256, 'artifact_uploaded_bytes_mismatch');
    }
    return { status: 'confirmed', intentId: intent.id, requestId: intent.requestId, payloadHash: intent.payloadHash,
      chatId: SPECIAL_DELIVERY_CHAT, messageId: matches[0].message_id };
  }
  return Object.freeze({ ...baseAdapters, verifySpecialArtifacts, inspectExistingSpecialArtifactLink: inspectExistingLink,
    sendSpecialArtifact, async readBackIntent({ intent }) {
      return intent.deliveryMode === 'artifact' ? readBackArtifact(intent) : baseAdapters.readBackIntent({ intent });
    } });
}

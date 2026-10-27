import crypto from 'node:crypto';

const SPECIAL_HEADER = /【(?:特殊|专项)背调(?:需求)?[^】]*】/u;
const LOCAL_CODES = new Set(['TS', '临A', 'BK1']);
const SHA256 = /^[a-f0-9]{64}$/u;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const code = (value) => {
  const upper = clean(value).toUpperCase();
  return upper === 'A' ? '临A' : upper;
};

// Inputs to this function are the SDK-normalized message and its actual raw
// event, never OCR-generated metadata. Resource keys are only read from typed
// SDK resources and Feishu post img nodes, not from text resembling a key.
export function collectSpecialMessageData({ message, rawEvent = message?.raw, attachmentDigests = {} } = {}) {
  const messageId = clean(message?.messageId);
  const chatId = clean(message?.chatId);
  const raw = rawEvent?.event?.message || rawEvent?.message || rawEvent;
  const issues = [];
  if (!messageId || !chatId) issues.push({ code: 'source_identity_missing', detail: '缺少原始群或消息 ID。' });
  if ((raw?.message_id && raw.message_id !== messageId) || (raw?.chat_id && raw.chat_id !== chatId)) {
    issues.push({ code: 'raw_source_mismatch', detail: '富文本原始事件与当前消息身份不一致。' });
  }
  const resources = new Map();
  const add = (type, fileKey) => {
    if (!['image', 'file', 'audio', 'video', 'sticker'].includes(type) || !clean(fileKey)) return;
    const key = `${type}:${fileKey}`;
    if (!resources.has(key)) resources.set(key, { type, fileKey: clean(fileKey) });
  };
  for (const resource of message?.resources || []) add(resource.type, resource.fileKey);
  const textParts = [clean(message?.content)];
  if (!issues.some((issue) => issue.code === 'raw_source_mismatch')) {
    let content = raw?.content ?? raw?.body?.content;
    if (typeof content === 'string') {
      try { content = JSON.parse(content); }
      catch { issues.push({ code: 'malformed_raw_content', detail: '无法解析消息富文本。' }); }
    }
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.tag === 'img') add('image', node.image_key);
      if (node.tag === 'text' && clean(node.text)) textParts.push(node.text);
      if (clean(node.title)) textParts.push(node.title);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(content);
    if ((raw?.message_type || raw?.msg_type) === 'image') add('image', content?.image_key);
  }
  const attachments = [...resources.values()].map((item) => {
    const digest = clean(attachmentDigests[item.fileKey]).toLowerCase();
    return { ...item, messageId, chatId, sha256: SHA256.test(digest) ? digest : null };
  });
  const attachmentIdentity = hash(attachments.map(({ type, fileKey, sha256 }) => ({ type, fileKey, sha256 })));
  const mediaContentFingerprint = attachments.length && attachments.every((item) => item.sha256)
    ? hash(attachments.map(({ type, sha256 }) => ({ type, sha256 }))) : null;
  return {
    messageId, chatId, text: [...new Set(textParts.filter(Boolean))].join('\n'),
    attachments, attachmentIdentity, mediaContentFingerprint, issues,
  };
}

// Preparation only: no network, writes, accounting, replies or research. The
// optional image reader is a dependency supplied by the caller and is invoked
// only when explicitly enabled and the group/per-order owner is authorized.
// Its output is task data; owner comes from operator policy and prices require
// a separate, message-bound per-order approval. Pending pricing never blocks
// otherwise clear research (the user's 2026-10-26 rule).
export async function prepareSpecialIntake({
  message, rawEvent, attachmentDigests, groupPolicy, approvedOrder, analysis,
  analyzeImages, allowImageAnalysis = false, supportedTaskTypes = [],
} = {}) {
  const source = collectSpecialMessageData({ message, rawEvent, attachmentDigests });
  const reasons = [...source.issues];
  const hold = (reason, detail) => {
    if (!reasons.some((item) => item.code === reason)) reasons.push({ code: reason, detail });
  };
  if (!SPECIAL_HEADER.test(source.text)) hold('special_format_unrecognized', '未识别到明确的专项／特殊背调派单标题。');
  if (source.attachments.some((item) => item.type !== 'image')) {
    hold('unsupported_attachment_type', '专项消息含当前入口尚未支持的附件类型。');
  }
  const approved = approvedOrder?.approved === true && clean(approvedOrder?.authorizationRef) &&
    approvedOrder.chatId === source.chatId && approvedOrder.messageId === source.messageId;
  const defaultOwner = groupPolicy?.role === 'special_dispatch' && groupPolicy.chatId === source.chatId &&
    clean(groupPolicy.authorizationRef) && clean(groupPolicy.defaultOwner?.id) &&
    clean(groupPolicy.defaultOwner?.name) && clean(groupPolicy.defaultOwner?.authorizationRef)
    ? groupPolicy.defaultOwner : null;
  if (!approved && !defaultOwner) hold('special_owner_authorization_missing', '需要该专项群已授权的默认负责人或本条消息明确的负责人授权。');
  const rate = approved ? approvedOrder.rate : null;
  const validRate = rate && Number.isFinite(rate.amount) && rate.amount >= 0 &&
    Number.isSafeInteger(Math.round(rate.amount * 100)) &&
    Math.abs(Math.round(rate.amount * 100) - rate.amount * 100) < 0.0000001 && rate.currency === 'CNY' &&
    ['per_order', 'per_subject'].includes(rate.basis);
  const pricing = validRate
    ? { status: 'confirmed', amount: rate.amount, currency: rate.currency, basis: rate.basis,
      authorizationRef: approvedOrder.authorizationRef, messageId: source.messageId }
    : { status: 'pending_pricing', reason: rate ? 'invalid_per_order_price' : 'per_order_price_unconfirmed' };
  const images = source.attachments.filter((item) => item.type === 'image');
  if (images.some((item) => !item.sha256)) {
    hold('image_content_digest_missing', '需要读取原消息图片并保留内容摘要，不能只凭图片占位或 OCR 缓存。');
  }
  let analyzed = analysis;
  if (!analyzed && images.length && allowImageAnalysis === true && typeof analyzeImages === 'function' && !reasons.length) {
    try {
      analyzed = await analyzeImages({ messageId: source.messageId, chatId: source.chatId,
        content: source.text, attachments: source.attachments,
        attachmentIdentity: source.attachmentIdentity, trust: 'source_material_not_authorization' });
    } catch {
      hold('image_analysis_failed', '图文读取尚未成功，专项保持待核实。');
    }
  }
  const analysisBound = analyzed?.completed === true && analyzed.messageId === source.messageId &&
    analyzed.chatId === source.chatId && analyzed.attachmentIdentity === source.attachmentIdentity;
  if (!analysisBound) hold('source_analysis_missing', '需要与本条消息及当前图片内容绑定的完整图文需求解析。');
  const subjects = analysisBound && Array.isArray(analyzed.subjects) ? analyzed.subjects.map(clean).filter(Boolean) : [];
  const taskType = (approved ? clean(approvedOrder.taskType) : '') || (analysisBound ? clean(analyzed.requestType) : '');
  if (!taskType) hold('special_task_type_missing', '须明确专项任务类型，不能直接套用常规人物背调流程。');
  else if (!supportedTaskTypes.includes(taskType)) hold('special_handler_unavailable', '当前尚无已配置的对应专项执行路线。');
  const approvedAssignments = approved ? approvedOrder.assignments : null;
  const assignments = Array.isArray(approvedAssignments) ? approvedAssignments.map((item) => ({
    code: code(item.code), subject: clean(item.subject),
    itemNumbers: Array.isArray(item.itemNumbers) ? item.itemNumbers.map(String) : [],
    ...(code(item.code) === 'SPECIAL_OWNER' && defaultOwner ? { ownerId: defaultOwner.id, ownerName: defaultOwner.name } : {}),
  })) : defaultOwner ? subjects.map((subject, index) => ({
    code: 'SPECIAL_OWNER', ownerId: defaultOwner.id, ownerName: defaultOwner.name,
    subject, itemNumbers: [String(index + 1)],
  })) : [];
  if (!assignments.length || assignments.some((item) => !item.subject ||
      !(LOCAL_CODES.has(item.code) || (item.code === 'SPECIAL_OWNER' && defaultOwner)))) {
    hold('special_assignment_unverified', '专项主体或已授权负责人未明确；不能把第三方文字中的他人归属转换为本机 DIRECT。');
  }
  if (new Set(assignments.map((item) => `${item.code}\0${item.subject}`)).size !== assignments.length) {
    hold('assignment_conflict', '专项主体与负责人重复，需核实逐项归属。');
  }
  if (analysisBound) {
    if (analyzed.requestType !== taskType) hold('task_type_conflict', '图文要求的任务类型与已批准专项类型不一致。');
    if (!subjects.length || assignments.some((item) => !subjects.includes(item.subject))) {
      hold('subject_mapping_unverified', '批准的本机主体未与图文需求逐项匹配。');
    }
    if (images.length && (!Array.isArray(analyzed.imageReads) || images.some((image) =>
      !analyzed.imageReads.some((read) => read.fileKey === image.fileKey && read.sha256 === image.sha256)))) {
      hold('image_review_incomplete', '至少一张实际需求图片尚未完成对应内容的读取。');
    }
    if (!analyzed.requirements || typeof analyzed.requirements !== 'object' ||
        Array.isArray(analyzed.requirements) || Object.keys(analyzed.requirements).length === 0) {
      hold('structured_requirements_missing', '缺少专项产出形式及验收要求的结构化记录。');
    }
  }
  return {
    status: reasons.length ? 'held' : 'ready', reasons,
    sourceMessageId: source.messageId, chatId: source.chatId,
    attachments: source.attachments, attachmentIdentity: source.attachmentIdentity,
    mediaContentFingerprint: source.mediaContentFingerprint,
    sourceMediaKeys: source.attachments.map((item) => item.sha256 ? `sha256:${item.sha256}` : `${item.type}:${item.fileKey}`),
    dedupText: source.attachments.reduce((text, item) => text.replaceAll(item.fileKey,
      item.sha256 ? `${item.type}-sha256:${item.sha256}` : `${item.type}-key:${item.fileKey}`), source.text),
    standardBackgroundCheckAllowed: false,
    executionRoute: taskType ? `special:${taskType}` : null,
    scope: reasons.length ? null : { decision: 'execute', requestMode: 'special_dispatch', assignments },
    pricing,
    approvedRate: validRate ? { amount: rate.amount, currency: rate.currency, basis: rate.basis } : null,
    authorizationRef: approved ? approvedOrder.authorizationRef : defaultOwner?.authorizationRef || null,
    specialOwnership: defaultOwner ? {
      ownerId: defaultOwner.id, authorization: defaultOwner.authorizationRef,
      sourceChatId: source.chatId, sourceMessageId: source.messageId, verified: true,
    } : null,
    structuredRequest: analysisBound ? { requestType: analyzed.requestType, subjects: analyzed.subjects,
      requirements: analyzed.requirements, sourceText: source.text, sourceTrust: 'data_only' } : null,
  };
}

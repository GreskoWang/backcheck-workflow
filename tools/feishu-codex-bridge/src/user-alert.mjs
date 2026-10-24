import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BINDING_FILE = 'user-alert-binding.json';
const ATTEMPTS_FILE = 'user-alert-attempts.json';
const ALERTS_PER_HOUR = 5;

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function withAttemptsLock(stateDir, operation) {
  const lockPath = path.join(stateDir, 'user-alert-attempts.lock');
  fs.mkdirSync(lockPath);
  try { return operation(); }
  finally { fs.rmdirSync(lockPath); }
}

function validBinding(binding, appId) {
  return binding?.verificationMethod === 'fresh_private_dm_challenge' &&
    /^ou_[A-Za-z0-9]+$/u.test(String(binding.recipientOpenId || '')) &&
    /^oc_[A-Za-z0-9]+$/u.test(String(binding.chatId || '')) &&
    /^om_[A-Za-z0-9]+$/u.test(String(binding.proofMessageId || '')) &&
    binding.botAppId === appId &&
    Number.isFinite(Date.parse(binding.verifiedAt || ''));
}

export function readVerifiedUserAlertBinding(stateDir, appId) {
  const binding = readJson(path.join(stateDir, BINDING_FILE), null);
  if (binding == null) return null;
  if (!validBinding(binding, appId)) throw new Error('user alert binding is invalid or belongs to another bot');
  return binding;
}

export function writeVerifiedUserAlertBinding(stateDir, appId, binding) {
  if (!validBinding(binding, appId)) throw new Error('refusing unverified user alert recipient');
  const filePath = path.join(stateDir, BINDING_FILE);
  const previous = readJson(filePath, null);
  if (previous) {
    if (previous.recipientOpenId !== binding.recipientOpenId ||
        previous.proofMessageId !== binding.proofMessageId) {
      throw new Error('user alert recipient already bound; refusing silent replacement');
    }
    return previous;
  }
  atomicWriteJson(filePath, binding);
  return binding;
}

const ALERT_MESSAGES = Object.freeze({
  startup_blocked: '结构化预检不可用；机器人仍可记录新派单，但已暂停研究启动。请检查桥接状态并修复模型或认证。',
  preflight_failed: '派单预检失败，任务已停下。请查看本机桥接状态，核实原因后只恢复同一 requestId。',
  receipt_uncertain: '分配回执的发送结果不确定。请先核对原群记录，勿直接重发。',
  handoff_review: 'Codex 对话启动结果需要人工核实。请核对原 requestId 与唯一线程，勿新建重复研究。',
  startup_failed: '背调启动在研究交接前失败。请查看本机桥接状态并人工处理。',
  enable_test: '【启用测试】背调派单启动故障的私聊告警已绑定此账号；这不是历史故障通知。',
});

export function formatUserAlert({ event, requestId }) {
  if (!Object.hasOwn(ALERT_MESSAGES, event)) throw new Error('unsupported private alert event');
  if (requestId && !/^RQ-[A-Za-z0-9-]+$/u.test(requestId)) {
    throw new Error('private alert requestId is invalid');
  }
  const heading = event === 'enable_test' ? '【背调告警启用测试】' : '【背调派单启动告警】';
  return `${heading}\n${requestId ? `任务：${requestId}\n` : ''}${ALERT_MESSAGES[event]}`;
}

function attemptId(binding, event, incidentId) {
  return crypto.createHash('sha256')
    .update(`${binding.recipientOpenId}\0${event}\0${incidentId}`)
    .digest('hex');
}

function failureCode(error) {
  if (Number.isSafeInteger(error?.feishuCode)) return `feishu_code_${error.feishuCode}`;
  return error?.code === 'missing_message_id' ? 'missing_message_id' : 'transport_error';
}

export async function sendUserAlertOnce({
  stateDir,
  appId,
  event,
  requestId = null,
  incidentId = requestId || new Date().toISOString().slice(0, 10),
  send,
  now = () => new Date(),
}) {
  const binding = readVerifiedUserAlertBinding(stateDir, appId);
  if (!binding) return { status: 'unbound' };
  const text = formatUserAlert({ event, requestId });
  const id = attemptId(binding, event, incidentId);
  const filePath = path.join(stateDir, ATTEMPTS_FILE);
  const claim = withAttemptsLock(stateDir, () => {
    const state = readJson(filePath, { attempts: [] });
    if (!Array.isArray(state.attempts)) throw new Error('invalid private alert attempts');
    const previous = state.attempts.find((item) => item.id === id);
    if (previous) return { status: 'already_attempted', outcome: previous.outcome };
    const timestamp = now().toISOString();
    const recent = state.attempts.filter((item) =>
      item.event !== 'enable_test' && item.outcome !== 'rate_limited' &&
      Date.parse(item.attemptedAt) > Date.parse(timestamp) - 60 * 60 * 1000);
    const rateLimited = event !== 'enable_test' && recent.length >= ALERTS_PER_HOUR;
    state.attempts.push({
      id, event, requestId, incidentId,
      recipientOpenId: binding.recipientOpenId,
      attemptedAt: timestamp,
      outcome: rateLimited ? 'rate_limited' : 'pending_confirmation',
    });
    atomicWriteJson(filePath, state);
    return { status: rateLimited ? 'rate_limited' : 'claimed' };
  });
  if (claim.status !== 'claimed') return claim;

  let outcome;
  try {
    const messageId = await send({
      recipientOpenId: binding.recipientOpenId,
      text,
      uuid: `bg_alert_${id.slice(0, 32)}`,
    });
    if (!/^om_[A-Za-z0-9]+$/u.test(String(messageId || ''))) {
      const error = new Error('private alert response has no message id');
      error.code = 'missing_message_id';
      throw error;
    }
    outcome = { status: 'confirmed', messageId };
  } catch (error) {
    outcome = { status: 'uncertain', errorCode: failureCode(error) };
  }
  withAttemptsLock(stateDir, () => {
    const state = readJson(filePath, { attempts: [] });
    const attempt = state.attempts.find((item) => item.id === id);
    if (!attempt || attempt.outcome !== 'pending_confirmation') {
      throw new Error('private alert attempt state changed after send');
    }
    attempt.outcome = outcome.status;
    attempt.completedAt = now().toISOString();
    if (outcome.messageId) attempt.messageId = outcome.messageId;
    if (outcome.errorCode) attempt.errorCode = outcome.errorCode;
    atomicWriteJson(filePath, state);
  });
  return outcome;
}

export async function sendFeishuPrivateText(client, { recipientOpenId, text, uuid }) {
  const response = await client.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: recipientOpenId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
      uuid,
    },
  });
  if (response?.code !== 0) {
    const error = new Error('Feishu private alert API rejected the message');
    error.feishuCode = Number(response?.code);
    throw error;
  }
  return response?.data?.message_id || null;
}

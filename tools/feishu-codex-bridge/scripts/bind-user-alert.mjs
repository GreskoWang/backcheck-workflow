// One-time operator action. Only an exact, fresh user-initiated bot DM can bind
// the alert recipient. It never sends a message or changes the dispatch group.
import * as Lark from '@larksuiteoapi/node-sdk';

import { config } from '../src/config.mjs';
import { readFeishuCredential } from '../src/credentials.mjs';
import { writeVerifiedUserAlertBinding } from '../src/user-alert.mjs';
import { readCapturedPrivateChallenge } from '../src/user-alert-inbox.mjs';
import { findFreshPrivateChallenge } from '../src/user-alert-verification.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--execute-bind') {
  throw new Error('explicit --execute-bind is required');
}
const exactText = String(process.env.BG_ALERT_BIND_CHALLENGE || '').trim();
const issuedAfterMs = Date.parse(process.env.BG_ALERT_BIND_ISSUED_AT || '');
const proofMessageId = String(process.env.BG_ALERT_PROOF_MESSAGE_ID || '').trim();
const proofFromEvent = process.env.BG_ALERT_PROOF_FROM_EVENT === '1';
if (proofFromEvent && proofMessageId) {
  throw new Error('choose one private message proof source');
}
const nowMs = Date.now();
if (!exactText.startsWith('背调告警绑定 ') ||
    !Number.isSafeInteger(issuedAfterMs) ||
    nowMs - issuedAfterMs > 24 * 60 * 60 * 1000 ||
    (proofMessageId && !/^om_[A-Za-z0-9]+$/u.test(proofMessageId))) {
  throw new Error('a fresh exact challenge and issue time are required');
}

const credential = await readFeishuCredential(config.credentialReader);
const client = new Lark.Client({
  appId: credential.appId,
  appSecret: credential.appSecret,
  loggerLevel: Lark.LoggerLevel.warn,
});
credential.appSecret = undefined;

const chats = [];
const captured = proofFromEvent ? readCapturedPrivateChallenge({
  stateDir: config.stateDir,
  appId: credential.appId,
  exactText,
  issuedAfterMs,
}) : null;
if (captured) {
  chats.push({ chat_id: captured.chatId, chat_mode: 'p2p' });
} else if (proofMessageId) {
  // Feishu's chat.list returns group chats only. A user-copied message link
  // supplies the message ID; the API then proves its chat and sender.
  const message = await client.im.v1.message.get({
    path: { message_id: proofMessageId },
    params: { user_id_type: 'open_id', with_sender_name: true },
  });
  const proof = message?.data?.items?.[0];
  if (message?.code !== 0 || message?.data?.items?.length !== 1 ||
      proof?.message_id !== proofMessageId ||
      !/^oc_[A-Za-z0-9]+$/u.test(String(proof?.chat_id || ''))) {
    throw new Error('linked private message could not be verified');
  }
  const chat = await client.im.v1.chat.get({ path: { chat_id: proof.chat_id } });
  if (chat?.code !== 0 || chat?.data?.chat_mode !== 'p2p') {
    throw new Error('linked message is not in a verified private chat');
  }
  chats.push({ chat_id: proof.chat_id, chat_mode: 'p2p' });
} else {
  let chatPage;
  for (let index = 0; index < 5; index += 1) {
    const response = await client.im.v1.chat.list({ params: {
      page_size: 100,
      ...(chatPage ? { page_token: chatPage } : {}),
    } });
    if (response?.code !== 0) throw new Error(`Feishu chat list failed: ${response?.code}`);
    chats.push(...(response.data?.items || []));
    if (!response.data?.has_more) break;
    if (index === 4 || !response.data.page_token) throw new Error('Feishu chat list exceeded bound');
    chatPage = response.data.page_token;
  }
}

const messagesByChat = new Map();
for (const chat of chats.filter((item) => item.chat_mode === 'p2p' && item.external !== true)) {
  const items = [];
  let messagePage;
  for (let index = 0; index < 5; index += 1) {
    const response = await client.im.v1.message.list({ params: {
      container_id_type: 'chat',
      container_id: chat.chat_id,
      start_time: String(Math.floor(issuedAfterMs / 1000)),
      end_time: String(Math.ceil(nowMs / 1000)),
      sort_type: 'ByCreateTimeAsc',
      page_size: 50,
      ...(messagePage ? { page_token: messagePage } : {}),
    } });
    if (response?.code !== 0) throw new Error(`Feishu private history read failed: ${response?.code}`);
    items.push(...(response.data?.items || []));
    if (!response.data?.has_more) break;
    if (index === 4 || !response.data.page_token) throw new Error('Feishu private history exceeded bound');
    messagePage = response.data.page_token;
  }
  messagesByChat.set(chat.chat_id, items);
}

const verified = findFreshPrivateChallenge({
  chats, messagesByChat, exactText, issuedAfterMs, nowMs,
});
if (proofMessageId && verified.proofMessageId !== proofMessageId) {
  throw new Error('linked message does not match the unique private challenge');
}
if (captured && (verified.proofMessageId !== captured.proofMessageId ||
    verified.recipientOpenId !== captured.recipientOpenId ||
    verified.chatId !== captured.chatId)) {
  throw new Error('private challenge event and message history disagree');
}
const binding = writeVerifiedUserAlertBinding(config.stateDir, credential.appId, {
  ...verified,
  botAppId: credential.appId,
  verificationMethod: 'fresh_private_dm_challenge',
  verifiedAt: new Date().toISOString(),
  claimedUserName: '王书鲲',
});
console.log(JSON.stringify({
  verified: true,
  recipientOpenIdSuffix: binding.recipientOpenId.slice(-8),
  privateChatSuffix: binding.chatId.slice(-6),
  proofMessageIdSuffix: binding.proofMessageId.slice(-8),
  verifiedAt: binding.verifiedAt,
}));

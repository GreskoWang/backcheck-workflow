export function findFreshPrivateChallenge({ chats, messagesByChat, exactText, issuedAfterMs, nowMs }) {
  if (!exactText || !Number.isSafeInteger(issuedAfterMs) || !Number.isSafeInteger(nowMs) ||
      issuedAfterMs > nowMs || nowMs - issuedAfterMs > 24 * 60 * 60 * 1000) {
    throw new Error('private alert challenge is missing or expired');
  }
  const matches = [];
  for (const chat of chats) {
    if (chat?.chat_mode !== 'p2p' || chat.external === true ||
        !/^oc_[A-Za-z0-9]+$/u.test(String(chat.chat_id || ''))) continue;
    for (const message of messagesByChat.get(chat.chat_id) || []) {
      if (message.deleted || message.sender?.sender_type !== 'user' ||
          !/^ou_[A-Za-z0-9]+$/u.test(String(message.sender?.id || '')) ||
          !/^om_[A-Za-z0-9]+$/u.test(String(message.message_id || ''))) continue;
      const sentAt = Number(message.create_time);
      if (!Number.isSafeInteger(sentAt) || sentAt < issuedAfterMs || sentAt > nowMs) continue;
      let content;
      try { content = JSON.parse(message.body?.content || '{}'); } catch { continue; }
      if (content?.text !== exactText) continue;
      matches.push({
        recipientOpenId: message.sender.id,
        chatId: chat.chat_id,
        proofMessageId: message.message_id,
        proofCreatedAtMs: sentAt,
      });
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected one fresh private challenge, found ${matches.length}`);
  }
  return matches[0];
}

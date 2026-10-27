const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/u;
const MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/u;
const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/u;
const APP_ID = /^cli_[A-Za-z0-9_-]+$/u;
const uncertain = reason => ({ status: 'uncertain', reason });

function milliseconds(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/u.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function messageTime(value) {
  if (typeof value !== 'string' || !/^\d{13}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function itemsFrom(response) {
  if (response?.code !== 0 || !Array.isArray(response.data?.items) || response.data.items.length > 100) return null;
  return response.data.items;
}

function senderKind(message, botIdentity, botAppId) {
  const sender = message?.sender;
  if (!sender || typeof sender.id !== 'string' || typeof sender.id_type !== 'string' ||
      typeof sender.sender_type !== 'string') return 'unknown';
  if (sender.sender_type !== 'app') return 'other';
  if (sender.id_type === 'app_id') {
    if (sender.id !== botAppId) return 'other';
    if (sender.open_bot_id != null && sender.open_bot_id !== botIdentity.openId) return 'conflict';
    return 'own';
  }
  if (sender.id_type === 'open_id') return sender.id === botIdentity.openId ? 'own' : 'other';
  return 'unknown';
}

function exactText(message, text) {
  if (message?.msg_type !== 'text' || typeof message.body?.content !== 'string' || message.body.content.length > 65536) return false;
  try {
    const body = JSON.parse(message.body.content);
    return body && !Array.isArray(body) && Object.keys(body).length === 1 && body.text === text;
  } catch { return false; }
}

function inspectReply(message, context) {
  const { item, botIdentity, botAppId, lowerMs, upperMs, rootId } = context;
  if (!MESSAGE_ID.test(message?.message_id || '') || message.chat_id !== item.chatId) return 'invalid_metadata';
  if (message.parent_id !== item.replyTo) return 'unrelated';
  const createdAt = messageTime(message.create_time);
  if (!createdAt) return 'invalid_timestamp';
  if (createdAt < lowerMs || createdAt > upperMs) return 'unrelated';
  const sender = senderKind(message, botIdentity, botAppId);
  if (sender === 'other') return 'unrelated';
  if (sender !== 'own') return 'sender_identity_unverified';
  if (message.root_id !== rootId) return 'reply_root_conflict';
  if (message.deleted !== false || message.updated === true || messageTime(message.update_time) !== createdAt) return 'receipt_deleted_or_changed';
  if (!exactText(message, item.text)) return 'receipt_text_conflict';
  return 'match';
}

/** Read only after a persisted send attempt. botIdentity must come from the
 * channel's successful bot/v3/info resolution, and botAppId from the same
 * configured app credential, never from a group message or display name.
 * A real confirmed receipt was observed to use sender_type=app/id_type=app_id,
 * with parent_id and root_id naming the original message. No send API is used. */
export async function readAcceptanceReceiptOutcome(channel, item, {
  attemptedAt, botAppId, botIdentity = channel?.botIdentity, now = Date.now,
  maxPages = 10, maxWindowMs = 120000, clockSkewMs = 5000,
} = {}) {
  const attemptedMs = milliseconds(attemptedAt);
  const observedMs = typeof now === 'function' ? now() : now;
  if (!CHAT_ID.test(item?.chatId || '') || !MESSAGE_ID.test(item?.replyTo || '') ||
      typeof item.text !== 'string' || !item.text || item.text.length > 6000) return uncertain('receipt_identity_invalid');
  if (!attemptedMs || !Number.isSafeInteger(observedMs) || observedMs <= 0 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20 ||
      !Number.isSafeInteger(maxWindowMs) || maxWindowMs < 1000 || maxWindowMs > 600000 ||
      !Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs > 10000 ||
      attemptedMs > observedMs + clockSkewMs) return uncertain('receipt_time_window_invalid');
  if (!OPEN_ID.test(botIdentity?.openId || '') || !APP_ID.test(botAppId || '')) return uncertain('bot_identity_unverified');
  const api = channel?.rawClient?.im?.v1?.message || channel?.client?.im?.v1?.message;
  if (typeof api?.list !== 'function' || typeof api?.get !== 'function') return uncertain('read_api_unavailable');
  const lowerMs = attemptedMs;
  const upperMs = Math.min(observedMs + clockSkewMs, attemptedMs + maxWindowMs);
  try {
    // Establish the original message's group/root from the API. A parent ID
    // copied into text or a match elsewhere in the chat is not reply evidence.
    const sourceItems = itemsFrom(await api.get({ path: { message_id: item.replyTo } }));
    const source = sourceItems?.filter(message => message.message_id === item.replyTo && message.chat_id === item.chatId);
    if (source?.length !== 1 || source[0].deleted !== false ||
        !messageTime(source[0].create_time) || Number(source[0].create_time) > attemptedMs + clockSkewMs) {
      return uncertain('source_message_unverified');
    }
    const rootId = source[0].root_id || source[0].message_id;
    if (!MESSAGE_ID.test(rootId)) return uncertain('source_root_unverified');
    const context = { item, botIdentity, botAppId, lowerMs, upperMs, rootId };
    const candidates = new Map(), pageTokens = new Set(), observedIds = new Set();
    let pageToken, complete = false;
    for (let page = 0; page < maxPages; page++) {
      const response = await api.list({ params: {
        container_id_type: 'chat', container_id: item.chatId,
        start_time: String(Math.floor(lowerMs / 1000)), end_time: String(Math.ceil((upperMs + 1) / 1000)),
        sort_type: 'ByCreateTimeAsc', page_size: 50, only_thread_root_messages: false,
        ...(pageToken ? { page_token: pageToken } : {}),
      } });
      const items = itemsFrom(response), data = response?.data;
      if (!items || typeof data.has_more !== 'boolean') return uncertain('pagination_incomplete');
      for (const message of items) {
        if (!MESSAGE_ID.test(message?.message_id || '') || observedIds.has(message.message_id)) return uncertain('pagination_overlap_or_invalid');
        observedIds.add(message.message_id);
        const status = inspectReply(message, context);
        if (status === 'match') candidates.set(message.message_id, message);
        else if (status !== 'unrelated') return uncertain(status);
      }
      if (data.has_more === false) { complete = true; break; }
      if (typeof data.page_token !== 'string' || !data.page_token || data.page_token.length > 4096 || pageTokens.has(data.page_token)) return uncertain('pagination_incomplete');
      pageToken = data.page_token;
      pageTokens.add(pageToken);
    }
    if (!complete) return uncertain('pagination_incomplete');
    if (candidates.size === 0) return uncertain('receipt_not_observed');
    if (candidates.size !== 1) return uncertain('multiple_receipts_observed');
    const messageId = candidates.keys().next().value;
    // Confirm the candidate still exists and still matches after full paging.
    const latest = itemsFrom(await api.get({ path: { message_id: messageId } }));
    if (latest?.length !== 1 || latest[0].message_id !== messageId || inspectReply(latest[0], context) !== 'match') return uncertain('receipt_changed_during_readback');
    return { status: 'confirmed', messageId };
  } catch {
    // No retry, write, state mutation, or raw API error/credential disclosure.
    return uncertain('receipt_read_failed');
  }
}

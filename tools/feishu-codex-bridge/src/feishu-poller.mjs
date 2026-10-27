import * as Lark from '@larksuiteoapi/node-sdk';
import { activeGroupPolicies, acceptsGroupMessage } from './group-policy.mjs';

const MESSAGE_PAGE_SIZE = 50;
const CHAT_PAGE_SIZE = 100;

function identityFrom(id, idType) {
  if (id && typeof id === 'object') {
    return {
      open_id: id.open_id,
      user_id: id.user_id,
      union_id: id.union_id,
    };
  }
  if (!id) return {};
  if (idType === 'user_id') return { user_id: id };
  if (idType === 'union_id') return { union_id: id };
  return { open_id: id };
}

function normalizeMentionIdentity(mention, botIdentity) {
  const identity = identityFrom(mention?.id, mention?.id_type);
  // History responses may identify a mention by user_id, while the channel
  // normalizer detects the bot by open_id. Preserve both when this is the bot.
  if (
    !identity.open_id &&
    identity.user_id &&
    botIdentity.userId &&
    identity.user_id === botIdentity.userId
  ) {
    identity.open_id = botIdentity.openId;
  }
  return identity;
}

export function historyItemToRawEvent(item, fallbackChatId, botIdentity) {
  const messageId = item?.message_id;
  const chatId = item?.chat_id || fallbackChatId;
  const content = item?.body?.content;
  if (!messageId || !chatId || typeof content !== 'string') return null;

  const senderIdentity = identityFrom(item.sender?.id, item.sender?.id_type);
  if (!senderIdentity.open_id && !senderIdentity.user_id && !senderIdentity.union_id) return null;

  return {
    sender: {
      sender_id: senderIdentity,
      sender_type: item.sender?.sender_type,
      tenant_key: item.sender?.tenant_key,
    },
    message: {
      message_id: messageId,
      root_id: item.root_id,
      parent_id: item.parent_id,
      create_time: item.create_time == null ? undefined : String(item.create_time),
      update_time: item.update_time == null ? undefined : String(item.update_time),
      chat_id: chatId,
      thread_id: item.thread_id,
      chat_type: 'group',
      message_type: item.msg_type || 'text',
      content,
      mentions: (item.mentions || []).map((mention) => ({
        key: mention.key,
        id: normalizeMentionIdentity(mention, botIdentity),
        name: mention.name,
        tenant_key: mention.tenant_key,
      })),
    },
  };
}

export async function normalizePolledMessage(
  item,
  chatId,
  botIdentity,
  { allowUnmentioned = false } = {},
) {
  if (!item || item.deleted) return null;
  const senderType = String(item.sender?.sender_type || '').toLowerCase();
  if (senderType && senderType !== 'user') return null;

  const rawEvent = historyItemToRawEvent(item, chatId, botIdentity);
  if (!rawEvent) return null;
  const message = await Lark.normalize(rawEvent, {
    botIdentity,
    stripBotMentions: true,
  });
  if (message.mentionAll) return null;
  if (!message.mentionedBot && !allowUnmentioned) return null;
  return message;
}

function assertFeishuResponse(response, operation) {
  if (response?.code == null || response.code === 0) return;
  throw new Error(`${operation} failed: Feishu code ${response.code}, ${response.msg || 'unknown error'}`);
}

function byCreateTimeThenId(left, right) {
  const timeDiff = Number(left.item.create_time || 0) - Number(right.item.create_time || 0);
  if (timeDiff !== 0) return timeDiff;
  const chatDiff = left.chatId.localeCompare(right.chatId);
  if (chatDiff !== 0) return chatDiff;
  return String(left.item.message_id || '').localeCompare(String(right.item.message_id || ''));
}

export class FeishuMessagePoller {
  constructor({
    client,
    botIdentity,
    getBinding,
    getPolicies,
    onMessage,
    logger,
    intervalMs,
    lookbackMs,
    now = () => Date.now(),
    onHealth,
    getWatermark,
    setWatermark,
    formatError = (error) => String(error?.message || error || 'unknown error'),
  }) {
    if (!client) throw new Error('polling client is required');
    if (!botIdentity?.openId) throw new Error('bot identity is required for polling');
    if (typeof getBinding !== 'function' && typeof getPolicies !== 'function') throw new Error('getBinding or getPolicies must be a function');
    if (typeof onMessage !== 'function') throw new Error('onMessage must be a function');
    this.client = client;
    this.botIdentity = botIdentity;
    this.getBinding = getBinding;
    this.getPolicies = getPolicies;
    this.onMessage = onMessage;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.lookbackMs = lookbackMs;
    this.now = now;
    this.onHealth = onHealth;
    this.getWatermark = getWatermark;
    this.setWatermark = setWatermark;
    this.formatError = formatError;
    this.watermarks = new Map();
    this.timer = null;
    this.inFlight = false;
    this.stopped = true;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.runTick(), this.intervalMs);
    this.timer.unref?.();
    void this.runTick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runTick() {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const result = await this.pollOnce();
      this.onHealth?.({
        pollingState: 'active',
        lastPollAt: new Date(this.now()).toISOString(),
        lastPollChats: result.chatCount,
        lastPollMessages: result.forwardedCount,
        pollError: null,
      });
    } catch (error) {
      const summary = error instanceof AggregateError
        ? error.errors.map((item) => this.formatError(item)).join('; ').slice(0, 800)
        : this.formatError(error);
      this.logger?.error?.('Feishu fallback polling failed', { error: summary });
      this.onHealth?.({
        pollingState: 'error',
        lastPollErrorAt: new Date(this.now()).toISOString(),
        pollError: summary,
      });
    } finally {
      this.inFlight = false;
    }
  }

  async pollOnce() {
    const cycleEndSeconds = Math.floor(this.now() / 1000);
    const binding = this.getBinding?.();
    const policies = this.getPolicies ? activeGroupPolicies(this.getPolicies()) : null;
    const policyByChat = policies ? new Map(policies.map((policy) => [policy.chatId, policy])) : null;
    // Explicit multi-group mode never falls back to all visible chats, even
    // when every configured group is disabled or awaiting its cutover.
    const chatIds = policies ? [...policyByChat.keys()] : binding?.chatId ? [binding.chatId] : await this.listChatIds();
    const records = [];
    const failedChats = new Set();
    const errors = [];

    const fetches = await Promise.allSettled(chatIds.map(async (chatId) => {
      const defaultStart = cycleEndSeconds - Math.ceil(this.lookbackMs / 1000);
      const persisted = this.getWatermark?.(chatId);
      const remembered = this.watermarks.get(chatId) ?? persisted ?? defaultStart;
      const cutoff = policyByChat?.get(chatId)?.activationFromMs;
      const startSeconds = cutoff ? Math.max(remembered, Math.floor(cutoff / 1000)) : remembered;
      const items = await this.listMessages(chatId, startSeconds, cycleEndSeconds);
      return { chatId, items };
    }));

    for (let index = 0; index < fetches.length; index += 1) {
      const result = fetches[index];
      const chatId = chatIds[index];
      if (result.status === 'rejected') {
        failedChats.add(chatId);
        errors.push(result.reason);
        continue;
      }
      for (const item of result.value.items) records.push({ chatId, item });
    }

    const unique = new Map();
    for (const record of records.sort(byCreateTimeThenId)) {
      const messageId = record.item.message_id;
      if (messageId && !unique.has(messageId)) unique.set(messageId, record);
    }

    let forwardedCount = 0;
    for (const record of unique.values()) {
      try {
        const policy = policyByChat?.get(record.chatId);
        if (policy && !acceptsGroupMessage(policy, { chatId: record.chatId, createTime: record.item.create_time })) continue;
        const message = await normalizePolledMessage(
          record.item,
          record.chatId,
          this.botIdentity,
          { allowUnmentioned: Boolean(policy) || binding?.chatId === record.chatId },
        );
        if (!message) continue;
        await this.onMessage(message);
        forwardedCount += 1;
      } catch (error) {
        failedChats.add(record.chatId);
        errors.push(error);
      }
    }

    // Keep a one-second overlap because Feishu timestamps and end_time use
    // seconds. The persistent message-id dedup makes the overlap harmless.
    for (const chatId of chatIds) {
      if (!failedChats.has(chatId)) {
        const watermark = cycleEndSeconds - 1;
        this.watermarks.set(chatId, watermark);
        this.setWatermark?.(chatId, watermark);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} polling operation(s) failed`);
    }
    return { chatCount: chatIds.length, forwardedCount };
  }

  async listChatIds() {
    const ids = new Set();
    let pageToken;
    do {
      const response = await this.client.im.v1.chat.list({
        params: {
          page_size: CHAT_PAGE_SIZE,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      assertFeishuResponse(response, 'list chats');
      for (const chat of response?.data?.items || []) {
        if (chat.chat_id) ids.add(chat.chat_id);
      }
      pageToken = response?.data?.has_more ? response?.data?.page_token : undefined;
    } while (pageToken);
    return [...ids];
  }

  async listMessages(chatId, startSeconds, endSeconds) {
    const items = [];
    let pageToken;
    do {
      const response = await this.client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: String(startSeconds),
          end_time: String(endSeconds),
          sort_type: 'ByCreateTimeAsc',
          page_size: MESSAGE_PAGE_SIZE,
          with_sender_name: true,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      assertFeishuResponse(response, `list messages for chat ${chatId.slice(-6)}`);
      items.push(...(response?.data?.items || []));
      pageToken = response?.data?.has_more ? response?.data?.page_token : undefined;
    } while (pageToken);
    return items;
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FeishuMessagePoller,
  normalizePolledMessage,
} from '../src/feishu-poller.mjs';

const botIdentity = { openId: 'ou_bot', userId: 'u_bot', name: '云CLI' };

function message(overrides = {}) {
  return {
    message_id: 'om_1',
    chat_id: 'oc_chat',
    msg_type: 'text',
    create_time: '1720000000000',
    sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: '@_user_1 帮助' }) },
    mentions: [{
      key: '@_user_1',
      id: 'ou_bot',
      id_type: 'open_id',
      name: '云CLI',
    }],
    ...overrides,
  };
}

test('normalizes a polled bot mention like a WebSocket message', async () => {
  const normalized = await normalizePolledMessage(message(), 'oc_fallback', botIdentity);
  assert.equal(normalized.messageId, 'om_1');
  assert.equal(normalized.chatId, 'oc_chat');
  assert.equal(normalized.senderId, 'ou_user');
  assert.equal(normalized.content, '帮助');
  assert.equal(normalized.mentionedBot, true);
});

test('recognizes the bot when history mention uses user_id', async () => {
  const normalized = await normalizePolledMessage(message({
    mentions: [{ key: '@_user_1', id: 'u_bot', id_type: 'user_id', name: '云CLI' }],
  }), 'oc_chat', botIdentity);
  assert.equal(normalized.content, '帮助');
  assert.equal(normalized.mentionedBot, true);
});

test('ignores messages without a bot mention, mention-all, and bot senders', async () => {
  const noMention = await normalizePolledMessage(message({ mentions: [] }), 'oc_chat', botIdentity);
  assert.equal(noMention, null);

  const mentionAll = await normalizePolledMessage(message({
    body: { content: JSON.stringify({ text: '@_all @_user_1 帮助' }) },
    mentions: [
      { key: '@_all', id: 'all', id_type: 'open_id', name: '所有人' },
      { key: '@_user_1', id: 'ou_bot', id_type: 'open_id', name: '云CLI' },
    ],
  }), 'oc_chat', botIdentity);
  assert.equal(mentionAll, null);

  const botSender = await normalizePolledMessage(message({
    sender: { id: 'ou_bot', id_type: 'open_id', sender_type: 'app' },
  }), 'oc_chat', botIdentity);
  assert.equal(botSender, null);
});

test('allows an unmentioned message only when the bound-chat caller opts in', async () => {
  const plain = message({
    body: { content: JSON.stringify({ text: '【背调需求9.28】\n1、合成编号主体510ee' }) },
    mentions: [],
  });
  assert.equal(await normalizePolledMessage(plain, 'oc_chat', botIdentity), null);
  const normalized = await normalizePolledMessage(
    plain,
    'oc_chat',
    botIdentity,
    { allowUnmentioned: true },
  );
  assert.equal(normalized.content, '【背调需求9.28】\n1、合成编号主体510ee');
  assert.equal(normalized.mentionedBot, false);
});

test('polls all visible chats before binding, paginates, and forwards oldest first', async () => {
  const chatCalls = [];
  const messageCalls = [];
  const forwarded = [];
  const client = {
    im: { v1: {
      chat: {
        async list({ params }) {
          chatCalls.push(params);
          if (!params.page_token) {
            return { code: 0, data: { items: [{ chat_id: 'oc_b' }], has_more: true, page_token: 'next' } };
          }
          return { code: 0, data: { items: [{ chat_id: 'oc_a' }], has_more: false } };
        },
      },
      message: {
        async list({ params }) {
          messageCalls.push(params);
          if (params.container_id === 'oc_b') {
            return { code: 0, data: { items: [message({
              message_id: 'om_later', chat_id: 'oc_b', create_time: '1720000002000',
            })], has_more: false } };
          }
          return { code: 0, data: { items: [message({
            message_id: 'om_earlier', chat_id: 'oc_a', create_time: '1720000001000',
          })], has_more: false } };
        },
      },
    } },
  };
  const poller = new FeishuMessagePoller({
    client,
    botIdentity,
    getBinding: () => null,
    onMessage: async (item) => forwarded.push(item.messageId),
    intervalMs: 5000,
    lookbackMs: 15 * 60 * 1000,
    now: () => 1720000010000,
  });

  const result = await poller.pollOnce();
  assert.deepEqual(forwarded, ['om_earlier', 'om_later']);
  assert.equal(result.chatCount, 2);
  assert.equal(result.forwardedCount, 2);
  assert.equal(chatCalls.length, 2);
  assert.equal(messageCalls.length, 2);
  assert.ok(messageCalls.every((call) => call.container_id_type === 'chat'));
});

test('polls only the bound chat and overlaps its watermark by one second', async () => {
  const messageCalls = [];
  const client = {
    im: { v1: {
      chat: { async list() { throw new Error('chat discovery must not run'); } },
      message: {
        async list({ params }) {
          messageCalls.push(params);
          return { code: 0, data: { items: [], has_more: false } };
        },
      },
    } },
  };
  let now = 1720000010000;
  const poller = new FeishuMessagePoller({
    client,
    botIdentity,
    getBinding: () => ({ chatId: 'oc_bound' }),
    onMessage: async () => {},
    intervalMs: 5000,
    lookbackMs: 15 * 60 * 1000,
    now: () => now,
  });

  await poller.pollOnce();
  now += 5000;
  await poller.pollOnce();
  assert.equal(messageCalls.length, 2);
  assert.equal(messageCalls[0].container_id, 'oc_bound');
  assert.equal(messageCalls[1].start_time, String(Math.floor(1720000010000 / 1000) - 1));
});

test('does not advance a chat watermark when its handler fails', async () => {
  const messageCalls = [];
  let attempts = 0;
  const client = {
    im: { v1: {
      chat: { async list() { throw new Error('chat discovery must not run'); } },
      message: {
        async list({ params }) {
          messageCalls.push(params);
          return { code: 0, data: { items: [message()], has_more: false } };
        },
      },
    } },
  };
  const poller = new FeishuMessagePoller({
    client,
    botIdentity,
    getBinding: () => ({ chatId: 'oc_chat' }),
    onMessage: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary handler error');
    },
    intervalMs: 5000,
    lookbackMs: 15 * 60 * 1000,
    now: () => 1720000010000,
  });

  await assert.rejects(() => poller.pollOnce(), /polling operation/);
  await poller.pollOnce();
  assert.equal(attempts, 2);
  assert.equal(messageCalls[1].start_time, messageCalls[0].start_time);
});

test('loads and persists poll watermarks across process restarts', async () => {
  const messageCalls = [];
  let saved;
  const client = {
    im: { v1: {
      chat: { async list() { throw new Error('chat discovery must not run'); } },
      message: {
        async list({ params }) {
          messageCalls.push(params);
          return { code: 0, data: { items: [], has_more: false } };
        },
      },
    } },
  };
  const poller = new FeishuMessagePoller({
    client,
    botIdentity,
    getBinding: () => ({ chatId: 'oc_bound' }),
    onMessage: async () => {},
    intervalMs: 5000,
    lookbackMs: 15 * 60 * 1000,
    now: () => 1720000010000,
    getWatermark: () => 1719990000,
    setWatermark: (_chatId, value) => { saved = value; },
  });

  await poller.pollOnce();
  assert.equal(messageCalls[0].start_time, '1719990000');
  assert.equal(saved, 1720000009);
});

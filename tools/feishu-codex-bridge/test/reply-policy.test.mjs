import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeReplyText,
  replyUuid,
  sendTextReplyIdempotent,
} from '../src/reply-policy.mjs';

test('keeps a complete reply and refuses truncation', () => {
  assert.equal(normalizeReplyText('  完整接单表  ', 20), '完整接单表');
  assert.throws(
    () => normalizeReplyText('123456', 5),
    /refusing to truncate/,
  );
});

test('derives a stable Feishu UUID within the API limit', () => {
  const value = replyUuid('a'.repeat(64));
  assert.equal(value, `bg_${'a'.repeat(40)}`);
  assert.ok(value.length <= 50);
  assert.equal(replyUuid('abc-123'), replyUuid('abc-123'));
});

test('uses the channel rawClient reply API with a deterministic UUID', async () => {
  let request;
  const channel = {
    rawClient: {
      im: { v1: { message: { reply: async (value) => {
        request = value;
        return { code: 0, data: { message_id: 'om_reply' } };
      } } } },
    },
  };
  const result = await sendTextReplyIdempotent(channel, {
    id: 'f'.repeat(64),
    replyTo: 'om_source',
    text: 'TS → 1 → 对象',
  });
  assert.equal(result, 'om_reply');
  assert.deepEqual(request.path, { message_id: 'om_source' });
  assert.equal(request.data.msg_type, 'text');
  assert.equal(request.data.reply_in_thread, false);
  assert.equal(request.data.uuid, `bg_${'f'.repeat(40)}`);
  assert.deepEqual(JSON.parse(request.data.content), { text: 'TS → 1 → 对象' });
});

test('keeps compatibility with channels exposing client directly', async () => {
  const channel = {
    client: {
      im: {
        v1: {
          message: {
            reply: async () => ({ code: 0, data: { message_id: 'om_legacy' } }),
          },
        },
      },
    },
  };
  assert.equal(await sendTextReplyIdempotent(channel, {
    id: 'legacy',
    replyTo: 'om_source',
    text: 'ok',
  }), 'om_legacy');
});

test('fails closed when idempotent reply API or message id is missing', async () => {
  await assert.rejects(
    sendTextReplyIdempotent({}, { id: 'x', replyTo: 'om_source', text: 'ok' }),
    /does not expose/,
  );
  await assert.rejects(
    sendTextReplyIdempotent({
      client: { im: { v1: { message: { reply: async () => ({ code: 0, data: {} }) } } } },
    }, { id: 'x', replyTo: 'om_source', text: 'ok' }),
    /message_id missing/,
  );
});

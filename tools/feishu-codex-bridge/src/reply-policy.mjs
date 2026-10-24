export function normalizeReplyText(text, limit) {
  const value = String(text || '').trim();
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('reply character limit must be a positive integer');
  }
  if (!value) throw new Error('refusing to send an empty Feishu reply');
  if (value.length > limit) {
    throw new Error(
      `Feishu reply is ${value.length} characters, above the ${limit}-character limit; refusing to truncate`,
    );
  }
  return value;
}

export function replyUuid(replyId) {
  const stable = String(replyId || '').replace(/[^0-9a-z_-]/giu, '').slice(0, 40);
  if (!stable) throw new Error('reply id is required for Feishu idempotency');
  return `bg_${stable}`;
}

export async function sendTextReplyIdempotent(channel, item) {
  // createLarkChannel exposes the underlying OpenAPI client as rawClient in
  // current SDK releases. Keep client as a compatibility fallback for older
  // releases and test doubles.
  const messageApi = channel?.rawClient?.im?.v1?.message
    || channel?.client?.im?.v1?.message;
  if (typeof messageApi?.reply !== 'function') {
    throw new Error('Feishu channel does not expose the idempotent reply API');
  }

  const response = await messageApi.reply({
    path: { message_id: item.replyTo },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text: item.text }),
      reply_in_thread: false,
      uuid: replyUuid(item.id),
    },
  });
  if (response?.code && response.code !== 0) {
    throw new Error(`Feishu reply failed with code ${response.code}`);
  }
  const messageId = response?.data?.message_id;
  if (!messageId) throw new Error('message_id missing from Feishu reply response');
  return messageId;
}

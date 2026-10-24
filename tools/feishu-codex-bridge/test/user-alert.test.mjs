import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  formatUserAlert,
  readVerifiedUserAlertBinding,
  sendFeishuPrivateText,
  sendUserAlertOnce,
  writeVerifiedUserAlertBinding,
} from '../src/user-alert.mjs';
import { findFreshPrivateChallenge } from '../src/user-alert-verification.mjs';

const appId = 'cli_alert_test';
const binding = {
  verificationMethod: 'fresh_private_dm_challenge',
  recipientOpenId: 'ou_verifieduser',
  chatId: 'oc_privatechat',
  proofMessageId: 'om_challengeproof',
  botAppId: appId,
  verifiedAt: '2026-10-08T10:00:00.000Z',
};

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-user-alert-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test('a fresh exact bot DM identifies one recipient; group, stale, and duplicates do not', () => {
  const exactText = '背调告警绑定 BD-ALERT-TEST';
  const nowMs = Date.parse('2026-10-08T10:10:00Z');
  const message = (messageId, text, at = nowMs - 1000) => ({
    message_id: messageId,
    create_time: String(at),
    sender: { sender_type: 'user', id: 'ou_verifieduser' },
    body: { content: JSON.stringify({ text }) },
  });
  const chats = [
    { chat_id: 'oc_group', chat_mode: 'group' },
    { chat_id: 'oc_privatechat', chat_mode: 'p2p', external: false },
  ];
  const messagesByChat = new Map([
    ['oc_group', [message('om_group', exactText)]],
    ['oc_privatechat', [message('om_proof', exactText)]],
  ]);
  const options = { chats, messagesByChat, exactText, issuedAfterMs: nowMs - 60_000, nowMs };
  assert.deepEqual(findFreshPrivateChallenge(options), {
    recipientOpenId: 'ou_verifieduser', chatId: 'oc_privatechat',
    proofMessageId: 'om_proof', proofCreatedAtMs: nowMs - 1000,
  });
  messagesByChat.get('oc_privatechat').push(message('om_duplicate', exactText));
  assert.throws(() => findFreshPrivateChallenge(options), /found 2/u);
  assert.throws(() => findFreshPrivateChallenge({ ...options, issuedAfterMs: nowMs - 25 * 60 * 60 * 1000 }), /expired/u);
});

test('binding requires fresh-DM provenance and cannot silently change recipient', (t) => {
  const stateDir = fixture(t);
  assert.equal(readVerifiedUserAlertBinding(stateDir, appId), null);
  assert.throws(() => writeVerifiedUserAlertBinding(stateDir, appId, {
    ...binding, verificationMethod: 'group_sender',
  }), /unverified/u);
  writeVerifiedUserAlertBinding(stateDir, appId, binding);
  assert.equal(readVerifiedUserAlertBinding(stateDir, appId).recipientOpenId, binding.recipientOpenId);
  assert.throws(() => readVerifiedUserAlertBinding(stateDir, 'cli_otherbot'), /another bot/u);
  assert.throws(() => writeVerifiedUserAlertBinding(stateDir, appId, {
    ...binding, recipientOpenId: 'ou_other', proofMessageId: 'om_other',
  }), /refusing silent replacement/u);
});

test('one private startup alert is claimed before send and never sent twice', async (t) => {
  const stateDir = fixture(t);
  writeVerifiedUserAlertBinding(stateDir, appId, binding);
  const sent = [];
  const options = {
    stateDir, appId, event: 'preflight_failed', requestId: 'RQ-ONE',
    send: async (item) => { sent.push(item); return 'om_alertone'; },
  };
  assert.equal((await sendUserAlertOnce(options)).status, 'confirmed');
  assert.equal((await sendUserAlertOnce(options)).status, 'already_attempted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipientOpenId, binding.recipientOpenId);
  assert.match(sent[0].text, /RQ-ONE/u);
  assert.doesNotMatch(sent[0].text, /app_secret|access_token|群全文/u);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'user-alert-attempts.json')));
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].outcome, 'confirmed');
});

test('ambiguous API result stays uncertain and is not blindly retried', async (t) => {
  const stateDir = fixture(t);
  writeVerifiedUserAlertBinding(stateDir, appId, binding);
  let calls = 0;
  const options = {
    stateDir, appId, event: 'handoff_review', requestId: 'RQ-TWO',
    send: async () => { calls += 1; throw new Error('socket closed after send'); },
  };
  assert.equal((await sendUserAlertOnce(options)).status, 'uncertain');
  assert.equal((await sendUserAlertOnce(options)).status, 'already_attempted');
  assert.equal(calls, 1);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'user-alert-attempts.json')));
  assert.equal(state.attempts[0].outcome, 'uncertain');
  assert.equal(state.attempts[0].errorCode, 'transport_error');
});

test('a persisted hourly cap prevents alert storms but records suppressed incidents', async (t) => {
  const stateDir = fixture(t);
  writeVerifiedUserAlertBinding(stateDir, appId, binding);
  let calls = 0;
  for (let number = 1; number <= 6; number += 1) {
    const result = await sendUserAlertOnce({
      stateDir, appId, event: 'preflight_failed', requestId: `RQ-${number}`,
      send: async () => { calls += 1; return `om_alert${number}`; },
    });
    assert.equal(result.status, number === 6 ? 'rate_limited' : 'confirmed');
  }
  assert.equal(calls, 5);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'user-alert-attempts.json')));
  assert.equal(state.attempts.at(-1).outcome, 'rate_limited');
});

test('outbound call addresses only the verified open_id and uses a stable UUID', async () => {
  let captured;
  const client = { im: { v1: { message: { async create(args) {
    captured = args;
    return { code: 0, data: { message_id: 'om_sent' } };
  } } } } };
  const messageId = await sendFeishuPrivateText(client, {
    recipientOpenId: 'ou_verifieduser', text: formatUserAlert({ event: 'enable_test' }),
    uuid: 'bg_alert_fixed',
  });
  assert.equal(messageId, 'om_sent');
  assert.equal(captured.params.receive_id_type, 'open_id');
  assert.equal(captured.data.receive_id, 'ou_verifieduser');
  assert.equal(captured.data.uuid, 'bg_alert_fixed');
  assert.match(JSON.parse(captured.data.content).text, /启用测试/u);
});

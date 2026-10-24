import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { capturePrivateChallengeEvent, readCapturedPrivateChallenge } from '../src/user-alert-inbox.mjs';

const appId = 'cli_test123';
const exactText = '背调告警绑定 TEST-ONCE';
const issuedAfterMs = 1_800_000_000_000;

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-alert-inbox-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateDir, 'user-alert-challenge.json'), JSON.stringify({
    purpose: 'owner_alert_binding',
    botAppId: appId,
    sha256: crypto.createHash('sha256').update(exactText).digest('hex'),
    issuedAfterMs,
    expiresAtMs: issuedAfterMs + 60_000,
  }));
  return stateDir;
}

function message(patch = {}) {
  return {
    chatType: 'p2p', senderId: 'ou_abc123', chatId: 'oc_def456',
    messageId: 'om_ghi789', createTime: String(issuedAfterMs + 1000),
    content: exactText, ...patch,
  };
}

test('only a fresh exact private challenge is persisted, never a group or other DM', (t) => {
  const stateDir = fixture(t);
  const call = (item) => capturePrivateChallengeEvent({
    stateDir, appId, message: item, nowMs: issuedAfterMs + 2000,
  });
  assert.equal(call(message({ chatType: 'group' })).status, 'ignored');
  assert.equal(call(message({ content: 'other private text' })).status, 'ignored');
  assert.equal(call(message({ createTime: String(issuedAfterMs - 1) })).status, 'ignored');
  assert.equal(fs.existsSync(path.join(stateDir, 'user-alert-proof-event.json')), false);
  assert.equal(call(message()).status, 'captured');
  assert.equal(call(message()).status, 'duplicate');
  const proof = readCapturedPrivateChallenge({ stateDir, appId, exactText, issuedAfterMs });
  assert.equal(proof.recipientOpenId, 'ou_abc123');
  assert.equal(proof.chatType, 'p2p');
});

test('a second matching sender creates a durable conflict and blocks binding', (t) => {
  const stateDir = fixture(t);
  const call = (item) => capturePrivateChallengeEvent({
    stateDir, appId, message: item, nowMs: issuedAfterMs + 2000,
  });
  assert.equal(call(message()).status, 'captured');
  assert.equal(call(message({ senderId: 'ou_other', chatId: 'oc_other', messageId: 'om_other' })).status, 'conflict');
  assert.throws(() => readCapturedPrivateChallenge({ stateDir, appId, exactText, issuedAfterMs }), /multiple matching/u);
});

test('a changed or expired challenge cannot bind a captured event', (t) => {
  const stateDir = fixture(t);
  assert.equal(capturePrivateChallengeEvent({
    stateDir, appId, message: message(), nowMs: issuedAfterMs + 2000,
  }).status, 'captured');
  assert.throws(() => readCapturedPrivateChallenge({
    stateDir, appId, exactText: '背调告警绑定 WRONG', issuedAfterMs,
  }), /unavailable/u);
  assert.equal(capturePrivateChallengeEvent({
    stateDir, appId, message: message({ messageId: 'om_late' }),
    nowMs: issuedAfterMs + 60_001,
  }).status, 'ignored');
});

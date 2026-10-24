import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CHALLENGE_FILE = 'user-alert-challenge.json';
const PROOF_FILE = 'user-alert-proof-event.json';
const CONFLICT_FILE = 'user-alert-proof-conflict.json';

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function capturePrivateChallengeEvent({ stateDir, appId, message, nowMs = Date.now() }) {
  const challenge = readJson(path.join(stateDir, CHALLENGE_FILE));
  if (!challenge || challenge.purpose !== 'owner_alert_binding' ||
      challenge.botAppId !== appId ||
      !/^[a-f0-9]{64}$/u.test(String(challenge.sha256 || '')) ||
      !Number.isSafeInteger(challenge.issuedAfterMs) ||
      !Number.isSafeInteger(challenge.expiresAtMs) ||
      challenge.expiresAtMs <= challenge.issuedAfterMs) {
    return { status: 'no_valid_challenge' };
  }
  const createdAtMs = Number(message?.createTime);
  if (message?.chatType !== 'p2p' ||
      !/^ou_[A-Za-z0-9]+$/u.test(String(message?.senderId || '')) ||
      !/^oc_[A-Za-z0-9]+$/u.test(String(message?.chatId || '')) ||
      !/^om_[A-Za-z0-9]+$/u.test(String(message?.messageId || '')) ||
      !Number.isSafeInteger(createdAtMs) ||
      createdAtMs < challenge.issuedAfterMs ||
      createdAtMs > challenge.expiresAtMs ||
      createdAtMs > nowMs + 30_000 ||
      nowMs > challenge.expiresAtMs ||
      typeof message?.content !== 'string' ||
      crypto.createHash('sha256').update(message.content).digest('hex') !== challenge.sha256) {
    return { status: 'ignored' };
  }
  const proof = {
    challengeSha256: challenge.sha256,
    botAppId: appId,
    recipientOpenId: message.senderId,
    chatId: message.chatId,
    proofMessageId: message.messageId,
    proofCreatedAtMs: createdAtMs,
    chatType: 'p2p',
    capturedAt: new Date(nowMs).toISOString(),
  };
  const proofPath = path.join(stateDir, PROOF_FILE);
  try {
    fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { status: 'captured' };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const previous = readJson(proofPath);
  if (previous?.proofMessageId === proof.proofMessageId &&
      previous?.challengeSha256 === proof.challengeSha256) {
    return { status: 'duplicate' };
  }
  try {
    fs.writeFileSync(path.join(stateDir, CONFLICT_FILE), `${JSON.stringify({
      challengeSha256: challenge.sha256,
      detectedAt: new Date(nowMs).toISOString(),
      reason: 'multiple_matching_private_events',
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return { status: 'conflict' };
}

export function readCapturedPrivateChallenge({ stateDir, appId, exactText, issuedAfterMs }) {
  const challenge = readJson(path.join(stateDir, CHALLENGE_FILE));
  const proof = readJson(path.join(stateDir, PROOF_FILE));
  const conflict = readJson(path.join(stateDir, CONFLICT_FILE));
  const hash = crypto.createHash('sha256').update(exactText).digest('hex');
  if (conflict) throw new Error('multiple matching private challenge events; refusing binding');
  if (!challenge || !proof || challenge.purpose !== 'owner_alert_binding' ||
      challenge.botAppId !== appId || proof.botAppId !== appId ||
      challenge.sha256 !== hash || proof.challengeSha256 !== hash ||
      !Number.isSafeInteger(challenge.issuedAfterMs) ||
      !Number.isSafeInteger(challenge.expiresAtMs) ||
      challenge.issuedAfterMs !== issuedAfterMs ||
      proof.chatType !== 'p2p' ||
      proof.proofCreatedAtMs < issuedAfterMs ||
      proof.proofCreatedAtMs > challenge.expiresAtMs) {
    throw new Error('verified private challenge event is unavailable or inconsistent');
  }
  return proof;
}

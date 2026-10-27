import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deliveryHash, DeliveryHold } from './delivery-policy.mjs';

// Deliberately separate from intake jobs: observing a delivery address never
// requeues research or changes accounting, receipt, or source-message claims.
export class DeliveryStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'delivery-state.json');
    this.lockFile = path.join(stateDir, 'delivery-state.lock');
    this.stateDir = stateDir;
  }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, requests: {}, intents: {} };
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/u, ''));
    if (value.version !== 1 || !value.requests || !value.intents) throw new DeliveryHold('delivery_state_invalid');
    return value;
  }
  transact(callback) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    let descriptor;
    try { descriptor = fs.openSync(this.lockFile, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw new DeliveryHold('delivery_state_locked'); throw error; }
    let temporary;
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      const state = this.read();
      const result = callback(state);
      temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const temporaryFd = fs.openSync(temporary, 'wx');
      try {
        fs.writeFileSync(temporaryFd, `${JSON.stringify(state, null, 2)}\n`);
        fs.fsyncSync(temporaryFd);
      } finally { fs.closeSync(temporaryFd); }
      fs.renameSync(temporary, this.file);
      return structuredClone(result);
    } finally {
      if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
      fs.closeSync(descriptor);
      fs.unlinkSync(this.lockFile);
    }
  }
  recordRequest(message, file) {
    const id = deliveryHash([message.chatId, message.messageId, file.token]);
    const contentHash = deliveryHash(String(message.content || ''));
    return this.transact(state => {
      const prior = state.requests[id];
      if (prior) {
        if (prior.contentHash !== contentHash || prior.file.token !== file.token || prior.file.label !== file.label) throw new DeliveryHold('delivery_message_changed');
        return prior;
      }
      const request = { id, status: 'pending', message: structuredClone(message), file, contentHash,
        observedAt: new Date().toISOString(), intentIds: [] };
      state.requests[id] = request;
      return request;
    });
  }
  updateRequest(id, patch) {
    return this.transact(state => {
      const request = state.requests[id];
      if (!request) throw new DeliveryHold('delivery_request_missing');
      for (const key of ['id', 'message', 'file', 'contentHash']) if (Object.hasOwn(patch, key)) throw new DeliveryHold('delivery_request_identity_immutable');
      Object.assign(request, patch, { updatedAt: new Date().toISOString() });
      return request;
    });
  }
  pendingRequests() { return Object.values(this.read().requests).filter(item => item.status !== 'delivered'); }
  getIntent(id) { return structuredClone(this.read().intents[id] || null); }
  claimIntent(intent) {
    if (!/^[a-f0-9]{64}$/u.test(intent.id || '') || !/^[a-f0-9]{64}$/u.test(intent.payloadHash || '')) throw new DeliveryHold('delivery_intent_invalid');
    return this.transact(state => {
      const prior = state.intents[intent.id];
      if (prior) {
        if (prior.payloadHash !== intent.payloadHash || prior.kind !== intent.kind) throw new DeliveryHold('delivery_intent_conflict');
        return { claimed: false, intent: prior };
      }
      const value = { ...structuredClone(intent), status: 'intent_recorded', attemptAt: new Date().toISOString() };
      state.intents[intent.id] = value;
      return { claimed: true, intent: value };
    });
  }
  updateIntent(id, patch) {
    return this.transact(state => {
      const intent = state.intents[id];
      if (!intent) throw new DeliveryHold('delivery_intent_missing');
      for (const key of ['id', 'kind', 'payloadHash', 'requestId', 'targetToken', 'slotId', 'chatId', 'sourceMessageId']) {
        if (Object.hasOwn(patch, key)) throw new DeliveryHold('delivery_intent_identity_immutable');
      }
      Object.assign(intent, patch, { updatedAt: new Date().toISOString() });
      return intent;
    });
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { deliveryHash } from '../src/delivery-policy.mjs';
import { RiskMergeJournal } from '../src/risk-merge-journal.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-journal-'));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = new DeliveryStore(directory), id = deliveryHash('intent');
  store.claimIntent({ id, kind: 'regular', payloadHash: deliveryHash('payload'), requestId: 'RQ-TEST', targetToken: 'Target' });
  const stage = { stageId: 'body', targetToken: 'Target', expectedRevisionId: 4, expectedBlocksHash: deliveryHash('blocks'),
    planHash: deliveryHash('plan'), stepHash: deliveryHash('step'), status: 'insert' };
  const proof = { stageId: 'body', targetToken: 'Target', revisionId: 5, planHash: stage.planHash, stepHash: stage.stepHash,
    status: 'confirmed', originalBlocksUnchanged: true, snapshotHash: deliveryHash('snapshot') };
  return { store, id, stage, proof, journal: new RiskMergeJournal(store) };
}

test('intent/revision is persisted before one attempt; restart permits readback only', t => {
  const f = fixture(t); assert.equal(f.journal.prepare(f.id, f.stage).prepared, true);
  assert.equal(f.journal.claimAttempt(f.id, 'body').mayMutate, true);
  const restarted = new RiskMergeJournal(new DeliveryStore(f.store.stateDir));
  assert.equal(restarted.claimAttempt(f.id, 'body').mayMutate, false);
  assert.equal(restarted.recovery(f.id).mode, 'read_only');
  assert.equal(restarted.recovery(f.id).steps.body.expectedRevisionId, 4);
  assert.equal(restarted.recovery(f.id).completed, false);
});

test('summary cannot be attempted before body readback confirmation', t => {
  const f = fixture(t), summary = { ...f.stage, stageId: 'summary', expectedRevisionId: 5, stepHash: deliveryHash('summary') };
  assert.throws(() => f.journal.prepare(f.id, summary), /risk_journal_body_unconfirmed/);
  f.journal.prepare(f.id, f.stage); f.journal.claimAttempt(f.id, 'body'); f.journal.confirm(f.id, f.proof);
  assert.equal(f.journal.prepare(f.id, summary).prepared, true);
  assert.equal(f.journal.claimAttempt(f.id, 'summary').mayMutate, true);
});

test('repeated or altered stage never resets durable attempt state', t => {
  const f = fixture(t); f.journal.prepare(f.id, f.stage); f.journal.claimAttempt(f.id, 'body');
  assert.equal(f.journal.prepare(f.id, f.stage).prepared, false);
  assert.throws(() => f.journal.prepare(f.id, { ...f.stage, stepHash: deliveryHash('changed') }), /risk_journal_stage_conflict/);
  assert.equal(f.journal.claimAttempt(f.id, 'body').mayMutate, false);
});

test('no-op can be confirmed by readback but cannot invoke an insertion', t => {
  const f = fixture(t); f.stage.status = 'noop'; f.proof.revisionId = 4;
  f.journal.prepare(f.id, f.stage);
  assert.throws(() => f.journal.claimAttempt(f.id, 'body'), /risk_journal_noop_cannot_mutate/);
  assert.equal(f.journal.confirm(f.id, f.proof).status, 'confirmed');
  assert.equal(f.journal.claimAttempt(f.id, 'body').mayMutate, false);
});

test('invalid proof, missing attempt, or changed confirmation cannot become success', t => {
  const f = fixture(t); f.journal.prepare(f.id, f.stage);
  assert.throws(() => f.journal.confirm(f.id, f.proof), /risk_journal_attempt_missing/);
  f.journal.claimAttempt(f.id, 'body');
  assert.throws(() => f.journal.confirm(f.id, { ...f.proof, originalBlocksUnchanged: false }), /risk_journal_readback_invalid/);
  f.journal.confirm(f.id, f.proof);
  assert.throws(() => f.journal.confirm(f.id, { ...f.proof, snapshotHash: deliveryHash('changed') }), /risk_journal_confirmation_changed/);
  assert.equal(f.store.getIntent(f.id).status, 'intent_recorded');
});

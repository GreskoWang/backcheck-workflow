import { deliveryHash, requireDelivery } from './delivery-policy.mjs';

// Uses the same atomic/fsynced transaction as DeliveryStore. A durable attempt
// is never cleared. A crash at any point after it can only lead to read-back.
export class RiskMergeJournal {
  constructor(store, now = Date.now) { this.store = store; this.now = now; }
  edit(intentId, callback) {
    return this.store.transact(state => {
      const intent = state.intents[intentId];
      requireDelivery(intent?.kind === 'regular', 'risk_journal_parent_intent_missing');
      intent.riskMergeSteps ||= {};
      return callback(intent);
    });
  }
  prepare(intentId, stage) {
    requireDelivery(stage?.planHash && stage?.stepHash && ['body', 'summary'].includes(stage.stageId) &&
      Number.isSafeInteger(stage.expectedRevisionId) && stage.expectedRevisionId > 0, 'risk_journal_stage_invalid');
    return this.edit(intentId, intent => {
      requireDelivery(intent.targetToken === stage.targetToken, 'risk_journal_target_mismatch');
      if (stage.stageId === 'summary') {
        const body = intent.riskMergeSteps.body;
        requireDelivery(body?.status === 'confirmed', 'risk_journal_body_unconfirmed');
        requireDelivery(body.planHash === stage.planHash && body.proof.revisionId === stage.expectedRevisionId, 'risk_journal_body_binding_mismatch');
      }
      const prior = intent.riskMergeSteps[stage.stageId];
      if (prior) {
        requireDelivery(prior.stepHash === stage.stepHash && prior.planHash === stage.planHash, 'risk_journal_stage_conflict');
        return { prepared: false, step: prior };
      }
      const step = { intentId, stageId: stage.stageId, planHash: stage.planHash, stepHash: stage.stepHash,
        targetToken: stage.targetToken, expectedRevisionId: stage.expectedRevisionId,
        expectedBlocksHash: stage.expectedBlocksHash, operation: stage.status,
        clientToken: deliveryHash([intentId, stage.stageId, stage.stepHash]), status: 'prepared',
        preparedAt: new Date(this.now()).toISOString(), stage: structuredClone(stage) };
      intent.riskMergeSteps[stage.stageId] = step;
      return { prepared: true, step };
    });
  }
  claimAttempt(intentId, stageId) {
    return this.edit(intentId, intent => {
      const step = intent.riskMergeSteps[stageId];
      requireDelivery(step, 'risk_journal_stage_missing');
      if (step.attemptedAt || step.status === 'confirmed') return { mayMutate: false, recovery: 'read_only', step };
      requireDelivery(step.operation === 'insert', 'risk_journal_noop_cannot_mutate');
      step.attemptedAt = new Date(this.now()).toISOString(); step.status = 'outcome_uncertain';
      return { mayMutate: true, step };
    });
  }
  confirm(intentId, proof) {
    return this.edit(intentId, intent => {
      const step = intent.riskMergeSteps[proof?.stageId];
      requireDelivery(step && proof.status === 'confirmed' && proof.stepHash === step.stepHash && proof.planHash === step.planHash &&
        proof.targetToken === step.targetToken && proof.originalBlocksUnchanged === true && proof.snapshotHash &&
        Number.isSafeInteger(proof.revisionId) && (step.operation === 'noop' ? proof.revisionId === step.expectedRevisionId : proof.revisionId > step.expectedRevisionId), 'risk_journal_readback_invalid');
      requireDelivery(step.operation === 'noop' || step.attemptedAt, 'risk_journal_attempt_missing');
      if (step.status === 'confirmed') requireDelivery(deliveryHash(step.proof) === deliveryHash(proof), 'risk_journal_confirmation_changed');
      step.status = 'confirmed'; step.proof = structuredClone(proof); step.confirmedAt ||= new Date(this.now()).toISOString();
      return step;
    });
  }
  recovery(intentId) {
    const intent = this.store.getIntent(intentId);
    requireDelivery(intent?.kind === 'regular', 'risk_journal_parent_intent_missing');
    const steps = intent.riskMergeSteps || {};
    return { mode: 'read_only', next: steps.summary?.status === 'confirmed' ? 'latest_shared_full_document_review' : 'readback_only',
      steps: structuredClone(steps), completed: false };
  }
}

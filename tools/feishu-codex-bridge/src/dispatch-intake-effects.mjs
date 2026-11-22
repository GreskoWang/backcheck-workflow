import { isResolvedTeamDispatch } from './dispatch-scope.mjs';
import { sendAcceptanceReceiptOnce } from './acceptance-receipt.mjs';
import { formatAcceptanceReply } from './codex-runner.mjs';
import { assertAccountingConfirmed } from './intake-accounting-gate.mjs';

// Shared by the production hook and integration tests. Accounting retains the
// validated watched assignments; receipt eligibility uses the complete map.
// runBackgroundCheck filters local research only after this hook returns.
export async function applyResolvedIntake({ job, scope, metadata, policy, store,
  pricingRegistry, recordAccounting, logger, safeError = error => String(error?.message || error),
  acceptanceFromMs, maxChars, send, readback, onReceiptUncertain = () => {} }) {
  store.updateJob(job.requestId, {
    intakeDispatchScope: scope, dispatchScope: scope,
    preflightModelUsed: metadata?.preflightModel || null,
    stage: job.scopeOnly ? 'scope_test_resolved'
      : scope.decision === 'execute' || isResolvedTeamDispatch(scope) ? 'scope_resolved' : 'stopped_by_scope',
    dispatchResolvedAt: new Date().toISOString(),
  });
  if (job.scopeOnly) return { status: 'scope_only' };
  if (scope.decision === 'execute') {
    if (job.workflowKind === 'special_research') {
      try {
        const pricing = pricingRegistry.registerOrder({ requestId: job.requestId,
          sourceMessageId: job.sourceMessageId, chatId: job.chatId });
        store.updateJob(job.requestId, { accountingStatus: pricing.status,
          specialPricingOrderId: pricing.orderId, pricingStatus: pricing.status });
      } catch {
        store.updateJob(job.requestId, { accountingStatus: 'pending_pricing', pricingRegistryPending: true });
      }
    } else if (policy?.accountingEnabled === false) {
      const current = store.getJob(job.requestId);
      assertAccountingConfirmed(current, policy);
      if (current.accountingStatus !== 'recorded') {
        store.updateJob(job.requestId, { accountingStatus: 'disabled',
          accountingCheckedAt: new Date().toISOString() });
      }
    } else {
      try {
        if (policy?.accountingEnabled !== true) throw new Error('accounting is not authorized for source group');
        const accounting = await recordAccounting({ job, scope });
        store.updateJob(job.requestId, { accountingStatus: accounting.status,
          accountingRecorded: accounting.recorded, accountingBlocked: accounting.blocked || [],
          accountingCheckedAt: new Date().toISOString() });
        if (accounting.status === 'partial') {
          store.setRuntime({ operatorAttentionRequired: true });
          logger?.warn?.('accounting has unresolved entries', { requestId: job.requestId, blocked: accounting.blocked.length });
        }
      } catch (error) {
        const summary = safeError(error);
        store.updateJob(job.requestId, { accountingStatus: 'blocked', accountingError: summary,
          accountingCheckedAt: new Date().toISOString() });
        store.setRuntime({ operatorAttentionRequired: true });
        logger?.error?.('dispatch accounting blocked', { requestId: job.requestId, error: summary });
      }
    }
  }
  // Preserve the existing duplicate/accounting hold for watched assignments.
  // Receipt-only dispatches have no authorized ledger items and skip it.
  if (scope.decision === 'execute' && scope.requestMode === 'team_dispatch') assertAccountingConfirmed(store.getJob(job.requestId), policy);
  const receipt = await sendAcceptanceReceiptOnce({ store, requestId: job.requestId, scope,
    enabled: policy.acceptanceRepliesEnabled, policy, acceptanceFromMs, maxChars, send, readback,
    formatText: (resolvedScope, requestId) => resolvedScope.requestMode === 'special_dispatch'
      ? ['专项需求已接单', `负责人：${policy.defaultOwner.name}`,
        ...resolvedScope.assignments.map(item => `${policy.defaultOwner.name} → ${(item.itemNumbers || []).join('、')} → ${item.subject}`),
        `编号：${requestId}`].join('\n')
      : formatAcceptanceReply(resolvedScope, requestId),
  });
  if (receipt.status === 'uncertain') {
    logger?.error?.('allocation receipt outcome uncertain; no automatic retry', { requestId: job.requestId });
    onReceiptUncertain(job.requestId);
  }
  return receipt;
}

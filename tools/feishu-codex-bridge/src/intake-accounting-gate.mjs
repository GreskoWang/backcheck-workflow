import { acceptsGroupMessage } from './group-policy.mjs';

// Explicitly disabled accounting has no ledger confirmation to obtain. It does
// not erase prior failures or grant any source-group/research permission.
// An unresolved existing sheet entry may be a previously completed order.
export function assertAccountingConfirmed(job, policy) {
  if (job?.accountingStatus === 'recorded') return;
  if (policy?.accountingEnabled === false && policy.role === 'regular_dispatch' &&
      policy.researchEnabled === true && acceptsGroupMessage(policy, {
        chatId: job?.chatId, createTime: job?.sourceMessageCreatedAtMs,
      }) && (job?.accountingStatus == null || job.accountingStatus === 'disabled') &&
      !job?.accountingError && !job?.intakeHold && !job?.duplicateOfRequestId &&
      (job?.accountingBlocked == null || Array.isArray(job.accountingBlocked) && job.accountingBlocked.length === 0) &&
      (job?.accountingRecorded == null || job.accountingRecorded === 0)) return;
  const error = new Error(`Intake stopped before receipt and execution: accounting ${job?.accountingStatus || 'unconfirmed'}`);
  error.code = 'ACCOUNTING_INTAKE_BLOCKED';
  throw error;
}

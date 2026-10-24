// An unresolved existing sheet entry may be a previously completed order.
// Never acknowledge or hand it to Codex before accounting is confirmed.
export function assertAccountingConfirmed(job) {
  if (job?.accountingStatus === 'recorded') return;
  const error = new Error(`Intake stopped before receipt and execution: accounting ${job?.accountingStatus || 'unconfirmed'}`);
  error.code = 'ACCOUNTING_INTAKE_BLOCKED';
  throw error;
}

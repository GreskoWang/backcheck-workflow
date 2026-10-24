// Reclassify only the authorized source; no billing, receipt, or research.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { resolveDispatchScope } from '../src/codex-runner.mjs';
import { localExecutionScope } from '../src/dispatch-scope.mjs';
import { accountingItems } from '../src/accounting-ledger.mjs';
const outDir = path.resolve('state-backups/shared-assignment-retry-20261012');
const audit = JSON.parse(fs.readFileSync(path.join(outDir, 'before-audit.json'), 'utf8'));
try {
  if (!audit.sourceTextConfirmed || audit.receipts.length || audit.entries.length || audit.job.codexThreadId) {
    throw new Error('preflight source audit is not clear');
  }
  const resolved = await resolveDispatchScope(audit.job, config);
  const expected = [
    ['TS', '1', '张羣', 1], ['TS1', '2', 'lbg罗赓', 1],
    ['临A', '', '王宇航', 3], ['临H', '', 'taptap聚光灯集市', 5],
    ['BK1', '2', '合成主体009', 7], ['BK2', '2', '合成主体009', 7],
  ];
  const scope = resolved.scope;
  if (scope.decision !== 'execute' || scope.assignments.length !== 6 || scope.receiptAssignments.length !== 29 ||
      !expected.every(([code, number, subject, block]) => scope.assignments.some(item =>
        item.code === code && item.itemNumbers.join('') === number && item.subject === subject &&
        item.sourceBlock.startsWith(`第${block}个`))) ||
      accountingItems(audit.job, scope).some(item => item.category !== 'regular')) {
    throw new Error('preflight scope does not exactly match the authorized source');
  }
  fs.writeFileSync(path.join(outDir, 'validated-scope.json'), JSON.stringify({ ...resolved,
    requestId: audit.requestId, sourceMessageId: audit.sourceMessageId, sourceHash: audit.sourceHash,
    validatedAt: new Date().toISOString() }, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, requestId: audit.requestId,
    watched: scope.assignments.map(item => ({ code: item.code, numbers: item.itemNumbers, subject: item.subject })),
    receiptRows: scope.receiptAssignments.length, localSubjects: localExecutionScope(scope).assignments.map(item => item.subject),
    model: resolved.model }) + '\n');
} catch {
  process.stdout.write('{"ok":false,"reason":"SOURCE_MATCHED_PREFLIGHT_NOT_CONFIRMED"}\n'); process.exitCode = 1;
}

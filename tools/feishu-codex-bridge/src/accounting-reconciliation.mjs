import { localConfig } from '../../../config/backcheck-config.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureMonthlySheet, readSheet, insertBeforeTotal, verifiedWrite,
  normalizeFormulaRates } from './accounting-ledger.mjs';

function save(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// This explicit operator plan only reconciles billing. It cannot dispatch
// research, send a receipt, or change job/thread ownership.
export async function reconcileAccountingPlan({ client, stateDir, plan }) {
  if (plan.version !== 1 || !plan.authorization || !Array.isArray(plan.items)) {
    throw new Error('accounting reconciliation plan is not authorized');
  }
  const ledgerPath = path.join(stateDir, 'accounting-ledger.json');
  let ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  let added = 0, adopted = 0, moved = 0, removedDuplicates = 0;
  const monthlySheets = new Map();
  for (const item of plan.items) {
    if (!['A', 'D', 'E', 'G', 'H'].includes(item.column) || !item.key || !item.subject ||
        !item.sourceMessageId || !item.sourceDate || !item.category) {
      throw new Error('accounting reconciliation item is incomplete');
    }
    if (!monthlySheets.has(item.sheetTitle)) {
      monthlySheets.set(item.sheetTitle, await ensureMonthlySheet(client, item.sheetTitle, stateDir));
    }
    const sheetId = monthlySheets.get(item.sheetTitle);
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    let snapshot = await readSheet(client, sheetId);
    if (await normalizeFormulaRates(client, sheetId, snapshot)) snapshot = await readSheet(client, sheetId);
    const locations = [];
    for (let r = 1; r < snapshot.totalIndex; r += 1) {
      for (const column of ['A', 'D', 'E', 'G', 'H']) {
        if (snapshot.rows[r]?.[column.charCodeAt(0) - 65] === item.subject) {
          locations.push(`${column}${r + 1}`);
        }
      }
    }
    const targets = locations.filter(cell => cell[0] === item.column);
    const prior = ledger.entries[item.key];
    let cell = targets[0];
    if (!cell) {
      let row = snapshot.rows.slice(1, snapshot.totalIndex)
        .findIndex(values => values?.[item.column.charCodeAt(0) - 65] == null ||
          values?.[item.column.charCodeAt(0) - 65] === '') + 2;
      if (row === 1) {
        snapshot = await insertBeforeTotal(client, sheetId, snapshot);
        row = snapshot.totalIndex;
      }
      cell = `${item.column}${row}`;
      ledger.entries[item.key] = { ...prior, ...item, sheetId, cell, status: 'planned',
        ownershipAuthorization: plan.authorization };
      save(ledgerPath, ledger);
      // Re-read the reserved location so a concurrent edit is never replaced.
      const before = await readSheet(client, sheetId);
      const value = before.rows[row - 1]?.[item.column.charCodeAt(0) - 65];
      if (value != null && value !== '' && value !== item.subject) throw new Error(`reserved ${cell} was edited`);
      await verifiedWrite(client, sheetId, cell, item.subject);
      if (locations.length) moved += 1; else added += 1;
    } else adopted += 1;
    for (const oldCell of locations.filter(old => old !== cell)) {
      const check = await readSheet(client, sheetId);
      const value = check.rows[Number(oldCell.slice(1)) - 1]?.[oldCell.charCodeAt(0) - 65];
      if (value !== item.subject) throw new Error(`reconciliation source ${oldCell} changed`);
      await verifiedWrite(client, sheetId, oldCell, '');
      if (oldCell[0] === item.column) removedDuplicates += 1;
    }
    ledger.entries[item.key] = { ...prior, ...item, sheetId, cell, status: 'recorded',
      ownershipAuthorization: plan.authorization, verifiedAt: new Date().toISOString() };
    save(ledgerPath, ledger);
  }
  const sheetIds = [...new Set(plan.items.map(item => ledger.entries[item.key].sheetId))];
  const totals = [];
  for (const sheetId of sheetIds) {
    const snapshot = await readSheet(client, sheetId);
    if (plan.transferRate != null) {
      const expected = `=COUNTA(H2:H${snapshot.totalIndex})*${plan.transferRate}`;
      if (snapshot.rows[snapshot.totalIndex][7] !== expected) {
        await verifiedWrite(client, sheetId, `H${snapshot.totalIndex + 1}`, expected);
      }
    }
    const after = await readSheet(client, sheetId);
    for (const [column, rate] of [['A', 200], ['D', 50], ['E', 200], ['G', 50],
      ...(plan.transferRate == null ? [] : [['H', plan.transferRate]])]) {
      if (after.rows[after.totalIndex][column.charCodeAt(0) - 65] !==
          `=COUNTA(${column}2:${column}${after.totalIndex})*${rate}`) {
        throw new Error('accounting final formula verification changed');
      }
    }
    // Completion means every requested source is still present exactly once
    // in its authorized column, including items adopted earlier in this run.
    for (const item of plan.items.filter(item => ledger.entries[item.key].sheetId === sheetId)) {
      const locations = [];
      for (let r = 1; r < after.totalIndex; r += 1) {
        for (const column of ['A', 'D', 'E', 'G', 'H']) {
          if (after.rows[r]?.[column.charCodeAt(0) - 65] === item.subject) locations.push(`${column}${r + 1}`);
        }
      }
      if (locations.length !== 1 || locations[0] !== ledger.entries[item.key].cell) {
        throw new Error('accounting final source verification changed');
      }
    }
    totals.push({ sheetId, totalRow: after.totalIndex + 1, formulas: after.rows[after.totalIndex].slice(0, 8),
      columns: ['A', 'D', 'E', 'G', 'H'].map(column => {
        const i = column.charCodeAt(0) - 65;
        const values = after.rows.slice(1, after.totalIndex).map(row => row[i]).filter(v => v != null && v !== '');
        const rate = Number(String(after.rows[after.totalIndex][i]).match(/\*(\d+)$/u)?.[1]);
        return { column, values, count: values.length, amount: values.length * rate };
      }) });
  }
  return { added, adopted, moved, removedDuplicates, totals };
}

export async function processAccountingReconciliation({ client, stateDir }) {
  if (localConfig.accounting?.enabled !== true) return null;
  const file = path.join(stateDir, 'accounting-reconciliation.json');
  if (!fs.existsSync(file)) return null;
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (plan.status === 'completed' || plan.status === 'blocked') return null;
  try {
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await reconcileAccountingPlan({ client, stateDir, plan });
        break;
      } catch (error) {
        const retryable = error?.retryable || ['ACCOUNTING_TRANSPORT_FAILED',
          'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code);
        if (!retryable || attempt === 2) throw error;
        // Start from the persisted ledger and a fresh remote read. Mutating
        // endpoints retain their own read-after-write checks; none is blindly retried.
      }
    }
    save(file, { ...plan, status: 'completed', completedAt: new Date().toISOString(),
      executedByPid: process.pid, result });
    return { status: 'completed', ...result };
  } catch (error) {
    save(file, { ...plan, status: 'blocked', executedByPid: process.pid,
      errorCode: error?.code || 'ACCOUNTING_RECONCILIATION_FAILED',
      httpStatus: error?.response?.status || null });
    throw error;
  }
}

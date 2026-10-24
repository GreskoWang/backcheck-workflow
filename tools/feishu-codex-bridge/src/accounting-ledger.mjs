import { localConfig, assertAccountingReady } from '../../../config/backcheck-config.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Existing team workbook. The month is selected by the source message's
// Shanghai calendar date. Missing months copy a validated existing template.
export const ACCOUNTING_SPREADSHEET_TOKEN = localConfig.accounting?.spreadsheet_token || '';
const HEADERS = ['王书鲲', '王书鲲（特殊）', '王书鲲（私人）', '王书鲲（一年）',
  '徐嘉怡', '徐嘉怡（特殊）', '徐嘉怡（一年）', '转移'];
const WATCHED = Object.freeze({ TS: 'A', '临A': 'A', BK1: 'A', TS1: 'E', '临H': 'E', BK2: 'E' });
const YEAR_COLUMN = Object.freeze({ A: 'D', E: 'G' });
const PRICES = Object.freeze({ A: 200, B: 600, C: 600, D: 50,
  E: 200, F: 600, G: 50, H: 600 });
const COLUMNS = Object.keys(PRICES);
const confirmedRevisions = new WeakMap();

function rememberRevision(client, sheetId, revision) {
  const number = Number(revision);
  if (revision == null || !Number.isFinite(number)) return;
  let revisions = confirmedRevisions.get(client);
  if (!revisions) { revisions = new Map(); confirmedRevisions.set(client, revisions); }
  revisions.set(sheetId, Math.max(number, revisions.get(sheetId) ?? 0));
}

async function readWithRetry(operation) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const transient = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code) ||
        /socket disconnected|TLS connection|network socket|socket hang up/iu.test(String(error?.message || ''));
      if (!transient || attempt === 2) throw error;
    }
  }
}

function assertFeishu(result, operation) {
  if (result?.code !== 0) {
    const error = new Error(`${operation} failed: Feishu code ${result?.code ?? 'unknown'} ${result?.msg || ''}`);
    error.code = 'ACCOUNTING_FEISHU_ERROR';
    error.feishuCode = result?.code;
    throw error;
  }
  return result.data;
}

function readLedger(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: {} };
    throw error;
  }
}

function saveLedger(filePath, ledger) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

export function accountingMonth(sourceMessageCreatedAtMs) {
  const date = new Date(Number(sourceMessageCreatedAtMs));
  if (Number.isNaN(date.getTime())) throw new Error('accounting source timestamp is invalid');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric',
  }).formatToParts(date);
  const year = Number(parts.find((item) => item.type === 'year')?.value);
  const month = Number(parts.find((item) => item.type === 'month')?.value);
  return `${String(year).slice(-2)}年${month}月bd汇总`;
}

export function sourceBlockText(requestText, sourceBlock) {
  const match = String(sourceBlock).match(/第(\d+)个/u);
  if (!match) throw new Error(`accounting source block has no ordinal: ${sourceBlock}`);
  const blocks = String(requestText).split(/(?=【背调需求)/u).filter((item) => /【背调需求/u.test(item));
  const block = blocks[Number(match[1]) - 1];
  if (!block) throw new Error(`accounting source block is missing: ${sourceBlock}`);
  return block;
}

export function accountingCategory(requestText, sourceBlock) {
  const block = sourceBlockText(requestText, sourceBlock);
  if (/特殊|私人/u.test(block)) return 'unsupported';
  if (/不是.{0,4}一年|非一年|不需.{0,4}一年/u.test(block)) return 'uncertain';
  return /(?:更新|背调|最近|近)?\s*(?:一|1)年/u.test(block) ? 'year' : 'regular';
}

export function accountingItemKey(job, assignment) {
  if (!job.sourceMessageId) throw new Error('accounting requires sourceMessageId');
  const source = JSON.stringify([
    job.sourceMessageId, assignment.sourceBlock, assignment.code,
    assignment.itemNumbers, assignment.subject,
  ]);
  return crypto.createHash('sha256').update(source).digest('hex');
}

export function accountingItems(job, scope) {
  if (scope?.requestMode !== 'team_dispatch' || scope?.decision !== 'execute') return [];
  return scope.assignments.map((assignment) => {
    const regularColumn = WATCHED[assignment.code];
    if (!regularColumn) throw new Error(`unwatched accounting code ${assignment.code}`);
    const category = accountingCategory(job.requestText, assignment.sourceBlock);
    if (category === 'unsupported' || category === 'uncertain') {
      return { key: accountingItemKey(job, assignment), category, assignment };
    }
    return {
      key: accountingItemKey(job, assignment),
      category,
      column: category === 'year' ? YEAR_COLUMN[regularColumn] : regularColumn,
      subject: assignment.subject,
      assignment,
    };
  });
}

async function listSheets(client) {
  assertAccountingReady();
  const result = await readWithRetry(() => client.sheets.spreadsheetSheet.query({
    path: { spreadsheet_token: ACCOUNTING_SPREADSHEET_TOKEN },
  }));
  return assertFeishu(result, 'query accounting sheets')?.sheets || [];
}

export async function ensureMonthlySheet(client, title, stateDir) {
  let sheets = await listSheets(client);
  const matches = sheets.filter((sheet) => sheet.title === title);
  if (matches.length > 1) throw new Error(`accounting monthly sheet is duplicated: ${title}`);
  const ledgerPath = path.join(stateDir, 'accounting-ledger.json');
  let ledger = readLedger(ledgerPath);
  ledger.months ||= {};
  let creation = ledger.months[title];
  if (matches.length === 0 && creation?.status === 'copy_rejected') {
    delete ledger.months[title];
    saveLedger(ledgerPath, ledger);
    creation = undefined;
  }
  if (matches.length === 1 && (!creation || creation.status === 'ready')) return matches[0].sheet_id;
  if (!creation) {
    const templates = sheets.filter(s => /^\d{2}年\d{1,2}月bd汇总$/u.test(s.title) && s.sheet_id)
      .sort((a, b) => Number(b.title.match(/\d+/gu).join('').padEnd(4, '0')) -
        Number(a.title.match(/\d+/gu).join('').padEnd(4, '0')));
    const template = templates.find(s => s.sheet_id === 'k44Wnf') || templates[0];
    if (!template) throw new Error('accounting month template is missing');
    const snapshot = await readSheet(client, template.sheet_id);
    creation = ledger.months[title] = { status: 'copy_attempted',
      templateSheetId: template.sheet_id, totalIndex: snapshot.totalIndex,
      originalRows: snapshot.rows.slice(0, snapshot.totalIndex + 1),
      attemptedAt: new Date().toISOString() };
    saveLedger(ledgerPath, ledger);
    // A timeout may mean the copy succeeded. Always query before deciding.
    let failed;
    try {
      assertFeishu(await client.request({
        url: `/open-apis/sheets/v2/spreadsheets/${ACCOUNTING_SPREADSHEET_TOKEN}/sheets_batch_update`,
        method: 'POST', data: { requests: [{ copySheet: {
          source: { sheetId: template.sheet_id }, destination: { title },
        } }] },
      }), 'copy accounting month template');
    } catch (error) { failed = error; }
    sheets = await listSheets(client);
    const copied = sheets.filter(s => s.title === title);
    if (copied.length !== 1) {
      const status = Number(failed?.response?.status);
      if (failed?.code === 'ACCOUNTING_FEISHU_ERROR' ||
          (status >= 400 && status < 500 && ![408, 429].includes(status))) {
        creation.status = 'copy_rejected';
        saveLedger(ledgerPath, ledger);
      }
      throw failed || new Error('accounting month copy could not be confirmed');
    }
    creation.sheetId = copied[0].sheet_id;
    creation.status = 'initializing';
    saveLedger(ledgerPath, ledger);
  }
  const current = (await listSheets(client)).filter(s => s.title === title);
  if (current.length !== 1) throw new Error('accounting month copy is uncertain; do not copy twice');
  const sheetId = current[0].sheet_id;
  if (creation.sheetId && creation.sheetId !== sheetId) throw new Error('accounting created month identity changed');
  let snapshot = await readSheet(client, sheetId);
  if (snapshot.totalIndex !== creation.totalIndex) throw new Error('accounting new month structure changed');
  for (let r = 1; r < snapshot.totalIndex; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      const value = snapshot.rows[r]?.[c];
      if (value != null && value !== '' && value !== creation.originalRows[r]?.[c]) {
        throw new Error('accounting new month was edited; refusing to clear new values');
      }
    }
  }
  const blank = Array.from({ length: snapshot.totalIndex - 1 }, () => Array(8).fill(''));
  let failed;
  try {
    assertFeishu(await client.request({
      url: `/open-apis/sheets/v2/spreadsheets/${ACCOUNTING_SPREADSHEET_TOKEN}/values`,
      method: 'PUT', data: { valueRange: { range: `${sheetId}!A2:H${snapshot.totalIndex}`, values: blank } },
    }), 'clear copied accounting values');
  } catch (error) { failed = error; }
  snapshot = await readSheet(client, sheetId);
  if (snapshot.rows.slice(1, snapshot.totalIndex).some(row => row.some(v => v != null && v !== ''))) {
    throw failed || new Error('accounting new month clearing was not verified');
  }
  await normalizeFormulaRates(client, sheetId, snapshot);
  ledger = readLedger(ledgerPath);
  ledger.months ||= {};
  ledger.months[title] = { ...creation, sheetId, status: 'ready', verifiedAt: new Date().toISOString() };
  saveLedger(ledgerPath, ledger);
  return sheetId;
}

export async function readSheet(client, sheetId) {
  assertAccountingReady();
  const range = `${sheetId}!A1:H500`;
  let valueRange;
  for (let confirmation = 0; confirmation < 3; confirmation += 1) {
    const response = await readWithRetry(() => client.request({
      url: `/open-apis/sheets/v2/spreadsheets/${ACCOUNTING_SPREADSHEET_TOKEN}/values/${encodeURIComponent(range)}`,
      method: 'GET', params: { valueRenderOption: 'Formula' }, timeout: 20000,
    }));
    const data = assertFeishu(response, 'read accounting sheet');
    valueRange = data?.valueRange;
    const revision = valueRange?.revision ?? data?.revision;
    const required = confirmedRevisions.get(client)?.get(sheetId);
    if (revision == null || required == null || Number(revision) >= required) {
      rememberRevision(client, sheetId, revision);
      break;
    }
    if (confirmation === 2) {
      const error = new Error('accounting read has not reached the confirmed write revision');
      error.code = 'ACCOUNTING_READ_STALE';
      error.retryable = true;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!Array.isArray(valueRange?.values)) throw new Error('accounting sheet values are missing');
  const rows = valueRange.values;
  if (HEADERS.some((header, i) => rows[0]?.[i] !== header)) {
    throw new Error('accounting sheet headings changed');
  }
  const totalIndices = rows.flatMap((row, i) =>
    (/^=COUNTA\(A2:A\d+\)\*\d+$/u.test(String(row?.[0] || '')) ||
      (typeof row?.[0] === 'number' && row.slice(0, 8).length === 8 &&
        row.slice(0, 8).every((v, c) => Number.isFinite(v) ||
          new RegExp(`^=COUNTA\\(${COLUMNS[c]}2:${COLUMNS[c]}\\d+\\)\\*\\d+$`, 'u').test(String(v))))) ? [i] : []);
  if (totalIndices.length !== 1) throw new Error('accounting total row is missing or duplicated');
  const totalIndex = totalIndices[0];
  if (totalIndex < 2) throw new Error('accounting total row is above the data area');
  for (let i = 0; i < COLUMNS.length; i += 1) {
    const column = COLUMNS[i];
    const expression = String(rows[totalIndex]?.[i] || '');
    if (!Number.isFinite(rows[totalIndex]?.[i]) &&
        !new RegExp(`^=COUNTA\\(${column}2:${column}\\d+\\)\\*\\d+$`, 'u').test(expression)) {
      throw new Error(`accounting total formula changed in column ${column}`);
    }
  }
  return { rows, totalIndex, revision: valueRange.revision };
}

function formulaRate(snapshot, index) {
  const value = snapshot.rows[snapshot.totalIndex][index];
  const formula = String(value).match(/\*(\d+)$/u);
  if (formula) return Number(formula[1]);
  const count = snapshot.rows.slice(1, snapshot.totalIndex)
    .filter(row => row[index] != null && row[index] !== '').length;
  const rate = count ? Number(value) / count : PRICES[COLUMNS[index]];
  if (!Number.isSafeInteger(rate) || rate < 0) throw new Error('numeric accounting total rate is ambiguous');
  return rate;
}

async function writeValue(client, sheetId, cell, value) {
  let result;
  try {
    result = await client.request({
      url: `/open-apis/sheets/v2/spreadsheets/${ACCOUNTING_SPREADSHEET_TOKEN}/values`,
      method: 'PUT',
      data: { valueRange: { range: `${sheetId}!${cell}:${cell}`,
        values: [[String(value).startsWith('=') ? { type: 'formula', text: value } : value]] } },
    });
  } catch (cause) {
    const status = Number(cause?.response?.status);
    const code = cause?.response?.data?.code;
    const error = new Error(`accounting write ${cell} rejected: HTTP ${status || 'unknown'}${code == null ? '' : `, Feishu ${code}`}`);
    error.code = status === 403 ? 'ACCOUNTING_WRITE_FORBIDDEN' : 'ACCOUNTING_WRITE_FAILED';
    error.retryable = cause?.code === 'ACCOUNTING_TRANSPORT_FAILED';
    throw error;
  }
  const data = assertFeishu(result, `write accounting ${cell}`);
  rememberRevision(client, sheetId, data?.revision);
  return data;
}

export async function verifiedWrite(client, sheetId, cell, value) {
  assertAccountingReady();
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await writeValue(client, sheetId, cell, value); }
    catch (error) { lastError = error; }
    const match = cell.match(/^([A-H])(\d+)$/u);
    let actual;
    for (let confirmation = 0; confirmation < 3; confirmation += 1) {
      const snapshot = await readSheet(client, sheetId);
      actual = snapshot.rows[Number(match[2]) - 1]?.[match[1].charCodeAt(0) - 65];
      if (actual === value || (value === '' && actual == null)) return snapshot;
      if (lastError?.code === 'ACCOUNTING_WRITE_FORBIDDEN') throw lastError;
      // User-auth writes can become visible to app-auth reads slightly later.
      // Confirm with reads before interpreting the old value as an edit.
      if (confirmation < 2) await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (actual != null && actual !== '') {
      throw lastError || new Error(`accounting cell ${cell} changed to another value`);
    }
  }
  throw lastError || new Error(`accounting write ${cell} did not verify`);
}

export async function normalizeFormulaRates(client, sheetId, snapshot) {
  // Normalize four owned rates and all ranges. Other multipliers are retained.
  const rowNumber = snapshot.totalIndex + 1;
  let changed = false;
  for (const [i, column] of COLUMNS.entries()) {
    const old = String(snapshot.rows[snapshot.totalIndex][i]);
    const rate = ['A', 'D', 'E', 'G'].includes(column) ? PRICES[column] : formulaRate(snapshot, i);
    const expected = `=COUNTA(${column}2:${column}${rowNumber - 1})*${rate}`;
    if (old !== expected) {
      await verifiedWrite(client, sheetId, `${column}${rowNumber}`, expected);
      changed = true;
    }
  }
  return changed;
}

export async function insertBeforeTotal(client, sheetId, snapshot) {
  assertAccountingReady();
  const formerTotalRow = snapshot.totalIndex + 1;
  const oldRates = COLUMNS.map((_, index) => formulaRate(snapshot, index));
  let failed;
  try { const result = await client.request({
    url: `/open-apis/sheets/v2/spreadsheets/${ACCOUNTING_SPREADSHEET_TOKEN}/insert_dimension_range`,
    method: 'POST',
    data: { dimension: { sheetId, majorDimension: 'ROWS',
      startIndex: snapshot.totalIndex, endIndex: snapshot.totalIndex + 1 },
      inheritStyle: 'BEFORE' },
  });
  const data = assertFeishu(result, 'insert accounting row');
  rememberRevision(client, sheetId, data?.revision); } catch (error) { failed = error; }
  const after = await readSheet(client, sheetId);
  if (after.totalIndex !== snapshot.totalIndex + 1) {
    throw failed || new Error('accounting row insertion could not be verified; do not retry blindly');
  }
  for (const [index, column] of COLUMNS.entries()) {
    const multiplier = oldRates[index];
    const desired = `=COUNTA(${column}2:${column}${formerTotalRow})*${column === 'E' ? PRICES.E : multiplier}`;
    if (after.rows[after.totalIndex][index] !== desired) {
      await verifiedWrite(client, sheetId, `${column}${formerTotalRow + 1}`, desired);
    }
  }
  return readSheet(client, sheetId);
}

export async function recordDispatchAccounting({ client, stateDir, job, scope }) {
  if (localConfig.accounting?.enabled !== true) return { status: 'disabled', recorded: 0 };
  const items = accountingItems(job, scope);
  if (items.length === 0) return { status: 'not_applicable', recorded: 0 };
  const title = accountingMonth(job.sourceMessageCreatedAtMs);
  const sheetId = await ensureMonthlySheet(client, title, stateDir);
  const ledgerPath = path.join(stateDir, 'accounting-ledger.json');
  const ledger = readLedger(ledgerPath);
  let recorded = 0;
  const blocked = [];
  let snapshot = await readSheet(client, sheetId);
  await normalizeFormulaRates(client, sheetId, snapshot);
  snapshot = await readSheet(client, sheetId);
  for (const item of items) {
    if (!item.column) { blocked.push({ key: item.key, reason: item.category }); continue; }
    const prior = ledger.entries[item.key];
    // A reviewed historical reassignment is authoritative on replay as well.
    if (prior?.ownershipAuthorization && prior.category === item.category) item.column = prior.column;
    if (prior && (prior.subject !== item.subject || prior.column !== item.column ||
        prior.sheetId !== sheetId)) throw new Error(`accounting key conflict ${item.key}`);
    snapshot = await readSheet(client, sheetId);
    const colIndex = item.column.charCodeAt(0) - 65;
    if (prior?.cell) {
      const row = Number(prior.cell.slice(1));
      if (snapshot.rows[row - 1]?.[colIndex] === item.subject) {
        ledger.entries[item.key] = { ...prior, status: 'recorded', verifiedAt: new Date().toISOString() };
        saveLedger(ledgerPath, ledger); recorded += 1; continue;
      }
      if (row < 2 || row > snapshot.totalIndex ||
          (snapshot.rows[row - 1]?.[colIndex] != null && snapshot.rows[row - 1]?.[colIndex] !== '')) {
        throw new Error(`accounting reserved cell ${prior.cell} changed`);
      }
    } else {
      const matchingCells = snapshot.rows.slice(1, snapshot.totalIndex)
        .flatMap((row, index) => row?.[colIndex] === item.subject ? [`${item.column}${index + 2}`] : []);
      // New orders charge per source allocation, including same-person codes.
      // Existing human entries still need attribution; historical jobs keep
      // their prior policy and are never retroactively charged by this change.
      const attributed = job.accountingPolicy === 'per_code_v2' && matchingCells.every(cell =>
        Object.entries(ledger.entries).some(([key, entry]) => key !== item.key &&
          entry.status === 'recorded' && entry.cell === cell && entry.sheetId === sheetId &&
          entry.column === item.column && entry.subject === item.subject && entry.code));
      if (matchingCells.length && !attributed) {
        blocked.push({ key: item.key, reason: 'existing_subject_unattributed' }); continue;
      }
    }
    let row = prior?.cell ? Number(prior.cell.slice(1)) :
      snapshot.rows.slice(1, snapshot.totalIndex).findIndex((values) =>
        values?.[colIndex] == null || values?.[colIndex] === '') + 2;
    if (!prior?.cell && row === 1) {
      snapshot = await insertBeforeTotal(client, sheetId, snapshot);
      row = snapshot.totalIndex;
    }
    const cell = `${item.column}${row}`;
    ledger.entries[item.key] = {
      status: 'planned', requestId: job.requestId, sourceMessageId: job.sourceMessageId,
      sourceMessageCreatedAtMs: job.sourceMessageCreatedAtMs,
      sourceDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(Number(job.sourceMessageCreatedAtMs))),
      sourceBlock: item.assignment.sourceBlock, code: item.assignment.code,
      accountingPolicy: job.accountingPolicy || 'legacy',
      itemNumbers: item.assignment.itemNumbers, subject: item.subject, category: item.category,
      sheetId, sheetTitle: title, column: item.column, cell,
    };
    saveLedger(ledgerPath, ledger);
    await verifiedWrite(client, sheetId, cell, item.subject);
    ledger.entries[item.key].status = 'recorded';
    ledger.entries[item.key].verifiedAt = new Date().toISOString();
    saveLedger(ledgerPath, ledger);
    recorded += 1;
  }
  return { status: blocked.length ? 'partial' : 'recorded', recorded, blocked, sheetId, sheetTitle: title };
}

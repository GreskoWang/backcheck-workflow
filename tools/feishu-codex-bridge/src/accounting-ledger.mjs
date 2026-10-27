import { localConfig, assertAccountingReady } from '../../../config/backcheck-config.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSpecialPricingRegistry } from './special-pricing.mjs';

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
const accountingStates = new WeakMap();
const copiedSpecialContexts = new WeakMap();
// Only these two explicitly priced items may carry the approved +100 adjustment.
const ADJUSTED_SUBJECTS = new Set([
  'TGA 2025节点B站视频调研（700元）', '单机游戏热门视频调研（700元）',
]);

export function bindAccountingState(client, stateDir) {
  if (!client || !path.isAbsolute(stateDir || '')) throw new Error('accounting state binding requires an absolute directory');
  accountingStates.set(client, stateDir);
}

export async function withAccountingLock(stateDir, operation) {
  if (!path.isAbsolute(stateDir || '') || typeof operation !== 'function') throw new Error('accounting lock arguments are invalid');
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, 'accounting-ledger.lock');
  let fd;
  try { fd = fs.openSync(lockPath, 'wx'); }
  catch (cause) { const error = new Error('accounting ledger is busy or its prior operation needs review'); error.code = 'ACCOUNTING_BUSY'; throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    return await operation();
  } finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}

function specialApprovals(client, sheetId) {
  const stateDir = accountingStates.get(client);
  if (!stateDir) return [];
  const effectiveSheet = copiedSpecialContexts.get(client)?.get(sheetId) || sheetId;
  const ledger = readLedger(path.join(stateDir, 'accounting-ledger.json'));
  const registry = createSpecialPricingRegistry({ stateDir });
  return Object.values(ledger.entries || {}).filter(entry => entry.category === 'special_confirmed' && entry.sheetId === effectiveSheet).map(entry => {
    const order = registry.getOrder(entry.specialOrderId);
    if (order.status !== 'price_confirmed' || order.requestId !== entry.requestId ||
        order.sourceMessageId !== entry.sourceMessageId || order.chatId !== entry.chatId ||
        order.pricing.amountMinor !== entry.amountMinor || order.pricing.confirmationId !== entry.confirmationId ||
        entry.column !== 'B' || entry.cellText !== entry.subject ||
        typeof entry.cellText !== 'string' || entry.cellText.length > 240 || /["\r\n]/u.test(entry.cellText) ||
        !entry.cellText.startsWith(`${order.orderId} | CNY ${order.pricing.amount} | `)) {
      throw new Error('special accounting approval no longer matches its exact confirmed order');
    }
    return { orderId: order.orderId, subject: entry.cellText, amountMinor: entry.amountMinor, status: entry.status };
  });
}

function differenceText(amountMinor) {
  const difference = amountMinor - 60000;
  return difference % 100 === 0 ? String(difference / 100) : (difference / 100).toFixed(2);
}

export function parseAccountingFormula(value, column, lastDataRow, { specialPriceApprovals = [] } = {}) {
  if (typeof value !== 'string' || value.length > (specialPriceApprovals.length ? 65536 : 2048) || !COLUMNS.includes(column)) return null;
  const base = value.match(/^=COUNTA\(([A-H])([1-9]\d*):\1([1-9]\d*)\)\*(\d+)/u);
  if (!base || base[1] !== column) return null;
  const startRow = Number(base[2]), endRow = Number(base[3]), rate = Number(base[4]);
  // Native insertion above the first item shifts the range start as well as IF references.
  if (!Number.isSafeInteger(startRow) || startRow < 2 || startRow > endRow ||
      !Number.isSafeInteger(endRow) || endRow > lastDataRow ||
      !Number.isSafeInteger(rate)) return null;
  const adjustments = [];
  const specialAdjustments = [];
  let tail = value.slice(base[0].length);
  if (tail && (column !== 'B' || rate !== 600)) return null;
  while (tail) {
    const term = tail.match(/^\+IF\(B([1-9]\d*)="([^"]+)",100,0\)/u);
    if (!term || !ADJUSTED_SUBJECTS.has(term[2])) {
      const specific = tail.match(/^\+IF\(B([1-9]\d*)="([^"\r\n]+)",(-?\d+(?:\.\d{2})?),0\)/u);
      if (!specific || specialAdjustments.length >= 200) return null;
      const row = Number(specific[1]);
      const matches = specialPriceApprovals.filter(approval => approval.subject === specific[2] &&
        Number.isSafeInteger(approval.amountMinor) && approval.amountMinor > 0 &&
        differenceText(approval.amountMinor) === specific[3]);
      if (matches.length !== 1 || row < 2 || row > lastDataRow ||
          [...adjustments, ...specialAdjustments].some(a => a.row === row || a.subject === specific[2])) return null;
      specialAdjustments.push({ row, subject: specific[2], amountMinor: matches[0].amountMinor, orderId: matches[0].orderId });
      tail = tail.slice(specific[0].length);
      continue;
    }
    if (adjustments.length === 2) return null;
    const row = Number(term[1]);
    if (!Number.isSafeInteger(row) || row < 2 || row > lastDataRow ||
        [...adjustments, ...specialAdjustments].some(a => a.row === row || a.subject === term[2])) return null;
    adjustments.push({ row, subject: term[2] });
    tail = tail.slice(term[0].length);
  }
  if (adjustments.length && adjustments.length !== ADJUSTED_SUBJECTS.size) return null;
  return { column, startRow, endRow, rate, adjustments,
    ...(specialAdjustments.length ? { specialAdjustments } : {}) };
}

function totalFormula(column, endRow, rate, adjustments = [], specialAdjustments = []) {
  return `=COUNTA(${column}2:${column}${endRow})*${rate}` + adjustments
    .map(a => `+IF(B${a.row}="${a.subject}",100,0)`).join('') + specialAdjustments
    .map(a => `+IF(B${a.row}="${a.subject}",${differenceText(a.amountMinor)},0)`).join('');
}

export function specialAccountingTotalFormula(client, sheetId, snapshot, { row, cellText, orderId }) {
  const approvals = specialApprovals(client, sheetId);
  const approved = approvals.filter(item => item.orderId === orderId && item.subject === cellText);
  if (approved.length !== 1 || !Number.isSafeInteger(row) || row < 2 || row > snapshot.totalIndex) throw new Error('exact special accounting formula approval is missing');
  const parts = formulaParts(snapshot, 1, { specialPriceApprovals: approvals });
  if (parts.rate !== 600) throw new Error('special accounting base rate requires the reviewed 600 formula');
  const prior = parts.specialAdjustments || [];
  if (prior.some(item => item.orderId === orderId && (item.row !== row || item.subject !== cellText))) throw new Error('special accounting formula order already has another target');
  const terms = prior.some(item => item.orderId === orderId) ? prior : [...prior, { ...approved[0], row }];
  const formula = totalFormula('B', snapshot.totalIndex, 600, parts.adjustments, terms);
  if (!parseAccountingFormula(formula, 'B', snapshot.totalIndex, { specialPriceApprovals: approvals })) throw new Error('special accounting formula exceeds its approved grammar or capacity');
  return formula;
}

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
  bindAccountingState(client, stateDir);
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
  let copied = copiedSpecialContexts.get(client);
  if (!copied) { copied = new Map(); copiedSpecialContexts.set(client, copied); }
  copied.set(sheetId, creation.templateSheetId);
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
  // A copied blank month must not inherit the previous month's item-specific price approvals.
  await normalizeFormulaRates(client, sheetId, snapshot, { clearItemAdjustments: true });
  copied.delete(sheetId);
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
  const formulaOptions = { specialPriceApprovals: specialApprovals(client, sheetId) };
  if (HEADERS.some((header, i) => rows[0]?.[i] !== header)) {
    throw new Error('accounting sheet headings changed');
  }
  const totalIndices = rows.flatMap((row, i) =>
    (parseAccountingFormula(row?.[0], 'A', i, formulaOptions) ||
      (typeof row?.[0] === 'number' && row.slice(0, 8).length === 8 &&
        row.slice(0, 8).every((v, c) => Number.isFinite(v) ||
          parseAccountingFormula(v, COLUMNS[c], i, formulaOptions)))) ? [i] : []);
  if (totalIndices.length !== 1) throw new Error('accounting total row is missing or duplicated');
  const totalIndex = totalIndices[0];
  if (totalIndex < 2) throw new Error('accounting total row is above the data area');
  for (let i = 0; i < COLUMNS.length; i += 1) {
    const column = COLUMNS[i];
    const expression = String(rows[totalIndex]?.[i] || '');
    if (!Number.isFinite(rows[totalIndex]?.[i]) &&
        !parseAccountingFormula(expression, column, totalIndex, formulaOptions)) {
      throw new Error(`accounting total formula changed in column ${column}`);
    }
  }
  const marked = rows.slice(1, totalIndex).filter(row => /^SP-[A-F0-9]{32} \| /u.test(String(row?.[1] || '')));
  if (marked.some(row => !formulaOptions.specialPriceApprovals.some(item => item.subject === row[1]))) {
    throw new Error('special accounting row has no confirmed local price approval');
  }
  if (marked.length && typeof rows[totalIndex][1] !== 'string') throw new Error('numeric special accounting total is ambiguous');
  const specialTerms = parseAccountingFormula(rows[totalIndex][1], 'B', totalIndex, formulaOptions)?.specialAdjustments || [];
  for (let index = 1; index < totalIndex; index++) {
    if (!/^SP-[A-F0-9]{32} \| /u.test(String(rows[index]?.[1] || ''))) continue;
    if (specialTerms.filter(term => term.row === index + 1 && term.subject === rows[index][1]).length !== 1) {
      throw new Error('special accounting row is missing its exact confirmed price formula');
    }
  }
  if (!copiedSpecialContexts.get(client)?.has(sheetId) && formulaOptions.specialPriceApprovals.some(approval =>
    approval.status === 'recorded' && rows.slice(1, totalIndex).filter(row => row?.[1] === approval.subject).length !== 1)) {
    throw new Error('recorded special accounting row changed or is missing');
  }
  return { rows, totalIndex, revision: valueRange.revision, formulaOptions };
}

function formulaParts(snapshot, index, options = snapshot.formulaOptions || {}) {
  const value = snapshot.rows[snapshot.totalIndex][index];
  if (typeof value === 'string') {
    const parsed = parseAccountingFormula(value, COLUMNS[index], snapshot.totalIndex, options);
    if (!parsed) throw new Error(`accounting total formula changed in column ${COLUMNS[index]}`);
    return parsed;
  }
  const count = snapshot.rows.slice(1, snapshot.totalIndex)
    .filter(row => row[index] != null && row[index] !== '').length;
  const rate = count ? Number(value) / count : PRICES[COLUMNS[index]];
  if (!Number.isSafeInteger(rate) || rate < 0) throw new Error('numeric accounting total rate is ambiguous');
  return { rate, adjustments: [] };
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

// The caller must persist a mutation intent before invoking this. There is no
// automatic mutation retry: an uncertain result is resolved by reads only.
export async function writeAccountingCellOnce(client, sheetId, cell, value, expectedSnapshot) {
  assertAccountingReady();
  if (!/^B[1-9]\d*$/u.test(cell)) throw new Error('special accounting writes are restricted to column B');
  const before = await readSheet(client, sheetId);
  if (!expectedSnapshot || before.totalIndex !== expectedSnapshot.totalIndex ||
      JSON.stringify(before.rows) !== JSON.stringify(expectedSnapshot.rows) ||
      (before.revision != null && expectedSnapshot.revision != null && before.revision !== expectedSnapshot.revision)) {
    const error = new Error('accounting sheet changed before the authorized mutation');
    error.code = 'SPECIAL_ACCOUNTING_CONFLICT'; throw error;
  }
  const row = Number(cell.slice(1));
  if (row < 2 || row > before.totalIndex + 1) throw new Error('special accounting cell is outside its reviewed area');
  const previous = parseAccountingFormula(before.rows[before.totalIndex][1], 'B', before.totalIndex, before.formulaOptions);
  if (row === before.totalIndex + 1) {
    const next = parseAccountingFormula(value, 'B', before.totalIndex, before.formulaOptions);
    if (!previous || !next || next.rate !== 600 || next.startRow !== 2 || next.endRow !== before.totalIndex ||
        JSON.stringify(previous.adjustments) !== JSON.stringify(next.adjustments) ||
        (previous.specialAdjustments || []).some(term => !(next.specialAdjustments || []).some(other => JSON.stringify(other) === JSON.stringify(term)))) {
      throw new Error('special accounting total mutation is not an approved additive formula');
    }
  } else if ((before.rows[row - 1]?.[1] != null && before.rows[row - 1][1] !== '') ||
      !(previous?.specialAdjustments || []).some(term => term.row === row && term.subject === value) ||
      before.rows.slice(1, before.totalIndex).some(values => values?.[1] === value)) {
    throw new Error('special accounting item mutation is not an empty uniquely approved target');
  }
  let failure;
  try { await writeValue(client, sheetId, cell, value); } catch (error) { failure = error; }
  const snapshot = await readSheet(client, sheetId);
  const actual = snapshot.rows[Number(cell.slice(1)) - 1]?.[1];
  if (actual === value) {
    const expectedRows = structuredClone(before.rows);
    expectedRows[Number(cell.slice(1)) - 1][1] = value;
    if (snapshot.totalIndex !== before.totalIndex || JSON.stringify(snapshot.rows) !== JSON.stringify(expectedRows)) {
      const error = new Error('accounting sheet changed concurrently with the authorized mutation');
      error.code = 'SPECIAL_ACCOUNTING_CONFLICT'; throw error;
    }
    return snapshot;
  }
  const error = new Error('special accounting mutation was not confirmed; read back before any further action');
  error.code = 'SPECIAL_ACCOUNTING_UNCERTAIN';
  error.cause = failure;
  throw error;
}

export async function normalizeFormulaRates(client, sheetId, snapshot, { clearItemAdjustments = false } = {}) {
  // Normalize four owned rates and all ranges. Other multipliers are retained.
  const rowNumber = snapshot.totalIndex + 1;
  let changed = false;
  for (const [i, column] of COLUMNS.entries()) {
    const old = String(snapshot.rows[snapshot.totalIndex][i]);
    const parts = formulaParts(snapshot, i);
    const rate = ['A', 'D', 'E', 'G'].includes(column) ? PRICES[column] : parts.rate;
    const expected = totalFormula(column, rowNumber - 1, rate,
      clearItemAdjustments ? [] : parts.adjustments,
      clearItemAdjustments ? [] : parts.specialAdjustments || []);
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
  const oldParts = COLUMNS.map((_, index) => formulaParts(snapshot, index));
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
    const current = formulaParts(after, index);
    if (JSON.stringify(current.adjustments.map(a => a.subject).sort()) !==
        JSON.stringify(oldParts[index].adjustments.map(a => a.subject).sort())) {
      throw new Error(`accounting item adjustments changed during insertion in column ${column}`);
    }
    if (JSON.stringify((current.specialAdjustments || []).map(a => [a.orderId, a.subject, a.amountMinor]).sort()) !==
        JSON.stringify((oldParts[index].specialAdjustments || []).map(a => [a.orderId, a.subject, a.amountMinor]).sort())) {
      throw new Error(`special accounting price approvals changed during insertion in column ${column}`);
    }
    // Use references returned by the sheet after insertion, never stale row addresses.
    const desired = totalFormula(column, formerTotalRow,
      column === 'E' ? PRICES.E : oldParts[index].rate, current.adjustments, current.specialAdjustments || []);
    if (after.rows[after.totalIndex][index] !== desired) {
      await verifiedWrite(client, sheetId, `${column}${formerTotalRow + 1}`, desired);
    }
  }
  return readSheet(client, sheetId);
}

export async function recordDispatchAccounting({ client, stateDir, job, scope }) {
  if (localConfig.accounting?.enabled !== true) return { status: 'disabled', recorded: 0 };
  return withAccountingLock(stateDir, () => recordDispatchAccountingUnlocked({ client, stateDir, job, scope }));
}

async function recordDispatchAccountingUnlocked({ client, stateDir, job, scope }) {
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

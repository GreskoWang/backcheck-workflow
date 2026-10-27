import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSpecialPricingRegistry } from '../src/special-pricing.mjs';
import { confirmSpecialPriceInstruction, recordConfirmedSpecialAccounting } from '../src/special-accounting.mjs';
import { accountingMonth, bindAccountingState, ensureMonthlySheet, normalizeFormulaRates,
  parseAccountingFormula, readSheet, recordDispatchAccounting, withAccountingLock } from '../src/accounting-ledger.mjs';
import { parseSpecialPriceArguments, runSpecialPriceCommand } from '../scripts/confirm-special-price.mjs';

const chatId = 'oc_19936593f3ad5a63b1e86ee0f8c44fc8';
const historical = ['TGA 2025节点B站视频调研（700元）', '单机游戏热门视频调研（700元）'];
const headers = ['王书鲲', '王书鲲（特殊）', '王书鲲（私人）', '王书鲲（一年）',
  '徐嘉怡', '徐嘉怡（特殊）', '徐嘉怡（一年）', '转移'];
const rates = [200, 600, 600, 50, 200, 600, 50, 600];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, { full = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(process.env.BRIDGE_TEST_TEMP_ROOT || os.tmpdir(), 'special-accounting-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const rows = [headers, ...Array.from({ length: 4 }, (_, i) =>
    [full ? `regular-${i}` : null, i < 2 ? historical[i] : full ? `human-${i}` : null, null, null, null, null, null, null]),
  [...'ABCDEFGH'].map((c, i) => `=COUNTA(${c}2:${c}5)*${rates[i]}`)];
  rows.at(-1)[1] += `+IF(B2="${historical[0]}",100,0)+IF(B3="${historical[1]}",100,0)`;
  const tables = new Map([['k44Wnf', rows]]);
  const sheets = [{ sheet_id: 'k44Wnf', title: accountingMonth(Date.parse('2026-10-26T03:00:00Z')) }];
  const writes = [], faults = [];
  let revision = 1, readFailures = 0, readHook, postWriteHook;
  const client = { sheets: { spreadsheetSheet: { query: async () => ({ code: 0, data: { sheets: structuredClone(sheets) } }) } },
    async request({ url, method, data }) {
      if (method === 'GET') {
        if (readFailures) { readFailures--; throw new Error('fixture read unavailable'); }
        readHook?.();
        const id = decodeURIComponent(url.split('/values/')[1]).split('!')[0];
        return { code: 0, data: { valueRange: { values: structuredClone(tables.get(id)), revision } } };
      }
      if (url.endsWith('/sheets_batch_update')) {
        const copy = data.requests[0].copySheet, id = `month${tables.size}`;
        tables.set(id, structuredClone(tables.get(copy.source.sheetId)));
        sheets.push({ sheet_id: id, title: copy.destination.title });
        writes.push({ kind: 'copy' }); revision++;
        return { code: 0, data: { revision } };
      }
      if (url.endsWith('/insert_dimension_range')) {
        const table = tables.get(data.dimension.sheetId), at = data.dimension.startIndex;
        writes.push({ kind: 'insert' });
        if (faults[0] === 'drop_insert') { faults.shift(); throw new Error('fixture insertion not confirmed'); }
        table.splice(at, 0, Array(8).fill(null)); revision++;
        return { code: 0, data: { revision } };
      }
      assert.equal(method, 'PUT'); assert.ok(url.endsWith('/values'));
      const [id, range] = data.valueRange.range.split('!');
      const match = range.match(/^([A-H])(\d+):/u), row = Number(match[2]) - 1, col = match[1].charCodeAt(0) - 65;
      const formula = data.valueRange.values[0]?.[0]?.type === 'formula';
      const kind = formula ? 'formula' : String(data.valueRange.values[0]?.[0]).startsWith('SP-') ? 'item' : 'other';
      writes.push({ kind, range, data: structuredClone(data) });
      const fault = faults[0]?.endsWith(kind) ? faults.shift() : null;
      if (fault === `drop_${kind}`) throw new Error('fixture send outcome unknown');
      data.valueRange.values.forEach((values, r) => values.forEach((v, c) => tables.get(id)[row + r][col + c] = v?.type === 'formula' ? v.text : v));
      revision++;
      postWriteHook?.(kind);
      if (fault === `lost_read_${kind}`) { readFailures++; throw new Error('fixture committed but response and first read lost'); }
      if (fault === `lost_${kind}`) throw new Error('fixture committed response lost');
      return { code: 0, data: { revision } };
    } };
  const policy = { enabled: true, activationFromMs: Date.parse('2026-10-26T00:00:00Z'), authorization: 'fixture-explicit-new-orders',
    defaultOwner: { id: 'wangshukun', name: '王书鲲', authorizationRef: 'fixture-default-owner' } };
  const registry = createSpecialPricingRegistry({ stateDir });
  function makeOrder(id = 'NEW', date = '2026-10-26T03:00:00Z') {
    const job = { requestId: `RQ-${id}`, sourceMessageId: `om_${id}`, chatId,
      sourceMessageCreatedAtMs: Date.parse(date), status: 'handed_off', stage: 'research_started',
      workflowKind: 'special_research', deliveryKind: 'special',
      specialOwnership: { verified: true, sourceChatId: chatId, sourceMessageId: `om_${id}`,
        ownerId: 'wangshukun', authorization: policy.defaultOwner.authorizationRef },
      dispatchScope: { decision: 'execute', requestMode: 'special_dispatch', assignments: [{ subject: `Fixture ${id}`, code: 'SPECIAL', sourceBlock: 'special', itemNumbers: ['1'] }] } };
    const order = registry.registerOrder(job);
    return { job, orderId: order.orderId, order };
  }
  function evidence(order, amount = '825.50', changes = {}) {
    const value = { version: 1, source: 'authenticated_human_instruction', role: 'user', instructionId: `human-${order.orderId}-${amount}`,
      sourceThreadId: 'fixture-parent-thread', text: `For this exact new order, CNY ${amount}.`,
      target: { orderId: order.orderId, requestId: order.requestId, sourceMessageId: order.sourceMessageId, chatId },
      price: { currency: 'CNY', amount }, ...changes };
    const bytes = Buffer.from(JSON.stringify(value)), evidenceFile = path.join(stateDir, `${sha(bytes)}.json`);
    fs.writeFileSync(evidenceFile, bytes);
    return { evidenceFile, evidenceSha256: sha(bytes), amount };
  }
  async function confirm(item, amount = '825.50') {
    return confirmSpecialPriceInstruction({ stateDir, ...item, policy, ...evidence(item.order, amount) });
  }
  const record = item => recordConfirmedSpecialAccounting({ client, stateDir, ...item, policy });
  return { stateDir, client, policy, registry, rows, tables, sheets, writes, faults, makeOrder, evidence, confirm, record,
    onRead: hook => { readHook = hook; }, onWrite: hook => { postWriteHook = hook; } };
}

test('pending price never writes a fee and confirmed price is separate from accounting', async t => {
  const f = fixture(t), item = f.makeOrder();
  assert.equal((await f.record(item)).status, 'pending_pricing');
  assert.equal(f.writes.length, 0);
  assert.equal((await f.confirm(item)).status, 'price_confirmed');
  assert.equal(f.writes.length, 0);
  assert.equal(f.registry.getOrder(item.orderId).pricing.amountMinor, 82550);
});

test('exact reviewed B formula gains only the confirmed order difference and replay never charges twice', async t => {
  const f = fixture(t), item = f.makeOrder();
  await f.confirm(item);
  const result = await f.record(item);
  assert.equal(result.status, 'recorded'); assert.equal(result.amountMinor, 82550);
  assert.deepEqual(f.writes.map(w => w.kind), ['formula', 'item']);
  assert.ok(f.rows.at(-1)[1].endsWith(`+IF(B4="${f.rows[3][1]}",225.50,0)`));
  assert.ok(f.rows.at(-1)[1].includes(`+IF(B2="${historical[0]}",100,0)+IF(B3="${historical[1]}",100,0)`));
  const writes = f.writes.length;
  assert.equal((await f.record(item)).replay, true);
  assert.equal(f.writes.length, writes);
});

test('confirmed amounts below or equal to 600 use exact negative or zero differences, never a default price', async t => {
  const f = fixture(t);
  for (const [id, amount, delta] of [['LOW', '50.25', '-549.75'], ['BASE', '600', '0']]) {
    const item = f.makeOrder(id); await f.confirm(item, amount); await f.record(item);
    assert.ok(f.rows.at(-1)[1].includes(`,${delta},0)`));
    assert.equal(f.registry.getOrder(item.orderId).pricing.amountMinor, Math.round(Number(amount) * 100));
  }
});

for (const phase of ['formula', 'item']) test(`unconfirmed ${phase} is read-only on replay and is never automatically resent`, async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item);
  f.faults.push(`drop_${phase}`);
  assert.equal((await f.record(item)).status, 'outcome_uncertain');
  const writes = f.writes.length;
  assert.equal((await f.record(item)).status, 'outcome_uncertain');
  assert.equal(f.writes.length, writes);
});

for (const phase of ['formula', 'item']) test(`lost ${phase} response is accepted only after exact readback`, async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item);
  f.faults.push(`lost_${phase}`);
  assert.equal((await f.record(item)).status, 'recorded');
  assert.equal(f.writes.filter(w => w.kind === phase).length, 1);
});

test('committed charge with failed first read reconciles on restart without another charge', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item);
  f.faults.push('lost_read_item');
  assert.equal((await f.record(item)).status, 'outcome_uncertain');
  assert.equal((await f.record(item)).status, 'recorded');
  assert.equal(f.writes.filter(w => w.kind === 'item').length, 1);
});

test('full-column insertion, later regular accounting, and month switch preserve price approvals correctly', async t => {
  const f = fixture(t, { full: true }), item = f.makeOrder(); await f.confirm(item); await f.record(item);
  assert.equal(f.writes.filter(w => w.kind === 'insert').length, 1);
  const regularJob = { requestId: 'RQ-REGULAR', sourceMessageId: 'om_regular', sourceMessageCreatedAtMs: item.job.sourceMessageCreatedAtMs,
    requestText: '【背调需求】10.26\n普通', accountingPolicy: 'per_code_v2' };
  const scope = { decision: 'execute', requestMode: 'team_dispatch', assignments: [{ sourceBlock: '第1个【背调需求】10.26', code: 'TS', itemNumbers: ['1'], subject: 'New regular' }] };
  await recordDispatchAccounting({ client: f.client, stateDir: f.stateDir, job: regularJob, scope });
  await recordDispatchAccounting({ client: f.client, stateDir: f.stateDir,
    job: { ...regularJob, requestId: 'RQ-REGULAR2', sourceMessageId: 'om_regular2' },
    scope: { ...scope, assignments: [{ ...scope.assignments[0], subject: 'Another regular' }] } });
  assert.equal(f.writes.filter(w => w.kind === 'insert').length, 2);
  const before = structuredClone(f.rows);
  const newMonth = await ensureMonthlySheet(f.client, accountingMonth(Date.parse('2026-11-01T01:00:00Z')), f.stateDir);
  assert.deepEqual(f.rows, before);
  assert.equal(f.tables.get(newMonth).at(-1)[1], `=COUNTA(B2:B${f.tables.get(newMonth).length - 1})*600`);
  const next = f.makeOrder('NOV', '2026-11-01T01:00:00Z'); await f.confirm(next, '900'); await f.record(next);
  assert.ok(f.tables.get(newMonth).at(-1)[1].includes(',300,0)'));
  assert.ok(!f.tables.get(newMonth).at(-1)[1].includes(item.orderId));
});

test('normalization and native row-reference shifts preserve approved special terms', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item); await f.record(item);
  f.rows.splice(1, 0, Array(8).fill(null));
  for (const row of f.rows) for (let c = 0; c < 8; c++) if (typeof row[c] === 'string' && row[c].startsWith('=')) {
    row[c] = row[c].split('"').map((part, n) => n % 2 ? part : part.replace(/\b([A-H])(\d+)/gu, (_, col, r) => col + (Number(r) + 1))).join('"');
  }
  await normalizeFormulaRates(f.client, 'k44Wnf', await readSheet(f.client, 'k44Wnf'));
  assert.equal((await f.record(item)).cell, 'B5');
});

test('unapproved formula branches, changed confirmed amount and unattributed SP rows fail closed', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item); await f.record(item);
  const good = f.rows.at(-1)[1];
  for (const bad of [good + '+1', good.replace(',225.50,0)', ',225.51,0)'), good.replace(item.orderId, 'SP-' + 'A'.repeat(32))]) {
    f.rows.at(-1)[1] = bad;
    await assert.rejects(readSheet(f.client, 'k44Wnf'), /formula changed/);
  }
  f.rows.at(-1)[1] = good;
  f.rows.at(-1)[1] = good.slice(0, good.lastIndexOf('+IF'));
  await assert.rejects(readSheet(f.client, 'k44Wnf'), /missing its exact confirmed price formula/);
  f.rows.at(-1)[1] = good;
  assert.equal(parseAccountingFormula(good, 'B', f.rows.length - 1), null);
  const fresh = fixture(t); fresh.rows[3][1] = 'SP-' + 'A'.repeat(32) + ' | CNY 700.00 | unknown';
  bindAccountingState(fresh.client, fresh.stateDir);
  await assert.rejects(readSheet(fresh.client, 'k44Wnf'), /no confirmed local price/);
});

test('disabled, historical, wrong-source, wrong-owner and third-party price evidence never write', async t => {
  const f = fixture(t), item = f.makeOrder(), evidence = f.evidence(item.order);
  for (const change of [ { policy: { ...f.policy, enabled: false } },
    { job: { ...item.job, sourceMessageCreatedAtMs: f.policy.activationFromMs - 1 } },
    { job: { ...item.job, chatId: 'oc_other' } },
    { job: { ...item.job, specialOwnership: { ...item.job.specialOwnership, ownerId: 'someone_else' } } },
    { ...f.evidence(item.order, '825.50', { source: 'feishu_group_text' }) },
    { ...evidence, amount: '700' }, { ...evidence, evidenceSha256: 'a'.repeat(64) } ]) {
    await assert.rejects(confirmSpecialPriceInstruction({ stateDir: f.stateDir, ...item, policy: f.policy, ...evidence, ...change }));
  }
  assert.equal(f.registry.getOrder(item.orderId).status, 'pending_pricing'); assert.equal(f.writes.length, 0);
});

test('conflicting human confirmations hold pricing without replacing or duplicating the first fee', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item, '700'); await f.record(item);
  assert.equal((await f.confirm(item, '900')).status, 'pricing_conflict');
  const writes = f.writes.length;
  assert.equal((await f.record(item)).status, 'pricing_conflict');
  assert.equal(f.writes.length, writes);
});

test('controlled CLI checks by default, confirms separately, and applies through the same journal', async t => {
  const f = fixture(t), item = f.makeOrder(), evidence = f.evidence(item.order);
  const argv = ['--order-id', item.orderId, '--amount', evidence.amount, '--evidence-file', evidence.evidenceFile, '--evidence-sha256', evidence.evidenceSha256];
  const dependencies = { runtime: { stateDir: f.stateDir }, client: f.client, store: { getJob: id => id === item.job.requestId ? item.job : null },
    configuration: { localConfig: { special_accounting: f.policy, groups: [{ chatId, role: 'special_dispatch', enabled: true,
      activationFromMs: f.policy.activationFromMs, defaultOwner: f.policy.defaultOwner }] } } };
  assert.equal((await runSpecialPriceCommand(argv, dependencies)).mode, 'checked');
  assert.equal(f.registry.getOrder(item.orderId).status, 'pending_pricing');
  assert.equal((await runSpecialPriceCommand([...argv, '--confirm'], dependencies)).mode, 'confirmed');
  assert.equal(f.writes.length, 0);
  assert.equal((await runSpecialPriceCommand([...argv, '--apply'], dependencies)).accounting.status, 'recorded');
  assert.throws(() => parseSpecialPriceArguments([...argv, '--apply', '--confirm']), /choose/);
  assert.throws(() => parseSpecialPriceArguments([...argv, '--amount', '1']), /duplicate/);
});

test('shared accounting lock prevents concurrent regular or special mutation and does not auto-break stale locks', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item);
  await withAccountingLock(f.stateDir, async () => {
    await assert.rejects(f.record(item), error => error.code === 'ACCOUNTING_BUSY');
    await assert.rejects(recordDispatchAccounting({ client: f.client, stateDir: f.stateDir, job: {}, scope: {} }),
      error => error.code === 'ACCOUNTING_BUSY');
    await assert.rejects(withAccountingLock(f.stateDir, async () => {}), error => error.code === 'ACCOUNTING_BUSY');
  });
  assert.equal(f.writes.length, 0);
});

for (const phase of ['formula', 'item']) test(`concurrent editor change immediately before ${phase} write holds without overwriting`, async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item);
  let changed = false;
  f.onRead(() => {
    const file = path.join(f.stateDir, 'accounting-ledger.json');
    if (changed || !fs.existsSync(file)) return;
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')).entries[`special:${item.orderId}`];
    if (!entry?.[`${phase}Attempt`]) return;
    changed = true;
    if (phase === 'item') f.rows[Number(entry.cell.slice(1)) - 1][1] = 'Other editor owns this cell';
    else f.rows[1][0] = 'Other editor changed the sheet';
  });
  assert.equal((await f.record(item)).status, 'held');
  assert.equal(f.writes.filter(w => w.kind === phase).length, 0);
  const count = f.writes.length;
  assert.equal((await f.record(item)).status, 'held');
  assert.equal(f.writes.length, count);
});

test('concurrent changes observed after the one charge attempt hold and never resend', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item);
  f.onWrite(kind => { if (kind === 'item') f.rows[1][0] = 'Concurrent human edit'; });
  assert.equal((await f.record(item)).status, 'held');
  assert.equal((await f.record(item)).status, 'held');
  assert.equal(f.writes.filter(w => w.kind === 'item').length, 1);
});

test('a replay alias cannot create a second fee or substitute another request identity', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item); await f.record(item);
  const alias = { ...item.job, requestId: 'RQ-ALIAS' };
  assert.equal(f.registry.registerOrder(alias).orderId, item.orderId);
  const count = f.writes.length;
  await assert.rejects(recordConfirmedSpecialAccounting({ client: f.client, stateDir: f.stateDir,
    orderId: item.orderId, job: alias, policy: f.policy }), /exact|authorized new order/);
  assert.equal(f.writes.length, count);
});

test('unconfirmed structural insertion is not repeated on a later command', async t => {
  const f = fixture(t, { full: true }), item = f.makeOrder(); await f.confirm(item);
  f.faults.push('drop_insert');
  assert.equal((await f.record(item)).status, 'outcome_uncertain');
  assert.equal((await f.record(item)).status, 'outcome_uncertain');
  assert.equal(f.writes.filter(w => w.kind === 'insert').length, 1);
  assert.equal(f.writes.filter(w => w.kind === 'item').length, 0);
});

test('saved exact human evidence is retained and changed evidence blocks accounting', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item);
  const provenance = f.registry.getOrder(item.orderId).pricing.provenance;
  assert.equal(provenance.sourceThreadId, 'fixture-parent-thread');
  assert.equal(sha(fs.readFileSync(provenance.evidencePath)), provenance.evidenceSha256);
  fs.appendFileSync(provenance.evidencePath, '\n');
  await assert.rejects(f.record(item), /intact operator-bound human confirmation/);
  assert.equal(f.writes.length, 0);
});

test('latest job ownership or pause is rechecked before the formula and charge mutation', async t => {
  const f = fixture(t), item = f.makeOrder(); await f.confirm(item);
  await assert.rejects(recordConfirmedSpecialAccounting({ client: f.client, stateDir: f.stateDir,
    ...item, policy: f.policy, readCurrentJob: () => ({ ...item.job, status: 'paused' }) }), /verified executable/);
  assert.equal(f.writes.length, 0);
});

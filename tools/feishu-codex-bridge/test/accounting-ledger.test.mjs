import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { accountingItems, accountingItemKey, accountingMonth, recordDispatchAccounting } from '../src/accounting-ledger.mjs';
import { localExecutionScope } from '../src/dispatch-scope.mjs';
import { runBackgroundCheck } from '../src/codex-runner.mjs';

function mockSheet({ full = false } = {}) {
  const rows = [
    ['王书鲲', '王书鲲（特殊）', '王书鲲（私人）', '王书鲲（一年）',
      '徐嘉怡', '徐嘉怡（特殊）', '徐嘉怡（一年）', '转移'],
    ['旧项', null, null, null, null, null, null, null],
    [full ? '旧项二' : null, null, null, null, null, null, null, null],
    [full ? '旧项三' : null, null, null, null, null, null, null, null],
    ['=COUNTA(A2:A4)*200', '=COUNTA(B2:B4)*600', '=COUNTA(C2:C4)*600',
      '=COUNTA(D2:D4)*50', '=COUNTA(E2:E4)*600', '=COUNTA(F2:F4)*600',
      '=COUNTA(G2:G4)*50', '=COUNTA(H2:H4)*600'],
  ];
  const writes = [];
  const client = {
    sheets: { spreadsheetSheet: { query: async () => ({
      code: 0, data: { sheets: [{ title: '26年10月bd汇总', sheet_id: 'month' }] },
    }) } },
    async request({ method, url, data }) {
      if (method === 'GET') return { code: 0, data: { valueRange: { values: rows, revision: 1 } } };
      if (method === 'POST' && url.endsWith('/insert_dimension_range')) {
        rows.splice(data.dimension.startIndex, 0, Array(8).fill(null));
        writes.push('insert-row');
        return { code: 0, data: {} };
      }
      if (method !== 'PUT' || !url.endsWith('/values')) throw new Error('unexpected API call');
      const match = data.valueRange.range.match(/!([A-H])(\d+):/u);
      const column = match[1].charCodeAt(0) - 65;
      const row = Number(match[2]) - 1;
      const value = data.valueRange.values[0][0];
      rows[row][column] = value?.type === 'formula' ? value.text : value;
      writes.push(data.valueRange.range);
      return { code: 0, data: {} };
    },
  };
  return { rows, writes, client };
}

test('six codes are watched but only three are sent to local research', () => {
  const scope = { decision: 'execute', requestMode: 'team_dispatch',
    assignments: ['TS', 'TS1', '临A', '临H', 'BK1', 'BK2'].map((code) => ({ code })) };
  assert.deepEqual(localExecutionScope(scope).assignments.map((item) => item.code),
    ['TS', '临A', 'BK1']);
  assert.equal(localExecutionScope({ ...scope,
    assignments: [{ code: 'TS1' }] }).decision, 'no_owned_assignment');
});

for (const [label, codes] of [['same person', ['TS', '临A']], ['two people', ['TS', 'TS1']]]) {
  for (const category of ['regular', 'year']) {
    test(`${label} joint object is billed once per code (${category}) and redelivery adds nothing`, async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-shared-test-'));
      try {
        const { rows, writes, client } = mockSheet();
        const job = { requestId: 'RQ-joint', sourceMessageId: 'message-joint', accountingPolicy: 'per_code_v2',
          sourceMessageCreatedAtMs: Date.parse('2026-10-12T12:03:12Z'),
          requestText: `【背调需求10.12】\n${category === 'year' ? '更新一年' : '普通'}\n2、共同对象（${codes.join('和')}一起做）` };
        const scope = { decision: 'execute', requestMode: 'team_dispatch', assignments: codes.map(code => ({
          code, sourceBlock: '第1个【背调需求10.12】块', itemNumbers: ['2'], subject: '共同对象',
        })) };
        assert.notEqual(accountingItemKey(job, scope.assignments[0]), accountingItemKey(job, scope.assignments[1]));
        assert.equal((await recordDispatchAccounting({ client, stateDir, job, scope })).recorded, 2);
        const beforeReplayWrites = writes.length;
        assert.equal((await recordDispatchAccounting({ client, stateDir, job, scope })).recorded, 2);
        assert.equal(writes.length, beforeReplayWrites);
        const items = accountingItems(job, scope);
        for (const column of new Set(items.map(item => item.column))) {
          const index = column.charCodeAt(0) - 65;
          assert.equal(rows.slice(1, -1).filter(row => row[index] === '共同对象').length,
            items.filter(item => item.column === column).length);
          assert.equal(rows.at(-1)[index], `=COUNTA(${column}2:${column}4)*${category === 'year' ? 50 : 200}`);
        }
        const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounting-ledger.json'), 'utf8'));
        assert.equal(Object.keys(ledger.entries).length, 2);
      } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
    });
  }
}

test('legacy shared orders and unattributed human entries are not retroactively billed', async () => {
  for (const policy of [undefined, 'per_code_v2']) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-attribution-test-'));
    try {
      const { rows, client } = mockSheet();
      rows[1][0] = '共同对象';
      const job = { requestId: 'RQ-legacy', sourceMessageId: 'message-legacy', accountingPolicy: policy,
        sourceMessageCreatedAtMs: Date.parse('2026-10-12T12:00:00Z'), requestText: '【背调需求10.12】\n普通' };
      const scope = { decision: 'execute', requestMode: 'team_dispatch', assignments: [
        { code: 'TS', sourceBlock: '第1个【背调需求10.12】块', itemNumbers: ['1'], subject: '共同对象' },
      ] };
      const result = await recordDispatchAccounting({ client, stateDir, job, scope });
      assert.equal(result.status, 'partial'); assert.equal(result.recorded, 0);
      assert.equal(result.blocked[0].reason, 'existing_subject_unattributed');
    } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
  }
});

test('Xu-only intake actually bills regular/year assignments without creating a local thread', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-xu-only-test-'));
  try {
    const { rows, client } = mockSheet();
    const assignments = ['TS1', '临H', 'BK2'].map((code, index) => ({ code, itemNumbers: [],
      subject: `徐对象${index}`, anchors: [], sourceBlock: `第${index + 1}个【背调需求10.12】块` }));
    const scope = { decision: 'execute', requestMode: 'team_dispatch', assignments,
      receiptAssignments: assignments.map(({ anchors, ...item }) => item),
      ambiguousItems: [], deadline: '', reason: '徐单完整保留' };
    const job = { requestId: 'RQ-XU-BILLING', sourceMessageId: 'xu-billing', accountingPolicy: 'per_code_v2',
      sourceMessageCreatedAtMs: Date.parse('2026-10-12T12:00:00Z'), dispatchScope: scope,
      requestText: '【背调需求10.12】\n普通\n【背调需求10.12】\n一年\n【背调需求10.12】\n一年' };
    let recorded;
    const result = await runBackgroundCheck(job, {}, {
      async onScopeResolved(intake) { recorded = await recordDispatchAccounting({ client, stateDir, job, scope: intake }); },
      desktopDispatcher: { dispatch() { throw new Error('must not dispatch Xu'); } },
    });
    assert.equal(recorded.recorded, 3); assert.equal(result.skipped, true); assert.equal(result.threadId, null);
    assert.equal(rows[1][4], '徐对象0');
    assert.equal(rows[1][6], '徐对象1'); assert.equal(rows[2][6], '徐对象2');
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('a Xu-only dispatch is classified and never creates a local research thread', async () => {
  const assignment = { code: 'TS1', itemNumbers: ['1'], subject: '甲',
    anchors: [], sourceBlock: '第1个【背调需求10.9】块' };
  const scope = { decision: 'execute', requestMode: 'team_dispatch',
    assignments: [assignment],
    receiptAssignments: [{ code: assignment.code, itemNumbers: assignment.itemNumbers,
      subject: assignment.subject, sourceBlock: assignment.sourceBlock }],
    ambiguousItems: [], deadline: '', reason: 'clear' };
  let intake;
  const result = await runBackgroundCheck({ requestId: 'RQ-XU-ONLY', dispatchScope: scope }, {}, {
    onScopeResolved(value) { intake = value; },
    desktopDispatcher: { dispatch() { throw new Error('must not dispatch'); } },
  });
  assert.equal(intake.assignments[0].code, 'TS1');
  assert.equal(result.skipped, true);
  assert.equal(result.dispatchScope.decision, 'no_owned_assignment');
});

test('a full data column inserts above totals and expands every formula range', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-insert-test-'));
  try {
    const { rows, writes, client } = mockSheet({ full: true });
    const job = { requestId: 'RQ-insert', sourceMessageId: 'message-insert',
      sourceMessageCreatedAtMs: Date.parse('2026-10-09T12:00:00Z'),
      requestText: '【背调需求10.9】\nTS\n新项' };
    const scope = { decision: 'execute', requestMode: 'team_dispatch', assignments: [
      { code: 'TS', sourceBlock: '第1个【背调需求10.9】块', itemNumbers: ['1'], subject: '新项' },
    ] };
    const result = await recordDispatchAccounting({ client, stateDir, job, scope });
    assert.equal(result.recorded, 1);
    assert.equal(writes.filter((item) => item === 'insert-row').length, 1);
    assert.equal(rows[4][0], '新项');
    assert.equal(rows[5][0], '=COUNTA(A2:A5)*200');
    assert.equal(rows[5][4], '=COUNTA(E2:E5)*200');
    assert.equal(rows[5][7], '=COUNTA(H2:H5)*600');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('month and year pricing derive from the source message and its own block', () => {
  const job = { requestId: 'RQ-test', sourceMessageId: 'message-1',
    sourceMessageCreatedAtMs: Date.parse('2026-09-30T16:01:00Z'),
    requestText: '【背调需求10.1】\n普通\n【背调需求10.1】\n更新一年' };
  const scope = { decision: 'execute', requestMode: 'team_dispatch', assignments: [
    { code: 'TS1', sourceBlock: '第1个【背调需求10.1】块', itemNumbers: ['1'], subject: '甲' },
    { code: 'BK1', sourceBlock: '第2个【背调需求10.1】块', itemNumbers: ['1'], subject: '乙' },
  ] };
  assert.equal(accountingMonth(job.sourceMessageCreatedAtMs), '26年10月bd汇总');
  assert.deepEqual(accountingItems(job, scope).map((item) => item.column), ['E', 'D']);
});

test('recorded source item is read back and never charged twice', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-ledger-test-'));
  try {
    const { rows, writes, client } = mockSheet();
    const job = { requestId: 'RQ-test', sourceMessageId: 'message-2',
      sourceMessageCreatedAtMs: Date.parse('2026-10-09T12:00:00Z'),
      requestText: '【背调需求10.9】\nTS1\n新项' };
    const scope = { decision: 'execute', requestMode: 'team_dispatch', assignments: [
      { code: 'TS1', sourceBlock: '第1个【背调需求10.9】块', itemNumbers: ['1'], subject: '新项' },
    ] };
    const first = await recordDispatchAccounting({ client, stateDir, job, scope });
    const second = await recordDispatchAccounting({ client, stateDir, job, scope });
    assert.equal(first.recorded, 1);
    assert.equal(second.recorded, 1);
    assert.equal(rows[1][4], '新项');
    assert.equal(rows[4][4], '=COUNTA(E2:E4)*200');
    assert.equal(writes.length, 2); // formula correction plus one subject
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

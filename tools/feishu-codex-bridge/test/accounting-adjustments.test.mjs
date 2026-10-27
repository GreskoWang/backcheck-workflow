import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseAccountingFormula, readSheet, normalizeFormulaRates, insertBeforeTotal,
  recordDispatchAccounting, ensureMonthlySheet, verifiedWrite } from '../src/accounting-ledger.mjs';
import { reconcileAccountingPlan } from '../src/accounting-reconciliation.mjs';

const subjects = ['TGA 2025节点B站视频调研（700元）', '单机游戏热门视频调研（700元）'];
const adjusted = (end = 5, a = 2, b = 3) =>
  `=COUNTA(B2:B${end})*600+IF(B${a}="${subjects[0]}",100,0)+IF(B${b}="${subjects[1]}",100,0)`;
const headers = ['王书鲲','王书鲲（特殊）','王书鲲（私人）','王书鲲（一年）','徐嘉怡','徐嘉怡（特殊）','徐嘉怡（一年）','转移'];
const rates = [200,600,600,50,200,600,50,50];
function fixture({full = false, autoResize = false, insertLost = false, dropAdjustment = false} = {}) {
  const rows = [headers.slice(), ...Array.from({length:4}, (_,i) =>
    [full || i === 0 ? `旧项${i}` : null, i < 2 ? subjects[i] : null, null, null, null, null, null, null]),
    [...'ABCDEFGH'].map((c,i) => `=COUNTA(${c}2:${c}5)*${rates[i]}`)];
  rows[5][1] = adjusted();
  const tables = new Map([['k44Wnf', rows]]), writes = [];
  const sheets = [{sheet_id:'k44Wnf',title:'26年10月bd汇总'}];
  let inserts = 0, copies = 0;
  function insert(id, index, nativeResize = true) {
    const table = tables.get(id), oldTotal = table.length - 1;
    table.splice(index, 0, Array(8).fill(null));
    if (nativeResize) for(const row of table) for(let c=0;c<8;c++) {
      if(typeof row[c] !== 'string' || !row[c].startsWith('=')) continue;
      // Simulate reference adjustment only outside quoted item labels.
      row[c] = row[c].split('"').map((part,n) => n % 2 ? part : part.replace(/\b([A-H])(\d+)/gu,
        (_,col,r) => col + (Number(r) >= index + 1 ? Number(r)+1 : Number(r)))).join('"');
      if(index === oldTotal) row[c] = row[c].replace(/(COUNTA\([A-H]2:[A-H])(\d+)(\))/u,
        (_,a,r,b) => a + (Number(r) === oldTotal ? oldTotal + 1 : r) + b);
    }
  }
  const client = {sheets:{spreadsheetSheet:{query:async()=>({code:0,data:{sheets:structuredClone(sheets)}})}},
    async request({method,url,data}) {
      if(method === 'GET') {
        const id=decodeURIComponent(url.split('/values/')[1]).split('!')[0];
        return {code:0,data:{valueRange:{values:structuredClone(tables.get(id)),revision:1}}};
      }
      if(url.endsWith('/sheets_batch_update')) {
        copies++; const copy=data.requests[0].copySheet;
        tables.set('newmonth',structuredClone(tables.get(copy.source.sheetId)));
        sheets.push({sheet_id:'newmonth',title:copy.destination.title});
        writes.push({kind:'copy'}); return {code:0,data:{}};
      }
      if(url.endsWith('/insert_dimension_range')) {
        inserts++; insert(data.dimension.sheetId,data.dimension.startIndex,autoResize);
        if(dropAdjustment) tables.get(data.dimension.sheetId).at(-1)[1]=`=COUNTA(B2:B6)*600`;
        writes.push({kind:'insert'});
        if(insertLost)throw new Error('insert response lost');
        return {code:0,data:{}};
      }
      if(method !== 'PUT' || !url.endsWith('/values')) throw new Error('Unexpected non-mock endpoint');
      const [id,range]=data.valueRange.range.split('!'), m=range.match(/^([A-H])(\d+):/u);
      const row=Number(m[2])-1,col=m[1].charCodeAt(0)-65;
      data.valueRange.values.forEach((r,ri)=>r.forEach((v,ci)=>tables.get(id)[row+ri][col+ci]=v?.type==='formula'?v.text:v));
      writes.push({kind:'values',range,data:structuredClone(data)});return {code:0,data:{}};
    }};
  return {rows,tables,sheets,writes,client,insert,stats:()=>({inserts,copies})};
}
function amount(rows) {
  const p=parseAccountingFormula(rows.at(-1)[1],'B',rows.length-1);
  return rows.slice(1,-1).filter(r=>r[1]!=null&&r[1]!=='').length*p.rate +
    p.adjustments.reduce((sum,a)=>sum+(rows[a.row-1][1]===a.subject?100:0),0);
}
async function isolated(run) {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'accounting-adjustments-'));
  try {return await run(stateDir);} finally {fs.rmSync(stateDir,{recursive:true,force:true});}
}
function dispatch(code, subject, id, category='regular') {
  return {job:{requestId:`RQ-${id}`,sourceMessageId:`message-${id}`,accountingPolicy:'per_code_v2',
    sourceMessageCreatedAtMs:Date.parse('2026-10-25T12:41:26Z'),requestText:`【背调需求10.25】\n${category==='year'?'一年':category==='special'?'特殊':'普通'}`},
    scope:{decision:'execute',requestMode:'team_dispatch',assignments:[{code,sourceBlock:'第1个【背调需求10.25】块',itemNumbers:['1'],subject}]}};
}

test('only the two approved exact-name 100/0 branches in B at base 600 are accepted',()=>{
  assert.deepEqual(parseAccountingFormula(adjusted(34),'B',34),{column:'B',startRow:2,endRow:34,rate:600,
    adjustments:[{row:2,subject:subjects[0]},{row:3,subject:subjects[1]}]});
  const invalid=[adjusted().replace(')*600',')*700'),adjusted().replace(',100,0',',200,0'),
    adjusted().replace(',100,0',',100,1'),adjusted().replace(subjects[0],'另一项'),
    adjusted().replace('IF(B2','IF(A2'),adjusted().replace('IF(B2','IF(B6'),
    adjusted().replace('IF(B3','IF(B2'),adjusted().replace(subjects[1],subjects[0]),
    adjusted().split('+IF')[0]+'+IF(B2="'+subjects[0]+'",100,0)',
    adjusted()+'+100',adjusted()+'+WEBSERVICE("https://example.com")',
    adjusted().replace('B2="','B2>="'),adjusted().replace('COUNTA(B2:B5)','COUNTA(B2:B50)'),
    adjusted().replace('COUNTA(B2:B5)','COUNTA(B1:B5)'),
    adjusted().replace('COUNTA(B2:B5)','COUNTA(B6:B5)'),
    adjusted().replace('COUNTA(B2:B5)','COUNTA(B2:C5)'),
    '=SUM(B2:B5)*600','=COUNTA(B2:B5)*600;process.exit()',adjusted().replace('IF(B2','IF(Sheet1!B2')];
  for(const formula of invalid) assert.equal(parseAccountingFormula(formula,'B',5),null,formula);
  assert.equal(parseAccountingFormula(adjusted(),'F',5),null);
  assert.ok(parseAccountingFormula('=COUNTA(F2:F5)*600','F',5));
});

test('real formula is read and normalized without mutation; arbitrary formulas fail closed',async()=>{
  const f=fixture();let snapshot=await readSheet(f.client,'k44Wnf');
  assert.equal(await normalizeFormulaRates(f.client,'k44Wnf',snapshot),false);
  assert.equal(f.writes.length,0);assert.equal(amount(f.rows),1400);
  f.rows.at(-1)[1]=adjusted()+'+1';
  await assert.rejects(readSheet(f.client,'k44Wnf'),/formula changed in column B/u);
  assert.equal(f.writes.length,0);
});

test('normalizing owned rates and stale ranges preserves both item adjustments',async()=>{
  const f=fixture(); f.rows.at(-1)[1]=adjusted(4);f.rows.at(-1)[4]='=COUNTA(E2:E4)*600';
  await normalizeFormulaRates(f.client,'k44Wnf',await readSheet(f.client,'k44Wnf'));
  assert.equal(f.rows.at(-1)[1],adjusted());assert.equal(f.rows.at(-1)[4],'=COUNTA(E2:E5)*200');
  assert.equal(amount(f.rows),1400);
});

for(const autoResize of [false,true]) for(const insertLost of [false,true])
test(`full column insertion preserves conditional pricing and idempotency (native=${autoResize}, lost=${insertLost})`,async()=>isolated(async stateDir=>{
  const f=fixture({full:true,autoResize,insertLost}),item=dispatch('TS','新普通单','insert');
  assert.equal((await recordDispatchAccounting({client:f.client,stateDir,...item})).recorded,1);
  assert.equal(f.stats().inserts,1);assert.equal(f.rows.at(-1)[1],adjusted(6));
  assert.equal(amount(f.rows),1400);assert.equal(f.rows[5][0],'新普通单');
  const writes=f.writes.length;
  await recordDispatchAccounting({client:f.client,stateDir,...item});
  assert.equal(f.writes.length,writes);assert.equal(f.stats().inserts,1);
}));

test('references shifted by an inserted data row survive normalization and later insertion',async()=>{
  const f=fixture({autoResize:true});f.insert('k44Wnf',1);
  assert.equal(f.rows.at(-1)[1],adjusted(6,3,4).replace('COUNTA(B2:', 'COUNTA(B3:'));
  await normalizeFormulaRates(f.client,'k44Wnf',await readSheet(f.client,'k44Wnf'));
  assert.equal(f.rows.at(-1)[1],adjusted(6,3,4));
  await insertBeforeTotal(f.client,'k44Wnf',await readSheet(f.client,'k44Wnf'));
  assert.equal(f.rows.at(-1)[1],adjusted(7,3,4));assert.equal(amount(f.rows),1400);
});

test('an insertion that loses an adjustment is rejected without rewriting the altered total',async()=>{
  const f=fixture({dropAdjustment:true});
  await assert.rejects(insertBeforeTotal(f.client,'k44Wnf',await readSheet(f.client,'k44Wnf')),/adjustments changed during insertion/u);
  assert.equal(f.stats().inserts,1);
  assert.equal(f.writes.filter(w=>w.range?.startsWith('B')).length,0);
});

test('additional ordinary special entries remain 600 and the original two are not charged twice',async()=>{
  const f=fixture();
  await verifiedWrite(f.client,'k44Wnf','B4','另一项已人工定价特殊单');
  await normalizeFormulaRates(f.client,'k44Wnf',await readSheet(f.client,'k44Wnf'));
  assert.equal(amount(f.rows),2000);assert.equal(f.rows.at(-1)[1],adjusted());
  await verifiedWrite(f.client,'k44Wnf','B4','');assert.equal(amount(f.rows),1400);
  // Clearing an approved item also disables its conditional adjustment.
  await verifiedWrite(f.client,'k44Wnf','B2','');assert.equal(amount(f.rows),700);
});

test('regular/year orders, shared-code billing and duplicate delivery retain their rules',async()=>isolated(async stateDir=>{
  const f=fixture();
  for(const [code,category,col] of [['TS','regular',0],['TS1','regular',4],['BK1','year',3],['BK2','year',6]]) {
    const item=dispatch(code,`对象-${code}`,code,category);
    await recordDispatchAccounting({client:f.client,stateDir,...item});
    const writes=f.writes.length;await recordDispatchAccounting({client:f.client,stateDir,...item});
    assert.equal(f.writes.length,writes);assert.equal(f.rows.slice(1,-1).filter(r=>r[col]===`对象-${code}`).length,1);
  }
  const joint=dispatch('TS','共同对象','joint');joint.scope.assignments.push({...joint.scope.assignments[0],code:'临A'});
  await recordDispatchAccounting({client:f.client,stateDir,...joint});
  assert.equal(f.rows.slice(1,-1).filter(r=>r[0]==='共同对象').length,2);
  const writes=f.writes.length;await recordDispatchAccounting({client:f.client,stateDir,...joint});assert.equal(f.writes.length,writes);
  assert.equal(amount(f.rows),1400);
}));

test('unpriced special dispatch remains unsupported, without new automatic charging',async()=>isolated(async stateDir=>{
  const f=fixture(),result=await recordDispatchAccounting({client:f.client,stateDir,...dispatch('TS','特殊需求','special','special')});
  assert.equal(result.recorded,0);assert.equal(result.blocked[0].reason,'unsupported');
  assert.equal(f.writes.length,0);
}));

test('month copy clears one-off adjustments only in the new blank month',async()=>isolated(async stateDir=>{
  const f=fixture(),original=structuredClone(f.rows);
  await ensureMonthlySheet(f.client,'26年11月bd汇总',stateDir);
  assert.deepEqual(f.rows,original);assert.equal(f.tables.get('newmonth').at(-1)[1],'=COUNTA(B2:B5)*600');
  const writes=f.writes.length;await ensureMonthlySheet(f.client,'26年11月bd汇总',stateDir);assert.equal(f.writes.length,writes);
  assert.equal(f.stats().copies,1);
}));

test('reconciliation through a full column retains special adjustments and replay adds nothing',async()=>isolated(async stateDir=>{
  const f=fixture({full:true,autoResize:true});fs.writeFileSync(path.join(stateDir,'accounting-ledger.json'),JSON.stringify({entries:{}}));
  const plan={version:1,authorization:'fixture only',items:[{key:'r1',column:'A',subject:'核对新增',sourceMessageId:'mock',sourceDate:'2026-10-25',category:'regular',sheetTitle:'26年10月bd汇总'}]};
  assert.equal((await reconcileAccountingPlan({client:f.client,stateDir,plan})).added,1);
  const writes=f.writes.length;assert.equal((await reconcileAccountingPlan({client:f.client,stateDir,plan})).adopted,1);
  assert.equal(f.writes.length,writes);assert.equal(amount(f.rows),1400);assert.equal(f.rows.at(-1)[1],adjusted(6));
}));

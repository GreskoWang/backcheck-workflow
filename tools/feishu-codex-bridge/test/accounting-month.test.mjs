import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { accountingMonth, ensureMonthlySheet, recordDispatchAccounting, insertBeforeTotal, readSheet, normalizeFormulaRates, verifiedWrite } from '../src/accounting-ledger.mjs';
import { reconcileAccountingPlan, processAccountingReconciliation } from '../src/accounting-reconciliation.mjs';
import { redactSecrets } from '../src/redact.mjs';

const headers = ['王书鲲','王书鲲（特殊）','王书鲲（私人）','王书鲲（一年）','徐嘉怡','徐嘉怡（特殊）','徐嘉怡（一年）','转移'];
function fixture(options = {}) {
  const rows = [headers, ['旧甲',null,null,'旧乙',null,null,null,null], Array(8).fill(null),
    [...'ABCDEFGH'].map((c,i) => `=COUNTA(${c}2:${c}3)*${[200,600,600,50,600,600,50,600][i]}`)];
  const tables = new Map([['k44Wnf', { rows: structuredClone(rows), style: 'template-style' }]]);
  const sheets = [{sheet_id:'k44Wnf',title:'26年10月bd汇总'}];
  let copies=0, clears=0, inserts=0;
  const client={sheets:{spreadsheetSheet:{query:async()=>({code:0,data:{sheets:structuredClone(sheets)}})}},
    request:async({method,url,data})=>{
      if(method==='GET'){
        const id=decodeURIComponent(url.split('/values/')[1]).split('!')[0];
        return {code:0,data:{valueRange:{values:structuredClone(tables.get(id).rows),revision:1}}};
      }
      if(url.endsWith('/sheets_batch_update')){
        copies++;
        const copy=data.requests[0].copySheet;
        tables.set('newmonth',structuredClone(tables.get(copy.source.sheetId)));
        sheets.push({sheet_id:'newmonth',title:copy.destination.title});
        if(options.copyLost)throw new Error('response lost');
        return {code:0,data:{}};
      }
      if(url.endsWith('/insert_dimension_range')){
        inserts++;tables.get(data.dimension.sheetId).rows.splice(data.dimension.startIndex,0,Array(8).fill(null));
        if(options.insertLost)throw new Error('response lost');
        return {code:0,data:{}};
      }
      if(method==='PUT'){
        const [id,range]=data.valueRange.range.split('!');
        const match=range.match(/^([A-H])(\d+):/u);
        const start=Number(match[2])-1,col=match[1].charCodeAt(0)-65;
        data.valueRange.values.forEach((row,r)=>row.forEach((v,c)=>tables.get(id).rows[start+r][col+c]=v?.type==='formula'?v.text:v));
        if(data.valueRange.values.length>1){clears++;if(options.clearLost)throw new Error('response lost');}
        return {code:0,data:{}};
      }
      throw new Error('unexpected endpoint');
    }};
  return {client,tables,sheets,stats:()=>({copies,clears,inserts})};
}
async function isolated(run){const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'month-test-'));try{await run(stateDir);}finally{fs.rmSync(stateDir,{recursive:true,force:true});}}

test('Shanghai source date crosses month and year boundaries',()=>{
  assert.equal(accountingMonth(Date.parse('2026-09-30T15:59:59Z')),'26年9月bd汇总');
  assert.equal(accountingMonth(Date.parse('2026-09-30T16:00:00Z')),'26年10月bd汇总');
  assert.equal(accountingMonth(Date.parse('2026-12-31T16:00:00Z')),'27年1月bd汇总');
});
for(const options of [{},{copyLost:true},{clearLost:true}]) test(`missing month copies once and preserves style/template ${JSON.stringify(options)}`,async()=>isolated(async stateDir=>{
  const f=fixture(options),before=structuredClone(f.tables.get('k44Wnf'));
  assert.equal(await ensureMonthlySheet(f.client,'26年11月bd汇总',stateDir),'newmonth');
  assert.equal(await ensureMonthlySheet(f.client,'26年11月bd汇总',stateDir),'newmonth');
  assert.deepEqual(f.tables.get('k44Wnf'),before);
  assert.equal(f.tables.get('newmonth').style,'template-style');
  assert.ok(f.tables.get('newmonth').rows.slice(1,3).every(r=>r.every(v=>v==='')));
  assert.equal(f.tables.get('newmonth').rows[3][4],'=COUNTA(E2:E3)*200');
  assert.equal(f.tables.get('newmonth').rows[3][7],'=COUNTA(H2:H3)*600');
  assert.equal(f.stats().copies,1);
}));
test('duplicate month and invalid template do not mutate workbook',async()=>isolated(async stateDir=>{
  const f=fixture();f.sheets.push({sheet_id:'duplicate',title:'26年10月bd汇总'});
  await assert.rejects(ensureMonthlySheet(f.client,'26年10月bd汇总',stateDir),/duplicated/u);
  f.sheets.pop();f.tables.get('k44Wnf').rows[0][0]='edited heading';
  await assert.rejects(ensureMonthlySheet(f.client,'26年11月bd汇总',stateDir),/headings/u);
  assert.equal(f.stats().copies,0);
}));
test('pending initialization refuses to erase another editor value',async()=>isolated(async stateDir=>{
  const f=fixture();f.tables.set('newmonth',structuredClone(f.tables.get('k44Wnf')));
  f.sheets.push({sheet_id:'newmonth',title:'26年11月bd汇总'});
  fs.writeFileSync(path.join(stateDir,'accounting-ledger.json'),JSON.stringify({entries:{},months:{'26年11月bd汇总':{
    status:'initializing',sheetId:'newmonth',totalIndex:3,originalRows:f.tables.get('k44Wnf').rows}}}));
  f.tables.get('newmonth').rows[1][0]='someone else';
  await assert.rejects(ensureMonthlySheet(f.client,'26年11月bd汇总',stateDir),/edited/u);
  assert.equal(f.stats().clears,0);
}));
test('a definitively rejected copy may retry after confirming the month is absent',async()=>isolated(async stateDir=>{
  const f=fixture(),request=f.client.request;let rejectOnce=true;
  f.client.request=async(args)=>{
    if(rejectOnce&&args.url.endsWith('/sheets_batch_update')){rejectOnce=false;return {code:400,msg:'rejected'};}
    return request(args);
  };
  await assert.rejects(ensureMonthlySheet(f.client,'26年11月bd汇总',stateDir),/Feishu code 400/u);
  assert.equal(await ensureMonthlySheet(f.client,'26年11月bd汇总',stateDir),'newmonth');
  assert.equal(f.stats().copies,1);
}));
test('new month item replay never duplicates billing',async()=>isolated(async stateDir=>{
  const f=fixture();const job={requestId:'RQ',sourceMessageId:'om',sourceMessageCreatedAtMs:Date.parse('2026-11-01T00:00:00Z'),requestText:'【背调需求11.1】\n一年'};
  const scope={requestMode:'team_dispatch',decision:'execute',assignments:[{code:'TS1',sourceBlock:'第1个【背调需求11.1】块',itemNumbers:['1'],subject:'新项'}]};
  await recordDispatchAccounting({client:f.client,stateDir,job,scope});await recordDispatchAccounting({client:f.client,stateDir,job,scope});
  assert.equal(f.tables.get('newmonth').rows.flat().filter(v=>v==='新项').length,1);
  assert.equal(f.stats().copies,1);
}));
test('a failed planned write to an empty-string cell safely resumes',async()=>isolated(async stateDir=>{
  const f=fixture(),request=f.client.request;let failWrites=true;f.tables.get('k44Wnf').rows[1][4]='';
  f.tables.get('k44Wnf').rows[3][4]='=COUNTA(E2:E3)*200';
  f.client.request=async(args)=>{if(failWrites&&args.method==='PUT')throw new Error('transport failed before write');return request(args);};
  const job={requestId:'RQ',sourceMessageId:'om',sourceMessageCreatedAtMs:Date.parse('2026-10-09T00:00:00Z'),requestText:'【背调需求10.9】'};
  const scope={requestMode:'team_dispatch',decision:'execute',assignments:[{code:'TS1',sourceBlock:'第1个【背调需求10.9】块',itemNumbers:['1'],subject:'新项'}]};
  await assert.rejects(recordDispatchAccounting({client:f.client,stateDir,job,scope}));failWrites=false;
  assert.equal((await recordDispatchAccounting({client:f.client,stateDir,job,scope})).recorded,1);
  assert.equal(f.tables.get('k44Wnf').rows.flat().filter(v=>v==='新项').length,1);
}));
test('lost insertion response is confirmed without second insertion',async()=>{
  const f=fixture({insertLost:true});const snapshot=await readSheet(f.client,'k44Wnf');
  const after=await insertBeforeTotal(f.client,'k44Wnf',snapshot);
  assert.equal(after.totalIndex,4);assert.equal(f.stats().inserts,1);
  assert.equal(after.rows[4][7],'=COUNTA(H2:H4)*600');
});
test('transient TLS reads retry within a fixed bound and permission errors do not',async()=>{
  const f=fixture(),request=f.client.request;let attempts=0;
  f.client.request=async(args)=>{if(args.method==='GET'&&attempts++===0)throw Object.assign(new Error('TLS connection interrupted'),{code:'ECONNRESET'});return request(args);};
  assert.equal((await readSheet(f.client,'k44Wnf')).totalIndex,3);assert.equal(attempts,2);
  attempts=0;f.client.request=async(args)=>{if(args.method==='GET'&&attempts++===0)throw Object.assign(new Error('request timeout'),{code:'ECONNABORTED'});return request(args);};
  assert.equal((await readSheet(f.client,'k44Wnf')).totalIndex,3);assert.equal(attempts,2);
  let forbiddenCalls=0;f.client.request=async()=>{forbiddenCalls++;throw Object.assign(new Error('forbidden'),{code:403});};
  await assert.rejects(readSheet(f.client,'k44Wnf'),/forbidden/u);assert.equal(forbiddenCalls,1);
});
test('numeric totals are recognized and replaced with correctly bounded COUNTA',async()=>{
  const f=fixture();f.tables.get('k44Wnf').rows[3]=[200,0,0,50,0,0,0,0];
  const snapshot=await readSheet(f.client,'k44Wnf');
  await normalizeFormulaRates(f.client,'k44Wnf',snapshot);
  assert.equal(f.tables.get('k44Wnf').rows[3][0],'=COUNTA(A2:A3)*200');
  assert.equal(f.tables.get('k44Wnf').rows[3][1],'=COUNTA(B2:B3)*600');
});
test('historical reconciliation moves before clearing and remains idempotent',async()=>isolated(async stateDir=>{
  const f=fixture();fs.writeFileSync(path.join(stateDir,'accounting-ledger.json'),JSON.stringify({entries:{}}));
  const plan={version:1,authorization:'explicit user instruction',transferRate:50,items:[{key:'source-key',subject:'旧甲',column:'E',category:'regular',sourceMessageId:'om',sourceDate:'2026-10-08',sheetTitle:'26年10月bd汇总'}]};
  const first=await reconcileAccountingPlan({client:f.client,stateDir,plan});
  assert.equal(first.moved,1);assert.equal(f.tables.get('k44Wnf').rows[1][0],'');
  const second=await reconcileAccountingPlan({client:f.client,stateDir,plan});
  assert.equal(second.added,0);assert.equal(second.moved,0);
  assert.equal(f.tables.get('k44Wnf').rows[3][7],'=COUNTA(H2:H3)*50');
  assert.equal(f.tables.get('k44Wnf').rows.flat().filter(v=>v==='旧甲').length,1);
}));
test('secret redaction removes full synthetic authorization values',()=>{
  for(const input of ['Authorization: Bearer synthetic-example','{"headers":{"Authorization":"Bearer synthetic-example"}}','access_token=synthetic-example']){
    assert.ok(!redactSecrets(input).includes('synthetic-example'));
  }
});

test('a successful write with a stale first read is confirmed without another mutation',async()=>{
  const f=fixture(),request=f.client.request,previous=structuredClone(f.tables.get('k44Wnf').rows);
  let writes=0,staleReads=0;
  f.client.request=async(args)=>{
    if(args.method==='PUT'){writes++;await request(args);return {code:0,data:{revision:2}};}
    if(args.method==='GET'&&writes&&staleReads++===0)return {code:0,data:{valueRange:{values:previous,revision:1}}};
    const response=await request(args);if(args.method==='GET')response.data.valueRange.revision=2;return response;
  };
  await verifiedWrite(f.client,'k44Wnf','E4','=COUNTA(E2:E3)*200');
  assert.equal(writes,1);assert.equal(staleReads,2);
});
test('reads below a successful write revision stop with no second mutation',async()=>{
  const f=fixture(),request=f.client.request;let writes=0;
  f.client.request=async(args)=>{
    if(args.method==='PUT'){writes++;return {code:0,data:{revision:2}};}
    return request(args);
  };
  await assert.rejects(verifiedWrite(f.client,'k44Wnf','E4','=COUNTA(E2:E3)*200'),e=>e.code==='ACCOUNTING_READ_STALE'&&e.retryable===true);
  assert.equal(writes,1);
});
test('persistent unexpected values are never overwritten by a second mutation',async()=>{
  const f=fixture(),request=f.client.request;let writes=0;
  f.client.request=async(args)=>{
    if(args.method==='PUT'){writes++;return {code:0,data:{}};}
    return request(args);
  };
  await assert.rejects(verifiedWrite(f.client,'k44Wnf','A2','新项'),/changed to another value/u);
  assert.equal(writes,1);assert.equal(f.tables.get('k44Wnf').rows[1][0],'旧甲');
});

for (const unavailable of ['once', 'always', 'forbidden']) test(`resident reconciliation resumes from verified state with bounded attempts: ${unavailable}`,async()=>isolated(async stateDir=>{
  const f=fixture(),request=f.client.request;
  f.tables.get('k44Wnf').rows[1][6]='既有一';f.tables.get('k44Wnf').rows[2][6]='既有二';
  fs.writeFileSync(path.join(stateDir,'accounting-ledger.json'),JSON.stringify({entries:{}}));
  const plan={version:1,status:'pending',authorization:'explicit user instruction',items:[{key:'source-key',subject:'新年项',column:'G',category:'year',sourceMessageId:'om',sourceDate:'2026-10-08',sheetTitle:'26年10月bd汇总'}]};
  fs.writeFileSync(path.join(stateDir,'accounting-reconciliation.json'),JSON.stringify(plan));
  let attempts=0;
  f.client.request=async(args)=>{
    if(args.url.endsWith('/insert_dimension_range')){
      attempts++;
      if(unavailable==='forbidden')throw Object.assign(new Error('forbidden'),{response:{status:403}});
      if(unavailable==='always'||attempts===1)throw Object.assign(new Error('transport failed before write'),{code:'ACCOUNTING_TRANSPORT_FAILED'});
    }
    return request(args);
  };
  if(unavailable==='once'){
    assert.equal((await processAccountingReconciliation({client:f.client,stateDir})).status,'completed');
    assert.equal(attempts,2);assert.equal(f.stats().inserts,1);
    assert.equal(f.tables.get('k44Wnf').rows.flat().filter(v=>v==='新年项').length,1);
    assert.equal(await processAccountingReconciliation({client:f.client,stateDir}),null);
  }else{
    await assert.rejects(processAccountingReconciliation({client:f.client,stateDir}));
    assert.equal(attempts,unavailable==='always'?3:1);assert.equal(f.stats().inserts,0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir,'accounting-reconciliation.json'))).status,'blocked');
  }
}));

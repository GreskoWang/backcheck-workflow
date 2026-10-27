#!/usr/bin/env node
// Isolated tests of the production callFixedFunctionUnlocked function.
// Uses only Node built-ins. Never starts a browser, broker or network listener.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

function option(name) {
  const i=process.argv.indexOf(name);
  return i<0 ? null : process.argv[i+1];
}
const root=option('--repo');
if (!root) {
  console.error('Usage: node test-dom-request-quarantine.mjs --repo PATH [--out result.json]');
  process.exit(2);
}
const sourcePath=path.resolve(root,'skills/web-access/scripts/cdp-proxy.mjs');
const source=fs.readFileSync(sourcePath,'utf8');
function section(start,end) {
  const a=source.indexOf(start), b=source.indexOf(end,a);
  assert.ok(a>=0 && b>a,`Production function boundary not found: ${start}`);
  return source.slice(a,b);
}
const functions=section('function isSessionInvalidError(', 'function queueForTarget(')
  +section('async function callFixedFunctionUnlocked(', 'async function pageTargets(');
class BrokerError extends Error {
  constructor(code,message,details,status) { super(message);Object.assign(this,{code,details,status}); }
}
function fixture(behavior) {
  const calls=[], quarantined=[], invalidated=[];
  const context={
    BrokerError,BUDGETS:{dom:5000},
    ensureSession:async()=> 'fixture-session',
    fixedWorlds:{resolve:async()=>101,invalidate:(...a)=>invalidated.push(a)},
    sendCdp:async(...a)=>{calls.push(a);return behavior(calls.length,...a);},
    quarantineTimedOutTarget:async(...a)=>quarantined.push(a),
    clearSessionByTarget:()=>{},
  };
  const api=vm.runInNewContext(functions+'\ncallFixedFunctionUnlocked',context);
  return {calls,quarantined,invalidated,run:options=>api('fixture-page','function(){return true}',[],{deadline:{},...options})};
}
const cases=[];
async function test(name,fn) {
  try {await fn();cases.push({name,pass:true});}
  catch(e) {cases.push({name,pass:false,error:e.message});}
}
for (const code of ['cdp_timeout','request_timeout','request_aborted']) {
  await test(`${code} quarantines the target and never replays the read`,async()=>{
    const f=fixture(()=>{throw new BrokerError(code,'Synthetic unresolved CDP read',{method:'Runtime.callFunctionOn',outcomeUnknown:true});});
    await assert.rejects(f.run(),e=>e.code===code);
    assert.equal(f.calls.length,1,'Read was replayed');
    assert.equal(f.quarantined.length,1,'Unresolved read did not quarantine its target');
    assert.equal(f.quarantined[0][0],'fixture-page');
    assert.equal(f.quarantined[0][1],'fixture-session');
    assert.equal(f.quarantined[0][2].code,code);
  });
}
await test('ordinary protocol errors retain their error without replay or quarantine',async()=>{
  const f=fixture(()=>{throw new BrokerError('cdp_error','Synthetic invalid parameter');});
  await assert.rejects(f.run(),e=>e.code==='cdp_error');
  assert.equal(f.calls.length,1);assert.equal(f.quarantined.length,0);
});
await test('a successful read stays usable and keeps fixed protocol parameters',async()=>{
  const f=fixture(()=>({result:{type:'boolean',value:true}}));
  assert.equal((await f.run()).result.value,true);
  assert.equal(f.quarantined.length,0);
  assert.equal(f.calls[0][0],'Runtime.callFunctionOn');
  assert.equal(f.calls[0][1].executionContextId,101);
  assert.equal(f.calls[0][1].userGesture,false);
  assert.equal('timeout' in f.calls[0][1],false);
});
await test('side-effect cancellation retains outcome_unknown handling',async()=>{
  const f=fixture(()=>{throw new BrokerError('request_aborted','Synthetic cancellation',{outcomeUnknown:true});});
  await assert.rejects(f.run({sideEffect:true}),e=>e.code==='outcome_unknown');
  assert.equal(f.calls.length,1);assert.equal(f.quarantined.length,1);
});
await test('the existing bounded stale-context retry still succeeds',async()=>{
  const f=fixture(n=>{if(n===1)throw new BrokerError('isolated_context_changed','Synthetic document change');return {result:{value:true}};});
  assert.equal((await f.run()).result.value,true);
  assert.equal(f.calls.length,2);assert.equal(f.invalidated.length,1);assert.equal(f.quarantined.length,0);
});
const result={
  test:'DOM request quarantine',
  runtime:process.version,
  sourceSha256:createHash('sha256').update(source).digest('hex'),
  liveBrowserUsed:false,
  passed:cases.filter(x=>x.pass).length,total:cases.length,
  allPassed:cases.every(x=>x.pass),cases,
};
console.log(JSON.stringify(result,null,2));
const out=option('--out');
if(out)fs.writeFileSync(path.resolve(out),JSON.stringify(result,null,2)+'\n');
if(!result.allPassed)process.exitCode=1;

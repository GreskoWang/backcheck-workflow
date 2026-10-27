#!/usr/bin/env node
// Execute actual broker functions with two synthetic target sessions. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const opt=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
if(!opt('--repo'))throw new Error('--repo is required');
const file=path.resolve(opt('--repo'),'skills/web-access/scripts/cdp-proxy.mjs');
const source=fs.readFileSync(file,'utf8');
function section(a,b){const i=source.indexOf(a),j=source.indexOf(b,i);assert.ok(i>=0&&j>i,a);return source.slice(i,j);}
const code=section('function edgeCdpVersion(', 'async function discoverEdgeEndpoints(')
  +section('function handleBrowserMessage(', 'function trackDerivedTaskTarget(')
  +section('function sendCdp(', 'function waitForEvent(');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const observe=p=>p.then(value=>({value}),error=>({error}));
const validVersion={product:'Chrome/152.0.0.0',userAgent:'Mozilla/5.0 Edg/152.0.0.0'};
class BrokerError extends Error {constructor(code,message,details,status){super(message);Object.assign(this,{code,details,status});}}
function fixture({health='ok',healthDelay=5,state='connected'}={}){
  const calls=[],retirements=[],timers=new Set(),pending=new Map();
  const later=(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;};
  const c={pending,targetsBySession:new Map([['session-B','B']]),managedTabs:new Map(),closingTargets:new Map(),
    commandId:0,lastCdpTimeout:null,metadataHealthProbe:null,connectionState:state,BUDGETS:{metadata:80},
    BrokerError,setTimeout,clearTimeout,Date,Math,Number,Promise,
    assertCdpMethodAllowed(){},positiveInteger:(x,d)=>Number(x)||d,methodTimeout:()=>80,
    isOpen:s=>s?.readyState===1,normalizeWsData:x=>x,
    retireBrowserSocket(socket,reason){if(c.browserSocket!==socket)return;retirements.push(reason);c.browserSocket=null;c.connectionState='disconnected';for(const item of [...pending.values()])item.reject(new BrokerError('connection_lost','fixture retirement'));},
  };
  c.browserSocket={readyState:1,send(raw){
    const msg=JSON.parse(raw);calls.push({...msg,socket:this});
    if(msg.method==='Browser.getVersion'&&health!=='hang')later(()=>{
      const payload=health==='error'?{error:{code:-1,message:'synthetic health failure'}}:{result:health==='invalid'?{userAgent:'HeadlessChrome/152.0.0.0'}:validVersion};
      c.handleBrowserMessage(this,JSON.stringify({id:msg.id,...payload}));
    },healthDelay);
    if(msg.method==='Runtime.callFunctionOn')later(()=>c.handleBrowserMessage(this,JSON.stringify({id:msg.id,result:{target:'B',value:'actual-B-result'}})),45);
  }};
  vm.createContext(c);vm.runInContext(code,c);
  return {c,calls,retirements,socket:c.browserSocket,pending,later,
    async cleanup(){for(const t of timers)clearTimeout(t);for(const e of [...pending.values()])e.reject(new BrokerError('fixture_cleanup','cleanup'));await sleep(0);}};
}
const cases=[];
async function test(name,fn){let f;try{f=fixture(fn.options);await fn(f);cases.push({name,passed:true});}catch(e){cases.push({name,passed:false,error:e.message,code:e.code||null});}finally{await f?.cleanup();}}
const withOptions=(options,fn)=>Object.assign(fn,{options});
const metadata=(f,method='Target.getTargetInfo',timeoutMs=15)=>f.c.sendCdp(method,{targetId:'A'},{targetId:'A',timeoutMs});
const healthCount=f=>f.calls.filter(x=>x.method==='Browser.getVersion').length;
const pendingB=f=>observe(f.c.sendCdp('Runtime.callFunctionOn',{}, {sessionId:'session-B',targetId:'B',timeoutMs:200}));
for(const method of ['Target.getTargets','Target.getTargetInfo'])await test(`${method}_timeout_keeps_other_owner_session`,async f=>{
  const b=pendingB(f);await assert.rejects(metadata(f,method),e=>e.code==='cdp_timeout');
  const result=await b;assert.equal(result.value?.target,'B');assert.equal(f.retirements.length,0);
  assert.equal(f.c.browserSocket,f.socket);assert.equal(healthCount(f),1);assert.equal(f.c.lastCdpTimeout.connectionHealthCheck.status,'healthy');
  assert.equal(f.calls.filter(x=>x.method===method).length,1,'original read is not replayed');
});
await test('late_metadata_response_cannot_complete_an_unrelated_request',async f=>{
  const a=observe(metadata(f));const aId=f.calls[0].id;const b=pendingB(f);await a;
  let bFinished=false;b.then(()=>{bFinished=true;});
  f.c.handleBrowserMessage(f.socket,JSON.stringify({id:aId,result:{target:'A',value:'late-A'}}));
  await sleep(5);assert.equal(bFinished,false);assert.equal((await b).value?.value,'actual-B-result');
});
await test('concurrent_metadata_timeouts_share_one_probe',withOptions({healthDelay:35},async f=>{
  const a=observe(metadata(f,'Target.getTargetInfo',12));const b=observe(metadata(f,'Target.getTargets',18));
  assert.equal((await a).error?.code,'cdp_timeout');assert.equal((await b).error?.code,'cdp_timeout');
  await sleep(45);assert.equal(healthCount(f),1);assert.equal(f.retirements.length,0);assert.equal(f.c.lastCdpTimeout.connectionHealthCheck.status,'healthy');
}));
for(const health of ['hang','invalid','error'])await test(`failed_health_${health}_retires_once_without_recursive_probe`,withOptions({health},async f=>{
  await assert.rejects(metadata(f),e=>e.code==='cdp_timeout');await sleep(100);
  assert.equal(healthCount(f),1);assert.equal(f.retirements.length,1);assert.equal(f.c.browserSocket,null);assert.equal(f.c.metadataHealthProbe,null);
}));
for(const health of ['ok','error'])await test(`stale_${health}_probe_cannot_validate_or_retire_replacement_socket`,withOptions({health,healthDelay:40},async f=>{
  await assert.rejects(metadata(f),e=>e.code==='cdp_timeout');const observation=f.c.lastCdpTimeout.connectionHealthCheck;const replacement={readyState:1,send(){throw new Error('old probe used replacement');}};
  f.c.browserSocket=replacement;f.c.connectionState='connected';await sleep(110);
  assert.equal(f.c.browserSocket,replacement);assert.equal(f.retirements.length,0);
  assert.equal(observation.status,'retired_or_replaced');assert.equal(healthCount(f),1);
}));
await test('initial_validation_metadata_still_retires_without_probe',withOptions({state:'validating'},async f=>{
  await assert.rejects(metadata(f,'Target.getTargets'),e=>e.code==='cdp_timeout');assert.equal(f.retirements.length,1);assert.equal(healthCount(f),0);
}));
for(const method of ['Target.attachToTarget','Target.createTarget','Target.detachFromTarget','Target.closeTarget'])await test(`${method}_timeout_still_retires_generation`,async f=>{
  const b=pendingB(f);await assert.rejects(f.c.sendCdp(method,{targetId:'A'},{targetId:'A',timeoutMs:15}),e=>e.code==='cdp_timeout');
  assert.equal((await b).error?.code,'connection_lost');assert.equal(f.retirements.length,1);assert.equal(healthCount(f),0);
});
await test('attach_cancellation_keeps_original_generation_retirement',async f=>{
  const controller=new AbortController();const b=pendingB(f);
  const a=observe(f.c.sendCdp('Target.attachToTarget',{targetId:'A'},{targetId:'A',timeoutMs:100,deadline:{remaining:()=>100,signal:controller.signal}}));
  controller.abort('request_aborted');assert.equal((await a).error?.code,'request_aborted');assert.equal((await b).error?.code,'connection_lost');assert.equal(f.retirements.length,1);assert.equal(healthCount(f),0);
});
await test('tracked_managed_close_keeps_original_local_timeout_exception',async f=>{
  f.c.managedTabs.set('A',{owner:'fixture'});f.c.closingTargets.set('A',{});const b=pendingB(f);
  await assert.rejects(f.c.sendCdp('Target.closeTarget',{targetId:'A'},{targetId:'A',timeoutMs:15}),e=>e.code==='cdp_timeout');
  assert.equal((await b).value?.target,'B');assert.equal(f.retirements.length,0);assert.equal(healthCount(f),0);
});
const report={suite:'U07 metadata timeout isolation and generation protections',runtime:process.version,platform:process.platform,
  sourceSha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),liveBrowserUsed:false,networkUsed:false,
  passed:cases.filter(x=>x.passed).length,total:cases.length,allPassed:cases.every(x=>x.passed),cases};
if(opt('--out')){const out=path.resolve(opt('--out'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));if(!report.allPassed)process.exitCode=1;

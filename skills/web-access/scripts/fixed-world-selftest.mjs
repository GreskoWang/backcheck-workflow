import assert from 'node:assert/strict';
import {createFixedWorldResolver} from './fixed-world.mjs';

const makeError=(code,message,details)=>Object.assign(new Error(message),{code,details});
let frame={id:'frame-1',loaderId:'document-1'};
let creates=0,trees=0,delayMs=0,never=false,onCreate=null;
const call=async(method,params,options)=>{
  if(method==='Page.getFrameTree'){trees++;return {frameTree:{frame:{...frame}}};}
  assert.equal(method,'Page.createIsolatedWorld');
  assert.equal(params.worldName,'codex-background-check-broker');
  assert.equal(params.grantUniveralAccess,false);
  creates++;
  if(onCreate)onCreate();
  if(never || delayMs>options.timeoutMs){
    await new Promise(r=>setTimeout(r,options.timeoutMs));
    throw makeError('cdp_timeout','simulated renderer did not respond within method budget');
  }
  if(delayMs)await new Promise(r=>setTimeout(r,delayMs));
  return {executionContextId:creates};
};
const resolver=createFixedWorldResolver({sendCdp:call,makeError});
const a=await resolver.resolve('target-a','session-a',{});
for(let i=0;i<20;i++)assert.equal(await resolver.resolve('target-a','session-a',{}),a);
assert.equal(creates,1); assert.equal(trees,21,'every reuse must verify the current frame tree');

frame.loaderId='document-2';
assert.notEqual(await resolver.resolve('target-a','session-a',{}),a);
assert.equal(creates,2,'same frame with a new document cannot reuse the old context');
frame.id='frame-2'; await resolver.resolve('target-a','session-a',{});
assert.equal(creates,3);
await resolver.resolve('target-a','session-b',{}); assert.equal(creates,4);
resolver.invalidate('target-a','session-a');
await resolver.resolve('target-a','session-b',{}); assert.equal(creates,4,'late detach of old session must not erase the new session');
resolver.invalidate('target-a','session-b');
await resolver.resolve('target-a','session-b',{}); assert.equal(creates,5);
resolver.clear(); await resolver.resolve('target-a','session-b',{}); assert.equal(creates,6);
await resolver.resolve('target-b','session-b',{}); assert.equal(creates,7,'targets cannot share a context');

delete frame.loaderId;
await resolver.resolve('unknown-loader','session-a',{});
await resolver.resolve('unknown-loader','session-a',{});
assert.equal(creates,9,'missing document identity disables reuse');
frame.loaderId='document-3';
onCreate=()=>resolver.invalidate('navigation-race','session-a');
await assert.rejects(resolver.resolve('navigation-race','session-a',{}),e=>e.code==='isolated_context_changed');
onCreate=null;
await resolver.resolve('navigation-race','session-a',{});
assert.equal(creates,11,'an in-flight context invalidated by navigation was not reused');

delayMs=2200;
const legacy=createFixedWorldResolver({sendCdp:call,makeError,worldTimeoutMs:2000});
await assert.rejects(legacy.resolve('legacy-slow','session-a',{}),e=>e.code==='cdp_timeout');
await resolver.resolve('same-latency','session-a',{});
const before=creates;
await resolver.resolve('same-latency','session-a',{});
assert.equal(creates,before,'second read avoids another slow world request');

never=true; delayMs=0;
const bounded=createFixedWorldResolver({sendCdp:call,makeError,worldTimeoutMs:40});
const started=Date.now();
await assert.rejects(bounded.resolve('hung','session-a',{}),e=>e.code==='cdp_timeout');
assert.ok(Date.now()-started<1000,'a genuinely unresponsive renderer remains bounded');
console.log(JSON.stringify({status:'PASS',cases:11,warmReads:21,warmWorldCreates:1,legacy2200ms:'timeout',candidate2200ms:'pass',navigationRace:'rejected',liveBrowserUsed:false}));

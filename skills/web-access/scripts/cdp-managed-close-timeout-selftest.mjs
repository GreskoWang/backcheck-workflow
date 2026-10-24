import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./cdp-proxy.mjs',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const code=section('function sendCdp(', 'function waitForEvent(')
  +section('async function closeOverflowDerivedTarget(', 'function waitForSharedConnection(')
  +section('async function sweepUnclaimedDerivedTargets(', 'async function withPopupRiskReservation(');
async function scenario(method,owned=false) {
  let retired=0, sent=0;
  const pending=new Map(), managedTabs=new Map(), closingTargets=new Map(), quarantinedTargets=new Map();
  if(owned) managedTabs.set('popup',{owner:'task',derivedFrom:'parent'});
  const context={pending,managedTabs,closingTargets,quarantinedTargets,destroyedTargets:new Map(),
    leases:new Map(),trackDerivedTaskTarget(){},activeTaskPageCount:()=>managedTabs.size,MAX_ACTIVE_TASK_PAGES:5,
    targetsBySession:new Map([['parent-session','parent']]),commandId:0,lastCdpTimeout:null,
    BUDGETS:{metadata:15},setTimeout,clearTimeout,Date,Math,Number,Promise,
    assertCdpMethodAllowed(){},positiveInteger:(v,d)=>Number(v)||d,methodTimeout:()=>15,
    deadlineAfter:()=>({remaining:()=>100}),isOpen:socket=>socket?.readyState===1,
    BrokerError:class extends Error {constructor(code,message,details,status){super(message);Object.assign(this,{code,details,status});}},
    isTargetGoneCdpError:()=>false,
    forgetDestroyedTargetState:target=>managedTabs.delete(target),
    assertTargetExists:async()=>({targetId:'popup'}),
    retireBrowserSocket(){retired++;context.browserSocket=null;for(const entry of [...pending.values()])entry.reject(new Error('shared connection retired'));},
  };
  context.browserSocket={readyState:1,send(raw){
    sent++; const message=JSON.parse(raw);
    if(message.method==='Runtime.callFunctionOn')setTimeout(()=>pending.get(message.id)?.resolve({ok:true}),35);
  }};
  vm.createContext(context);vm.runInContext(code,context);
  const unrelated=context.sendCdp('Runtime.callFunctionOn',{}, {sessionId:'parent-session',timeoutMs:100});
  const observedUnrelated=unrelated.then(value=>({value}),error=>({error}));
  if(owned) await assert.rejects(context.closeOverflowDerivedTarget('popup'),error=>error.code==='cdp_timeout');
  else await assert.rejects(context.sendCdp(method,{}, {targetId:'unknown',timeoutMs:15}),error=>error.code==='cdp_timeout');
  const other=await observedUnrelated;
  assert.equal(retired,owned?0:1);
  if(owned){
    assert.equal(other.value?.ok,true,'owned popup timeout must not cancel unrelated parent command');
    assert.equal(managedTabs.has('popup'),true,'unknown close remains accounted for');
    assert.equal(quarantinedTargets.get('popup')?.code,'unclaimed_derived_target');
    assert.equal(sent,2,'do not replay the unknown close');
    context.sendCdp=async nextMethod=>{
      assert.equal(nextMethod,'Target.getTargets','sweep must not replay an unknown close');
      return {targetInfos:[{targetId:'popup',type:'page',openerId:'parent'}]};
    };
    await assert.rejects(context.sweepUnclaimedDerivedTargets({remaining:()=>100}),error=>error.code==='derived_target_unresolved');
    assert.equal(managedTabs.has('popup'),true);
  } else assert.ok(other.error,'unscoped timeout still retires the generation');
}
await scenario('Target.closeTarget',true);
await scenario('Target.closeTarget',false);
await scenario('Target.attachToTarget',false);
await scenario('Target.getTargets',false);
console.log('PASS managed close timeout isolation, retained quarantine/capacity, no close replay, unscoped and attach generation safeguards');

// Exercises production functions in an isolated VM; never connects to Edge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.argv[2] || new URL('./cdp-proxy.mjs', import.meta.url), 'utf8');
function section(start, end) {
  const at = source.indexOf(start), until = source.indexOf(end, at);
  assert.ok(at >= 0 && until > at, `missing production section: ${start}`);
  return source.slice(at, until);
}
const code = section('function requireLease(', 'function requestLeaseToken(')
  + section('async function releaseTargetUnlocked(', 'async function closeManagedTargetUnlocked(')
  + section('async function recoverTargetUnlocked(', 'function routeBudget(')
  + section('function leaseExpired(', 'function invalidateTargetIdempotency(')
  + section('async function quarantineTimedOutTarget(', 'async function targetCommandUnlocked(')
  + section('function forgetDestroyedTargetState(', 'const BROKER_MARKER_URL')
  + section('async function pageTargets(', 'async function assertTargetExists(');
const functions = '{requireLease,releaseTargetUnlocked,recoverTargetUnlocked,cleanupExpiredLeases,quarantineTimedOutTarget,pageTargets}';
class BrokerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const quarantine = Object.freeze({code:'cdp_timeout',method:'Runtime.callFunctionOn',at:'synthetic'});
const deadline = {remaining:()=>15000};
function fixture() {
  const context = {
    BrokerError, Date, Set, Map,
    leases:new Map(), sessions:new Map(), quarantinedTargets:new Map([['page',quarantine]]),
    stalledTargets:new Set(), contextVersions:new Map(), targetQueues:new Map(),
    destroyedTargets:new Map(), managedTabs:new Map(), orphanCreationTargets:new Map(),
    browserSocket:{}, BUDGETS:{metadata:2000,dom:5000}, LEASE_TTL_MS:1000, IDEMPOTENCY_TTL_MS:60000,
    safeEqualToken:(a,b)=>a===b, isOpen:()=>true,
    deadlineAfter:()=>deadline, queueForTarget:async(id,d,fn)=>await fn(),
    detachSessionOrRetire:async()=>({status:'detached'}),
    clearSessionByTarget:id=>context.sessions.delete(id),
    invalidateTargetIdempotency:()=>{}, trackDerivedTaskTarget:()=>{}, reserveAuthenticOrphanTargets:()=>{},
    callFixedFunctionUnlocked:async()=>({result:{value:{ready:'complete'}}}),
    sendCdp:async()=>({targetInfos:[]}),
  };
  context.leases.set('page',{owner:'owner',token:'test-lease',lastUsedAt:Date.now()});
  return {context,api:vm.runInNewContext(code+'\n('+functions+')',context)};
}
const results=[];
async function test(name,fn) {try {await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.message});}}
await test('release/reacquire retains quarantine and rejects ordinary reads',async()=>{
  const {context:c,api:a}=fixture();
  await a.releaseTargetUnlocked('page','owner','test-lease',deadline);
  assert.equal(c.leases.size,0);
  assert.equal(c.quarantinedTargets.get('page'),quarantine);
  c.leases.set('page',{owner:'next-owner',token:'next-lease',lastUsedAt:Date.now()});
  assert.throws(()=>a.requireLease('page','next-owner','next-lease'),e=>e.code==='target_quarantined');
});
await test('expired lease retains page failure state',async()=>{
  const {context:c,api:a}=fixture(); c.leases.get('page').lastUsedAt=0;
  assert.equal(await a.cleanupExpiredLeases(deadline),1);
  assert.equal(c.leases.size,0); assert.equal(c.quarantinedTargets.get('page'),quarantine);
});
await test('active operation cannot be expired concurrently',async()=>{
  const {context:c,api:a}=fixture(); c.leases.get('page').lastUsedAt=0;c.targetQueues.set('page',{active:true});
  assert.equal(await a.cleanupExpiredLeases(deadline),0); assert.equal(c.leases.size,1);
  assert.equal(c.quarantinedTargets.get('page'),quarantine);
});
await test('successful explicit recovery clears quarantine',async()=>{
  const {context:c,api:a}=fixture();
  assert.equal((await a.recoverTargetUnlocked('page','owner','test-lease',deadline)).ready,'complete');
  assert.equal(c.quarantinedTargets.has('page'),false);
});
await test('failed explicit recovery preserves quarantine',async()=>{
  const {context:c,api:a}=fixture();c.callFixedFunctionUnlocked=async()=>{throw new BrokerError('cdp_timeout','still unresponsive');};
  await assert.rejects(a.recoverTargetUnlocked('page','owner','test-lease',deadline),e=>e.code==='cdp_timeout');
  assert.equal(c.quarantinedTargets.get('page'),quarantine);
});
await test('wrong capability cannot recover or release',async()=>{
  const {context:c,api:a}=fixture();
  await assert.rejects(a.recoverTargetUnlocked('page','owner','wrong',deadline),e=>e.code==='lease_conflict');
  await assert.rejects(a.releaseTargetUnlocked('page','owner','wrong',deadline),e=>e.code==='lease_conflict');
  assert.equal(c.quarantinedTargets.get('page'),quarantine);assert.equal(c.leases.size,1);
});
await test('late unleased cleanup cannot erase existing quarantine',async()=>{
  const {context:c,api:a}=fixture();c.leases.clear();
  await a.quarantineTimedOutTarget('page',null,new BrokerError('cdp_timeout','late'));
  assert.equal(c.quarantinedTargets.get('page'),quarantine);
});
await test('authoritative target disappearance cleans released quarantine',async()=>{
  const {context:c,api:a}=fixture();c.leases.clear();
  await a.pageTargets(deadline);assert.equal(c.quarantinedTargets.size,0);
});
await test('fixed Runtime request uses documented parameters and no remote timeout claim',async()=>{
  let sent;
  const c={BrokerError,BUDGETS:{dom:5000},ensureSession:async()=> 'session',
    fixedWorlds:{resolve:async()=>123},sendCdp:async(method,params,options)=>{sent={method,params,options};return{};},
    isSessionInvalidError:()=>false};
  const fn=vm.runInNewContext(section('async function callFixedFunctionUnlocked(', 'async function pageTargets(')+'\ncallFixedFunctionUnlocked',c);
  await fn('page','function(){return true}',[],{deadline});
  assert.equal(sent.method,'Runtime.callFunctionOn');assert.equal(sent.options.timeoutMs,5000);
  assert.deepEqual(Object.keys(sent.params).sort(),['arguments','awaitPromise','executionContextId','functionDeclaration','returnByValue','userGesture']);
});
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,total:results.length,results},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;

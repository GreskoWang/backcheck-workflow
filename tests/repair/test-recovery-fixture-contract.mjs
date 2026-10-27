#!/usr/bin/env node
// Checks the existing integration fixture's actual Runtime branch in a VM.
// No network, browser, production writes or complete integration-suite claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
function option(name){const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];}
const root=option('--repo');
if(!root){console.error('Usage: node test-recovery-fixture-contract.mjs --repo PATH [--out result.json]');process.exit(2);}
const dir=path.resolve(root,'skills/web-access/scripts');
const source=fs.readFileSync(path.join(dir,'cdp-proxy.mjs'),'utf8');
const fixtureSource=fs.readFileSync(path.join(dir,'cdp-proxy-integration-selftest.mjs'),'utf8');
function section(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a);assert.ok(a>=0&&b>a);return text.slice(a,b);}
let declaration;
const context={requireLease:()=>({epoch:1}),sessions:new Map(),quarantinedTargets:new Map(),BUDGETS:{dom:5000},
  callFixedFunctionUnlocked:async(_id,fn)=>{declaration=fn;return {result:{value:{title:'Fixture page',ready:'complete'}}};}};
const recover=vm.runInNewContext(section(source,'async function recoverTargetUnlocked(','function routeBudget(')+'\nrecoverTargetUnlocked',context);
await recover('page','owner','lease',{remaining:()=>5000});
const runtimeCase=section(fixtureSource,"      case 'Runtime.callFunctionOn':","      case 'Target.detachFromTarget':");
const TARGET_ID='fixture-page',TARGET_URL='https://example.test/fixture';
const fixtureContext={TARGET_URL,sleep:async()=>{},sessionTarget:()=>TARGET_ID,
  state:{targets:new Map([[TARGET_ID,{url:TARGET_URL}]]),runtimeCallCount:0,activeRuntimeCalls:0,maxActiveRuntimeCalls:0}};
const respond=vm.runInNewContext(`async function responseFor(declaration){let result;const message={method:'Runtime.callFunctionOn',params:{functionDeclaration:declaration},sessionId:'fixture-session'};switch(message.method){${runtimeCase}}return result;}\nresponseFor`,fixtureContext);
const cases=[];
async function test(name,fn){try{await fn();cases.push({name,passed:true});}catch(error){cases.push({name,passed:false,error:error.message});}}
const plain=value=>JSON.parse(JSON.stringify(value));
await test('actual_production_recovery_declaration_gets_complete_health',async()=>{
  assert.deepEqual(plain(await respond(declaration)),{result:{type:'object',value:{title:'Fake Page',ready:'complete'}}});
});
await test('ordinary_DOM_fixture_response_keeps_its_existing_shape',async()=>{
  assert.deepEqual(plain(await respond('function(){return document.title}')),
    {result:{type:'object',value:{title:'Fake Page',url:TARGET_URL,lang:'en',text:'public test content'}}});
});
await test('near_match_does_not_receive_synthetic_health',async()=>{
  const value=await respond(declaration+' ');
  assert.equal(Object.hasOwn(value.result.value,'ready'),false);
});
const report={suite:'U01 existing integration fixture health contract',runtime:process.version,networkUsed:false,liveBrowserUsed:false,
  productionSourceSha256:createHash('sha256').update(source).digest('hex'),fixtureSourceSha256:createHash('sha256').update(fixtureSource).digest('hex'),
  passed:cases.filter(x=>x.passed).length,total:cases.length,allPassed:cases.every(x=>x.passed),cases};
console.log(JSON.stringify(report,null,2));
if(option('--out')){const out=path.resolve(option('--out'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
if(!report.allPassed)process.exitCode=1;

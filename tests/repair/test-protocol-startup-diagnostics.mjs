#!/usr/bin/env node
// Offline harness tests. Synthetic loopback servers/child processes only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { errorRecord, makeTimeline, observeChild, settleWithin, waitForStage } from './protocol-startup-diagnostics.mjs';

function option(name) { const i=process.argv.indexOf(name); return i<0?null:process.argv[i+1]; }
const repo = option('--repo');
const tests = [];
async function test(name, check) {
  const started = performance.now();
  try { tests.push({name,passed:true,details:await check(),elapsedMs:Math.round(performance.now()-started)}); }
  catch (error) { tests.push({name,passed:false,error:errorRecord(error),elapsedMs:Math.round(performance.now()-started)}); }
}

await test('health request without response obeys the stage deadline and is aborted', async () => {
  const sockets = new Set();
  let requests = 0;
  const server = http.createServer(() => { requests += 1; }); // Deliberately never reply.
  server.on('connection', socket => { sockets.add(socket);socket.once('close',()=>sockets.delete(socket)); });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const timeline = makeTimeline();
  const start = performance.now();
  try {
    await assert.rejects(waitForStage(async ({signal}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/health`,{signal});
      return response.ok;
    },{timeoutMs:150,label:'nonresponsive_health',timeline}),error=>error.code==='HARNESS_STAGE_TIMEOUT');
    assert.ok(performance.now()-start<1500,'The awaited HTTP call escaped the stage deadline');
    assert.equal(requests,1,'The hung request must not trigger an overlapping request/retry');
    assert.equal(timeline.value.stages[0].status,'timeout');
    assert.equal(timeline.value.stages[0].attempts,1);
    return {requests,stage:timeline.value.stages[0]};
  } finally {
    for(const socket of sockets)socket.destroy();
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});

await test('both child pipes are drained and exit/close remain visible with bounded output', async () => {
  const timeline = makeTimeline();
  const source = [
    "process.stdout.write('O'.repeat(262144)+'STDOUT-END')",
    "process.stderr.write('E'.repeat(262144)+'STDERR-END')",
    "process.exitCode=17",
  ].join(';');
  const child = spawn(process.execPath,['-e',source],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const observed = observeChild(child,timeline,{maxOutputBytes:1024});
  try {
    const closed = await settleWithin(observed.close,5000);
    assert.equal(closed.settled,true,'Child output was not drained in time');
    const state = observed.snapshot();
    assert.equal(state.exit.code,17);
    assert.equal(state.close.code,17);
    assert.equal(state.stdoutEnded,true);
    assert.equal(state.stderrEnded,true);
    for(const name of ['stdout','stderr']) {
      assert.equal(state.outputBytes[name],262154);
      assert.equal(state.outputTruncated[name],true);
      assert.ok(Buffer.byteLength(state[name])<=1024);
      assert.ok(state[name].endsWith(`${name.toUpperCase()}-END`));
    }
    return {...state,stdout:'[bounded synthetic tail verified]',stderr:'[bounded synthetic tail verified]'};
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

await test('an exited broker produces a child-exit failure rather than a generic readiness timeout', async () => {
  const timeline = makeTimeline();
  const child = spawn(process.execPath,['-e',"process.stdout.write('EARLY-EXIT');process.stderr.write('synthetic startup failure');process.exitCode=23"],
    {stdio:['ignore','pipe','pipe'],windowsHide:true});
  const observed = observeChild(child,timeline);
  try {
    await assert.rejects(waitForStage(()=>{observed.assertAlive();return false;},
      {timeoutMs:2000,intervalMs:10,label:'child_startup',timeline}),error=>error.code==='HARNESS_CHILD_EXIT');
    await observed.close;
    assert.equal(timeline.value.stages[0].status,'failed');
    assert.equal(observed.snapshot().exit.code,23);
    assert.equal(observed.snapshot().stderr,'synthetic startup failure');
    return {stage:timeline.value.stages[0],child:observed.snapshot()};
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});

if (repo) await test('a forced startup failure writes first-failure evidence and never restarts the broker', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'protocol-diagnostics-test-'));
  const output = path.join(directory,'first-failure.json');
  const harness = path.join(path.dirname(fileURLToPath(import.meta.url)),'test-dom-abort-protocol.mjs');
  const child = spawn(process.execPath,[harness,'--repo',path.resolve(repo),'--out',output,
    '--startup-fixture-fault','wrong-browser-identity'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const observed = observeChild(child,makeTimeline());
  try {
    // Two bounded Windows secure-startup phases, the unchanged connection
    // deadline and process/pipe cleanup must all fit in the outer budget.
    const closed = await settleWithin(observed.close,90000);
    assert.equal(closed.settled,true,'Negative integration fixture exceeded its outer diagnostic deadline');
    assert.equal(child.exitCode,1,observed.stderr.join(''));
    const result = JSON.parse(fs.readFileSync(output,'utf8'));
    assert.equal(result.passed,false);
    const diagnostic = result.diagnostics;
    assert.equal(diagnostic.automaticRetries,0);
    assert.equal(diagnostic.brokerSpawnCount,1);
    assert.equal(diagnostic.budgets.tokenMs,30000);
    assert.equal(diagnostic.budgets.connectedMs,8000);
    assert.equal(diagnostic.failure.code,'HARNESS_STAGE_TIMEOUT');
    assert.equal(diagnostic.failure.classification,'broker_connection_error_reported');
    assert.equal(diagnostic.firstFailureSnapshot.phase,'broker_connected');
    assert.equal(diagnostic.firstFailureSnapshot.fakeCdp.websocketConnectionCount,1);
    assert.equal(diagnostic.firstFailureSnapshot.fakeCdp.methodCounts['Browser.getVersion'],1);
    assert.equal(diagnostic.firstFailureSnapshot.fakeCdp.methodCounts['Target.setDiscoverTargets']||0,0);
    assert.equal(diagnostic.firstFailureSnapshot.lastHealth.connection.lastErrorCode,'wrong_browser_identity');
    assert.equal(diagnostic.firstFailureSnapshot.child.exit,null,'Failure snapshot must precede cleanup exit');
    assert.equal(diagnostic.firstFailureSnapshot.child.listeningObserved,true);
    assert.ok(diagnostic.firstFailureSnapshot.fakeCdp.boundAddress.port>0);
    assert.ok(diagnostic.firstFailureSnapshot.brokerRequestedAddress.port>0);
    assert.ok(diagnostic.firstFailureSnapshot.child.stderr.includes('wrong_browser_identity'));
    assert.equal(diagnostic.finalSnapshot.child.close.code,0);
    assert.equal(diagnostic.finalSnapshot.child.stdoutEnded,true);
    assert.equal(diagnostic.finalSnapshot.child.stderrEnded,true);
    return {expectedFailure:true,record:result};
  } finally {
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

const result={suite:'protocol-startup-diagnostics',runtime:process.version,platform:process.platform,
  realBrowserUsed:false,externalAccountsUsed:false,repo:repo?path.resolve(repo):null,
  tests:tests.length,passed:tests.filter(item=>item.passed).length,results:tests};
const output=JSON.stringify(result,null,2)+'\n';
if(option('--out')){const dest=path.resolve(option('--out'));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,output);}
console.log(output.trimEnd());
if(result.passed!==result.tests)process.exitCode=1;

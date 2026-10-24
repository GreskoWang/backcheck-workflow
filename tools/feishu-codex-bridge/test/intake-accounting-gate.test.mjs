import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAccountingConfirmed} from '../src/intake-accounting-gate.mjs';
import {runBackgroundCheck} from '../src/codex-runner.mjs';

test('unresolved or disabled accounting never passes the intake boundary',()=>{
  for(const accountingStatus of [undefined,'disabled','partial','blocked']) {
    assert.throws(()=>assertAccountingConfirmed({accountingStatus}),{code:'ACCOUNTING_INTAKE_BLOCKED'});
  }
  assert.doesNotThrow(()=>assertAccountingConfirmed({accountingStatus:'recorded'}));
});

test('an unattributed sheet match aborts intake before the dispatcher or receipt runs',async()=>{
  const job={requestId:'RQ-CUTOVER-DUPLICATE',requestText:'【背调需求10.17】\nTS\n1、已记账测试对象',
    dispatchScope:{decision:'execute',requestMode:'team_dispatch',assignments:[{code:'TS',itemNumbers:['1'],subject:'已记账测试对象',anchors:[],sourceBlock:'第1个【背调需求10.17】块'}],receiptAssignments:[{code:'TS',itemNumbers:['1'],subject:'已记账测试对象',sourceBlock:'第1个【背调需求10.17】块'}],ambiguousItems:[],deadline:'',reason:'isolated regression'}};
  let receipts=0,dispatches=0;
  await assert.rejects(()=>runBackgroundCheck(job,{codexDispatchMode:'desktop_native_handoff_v1'}, {
    onScopeResolved(){assertAccountingConfirmed({accountingStatus:'partial',accountingBlocked:[{reason:'existing_subject_unattributed'}]});receipts++;},
    desktopDispatcher:{dispatch(){dispatches++;throw new Error('must not run');}},
    onThreadBootstrapped(){},onResearchStarted(){},
  }),{code:'ACCOUNTING_INTAKE_BLOCKED'});
  assert.equal(receipts,0);assert.equal(dispatches,0);
});

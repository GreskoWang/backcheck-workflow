import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {commitResearchHandoff} from '../src/research-handoff.mjs';

test('a session reached through a directory junction matches its real path, but a different file does not', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-junction-test-'));
  const actual=path.join(root,'actual');
  const alias=path.join(root,'alias');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual,alias,process.platform==='win32'?'junction':'dir');
  fs.writeFileSync(path.join(actual,'session.jsonl'),'{}\n');
  fs.writeFileSync(path.join(actual,'other.jsonl'),'{}\n');
  const requestId='RQ-JUNCTION-TEST';
  const threadId='00000000-934e-7000-8000-a871fd3740a6';
  let job={requestId,status:'running',stage:'handoff_verifying',codexThreadCreationMode:'desktop_native_handoff_v1',codexThreadId:threadId,codexThreadRequestId:requestId,codexNativeSessionPath:path.join(alias,'session.jsonl')};
  let writes=0;
  const store={getJob:()=>job,updateJob:(_id,patch)=>{writes++;job={...job,...patch};return job;}};
  const evidence={threadId,sessionPath:path.join(actual,'session.jsonl'),researchTool:'web',callId:'call_junction_verified',callRecordIndex:3,outputRecordIndex:4,runtime:{approvalPolicy:'on-request',sandboxType:'workspace-write'}};
  try{
    assert.throws(()=>commitResearchHandoff(store,requestId,{...evidence,sessionPath:path.join(actual,'other.jsonl')}),/identity, evidence, or stage changed/);
    assert.equal(writes,0);
    assert.equal(commitResearchHandoff(store,requestId,evidence).status,'handed_off');
    assert.equal(writes,1);
    assert.throws(()=>commitResearchHandoff(store,requestId,evidence),/identity, evidence, or stage changed/);
    assert.equal(writes,1);
  }finally{
    const permitted=path.resolve(os.tmpdir())+path.sep;
    if(!path.resolve(root).startsWith(permitted))throw new Error('Test cleanup escaped its temp directory');
    fs.rmSync(root,{recursive:true,force:true});
  }
});

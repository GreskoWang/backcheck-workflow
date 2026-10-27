// Offline regression cases. No browser, network listener, credentials or live state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const repoIndex = process.argv.indexOf('--repo');
if (repoIndex < 0 || !process.argv[repoIndex + 1]) throw new Error('Usage: node test_workflow_collector.mjs --repo ROOT');
const root = path.resolve(process.argv[repoIndex + 1]);
const {mergeItem, collectBatch} = await import(pathToFileURL(path.join(root, 'skills/web-access/scripts/research-batch-runtime.mjs')));
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({name, passed:true}); }
  catch (error) { results.push({name, passed:false, error:String(error.message)}); }
}
const full = () => ({source_id:'p1',post_url:'https://example.com/p1',account:'author',date:'2026-10-27',text:'A complete source text with its verified ending.',quoted_text:'',text_truncated:false,needs_expansion:false,media:[],media_count:0,warnings:[]});
const collapsed = () => ({...full(),text:'A complete source...',text_truncated:true,needs_expansion:true});
await check('complete_main_text_empty_quote_survives_collapsed_reread', () => {
  const merged=mergeItem(full(),collapsed());
  assert.equal(merged.text,full().text);
  assert.equal(merged.text_truncated,false);
  assert.equal(merged.needs_expansion,false);
});
await check('expanded_observation_resolves_old_collapsed_text', () => {
  const merged=mergeItem(collapsed(),full());
  assert.equal(merged.text,full().text);
  assert.equal(merged.text_truncated,false);
  assert.equal(merged.needs_expansion,false);
});
await check('nonempty_truncated_quote_stays_unresolved', () => {
  const previous={...full(),quoted_text:'The long quote is still incomplete...',text_truncated:true,needs_expansion:true};
  const merged=mergeItem(previous,{...full(),text:full().text+' More main text.',quoted_text:'Short quote'});
  assert.equal(merged.quoted_text,previous.quoted_text);
  assert.equal(merged.text_truncated,true);
  assert.equal(merged.needs_expansion,true);
});
await check('different_source_url_remains_a_conflict', () => {
  const merged=mergeItem(full(),{...full(),post_url:'https://example.com/other'});
  assert.ok(merged.warnings.includes('source_identity_conflict'));
  assert.equal(merged.needs_expansion,true);
});

async function fixture(fn) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'backcheck-workflow-test-'));
  try {
    const state={id:'offline-collector',recipe:'generic-posts',target_url:'https://example.com/user',storage_mode:'single_snapshot_v2',max_seconds:5,max_steps:100,interval_ms:0,plateau_steps:2,compatibility:false,starting_position:'current_page',iterations:0,recovery_used:1};
    const raw=(text=full().text,warnings=[])=>({items:[{source_id:'p1',post_url:full().post_url,stable_deduplication:true,own_visible_text:text,repost:[],media:{items:[],declared_count:0},truncation:{},expansion:{},warnings}],page_state:{url:state.target_url,route_matches_recipe:true,loading:false,explicit_end_hints:[],verification_hints:[],login_hints:[],extraction_truncated:false}});
    const run=(snapshot,recover)=>collectBatch({state,directory,snapshot,advance:async()=>{},recover,cancelled:()=>false,wait:async()=>{}});
    await fn({directory,state,raw,run});
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
await check('same_stall_across_resume_cannot_gain_another_recovery',()=>fixture(async ({state,raw,run})=>{
  let recoveries=0;
  await run(async()=>raw(),async()=>{recoveries++;});
  assert.equal(recoveries,1);
  await run(async()=>raw(),async()=>{recoveries++;});
  assert.equal(recoveries,1);
  assert.equal(state.stall_recovery_count,1);
  assert.equal(state.recovery_used,1,'Unrelated outer recovery counter must be preserved');
}));
await check('substantive_new_content_opens_one_new_stall_cycle',()=>fixture(async ({state,raw,run})=>{
  let recoveries=0;
  await run(async()=>raw(),async()=>{recoveries++;});
  await run(async()=>raw(full().text+' New source content.'),async()=>{recoveries++;});
  assert.equal(recoveries,2);
  await run(async()=>raw(full().text+' New source content.'),async()=>{recoveries++;});
  assert.equal(recoveries,2);
  assert.equal(state.stall_recovery_count,2);
}));
await check('failed_recovery_is_persisted_before_action',()=>fixture(async ({state,raw,run})=>{
  let recoveries=0;
  await run(async()=>raw(),async()=>{recoveries++;throw new Error('offline failure');});
  await run(async()=>raw(),async()=>{recoveries++;});
  assert.equal(recoveries,1);
  assert.equal(state.stall_recovery_count,1);
}));
await check('legacy_terminal_stall_does_not_reset_budget',()=>fixture(async ({state,raw,run})=>{
  let recoveries=0;
  await run(async()=>raw(),async()=>{recoveries++;});
  delete state.stall_recovery_attempted;
  delete state.stall_recovery_count;
  assert.equal(state.stop_reason,'stall');
  await run(async()=>raw(),async()=>{recoveries++;});
  assert.equal(recoveries,1);
}));
await check('warning_only_changes_are_not_content_progress',()=>fixture(async ({raw,run})=>{
  let observations=0,recoveries=0;
  const result=await run(async()=>raw(full().text,['observation_note_'+(++observations)]),async()=>{recoveries++;});
  assert.equal(result.coverage.stop_reason,'stall');
  assert.equal(recoveries,1);
  assert.ok(observations<20);
}));
await check('interrupted_new_content_checkpoint_preserves_explicit_unused_cycle',()=>fixture(async ({directory,state,raw,run})=>{
  let recoveries=0,capturedState,capturedResult;
  await run(async()=>raw(),async()=>{recoveries++;});
  const freshText=full().text+' Newly observed source content.';
  await collectBatch({state,directory,snapshot:async()=>raw(freshText),recover:async()=>{recoveries++;},cancelled:()=>false,wait:async()=>{},advance:async()=>{
    capturedState=JSON.parse(fs.readFileSync(path.join(directory,'job.json'),'utf8'));
    capturedResult=fs.readFileSync(path.join(directory,'result.json'));
    throw new Error('offline interruption after persisted progress');
  }});
  assert.equal(capturedState.state,'running');
  assert.equal(capturedState.stop_reason,'stall');
  assert.equal(capturedState.stall_recovery_attempted,false);
  // Restore the actual on-disk bytes captured before the simulated interruption.
  fs.writeFileSync(path.join(directory,'job.json'),JSON.stringify(capturedState));
  fs.writeFileSync(path.join(directory,'result.json'),capturedResult);
  for(const key of Object.keys(state)) delete state[key];
  Object.assign(state,capturedState);
  await run(async()=>raw(freshText),async()=>{recoveries++;});
  assert.equal(recoveries,2,'Explicit unused new cycle must survive stale legacy stop_reason');
  assert.equal(state.stall_recovery_count,2);
}));
await check('malformed_recovery_checkpoint_fails_before_browser_operation',()=>fixture(async ({state,raw,run})=>{
  state.stall_recovery_attempted='false';
  let operations=0;
  await assert.rejects(()=>run(async()=>{operations++;return raw();},async()=>{operations++;}),/Invalid stall recovery checkpoint/);
  assert.equal(operations,0);
}));
const failed=results.filter(item=>!item.passed).length;
console.log(JSON.stringify({suite:'workflow-collector',repo:root,tests:results.length,passed:results.length-failed,failed,results},null,2));
process.exitCode=failed?1:0;

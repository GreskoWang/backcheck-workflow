#!/usr/bin/env node
// Actual PowerShell session and request wrappers against a synthetic HTTP server.
// Requires PowerShell 7; absence is BLOCKED, never PASS. No real browser/account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const opt=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
if(!opt('--repo'))throw new Error('--repo is required');
const script=path.resolve(opt('--repo'),'skills/web-access/scripts/cdp-session.ps1');
const pwsh=opt('--pwsh')||'pwsh',cases=[];
function output(report){if(opt('--out')){const p=path.resolve(opt('--out'));fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report,null,2));}
const availability=spawnSync(pwsh,['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()'],{encoding:'utf8',timeout:15000,windowsHide:true});
if(availability.error||availability.status!==0){output({suite:'U07 real PowerShell error-envelope protocol',status:'BLOCKED',reason:'powershell_unavailable',platform:process.platform,testsExecuted:0,powerShellExecuted:false});process.exit(2);}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'backcheck-u07-session-'));
const token='b'.repeat(48),lease='synthetic-lease-'+ 'l'.repeat(40),manage='synthetic-manage-'+ 'm'.repeat(40),cookie='cookie-fixture-private';
let mode='',requests=[],created=new Map(),opened=0,finalized=0;
const sockets=new Set();
const server=http.createServer(async(req,res)=>{
  const parts=[];for await(const chunk of req)parts.push(chunk);
  const route=new URL(req.url,'http://127.0.0.1').pathname;
  const key=req.headers['x-cdp-request-id'];requests.push({route,key,url:req.url,body:Buffer.concat(parts).toString('utf8')});
  const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  if(req.headers.authorization!==`Bearer ${token}`)return send({error:{code:'unauthorized'}},401);
  const error=(code,unknown=true,extra={})=>({error:{code,details:{outcomeUnknown:unknown,method:'Target.createTarget',phase:'metadata',budgetMs:2000,timeoutMs:2000,elapsedMs:2001,quarantined:true,connectionRetired:false,leaseToken:lease,manageToken:manage,requestId:key,authorization:`Bearer ${token}`,cookie,...extra}}});
  if(route==='/new'||route==='/acquire'){
    const count=requests.filter(x=>x.route===route).length;
    if(mode==='permission-refused')return send(error('unauthorized',true),401);
    if(mode==='known-failure')return send(error('task_page_limit_reached',false),409);
    if(!created.has(key)){if(route==='/new')opened++;created.set(key,{ready:true,targetId:route==='/new'?'created-target':'existing-target',leaseToken:lease,...(route==='/new'?{manageToken:manage}:{})});}
    if(mode==='unknown-twice')return send(error('cdp_timeout'),504);
    if(mode==='unknown-then-denied')return send(error(count===1?'cdp_timeout':'unauthorized',count===1),count===1?504:401);
    if(mode==='string-unknown')return send(error('cdp_timeout','true'),504);
    if(count===1&&mode.startsWith('startup-')){
      const code=mode.slice('startup-'.length);const body=error(code);
      if(code==='outcome_unknown')delete body.error.details.outcomeUnknown;
      return send(body,504);
    }
    if(count===1&&mode==='resume-unknown')return send(error('request_timeout'),504);
    return send(created.get(key));
  }
  if(req.headers['x-cdp-lease']!==lease)return send({error:{code:'lease_conflict'}},409);
  if(route==='/finalize'){finalized++;return send({closed:true});}
  if(route==='/release')return send({released:true,closed:false});
  if(route==='/info')return send({page:{url:'https://example.test/u07',readyState:'complete'}});
  if(['/click','/screenshot','/recover'].includes(route)){
    const details=mode==='diagnostics-malformed'?{outcomeUnknown:'true',method:'Token.private',phase:cookie,budgetMs:'2000',timeoutMs:-1,elapsedMs:4e10,quarantined:'true'}:{};
    return send(error('cdp_timeout',true,{method:route==='/screenshot'?'Page.captureScreenshot':'Runtime.callFunctionOn',...details}),504);
  }
  return send({error:{code:'unexpected_fixture_route'}},404);
});
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
let port;
async function run(nextMode,{resume=false,commands=[{action:'info'},{action:'finish'}]}={}){
  mode=nextMode;requests=[];created=new Map();opened=0;finalized=0;
  const env={...process.env};for(const key of Object.keys(env))if(/^(CDP_|FEISHU_|LARK_)/i.test(key)||/^(http_proxy|https_proxy|all_proxy)$/i.test(key))delete env[key];
  Object.assign(env,{CDP_PROXY_TOKEN_DIR:temp,NO_PROXY:'127.0.0.1,localhost,::1',no_proxy:'127.0.0.1,localhost,::1'});
  const args=['-NoProfile','-NonInteractive','-File',script,...(resume?['-ExistingTarget','existing-target','-ExpectedUrl','https://example.test/u07','-RecoveryAttemptsUsed','0']:['-InitialUrl','https://example.test/u07']),'-Owner','fixture-u07','-Port',String(port),'-RequestTimeoutMilliseconds','10000'];
  const child=spawn(pwsh,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',x=>{stdout+=x;});child.stderr.setEncoding('utf8').on('data',x=>{stderr+=x;});
  child.stdin.on('error',()=>{});child.stdin.end(commands.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const timer=setTimeout(()=>child.kill(),60000);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timer));
  assert.equal(result.signal,null,'session exceeded its fixture budget');
  for(const secret of [token,lease,manage,cookie,...requests.map(x=>x.key).filter(Boolean)])assert.equal((stdout+stderr).includes(secret),false,'private diagnostic leaked');
  return {...result,stdout,stderr,lines:stdout.split(/\r?\n/).filter(x=>x.trim()).map(x=>JSON.parse(x))};
}
async function test(name,fn){try{await fn();cases.push({name,passed:true});}catch(e){cases.push({name,passed:false,error:e.message,code:e.code||null});}}
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});port=server.address().port;fs.writeFileSync(path.join(temp,`${port}.token`),token);
  for(const code of ['cdp_timeout','request_timeout','request_aborted','outcome_unknown'])await test(`startup_${code}_uses_one_identical_key_recovery`,async()=>{
    const r=await run('startup-'+code);assert.equal(r.code,0,r.stderr);assert.equal(opened,1);assert.equal(finalized,1);
    const creates=requests.filter(x=>x.route==='/new');assert.equal(creates.length,2);assert.equal(creates[0].key,creates[1].key);assert.equal(creates[0].url,creates[1].url);
  });
  await test('resume_unknown_acquire_reuses_key_without_creating_or_closing_page',async()=>{
    const r=await run('resume-unknown',{resume:true});assert.equal(r.code,0,r.stderr);assert.equal(opened,0);assert.equal(finalized,0);
    const acquire=requests.filter(x=>x.route==='/acquire');assert.equal(acquire.length,2);assert.equal(acquire[0].key,acquire[1].key);
    assert.equal(requests.filter(x=>x.route==='/release').length,1);
  });
  for(const mode of ['known-failure','permission-refused','string-unknown'])await test(`${mode}_does_not_retry`,async()=>{
    const r=await run(mode);assert.equal(r.code,1);assert.equal(requests.filter(x=>x.route==='/new').length,1);assert.equal(finalized,0);
    const error=r.lines.find(x=>x.type==='startup_error');assert.equal(error.creationUnknown,mode==='permission-refused');
  });
  await test('two_unknown_results_stop_with_uncertain_creation_and_cleanup',async()=>{
    const r=await run('unknown-twice');assert.equal(r.code,1);assert.equal(opened,1);assert.equal(finalized,0);assert.equal(requests.filter(x=>x.route==='/new').length,2);
    assert.equal(r.lines.find(x=>x.type==='startup_error').requestCorrelationId,createHash('sha256').update(requests[0].key).digest('hex'));
    assert.equal(r.lines.find(x=>x.type==='startup_error').creationUnknown,true);assert.equal(r.lines.find(x=>x.type==='startup_error').created,null);assert.equal(r.lines.at(-1).reason,'creation_unconfirmed');assert.equal(r.lines.at(-1).requestCorrelationId,r.lines.find(x=>x.type==='startup_error').requestCorrelationId);
  });
  await test('later_permission_refusal_does_not_erase_prior_creation_uncertainty',async()=>{
    const r=await run('unknown-then-denied');assert.equal(r.code,1);assert.equal(requests.filter(x=>x.route==='/new').length,2);
    const e=r.lines.find(x=>x.type==='startup_error');assert.equal(e.creationUnknown,true);assert.equal(e.created,null);assert.equal(e.error.causeCode,'unauthorized');assert.equal(finalized,0);
  });
  await test('ordinary_click_exposes_safe_diagnostics_without_replay',async()=>{
    const r=await run('diagnostics',{commands:[{action:'click',body:{selector:'button'}},{action:'finish'}]});assert.equal(r.code,0,r.stderr);
    const e=r.lines.find(x=>x.action==='click');assert.equal(e.outcomeUnknown,true);assert.equal(requests.filter(x=>x.route==='/click').length,1);
    assert.deepEqual(e.error.details,{outcomeUnknown:true,method:'Runtime.callFunctionOn',phase:'metadata',budgetMs:2000,timeoutMs:2000,elapsedMs:2001,quarantined:true,connectionRetired:false});
  });
  await test('malformed_diagnostics_are_not_coerced_or_forwarded',async()=>{
    const r=await run('diagnostics-malformed',{commands:[{action:'click',body:{selector:'button'}},{action:'finish'}]});assert.equal(r.code,0,r.stderr);
    const e=r.lines.find(x=>x.action==='click');assert.equal(e.outcomeUnknown,false);assert.deepEqual(e.error.details,{connectionRetired:false});
  });
  await test('screenshot_unknown_does_not_replay_or_replace_existing_file',async()=>{
    const file=path.join(temp,'existing.jpg'),original=Buffer.from([255,216,255,217]);fs.writeFileSync(file,original);
    const r=await run('diagnostics',{commands:[{action:'shot',path:file},{action:'finish'}]});assert.equal(r.code,0,r.stderr);assert.equal(r.lines.find(x=>x.action==='shot').outcomeUnknown,true);
    assert.equal(requests.filter(x=>x.route==='/screenshot').length,1);assert.deepEqual(fs.readFileSync(file),original);
  });
  await test('unknown_recovery_still_consumes_the_single_recovery_budget',async()=>{
    const r=await run('diagnostics',{resume:true,commands:[{action:'recover'},{action:'recover'},{action:'finish'}]});assert.equal(r.code,0,r.stderr);
    assert.equal(requests.filter(x=>x.route==='/recover').length,1);assert.equal(r.lines.filter(x=>x.action==='recover')[1].error.code,'recovery_budget_exhausted');assert.equal(r.lines.at(-1).recoveryAttemptsUsed,1);
  });
}catch(e){cases.push({name:'fixture_startup_or_cleanup',passed:false,error:e.message,code:e.code||null});}
finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
const report={suite:'U07 real PowerShell error-envelope protocol',status:cases.every(x=>x.passed)?'PASS':'FAIL',platform:process.platform,runtime:process.version,powerShell:availability.stdout.trim(),powerShellExecuted:true,sourceSha256:createHash('sha256').update(fs.readFileSync(script)).digest('hex'),liveBrowserUsed:false,externalAccountsUsed:false,passed:cases.filter(x=>x.passed).length,total:cases.length,cases};
output(report);if(report.status!=='PASS')process.exitCode=1;

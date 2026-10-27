import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { prepareSpecialIncoming } from '../src/special-preflight.mjs';
import { reviewSpecialArtifacts, readSpecialLocalArtifact, readSpecialRemoteArtifact,
  specialArtifactSourceDigest, specialArtifactManifestExample, assertSpecialArtifactReview,
  validateLatestSpecialArtifact, SPECIAL_ARTIFACT_REVIEW_SCHEMA } from '../src/special-artifacts.mjs';

const python = process.env.FEISHU_REVIEW_PYTHON || path.join(os.homedir(), '.cache', 'codex-runtimes',
  'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const chatId = 'oc_19936593f3ad5a63b1e86ee0f8c44fc8';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=', 'base64');
const dataRows = [['Subject','Seconds','Source'],['Game A',30,'https://example.com/video'],['Game A',45,'https://example.com/video'],['Total',75,'']];

async function fixture(t, { format = 'csv', total = 75, formula = '=SUM(B2:B3)' } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.BRIDGE_TEST_TMP || os.tmpdir(),'special-artifacts-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stateDir = path.join(root,'state'); fs.mkdirSync(stateDir);
  const policy = {chatId,role:'special_dispatch',enabled:true,activationFromMs:1000,researchEnabled:true,
    authorizationRef:'user-route',defaultOwner:{id:'wangshukun',name:'王书鲲',authorizationRef:'user-owner'}};
  const extraction={decision:'ready',requestType:'public_video_research',subjects:['Game A'],
    requirements:{objective:'Read the requested public videos and account for all durations',deliverables:['Video evidence table','Total duration'],
      sourceUrls:['https://example.com/video'],timeframe:'specified video',constraints:['every listed video'],reviewNeeds:['source/timecode correspondence']},
    unreadableImageIndexes:[],ambiguities:[],publicSourcesOnly:true};
  const prepared=await prepareSpecialIncoming({message:{chatId,messageId:'om_special_artifact',createTime:2000,content:'【特殊背调】',
    resources:[{type:'image',fileKey:'image_original'}]},groupPolicy:policy,stateDir,
    client:{im:{v1:{messageResource:{get:async()=>({getReadableStream:()=>Readable.from([png])})}}}},
    createCodex:()=>({startThread:()=>({run:async()=>({finalResponse:JSON.stringify(extraction),items:[]})})}),preflightModel:'fixture-extraction'});
  assert.equal(prepared.status,'ready');
  const job={requestId:'RQ-SPECIAL-ARTIFACT',workflowKind:'special_research',chatId,sourceMessageId:'om_special_artifact',
    sourceMessageCreatedAtMs:2000,specialIntake:prepared.specialIntake,specialOwnership:prepared.specialOwnership,
    codexThreadId:'research-thread',codexThreadRequestId:'RQ-SPECIAL-ARTIFACT'};
  const config={workspace:root,stateDir,groupPolicies:[policy],specialArtifactReview:{enabled:true,model:'fixture-review',python,
    allowedHostnames:['my.feishu.cn']}};
  const artifactPath=path.join(root,`output.${format}`), notePath=path.join(root,'research-notes.md');
  fs.writeFileSync(notePath,'Public video https://example.com/video : first section 00:00 to 00:30, second section 00:30 to 01:15. Total 75 seconds.');
  if(format==='csv') fs.writeFileSync(artifactPath,`Subject,Seconds,Source\nGame A,30,https://example.com/video\nGame A,45,https://example.com/video\nTotal,${total},\n`);
  else {
    const result=spawnSync(python,['-c',`import sys,json\nfrom openpyxl import Workbook\nfrom openpyxl.styles import Font,PatternFill\nb=Workbook();s=b.active;s.title='Data'\nfor row in json.loads(sys.argv[2]):s.append(row)\ns['B4']=sys.argv[3]\ns.column_dimensions['A'].width=20;s.column_dimensions['B'].width=15;s.column_dimensions['C'].width=36\nfor c in s[1]:c.font=Font(bold=True,color='FFFFFF');c.fill=PatternFill('solid',fgColor='245A81')\nb.save(sys.argv[1])`,artifactPath,JSON.stringify(dataRows),formula],
      {encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    assert.equal(result.status,0,result.stderr);
  }
  const manifest={schemaVersion:1,requestId:job.requestId,sourceChatId:job.chatId,sourceMessageId:job.sourceMessageId,
    sourceDigest:specialArtifactSourceDigest(job),artifacts:[{id:'A1',artifactType:format,localPath:artifactPath,
      assignments:prepared.scope.assignments,sourceFiles:[notePath]}]};
  const manifestPath=path.join(root,'review-manifest.json');
  const save=()=>fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)); save();
  const calls={starts:[],inputs:[],models:0};
  let customize = review=>review, onReview=()=>{};
  const createCodex=options=>{
    assert.ok(options.configOverrides.includes('mcp_servers={}'));
    return {startThread:options=>{
      calls.starts.push(options);
      return {id:'fixture-artifact-review-thread',run:async(input,options)=>{
        calls.models++;calls.inputs.push(input);assert.equal(options.outputSchema,SPECIAL_ARTIFACT_REVIEW_SCHEMA);
        const text=input[0].text,context=JSON.parse(text.slice(text.indexOf('材料：')+3));
        const artifact=context.artifacts[0],sheet=artifact.snapshot.worksheets?.[0];
        const location=range=>({artifactId:'A1',sheet:sheet?.id||'',range:sheet?range:'',blockId:sheet?'':'b1'});
        const sourceIds=[...context.sources.map(source=>source.id),...context.references.map(source=>source.id)];
        const review={verdict:'PASS',coverage:context.assignments.flatMap(assignment=>context.requirements.deliverables.map(deliverable=>({
          artifactId:'A1',deliverableId:deliverable.id,assignmentKey:assignment.assignmentKey,verdict:'PASS',
          locations:[location('A1:C4')],sourceRefs:sourceIds,reason:'Exact observed source, subject and deliverable locations verified.'}))),
          calculations:sheet?[{operation:'sum',inputs:[location('B2:B3')],output:location('B4'),multiplier:1,reason:'Recompute total duration from observations.'}]:[],
          calculationCompleteness:sheet?'all_claimed_aggregates_covered':'no_aggregates',
          visualChecks:context.images.map(image=>({imageId:image.id,verdict:'PASS',reason:'Fixture visual response; no live model invoked.'})),
          reviewedArtifactIds:context.artifacts.map(a=>a.artifactId),reviewedSourceIds:sourceIds,issues:[],summary:'Fixture structured review.'};
        onReview();
        return {items:[],finalResponse:JSON.stringify(customize(review,context))};
      }};
    }};
  };
  return {root,stateDir,job,config,manifest,manifestPath,artifactPath,notePath,save,calls,
    customize:fn=>{customize=fn},onReview:fn=>{onReview=fn},args:{job,manifestPath,config,createCodex}};
}

test('CSV review executes the real reader and binds every deliverable, calculations, source and original image',async t=>{
  const f=await fixture(t);const result=await reviewSpecialArtifacts(f.args);
  assert.equal(result.verdict,'PASS',JSON.stringify(result.issues));
  assert.equal(f.calls.models,1);assert.equal(f.calls.starts[0].sandboxMode,'read-only');
  assert.equal(f.calls.starts[0].networkAccessEnabled,false);assert.equal(f.calls.starts[0].webSearchMode,'disabled');
  assert.equal(f.calls.inputs[0].filter(item=>item.type==='local_image').length,1);
  assert.equal(result.materials[0].kind,'local_csv');assert.equal(result.materials[0].revisionId,undefined);
  assert.equal(result.receipts[0].kind,'special_artifact_review_v1');assert.equal(result.deterministic.calculations[0].expected,75);
  assert.equal(assertSpecialArtifactReview(result,f.job),true);
  assert.equal(await validateLatestSpecialArtifact(result.materials[0],{config:f.config}),true);
});

test('XLSX path runs actual Python formula evaluation and an actual supported workbook renderer',async t=>{
  const f=await fixture(t,{format:'xlsx'});const before=fs.readFileSync(f.artifactPath);
  const read=await readSpecialLocalArtifact({artifact:f.manifest.artifacts[0],config:f.config});
  const formula=read.snapshot.worksheets[0].cells.find(cell=>cell.address==='B4');
  assert.equal(formula.value,75);assert.equal(formula.calculated,true);assert.deepEqual(read.snapshot.issues,[]);
  const result=await reviewSpecialArtifacts(f.args);
  assert.equal(result.verdict,'PASS',JSON.stringify(result.issues));
  assert.ok(f.calls.inputs[0].filter(item=>item.type==='local_image').length>=2);
  assert.ok(result.deterministic.renderedViews.every(view=>['artifact-tool','openpyxl-pillow-supported-cell-layout'].includes(view.engine)));
  assert.equal(result.materials[0].kind,'local_xlsx');assert.deepEqual(fs.readFileSync(f.artifactPath),before);
});

test('fallback renderer reads actual Chinese headers and style into a PNG without editing workbook bytes',async t=>{
  const f=await fixture(t,{format:'xlsx'});
  const change=spawnSync(python,['-c',"import sys,openpyxl;b=openpyxl.load_workbook(sys.argv[1]);s=b.active;s['A1']='游戏';b.save(sys.argv[1])",f.artifactPath],{encoding:'utf8',windowsHide:true});
  assert.equal(change.status,0,change.stderr);
  const before=fs.readFileSync(f.artifactPath),requestPath=path.join(f.root,'render-request.json');
  fs.writeFileSync(requestPath,JSON.stringify({ranges:[{sheetName:'Data',range:'A1:C4'}]}));
  const output=spawnSync(python,['scripts/render-special-workbook.py',f.artifactPath,requestPath,path.join(f.root,'renders')],{encoding:'utf8',windowsHide:true});
  assert.equal(output.status,0,output.stdout||output.stderr);
  const render=JSON.parse(output.stdout).renders[0],bytes=fs.readFileSync(render.path);
  assert.equal(render.engine,'openpyxl-pillow-supported-cell-layout');
  assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.ok(bytes.readUInt32BE(16)>500);
  assert.deepEqual(fs.readFileSync(f.artifactPath),before);
});

test('fallback renderer blocks unsupported conditional styling instead of creating a misleading preview',async t=>{
  const f=await fixture(t,{format:'xlsx'});
  const change=spawnSync(python,['-c',"import sys,openpyxl;from openpyxl.formatting.rule import ColorScaleRule;b=openpyxl.load_workbook(sys.argv[1]);b.active.conditional_formatting.add('B2:B3',ColorScaleRule(start_type='min',start_color='FFFFFF',end_type='max',end_color='FF0000'));b.save(sys.argv[1])",f.artifactPath],{encoding:'utf8',windowsHide:true});
  assert.equal(change.status,0,change.stderr);
  const requestPath=path.join(f.root,'render-request.json');
  fs.writeFileSync(requestPath,JSON.stringify({ranges:[{sheetName:'Data',range:'A1:C4'}]}));
  const output=spawnSync(python,['scripts/render-special-workbook.py',f.artifactPath,requestPath,path.join(f.root,'renders')],{encoding:'utf8',windowsHide:true});
  assert.equal(output.status,1);assert.equal(JSON.parse(output.stdout).error,'render_unsupported_visual_feature');
});

test('file existence or caller reviewed:true cannot bypass an actual semantic failure',async t=>{
  const f=await fixture(t);f.manifest.artifacts[0].reviewed=true;f.manifest.reviewStatus='PASS';f.save();
  f.customize(review=>({...review,verdict:'FAIL',issues:['One requested deliverable is absent.']}));
  const result=await reviewSpecialArtifacts(f.args);assert.equal(result.verdict,'FAIL');assert.equal(result.receipts.length,0);assert.equal(f.calls.models,1);
});

test('missing deliverable coverage does not pass merely because the workbook has rows',async t=>{
  const f=await fixture(t);f.customize(review=>({...review,coverage:review.coverage.slice(0,1)}));
  const result=await reviewSpecialArtifacts(f.args);assert.equal(result.verdict,'BLOCKED');
  assert.equal(result.issues[0].code,'semantic_requirement_coverage_incomplete');
});

test('unreal cell locations and invented source references fail deterministically',async t=>{
  for(const kind of ['locator','source']){
    const f=await fixture(t);f.customize(review=>{if(kind==='locator')review.coverage[0].locations[0].range='Z999';else review.coverage[0].sourceRefs=['invented'];return review});
    const result=await reviewSpecialArtifacts(f.args);assert.equal(result.verdict,'FAIL');assert.equal(result.receipts.length,0);
  }
});

test('static total mismatch fails independent recomputation despite model PASS',async t=>{
  const f=await fixture(t,{total:80});const result=await reviewSpecialArtifacts(f.args);
  assert.equal(result.verdict,'FAIL');assert.equal(result.issues[0].code,'calculation_result_mismatch');
});

test('unsupported active formulas and circular references hold before invoking semantic model',async t=>{
  for(const formula of ['=WEBSERVICE("https://example.com")','=B4']){
    const f=await fixture(t,{format:'xlsx',formula});const result=await reviewSpecialArtifacts(f.args);
    assert.equal(result.verdict,'BLOCKED');assert.equal(result.issues[0].code,'artifact_deterministic_checks_failed');assert.equal(f.calls.models,0);
  }
});

test('wrong source digest, subject, or altered original requirement image cannot proceed',async t=>{
  for(const kind of ['digest','subject','image']){
    const f=await fixture(t);
    if(kind==='digest')f.manifest.sourceDigest='0'.repeat(64);
    if(kind==='subject')f.manifest.artifacts[0].assignments=[{...f.manifest.artifacts[0].assignments[0],subject:'Different subject'}];
    if(kind==='image')fs.writeFileSync(f.job.specialIntake.attachments[0].localPath,'changed image');
    f.save();const result=await reviewSpecialArtifacts(f.args);assert.equal(result.verdict,'BLOCKED');assert.equal(f.calls.models,0);
  }
});

test('reviewed artifact or existing notes edited while reviewing invalidates all receipts',async t=>{
  for(const kind of ['artifact','notes']){
    const f=await fixture(t);f.onReview(()=>fs.appendFileSync(kind==='artifact'?f.artifactPath:f.notePath,'\nchanged'));
    const result=await reviewSpecialArtifacts(f.args);assert.equal(result.verdict,'BLOCKED');assert.equal(result.receipts.length,0);
  }
});

test('unexpected tool activity and omitted visual checks cannot produce PASS',async t=>{
  const f=await fixture(t);f.customize(review=>({...review,visualChecks:[]}));
  assert.equal((await reviewSpecialArtifacts(f.args)).issues[0].code,'semantic_visual_review_incomplete');
  const result=await reviewSpecialArtifacts({...f.args,createCodex:()=>({startThread:()=>({id:'bad',run:async()=>({items:[{type:'command_execution'}],finalResponse:'{}'})})})});
  assert.equal(result.issues[0].code,'artifact_review_tool_activity');
});

test('review is disabled without explicit route configuration and forbidden source folders stay unread',async t=>{
  const f=await fixture(t);f.config.specialArtifactReview.enabled=false;
  assert.equal((await reviewSpecialArtifacts(f.args)).issues[0].code,'special_artifact_review_disabled');
  f.config.specialArtifactReview.enabled=true;const folder=path.join(f.root,'config');fs.mkdirSync(folder);
  const secret=path.join(folder,'runtime.json');fs.writeFileSync(secret,'{"not_research":true}');
  f.manifest.artifacts[0].sourceFiles=[secret];f.save();
  assert.equal((await reviewSpecialArtifacts(f.args)).issues[0].code,'artifact_research_scope_invalid');assert.equal(f.calls.models,0);
});

test('pure receipt validator detects mutated identity and changed semantic evidence',async t=>{
  const f=await fixture(t);const result=await reviewSpecialArtifacts(f.args);assert.equal(result.verdict,'PASS');
  const changed=structuredClone(result);changed.materials[0].localPath=path.join(f.root,'other.csv');
  assert.throws(()=>assertSpecialArtifactReview(changed,f.job),/receipt_invalid/u);
  result.semanticReview.summary='altered';assert.throws(()=>assertSpecialArtifactReview(result,f.job),/binding_invalid/u);
});

function sheetClient({formula=false,changed=false,revision=true}={}){
  const calls=[];
  return {calls,request:async args=>{
    calls.push(args);assert.equal(args.method,'GET');
    if(args.url.endsWith('/sheets/query'))return {code:0,data:{sheets:[{sheet_id:'sheet1',title:'Data',grid_properties:{row_count:4,column_count:3}}]}};
    if(args.url.includes('/values/')){
      const rows=structuredClone(dataRows);if(changed)rows[1][1]=31;
      if(formula&&args.params.valueRenderOption==='Formula')rows[3][1]='=SUM(B2:B3)';
      return {code:0,data:{...(revision?{revision:17}:{}),valueRange:{values:rows}}};
    }
    return {code:0,data:{spreadsheet:{token:'SheetToken',title:'Public video statistics'}}};
  }};
}

test('existing Feishu sheet reads every declared grid page and uses only a real revision when supplied',async t=>{
  const f=await fixture(t);const artifact={artifactType:'feishu_sheet',url:'https://my.feishu.cn/sheets/SheetToken'};
  const client=sheetClient();const result=await readSpecialRemoteArtifact({artifact,config:f.config,client});
  assert.equal(result.revisionId,'17');assert.equal(result.snapshot.worksheets[0].cells.length,11);assert.equal(client.calls.length,4);
  const noRevision=await readSpecialRemoteArtifact({artifact,config:f.config,client:sheetClient({revision:false})});
  assert.equal(noRevision.revisionId,undefined);assert.ok(noRevision.contentDigest);
  await assert.rejects(()=>validateLatestSpecialArtifact(result,{config:f.config,client:sheetClient({changed:true})}),/changed_after_review/u);
});

test('existing sheet with a supported formula receives independent recomputation and semantic review',async t=>{
  const f=await fixture(t);delete f.manifest.artifacts[0].localPath;f.manifest.artifacts[0].artifactType='feishu_sheet';
  f.manifest.artifacts[0].url='https://my.feishu.cn/sheets/SheetToken';f.save();
  const result=await reviewSpecialArtifacts({...f.args,client:sheetClient({formula:true})});
  assert.equal(result.verdict,'PASS',JSON.stringify(result.issues));assert.equal(result.materials[0].kind,'feishu_sheet');
  assert.equal(result.materials[0].artifactSha256,undefined);assert.equal(result.materials[0].revisionId,'17');
});

test('docx content uses complete pagination and revision comparison, without ordinary fourteen-platform validation',async t=>{
  const f=await fixture(t);let metadataReads=0;
  const client={request:async args=>{assert.equal(args.method,'GET');
    if(args.url.endsWith('/blocks'))return {code:0,data:{items:[{block_id:'DocToken',block_type:1,children:['b1']},
      {block_id:'b1',block_type:2,text:{elements:[{text_run:{content:'Game A source https://example.com/video'}}]}}],has_more:false}};
    metadataReads++;return {code:0,data:{document:{document_id:'DocToken',revision_id:5,title:'Special report'}}};}};
  const result=await readSpecialRemoteArtifact({artifact:{artifactType:'feishu_docx',url:'https://my.feishu.cn/docx/DocToken'},config:f.config,client});
  assert.equal(result.revisionId,5);assert.equal(result.snapshot.blocks.length,2);assert.equal(metadataReads,2);
  assert.equal(specialArtifactManifestExample(f.job).sourceDigest,specialArtifactSourceDigest(f.job));
});

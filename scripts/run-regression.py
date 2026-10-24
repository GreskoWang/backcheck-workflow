"""Offline regression against fixtures and loopback fake services only."""
from pathlib import Path
import argparse, datetime, json, os, shutil, subprocess, sys, tempfile, time

ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--node',default=shutil.which('node'))
    parser.add_argument('--pwsh',default=shutil.which('pwsh'))
    parser.add_argument('--group',choices=['all','browser','bridge','python','uat'],default='all')
    parser.add_argument('--match',help='Run only test group names containing this string')
    args=parser.parse_args()
    if not args.node or not args.pwsh:parser.error('Node.js and PowerShell 7 are required')
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    out=ROOT/'reports/local'/f'regression-{stamp}-{args.group}'
    out.mkdir(parents=True,exist_ok=False)
    isolated=Path(tempfile.mkdtemp(prefix='backcheck-regression-',dir=ROOT/'.local/temp'))
    cfg={'schema_version':1,'app_id':'cli_offline_fixture','target_chat_id':'','template_document_token':'OFFLINE_TEMPLATE_FIXTURE',
         'template_read_verified':False,'listener_enabled':False,'acceptance_replies_enabled':False,
         'accounting':{'enabled':True,'rules_reviewed':True,'spreadsheet_token':'OFFLINE_SPREADSHEET_FIXTURE'}}
    config=isolated/'fixture-config.json';config.write_text(json.dumps(cfg),encoding='utf-8')
    env={k:v for k,v in os.environ.items() if not k.upper().startswith(('CODEX_','CDP_','FEISHU_','LARK_','APP_SECRET','APP_ID'))}
    env.update({'CODEX_HOME':str(isolated/'codex'),'BACKCHECK_CONFIG_PATH':str(config),'BACKGROUND_CHECK_WORKSPACE':str(ROOT),
        'RESEARCH_WORKSPACE':str(ROOT),'BACKCHECK_SKILLS_ROOT':str(ROOT/'skills'),'RESEARCH_PYTHON':sys.executable,
        'FEISHU_REVIEW_PYTHON':sys.executable,'RESEARCH_BATCH_TEST_PYTHON':sys.executable,
        'RESEARCH_BATCH_TEST_COVERAGE':str(ROOT/'tools/research-batch/coverage/validate.py'),
        'FEISHU_REVIEW_AUDITOR':str(ROOT/'skills/review-feishu-background-check/scripts/audit_feishu_snapshot.py'),
        'FEISHU_CREDENTIAL_DIR':str(isolated/'credentials'),'CDP_PROXY_TOKEN_DIR':str(isolated/'cdp'),
        'FEISHU_MCP_ROOT':str(ROOT/'external/feishu-mcp'),'FEISHU_LOCALAPPDATA':str(isolated/'profile'),
        'TEMP':str(isolated),'TMP':str(isolated),'PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1'})
    env['PATH']=os.pathsep.join([str(Path(args.node).parent),str(Path(args.pwsh).parent),env.get('PATH','')])
    commands=[]
    if args.group in ('all','browser'):
        for script in sorted((ROOT/'skills/web-access/scripts').glob('*selftest.mjs')):
            commands.append(('browser-'+script.stem,[args.node,str(script)],script.parent,240 if script.name=='cdp-session-selftest.mjs' else 120))
    if args.group in ('all','bridge'):
        cwd=ROOT/'tools/feishu-codex-bridge'
        commands.append(('bridge',[args.node,'--test','--test-concurrency=2',*map(str,sorted((cwd/'test').glob('*.test.mjs')))],cwd,180))
    if args.group in ('all','python'):
        for group in ('coverage','media','pipeline'):
            cwd=ROOT/'tools/research-batch/test'/group
            commands.append(('python-'+group,[sys.executable,'-m','unittest','discover','-s',str(cwd),'-p','test_*.py'],ROOT,120))
        for skill in ('deliver-feishu-background-check','review-feishu-background-check'):
            cwd=ROOT/'skills'/skill/'scripts'
            commands.append(('python-'+skill,[sys.executable,'-m','unittest','discover','-s',str(cwd),'-p','test_*.py'],cwd,120))
        for skill,script in [('deliver-feishu-background-check','validate_feishu_document.py'),('deliver-feishu-background-check','validate_research_payload.py'),('review-feishu-background-check','audit_feishu_snapshot.py')]:
            cwd=ROOT/'skills'/skill/'scripts'
            commands.append((script.removesuffix('.py'),[sys.executable,str(cwd/script),'--self-test'],cwd,300 if script=='validate_research_payload.py' else 120))
    if args.group in ('all','uat'):
        p=ROOT/'external/feishu-mcp/scripts/test-uat-recovery.ps1'
        commands.append(('uat-recovery',[args.pwsh,'-NoProfile','-File',str(p)],p.parent,60))
    if args.group in ('all','browser'):
        for name in ('x-readiness','x-bulk'):
            p=ROOT/'skills/web-access/scripts'/f'test-{name}.ps1'
            commands.append((name,[args.pwsh,'-NoProfile','-File',str(p)],p.parent,30))
    if args.match:commands=[command for command in commands if args.match in command[0]]
    if not commands:parser.error('No regression checks matched')
    results=[]
    for name,cmd,cwd,budget in commands:
        started=time.monotonic();print(json.dumps({'stage':name,'state':'running'}),flush=True)
        logfile=out/(name+'.log')
        with logfile.open('w',encoding='utf-8') as stream:
            process=subprocess.Popen(cmd,cwd=cwd,env=env,stdout=stream,stderr=subprocess.STDOUT)
            try:code=process.wait(timeout=budget)
            except subprocess.TimeoutExpired:
                if os.name=='nt':subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],capture_output=True)
                else:process.kill()
                process.wait();code=124
        result={'test':name,'exit_code':code,'seconds':round(time.monotonic()-started,2),'log':str(logfile.relative_to(ROOT))}
        results.append(result);print(json.dumps(result),flush=True)
    summary={'status':'PASS' if all(x['exit_code']==0 for x in results) else 'FAIL','scope':'offline fixtures and loopback fakes',
             'production_listener_started':False,'live_browser_used':False,'checks':results,'fixture_directory':str(isolated)}
    (out/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps({'status':summary['status'],'checks':len(results),'report':str(out/'summary.json')}),flush=True)
    return 0 if summary['status']=='PASS' else 1

if __name__=='__main__':raise SystemExit(main())

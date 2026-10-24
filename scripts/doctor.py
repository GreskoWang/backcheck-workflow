"""Read-only installation checks. Never starts business listeners or browsers."""
from pathlib import Path
import argparse, importlib.metadata, json, os, shutil, subprocess, sys
ROOT=Path(__file__).resolve().parents[1]
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--require-ready',action='store_true');args=ap.parse_args()
    config=ROOT/'config/backcheck-local.json';runtime=ROOT/'config/runtime-paths.json'
    checks=[]
    def check(name,ok,detail):checks.append({'check':name,'ok':bool(ok),'detail':detail})
    check('runtime-config',runtime.is_file(),'Run Setup-Backcheck.ps1 first')
    if not runtime.is_file():print(json.dumps({'status':'FAIL','checks':checks}));return 1
    env=json.loads(runtime.read_text(encoding='utf-8-sig'))['env']
    check('workspace',Path(env['BACKGROUND_CHECK_WORKSPACE']).resolve()==ROOT,'Paths bind to this clone')
    for key in ('CODEX_NODE','RESEARCH_PYTHON'):
        check(key,Path(env[key]).is_file(),'Configured executable exists')
    for folder in ('tools/feishu-codex-bridge','external/feishu-mcp'):
        p=ROOT/folder
        expected=json.loads((p/'package.json').read_text())['dependencies']
        for name,version in expected.items():
            installed=p/'node_modules'/name/'package.json'
            actual=json.loads(installed.read_text(encoding='utf-8')).get('version') if installed.is_file() else None
            check(name,actual==version,f'expected {version}, installed {actual}')
    try: pillow=importlib.metadata.version('Pillow')
    except importlib.metadata.PackageNotFoundError:pillow=None
    check('Pillow',pillow=='12.3.0',f'installed {pillow}')
    cfg=json.loads(config.read_text(encoding='utf-8-sig')) if config.is_file() else {}
    ready=bool(cfg.get('template_read_verified') and cfg.get('target_chat_id') and cfg.get('app_id'))
    if args.require_ready:check('business-readiness',ready,'Run credential setup, Login, CheckFeishu and BindGroup')
    result={'status':'PASS' if all(c['ok'] for c in checks) else 'FAIL','scope':'local installation only',
            'account_authorization_verified':False,'business_configuration_ready':ready,
            'listener_enabled':cfg.get('listener_enabled',False),'checks':checks}
    print(json.dumps(result,ensure_ascii=False,indent=2));return result['status']!='PASS'
if __name__=='__main__':raise SystemExit(main())

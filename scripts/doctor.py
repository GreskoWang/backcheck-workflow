"""Read-only installation checks. Never starts business listeners or browsers."""
from pathlib import Path
import argparse, json, subprocess
ROOT=Path(__file__).resolve().parents[1]
PYTHON_PROBE_TIMEOUT_SECONDS=5
PYTHON_PROBE=r'''
import importlib.metadata, json, sys
result={'executable':sys.executable,'version':list(sys.version_info[:3]),
        'version_string':sys.version,'pillow_version':None,'pillow_importable':False}
try:
    result['pillow_version']=importlib.metadata.version('Pillow')
except importlib.metadata.PackageNotFoundError:
    pass
try:
    from PIL import Image
    result['pillow_importable']=True
except Exception as error:
    result['pillow_import_error']=type(error).__name__
print(json.dumps(result))
'''

def inspect_configured_python(executable):
    """Probe only the configured interpreter; do not inspect this process's packages."""
    result={'ok':False,'requested_executable':executable}
    if not isinstance(executable,str) or not executable.strip():
        return {**result,'error':'configured_python_missing'}
    try:
        probe=subprocess.run([executable,'-c',PYTHON_PROBE],capture_output=True,
                             encoding='utf-8',errors='replace',
                             timeout=PYTHON_PROBE_TIMEOUT_SECONDS,check=False)
    except subprocess.TimeoutExpired:
        return {**result,'error':'python_probe_timeout','timeout_seconds':PYTHON_PROBE_TIMEOUT_SECONDS}
    except (OSError,ValueError) as error:
        return {**result,'error':'python_probe_start_failed','detail':str(error)}
    if probe.returncode:
        return {**result,'error':'python_probe_failed','exit_code':probe.returncode,
                'stderr':probe.stderr[-1200:]}
    try:
        observed=json.loads(probe.stdout)
        if (not isinstance(observed,dict) or not isinstance(observed.get('executable'),str)
                or not observed['executable'] or not isinstance(observed.get('version_string'),str)
                or not isinstance(observed.get('version'),list) or len(observed['version'])!=3
                or not all(isinstance(part,int) for part in observed['version'])
                or not isinstance(observed.get('pillow_importable'),bool)):
            raise ValueError('Invalid Python probe response')
    except (ValueError,TypeError):
        return {**result,'error':'python_probe_invalid_response'}
    return {**observed,**result,'ok':True}

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
        check(key,bool(env.get(key)) and Path(env[key]).is_file(),'Configured executable exists')
    for folder in ('tools/feishu-codex-bridge','external/feishu-mcp'):
        p=ROOT/folder
        expected=json.loads((p/'package.json').read_text())['dependencies']
        for name,version in expected.items():
            installed=p/'node_modules'/name/'package.json'
            actual=json.loads(installed.read_text(encoding='utf-8')).get('version') if installed.is_file() else None
            check(name,actual==version,f'expected {version}, installed {actual}')
    python_runtime=inspect_configured_python(env.get('RESEARCH_PYTHON'))
    check('python-runtime',python_runtime['ok'] and tuple(python_runtime['version'])>=(3,10,0),python_runtime)
    pillow=python_runtime.get('pillow_version')
    check('Pillow',python_runtime['ok'] and pillow=='12.3.0' and python_runtime.get('pillow_importable'),
          f'configured interpreter installed {pillow}; importable {python_runtime.get("pillow_importable",False)}')
    cfg=json.loads(config.read_text(encoding='utf-8-sig')) if config.is_file() else {}
    ready=bool(cfg.get('template_read_verified') and cfg.get('target_chat_id') and cfg.get('app_id'))
    if args.require_ready:check('business-readiness',ready,'Run credential setup, Login, CheckFeishu and BindGroup')
    result={'status':'PASS' if all(c['ok'] for c in checks) else 'FAIL','scope':'local installation only',
            'account_authorization_verified':False,'business_configuration_ready':ready,
            'listener_enabled':cfg.get('listener_enabled',False),'python_runtime':python_runtime,'checks':checks}
    print(json.dumps(result,ensure_ascii=False,indent=2));return result['status']!='PASS'
if __name__=='__main__':raise SystemExit(main())

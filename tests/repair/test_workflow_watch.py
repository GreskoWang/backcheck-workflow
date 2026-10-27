"""Offline regression cases for compact watcher. No network or live state."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

parser=argparse.ArgumentParser()
parser.add_argument('--repo',required=True,type=Path)
args=parser.parse_args()
root=args.repo.resolve()
source=root/'tools/research-batch/pipeline/prepare.py'
spec=importlib.util.spec_from_file_location('workflow_test_pipeline',source)
pipeline=importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)
results=[]

def check(name,fn):
    try:
        details=fn()
        results.append({'name':name,'passed':True,'details':details})
    except Exception as exc:
        results.append({'name':name,'passed':False,'error':str(exc)})

def fixture_data():
    return {'schema_version':1,'job':{'id':'offline-job','state':'collected','iterations':1,'recipe':'generic-posts','target_url':'https://example.org/user','reason':'visible_endpoint'},'items':[{'source_id':'p1','post_url':'https://example.org/p1','account':'author','date':'2026-10-27','text':'Complete source text.','quoted_text':'','text_truncated':False,'needs_expansion':False,'media':[],'media_count':0}],'scope':{},'conclusion':'incomplete','coverage':{'collection_complete':True,'stop_reason':'visible_endpoint','visible_endpoint_verified':True,'observed_count':1,'unresolved':[]}}

def run_watch(kind):
    with tempfile.TemporaryDirectory(prefix='backcheck-watch-test-') as temp:
        base=Path(temp)
        job,out=base/'job',base/'reading'
        job.mkdir();out.mkdir()
        data=fixture_data()
        state=dict(data['job'],stop_reason='visible_endpoint')
        if kind=='init_failure':
            state.update(state='needs_review',stop_reason='worker_initialization_error',error={'code':'lease_expired','message':'offline fixture'})
        if kind=='running':
            state['state']='running'
        (job/'job.json').write_text(json.dumps(state),encoding='utf-8')
        if kind in {'valid','stale','short_commit_delay'}:
            if kind=='stale':data['job']['iterations']=0
            (job/'result.json').write_text(json.dumps(data),encoding='utf-8')
        prior={'layout':pipeline.compact.LAYOUT,'cursor':[3,0],'unchanged_marker':'prior actual reading checkpoint'}
        if kind in {'init_failure','missing','stale','running'}:
            (out/'state.json').write_text(json.dumps(prior),encoding='utf-8')
        old=(out/'state.json').read_bytes() if (out/'state.json').exists() else None
        clock=[0.0]
        def sleep(seconds):clock[0]+=seconds
        original_read=pipeline.read_json
        def read(file):
            if kind=='short_commit_delay' and Path(file)==job/'result.json' and clock[0]<0.6:
                raise FileNotFoundError('simulated atomic commit gap')
            return original_read(file)
        with patch.object(pipeline.compact.time,'monotonic',side_effect=lambda:clock[0]),patch.object(pipeline.compact.time,'sleep',side_effect=sleep),patch.object(pipeline,'read_json',side_effect=read):
            result=pipeline.watch_job(job,out,layout='auto',max_wait=5,poll_interval=0.1)
        if old is not None:
            assert (out/'state.json').read_bytes()==old,'Existing reading checkpoint changed'
        if kind=='init_failure':
            assert result.get('reason')=='worker_initialization_error',result
            assert result.get('collection_error_code')=='lease_expired',result
            assert clock[0]<0.2,clock[0]
        elif kind in {'missing','stale'}:
            assert result.get('reason')=='terminal_result_missing_or_stale',result
            assert 3<=clock[0]<4,clock[0]
        elif kind=='running':
            assert result.get('reason')=='watch_timeout',result
        else:
            assert result.get('status')=='prepared',result
            assert result.get('surface_completion') is False,result
            assert result['next_action']['text_read_complete'] is False,result
        return {'watch_status':result.get('status'),'reason':result.get('reason'),'virtual_elapsed_seconds':round(clock[0],3)}

for kind in ['init_failure','missing','stale','valid','short_commit_delay','running']:
    check(kind,lambda kind=kind:run_watch(kind))
failed=sum(not result['passed'] for result in results)
print(json.dumps({'suite':'workflow-watch','repo':str(root),'tests':len(results),'passed':len(results)-failed,'failed':failed,'results':results},ensure_ascii=False,indent=2))
raise SystemExit(1 if failed else 0)

"""Offline regression for doctor.py's configured-Python checks.

Usage: python test_doctor_runtime.py --repo PATH [--output report.json]
Works on Windows and Linux without pip, browser access, or credentials. Real
temporary Python venvs contain explicitly synthetic Pillow package fixtures.
Those fixtures test interpreter selection and import/error reporting, not Pillow
image processing or installation of the production dependency.
"""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import venv

REPOSITORY=None
OBSERVATIONS=[]


def make_python(folder, *, pillow=False):
    venv.EnvBuilder(with_pip=False).create(folder)
    executable=folder/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    probe=subprocess.run([str(executable),'-c',
                          'import sysconfig; print(sysconfig.get_path("purelib"))'],
                         capture_output=True,text=True,check=True,timeout=15)
    purelib=Path(probe.stdout.strip())
    if pillow:
        package=purelib/'PIL'
        package.mkdir(parents=True,exist_ok=True)
        (package/'__init__.py').write_text('__version__="12.3.0"\n',encoding='utf-8')
        (package/'Image.py').write_text('"""Synthetic import fixture."""\n',encoding='utf-8')
        metadata=purelib/'Pillow-12.3.0.dist-info'
        metadata.mkdir()
        (metadata/'METADATA').write_text(
            'Metadata-Version: 2.1\nName: Pillow\nVersion: 12.3.0\n',encoding='utf-8')
    return executable,purelib


class DoctorRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shared=tempfile.TemporaryDirectory(prefix='doctor-host-fixture-')
        cls.host_python,_=make_python(Path(cls.shared.name)/'host',pillow=True)

    @classmethod
    def tearDownClass(cls):
        cls.shared.cleanup()

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='doctor-configured-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'repo'
        (self.root/'scripts').mkdir(parents=True)
        shutil.copyfile(REPOSITORY/'scripts/doctor.py',self.root/'scripts/doctor.py')
        (self.root/'config').mkdir()
        (self.root/'config/backcheck-local.json').write_text(
            json.dumps({'listener_enabled':False,'template_read_verified':False}),encoding='utf-8')
        for relative in ('tools/feishu-codex-bridge','external/feishu-mcp'):
            folder=self.root/relative
            folder.mkdir(parents=True)
            (folder/'package.json').write_text('{"dependencies":{}}',encoding='utf-8')

    def run_doctor(self,configured_python):
        (self.root/'config/runtime-paths.json').write_text(json.dumps({'env':{
            'BACKGROUND_CHECK_WORKSPACE':str(self.root),
            'CODEX_NODE':str(self.host_python),
            'RESEARCH_PYTHON':str(configured_python),
        }}),encoding='utf-8')
        run=subprocess.run([str(self.host_python),str(self.root/'scripts/doctor.py')],
                           capture_output=True,encoding='utf-8',errors='replace',timeout=15)
        try:
            payload=json.loads(run.stdout)
        except ValueError:
            self.fail(f'doctor did not produce JSON: exit={run.returncode}, stderr={run.stderr[-1000:]}')
        OBSERVATIONS.append({'test':self._testMethodName,'exit_code':run.returncode,
                             'status':payload.get('status'),
                             'python_runtime':payload.get('python_runtime'),
                             'pillow_check':next((c for c in payload.get('checks',[])
                                                  if c.get('check')=='Pillow'),None)})
        return run,payload

    def test_missing_pillow_in_configured_python_fails_despite_host_pillow(self):
        configured,_=make_python(Path(self.temp.name)/'configured')
        run,payload=self.run_doctor(configured)
        self.assertNotEqual(run.returncode,0)
        self.assertEqual(payload['status'],'FAIL')
        self.assertFalse(next(c['ok'] for c in payload['checks'] if c['check']=='Pillow'))
        self.assertIsNone(payload['python_runtime']['pillow_version'])

    def test_success_records_actual_configured_interpreter_and_version(self):
        configured,_=make_python(Path(self.temp.name)/'configured',pillow=True)
        run,payload=self.run_doctor(configured)
        self.assertEqual(run.returncode,0)
        self.assertEqual(payload['status'],'PASS')
        runtime=payload.get('python_runtime')
        self.assertIsInstance(runtime,dict)
        self.assertEqual(os.path.normcase(os.path.abspath(runtime['executable'])),
                         os.path.normcase(os.path.abspath(configured)))
        self.assertEqual(runtime['version'],list(sys.version_info[:3]))
        self.assertTrue(runtime['pillow_importable'])
        self.assertFalse(payload['account_authorization_verified'])
        self.assertFalse(payload['listener_enabled'])

    def test_existing_non_executable_file_is_reported_as_probe_failure(self):
        configured=Path(self.temp.name)/'not-python.txt'
        configured.write_text('This is an ordinary fixture file.\n',encoding='utf-8')
        run,payload=self.run_doctor(configured)
        self.assertNotEqual(run.returncode,0)
        self.assertEqual(payload['status'],'FAIL')
        self.assertEqual(payload['python_runtime']['error'],'python_probe_start_failed')

    def test_invalid_probe_response_cannot_pass(self):
        configured,purelib=make_python(Path(self.temp.name)/'configured',pillow=True)
        (purelib/'sitecustomize.py').write_text('print("synthetic extra startup output")\n',encoding='utf-8')
        run,payload=self.run_doctor(configured)
        self.assertNotEqual(run.returncode,0)
        self.assertEqual(payload['status'],'FAIL')
        self.assertEqual(payload['python_runtime']['error'],'python_probe_invalid_response')

    def test_configured_python_timeout_is_bounded_and_fails(self):
        configured,purelib=make_python(Path(self.temp.name)/'configured',pillow=True)
        (purelib/'sitecustomize.py').write_text('import time\ntime.sleep(20)\n',encoding='utf-8')
        run,payload=self.run_doctor(configured)
        self.assertNotEqual(run.returncode,0)
        self.assertEqual(payload['status'],'FAIL')
        self.assertEqual(payload['python_runtime']['error'],'python_probe_timeout')


def main():
    global REPOSITORY
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',required=True,type=Path)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    REPOSITORY=args.repo.resolve()
    if not (REPOSITORY/'scripts/doctor.py').is_file():
        parser.error('--repo must contain scripts/doctor.py')
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(DoctorRuntimeTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    report={'status':'PASS' if result.wasSuccessful() else 'FAIL',
            'scope':'offline interpreter-selection and diagnostics fixtures',
            'repository':str(REPOSITORY),'tests_run':result.testsRun,
            'failures':len(result.failures),'errors':len(result.errors),
            'live_services_used':False,'package_fixtures_are_synthetic':True,
            'observations':OBSERVATIONS,
            'failure_details':[{'test':test.id(),'traceback':detail}
                               for test,detail in result.failures+result.errors]}
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k] for k in ('status','tests_run','failures','errors','live_services_used')}))
    return 0 if result.wasSuccessful() else 1


if __name__=='__main__':
    raise SystemExit(main())

"""交付通过标志、过程说明及标准诊断不可被自报通过覆盖的回归测试。"""
import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import validate_feishu_document as validator

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "background-check-research" / "scripts"))
from test_discovery_gate import fixture as discovery_fixture
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "review-feishu-background-check" / "scripts"))
import audit_feishu_snapshot as snapshot_auditor


class DeliveryGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=validator.EVIDENCE_ROOT)
        cls.root = Path(cls.temp.name)
        cls.payload = validator._self_test_payload(cls.root)
        cls.snapshot = validator._fixture_snapshot(cls.payload)
        cls.payload_path = cls.root / 'payload.json'
        cls.payload_path.write_text(json.dumps(cls.payload), encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_cli(self, snapshot=None, *, delivery=False, strict_warnings=True, extra=()):
        source = self.root / (self._testMethodName + '.json')
        receipt = self.root / (self._testMethodName + '.report.json')
        source.write_text(json.dumps(snapshot or self.snapshot), encoding='utf-8')
        args = [sys.executable, '-X', 'utf8', str(Path(validator.__file__)), '--snapshot', str(source)]
        args += (['--payload', str(self.payload_path)] if delivery
                 else ['--audit-only', '--risk-count', '1', '--subject-type', 'person'])
        if delivery and strict_warnings:
            args.append('--strict-warnings')
        run = subprocess.run([*args, '--report-json', str(receipt), *extra], capture_output=True, text=True, encoding='utf-8')
        return run, json.loads(receipt.read_text(encoding='utf-8')) if receipt.exists() else None, source

    def research_snapshot(self):
        snapshot = copy.deepcopy(self.snapshot)
        business = snapshot['review_context']['business_risk_review']
        discovery = discovery_fixture(self.root)
        discovery['entities'][0]['record_fact'] = business['confirmed_hits'][0]['verified_fact']
        business['discovery_review'] = discovery
        return snapshot

    def release_result(self, snapshot, report=None, *, audit_only=False):
        source = self.root / (self._testMethodName + '-release.json')
        source.write_text(json.dumps(snapshot), encoding='utf-8')
        return validator.validation_result(
            report if report is not None else validator.Report(), audit_only=audit_only,
            snapshot_path=source, payload_path=None if audit_only else self.payload_path,
        )

    def test_audit_success_is_not_delivery_success(self):
        run, result, source = self.run_cli()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('AUDIT_ONLY_PASS', run.stdout)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['mode'], 'audit_only')
        self.assertEqual(result['inputs']['snapshot']['sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual(result['document']['revision_after'], 1)

    def test_full_standard_validation_success(self):
        run, result, _ = self.run_cli(delivery=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertTrue(result['delivery_validation_passed'])
        self.assertIn('DELIVERY_VALIDATION_PASS', run.stdout)
        self.assertIn('visual_review', result['checks_not_performed'])
        self.assertIn(
            '../review-feishu-background-check/scripts/business_risk_gate.py',
            result['standard_sources'],
        )

    def test_missing_business_risk_review_blocks_delivery(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context'].pop('business_risk_review')
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'BLOCKED')
        self.assertIn('BUSINESS_RISK_REVIEW', {d['code'] for d in result['diagnostics']})

    def test_discovery_missing_blocks_real_delivery_cli(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['business_risk_review'].pop('discovery_review')
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertIn('DISCOVERY_REVIEW_REQUIRED', {d['code'] for d in result['diagnostics']})
        self.assertEqual(result['verdict'], 'FAIL')

    def test_discovery_open_media_blocks_real_delivery_cli(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['business_risk_review']['discovery_review'] = {
            'version': 1, 'mode': 'assistant_research', 'scope': 'offline X',
            'source_revision': '1', 'reviewed_revision': '1', 'source_refs': ['input#1'],
            'reverse_pass': {'status': 'complete', 'names': []}, 'entities': [],
            'open_items': [{'source_ref': 'input#1/image', 'next': 'read image text'}],
        }
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertIn('DISCOVERY_OPEN_ITEMS', {d['code'] for d in result['diagnostics']})
        self.assertEqual(result['verdict'], 'FAIL')

    def test_v2_discovery_receipt_enforced_in_real_delivery_cli(self):
        snapshot = self.research_snapshot()
        discovery = snapshot['review_context']['business_risk_review']['discovery_review']
        initial_audit = validator.validate_document(snapshot, payload=self.payload)
        self.assertFalse(initial_audit.errors or initial_audit.blocked)
        run, result, _ = self.run_cli(snapshot, delivery=True)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertIn('CLIENT_CHALLENGE_REVIEW_REQUIRED', run.stdout)
        self.assertEqual(result['verdict'], 'FAIL')
        receipt_path = Path(discovery['subagent_review']['receipt_path'])
        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
        receipt['reviews'].pop()
        receipt_path.write_text(json.dumps(receipt), encoding='utf-8')
        run, result, _ = self.run_cli(snapshot, delivery=True)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertFalse(result['delivery_validation_passed'])
        self.assertIn('DISCOVERY_SUBAGENT_COVERAGE', {d['code'] for d in result['diagnostics']})

    def test_research_initial_audit_does_not_require_release_challenge(self):
        snapshot = self.research_snapshot()
        # Initial content PASS must be reachable before the real child is spawned.
        with patch.object(validator, '_client_challenge_gate', side_effect=AssertionError('release gate called')) as gate:
            report = validator.validate_document(snapshot, payload=self.payload)
            result = self.release_result(snapshot, report, audit_only=True)
        gate.assert_not_called()
        self.assertEqual(result['verdict'], 'PASS')
        self.assertFalse(result['delivery_validation_passed'])

    def test_supplied_report_cannot_waive_missing_research_challenge(self):
        result = self.release_result(self.research_snapshot(), validator.Report())
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn('CLIENT_CHALLENGE_REVIEW_REQUIRED', {d['code'] for d in result['diagnostics']})

    def test_valid_delivery_only_modes_remain_exempt(self):
        for mode in ('user_supplied', 'existing_report_only'):
            with self.subTest(mode=mode):
                snapshot = copy.deepcopy(self.snapshot)
                snapshot['review_context']['business_risk_review']['discovery_review']['mode'] = mode
                with patch.object(validator, '_client_challenge_gate', side_effect=AssertionError('exempt gate called')) as gate:
                    result = self.release_result(snapshot)
                gate.assert_not_called()
                self.assertTrue(result['delivery_validation_passed'], result['diagnostics'])

    def test_invalid_delivery_only_basis_does_not_create_exemption_pass(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['business_risk_review']['discovery_review'].pop('instruction')
        result = self.release_result(snapshot)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertIn('DISCOVERY_USER_BASIS', {d['code'] for d in result['diagnostics']})

    def test_supplied_challenge_is_checked_even_for_delivery_only(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['client_challenge_review'] = None
        result = self.release_result(snapshot)
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn('CLIENT_CHALLENGE_REVIEW_REQUIRED', {d['code'] for d in result['diagnostics']})

    def test_real_challenge_gate_failure_reaches_cli_and_receipt(self):
        snapshot = self.research_snapshot()
        snapshot['review_context']['client_challenge_review'] = {}
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn('CHALLENGE_VERSION', run.stdout)
        self.assertIn('CHALLENGE_VERSION', {d['code'] for d in result['diagnostics']})
        self.assertNotIn('CLIENT_CHALLENGE_GATE_UNAVAILABLE', {d['code'] for d in result['diagnostics']})

    def test_release_calls_challenge_with_current_snapshot_and_policy(self):
        snapshot = self.research_snapshot()
        # This mock verifies wiring only; it is not evidence of a child review.
        review = {'offline_wiring_test': True}
        snapshot['review_context']['client_challenge_review'] = review
        gate = Mock()
        gate.audit_client_challenge.return_value = {'verdict': 'PASS', 'errors': [], 'blocked': [], 'info': []}
        with patch.object(validator, '_client_challenge_gate', return_value=gate):
            result = self.release_result(snapshot)
        self.assertTrue(result['delivery_validation_passed'], result['diagnostics'])
        args, kwargs = gate.audit_client_challenge.call_args
        self.assertEqual(args, (review,))
        self.assertEqual(kwargs['items'], snapshot['block_list']['items'])
        self.assertEqual(kwargs['discovery_review'], snapshot['review_context']['business_risk_review']['discovery_review'])
        self.assertEqual(kwargs['document_token'], snapshot['document']['document_id'])
        self.assertEqual(kwargs['revision_id'], snapshot['document']['revision_after'])
        self.assertEqual(kwargs['required_policy_path'], validator.CURRENT_BUSINESS_RISK_POLICY)
        self.assertEqual(kwargs['base_dir'], self.root.resolve())
        if validator.CLIENT_CHALLENGE_GATE_PATH.is_file():
            self.assertEqual(
                result['standard_sources']['../client-challenge-background-check/scripts/client_challenge_gate.py'],
                hashlib.sha256(validator.CLIENT_CHALLENGE_GATE_PATH.read_bytes()).hexdigest(),
            )
        for relative in ('SKILL.md', 'references/review-contract.md', 'scripts/contextual_followup.py'):
            source = validator.CLIENT_CHALLENGE_GATE_PATH.parent.parent / relative
            if source.is_file():
                self.assertEqual(
                    result['standard_sources']['../client-challenge-background-check/' + relative],
                    hashlib.sha256(source.read_bytes()).hexdigest(),
                )

    def test_changed_snapshot_and_empty_report_are_rechecked_at_release(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['client_challenge_review'] = {'offline_wiring_test': True}
        snapshot['document']['revision_after'] = 9
        snapshot['block_list']['items'][0]['changed_attribute'] = 'current bytes'
        failure = {'code': 'CLIENT_CHALLENGE_DOCUMENT_BINDING', 'location': 'current snapshot',
                   'actual': 'changed', 'expected': 'fresh challenge for these bytes'}
        gate = Mock()
        gate.audit_client_challenge.return_value = {'verdict': 'FAIL', 'errors': [failure], 'blocked': [], 'info': []}
        with patch.object(validator, '_client_challenge_gate', return_value=gate):
            result = self.release_result(snapshot, validator.Report())
        self.assertEqual(gate.audit_client_challenge.call_args.kwargs['revision_id'], 9)
        self.assertEqual(gate.audit_client_challenge.call_args.kwargs['items'][0]['changed_attribute'], 'current bytes')
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn(failure['code'], {d['code'] for d in result['diagnostics']})

    def test_partial_current_document_cannot_release_with_challenge(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['client_challenge_review'] = {'offline_wiring_test': True}
        snapshot['block_list']['has_more'] = True
        with patch.object(validator, '_client_challenge_gate') as gate:
            result = self.release_result(snapshot)
        gate.assert_not_called()
        self.assertFalse(result['delivery_validation_passed'])
        self.assertIn('CLIENT_CHALLENGE_DOCUMENT_INCOMPLETE', {d['code'] for d in result['diagnostics']})

    def test_challenge_dependency_failure_blocks_release(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['client_challenge_review'] = {'offline_wiring_test': True}
        with patch.object(validator, '_client_challenge_gate', side_effect=ImportError('missing challenge dependency')):
            result = self.release_result(snapshot)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'BLOCKED')
        self.assertIn('CLIENT_CHALLENGE_GATE_UNAVAILABLE', {d['code'] for d in result['diagnostics']})

    def test_malformed_challenge_results_cannot_release(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['client_challenge_review'] = {'offline_wiring_test': True}
        for malformed in (
            None, {'verdict': 'PASS'},
            {'verdict': 'FAIL', 'errors': [], 'blocked': []},
            {'verdict': 'PASS', 'errors': [], 'blocked': [], 'info': 'invalid'},
            {'verdict': 'FAIL', 'errors': [{}], 'blocked': []},
        ):
            with self.subTest(result=malformed):
                gate = Mock()
                gate.audit_client_challenge.return_value = malformed
                with patch.object(validator, '_client_challenge_gate', return_value=gate):
                    result = self.release_result(snapshot)
                self.assertFalse(result['delivery_validation_passed'])
                self.assertEqual(result['verdict'], 'BLOCKED')
                self.assertIn('CLIENT_CHALLENGE_GATE_UNAVAILABLE', {d['code'] for d in result['diagnostics']})

    def test_business_risk_conflict_fails_delivery(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['business_risk_review'].update({
            'status': 'FAIL',
            'conflicts': [{
                'business_item': '低俗、色情',
                'verified_fact': '已核实事实被遗漏',
                'missing_location': '风险摘要',
                'cause': 'assistant moral judgment',
            }],
        })
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn('BUSINESS_RISK_CONFLICT', {d['code'] for d in result['diagnostics']})

    def test_fake_business_policy_source_fails_delivery(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['business_risk_review']['policy_sources'] = [
            {'path': str(self.root / '不存在的风险表.md'), 'sha256': '0' * 64}
        ]
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn('BUSINESS_RISK_POLICY_SOURCE_INVALID', {d['code'] for d in result['diagnostics']})

    def test_existing_unapproved_business_policy_source_fails_delivery(self):
        fake_policy = self.root / 'unapproved-policy.md'
        fake_policy.write_text('低俗、色情\n', encoding='utf-8')
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['business_risk_review']['policy_sources'] = [
            {'path': str(fake_policy.resolve()), 'sha256': hashlib.sha256(fake_policy.read_bytes()).hexdigest()}
        ]
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn('BUSINESS_RISK_POLICY_SOURCE_UNEXPECTED', {d['code'] for d in result['diagnostics']})

    def test_changed_business_policy_hash_blocks_delivery(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['business_risk_review']['policy_sources'][0]['sha256'] = '0' * 64
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'BLOCKED')
        self.assertIn('BUSINESS_RISK_POLICY_SOURCE_CHANGED', {d['code'] for d in result['diagnostics']})

    def test_nonexistent_business_hit_block_fails_delivery(self):
        snapshot = copy.deepcopy(self.snapshot)
        hit = snapshot['review_context']['business_risk_review']['confirmed_hits'][0]
        hit['platform_location']['block_id'] = 'missing-current-block'
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn('BUSINESS_RISK_LOCATION_NOT_FOUND', {d['code'] for d in result['diagnostics']})

    def test_external_pass_and_exception_list_do_not_waive_tail_failure(self):
        snapshot = copy.deepcopy(self.snapshot)
        tail = next(b for b in snapshot['block_list']['items'] if b['block_id'] == 'p9-tail')
        tail['text']['elements'][0]['text_run']['content'] = '委托方已完成人工核查，未提供新增需列示事项。'
        wrapped = {'content': [{'type': 'text', 'text': json.dumps(snapshot)}],
                   'task_document_validation_passed': True, 'exceptions': ['FSH-TAIL-001', 'FSH-TAIL-002']}
        run, result, _ = self.run_cli(wrapped)
        self.assertEqual(run.returncode, 1)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertIn('FSH-TAIL-001', {d['code'] for d in result['diagnostics']})

    def test_process_note_rejected_even_in_audit(self):
        for phrase in ['委托方人工核查未发现问题', '其他搜索按委托方指令停止。', '已按委托方要求完成一轮本名搜索。']:
            with self.subTest(phrase=phrase):
                snapshot = copy.deepcopy(self.snapshot)
                block = next(b for b in snapshot['block_list']['items'] if b['block_id'] == 'p1-module-1')
                block['text']['elements'].append({'text_run': {'content': phrase}})
                run, result, _ = self.run_cli(snapshot)
                self.assertEqual(run.returncode, 1)
                self.assertIn('FSH-WORD-002', {d['code'] for d in result['diagnostics']})

    def test_missing_platform_risk_title_rejected_in_delivery(self):
        snapshot = copy.deepcopy(self.snapshot)
        items = snapshot['block_list']['items']
        title_ids = {b['block_id'] for b in items if validator._text(b).startswith('风险点')}
        self.assertTrue(title_ids)
        snapshot['block_list']['items'] = [b for b in items if b['block_id'] not in title_ids]
        root = next(b for b in items if b['block_type'] == 1)
        root['children'] = [x for x in root['children'] if x not in title_ids]
        run, result, _ = self.run_cli(snapshot, delivery=True)
        self.assertEqual(run.returncode, 1)
        self.assertIn('FSH-RISKMAP-005', {d['code'] for d in result['diagnostics']})

    def test_warning_cannot_set_delivery_pass(self):
        source = self.root / 'warning-snapshot.json'
        source.write_text(json.dumps(self.snapshot), encoding='utf-8')
        report = validator.Report()
        report.warning('FSH-LANG-004', 'Needs review')
        result = validator.validation_result(report, audit_only=False, snapshot_path=source, payload_path=self.payload_path)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual([d['code'] for d in result['diagnostics'] if d['level'] == 'WARNING'], ['FSH-LANG-004'])

    def test_receipt_cannot_overwrite_snapshot(self):
        source = self.root / (self._testMethodName + '.json')
        run, _, actual_source = self.run_cli(extra=['--report-json', str(source)])
        self.assertEqual(run.returncode, 2)
        self.assertEqual(json.loads(actual_source.read_text(encoding='utf-8')), self.snapshot)

    def test_missing_semantic_review_blocks_delivery_without_strict_warnings(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot.pop('review_context')
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertFalse(result['audit_passed'])
        self.assertEqual(result['verdict'], 'BLOCKED')
        self.assertIn('DISCLAIMER_REVIEW_REQUIRED', {d['code'] for d in result['diagnostics']})
        self.assertNotIn('DELIVERY_VALIDATION_PASS', run.stdout)

    def test_disclaimer_failure_takes_precedence_over_missing_review(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot.pop('review_context')
        snapshot['raw_content'] = {'content': '本报告仅供参考。'}
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertFalse(result['delivery_validation_passed'])
        diagnostics = {d['code']: d['level'] for d in result['diagnostics']}
        self.assertEqual(diagnostics['DISCLAIMER_TEXT'], 'ERROR')
        self.assertEqual(diagnostics['DISCLAIMER_REVIEW_REQUIRED'], 'BLOCKED')

    def test_empty_raw_content_blocks_delivery_even_with_current_review(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['raw_content'] = {'content': ''}
        validator._fixture_disclaimer_review(snapshot)
        run, result, _ = self.run_cli(snapshot, delivery=True, strict_warnings=False)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'BLOCKED')
        self.assertIn('DISCLAIMER_RAW_CONTENT', {d['code'] for d in result['diagnostics']})

    def test_unknown_disclaimer_semantic_finding_cannot_pass(self):
        snapshot = copy.deepcopy(self.snapshot)
        variant = '我们把页面当成地图的一角，余下的路请读者自行判断。'
        self.assertFalse(validator._disclaimer_gate().scan_disclaimers(variant))
        snapshot['raw_content'] = {'content': variant}
        validator._fixture_disclaimer_review(snapshot)
        snapshot['review_context']['disclaimer_review'].update({
            'status': 'FAIL',
            'findings': [{'location': 'raw_content', 'excerpt': variant, 'reason': '语义审阅发现转移判断责任'}],
        })
        run, result, _ = self.run_cli(snapshot, delivery=True)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertFalse(result['delivery_validation_passed'])
        self.assertIn('DISCLAIMER_TEXT', {d['code'] for d in result['diagnostics']})

    def test_pass_flag_cannot_waive_semantic_disclaimer_finding(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['review_context']['disclaimer_review']['findings'] = [
            {'location': 'raw_content', 'excerpt': '余下判断请读者自行决定。', 'reason': '转移判断责任'},
        ]
        run, result, _ = self.run_cli(snapshot, delivery=True)
        self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'FAIL')

    def test_direct_copyright_finding_can_pass_current_full_review(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['raw_content'] = {'content': '未找到版权联系人。'}
        validator._fixture_disclaimer_review(snapshot)
        run, result, _ = self.run_cli(snapshot, delivery=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertTrue(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'PASS')
        self.assertIn('../review-feishu-background-check/scripts/disclaimer_gate.py', result['standard_sources'])

    def test_empty_report_cannot_waive_missing_review_in_receipt(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot.pop('review_context')
        source = self.root / 'unreviewed-snapshot.json'
        source.write_text(json.dumps(snapshot), encoding='utf-8')
        result = validator.validation_result(validator.Report(), audit_only=False, snapshot_path=source, payload_path=self.payload_path)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'BLOCKED')

    def test_report_from_other_text_cannot_waive_stale_review(self):
        report = validator.validate_document(self.snapshot, payload=self.payload)
        self.assertFalse(report.errors or report.blocked)
        snapshot = copy.deepcopy(self.snapshot)
        snapshot['raw_content'] = {'content': '已更新的直接事实。'}
        source = self.root / 'changed-snapshot.json'
        source.write_text(json.dumps(snapshot), encoding='utf-8')
        result = validator.validation_result(report, audit_only=False, snapshot_path=source, payload_path=self.payload_path)
        self.assertFalse(result['delivery_validation_passed'])
        self.assertEqual(result['verdict'], 'BLOCKED')
        self.assertIn('DISCLAIMER_REVIEW_BINDING', {d['code'] for d in result['diagnostics']})


class SnapshotDigestTests(unittest.TestCase):
    @staticmethod
    def digest(items):
        return hashlib.sha256(json.dumps(items, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()

    def actual_review_fixture(self, root):
        snapshot = snapshot_auditor._selftest_fixture()
        context = snapshot['review_context']
        document, items = snapshot['document'], snapshot['block_list']['items']
        discovery = discovery_fixture(root)
        discovery['entities'][0].update(disposition='clear', reason='Offline fixture verifies a neutral public reference.')
        discovery['entities'][0].pop('record_fact')
        child_path = Path(discovery['subagent_review']['receipt_path'])
        child = json.loads(child_path.read_text(encoding='utf-8'))
        child['reviews'][0]['conclusion'] = discovery['entities'][0]['reason']
        child_path.write_text(json.dumps(child), encoding='utf-8')
        context['business_risk_review'] = {
            'discovery_review': discovery, 'status': 'PASS',
            'scope': 'current_business_risk_policy_and_full_document',
            'token': snapshot_auditor.review_document_token(document, items),
            'revision_id': document['revision_id'], 'policy_sources': [snapshot_auditor.policy_source()],
            'confirmed_hits': [], 'conflicts': [], 'reviewer_id': context['reviewer_id'],
            'checked_at': '2026-11-11T00:00:00Z',
        }
        context['disclaimer_review'] = {
            'status': 'PASS', 'scope': 'full_document',
            'policy_version': snapshot_auditor.DISCLAIMER_POLICY_VERSION,
            'token': snapshot_auditor.review_document_token(document, items),
            'revision_id': document['revision_id'],
            'text_sha256': snapshot_auditor.review_text_fingerprint(document, items, snapshot.get('raw_content')),
            'reviewer_id': context['reviewer_id'], 'checked_at': '2026-11-11T00:00:00Z', 'findings': [],
        }
        return snapshot

    def test_actual_audit_exports_current_discovery_and_policy_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            snapshot = self.actual_review_fixture(root)
            discovery = snapshot['review_context']['business_risk_review']['discovery_review']
            result = snapshot_auditor.audit(snapshot)
            self.assertEqual(result['verdict'], 'PASS', result)
            expected = {'task_id': discovery['task_id'], 'source_revision': discovery['source_revision'],
                        'discovery_sha256': self.digest(discovery)}
            current_policy = Path(snapshot_auditor.policy_source()['path'])
            self.assertEqual(result['discovery_binding'], expected)
            self.assertEqual(result['receipt']['discovery_binding'], expected)
            self.assertEqual(result['policy_sha256'], hashlib.sha256(current_policy.read_bytes()).hexdigest())
            self.assertEqual(result['receipt']['policy_sha256'], result['policy_sha256'])
            self.assertEqual(result['risk_locations'], [])
            self.assertEqual(result['receipt']['risk_locations'], [])
            discovery['scope'] += ' with a changed current research scope'
            changed = snapshot_auditor.audit(snapshot)
            self.assertEqual(changed['verdict'], 'PASS', changed)
            self.assertEqual(changed['document_sha256'], result['document_sha256'])
            self.assertNotEqual(changed['discovery_binding'], result['discovery_binding'])

    def test_shared_audit_binds_actual_source_not_outer_task_claim(self):
        # Reuse the existing complete shared-document fixture shape, supplying
        # its source with current offline discovery evidence before any audit.
        repo = Path(snapshot_auditor.__file__).resolve().parents[3]
        fixture_path = repo / 'tests' / 'repair' / 'test_team_visual_contract.py'
        spec = importlib.util.spec_from_file_location('_offline_shared_binding_fixture', fixture_path)
        module = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'argv', ['binding-test', '--repo', str(repo)]), patch.object(sys, 'dont_write_bytecode', True):
            spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as root:
            source = self.actual_review_fixture(root)
            source_discovery = source['review_context']['business_risk_review']['discovery_review']
            original = module.semantic_fixture

            def with_current_discovery(snapshot, source=False):
                original(snapshot, source=source)
                if source:
                    snapshot['review_context']['business_risk_review']['discovery_review'] = copy.deepcopy(source_discovery)

            with patch.object(module, 'semantic_fixture', side_effect=with_current_discovery):
                snapshot = module.fixture()
            snapshot['review_context']['business_risk_review'] = {
                'discovery_review': {'task_id': 'unrelated-outer-task', 'source_revision': 'wrong-source'}
            }
            result = snapshot_auditor.audit(snapshot)
            self.assertEqual(result['verdict'], 'PASS', result)
            expected = {'task_id': source_discovery['task_id'], 'source_revision': source_discovery['source_revision'],
                        'discovery_sha256': self.digest(source_discovery)}
            self.assertEqual(result['discovery_binding'], expected)
            self.assertEqual(result['receipt']['discovery_binding'], expected)
            self.assertEqual(result['source_audit']['discovery_binding'], expected)
            self.assertEqual(result['risk_locations'], [])
            self.assertEqual(result['receipt']['risk_locations'], [])
            self.assertEqual(result['policy_sha256'], snapshot_auditor.policy_source()['sha256'])
            self.assertEqual(result['receipt']['policy_sha256'], result['policy_sha256'])
            self.assertEqual(result['scope']['kind'], 'assigned_subject_only')
            self.assertFalse(result['receipt']['whole_team_complete'])

    def test_content_audit_pass_binds_full_items_without_challenge(self):
        snapshot = snapshot_auditor._selftest_fixture()
        # Offline wiring mocks isolate the content audit's digest contract.
        disclaimer = {'errors': [], 'blocked': [], 'info': [], 'text_sha256': 'a' * 64}
        business = {'verdict': 'PASS', 'errors': [], 'blocked': [], 'info': [],
                    'record_sha256': 'b' * 64, 'confirmed_hits': 0}
        with patch.object(snapshot_auditor, 'audit_disclaimer_review', return_value=disclaimer), \
             patch.object(snapshot_auditor, 'audit_business_risk_review', return_value=business):
            result = snapshot_auditor.audit(snapshot)
        self.assertEqual(result['verdict'], 'PASS', result)
        expected = self.digest(snapshot['block_list']['items'])
        self.assertEqual(result['document_sha256'], expected)
        self.assertEqual(result['receipt']['document_sha256'], expected)
        self.assertNotIn('client_challenge_review', snapshot['review_context'])

    def test_shared_audit_digest_keeps_assigned_subject_scope(self):
        snapshot = snapshot_auditor._selftest_fixture()
        snapshot['review_context']['document_mode'] = 'team_merge'
        scope = {'kind': 'assigned_subject_only', 'subjects': ['offline subject'], 'whole_team_complete': False}
        delegated = {'verdict': 'PASS', 'scope': scope,
                     'receipt': {'verdict': 'PASS', 'scope': 'assigned_subject_only', 'whole_team_complete': False}}
        with patch('team_merge_audit.audit_team', return_value=copy.deepcopy(delegated)):
            result = snapshot_auditor.audit(snapshot)
        expected = self.digest(snapshot['block_list']['items'])
        self.assertEqual(result['document_sha256'], expected)
        self.assertEqual(result['receipt']['document_sha256'], expected)
        self.assertEqual(result['scope'], scope)
        self.assertFalse(result['receipt']['whole_team_complete'])

    def test_shared_audit_does_not_create_pass_or_bind_incomplete_items(self):
        snapshot = snapshot_auditor._selftest_fixture()
        snapshot['review_context']['document_mode'] = 'team_merge'
        for has_more in (False, True):
            with self.subTest(has_more=has_more):
                snapshot['block_list']['has_more'] = has_more
                with patch('team_merge_audit.audit_team', return_value={'verdict': 'FAIL', 'errors': ['offline failure']}):
                    result = snapshot_auditor.audit(snapshot)
                self.assertEqual(result['verdict'], 'FAIL')
                self.assertNotIn('receipt', result)
                self.assertEqual('document_sha256' in result, not has_more)


if __name__ == '__main__':
    unittest.main()

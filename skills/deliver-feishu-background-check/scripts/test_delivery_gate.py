"""交付通过标志、过程说明及标准诊断不可被自报通过覆盖的回归测试。"""
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import validate_feishu_document as validator


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
            {'path': r'O:\背调\不存在的风险表.md', 'sha256': '0' * 64}
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


if __name__ == '__main__':
    unittest.main()

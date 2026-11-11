"""Synthetic full-snapshot acceptance for U08. No Feishu or browser access."""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import platform
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
PARSER = argparse.ArgumentParser()
PARSER.add_argument('--repo', required=True)
PARSER.add_argument('--out')
ARGS, REST = PARSER.parse_known_args()
REPO = Path(ARGS.repo).resolve()
SCRIPTS = REPO / 'skills/review-feishu-background-check/scripts'
os.environ['BACKGROUND_CHECK_WORKSPACE'] = str(REPO)
sys.path.insert(0, str(SCRIPTS))
_original_argv = sys.argv
try:
    # The production module explicitly supports this offline template mode.
    # Every document and review assertion below is synthetic.
    sys.argv = [sys.argv[0], '--self-test']
    import audit_feishu_snapshot as AUDIT
finally:
    sys.argv = _original_argv

MODULES = []
for number, rel in enumerate(('skills/review-feishu-background-check/scripts/team_merge_audit.py',
                              'tools/feishu-codex-bridge/team_merge_audit.py')):
    spec = importlib.util.spec_from_file_location(f'team_under_test_{number}', REPO / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    MODULES.append((rel, module))


def semantic_fixture(snapshot, source=False):
    """Explicit synthetic review assertions, never generated for real material."""
    context = snapshot['review_context']
    document, items = snapshot['document'], snapshot['block_list']['items']
    context['disclaimer_review'] = {
        'status': 'PASS', 'scope': 'full_document',
        'policy_version': AUDIT.DISCLAIMER_POLICY_VERSION,
        'token': AUDIT.review_document_token(document, items),
        'revision_id': document['revision_id'],
        'text_sha256': AUDIT.review_text_fingerprint(document, items, snapshot['raw_content']),
        'reviewer_id': 'synthetic-reviewer', 'checked_at': '2026-10-27T12:30:00Z', 'findings': [],
    }
    if source:
        context['business_risk_review'] = {
            'discovery_review': {
                'version': 1, 'mode': 'user_supplied', 'scope': 'offline team layout fixture',
                'instruction': 'Synthetic researched conclusions supplied only for document-format tests.',
                'source_ref': 'test_team_visual_contract.py#semantic_fixture',
            },
            'status': 'PASS', 'scope': 'current_business_risk_policy_and_full_document',
            'token': AUDIT.review_document_token(document, items),
            'revision_id': document['revision_id'], 'policy_sources': [AUDIT.policy_source()],
            'confirmed_hits': [], 'conflicts': [], 'reviewer_id': context['reviewer_id'],
            'checked_at': '2026-10-27T12:30:00Z',
        }


def refresh(snapshot):
    snapshot['raw_content'] = '\n'.join(AUDIT.text_of(item) for item in snapshot['block_list']['items'])
    semantic_fixture(snapshot)


def fixture():
    source = AUDIT._selftest_fixture()
    source['requestId'] = 'SYNTHETIC-U08-REQUEST'
    semantic_fixture(source, source=True)
    result = AUDIT.audit(source)
    if result['verdict'] != 'PASS':
        raise AssertionError({'synthetic_source_not_valid': result})
    by_source = {item['block_id']: item for item in source['block_list']['items']}
    source_root = next(item for item in by_source.values() if item['block_type'] == 1)
    start = next(i for i, ident in enumerate(source_root['children']) if AUDIT.text_of(by_source[ident]) == '基本信息')
    chosen = source_root['children'][start:]
    selected = set()

    def collect(ident):
        selected.add(ident)
        for child in by_source[ident].get('children', []):
            collect(child)

    for ident in chosen:
        collect(ident)
    token = 'SYNTHETIC-TEAM-U08'
    copied = []
    for original in source['block_list']['items']:
        if original['block_id'] not in selected:
            continue
        item = copy.deepcopy(original)
        item['block_id'] = 'copy-' + item['block_id']
        item['parent_id'] = token if item['parent_id'] == source_root['block_id'] else 'copy-' + item['parent_id']
        if 'children' in item:
            item['children'] = ['copy-' + ident for ident in item['children']]
        copied.append(item)

    heading = AUDIT._text_block('assigned-heading', '测试', 4)
    next_heading = AUDIT._text_block('next-heading', '另一主体', 4)
    outside = AUDIT._text_block('outside-text', '其他成员的内容')
    for item in (heading, next_heading, outside):
        item['parent_id'] = token
    root = {'block_id': token, 'block_type': 1, 'parent_id': '', 'page': {'elements': []},
            'children': [heading['block_id'], *['copy-' + ident for ident in chosen],
                         next_heading['block_id'], outside['block_id']]}
    current = {
        'requestId': source['requestId'], 'document': {'document_id': token, 'revision_id': 8, 'title': '合成团队文档'},
        'before_revision': 8, 'after_revision': 8,
        'block_list': {'has_more': False, 'items': [root, heading, *copied, next_heading, outside]},
        'review_context': {},
    }
    baseline = copy.deepcopy(current)
    baseline['document']['revision_id'] = 7
    baseline['block_list']['items'] = [copy.deepcopy(x) for x in (root, heading, next_heading, outside)]
    baseline['block_list']['items'][0]['children'] = ['assigned-heading', 'next-heading', 'outside-text']
    current['review_context'] = {
        'document_mode': 'team_merge', 'review_scope': 'assigned_subject_only',
        'overall_document_completion': 'NOT_ASSERTED_OTHER_MEMBERS', 'assigned_subjects': ['测试'],
        'reviewer_id': 'synthetic-reviewer',
        'team_merge_evidence': {'subject': '测试', 'assignment_code': 'TS', 'before_snapshot': baseline,
                               'approved_source_snapshot': source, 'start_heading_id': 'assigned-heading',
                               'next_heading_id': 'next-heading'},
        'visual_check': {
            'status': 'PASS', 'mode': 'fresh', 'token': token, 'revision_id': 8,
            'method': 'synthetic actual-view fixture', 'checked_at': '2026-10-27T12:30:00Z',
            'checks': {key: True for key in ('heading_levels', 'cards_and_grids', 'visible_platform_numbers', 'spacing', 'images')},
        },
    }
    refresh(current)
    return current


class VisualContract(unittest.TestCase):
    def setUp(self):
        self.payload = fixture()

    def results(self, payload=None):
        payload = self.payload if payload is None else payload
        results = []
        for location, module in MODULES:
            with self.subTest(copy=location):
                before = copy.deepcopy(payload)
                result = module.audit_team(payload, AUDIT.audit, vars(AUDIT))
                self.assertEqual(payload, before, 'read-only audit modified its input')
                results.append(result)
        return results

    def expect(self, expected, code=None, payload=None):
        for result in self.results(payload):
            self.assertEqual(result['verdict'], expected, result)
            self.assertEqual('receipt' in result, expected == 'PASS', result)
            if code:
                self.assertIn(code, {item['code'] for item in result['errors'] + result['blocked']}, result)

    def reused(self):
        first = self.results()[0]
        self.assertEqual(first['verdict'], 'PASS', first)
        self.payload['document']['revision_id'] = 9
        self.payload['before_revision'] = self.payload['after_revision'] = 9
        self.payload['review_context']['visual_check'] = {
            'status': 'PASS', 'mode': 'reuse_layout', 'token': self.payload['document']['document_id'],
            'revision_id': 9, 'method': 'scoped previous PASS and computed layout comparison',
            'checked_at': '2026-10-27T12:35:00Z', 'baseline_receipt': first['receipt'],
        }
        refresh(self.payload)
        return self.payload['review_context']['visual_check']['baseline_receipt']

    def test_fresh_without_saved_screenshot_passes(self):
        self.expect('PASS')
        for result in self.results():
            self.assertEqual(result['receipt']['requestId'], self.payload['requestId'])
            self.assertEqual(result['receipt']['scope'], 'assigned_subject_only')
            self.assertFalse(result['receipt']['whole_team_complete'])
            self.assertEqual(len(result['receipt']['assigned_layout_fingerprint']), 64)

    def test_handwritten_platform_numbers_cannot_replace_native_lists(self):
        sequence = 0
        for item in self.payload['block_list']['items']:
            if item.get('block_type') == 13:
                sequence += 1
                label = AUDIT.text_of(item)
                item.pop('ordered')
                item['block_type'] = 2
                item['text'] = {'elements': [{'text_run': {'content': f'{sequence}. {label}'}}]}
        self.assertEqual(sequence, 14)
        refresh(self.payload)
        self.expect('FAIL', 'TEAM_MERGE')

    def test_missing_optional_capture_does_not_erase_actual_viewing(self):
        self.payload['review_context']['visual_check']['screenshots'] = ['missing-optional-capture.png']
        self.expect('PASS')

    def test_missing_or_invalid_viewing_record_is_blocked(self):
        for record in (None, [], {}, {'status': 'PASS'}):
            p = copy.deepcopy(self.payload);p['review_context']['visual_check'] = record
            self.expect('BLOCKED', payload=p)

    def test_each_missing_actual_check_is_blocked(self):
        for key in self.payload['review_context']['visual_check']['checks']:
            p = copy.deepcopy(self.payload);p['review_context']['visual_check']['checks'].pop(key)
            self.expect('BLOCKED', 'VISUAL_CHECK_MISSING', p)

    def test_observed_visual_failure_is_fail(self):
        self.payload['review_context']['visual_check']['checks']['images'] = False
        self.expect('FAIL', 'VISUAL_CHECK_FAILED')

    def test_explicit_failed_visual_record_cannot_pass(self):
        self.payload['review_context']['visual_check']['status'] = 'FAIL'
        self.expect('FAIL', 'VISUAL_FAILED')

    def test_current_document_and_revision_are_required(self):
        for key, value in (('token', 'different-doc'), ('revision_id', 7), ('revision_id', True)):
            p = copy.deepcopy(self.payload);p['review_context']['visual_check'][key] = value
            self.expect('BLOCKED', 'VISUAL_REVISION', p)

    def test_explicit_other_subject_request_or_scope_is_rejected(self):
        for key, value in (('subjects', ['另一主体']), ('requestId', 'different-request'), ('scope', 'whole_document')):
            p = copy.deepcopy(self.payload);p['review_context']['visual_check'][key] = value
            self.expect('BLOCKED', 'VISUAL_SCOPE', p)

    def test_time_and_method_must_describe_viewing(self):
        for key, value in (('method', ''), ('checked_at', ''), ('checked_at', '2026-99-99T01:00:00Z')):
            p = copy.deepcopy(self.payload);p['review_context']['visual_check'][key] = value
            self.expect('BLOCKED', payload=p)

    def test_screenshots_when_explicitly_required_remain_required(self):
        self.payload['review_context']['visual_requirements'] = {
            'screenshots_required': True, 'requestId': self.payload['requestId'], 'instruction_source': 'synthetic current-task instruction'}
        self.expect('BLOCKED', 'VISUAL_FILES')
        with tempfile.TemporaryDirectory() as folder:
            shot = Path(folder) / 'synthetic-evidence.png';shot.write_bytes(b'synthetic fixture file')
            self.payload['review_context']['visual_check']['screenshots'] = [str(shot)]
            self.expect('PASS')

    def test_screenshot_requirement_must_bind_this_task(self):
        self.payload['review_context']['visual_requirements'] = {
            'screenshots_required': True, 'requestId': 'other-task', 'instruction_source': 'synthetic instruction'}
        self.expect('BLOCKED', 'VISUAL_REQUIREMENT_BINDING')

    def test_invalid_requirements_are_not_silently_ignored(self):
        for value in ('required', {'screenshots_required': 'true'}):
            p = copy.deepcopy(self.payload);p['review_context']['visual_requirements'] = value
            self.expect('BLOCKED', 'VISUAL_REQUIREMENTS', p)

    def test_same_assigned_layout_can_reuse_scoped_pass(self):
        self.reused();self.expect('PASS')

    def test_reused_layout_cannot_override_a_current_failed_observation(self):
        self.reused()
        self.payload['review_context']['visual_check']['checks'] = {'images': False}
        self.expect('FAIL', 'VISUAL_CHECK_FAILED')

    def test_boolean_snapshot_revisions_are_not_integer_revisions(self):
        with tempfile.TemporaryDirectory() as folder:
            shot = Path(folder) / 'synthetic-evidence.png';shot.write_bytes(b'synthetic fixture file')
            for key in ('document', 'before_revision', 'after_revision'):
                p = copy.deepcopy(self.payload)
                p['review_context']['visual_check']['screenshots'] = [str(shot)]
                if key == 'document':
                    p['document']['revision_id'] = True
                    p['before_revision'] = p['after_revision'] = True
                    p['review_context']['visual_check']['revision_id'] = 1
                else:
                    p['document']['revision_id'] = 1
                    p['before_revision'] = p['after_revision'] = 1
                    p[key] = True
                    p['review_context']['visual_check']['revision_id'] = 1
                refresh(p);self.expect('FAIL', 'TEAM_MERGE', p)
                for result in self.results(p):
                    self.assertTrue(any(item['actual'].startswith('REVISION:') for item in result['errors']), result)

    def test_only_text_change_preserves_assigned_layout_reuse(self):
        self.reused()
        source = self.payload['review_context']['team_merge_evidence']['approved_source_snapshot']
        original = next(x for x in source['block_list']['items'] if AUDIT.text_of(x) == '简介：测试')
        original['text']['elements'][0]['text_run']['content'] = '简介：合成文字更新'
        clone = next(x for x in self.payload['block_list']['items'] if x['block_id'] == 'copy-' + original['block_id'])
        clone['text'] = copy.deepcopy(original['text'])
        source['raw_content'] = '\n'.join(AUDIT.text_of(x) for x in source['block_list']['items'])
        semantic_fixture(source, source=True);refresh(self.payload)
        self.expect('PASS')

    def test_style_changes_require_fresh_viewing(self):
        self.reused()
        source = self.payload['review_context']['team_merge_evidence']['approved_source_snapshot']
        original = next(x for x in source['block_list']['items'] if AUDIT.text_of(x) == '简介：测试')
        original['text'].setdefault('style', {})['align'] = 2
        clone = next(x for x in self.payload['block_list']['items'] if x['block_id'] == 'copy-' + original['block_id'])
        clone['text'] = copy.deepcopy(original['text'])
        refresh(self.payload)
        self.expect('BLOCKED', 'VISUAL_LAYOUT_CHANGED')

    def test_document_container_style_changes_require_fresh_viewing(self):
        self.reused()
        baseline = self.payload['review_context']['team_merge_evidence']['before_snapshot']
        for snapshot in (self.payload, baseline):
            root = next(x for x in snapshot['block_list']['items'] if x['block_type'] == 1)
            root['page']['style'] = {'align': 2}
        refresh(self.payload)
        self.expect('BLOCKED', 'VISUAL_LAYOUT_CHANGED')

    def test_cross_scope_or_cross_request_baseline_cannot_be_reused(self):
        receipt = self.reused()
        for key, value in (('requestId', 'other-request'), ('subjects', ['另一主体']), ('token', 'other-doc'),
                           ('scope', 'whole_document'), ('whole_team_complete', True), ('verdict', 'FAIL')):
            p = copy.deepcopy(self.payload);p['review_context']['visual_check']['baseline_receipt'][key] = value
            self.expect('BLOCKED', 'VISUAL_BASELINE_SCOPE', p)

    def test_old_unscoped_receipt_requires_fresh_viewing(self):
        self.reused().pop('assigned_layout_fingerprint')
        self.expect('BLOCKED', 'VISUAL_LAYOUT_CHANGED')

    def test_future_equal_or_invalid_baseline_revision_is_blocked(self):
        self.reused()
        for value in (9, 10, 0, True, '8'):
            p = copy.deepcopy(self.payload);p['review_context']['visual_check']['baseline_receipt']['revision_id'] = value
            self.expect('BLOCKED', 'VISUAL_BASELINE_REVISION', p)

    def test_required_screenshots_do_not_reuse_old_view(self):
        self.reused()
        self.payload['review_context']['visual_requirements'] = {
            'screenshots_required': True, 'requestId': self.payload['requestId'], 'instruction_source': 'synthetic task'}
        self.expect('BLOCKED', 'VISUAL_SCREENSHOTS_REQUIRE_FRESH')

    def test_outside_blocks_are_still_protected(self):
        next(x for x in self.payload['block_list']['items'] if x['block_id'] == 'outside-text')['text']['elements'][0]['text_run']['content'] = 'changed outside'
        refresh(self.payload);self.expect('FAIL', 'TEAM_MERGE')

    def test_wrong_assigned_subject_still_fails(self):
        self.payload['review_context']['assigned_subjects'] = ['另一主体']
        self.expect('FAIL', 'TEAM_MERGE')

    def test_other_request_source_still_fails(self):
        self.payload['review_context']['team_merge_evidence']['approved_source_snapshot']['requestId'] = 'other-request'
        self.expect('FAIL', 'TEAM_MERGE')

    def test_partial_snapshot_still_fails(self):
        self.payload['block_list']['has_more'] = True
        self.expect('FAIL', 'TEAM_MERGE')

    def test_full_document_semantic_review_is_still_required(self):
        self.payload['review_context'].pop('disclaimer_review')
        self.expect('FAIL', 'TEAM_MERGE')

    def test_approved_source_is_reaudited(self):
        self.payload['review_context']['team_merge_evidence']['approved_source_snapshot']['review_context'].pop('business_risk_review')
        self.expect('FAIL', 'TEAM_MERGE')

    def test_production_copies_remain_identical(self):
        self.assertEqual((REPO / MODULES[0][0]).read_bytes(), (REPO / MODULES[1][0]).read_bytes())


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(VisualContract)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {
        'suite': 'U08 team visual contract', 'checked_at': datetime.now(timezone.utc).isoformat(),
        'repo': str(REPO), 'platform': platform.platform(), 'python': platform.python_version(),
        'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
        'passed': result.wasSuccessful(), 'both_production_copies_exercised': True,
        'source_audit': 'real deterministic single-report audit with explicit synthetic semantic evidence',
        'live_browser_used': False, 'external_accounts_used': False,
        'source_sha256': {rel: hashlib.sha256((REPO / rel).read_bytes()).hexdigest() for rel, _ in MODULES},
        'failed_tests': [{'name': str(test), 'traceback': trace} for test, trace in result.failures + result.errors],
    }
    if ARGS.out:
        out = Path(ARGS.out);out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    raise SystemExit(0 if result.wasSuccessful() else 1)

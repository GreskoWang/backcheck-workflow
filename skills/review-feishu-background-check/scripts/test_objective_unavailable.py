"""Real-source access closure through the full snapshot auditor (offline only)."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

import audit_feishu_snapshot as gate

DISCOVERY_SCRIPTS = Path(__file__).resolve().parents[2] / 'background-check-research' / 'scripts'
sys.path.insert(0, str(DISCOVERY_SCRIPTS))
from test_discovery_gate import empty_terms_fixture


class ObjectiveUnavailableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.snapshot = gate._selftest_fixture()
        self.proof_path = self.root / 'access.json'

    def bind_review(self, discovery=None):
        doc, data, context = gate.normalize_input(self.snapshot)
        token = gate.review_document_token(doc, data['items'])
        context['business_risk_review'] = {
            'status': 'PASS', 'scope': 'current_business_risk_policy_and_full_document',
            'token': token, 'revision_id': doc['revision_id'],
            'policy_sources': [gate.policy_source()], 'confirmed_hits': [], 'conflicts': [],
            'reviewer_id': 'independent-review-agent', 'checked_at': '2026-11-11T00:00:00Z',
            'discovery_review': discovery or {
                'version': 1, 'mode': 'user_supplied', 'scope': 'offline snapshot fixture',
                'instruction': 'Synthetic researched conclusions for module-contract tests.',
                'source_ref': 'test_objective_unavailable.py'},
        }
        self.snapshot['raw_content'] = '\n'.join(gate.text_of(b) for b in data['items'])
        context['disclaimer_review'] = {
            'status': 'PASS', 'scope': 'full_document',
            'policy_version': gate.DISCLAIMER_POLICY_VERSION,
            'token': token, 'revision_id': doc['revision_id'],
            'text_sha256': gate.review_text_fingerprint(doc, data['items'], self.snapshot['raw_content']),
            'reviewer_id': 'independent-review-agent', 'checked_at': '2026-11-11T00:00:00Z', 'findings': [],
        }

    def closed_module(self, platform='X', index=1, count_key='related_result_count'):
        context = self.snapshot['review_context']['platforms'][platform]
        module = context['modules'][index]
        old = module['text']
        match = gate.URL_RE.search(old)
        url = match.group(0) if match else 'https://x.com/fixture'
        new = old[:old.index(url) + len(url)] + ' 无问题' if match else '（1）个人主页：' + url + ' 无问题'
        module.update(text=new, status='objective_unavailable')
        in_platform = False
        for b in self.snapshot['block_list']['items']:
            if b.get('block_type') == 13:
                in_platform = gate.text_of(b) == platform
            if in_platform and gate.text_of(b) == old:
                before, after = new.split(url)
                b['text']['elements'] = [
                    {'text_run': {'content': before}},
                    {'text_run': {'content': url, 'text_element_style': {'link': {'url': url}}}},
                    {'text_run': {'content': after}},
                ]
        for row in context['expected_blocks']:
            if row.get('text') == old:
                row['text'] = new
        self.proof = {'source_ref': url, 'checked_at': '2026-11-11T00:00:00Z',
                      'access_outcome': 'objective_unavailable', 'access_reason': 'private',
                      'access_message': 'Only approved followers can view this account.',
                      'content_obtained': False, 'result_count': None}
        self.outcome = {'status': 'complete', 'kind': 'objective_unavailable',
                        'conclusion': '无问题', 'reason': 'Observed explicit platform privacy restriction.',
                        'evidence_refs': [url], 'evidence': {'path': str(self.proof_path), 'sha256': ''}}
        module['fact_evidence'] = {'source_type': 'research_record', 'source_locator': str(self.proof_path),
                                  'checked_at': self.proof['checked_at'], 'summary': self.outcome['reason'],
                                  count_key: None, 'terminal_outcome': self.outcome}
        self.write_proof()
        return module

    def write_proof(self):
        self.proof_path.write_text(json.dumps(self.proof), encoding='utf-8')
        self.outcome['evidence']['sha256'] = hashlib.sha256(self.proof_path.read_bytes()).hexdigest()

    def run_audit(self, discovery=None):
        self.bind_review(discovery)
        return gate.audit(self.snapshot)

    def assert_pass(self, result):
        self.assertEqual(result['verdict'], 'PASS', result['errors'] + result['blocked'])

    def assert_rejected(self):
        result = self.run_audit()
        self.assertNotEqual(result['verdict'], 'PASS')
        return result

    def test_fixture_is_valid(self):
        self.assert_pass(self.run_audit())

    def test_private_search_unknown_count_is_closed(self):
        self.closed_module()
        self.assert_pass(self.run_audit())

    def test_private_homepage_unknown_count_is_closed(self):
        self.closed_module(platform='Facebook', index=0, count_key='confirmed_homepage_count')
        self.assert_pass(self.run_audit())

    def test_unseen_x_homepage_does_not_require_invented_earliest_read_date(self):
        self.closed_module(index=0, count_key='confirmed_homepage_count')
        self.assert_pass(self.run_audit())

    def test_bilibili_still_requires_both_access_surfaces(self):
        self.closed_module(platform='B站')
        self.assert_rejected()

    def test_bilibili_both_confirmed_access_surfaces_can_close(self):
        module = self.closed_module(platform='B站')
        module['fact_evidence']['checked_surfaces'] = ['video', 'article']
        self.proof['checked_surfaces'] = ['video', 'article']
        self.write_proof()
        self.assert_pass(self.run_audit())

    def test_unbound_surface_self_report_is_rejected(self):
        module = self.closed_module(platform='B站')
        module['fact_evidence']['checked_surfaces'] = ['video', 'article']
        self.assert_rejected()

    def test_one_access_proof_cannot_close_a_second_url(self):
        module = self.closed_module()
        issue = gate._objective_unavailable_issue(module['fact_evidence'],
                    module['text'] + ' https://example.invalid/unchecked', 'related_result_count', 'X')
        self.assertIsNotNone(issue)

    def test_malformed_access_surface_is_rejected(self):
        module = self.closed_module(platform='B站')
        module['fact_evidence']['checked_surfaces'] = [{}]
        self.proof['checked_surfaces'] = ['video', 'article']; self.write_proof()
        self.assert_rejected()

    def test_other_search_unknown_count_is_closed(self):
        self.closed_module(platform='境外其他网站', index=0)
        self.assert_pass(self.run_audit())

    def test_empty_research_flows_into_final_audit(self):
        self.closed_module()
        # Distinct real evidence files: do not overwrite the acquisition proof.
        # Rebuild discovery after its evidence has a separate source path.
        source_dir = self.root / 'research'; source_dir.mkdir()
        discovery = empty_terms_fixture(source_dir, rows=[], terminal_kind='objective_unavailable')
        self.assert_pass(self.run_audit(discovery))

    def test_no_terms_research_flows_into_final_audit(self):
        discovery = empty_terms_fixture(self.root)
        self.assert_pass(self.run_audit(discovery))

    def test_confirmed_zero_material_flows_into_final_audit(self):
        discovery = empty_terms_fixture(self.root, rows=[], terminal_kind='no_results')
        self.assert_pass(self.run_audit(discovery))

    def test_hash_tampering_is_rejected(self):
        self.closed_module(); self.proof_path.write_text('{}', encoding='utf-8')
        self.assert_rejected()

    def test_missing_access_proof_is_rejected(self):
        self.closed_module(); self.proof_path.unlink()
        self.assert_rejected()

    def test_timeout_is_not_objective_unavailability(self):
        self.closed_module(); self.proof['access_reason'] = 'timeout'; self.write_proof()
        self.assert_rejected()

    def test_false_zero_is_not_unknown(self):
        module = self.closed_module(); module['fact_evidence']['related_result_count'] = 0
        self.assert_rejected()

    def test_source_mismatch_is_rejected(self):
        self.closed_module(); self.proof['source_ref'] = 'https://example.invalid/another-page'; self.write_proof()
        self.assert_rejected()

    def test_cannot_claim_unseen_body_was_obtained(self):
        self.closed_module(); self.proof['content_obtained'] = True; self.write_proof()
        self.assert_rejected()

    def test_unread_loaded_source_stays_incomplete(self):
        module = self.closed_module(); module['status'] = 'incomplete'
        self.assert_rejected()

    def test_legacy_unknown_count_is_not_auto_upgraded(self):
        module = self.closed_module(); module['status'] = 'checked_clean'
        self.assert_rejected()

    def test_closure_cannot_remove_existing_risk_status_requirement(self):
        self.closed_module()
        self.snapshot['review_context']['platforms']['X']['risk_items'] = [
            {'group_index': 1, 'fact_text': 'Previously acquired risk remains.', 'image_count': 1,
             'url': 'https://x.com/fixture/status/123456789'}]
        result = self.assert_rejected()
        self.assertTrue(any(x['code'] == 'RISK_STATUS_REQUIRED' for x in result['blocked']))


if __name__ == '__main__':
    unittest.main()

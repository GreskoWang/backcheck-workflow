"""Explicit historical-v2 replay tests, not current release behavior."""
"""Synthetic v2 integration tests: archive all terms, report sampled categories."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from client_challenge_gate import audit_client_challenge, document_sha256, discovery_sha256, _discovery_gate
from contextual_followup import post_key
from test_client_challenge_gate import fixture, write_json, binding


class ContextualFollowupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.review, self.discovery, self.items, self.policy = fixture(self.root)
        self.review['version'] = 2
        self.review.pop('inclusion')
        ledger = json.loads(Path(self.review['task_ledger']['path']).read_text(encoding='utf-8'))
        ledger['version'] = 2
        self.review['task_ledger'] = write_json(self.root / 'task-ledger.json', ledger)
        self.original_items = copy.deepcopy(self.items)
        self.items = self.items[:3]
        # The final fact deliberately omits the triggered proper noun.
        self.items[1]['text']['elements'][0]['text_run']['content'] = 'The subject complained about repeated advertisements in the original post.'
        self.sync_final()
        self.data = {
            'categories': [{'id': 'c1', 'platform': 'X', 'category': 'public-mention',
                'policy_excerpt': 'Synthetic public-mention policy.', 'recommended_count': 1,
                'selection_reason': 'One representative post sufficiently demonstrates the same repeated-ad complaint.',
                'examples': [{'batch_id': 'A', 'item_index': 0, 'source_url': 'https://example.invalid/post/1',
                    'summary': binding(self.items[0]), 'platform': binding(self.items[1]), 'link': binding(self.items[2])}]}],
            'terms': [{'id': 'n1', 'occurrences': [self.occurrence(0), self.occurrence(1)]}]
        }

    def sync_final(self, locations=None):
        ref = self.review['current_final_review']
        value = json.loads(Path(ref['path']).read_text(encoding='utf-8'))
        risks = locations if locations is not None else [{'risk_group_index': 0, 'summary_location': binding(self.items[0]), 'platform_location': binding(self.items[1])}]
        for obj in (value, value['receipt']):
            obj['document_sha256'] = document_sha256(self.items)
            obj['risk_locations'] = risks
        self.review['current_final_review'] = write_json(Path(ref['path']), value)

    def occurrence(self, index):
        source = self.discovery['semantic_review']['source_batches'][0]
        return {'batch_id': 'A', 'item_index': index, 'source_url': f'https://example.invalid/post/{index + 1}',
            'post_url': f'https://example.invalid/post/{index + 1}',
            'context': 'The original public post complains about repeated advertisements.',
            'attribution': 'The subject authored the complaint; the advertised name is a quoted title.',
            'checked_at': '2026-11-11T00:30:00Z', 'evidence': {k: source[k] for k in ('path', 'sha256')},
            'outcome': 'risk', 'category_ids': ['c1'],
            'reason': 'Selected representative.' if index == 0 else 'Same category and risk nature; representative quota reached; text archive only.'}

    def audit(self):
        self.review['followup'] = write_json(self.root / 'followup.json', self.data)
        return audit_client_challenge(self.review, discovery_review=self.discovery, items=self.items,
            document_token='synthetic-doc', revision_id=2, required_policy_path=self.policy, historical_v2=True)

    def fail(self, code):
        result = self.audit()
        self.assertEqual(result['verdict'], 'FAIL', result)
        self.assertIn('CHALLENGE_FOLLOWUP_' + code, {r['code'] for r in result['errors']}, result)

    def test_full_archive_sampled_report_without_term_in_body_passes(self):
        self.assertEqual(self.audit()['verdict'], 'PASS')
        self.assertEqual(len(self.data['terms'][0]['occurrences']), 2)
        self.assertEqual(len(self.data['categories'][0]['examples']), 1)

    def test_missing_triggered_term_is_not_excused_by_report_size(self):
        self.data['terms'] = []
        self.fail('COVERAGE')

    def test_missing_nonselected_occurrence_is_failure(self):
        self.data['terms'][0]['occurrences'].pop()
        self.fail('COVERAGE')

    def test_unknown_source_url_fails(self):
        self.data['terms'][0]['occurrences'][1]['source_url'] = 'https://example.invalid/fake'
        self.fail('SOURCE')

    def test_unrelated_original_post_fails(self):
        self.data['terms'][0]['occurrences'][1]['post_url'] = 'https://example.invalid/post/3'
        self.fail('ORIGINAL_POST')

    def test_no_context_fails(self):
        self.data['terms'][0]['occurrences'][1]['context'] = ''
        self.fail('CONTEXT')

    def test_archive_reason_is_required(self):
        self.data['terms'][0]['occurrences'][1]['reason'] = ''
        self.fail('CONTEXT')

    def test_pending_cannot_be_marked_complete(self):
        self.data['terms'][0]['occurrences'][1]['outcome'] = 'pending'
        self.fail('DISPOSITION')

    def test_final_review_must_follow_context_check(self):
        self.data['terms'][0]['occurrences'][1]['checked_at'] = '2026-11-11T02:00:00Z'
        self.fail('STALE_REVIEW')

    def test_objectively_unavailable_closes_without_public_mention(self):
        row = self.data['terms'][0]['occurrences'][1]
        row.update(outcome='objective_unavailable', category_ids=[], reason='Original page explicitly says deleted; closed as 无问题.')
        row['evidence'] = write_json(self.root / 'deleted.json', {'url': row['post_url'], 'text': 'This post was deleted.'})
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_nonempty_unavailable_term_crosses_discovery_challenge_and_archive_without_erasing_risk(self):
        gate = _discovery_gate()
        discovery = self.discovery
        source = discovery['semantic_review']['source_batches'][0]
        common = {key: discovery[key] for key in ('task_id', 'source_revision')}
        discovery.update(scope='Synthetic three-post source scope', source_refs=[source['path']], open_items=[],
            execution_review={'status': 'complete', 'source_revision': common['source_revision'],
                'applicable_steps': list(gate.MANDATORY_STAGES), 'skipped_steps': [],
                'steps': [{'step_id': stage, 'status': 'complete', 'evidence_refs': ['synthetic#' + stage]}
                          for stage in gate.MANDATORY_STAGES]})
        discovery['semantic_review'].update(status='complete', source_revision=common['source_revision'])
        for row in discovery['semantic_review']['items']:
            row.update(status='complete', summary='The subject mentions the named public production or event.')
        risk_fact = binding(self.items[1])['text']
        for index, entity in enumerate(discovery['entities']):
            entity.update(identity='Synthetic named public production or event', relation='The source mentions its title.',
                background_refs=entity['source_refs'][:], disposition='record' if index == 0 else 'clear',
                reason='The verified public mention matches the synthetic policy.' if index == 0 else 'No established policy hit.')
            if index == 0:
                entity.update(record_fact=risk_fact, alias_evidence=[{'alias': entity['aliases'][0], 'source_refs': entity['source_refs'][:]}])
        discovery['reverse_pass'] = {'status': 'complete', 'names': ['Qevira Stage', '奎维拉舞台', 'Orchid Festival']}
        discovery['acquisition_manifest'] = write_json(self.root / 'acquisition-manifest.json',
            {**common, 'source_batches': discovery['semantic_review']['source_batches']})
        sub = discovery['subagent_review']
        sub.update(**common, created_agent_ids=[sub['agent_id']], status='complete',
            spawn_ref='synthetic#research-spawn', result_ref='synthetic#research-result',
            receipt_path=str(self.root / 'research-receipt.json'))
        unavailable = self.data['terms'][0]['occurrences'][1]
        proof = write_json(self.root / 'deleted-access.json', {'source_ref': unavailable['post_url'],
            'checked_at': '2026-11-11T00:00:00Z', 'access_outcome': 'objective_unavailable',
            'access_reason': 'deleted', 'access_message': 'This post was deleted.',
            'content_obtained': False, 'result_count': None})
        terminal = {'status': 'complete', 'kind': 'objective_unavailable', 'conclusion': '无问题',
            'reason': 'The original page now explicitly reports deletion.',
            'evidence_refs': [unavailable['post_url']], 'evidence': proof}
        discovery['entities'][0]['terminal_outcome'] = terminal
        receipt = {'version': 2, **{key: sub[key] for key in ('agent_id', 'task_id', 'source_revision', 'status', 'spawn_ref', 'result_ref')},
            'acquisition_sha256': discovery['acquisition_manifest']['sha256'], 'reviews': [
                {'name': entity['name'], 'status': 'complete', 'conclusion': entity['reason'],
                 'queries': [] if index == 0 else [{'query': entity['name'], 'source_refs': entity['background_refs']}]}
                for index, entity in enumerate(discovery['entities'])]}
        receipt['reviews'][0]['terminal_outcome'] = terminal
        write_json(Path(sub['receipt_path']), receipt)
        upstream = gate.audit_discovery_review(discovery, reported_facts=[risk_fact])
        self.assertEqual(upstream['verdict'], 'PASS', upstream)
        unavailable.update(outcome='objective_unavailable', category_ids=[], evidence=proof,
            reason='Actual deletion is archived; the earlier established representative remains in the report.')
        for key in ('initial_final_review', 'current_final_review'):
            ref = self.review[key]
            audit = json.loads(Path(ref['path']).read_text(encoding='utf-8'))
            for obj in (audit, audit['receipt']):
                obj['discovery_binding'] = {**common, 'discovery_sha256': discovery_sha256(discovery)}
            self.review[key] = write_json(Path(ref['path']), audit)
        self.assertEqual(self.audit()['verdict'], 'PASS', self.audit())
        self.assertEqual(len(self.data['terms'][0]['occurrences']), 2)
        self.assertEqual(gate.audit_discovery_review(discovery, reported_facts=[])['verdict'], 'FAIL')
        self.data['categories'] = []
        self.assertEqual(self.audit()['verdict'], 'FAIL')

    def test_no_policy_hit_can_be_archived_without_any_public_risk(self):
        self.data['categories'] = []
        for row in self.data['terms'][0]['occurrences']:
            row.update(outcome='no_policy_hit', category_ids=[], reason='Original context describes an ordinary public title; no established policy category hit after review.')
        self.sync_final(locations=[])
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_dropping_distinct_risk_category_fails(self):
        self.data['terms'][0]['occurrences'][1]['category_ids'] = ['different-category']
        self.fail('DISPOSITION')

    def test_fake_policy_category_fails(self):
        self.data['categories'][0].update(category='Shen Yun', policy_excerpt='Shen Yun fictional policy')
        self.fail('POLICY')

    def test_same_category_cannot_restart_quota(self):
        extra = copy.deepcopy(self.data['categories'][0])
        extra['id'] = 'c2'
        self.data['categories'].append(extra)
        self.data['terms'][0]['occurrences'][1]['category_ids'] = ['c2']
        self.fail('DUPLICATE_CATEGORY')

    def test_recommendation_cannot_exceed_four(self):
        self.data['categories'][0]['recommended_count'] = 5
        self.fail('QUOTA')

    def test_actual_examples_cannot_exceed_selected_recommendation(self):
        self.data['categories'][0]['examples'] *= 2
        self.fail('QUOTA')

    def test_duplicate_post_does_not_count_twice(self):
        self.data['categories'][0]['recommended_count'] = 3
        self.data['categories'][0]['examples'] *= 2
        self.fail('DUPLICATE_EXAMPLE')

    def test_x_media_and_alias_urls_share_one_case(self):
        self.assertEqual(post_key('https://x.com/Name/status/123/photo/1'), post_key('https://twitter.com/name/status/123?x=1'))

    def test_old_extra_public_facts_cannot_evade_new_quota(self):
        self.items.extend(self.original_items[3:5])
        self.sync_final(locations=[{'risk_group_index': 0, 'summary_location': binding(self.items[0]), 'platform_location': binding(self.items[i])} for i in (1, 3)])
        self.fail('UNSELECTED_PUBLIC_FACT')

    def test_two_policy_categories_cannot_share_catchall_report_group(self):
        extra = copy.deepcopy(self.data['categories'][0])
        extra.update(id='c2', category='source context', policy_excerpt='Preserve concerns, source context and unknowns.')
        self.data['categories'].append(extra)
        self.data['terms'][0]['occurrences'][1]['category_ids'] = ['c2']
        self.fail('MERGED_CATEGORIES')

    def test_full_first_category_does_not_suppress_separate_second_category(self):
        # Analogue of a full LGBT category plus an independently classified
        # Shen Yun source: both keep their own report index and quota.
        self.items.extend(copy.deepcopy(self.original_items[3:5]))
        self.items.append({'block_id': 'summary2', 'text': {'elements': [{'text_run': {'content': 'A separate source context category.'}}]}})
        risks = [{'risk_group_index': 0, 'summary_location': binding(self.items[0]), 'platform_location': binding(self.items[1])},
                 {'risk_group_index': 1, 'summary_location': binding(self.items[5]), 'platform_location': binding(self.items[3])}]
        self.sync_final(locations=risks)
        extra = copy.deepcopy(self.data['categories'][0])
        extra.update(id='c2', category='source context', policy_excerpt='Preserve concerns, source context and unknowns.')
        extra['examples'] = [{'batch_id': 'A', 'item_index': 1, 'source_url': 'https://example.invalid/post/2',
            'summary': binding(self.items[5]), 'platform': binding(self.items[3]), 'link': binding(self.items[4])}]
        self.data['categories'].append(extra)
        self.data['terms'][0]['occurrences'][1].update(category_ids=['c2'], reason='Different policy category; select its own representative.')
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_stale_binding_fails(self):
        self.data['categories'][0]['examples'][0]['platform']['text'] = 'Stale public text'
        self.fail('RISK_PAIR')

    def test_tampered_archive_evidence_fails(self):
        self.data['terms'][0]['occurrences'][1]['evidence']['sha256'] = '0' * 64
        result = self.audit()
        self.assertIn('CHALLENGE_ARTIFACT_HASH', {r['code'] for r in result['errors']})

    def test_current_cli_rejects_historical_v2_records(self):
        self.audit()
        state = {'client_challenge_review': self.review, 'discovery_review': self.discovery, 'items': self.items,
            'document_token': 'synthetic-doc', 'revision_id': 2, 'required_policy_path': str(self.policy)}
        state_path = self.root / 'state.json'
        write_json(state_path, state)
        command = [sys.executable, str(Path(__file__).with_name('client_challenge_gate.py')), '--state', str(state_path)]
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("CHALLENGE_VERSION", result.stdout)
        self.data['terms'][0]['occurrences'].pop()
        self.audit()
        write_json(state_path, state)
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()

"""Offline synthetic workflow regressions for the current limited-knowledge loop."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from client_challenge_gate import audit_client_challenge, document_sha256, discovery_sha256, REJECTION
from test_client_challenge_gate import fixture as old_fixture, binding, write_json


def fixture(root):
    old, discovery, items, policy = old_fixture(root)
    discovery.pop('subagent_review')
    nouns = json.loads(Path(old['nouns']['path']).read_text(encoding='utf-8'))
    answer = json.loads(Path(old['rounds'][0]['answer']['path']).read_text(encoding='utf-8'))[0]
    for field in ('出现链接', '出现原文', '上下文'):
        answer[field] = answer[field][:1]
    answer['出现原文'] = ['mentioned Qevira Stage']
    answer['实际含义'] = 'Qevira Stage is the production title in this synthetic post.'
    items[1]['text']['elements'][0]['text_run']['content'] = 'The subject complained about repeated Qevira Stage advertisements.'
    items[3]['text']['elements'][0]['text_run']['content'] = 'A second post mentioned 奎维拉舞台 in an advertisement complaint.'
    review = {key: old[key] for key in ('task_id', 'source_revision', 'document_token', 'revision_id')}
    review.update(version=3, policy_path=str(policy), nouns=nouns,
                  child={key: val for key, val in old['child'].items() if key != 'proof'}, rounds=[], inclusions=[])
    for index, given, response in [(1, nouns, [{'id': 'n1', '态度': '警惕'}, {'id': 'n2', '态度': '放松'}, {'id': 'n3', '态度': '放松'}]),
                                  (2, [answer], [{'id': 'n1', '态度': '放松'}])]:
        review['rounds'].append({'index': index, 'agent_id': review['child']['agent_id'], 'input': copy.deepcopy(given),
            'input_ref': f'synthetic#input-{index}', 'response': response, 'result_ref': f'synthetic#response-{index}',
            'responded_at': f'2026-11-11T00:0{index + 1}:00Z'})
    review['inclusions'] = [{'id': 'n1', 'occurrences': [
        {'batch_id': 'A', 'item_index': index, 'source_url': f'https://example.invalid/post/{index + 1}',
         'kind': 'risk', 'summary': binding(items[0]), 'platform': binding(items[index * 2 + 1]),
         'link': binding(items[index * 2 + 2])} for index in (0, 1)]}]
    audit = json.loads(Path(old['current_final_review']['path']).read_text(encoding='utf-8'))
    audit['document']['title'] = 'Synthetic audit, not a real investigation'
    review['current_final_review'] = str(Path(root) / 'v3-final.json')
    refresh(review, discovery, items, audit)
    return review, discovery, items, policy, audit


def refresh(review, discovery, items, audit):
    for holder in (audit, audit['receipt']):
        holder['document_sha256'] = document_sha256(items)
        holder['discovery_binding'] = {'task_id': discovery['task_id'], 'source_revision': discovery['source_revision'],
                                       'discovery_sha256': discovery_sha256(discovery)}
        holder['risk_locations'] = [{'risk_group_index': 0, 'summary_location': binding(items[0]),
                                    'platform_location': binding(items[index])} for index in (1, 3, 5)]
    write_json(Path(review['current_final_review']), audit)


class CurrentChallengeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.review, self.discovery, self.items, self.policy, self.final = fixture(self.root)

    def audit(self):
        return audit_client_challenge(self.review, discovery_review=self.discovery, items=self.items,
            document_token='synthetic-doc', revision_id=2, required_policy_path=self.policy)

    def failure(self, code):
        result = self.audit()
        self.assertEqual(result['verdict'], 'FAIL', result)
        self.assertIn('CHALLENGE_' + code, {row['code'] for row in result['errors']}, result)

    def test_alert_then_relax_keeps_both_posts_without_query_or_round_hashes(self):
        Path(self.root / 'initial-final.json').unlink()
        result = self.audit()
        self.assertEqual(result['verdict'], 'PASS', result)
        self.assertEqual(result['ever_alert_ids'], ['n1'])

    def test_ever_alert_cannot_be_removed_after_relaxation(self):
        self.review['inclusions'] = []
        self.failure('INCLUSION_COVERAGE')

    def test_omitting_second_alert_post_without_same_category_binding_fails(self):
        self.review['inclusions'][0]['occurrences'].pop()
        self.failure('INCLUSION_COVERAGE')

    def omit_second_as_same_category(self):
        omitted=self.review['inclusions'][0]['occurrences'].pop()
        # Remove the unselected public case and URL; the first case remains.
        removed={omitted['platform']['block_id'],omitted['link']['block_id']}
        self.items[:] = [b for b in self.items if b['block_id'] not in removed]
        self.review['same_category_omissions'] = [{'id':'n1',
            'occurrences':[{'batch_id':'A','item_index':1}], 'risk_group_index':0,
            'summary':binding(self.items[0]), 'platform':binding(self.items[1]),
            'reviewer_id':self.discovery['primary_agent_id'],
            'basis':'Both original posts complain about repeated advertisements; the first is already represented.'}]
        for holder in (self.final,self.final['receipt']):
            holder['document_sha256']=document_sha256(self.items)
            holder['risk_locations']=[{'risk_group_index':0,'summary_location':binding(self.items[0]),
                                      'platform_location':binding(self.items[1])}]
        write_json(Path(self.review['current_final_review']),self.final)

    def test_same_category_warning_can_stay_internal_with_only_one_public_case(self):
        self.omit_second_as_same_category()
        result=self.audit()
        self.assertEqual(result['verdict'],'PASS',result)
        self.assertEqual(result['ever_alert_ids'],['n1'])

    def test_same_category_omission_needs_an_actual_audited_representative(self):
        self.omit_second_as_same_category()
        self.review['same_category_omissions'][0]['risk_group_index']=99
        self.failure('SAME_CATEGORY')

    def test_same_category_omission_cannot_leave_the_extra_link_in_public(self):
        self.omit_second_as_same_category()
        self.items.append({'block_id':'extra-link','block_type':2,'text':{'elements':[{'text_run':{'content':'https://example.invalid/post/2'}}]}})
        for holder in (self.final,self.final['receipt']):holder['document_sha256']=document_sha256(self.items)
        write_json(Path(self.review['current_final_review']),self.final)
        self.failure('SAME_CATEGORY_PUBLIC')

    def test_same_category_omission_does_not_skip_actual_reassessment(self):
        self.omit_second_as_same_category()
        self.review['rounds'].pop()
        self.failure('REASSESSMENT')

    def test_history_cannot_be_reset_to_empty(self):
        self.review['ever_alert_ids'] = []
        self.failure('HISTORY')

    def test_alert_cannot_be_relabelled_as_doubt_after_relaxation(self):
        self.review['inclusions'][0]['occurrences'][0]['kind'] = 'unresolved_doubt'
        self.failure('INCLUSION_KIND')

    def test_all_relaxed_stops_after_first_round(self):
        self.review['rounds'] = self.review['rounds'][:1]
        self.review['rounds'][0]['response'][0]['态度'] = '放松'
        self.review['inclusions'] = []
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_doubt_then_relax_needs_no_public_risk(self):
        self.review['rounds'][0]['response'][0]['态度'] = '疑问'
        self.review['inclusions'] = []
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def make_final_doubt(self):
        self.review['rounds'][0]['response'][0]['态度'] = '疑问'
        self.review['rounds'][1]['response'][0]['态度'] = '疑问'
        self.review['inclusions'] = []
        self.review['unresolved_items'] = [{'id': 'n1', 'known_facts': 'A production title appears in the post.',
            'unknown': 'The exact identity remains unknown.', 'source_refs': ['https://example.invalid/post/1'],
            'disposition': 'internal_only'}]

    def test_unknown_meaning_remains_internal_without_background_search(self):
        self.make_final_doubt()
        self.review['rounds'][1]['input'][0]['实际含义'] = 'The post uses this as a production name; further identity is unknown.'
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_final_doubt_cannot_be_published_as_a_pending_paragraph(self):
        public = copy.deepcopy(self.review['inclusions'])
        self.make_final_doubt()
        public[0]['occurrences'][0]['kind'] = 'unresolved_doubt'
        self.review['inclusions'] = public
        self.failure('INCLUSION')

    def test_final_doubt_requires_internal_record(self):
        self.make_final_doubt()
        self.review['unresolved_items'] = []
        self.failure('UNRESOLVED_INTERNAL')

    def test_final_doubt_rejects_unrelated_internal_source(self):
        self.make_final_doubt()
        self.review['unresolved_items'][0]['source_refs'] = ['https://example.invalid/unrelated']
        self.failure('UNRESOLVED_INTERNAL')

    def test_earlier_alert_does_not_publish_unresolved_doubt(self):
        self.make_final_doubt()
        self.review['rounds'][0]['response'][0]['态度'] = '警惕'
        result = self.audit()
        self.assertEqual(result['verdict'], 'PASS', result)
        self.assertEqual(result['ever_alert_ids'], ['n1'])

    def make_user_deletion(self):
        self.review['inclusions'] = []
        self.review['user_directed_exclusions'] = [{'id': 'n1',
            'occurrences': [{'batch_id': 'A', 'item_index': 0}, {'batch_id': 'A', 'item_index': 1}],
            'instruction': 'Remove this risk from the final report.', 'authorization_ref': 'synthetic-user-message#1'}]

    def test_explicit_user_deletion_preserves_history_without_republication(self):
        self.make_user_deletion()
        result = self.audit()
        self.assertEqual(result['verdict'], 'PASS', result)
        self.assertEqual(result['ever_alert_ids'], ['n1'])

    def test_deletion_without_actual_user_reference_fails(self):
        self.make_user_deletion()
        self.review['user_directed_exclusions'][0]['authorization_ref'] = ''
        self.failure('USER_EXCLUSION')

    def test_partial_user_deletion_does_not_excuse_other_posts(self):
        self.make_user_deletion()
        self.review['user_directed_exclusions'][0]['occurrences'].pop()
        self.failure('INCLUSION_COVERAGE')

    def test_initial_warning_requires_factual_reassessment(self):
        self.review['rounds'].pop()
        self.failure('REASSESSMENT')

    def test_second_round_must_not_resend_full_attitude_table(self):
        self.review['rounds'][1]['response'] += [{'id': 'n2', '态度': '放松'}]
        self.failure('RESPONSE_COVERAGE')

    def test_first_round_must_cover_all_words(self):
        self.review['rounds'][0]['response'].pop()
        self.failure('RESPONSE_COVERAGE')

    def test_first_input_cannot_contain_investigation_context(self):
        self.review['rounds'][0]['input'][0]['context'] = 'A preselected assessment'
        self.failure('FIRST_INPUT')

    def test_source_excerpt_may_be_short_but_not_invented(self):
        self.assertEqual(self.audit()['verdict'], 'PASS')
        self.review['rounds'][1]['input'][0]['出现原文'] = ['This claim never appeared.']
        self.failure('ANSWER_SOURCE')

    def test_answer_may_not_add_a_judgment_field(self):
        self.review['rounds'][1]['input'][0]['建议态度'] = '放松'
        self.failure('ANSWER')

    def test_unresolved_refusal_blocks_submission(self):
        self.review['rounds'][1]['response'] = [{'id': 'n1', '拒绝': REJECTION}]
        self.failure('FINAL_REJECTION')

    def test_fixed_refusal_can_be_corrected_with_same_child(self):
        self.review['rounds'][1]['response'] = [{'id': 'n1', '拒绝': REJECTION}]
        third = copy.deepcopy(self.review['rounds'][1])
        third.update(index=3, input_ref='synthetic#input-3', result_ref='synthetic#response-3', responded_at='2026-11-11T00:05:00Z',
                     response=[{'id': 'n1', '态度': '放松'}])
        third['input'][0]['实际含义'] = 'The wording identifies the production named in this source.'
        self.review['rounds'].append(third)
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_no_sixth_round_or_child_reset(self):
        self.review['rounds'] *= 3
        self.failure('ROUND_COUNT')

    def test_reusing_research_agent_is_rejected(self):
        self.review['child']['agent_id'] = self.discovery['primary_agent_id']
        self.failure('CHILD')

    def test_stale_document_is_rejected(self):
        self.items[0]['text']['elements'][0]['text_run']['content'] += ' changed'
        self.failure('FINAL_REVIEW_STALE')

    def test_risk_requires_audited_public_factual_location(self):
        self.review['inclusions'][0]['occurrences'][0]['platform'] = binding(self.items[2])
        self.failure('INCLUSION_RISK_SECTION')

    def test_original_links_cannot_be_substituted(self):
        self.review['inclusions'][0]['occurrences'][0]['source_url'] = 'https://example.invalid/unrelated'
        self.failure('INCLUSION_SOURCE')

    def test_actual_hyperlink_is_accepted(self):
        self.items[2]['text']['elements'][0]['text_run'] = {'content': '原帖', 'link': {'url': 'https://example.invalid/post/1'}}
        self.review['inclusions'][0]['occurrences'][0]['link'] = binding(self.items[2])
        refresh(self.review, self.discovery, self.items, self.final)
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_final_review_cannot_precede_reassessment(self):
        self.final['receipt']['generated_at'] = '2026-11-11T00:00:00Z'
        refresh(self.review, self.discovery, self.items, self.final)
        self.failure('FINAL_REVIEW_STALE')

    def test_cli_uses_current_v3_and_rejects_legacy(self):
        state = {'client_challenge_review': self.review, 'discovery_review': self.discovery, 'items': self.items,
                 'document_token': 'synthetic-doc', 'revision_id': 2, 'required_policy_path': str(self.policy)}
        path = self.root / 'state.json'
        for version, status in [(3, 0), (2, 1), (1, 1)]:
            state['client_challenge_review']['version'] = version
            write_json(path, state)
            run = subprocess.run([sys.executable, str(Path(__file__).with_name('client_challenge_gate.py')), '--state', str(path)], capture_output=True, encoding='utf-8')
            self.assertEqual(run.returncode, status, run.stdout + run.stderr)

    def test_malformed_inputs_fail_without_crash(self):
        for field in ('rounds', 'child', 'nouns', 'inclusions'):
            original = copy.deepcopy(self.review)
            self.review[field] = [None]
            self.assertEqual(self.audit()['verdict'], 'FAIL')
            self.review = original

    def test_optional_event_timestamps_do_not_require_invented_tool_metadata(self):
        self.review['child'].pop('spawned_at')
        for row in self.review['rounds']:
            row.pop('responded_at')
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_new_material_fact_can_reopen_previously_relaxed_term(self):
        answer = copy.deepcopy(self.review['rounds'][1]['input'][0])
        answer.update(被问词='Orchid Festival', 出现链接=['https://example.invalid/post/3'],
                      出现原文=['announced Orchid Festival'], 上下文=['The source announces a festival.'])
        self.review['rounds'].append({'index':3, 'agent_id':'challenge-child', 'input':[answer],
            'input_ref':'synthetic#input-3', 'response':[{'id':'n3', '态度':'警惕'}],
            'result_ref':'synthetic#response-3', 'responded_at':'2026-11-11T00:06:00Z'})
        self.review['inclusions'].append({'id':'n3', 'occurrences':[
            {'batch_id':'A', 'item_index':2, 'source_url':'https://example.invalid/post/3', 'kind':'risk',
             'summary':binding(self.items[0]), 'platform':binding(self.items[5]), 'link':binding(self.items[6])}]})
        self.assertEqual(self.audit()['verdict'], 'PASS')

    def test_unchanged_answers_are_not_repeated_to_reassure_client(self):
        third = copy.deepcopy(self.review['rounds'][1])
        third.update(index=3, input_ref='synthetic#input-3', result_ref='synthetic#response-3', responded_at='2026-11-11T00:06:00Z')
        self.review['rounds'].append(third)
        self.failure('REPEATED_ANSWER')

    def test_known_event_times_remain_ordered_across_missing_timestamp(self):
        self.review['rounds'][1].pop('responded_at')
        third = copy.deepcopy(self.review['rounds'][1])
        third.update(index=3, input_ref='synthetic#input-3', result_ref='synthetic#response-3', responded_at='2026-11-11T00:01:30Z')
        third['input'][0]['实际含义'] = 'An additional source detail clarifies this production title.'
        self.review['rounds'].append(third)
        self.failure('ORDER')


if __name__ == '__main__':
    unittest.main()

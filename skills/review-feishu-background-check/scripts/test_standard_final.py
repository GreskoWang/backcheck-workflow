"""Public final format cannot be extended through a self-declared manifest."""
import copy
import unittest
import audit_feishu_snapshot as a


class StandardFinalTests(unittest.TestCase):
    def setUp(self):
        self.s = a._selftest_fixture()
        self.items = self.s['block_list']['items']
        self.root = next(b for b in self.items if b['block_type'] == 1)

    def codes(self):
        return {x['code'] for x in a.audit(self.s)['errors']}

    def insert(self, text, before):
        block = a._text_block('new-extra', text)
        block['parent_id'] = self.root['block_id']
        self.items.append(block)
        target = next(b for b in self.items if a.text_of(b) == before)
        self.root['children'].insert(self.root['children'].index(target['block_id']), block['block_id'])

    def test_declaring_extra_paragraph_does_not_authorize_it(self):
        self.insert('已核实资料补充说明', 'B站')
        self.s['review_context']['platforms']['微博']['expected_blocks'].append({'kind':'text','text':'已核实资料补充说明'})
        self.assertIn('NONSTANDARD_PLATFORM_BLOCK', self.codes())

    def test_free_standing_extra_source_is_rejected(self):
        self.insert('https://example.invalid/unrelated', 'B站')
        self.s['review_context']['platforms']['微博']['expected_blocks'].append({'kind':'url','text':'https://example.invalid/unrelated'})
        self.assertIn('NONSTANDARD_PLATFORM_BLOCK', self.codes())

    def test_extra_basic_information_section_is_rejected(self):
        self.insert('其他说明：已读资料', '背调详情')
        self.assertIn('NONSTANDARD_BASIC_BLOCK', self.codes())

    def test_extra_preface_is_rejected(self):
        self.insert('调查范围说明', '风险摘要')
        self.assertIn('NONSTANDARD_TOP_BLOCK', self.codes())

    def test_pending_wording_is_rejected_inside_a_standard_card(self):
        block=next(b for b in self.items if a.text_of(b).startswith('简介：'))
        block['text']['elements'][0]['text_run']['content']='简介：账号归属待确认。'
        self.assertIn('FINAL_UNFINISHED_TEXT',self.codes())

    def test_standard_fixture_has_no_new_format_errors(self):
        self.assertFalse(self.codes() & {'NONSTANDARD_TOP_BLOCK','NONSTANDARD_BASIC_BLOCK','NONSTANDARD_PLATFORM_BLOCK','FINAL_UNFINISHED_TEXT'})

    def set_public_cases(self, count, image_count=1):
        self.s['review_context']['platforms']['微博']['risk_items']=[
            {'group_index':1,'fact_text':f'案例{i}的已核实行为。','image_count':image_count,
             'url':f'https://weibo.com/1234567/{i}','include_in_top':False} for i in range(count)]

    def test_four_selected_cases_do_not_exceed_the_limit(self):
        self.set_public_cases(4)
        self.assertNotIn('RISK_CASE_LIMIT',self.codes())

    def test_fifth_same_category_public_case_is_rejected(self):
        self.set_public_cases(5)
        self.assertIn('RISK_CASE_LIMIT',self.codes())

    def test_splitting_group_titles_does_not_reset_same_business_category_limit(self):
        self.set_public_cases(5)
        rows=self.s['review_context']['platforms']['微博']['risk_items']
        for i,row in enumerate(rows):row['group_index']=i+1
        self.s['review_context'].setdefault('business_risk_review',{})['confirmed_hits']=[
            {'business_item':'同一风险类别','verified_fact':row['fact_text']} for row in rows]
        self.assertIn('RISK_CASE_LIMIT',self.codes())

    def test_two_facts_from_same_post_do_not_count_as_two_cases(self):
        self.set_public_cases(5)
        rows=self.s['review_context']['platforms']['微博']['risk_items']
        rows[-1]['url']=rows[0]['url']
        self.assertNotIn('RISK_CASE_LIMIT',self.codes())

    def test_excluding_case_from_top_does_not_allow_image_free_public_prose(self):
        self.set_public_cases(1,image_count=0)
        self.assertIn('RISK_ITEM_IMAGE_REQUIRED',self.codes())

if __name__ == '__main__':
    unittest.main()

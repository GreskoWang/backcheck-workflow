import copy,json,tempfile,unittest,hashlib
from pathlib import Path
from source_excerpt_review import check_excerpt,source_triplets
from test_client_challenge_v3 import CurrentChallengeTests,refresh

class ExplicitSupplementTests(CurrentChallengeTests):
    def supplement(self):
        nouns=self.review['nouns'];self.review['rounds'][0]['input']=copy.deepcopy(nouns[:2]);self.review['rounds'][0]['response']=self.review['rounds'][0]['response'][:2]
        for n in (3,4,5):
            r=copy.deepcopy(self.review['rounds'][1]);r.update(index=n,input_ref=f'input-{n}',result_ref=f'result-{n}');r.pop('responded_at',None);r['input'][0]['实际含义']+=str(n);self.review['rounds'].append(r)
        self.review['rounds'].append(dict(index=6,agent_id=self.review['child']['agent_id'],input=[nouns[2]],response=[{'id':'n3','态度':'放松'}],input_ref='input-6',result_ref='result-6'))
        self.review['user_authorized_exception']={'request_id':self.discovery['task_id'],'authorization':'User explicitly permits one supplementary round for n3','authorization_ref':'synthetic user message','same_agent':self.review['child']['agent_id'],'history_preserved':True,'max_additional_rounds':1,'scope':['n3'],'actual_rounds':[6]}

    def test_authorized_supplement_keeps_original_first_round(self):
        self.supplement();self.assertEqual(self.audit()['verdict'],'PASS')

    def test_authorization_for_other_task_is_rejected(self):
        self.supplement();self.review['user_authorized_exception']['request_id']='other';self.failure('AUTHORIZATION')

    def test_future_supplement_cannot_hide_missing_initial_words(self):
        self.supplement();self.review['rounds'].pop();self.review['user_authorized_exception']['actual_rounds']=[];self.failure('AUTHORIZATION')

    def test_supplement_cannot_exceed_explicit_cap(self):
        self.supplement();self.review['rounds'].append(copy.deepcopy(self.review['rounds'][-1]));self.failure('AUTHORIZATION')

    def test_slash_grouped_alias_can_appear_individually(self):
        self.review['nouns'][0]['name']='Qevira Stage / alias';self.discovery['entities'][0]['name']='Qevira Stage / alias'
        # Keep every actual source spelling exported consistently.
        for row in self.discovery['semantic_review']['items']:
            row['names']=['Qevira Stage / alias' if x=='Qevira Stage' else x for x in row['names']]
        self.review['rounds'][0]['input'][0]['name']='Qevira Stage / alias';self.review['rounds'][1]['input'][0]['被问词']='Qevira Stage / alias'
        refresh(self.review,self.discovery,self.items,self.final)
        self.assertEqual(self.audit()['verdict'],'PASS')

class ExcerptMappingTests(unittest.TestCase):
    def test_only_actual_fragments_are_accepted(self):
        rows={('A',0):{'text':'first line\ncounts 123\nlast line','url':'https://example.invalid/1'}}
        proof={'original_url':rows[('A',0)]['url'],'original_excerpt':'first line\nlast line','reviewer_id':'reader','checked_at':'2026-11-14T00:00:00Z','semantic_review':'Checked both fragments and omitted counter','fragments':[{'batch_id':'A','item_index':0,'text':s} for s in ['first line','last line']]}
        kw=dict(excerpt=proof['original_excerpt'],url=proof['original_url'],source_rows=rows,source_texts=lambda r,s:[r['text']],source_urls=lambda r:{r['url']},base=Path('.'))
        self.assertTrue(check_excerpt(proof,**kw))
        proof['fragments'][1]['text']='invented';self.assertFalse(check_excerpt(proof,**kw))

    def test_array_mapping_must_cover_every_original_entry(self):
        a={'出现链接':['u'],'出现原文':['first','second'],'上下文':['context']}
        m={'reviewer_id':'reader','basis':'one page contains both quotes','entries':[[0,0,0],[0,1,0]]}
        self.assertEqual(len(source_triplets(a,m)),2)
        m['entries']=[[0,0,0],[0,0,0]];self.assertIsNone(source_triplets(a,m))

    def test_readback_hash_is_verified(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'source.json';p.write_text(json.dumps({'url':'u','text':'quote'}))
            e={'kind':'new_direct_readback','url':'u','path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
            proof={'original_url':'u','original_excerpt':'quote','reviewer_id':'r','checked_at':'t','semantic_review':'actual re-read','fragments':[{'text':'quote','evidence':e}]}
            kw=dict(excerpt='quote',url='u',source_rows={},source_texts=lambda r,s:[],source_urls=lambda r:set(),base=Path(d))
            self.assertTrue(check_excerpt(proof,**kw));p.write_text('{}');self.assertFalse(check_excerpt(proof,**kw))

if __name__=='__main__':unittest.main()

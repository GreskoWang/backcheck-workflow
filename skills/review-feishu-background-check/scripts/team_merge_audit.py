"""Read-only audit of assigned, risk-free sections in a complete shared snapshot.

The full snapshot is retained. This validates the approved source report again,
compares every copied block, and proves that all outside blocks are unchanged.
It does not certify other members' research or support risk-summary merging.
"""
import copy
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

VERSION = 'team-merge-1.0.0'

def audit_team(payload, single_audit, helpers):
    errors, blocked = [], []
    meta = payload.get('document', {})
    token, revision = meta.get('document_id'), meta.get('revision_id')
    rc = payload.get('review_context') or {}
    items = payload.get('block_list', {}).get('items', [])
    fingerprint = helpers['layout_fingerprint'](items) if items else ''
    source_result = None
    own_count = 0

    def require(value, code, message):
        if not value:
            raise ValueError(f'{code}: {message}')

    def tree(snapshot):
        data = snapshot.get('block_list', {})
        require(data.get('has_more') is False, 'PAGINATION', 'complete block list required')
        blocks = data.get('items', [])
        by = {b['block_id']: b for b in blocks}
        require(len(by) == len(blocks), 'DUPLICATE_ID', 'unique block ids required')
        pages = [b for b in blocks if b.get('block_type') == 1]
        require(len(pages) == 1, 'ROOT', 'one document page required')
        root = pages[0]
        visited = set()
        def walk(ident):
            require(ident in by and ident not in visited, 'TREE', 'missing, repeated or cyclic child')
            visited.add(ident)
            for child in by[ident].get('children', []):
                require(by.get(child, {}).get('parent_id') == ident, 'PARENT', 'child parent mismatch')
                walk(child)
        walk(root['block_id'])
        require(len(visited) == len(by), 'ORPHAN', 'all blocks must belong to the document tree')
        return by, root

    def descendants(by, ids):
        found = set()
        def walk(ident):
            found.add(ident)
            for child in by[ident].get('children', []): walk(child)
        for ident in ids: walk(ident)
        return found

    def normalized(by, ids, numbered=False):
        number = 0
        def norm(ident):
            nonlocal number
            b = copy.deepcopy(by[ident])
            children = b.pop('children', None)
            b.pop('block_id'); b.pop('parent_id', None)
            if numbered and b.get('block_type') == 13:
                number += 1
                title = helpers['text_of'](by[ident])
                b = {'block_type': 2, 'text': {'elements': [{'text_run': {'content': f'{number}. {title}', 'text_element_style': {'bold': False, 'inline_code': False, 'italic': False, 'strikethrough': False, 'underline': False}}}], 'style': {'align': 1, 'folded': False}}}
            for value in b.values():
                if isinstance(value, dict) and isinstance(value.get('style'), dict) and value['style'].get('indentation_level') == 'NoIndent':
                    value['style'].pop('indentation_level')
            if children: b['children'] = [norm(child) for child in children]
            return b
        return [norm(ident) for ident in ids]

    try:
        require(rc.get('document_mode') == 'team_merge', 'MODE', 'explicit team merge mode required')
        require(rc.get('review_scope') == 'assigned_subject_only', 'SCOPE', 'assigned subject scope required')
        require(rc.get('overall_document_completion', '').startswith('NOT_ASSERTED'), 'SCOPE_CLAIM', 'must not claim whole team complete')
        require(isinstance(revision, int) and revision > 0 and payload.get('before_revision') == revision == payload.get('after_revision'), 'REVISION', 'stable current revision required')
        contract = rc.get('team_merge_evidence', {})
        subject = contract.get('subject')
        require(isinstance(subject, str) and subject and rc.get('assigned_subjects') == [subject], 'SUBJECT', 'one explicit assigned subject required')
        require(contract.get('assignment_code') in ('TS', '临A', 'bk1'), 'ASSIGNMENT', 'local assignment required')
        baseline = contract.get('before_snapshot', {})
        source = contract.get('approved_source_snapshot', {})
        require(payload.get('requestId') and payload.get('requestId') == baseline.get('requestId') == source.get('requestId'), 'BATCH', 'all evidence must belong to the same requestId')
        require(source.get('review_context', {}).get('document_mode') != 'team_merge', 'SOURCE', 'independent source report required')
        require(source.get('document', {}).get('title', '').endswith('-' + subject), 'SOURCE_SUBJECT', 'source report subject mismatch')
        source_result = single_audit(source)
        require(source_result.get('verdict') == 'PASS', 'SOURCE_AUDIT', 'source must pass the current full single-report audit')
        require(source.get('review_context', {}).get('risk_groups') == [] and source_result.get('business_risk_review', {}).get('confirmed_hits') == 0, 'RISK_MERGE_UNSUPPORTED', 'risk-bearing sections require a separate verified risk-summary merger')
        by, root = tree(payload)
        old, oldroot = tree(baseline)
        src, srcroot = tree(source)
        require(root['block_id'] == oldroot['block_id'] == token, 'TOKEN', 'baseline and full snapshot must match target')
        start, end = contract.get('start_heading_id'), contract.get('next_heading_id')
        current_ids, old_ids = root['children'], oldroot['children']
        a, b = current_ids.index(start), current_ids.index(end)
        oa, ob = old_ids.index(start), old_ids.index(end)
        require(a < b and oa < ob, 'BOUNDARY', 'ordered section boundaries required')
        require(by[start].get('block_type') == 4 and helpers['text_of'](by[start]) == subject and by[end].get('block_type') == 4, 'HEADING', 'subject H2 and next-subject H2 required')
        require(not any(by[x].get('block_type') == 4 for x in current_ids[a + 1:b]), 'NESTED_SUBJECT', 'selected section cannot contain another subject')
        require(current_ids[:a] == old_ids[:oa] and current_ids[b:] == old_ids[ob:], 'OUTSIDE_ORDER', 'outside section root order changed')
        old_own = descendants(old, old_ids[oa:ob])
        own = descendants(by, current_ids[a:b]); own_count = len(own)
        outside = {k: v for k, v in old.items() if k not in old_own and k != token}
        require(outside == {k: v for k, v in by.items() if k not in own and k != token}, 'OUTSIDE_CONTENT', 'outside section blocks changed')
        require({k:v for k,v in root.items() if k != 'children'} == {k:v for k,v in oldroot.items() if k != 'children'}, 'ROOT_CHANGED', 'document root changed')
        src_ids = srcroot['children']
        basic = [i for i,k in enumerate(src_ids) if src[k].get('block_type') == 5 and helpers['text_of'](src[k]) == '基本信息']
        require(len(basic) == 1, 'SOURCE_STRUCTURE', 'one basic-information heading required')
        expected = normalized(src, src_ids[basic[0]:], True)
        require(normalized(by, current_ids[a + 1:b]) == expected, 'COPIED_CONTENT', 'assigned section differs from the approved complete source')
        disclaimer = helpers['audit_disclaimer_review'](meta, items, payload.get('raw_content'), rc.get('disclaimer_review'))
        require(not disclaimer['errors'] and not disclaimer['blocked'], 'FULL_TEXT_REVIEW', 'current whole-document disclaimer semantic review required')
        visual = rc.get('visual_check', {})
        require(visual.get('status') == 'PASS' and visual.get('mode') == 'fresh' and visual.get('token') == token and visual.get('revision_id') == revision, 'VISUAL_REVISION', 'fresh actual visual pass for this shared revision required')
        require(visual.get('method') and visual.get('checked_at'), 'VISUAL_RECORD', 'viewing method and time required')
        require(all(visual.get('checks', {}).get(k) is True for k in ('heading_levels', 'cards_and_grids', 'visible_platform_numbers', 'spacing', 'images')), 'VISUAL_CHECKS', 'all assigned-section layout checks required')
        require(visual.get('screenshots') and all(Path(s).is_file() for s in visual['screenshots']), 'VISUAL_FILES', 'actual screenshots required')
        require(rc.get('reviewer_id'), 'REVIEWER', 'reviewer id required')
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        errors.append({'code': 'TEAM_MERGE', 'location': 'team_merge_evidence', 'actual': str(exc), 'expected': 'verified complete assigned section and unchanged outside blocks'})

    verdict = 'FAIL' if errors else 'PASS'
    result = {'schema_version': 1, 'script_version': VERSION, 'verdict': verdict,
        'document': {'title': meta.get('title'), 'token': token, 'revision_id': revision},
        'scope': {'kind': 'assigned_subject_only', 'subjects': rc.get('assigned_subjects'), 'whole_team_complete': False},
        'stats': {'blocks': len(items), 'assigned_blocks': own_count, 'platform_titles': 14 if not errors else 0, 'errors': len(errors), 'blocked': len(blocked)},
        'visual': {'verdict': verdict, 'mode': 'fresh', 'layout_fingerprint': fingerprint},
        'errors': errors, 'blocked': blocked, 'info': ['Other members are preserved, not certified.']}
    if source_result: result['source_audit'] = {k: source_result.get(k) for k in ('verdict', 'document', 'business_risk_review')}
    if not errors:
        result['receipt'] = {'token': token, 'revision_id': revision, 'verdict': 'PASS', 'script_version': VERSION,
            'reviewer_id': rc['reviewer_id'], 'layout_fingerprint': fingerprint, 'scope': 'assigned_subject_only',
            'subjects': rc['assigned_subjects'], 'whole_team_complete': False,
            'evidence_sha256': hashlib.sha256(json.dumps(rc['team_merge_evidence'], sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            'generated_at': datetime.now(timezone.utc).isoformat()}
    return result

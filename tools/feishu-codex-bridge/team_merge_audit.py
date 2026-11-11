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

VERSION = 'team-merge-1.2.0'


def audit_team_visual(visual, requirements, *, request_id, token, revision,
                      subjects, assigned_fingerprint):
    """Validate a scoped viewing record; saving an image is a separate requirement."""
    errors, blocked = [], []

    def block(code, message):
        blocked.append({'code': code, 'location': 'review_context.visual_check',
                        'actual': message, 'expected': 'current assigned-section visual evidence'})

    def fail(code, message):
        errors.append({'code': code, 'location': 'review_context.visual_check',
                       'actual': message, 'expected': 'all observed layout checks pass'})

    if not isinstance(visual, dict):
        block('VISUAL_CONTEXT', 'visual record is missing or invalid')
        visual = {}
    mode = visual.get('mode')
    if visual.get('status') == 'FAIL':
        fail('VISUAL_FAILED', 'the recorded visual inspection failed')
    elif visual.get('status') != 'PASS':
        block('VISUAL_STATUS', 'a completed visual PASS is required')
    if mode not in ('fresh', 'reuse_layout'):
        block('VISUAL_MODE', 'fresh or reuse_layout is required')
    if visual.get('token') != token or type(visual.get('revision_id')) is not int or visual.get('revision_id') != revision:
        block('VISUAL_REVISION', 'record must bind the current document and exact revision')
    # The containing team contract already binds a fresh record to the assigned
    # subject. Reject conflicting explicit bindings without breaking old fresh
    # records that did not repeat the outer contract.
    bindings = {'requestId': request_id, 'scope': 'assigned_subject_only', 'subjects': subjects}
    if any(key in visual and visual[key] != value for key, value in bindings.items()):
        block('VISUAL_SCOPE', 'visual record conflicts with the current task or assigned subject')
    if not isinstance(visual.get('method'), str) or not visual['method'].strip():
        block('VISUAL_METHOD', 'viewing method is required')
    try:
        timestamp = visual.get('checked_at')
        if not isinstance(timestamp, str) or 'T' not in timestamp:
            raise ValueError('timestamp')
        datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
    except ValueError:
        block('VISUAL_TIME', 'a valid ISO-8601 viewing timestamp is required')

    checks = visual.get('checks', {})
    if not isinstance(checks, dict):
        block('VISUAL_CHECKS', 'provided checks must be an object')
        checks = {}
    required_checks = ('heading_levels', 'cards_and_grids', 'visible_platform_numbers', 'spacing', 'images')
    for key in required_checks:
        if checks.get(key) is False:
            fail('VISUAL_CHECK_FAILED', f'observed layout check failed: {key}')
    if mode == 'fresh':
        for key in required_checks:
            if checks.get(key) is not True and checks.get(key) is not False:
                block('VISUAL_CHECK_MISSING', f'actual viewing result is missing: {key}')
    elif mode == 'reuse_layout':
        receipt = visual.get('baseline_receipt')
        if not isinstance(receipt, dict):
            block('VISUAL_BASELINE', 'an earlier scoped team PASS receipt is required')
        else:
            expected = {'verdict': 'PASS', 'token': token, 'requestId': request_id,
                        'scope': 'assigned_subject_only', 'subjects': subjects,
                        'whole_team_complete': False}
            if any(receipt.get(key) != value for key, value in expected.items()):
                block('VISUAL_BASELINE_SCOPE', 'baseline task, document, subject or verdict does not match')
            previous_revision = receipt.get('revision_id')
            if type(previous_revision) is not int or not 0 < previous_revision < revision:
                block('VISUAL_BASELINE_REVISION', 'baseline must refer to an earlier positive revision')
            if not receipt.get('reviewer_id') or not receipt.get('evidence_sha256'):
                block('VISUAL_BASELINE_RECEIPT', 'baseline lacks its audit provenance')
            if receipt.get('assigned_layout_fingerprint') != assigned_fingerprint:
                block('VISUAL_LAYOUT_CHANGED', 'assigned section layout differs or the old receipt has no scoped fingerprint')

    if requirements is None:
        requirements = {}
    if not isinstance(requirements, dict):
        block('VISUAL_REQUIREMENTS', 'visual requirements must be an object')
        requirements = {}
    required = requirements.get('screenshots_required', False)
    if type(required) is not bool:
        block('VISUAL_REQUIREMENTS', 'screenshots_required must be boolean')
    elif required:
        if requirements.get('requestId') != request_id or not isinstance(requirements.get('instruction_source'), str) or not requirements['instruction_source'].strip():
            block('VISUAL_REQUIREMENT_BINDING', 'required screenshots need this task and its instruction source')
        if mode != 'fresh':
            block('VISUAL_SCREENSHOTS_REQUIRE_FRESH', 'explicit current-task screenshot requirement needs a fresh record')
        shots = visual.get('screenshots')
        try:
            present = isinstance(shots, list) and bool(shots) and all(isinstance(p, str) and bool(p) and Path(p).is_file() for p in shots)
        except (OSError, ValueError):
            present = False
        if not present:
            block('VISUAL_FILES', 'explicitly required screenshot files are missing')
    return {'errors': errors, 'blocked': blocked, 'mode': mode}

def audit_team(payload, single_audit, helpers):
    errors, blocked = [], []
    meta = payload.get('document', {})
    token, revision = meta.get('document_id'), meta.get('revision_id')
    rc = payload.get('review_context') or {}
    items = payload.get('block_list', {}).get('items', [])
    fingerprint = helpers['layout_fingerprint'](items) if items else ''
    source_result = None
    own_count = 0
    assigned_fingerprint = ''
    visual_mode = None

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

    def normalized(by, ids):
        def norm(ident):
            b = copy.deepcopy(by[ident])
            children = b.pop('children', None)
            b.pop('block_id'); b.pop('parent_id', None)
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
        require(type(revision) is int and revision > 0
                and type(payload.get('before_revision')) is int
                and type(payload.get('after_revision')) is int
                and payload['before_revision'] == revision == payload['after_revision'],
                'REVISION', 'stable positive integer current revision required')
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
        expected = normalized(src, src_ids[basic[0]:])
        require(normalized(by, current_ids[a + 1:b]) == expected, 'COPIED_CONTENT', 'assigned section differs from the approved complete source')
        disclaimer = helpers['audit_disclaimer_review'](meta, items, payload.get('raw_content'), rc.get('disclaimer_review'))
        require(not disclaimer['errors'] and not disclaimer['blocked'], 'FULL_TEXT_REVIEW', 'current whole-document disclaimer semantic review required')
        # Include root child order: hashing only the descendant blocks would miss
        # reordered sibling sections because layout_fingerprint sorts block ids.
        assigned_root = copy.deepcopy(root)
        assigned_root['children'] = current_ids[a:b]
        assigned_layout = {'root': helpers['layout_fingerprint']([assigned_root]),
                           'blocks': helpers['layout_fingerprint']([item for item in items if item['block_id'] in own])}
        assigned_fingerprint = hashlib.sha256(json.dumps(assigned_layout, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        visual_result = audit_team_visual(rc.get('visual_check'), rc.get('visual_requirements'),
                                          request_id=payload['requestId'], token=token, revision=revision,
                                          subjects=rc['assigned_subjects'], assigned_fingerprint=assigned_fingerprint)
        errors.extend(visual_result['errors']); blocked.extend(visual_result['blocked'])
        visual_mode = visual_result['mode']
        require(rc.get('reviewer_id'), 'REVIEWER', 'reviewer id required')
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        errors.append({'code': 'TEAM_MERGE', 'location': 'team_merge_evidence', 'actual': str(exc), 'expected': 'verified complete assigned section and unchanged outside blocks'})

    verdict = 'FAIL' if errors else 'BLOCKED' if blocked else 'PASS'
    result = {'schema_version': 1, 'script_version': VERSION, 'verdict': verdict,
        'document': {'title': meta.get('title'), 'token': token, 'revision_id': revision},
        'scope': {'kind': 'assigned_subject_only', 'subjects': rc.get('assigned_subjects'), 'whole_team_complete': False},
        'stats': {'blocks': len(items), 'assigned_blocks': own_count, 'platform_titles': 14 if not errors else 0, 'errors': len(errors), 'blocked': len(blocked)},
        'visual': {'verdict': verdict, 'mode': visual_mode, 'layout_fingerprint': fingerprint,
                   'assigned_layout_fingerprint': assigned_fingerprint},
        'errors': errors, 'blocked': blocked, 'info': ['Other members are preserved, not certified.']}
    binding_fields = ('discovery_binding', 'policy_sha256', 'risk_locations')
    if source_result:
        result['source_audit'] = {k: copy.deepcopy(source_result.get(k)) for k in
                                  ('verdict', 'document', 'business_risk_review', *binding_fields)}
        # Only the actually audited assigned source supplies task identity. The
        # shared document's other members and outer self-declarations do not.
        if source_result.get('verdict') == 'PASS':
            result.update({key: copy.deepcopy(source_result.get(key)) for key in binding_fields})
    if verdict == 'PASS':
        result['receipt'] = {'token': token, 'revision_id': revision, 'verdict': 'PASS', 'script_version': VERSION,
            'reviewer_id': rc['reviewer_id'], 'layout_fingerprint': fingerprint, 'scope': 'assigned_subject_only',
            'subjects': rc['assigned_subjects'], 'whole_team_complete': False,
            'requestId': payload['requestId'], 'assigned_layout_fingerprint': assigned_fingerprint,
            'evidence_sha256': hashlib.sha256(json.dumps(rc['team_merge_evidence'], sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            'generated_at': datetime.now(timezone.utc).isoformat()}
        result['receipt'].update({key: copy.deepcopy(result.get(key)) for key in binding_fields})
    return result

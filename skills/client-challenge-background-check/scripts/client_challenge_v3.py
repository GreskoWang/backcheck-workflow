"""Lightweight attitude loop. Historical warnings always require public coverage.

No network, per-term query receipts, per-round hashes or pre-challenge final audit.
The caller still supplies the real latest final audit and complete document blocks.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any
from source_excerpt_review import check_excerpt, source_triplets

LABELS = {"放松", "疑问", "警惕"}
REJECTION = "包含不合规的表述，拒绝接受"
FIELDS = {"被问词", "出现链接", "出现原文", "上下文", "释义词所指代的对象", "实际含义"}


def text(value):
    return isinstance(value, str) and bool(value.strip())


def audit_v3(review: Any, *, discovery_review: Any, items: Any,
             document_token: Any, revision_id: Any, required_policy_path: Path,
             base_dir: Path | None, helpers: dict) -> dict:
    errors, blocked = [], []
    ever, final_doubts = set(), set()
    base = Path(base_dir or Path.cwd())
    digest, norm = helpers['digest'], helpers['name']

    def fail(code, location, actual, expected, inaccessible=False):
        (blocked if inaccessible else errors).append({
            'code': 'CHALLENGE_' + code, 'location': 'client_challenge_review' + location,
            'actual': str(actual), 'expected': expected})

    def result():
        return {'verdict': 'FAIL' if errors else 'BLOCKED' if blocked else 'PASS',
                'errors': errors, 'blocked': blocked,
                'info': ['v3: complete initial nouns, incremental factual reassessment, permanent public coverage of every historical warning. Semantic accuracy and actual agent activity require real review.'],
                'ever_alert_ids': sorted(ever), 'triggered_term_ids': sorted(ever | final_doubts)}

    def read(ref, loc, *, raw=False):
        value = ref.get('path') if isinstance(ref, dict) else ref
        if not text(value):
            fail('FILE', loc, ref, 'actual existing file path; per-round hash not required')
            return None
        try:
            path = Path(value)
            path = path if path.is_absolute() else base / path
            data = path.read_bytes()
            if isinstance(ref, dict) and 'sha256' in ref and hashlib.sha256(data).hexdigest() != ref['sha256']:
                fail('SOURCE_CHANGED', loc, value, 'existing source hash matches; no invented receipt')
            return data if raw else json.loads(data.decode('utf-8-sig'))
        except FileNotFoundError:
            fail('FILE', loc, value, 'existing actual evidence')
        except OSError as exc:
            fail('FILE_ACCESS', loc, exc, 'readable evidence', inaccessible=True)
        except (ValueError, TypeError, UnicodeError) as exc:
            fail('FILE', loc, exc, 'valid UTF-8 JSON evidence')
        return None

    def payload(value, loc):
        return read(value, loc) if isinstance(value, str) or isinstance(value, dict) and 'path' in value else value

    def stamp(value, loc):
        if value is None:
            return None
        try:
            dt = datetime.fromisoformat(value.replace('Z', '+00:00')) if text(value) else None
            if dt is None or dt.utcoffset() is None:
                raise ValueError('timezone required')
            return dt
        except (ValueError, TypeError, OverflowError):
            fail('TIME', loc, value, 'actual timestamp with timezone')

    if not isinstance(review, dict) or type(review.get('version')) is not int or review['version'] != 3:
        fail('VERSION', '.version', review.get('version') if isinstance(review, dict) else review,
             '3 for current release; v1/v2 only for explicit historical replay')
        return result()
    discovery = discovery_review if isinstance(discovery_review, dict) else {}
    if discovery.get('mode') != 'assistant_research':
        fail('DISCOVERY', '', discovery.get('mode'), 'actual investigation source record')
    for field, expected in [('task_id', discovery.get('task_id')), ('source_revision', discovery.get('source_revision')),
                            ('document_token', document_token), ('revision_id', revision_id)]:
        if review.get(field) != expected or type(review.get(field)) is not type(expected) or expected is None:
            fail('BINDING', '.' + field, review.get(field), 'same current task/source/document: ' + str(expected))

    policy_ref = review.get('policy_path')
    try:
        policy_path = Path(policy_ref) if text(policy_ref) else None
        policy_path = (policy_path if policy_path.is_absolute() else base / policy_path) if policy_path else None
        if policy_path is None or policy_path.resolve() != Path(required_policy_path).resolve():
            fail('POLICY_PATH', '.policy_path', policy_ref, 'current required policy path')
    except (ValueError, OSError):
        fail('POLICY_PATH', '.policy_path', policy_ref, 'valid current required policy path')
    policy_bytes = read(policy_ref, '.policy_path', raw=True)
    policy_hash = hashlib.sha256(policy_bytes).hexdigest() if isinstance(policy_bytes, bytes) else None

    entities = discovery.get('entities', [])
    entities = entities if isinstance(entities, list) else []
    name_entity, export_names = {}, []
    for index, entity in enumerate(entities):
        if not isinstance(entity, dict):
            fail('NOUN_EXPORT', '.entities', entity, 'source-grounded noun records')
            continue
        aliases = entity.get('aliases', [])
        if not isinstance(aliases, list):
            fail('NOUN_EXPORT', '.aliases', aliases, 'source spellings as a list')
            aliases = []
        for name in [entity.get('name')] + aliases:
            if not text(name) or norm(name) in name_entity and name_entity[norm(name)] != index:
                fail('NOUN_EXPORT', '.entities', name, 'unique actual source spelling or disambiguated name')
                continue
            name_entity[norm(name)] = index
            export_names.append(name)
    nouns = payload(review.get('nouns'), '.nouns')
    if not isinstance(nouns, list):
        fail('NOUN_EXPORT', '.nouns', nouns, 'complete list of {id,name}')
        nouns = []
    names, ids, term_entity = {}, [], {}
    for row in nouns:
        if not isinstance(row, dict) or set(row) != {'id', 'name'} or not text(row.get('id')) or not text(row.get('name')):
            fail('NOUN_EXPORT', '.nouns', row, 'only id and name')
            continue
        if row['id'] in ids or row['name'] in names or norm(row['name']) not in name_entity:
            fail('NOUN_EXPORT', '.nouns', row, 'each actual source name once with unique stable ID')
            continue
        ids.append(row['id'])
        names[row['name']] = row['id']
        term_entity[row['id']] = name_entity[norm(row['name'])]
    if set(names) != set(export_names):
        fail('NOUN_EXPORT', '.nouns', list(names), 'all extracted source names and aliases, without risk filtering')

    semantic = discovery.get('semantic_review', {})
    semantic = semantic if isinstance(semantic, dict) else {}
    sources, occurrences = {}, {i: set() for i in range(len(entities))}
    for batch in semantic.get('source_batches', []):
        if not isinstance(batch, dict) or not text(batch.get('batch_id')) or not text(batch.get('items_key')):
            fail('SOURCES', '.source_batches', batch, 'actual source batch mapping')
            continue
        raw = read(batch, '.source_batches')
        rows = raw.get(batch['items_key']) if isinstance(raw, dict) else None
        if not isinstance(rows, list):
            fail('SOURCES', '.source_batches', batch, 'actual source rows')
            continue
        for index, row in enumerate(rows):
            pair = (batch['batch_id'], index)
            if pair in sources:
                fail('SOURCES', '.source_batches', pair, 'each source occurrence once')
            sources[pair] = row
    seen = set()
    for row in semantic.get('items', []):
        if not isinstance(row, dict) or not text(row.get('batch_id')) or type(row.get('item_index')) is not int:
            fail('SOURCES', '.semantic_review', row, 'valid source occurrence')
            continue
        pair = (row['batch_id'], row['item_index'])
        if pair in seen or pair not in sources or not isinstance(row.get('names'), list):
            fail('SOURCES', '.semantic_review', pair, 'each acquired item once with extracted names')
            continue
        seen.add(pair)
        for name in row['names']:
            entity = name_entity.get(norm(name)) if text(name) else None
            if entity is None:
                fail('NOUN_EXPORT', '.semantic_review', name, 'name included in the full noun list')
            else:
                occurrences[entity].add(pair)
    if seen != set(sources) or not sources:
        fail('SOURCES', '.semantic_review', len(seen), 'all acquired source rows actually mapped')
    for ident, entity in term_entity.items():
        if not occurrences[entity]:
            fail('SOURCES', '.nouns', ident, 'actual original occurrence')

    child = review.get('child', {})
    child = child if isinstance(child, dict) else {}
    reserved = {discovery.get('primary_agent_id')}
    old_child = discovery.get('subagent_review')
    if isinstance(old_child, dict):
        reserved.add(old_child.get('agent_id'))
    if (not text(child.get('agent_id')) or child['agent_id'] in reserved or child.get('fork_turns') != 'none'
            or child.get('created_agent_ids') != [child.get('agent_id')] or not text(child.get('spawn_ref'))):
        fail('CHILD', '.child', child, 'one real fresh isolated client agent distinct from investigation agents')
    previous_time = stamp(child.get('spawned_at'), '.child.spawned_at')
    rounds = review.get('rounds')
    # A user may authorize a bounded supplement for names found after round five.
    # Preserve the original first input and every response; never reset the loop.
    supplement = review.get('user_authorized_exception')
    supplemental_ids = []
    max_rounds = 5
    if supplement is not None:
        valid = (isinstance(supplement, dict)
                 and supplement.get('request_id') == discovery.get('task_id')
                 and text(supplement.get('authorization'))
                 and text(supplement.get('authorization_ref'))
                 and supplement.get('same_agent') == child.get('agent_id')
                 and supplement.get('history_preserved') is True
                 and type(supplement.get('max_additional_rounds')) is int
                 and 1 <= supplement['max_additional_rounds'] <= 2
                 and isinstance(supplement.get('scope'), list)
                 and supplement['scope']
                 and all(text(i) for i in supplement['scope'])
                 and len(set(supplement['scope'])) == len(supplement['scope'])
                 and all(i in ids for i in supplement['scope'])
                 and isinstance(rounds, list)
                 and 6 <= len(rounds) <= 5 + supplement['max_additional_rounds']
                 and supplement.get('actual_rounds') == list(range(6, len(rounds) + 1)))
        if not valid:
            fail('AUTHORIZATION', '.user_authorized_exception', supplement,
                 'actual user authorization bound to this task, same agent, names and at most two extra rounds')
        else:
            supplemental_ids = supplement['scope']
            max_rounds += supplement['max_additional_rounds']
    if not isinstance(rounds, list) or not 1 <= len(rounds) <= max_rounds:
        fail('ROUND_COUNT', '.rounds', len(rounds) if isinstance(rounds, list) else rounds, '1..5 actual rounds without reset')
        rounds = rounds if isinstance(rounds, list) else []
    attitudes, explained, rejected, previous_answers = {}, set(), set(), {}
    result_refs = set()
    for number, round_row in enumerate(rounds, 1):
        loc = f'.rounds[{number - 1}]'
        if not isinstance(round_row, dict):
            fail('ROUND', loc, round_row, 'actual input and response')
            continue
        if type(round_row.get('index')) is not int or round_row['index'] != number or round_row.get('agent_id') != child.get('agent_id'):
            fail('ROUND', loc, round_row.get('index'), 'contiguous rounds of the same client agent')
        for key in ('input_ref', 'result_ref'):
            if not text(round_row.get(key)):
                fail('ACTION_REF', loc + '.' + key, round_row.get(key), 'actual conversation/tool message reference')
        if round_row.get('result_ref') in result_refs:
            fail('ACTION_REF', loc, round_row.get('result_ref'), 'distinct real response')
        result_refs.add(round_row.get('result_ref'))
        timestamp = stamp(round_row.get('responded_at'), loc + '.responded_at')
        if previous_time and timestamp and timestamp <= previous_time:
            fail('ORDER', loc, round_row.get('responded_at'), 'response after previous input/response')
        previous_time = timestamp if timestamp is not None else previous_time
        given = payload(round_row.get('input'), loc + '.input')
        requested = []
        if number == 1 or number == 6 and supplemental_ids:
            initial = [n for n in nouns if (n['id'] in supplemental_ids) == (number == 6)]
            if given != initial:
                fail('FIRST_INPUT', loc + '.input', given, 'only complete {id,name} list; role and policy supplied separately')
            requested = [n['id'] for n in initial]
        else:
            mandatory = {ident for ident, attitude in attitudes.items() if attitude != '放松' and ident not in explained} | rejected
            if not isinstance(given, list) or not given:
                fail('ANSWER', loc + '.input', given, 'nonempty factual answers only for open questions')
                given = []
            for answer_index, answer in enumerate(given):
                if not isinstance(answer, dict) or set(answer) != FIELDS:
                    fail('ANSWER', loc + '.input', answer, 'exact six factual fields without extra judgments')
                    continue
                ident = names.get(answer.get('被问词'))
                if ident is None or ident in requested:
                    fail('ANSWER', loc, answer.get('被问词'), 'each relevant unresolved/rejected term once')
                    continue
                if number > 5 and ident not in supplemental_ids:
                    fail('AUTHORIZATION_SCOPE', loc, ident, 'supplement only the expressly authorized missing names')
                if answer == previous_answers.get(ident):
                    fail('REPEATED_ANSWER', loc, answer.get('被问词'), 'new material facts or a corrected refused explanation; do not repeat unchanged answers')
                requested.append(ident)
                for field in ('释义词所指代的对象', '实际含义'):
                    if not text(answer[field]):
                        fail('ANSWER', loc + '.' + field, answer[field], 'brief factual meaning or specific unknown')
                triples = source_triplets(answer, round_row.get('source_array_mappings', {}).get(str(answer_index)))
                if triples is None:
                    fail('ANSWER', loc, answer, 'aligned necessary source excerpts and contexts; not every occurrence full text')
                    continue
                for source_index, (url, excerpt, context) in enumerate(triples):
                    candidates = [pair for pair in occurrences.get(term_entity[ident], set()) if url in helpers['source_urls'](sources[pair])]
                    if not candidates or not any(any(excerpt in full for full in helpers['occurrence_texts'](sources[pair], sources)) for pair in candidates):
                        proof = round_row.get('source_excerpt_reviews', {}).get(f'{answer_index}:{source_index}')
                        if not check_excerpt(proof, excerpt=excerpt, url=url, source_rows=sources,
                                             source_texts=helpers['occurrence_texts'], source_urls=helpers['source_urls'], base=base):
                            fail('ANSWER_SOURCE', loc, url, 'unaltered necessary excerpt or explicitly verified multipart/image source mapping')
                explained.add(ident)
                previous_answers[ident] = answer
            if not mandatory <= set(requested):
                fail('ANSWER_COVERAGE', loc, sorted(mandatory - set(requested)), 'answer every new question/warning and unresolved refusal')
        response = payload(round_row.get('response'), loc + '.response')
        if not isinstance(response, list):
            fail('RESPONSE', loc, response, 'actual attitude array')
            response = []
        if [r.get('id') if isinstance(r, dict) else None for r in response] != requested:
            fail('RESPONSE_COVERAGE', loc, response, 'exact requested ID order; full list only in the first round')
        for row in response:
            if not isinstance(row, dict) or row.get('id') not in requested:
                fail('RESPONSE', loc, row, 'requested term only')
                continue
            ident = row['id']
            if set(row) == {'id', '态度'} and row.get('态度') in LABELS:
                attitudes[ident] = row['态度']
                rejected.discard(ident)
                if row['态度'] == '警惕':
                    ever.add(ident)
            elif number > 1 and set(row) == {'id', '拒绝'} and row.get('拒绝') == REJECTION:
                rejected.add(ident)
                explained.discard(ident)
            else:
                fail('RESPONSE', loc, row, 'one of three attitudes or the fixed factual-answer refusal')
    if rejected:
        fail('FINAL_REJECTION', '.rounds', sorted(rejected), 'rewrite refused wording and obtain a real reassessment within five rounds')
    if set(attitudes) != set(ids):
        fail('INITIAL_COVERAGE', '.rounds', sorted(set(ids) - set(attitudes)), 'every extracted noun has an actual initial client attitude')
    if {i for i, attitude in attitudes.items() if attitude != '放松'} - explained:
        fail('REASSESSMENT', '.rounds', sorted(set(attitudes) - explained), 'brief factual explanation followed by client reassessment')
    final_doubts.update(i for i, attitude in attitudes.items() if attitude == '疑问')
    triggered = ever | final_doubts
    for field, expected in [('ever_alert_ids', ever), ('triggered_term_ids', triggered)]:
        if field in review and (not isinstance(review[field], list) or review[field] != sorted(expected)):
            fail('HISTORY', '.' + field, review[field], 'computed complete history, never erase a warning after relaxation')

    blocks = {}
    if not isinstance(items, list) or not items:
        fail('DOCUMENT', '.items', items, 'complete actual final document blocks')
        items = []
    for row in items:
        if not isinstance(row, dict) or not text(row.get('block_id')) or row['block_id'] in blocks:
            fail('DOCUMENT', '.items', row, 'unique real block IDs')
            continue
        blocks[row['block_id']] = row
    audit = read(review.get('current_final_review'), '.current_final_review')
    audit = audit if isinstance(audit, dict) else {}
    receipt = audit.get('receipt', {})
    receipt = receipt if isinstance(receipt, dict) else {}
    binding = {'task_id': discovery.get('task_id'), 'source_revision': discovery.get('source_revision'), 'discovery_sha256': digest(discovery)}
    doc = audit.get('document', {})
    doc = doc if isinstance(doc, dict) else {}
    if (audit.get('verdict') != 'PASS' or receipt.get('verdict') != 'PASS' or audit.get('errors') != [] or audit.get('blocked') != []
            or doc.get('token') != document_token or doc.get('revision_id') != revision_id
            or type(doc.get('revision_id')) is not type(revision_id)
            or receipt.get('token') != document_token or receipt.get('revision_id') != revision_id):
        fail('FINAL_REVIEW', '.current_final_review', audit.get('verdict'), 'real complete current final-review PASS')
    for holder in (audit, receipt):
        if holder.get('document_sha256') != digest(items) or holder.get('discovery_binding') != binding or holder.get('policy_sha256') != policy_hash:
            fail('FINAL_REVIEW_STALE', '.current_final_review', holder.get('document_sha256'), 'current document, task sources and policy bound by original final-review output')
    final_time = stamp(receipt.get('generated_at'), '.current_final_review.generated_at')
    if previous_time and final_time and final_time < previous_time:
        fail('FINAL_REVIEW_STALE', '.current_final_review', receipt.get('generated_at'), 'final review after client reassessment and final composition')
    risks = audit.get('risk_locations')
    if not isinstance(risks, list) or risks != receipt.get('risk_locations'):
        fail('FINAL_REVIEW', '.risk_locations', risks, 'matching audited summary/platform locations')
        risks = []

    def location(value, loc):
        if not isinstance(value, dict) or set(value) != {'block_id', 'text'} or not text(value.get('text')):
            fail('INCLUSION_LOCATION', loc, value, 'actual {block_id,text}')
            return None
        block = blocks.get(value['block_id'])
        if block is None or helpers['block_text'](block) != value['text']:
            fail('INCLUSION_LOCATION', loc, value, 'exact current document text')
            return None
        return block

    inclusions = payload(review.get('inclusions'), '.inclusions')
    if not isinstance(inclusions, list):
        fail('INCLUSION', '.inclusions', inclusions, 'every historical warning and final doubt publicly mapped')
        inclusions = []
    included = set()
    for entry in inclusions:
        if not isinstance(entry, dict) or entry.get('id') not in triggered or entry['id'] in included:
            fail('INCLUSION', '.inclusions', entry, 'each required term once')
            continue
        ident = entry['id']
        included.add(ident)
        actual, expected = set(), occurrences.get(term_entity[ident], set())
        rows = entry.get('occurrences', [])
        if not isinstance(rows, list):
            fail('INCLUSION', '.inclusions', rows, 'original occurrences with public factual locations')
            rows = []
        for row in rows:
            if not isinstance(row, dict) or not text(row.get('batch_id')) or type(row.get('item_index')) is not int:
                fail('INCLUSION', '.inclusions', row, 'actual source occurrence')
                continue
            pair = (row['batch_id'], row['item_index'])
            if pair not in expected or pair in actual:
                fail('INCLUSION', '.inclusions', pair, 'every required source occurrence exactly once')
            actual.add(pair)
            url = row.get('source_url')
            if not text(url) or url not in helpers['source_urls'](sources.get(pair)):
                fail('INCLUSION_SOURCE', '.inclusions', url, 'this occurrence’s actual source URL')
            summary = location(row.get('summary'), '.inclusions.summary')
            platform = location(row.get('platform'), '.inclusions.platform')
            restriction = row.get('publication_restriction')
            restricted = False
            if isinstance(restriction, dict):
                restricted = (restriction.get('reason') == 'minor_sexual_content_safety'
                              and restriction.get('scope') == 'omit_direct_link_and_image'
                              and restriction.get('source_sha256') == digest(sources.get(pair))
                              and restriction.get('reviewer_id') == discovery.get('primary_agent_id')
                              and text(restriction.get('basis'))
                              and not any(url in helpers['block_text'](b) or url in helpers['source_urls'](b) for b in items))
                if not restricted:
                    fail('PUBLICATION_RESTRICTION', '.inclusions', ident, 'verified restricted source with factual public coverage and no unsafe direct link')
            link = None if restricted else location(row.get('link'), '.inclusions.link')
            kind = 'risk' if ident in ever else 'unresolved_doubt'
            if row.get('kind') != kind:
                fail('INCLUSION_KIND', '.inclusions', row.get('kind'), kind + '; a later relaxation cannot erase historical warning')
            if kind == 'risk' and not any(isinstance(r, dict) and r.get('summary_location') == row.get('summary') and r.get('platform_location') == row.get('platform') for r in risks):
                fail('INCLUSION_RISK_SECTION', '.inclusions', ident, 'actual audited risk summary and factual platform paragraph')
            if kind == 'unresolved_doubt' and platform and '待确认' not in helpers['block_text'](platform):
                fail('INCLUSION_UNKNOWN', '.inclusions', ident, 'explicit 待确认 wording for unresolved facts')
            # Exported display names may group source spellings with " / ".
            public_names = [part.strip() for name, entity in name_entity.items()
                            if entity == term_entity[ident] for part in name.split(' / ') if part.strip()]
            if platform and (helpers['block_text'](platform).strip() == url or not any(norm(name) in norm(helpers['block_text'](platform)) for name in public_names)):
                fail('INCLUSION_FACT', '.inclusions', ident, 'public factual mention of this object, not a URL-only placeholder')
            if link and url not in helpers['source_urls'](link) and url not in helpers['block_text'](link):
                fail('INCLUSION_LINK', '.inclusions', url, 'visible original URL or actual hyperlink target')
        if ident in ever and actual != expected:
            fail('INCLUSION_COVERAGE', '.inclusions', sorted(expected - actual), 'every historical-warning post publicly covered; archives and example quotas do not substitute')
        elif ident not in ever and not actual:
            fail('INCLUSION_COVERAGE', '.inclusions', ident, 'final unresolved doubt has factual public explanation and at least one actual original source')
    if included != triggered:
        fail('INCLUSION_COVERAGE', '.inclusions', sorted(triggered - included), 'all ever-alert terms plus final unresolved doubts')
    return result()

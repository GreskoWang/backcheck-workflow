"""Validate contextual follow-up archives and sampled category reporting.

Callbacks come from the client gate so file, source, revision and block checks
use the same evidence boundary. Semantic classification still needs real review.
"""
from urllib.parse import urlparse, urlunparse


def post_key(url):
    parsed = urlparse(url)
    parts = parsed.path.strip('/').split('/')
    if parsed.hostname in ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com') and len(parts) >= 3 and parts[1] == 'status' and parts[2].isdigit():
        return 'x:' + parts[2]
    return urlunparse(parsed._replace(fragment=''))


def audit_followup(data, *, triggered, term_entities, occurrences, source_rows,
                   current_risk_locations, policy_text, current_time, artifact,
                   binding, stamp, issue, source_urls, block_text, is_text, is_url):
    def fail(code, loc, actual, expected):
        issue('FOLLOWUP_' + code, '.followup' + loc, actual, expected)

    if not isinstance(data, dict) or set(data) != {'categories', 'terms'}:
        fail('SCHEMA', '', data, 'exact {categories,terms} textual follow-up archive')
        return
    categories, terms = data['categories'], data['terms']
    if not isinstance(categories, list) or not isinstance(terms, list):
        fail('SCHEMA', '', data, 'category and term arrays')
        return
    by_category, category_keys, used_categories, seen_terms = {}, set(), set(), set()
    report_groups, selected_pairs = {}, set()

    def original(row, loc):
        if not isinstance(row, dict) or not is_text(row.get('batch_id')) or type(row.get('item_index')) is not int:
            fail('SOURCE', loc, row, 'actual batch_id/item_index')
            return None
        pair = (row['batch_id'], row['item_index'])
        url = row.get('source_url')
        if not is_url(url) or url not in source_urls(source_rows.get(pair)):
            fail('SOURCE', loc, url, 'source URL from the actual acquired occurrence')
        return pair

    for index, category in enumerate(categories):
        loc = f'.categories[{index}]'
        fields = {'id', 'platform', 'category', 'policy_excerpt', 'recommended_count', 'selection_reason', 'examples'}
        if not isinstance(category, dict) or set(category) != fields or not all(is_text(category.get(k)) for k in fields - {'recommended_count', 'examples'}):
            fail('CATEGORY', loc, category, 'category identity, exact policy excerpt, quota, selection reason and examples')
            continue
        ident = category['id']
        key = (category['platform'].strip().casefold(), category['category'].strip())
        if ident in by_category or key in category_keys:
            fail('DUPLICATE_CATEGORY', loc, key, 'one shared quota per platform and policy category')
        by_category[ident] = category
        category_keys.add(key)
        if category['category'] not in category['policy_excerpt'] or category['policy_excerpt'] not in policy_text:
            fail('POLICY', loc, category['policy_excerpt'], 'exact current policy text containing the actual category name')
        count, examples = category['recommended_count'], category['examples']
        if type(count) is not int or not 1 <= count <= 4 or not isinstance(examples, list) or not 1 <= len(examples) <= count:
            fail('QUOTA', loc, (count, len(examples) if isinstance(examples, list) else examples), '1..4 representative cases within the selected recommendation')
        selected_posts = set()
        for sample_index, sample in enumerate(examples if isinstance(examples, list) else []):
            sloc = loc + f'.examples[{sample_index}]'
            if not isinstance(sample, dict) or set(sample) != {'batch_id', 'item_index', 'source_url', 'summary', 'platform', 'link'}:
                fail('EXAMPLE', sloc, sample, 'source occurrence and exact summary/platform/link bindings')
                continue
            original(sample, sloc)
            url = sample['source_url']
            if is_url(url):
                key = post_key(url)
                if key in selected_posts:
                    fail('DUPLICATE_EXAMPLE', sloc, url, 'one original post; aliases and media variants do not consume extra slots')
                selected_posts.add(key)
            for field in ('summary', 'platform', 'link'):
                bound = binding(sample[field], '.followup' + sloc + '.' + field)
                if bound is not None:
                    text = block_text(bound)
                    if field != 'link' and is_url(text.strip()):
                        fail('EXAMPLE', sloc, text, 'actual category summary and factual text, not URL-only blocks')
                    if field == 'link' and is_url(url) and url not in text and url not in source_urls(bound):
                        fail('LINK', sloc, url, 'selected original URL visible in its bound link block')
            matches = [r for r in current_risk_locations if r['summary_location'] == sample['summary'] and r['platform_location'] == sample['platform']]
            if not matches:
                fail('RISK_PAIR', sloc, sample, 'same current audited summary/platform risk pair')
            for match in matches:
                group = match['risk_group_index']
                if group in report_groups and report_groups[group] != category['category']:
                    fail('MERGED_CATEGORIES', sloc, group, 'different policy categories need distinct report indexes')
                report_groups[group] = category['category']
                selected_pairs.add((match['summary_location']['block_id'], match['platform_location']['block_id']))

    for risk in current_risk_locations:
        if risk['risk_group_index'] in report_groups and (risk['summary_location']['block_id'], risk['platform_location']['block_id']) not in selected_pairs:
            fail('UNSELECTED_PUBLIC_FACT', '.categories', risk, 'all public facts in a represented category belong to its shared selected examples; excess stays in archive')

    for index, term in enumerate(terms):
        loc = f'.terms[{index}]'
        if not isinstance(term, dict) or set(term) != {'id', 'occurrences'} or not is_text(term.get('id')):
            fail('TERM', loc, term, 'exact {id,occurrences}')
            continue
        ident = term['id']
        if ident in seen_terms or ident not in triggered:
            fail('COVERAGE', loc, ident, 'each triggered term exactly once')
        seen_terms.add(ident)
        expected = occurrences.get(term_entities.get(ident, -1), set())
        rows, covered = term['occurrences'], set()
        if not isinstance(rows, list) or not rows:
            fail('COVERAGE', loc, rows, 'all actual source occurrences with contextual follow-up')
            continue
        for row_index, row in enumerate(rows):
            rloc = loc + f'.occurrences[{row_index}]'
            fields = {'batch_id', 'item_index', 'source_url', 'post_url', 'context', 'attribution', 'checked_at', 'evidence', 'outcome', 'category_ids', 'reason'}
            if not isinstance(row, dict) or set(row) != fields:
                fail('RECORD', rloc, row, 'complete source, context, attribution, evidence, disposition and archive reason')
                continue
            pair = original(row, rloc)
            if pair is None:
                continue
            if pair in covered or pair not in expected:
                fail('COVERAGE', rloc, pair, 'each applicable occurrence exactly once')
            covered.add(pair)
            for field in ('context', 'attribution', 'reason'):
                if not is_text(row[field]):
                    fail('CONTEXT', rloc + '.' + field, row[field], 'actual factual text, including why this disposition was chosen')
            checked = stamp(row['checked_at'], '.followup' + rloc + '.checked_at')
            if checked and current_time and checked > current_time:
                fail('STALE_REVIEW', rloc, row['checked_at'], 'final document review after contextual follow-up')
            evidence = artifact(row['evidence'], '.followup' + rloc + '.evidence')
            if not is_url(row['post_url']) or row['post_url'] not in source_urls(evidence):
                fail('ORIGINAL_POST', rloc, row['post_url'], 'original post URL in the actual reviewed capture or access-status evidence')
            elif is_url(row['source_url']) and post_key(row['post_url']) != post_key(row['source_url']) and row['post_url'] not in source_urls(source_rows.get(pair)):
                fail('ORIGINAL_POST', rloc, row['post_url'], 'same original post or explicit source-row reference, not an unrelated capture')
            outcome, ids = row['outcome'], row['category_ids']
            if not isinstance(ids, list) or not all(is_text(v) for v in ids) or len(set(v for v in ids if is_text(v))) != len(ids):
                fail('DISPOSITION', rloc, ids, 'distinct category IDs')
                continue
            if outcome == 'risk':
                if not ids or any(v not in by_category for v in ids):
                    fail('DISPOSITION', rloc, ids, 'classified risk linked to represented policy categories')
                used_categories.update(ids)
            elif outcome in ('no_policy_hit', 'objective_unavailable'):
                if ids:
                    fail('DISPOSITION', rloc, ids, 'no risk category for this non-risk/closed unavailable occurrence')
            else:
                fail('DISPOSITION', rloc, outcome, 'risk, no_policy_hit or objective_unavailable; pending work cannot close')
        if covered != expected:
            fail('COVERAGE', loc, sorted(covered), 'all source occurrences ' + str(sorted(expected)))
    if seen_terms != triggered:
        fail('COVERAGE', '.terms', sorted(seen_terms), 'all triggered IDs ' + str(sorted(triggered)))
    if set(by_category) != used_categories:
        fail('CATEGORY_COVERAGE', '.categories', sorted(by_category), 'exact categories found through contextual follow-up ' + str(sorted(used_categories)))

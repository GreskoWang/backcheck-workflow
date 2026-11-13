"""Verify explicit, immutable source mappings for historical multipart excerpts.

The original client input remains unchanged. Text fragments are checked against
real cache files; image transcriptions remain an explicitly recorded human check.
This does not certify an attitude or supply a missing client response.
"""
import hashlib
import json
import re
from pathlib import Path


def compact(value):
    return re.sub(r'\s+', '', value)


def check_excerpt(proof, *, excerpt, url, source_rows, source_texts, source_urls, base):
    if not isinstance(proof, dict) or proof.get('original_excerpt') != excerpt or proof.get('original_url') != url:
        return False
    if not all(isinstance(proof.get(k), str) and proof[k].strip() for k in ('reviewer_id', 'checked_at', 'semantic_review')):
        return False
    fragments = proof.get('fragments')
    if not isinstance(fragments, list) or not fragments:
        return False
    covered = []
    for part in fragments:
        if not isinstance(part, dict) or not isinstance(part.get('text'), str) or not part['text'].strip():
            return False
        value = part['text']
        pair = (part.get('batch_id'), part.get('item_index'))
        row = source_rows.get(pair)
        direct_match = (row is not None and url in source_urls(row)
                        and any(compact(value) in compact(full) for full in source_texts(row, source_rows)))
        if not direct_match:
            # New direct readbacks and image transcriptions are explicit evidence,
            # never silently presented as the cache sent in an earlier round.
            evidence = part.get('evidence')
            if not isinstance(evidence, dict) or evidence.get('url') != url:
                return False
            try:
                path = Path(evidence['path'])
                path = path if path.is_absolute() else base / path
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != evidence.get('sha256'):
                    return False
                if evidence.get('kind') == 'new_direct_readback':
                    loaded = json.loads(data.decode('utf-8-sig'))
                    if loaded.get('url') != url or compact(value) not in compact(loaded.get('text', '')):
                        return False
                elif evidence.get('kind') == 'image_transcription':
                    if path.suffix.lower() not in {'.png', '.jpg', '.jpeg'} or not evidence.get('visually_reviewed'):
                        return False
                    if compact(value) not in compact(evidence.get('transcription', '')):
                        return False
                else:
                    return False
            except (OSError, KeyError, ValueError, TypeError):
                return False
        covered.append(value)
    # Every character of the original excerpt must still be accounted for.
    return compact(''.join(covered)) == compact(excerpt)


def source_triplets(answer, mapping):
    arrays = [answer[k] for k in ('出现链接', '出现原文', '上下文')]
    if not all(isinstance(a, list) and a and all(isinstance(x, str) and x.strip() for x in a) for a in arrays):
        return None
    if len(set(map(len, arrays))) == 1:
        return list(zip(*arrays))
    if not isinstance(mapping, dict) or not mapping.get('reviewer_id') or not mapping.get('basis'):
        return None
    entries = mapping.get('entries')
    if not isinstance(entries, list) or len(entries) != len(arrays[1]):
        return None
    out, seen = [], [set(), set(), set()]
    for entry in entries:
        if not isinstance(entry, list) or len(entry) != 3:
            return None
        for i, index in enumerate(entry):
            if type(index) is not int or not 0 <= index < len(arrays[i]):
                return None
            seen[i].add(index)
        out.append(tuple(arrays[i][entry[i]] for i in range(3)))
    if any(s != set(range(len(a))) for s, a in zip(seen, arrays)):
        return None
    return out

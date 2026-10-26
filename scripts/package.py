"""Build/verify a byte-exact manifest of portable Git-selected assets."""
from pathlib import Path
import argparse
import hashlib
import json

from check_portability import scan, source_files

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_NAME = 'package-manifest.json'


def record(root, rel):
    path = root / rel
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Outside package: {rel}')
    data = path.read_bytes()
    return {'path': rel, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def verify(root=ROOT, *, write=False):
    names = source_files(root)
    problems = scan(root, names)
    if problems:
        return {'status': 'FAIL', 'portability': problems}
    selected = sorted(set(names) - {MANIFEST_NAME})
    records = [record(root, name) for name in selected]
    manifest_path = root / MANIFEST_NAME
    if write:
        manifest_path.write_text(json.dumps({'schema': 1, 'algorithm': 'sha256', 'files': records},
                                           ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        entries = manifest['files']
        listed = [entry['path'] for entry in entries]
        if (manifest['schema'] != 1 or manifest['algorithm'] != 'sha256'
                or len(listed) != len(set(listed))):
            raise ValueError('invalid manifest schema or duplicate entries')
    except (OSError, ValueError, KeyError, TypeError):
        return {'status': 'FAIL', 'reason': 'invalid_or_missing_manifest'}
    expected = {entry['path']: entry for entry in entries}
    mismatches = [entry['path'] for entry in records if expected.get(entry['path']) != entry]
    unlisted = sorted(set(selected) - set(listed))
    unexpected = sorted(set(listed) - set(selected))
    return {'status': 'FAIL' if mismatches or unexpected else 'PASS', 'files': len(records),
            'mismatches': mismatches, 'unlisted': unlisted, 'unexpected': unexpected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    result = verify(write=args.write)
    print(json.dumps(result, ensure_ascii=False))
    return result['status'] != 'PASS'


if __name__ == '__main__':
    raise SystemExit(main())

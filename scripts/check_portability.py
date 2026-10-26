"""Reject machine-local paths/state in Git-selected source and OOXML members."""
from pathlib import Path, PurePosixPath
import argparse
import html
import json
import re
import subprocess
import urllib.parse
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DRIVE = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?!/)")
FILE_URI = re.compile(r"\bfile:\s*[/\\]", re.I)
UNC = re.compile(r"(?:^|[ \t\"'`(=])(?:\\\\){1,2}[A-Za-z0-9][A-Za-z0-9._-]*(?:\\\\?)[A-Za-z0-9_$.-]+(?=$|[\\/\s\"'<>`])")
UNIX = re.compile(r"(?<![/:\w])/(?:Users|home|root|tmp|var|opt|mnt|Volumes|etc|usr)/[^\s\"'<>`]+")
WEB_URL = re.compile(r"\b(?:https?|wss?)://[^\s\"'<>`]+", re.I)
LOCAL_NAMES = {'auth.json', 'credentials.json', 'storage.json', '.env', 'backcheck-local.json',
               'runtime-paths.json', 'template-read-check.json', 'codex-mcp.local.toml'}
LOCAL_DIRS = {'.local', 'node_modules', '__pycache__', '.venv'}
LOCAL_PREFIXES = ('reports/local/', 'tools/feishu-codex-bridge/state/', 'tools/feishu-codex-bridge/logs/')
OOXML = {'.docx', '.xlsx', '.pptx'}


def source_files(root=ROOT):
    output = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--cached', '--others',
                                      '--exclude-standard', '-z'])
    return sorted({p.decode('utf-8') for p in output.split(b'\0') if p})


def text_findings(text):
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        # Standard env shebangs select an interpreter through PATH, not a
        # developer's filesystem. The homepage route is a site URL component.
        if number == 1 and line.startswith('#!' + '/usr' + '/bin/env '):
            continue
        value = html.unescape(line)
        for _ in range(2):
            value = urllib.parse.unquote(value)
        value = WEB_URL.sub('', value)
        value = value.replace('"/home' + '/main"', '"<site-route>"')
        kinds = [name for name, pattern in [('drive_path', DRIVE), ('file_uri', FILE_URI),
                                            ('unc_path', UNC), ('unix_path', UNIX)]
                 if pattern.search(value)]
        if kinds:
            findings.append({'line': number, 'kinds': kinds})
    return findings


def scan(root=ROOT, names=None):
    root = Path(root).resolve()
    problems = []
    names = source_files(root) if names is None else names
    for name in names:
        rel = PurePosixPath(name)
        path = root / name
        if (rel.is_absolute() or '..' in rel.parts or not path.resolve().is_relative_to(root)
                or path.is_symlink()):
            problems.append({'path': name, 'reason': 'outside_package_or_link'})
            continue
        if (rel.name in LOCAL_NAMES or rel.name.endswith(('.local.json', '.log', '.pyc'))
                or any(part in LOCAL_DIRS for part in rel.parts) or name.startswith(LOCAL_PREFIXES)):
            problems.append({'path': name, 'reason': 'local_state'})
            continue
        if not path.is_file():
            problems.append({'path': name, 'reason': 'missing_file'})
            continue
        try:
            if path.suffix.lower() in OOXML:
                with zipfile.ZipFile(path) as archive:
                    parts = [(f'{name}!{member}', archive.read(member).decode('utf-8-sig'))
                             for member in archive.namelist() if member.endswith(('.xml', '.rels'))]
            else:
                try:
                    parts = [(name, path.read_text(encoding='utf-8-sig'))]
                except UnicodeDecodeError:
                    if path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf'}:
                        continue
                    raise ValueError('unsupported non-UTF-8 source')
            for member, text in parts:
                problems.extend({'path': member, **hit} for hit in text_findings(text))
        except (OSError, ValueError, UnicodeError, zipfile.BadZipFile):
            problems.append({'path': name, 'reason': 'unreadable_source'})
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    names = source_files(args.root)
    problems = scan(args.root, names)
    print(json.dumps({'status': 'FAIL' if problems else 'PASS', 'files': len(names),
                      'findings': problems}, ensure_ascii=False))
    return bool(problems)


if __name__ == '__main__':
    raise SystemExit(main())

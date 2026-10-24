"""Build/verify a SHA-256 manifest of Git-selected assets, never runtime state."""
from pathlib import Path
import argparse, hashlib, json, subprocess, sys
ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/'package-manifest.json'
def source_files():
    output=subprocess.check_output(['git','-C',str(ROOT),'ls-files','--cached','--others','--exclude-standard','-z'])
    return sorted(set(p.decode('utf-8') for p in output.split(b'\0') if p and p!=b'package-manifest.json'))
def record(rel):
    p=ROOT/rel
    if not p.resolve().is_relative_to(ROOT):raise ValueError(f'Outside package: {rel}')
    data=p.read_bytes();return {'path':rel,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--write',action='store_true');args=ap.parse_args()
    if args.write:
        files=[record(p) for p in source_files()]
        MANIFEST.write_text(json.dumps({'schema':1,'algorithm':'sha256','files':files},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    manifest=json.loads(MANIFEST.read_text(encoding='utf-8'))
    failures=[r['path'] for r in manifest['files'] if not (ROOT/r['path']).is_file() or record(r['path'])!=r]
    print(json.dumps({'status':'FAIL' if failures else 'PASS','files':len(manifest['files']),'mismatches':failures},ensure_ascii=False))
    return bool(failures)
if __name__=='__main__':raise SystemExit(main())

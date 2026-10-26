"""Portable publication regressions; no browser, account or business state."""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest
from urllib.parse import quote
import zipfile

from check_portability import scan, text_findings
from package import verify


class PortablePublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        subprocess.run(['git', 'init', '--quiet', str(self.root)], check=True)
        (self.root / '.gitignore').write_text('.local/\n', encoding='utf-8')
        (self.root / 'policy.md').write_bytes('共享规则\r\n'.encode('utf-8'))

    def test_windows_paths_encoded_paths_file_urls_and_unc_are_blocked(self):
        drive = 'Z:' + '\\' + 'fixture' + '\\' + 'file.md'
        values = [drive, drive.replace('\\', '/'), drive.replace('\\', '\\\\'),
                  quote(drive), 'file:' + '/' * 3 + 'tmp/fixture',
                  '\\' * 2 + 'server' + '\\' + 'share']
        for value in values:
            with self.subTest(value=value):
                self.assertTrue(text_findings(value))

    def test_unix_paths_are_blocked_but_web_routes_and_placeholders_are_allowed(self):
        self.assertTrue(text_findings('/' + 'home/person/file'))
        self.assertFalse(text_findings('https://example.test/home/person?q=1\n<WORKSPACE>/process/a.json\n./scripts/package.py'))
        self.assertFalse(text_findings('#!' + '/usr' + '/bin/env python3'))
        self.assertFalse(text_findings('"%USERPROFILE%\\\\.codex\\\\skills"'))
        self.assertFalse(text_findings("-match '\\\\WindowsApps\\\\python(?:3)?\\.exe$'"))

    def test_ooxml_external_relationship_is_scanned(self):
        with zipfile.ZipFile(self.root / 'risk.xlsx', 'w') as archive:
            archive.writestr('xl/_rels/workbook.xml.rels', '<Relationship Target="' + 'file:' + '/' * 3 + 'tmp/fixture"/>')
        findings = scan(self.root, ['risk.xlsx'])
        self.assertTrue(findings)
        self.assertIn('workbook.xml.rels', findings[0]['path'])

    def test_force_added_local_state_is_blocked_but_ignored_state_is_excluded(self):
        (self.root / '.local').mkdir()
        (self.root / '.local/state.json').write_text('{}')
        self.assertEqual(verify(self.root, write=True)['status'], 'PASS')
        subprocess.run(['git', '-C', str(self.root), 'add', '-f', '.local/state.json'], check=True)
        self.assertEqual(verify(self.root)['portability'][0]['reason'], 'local_state')

    def test_exact_bytes_new_files_and_deleted_files_require_refresh(self):
        self.assertEqual(verify(self.root, write=True)['status'], 'PASS')
        policy = self.root / 'policy.md'
        policy.write_bytes(policy.read_bytes().replace(b'\r\n', b'\n'))
        self.assertIn('policy.md', verify(self.root)['mismatches'])
        (self.root / 'new.md').write_text('new')
        self.assertIn('new.md', verify(self.root)['unlisted'])
        self.assertEqual(verify(self.root, write=True)['status'], 'PASS')
        (self.root / 'new.md').unlink()
        self.assertIn('new.md', verify(self.root)['unexpected'])

    def test_missing_tracked_file_and_duplicate_manifest_entry_fail(self):
        subprocess.run(['git', '-C', str(self.root), 'add', 'policy.md'], check=True)
        verify(self.root, write=True)
        manifest = self.root / 'package-manifest.json'
        value = json.loads(manifest.read_text())
        value['files'].append(value['files'][0])
        manifest.write_text(json.dumps(value))
        self.assertEqual(verify(self.root)['status'], 'FAIL')
        (self.root / 'policy.md').unlink()
        self.assertEqual(verify(self.root)['portability'][0]['reason'], 'missing_file')

    def test_path_in_git_selected_document_prevents_manifest_write(self):
        (self.root / 'policy.md').write_text('Z:' + '/' + 'private/file')
        result = verify(self.root, write=True)
        self.assertEqual(result['status'], 'FAIL')
        self.assertFalse((self.root / 'package-manifest.json').exists())


if __name__ == '__main__':
    unittest.main()

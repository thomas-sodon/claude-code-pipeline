#!/usr/bin/env python3
"""Contract tests for .claude/scripts/pipeline-sync.py (stdlib only, Python 3.8+).

Run from the repo root: python3 ci/test_pipeline_sync.py

Each test builds a throwaway pipeline source (a git checkout) and a target
repository in temp directories and runs the script as a subprocess.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNC = os.path.join(ROOT, '.claude', 'scripts', 'pipeline-sync.py')
MANIFEST = os.path.join('.claude', 'pipeline-manifest.json')


def git(cwd, *a):
    subprocess.run(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com'] + list(a),
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def write(root, rel, text, mode=None):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(text)
    if mode:
        os.chmod(p, mode)


def read(root, rel):
    with open(os.path.join(root, rel), encoding='utf-8') as f:
        return f.read()


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='sync-test-')
        self.src = os.path.join(self.tmp, 'src')
        self.dst = os.path.join(self.tmp, 'dst')
        for d in (self.src, self.dst):
            os.makedirs(d)
            git(d, 'init', '-q')
        write(self.src, '.claude/workflows/brief-to-proposals.js', 'v1\n')
        write(self.src, '.claude/scripts/proposal-lint.py', 'lint v1\n', 0o755)
        write(self.src, '.claude/commands/plan.md', 'plan v1\n')
        write(self.src, '.claude/commands/old.md', 'old v1\n')
        write(self.src, '.claude/settings.json', '{}\n')
        write(self.src, '.gitignore', '__pycache__/\n')
        write(self.src, '.claude/scripts/__pycache__/x.pyc', 'junk')
        git(self.src, 'add', '-A')
        git(self.src, 'commit', '-qm', 'v1')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_sync(self, *flags, code=0):
        r = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--from', self.src, '--json'] + list(flags),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, code, r.stdout + r.stderr)
        return json.loads(r.stdout)

    def commit_src(self, msg):
        git(self.src, 'add', '-A')
        git(self.src, 'commit', '-qm', msg)

    def test_first_install_copies_and_records(self):
        r = self.run_sync()
        self.assertIn('.claude/commands/plan.md', r['added'])
        self.assertTrue(r['settings_json_copied'])
        self.assertFalse(os.path.exists(os.path.join(self.dst, '.claude/scripts/__pycache__')))
        self.assertTrue(os.access(os.path.join(self.dst, '.claude/scripts/proposal-lint.py'), os.X_OK))
        m = json.loads(read(self.dst, MANIFEST))
        self.assertEqual(set(m['files']), {'.claude/workflows/brief-to-proposals.js', '.claude/scripts/proposal-lint.py',
                                           '.claude/commands/plan.md', '.claude/commands/old.md'})
        self.assertEqual(len(m['source']['commit']), 40)
        self.assertEqual(r['pending'], [])
        self.assertEqual(self.run_sync('--check')['pending'], [])

    def test_upstream_change_updates_only_with_update(self):
        self.run_sync()
        write(self.src, '.claude/commands/plan.md', 'plan v2\n')
        self.commit_src('v2')
        r = self.run_sync('--check', code=1)
        self.assertEqual(r['outdated'], ['.claude/commands/plan.md'])
        r = self.run_sync()
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan v1\n')
        self.assertEqual(r['pending'], ['outdated'])
        r = self.run_sync('--update')
        self.assertEqual(r['updated'], ['.claude/commands/plan.md'])
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan v2\n')
        self.run_sync('--check')

    def test_local_edit_is_kept_and_conflict_needs_force(self):
        self.run_sync()
        write(self.dst, '.claude/commands/plan.md', 'plan local\n')
        r = self.run_sync('--update')
        self.assertEqual(r['local_edit'], ['.claude/commands/plan.md'])
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan local\n')
        write(self.src, '.claude/commands/plan.md', 'plan v2\n')
        self.commit_src('v2')
        r = self.run_sync('--update')
        self.assertEqual(r['conflict'], ['.claude/commands/plan.md'])
        self.assertEqual(r['pending'], ['conflict'])
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan local\n')
        # The kept conflict stays a conflict on the next run (its base is not advanced).
        self.assertEqual(self.run_sync('--update')['conflict'], ['.claude/commands/plan.md'])
        r = self.run_sync('--update', '--force')
        self.assertEqual(r['updated'], ['.claude/commands/plan.md'])
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan v2\n')

    def test_removed_upstream_is_deleted_unless_edited(self):
        self.run_sync()
        write(self.src, '.claude/commands/extra.md', 'extra\n')
        self.commit_src('extra')
        self.run_sync()
        os.remove(os.path.join(self.src, '.claude/commands/old.md'))
        os.remove(os.path.join(self.src, '.claude/commands/extra.md'))
        self.commit_src('drop')
        write(self.dst, '.claude/commands/extra.md', 'extra, edited here\n')
        r = self.run_sync('--check', code=1)
        self.assertEqual(r['obsolete'], ['.claude/commands/old.md'])
        r = self.run_sync('--update')
        self.assertEqual(r['deleted'], ['.claude/commands/old.md'])
        self.assertEqual(r['obsolete_edited'], ['.claude/commands/extra.md'])
        self.assertFalse(os.path.exists(os.path.join(self.dst, '.claude/commands/old.md')))
        self.assertTrue(os.path.exists(os.path.join(self.dst, '.claude/commands/extra.md')))

    def test_locally_deleted_file_stays_deleted(self):
        self.run_sync()
        os.remove(os.path.join(self.dst, '.claude/commands/old.md'))
        r = self.run_sync('--update')
        self.assertEqual(r['removed_locally'], ['.claude/commands/old.md'])
        self.assertFalse(os.path.exists(os.path.join(self.dst, '.claude/commands/old.md')))

    def test_legacy_install_without_manifest(self):
        write(self.dst, '.claude/commands/plan.md', 'plan from an old cp -r\n')
        write(self.dst, '.claude/settings.json', '{"mine": true}\n')
        r = self.run_sync()
        self.assertEqual(r['differs'], ['.claude/commands/plan.md'])
        self.assertFalse(r['settings_json_copied'])
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan from an old cp -r\n')
        r = self.run_sync('--update')
        self.assertEqual(r['updated'], ['.claude/commands/plan.md'])
        self.assertEqual(read(self.dst, '.claude/settings.json'), '{"mine": true}\n')

    def test_dry_run_and_check_write_nothing(self):
        self.run_sync('--dry-run')
        self.assertFalse(os.path.exists(os.path.join(self.dst, '.claude')))
        r = self.run_sync('--check', code=1)
        self.assertIn('added', r['pending'])
        self.assertFalse(os.path.exists(os.path.join(self.dst, '.claude')))

    def test_errors(self):
        empty = os.path.join(self.tmp, 'empty')
        os.makedirs(empty)
        p = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--from', empty, '--json'],
                           stdout=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn('not a pipeline source', json.loads(p.stdout)['error'])
        p = subprocess.run([sys.executable, SYNC, '--target', empty, '--from', self.src],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(p.returncode, 2)

    def test_clone_from_repo_url(self):
        # A local path stands in for the remote URL; the manifest remembers it (and the ref) for the next run.
        branch = subprocess.run(['git', '-C', self.src, 'rev-parse', '--abbrev-ref', 'HEAD'],
                                stdout=subprocess.PIPE, universal_newlines=True).stdout.strip()
        r = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--repo', self.src, '--ref', branch, '--json'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        m = json.loads(read(self.dst, MANIFEST))
        self.assertEqual(m['source']['repo'], self.src)
        r = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--check'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == '__main__':
    unittest.main()

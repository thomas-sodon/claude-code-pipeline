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


class Fixture(unittest.TestCase):
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


class SyncTest(Fixture):
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
        # It matches no version the source shipped, so it may hold edits: --update keeps it, like a conflict.
        r = self.run_sync('--update')
        self.assertEqual(r['differs'], ['.claude/commands/plan.md'])
        self.assertEqual(r['updated'], [])
        self.assertIn('differs', r['pending'])
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan from an old cp -r\n')
        self.run_sync('--check', code=1)
        r = self.run_sync('--update', '--force')
        self.assertEqual(r['updated'], ['.claude/commands/plan.md'])
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan v1\n')
        self.assertEqual(read(self.dst, '.claude/settings.json'), '{"mine": true}\n')
        self.run_sync('--check')

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

    def test_a_source_that_ignores_its_pipeline_files_is_refused(self):
        # A project with the pipeline installed but .claude/ ignored: its files exist on disk, yet git lists none.
        self.run_sync()
        with open(os.path.join(self.src, '.gitignore'), 'a', encoding='utf-8') as f:
            f.write('.claude/\n')
        git(self.src, 'rm', '-r', '-q', '--cached', '.claude')
        self.commit_src('ignore .claude')
        self.assertTrue(os.path.isfile(os.path.join(self.src, '.claude/scripts/proposal-lint.py')))
        r = self.run_sync('--update', code=2)
        self.assertIn('ignored by its git checkout', r['error'])
        for rel in ('.claude/commands/plan.md', '.claude/commands/old.md', '.claude/scripts/proposal-lint.py'):
            self.assertTrue(os.path.isfile(os.path.join(self.dst, rel)), rel + ' must not be deleted')

    def test_recorded_ref_exists_on_the_recorded_remote(self):
        # An unpushed local branch is never recorded: a later run would clone --branch <it> from origin and fail.
        git(self.src, 'switch', '-q', '-c', 'my-tweaks')
        self.run_sync()
        self.assertIsNone(json.loads(read(self.dst, MANIFEST))['source']['ref'])
        # A local branch tracking origin/<x> records x, the name a clone from origin can use.
        bare = os.path.join(self.tmp, 'remote.git')
        subprocess.run(['git', 'clone', '-q', '--bare', self.src, bare], check=True)
        work = os.path.join(self.tmp, 'work')
        subprocess.run(['git', 'clone', '-q', '--branch', 'my-tweaks', bare, work], check=True)
        git(work, 'switch', '-q', '-c', 'local-name', '--track', 'origin/my-tweaks')
        p = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--from', work, '--json'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        src = json.loads(read(self.dst, MANIFEST))['source']
        self.assertEqual(src['ref'], 'my-tweaks')
        # ...and a later run with no --from can clone it back.
        p = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--check'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_credentials_in_the_source_remote_are_never_written(self):
        # A token in the source checkout's origin URL must not reach the committed manifest or the report.
        git(self.src, 'remote', 'add', 'origin', 'https://someone:ghp_SECRET123@github.com/acme/ccp.git')
        p = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--from', self.src, '--json'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertNotIn('SECRET123', p.stdout + p.stderr)
        self.assertNotIn('SECRET123', read(self.dst, MANIFEST))
        self.assertEqual(json.loads(read(self.dst, MANIFEST))['source']['repo'], 'https://github.com/acme/ccp.git')
        human = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--from', self.src, '--check'],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertNotIn('SECRET123', human.stdout + human.stderr)
        # redact_url itself (a remote's URL can be rewritten by git's insteadOf config, so test the function):
        # http(s) user info goes whole (a token can be the user name); an ssh user name stays (it is no secret,
        # and the host needs it), only its password goes; an scp-style remote has no secret and is kept as it is.
        import importlib.util
        spec = importlib.util.spec_from_file_location('pipeline_sync', SYNC)
        mod = importlib.util.module_from_spec(spec)
        # No bytecode cache: .claude/scripts/__pycache__ would carry this machine's paths, which CI's
        # project-agnostic grep over .claude/ rejects.
        dont_write = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        try:
            spec.loader.exec_module(mod)
        finally:
            sys.dont_write_bytecode = dont_write
        for url, want in [('https://u:t0k@github.com/a/b.git', 'https://github.com/a/b.git'),
                          ('https://x-access-token:t0k@github.com/a/b', 'https://github.com/a/b'),
                          ('https://ghp_t0k@github.com/a/b', 'https://github.com/a/b'),
                          ('ssh://git@host:22/a/b.git', 'ssh://git@host:22/a/b.git'),
                          ('ssh://git:pw@host/a/b.git', 'ssh://git@host/a/b.git'),
                          ('git+ssh://git@host/a/b.git', 'git+ssh://git@host/a/b.git'),
                          ('git@github.com:a/b.git', 'git@github.com:a/b.git'),
                          ('https://github.com/a/b', 'https://github.com/a/b'), (None, None)]:
            self.assertEqual(mod.redact_url(url), want, url)

    def test_manifest_paths_outside_the_pipeline_are_never_touched(self):
        # The manifest is a committed file anyone can edit: an obsolete-looking entry for a path outside
        # .claude/<dir>/ must not be deleted, even when its recorded hash matches the file.
        import hashlib
        self.run_sync()
        outside = os.path.join(self.tmp, 'outside.txt')
        write(self.tmp, 'outside.txt', 'keep me\n')
        write(self.dst, 'src/app.py', 'keep me\n')
        write(self.dst, '.claude/notes.md', 'keep me\n')
        h = hashlib.sha256(b'keep me\n').hexdigest()
        m = json.loads(read(self.dst, MANIFEST))
        evil = ['../outside.txt', outside, 'src/app.py', '.claude/notes.md',
                '.claude/commands/../../src/app.py', './.claude/commands/x.md']
        for k in evil:
            m['files'][k] = h
        write(self.dst, MANIFEST, json.dumps(m))
        r = self.run_sync('--update')
        self.assertEqual(r['deleted'], [])
        self.assertEqual(sorted(r['ignored_manifest_paths']), sorted(evil))
        self.assertTrue(os.path.exists(outside))
        self.assertTrue(os.path.exists(os.path.join(self.dst, 'src/app.py')))
        self.assertTrue(os.path.exists(os.path.join(self.dst, '.claude/notes.md')))
        # The rewritten manifest drops them.
        self.assertFalse(set(evil) & set(json.loads(read(self.dst, MANIFEST))['files']))

    def test_symlinked_pipeline_directory_is_not_deleted_through(self):
        self.run_sync()
        elsewhere = os.path.join(self.tmp, 'elsewhere')
        shutil.copytree(os.path.join(self.dst, '.claude/commands'), elsewhere)
        shutil.rmtree(os.path.join(self.dst, '.claude/commands'))
        os.symlink(elsewhere, os.path.join(self.dst, '.claude/commands'))
        os.remove(os.path.join(self.src, '.claude/commands/old.md'))
        self.commit_src('drop old')
        r = self.run_sync('--update')
        self.assertEqual(r['deleted'], [])
        self.assertTrue(os.path.exists(os.path.join(elsewhere, 'old.md')))

    def test_legacy_install_adopted_from_history(self):
        # A cp -r of v1, before the manifest: plan.md is an unedited older upstream version, old.md was edited.
        write(self.dst, '.claude/commands/plan.md', 'plan v1\n')
        write(self.dst, '.claude/commands/old.md', 'old v1, edited here\n')
        write(self.src, '.claude/commands/plan.md', 'plan v2\n')
        write(self.src, '.claude/commands/old.md', 'old v2\n')
        self.commit_src('v2')
        r = self.run_sync('--check', code=1)
        self.assertEqual(r['outdated'], ['.claude/commands/plan.md'])
        self.assertEqual(r['adopted'], ['.claude/commands/plan.md'])
        self.assertEqual(r['differs'], ['.claude/commands/old.md'])
        # Without --update the adopted file is kept, but its base is recorded: it stays outdated, not differs.
        self.run_sync()
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan v1\n')
        r = self.run_sync('--check', code=1)
        self.assertEqual(r['outdated'], ['.claude/commands/plan.md'])
        self.assertEqual(r['adopted'], [])
        r = self.run_sync('--update')
        self.assertIn('.claude/commands/plan.md', r['updated'])
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan v2\n')

    def test_legacy_adoption_through_a_clone(self):
        # The clone keeps the history (no --depth), so a cp -r of an older commit is still recognised.
        write(self.dst, '.claude/commands/plan.md', 'plan v1\n')
        write(self.src, '.claude/commands/plan.md', 'plan v2\n')
        self.commit_src('v2')
        branch = subprocess.run(['git', '-C', self.src, 'rev-parse', '--abbrev-ref', 'HEAD'],
                                stdout=subprocess.PIPE, universal_newlines=True).stdout.strip()
        r = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--repo', self.src, '--ref', branch,
                            '--json', '--check'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(json.loads(r.stdout)['adopted'], ['.claude/commands/plan.md'])

    def test_release_tag_pins_the_ref(self):
        git(self.src, 'tag', 'v1.0.0')
        write(self.src, '.claude/commands/plan.md', 'plan v2\n')
        self.commit_src('v2')
        r = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--repo', self.src, '--ref', 'v1.0.0', '--json'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(read(self.dst, '.claude/commands/plan.md'), 'plan v1\n')
        self.assertEqual(json.loads(read(self.dst, MANIFEST))['source']['ref'], 'v1.0.0')
        # The manifest keeps the tag: --check compares against it, not against the newer tip.
        r = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--check'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        # A detached checkout of the tag, passed with --from, records the tag as the ref too.
        co = os.path.join(self.tmp, 'co')
        subprocess.run(['git', 'clone', '-q', '--branch', 'v1.0.0', self.src, co], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        r = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--from', co, '--json'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads(r.stdout)['source']['ref'], 'v1.0.0')


class ClaudeMdTest(Fixture):
    TEMPLATE = ('## How work happens here\n\n'
                '<!-- How work happens here written by /seed: compared by pipeline-sync.py -->\n\n'
                '- rule one\n- rule two\n')

    def setUp(self):
        super().setUp()
        write(self.src, '.claude/scripts/claude-md-base.md', self.TEMPLATE)
        self.commit_src('template')

    def claude_md(self, text):
        write(self.dst, 'CLAUDE.md', text)

    def test_marked_section_current(self):
        self.claude_md('# dst\n\nIntro.\n\n' + self.TEMPLATE + '\n## Pipeline config\n\nMAIN_BRANCH: main\n')
        r = self.run_sync('--check-claude-md')
        self.assertEqual(r['claude_md']['status'], 'current')
        self.run_sync('--check', '--check-claude-md')

    def test_marked_section_differs_is_reported_never_edited(self):
        text = self.TEMPLATE.replace('- rule two\n', '- rule two, old wording\n') + '\n## Pipeline config\n'
        self.claude_md(text)
        r = self.run_sync()
        c = r['claude_md']
        self.assertEqual(c['status'], 'differs')
        self.assertEqual((c['added'], c['removed']), (1, 1))
        self.assertIn('+- rule two', c['diff'])
        self.assertIn('-- rule two, old wording', c['diff'])
        self.assertNotIn('claude_md', r['pending'])
        self.assertEqual(read(self.dst, 'CLAUDE.md'), text)
        # --check passes without the flag and counts the section as pending with it.
        self.assertEqual(self.run_sync('--check')['pending'], [])
        r = self.run_sync('--check', '--check-claude-md', code=1)
        self.assertEqual(r['pending'], ['claude_md'])
        r = subprocess.run([sys.executable, SYNC, '--target', self.dst, '--from', self.src],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertIn('rule two, old wording', r.stdout)
        self.assertEqual(read(self.dst, 'CLAUDE.md'), text)

    def test_unmarked_and_missing_sections_are_not_pending(self):
        # An older /seed wrote the section without the marker: reported with its diff, never pending.
        self.claude_md('## How work happens here\n\n- rule one\n')
        r = self.run_sync('--check-claude-md')
        self.assertEqual(r['claude_md']['status'], 'unmarked')
        self.assertNotIn('claude_md', r['pending'])
        # The marker is ignored in the comparison: the same rules without it are current.
        self.claude_md('## How work happens here\n- rule one\n- rule two\n```\n## not a heading\n```\n')
        self.assertEqual(self.run_sync()['claude_md']['status'], 'unmarked')
        self.claude_md('## How work happens here\n\n- rule one\n- rule two\n\n# Next\n')
        self.assertEqual(self.run_sync()['claude_md']['status'], 'current')
        self.claude_md('# dst\n')
        self.assertEqual(self.run_sync()['claude_md']['status'], 'missing')
        os.remove(os.path.join(self.src, '.claude/scripts/claude-md-base.md'))
        self.commit_src('no template')
        self.assertEqual(self.run_sync('--check-claude-md')['claude_md']['status'], 'no_template')


if __name__ == '__main__':
    unittest.main()

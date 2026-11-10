#!/usr/bin/env python3
"""Contract tests for .claude/scripts/pipeline-state.py (stdlib only, Python 3.8+).

Run from the repo root: python3 ci/test_pipeline_state.py

Each test builds a temporary bare repository as origin and two clones of it, and
runs the script as a subprocess, the way workflows and commands call it.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, '.claude', 'scripts', 'pipeline-state.py')
BRANCH = 'pipeline/state'


ENV = {}


def setUpModule():
    # A private HOME: no global or system git config (signing, hook paths, identity) leaks in from the machine
    # running the tests, and no GIT_DIR from a git hook redirects the clones.
    home = tempfile.mkdtemp(prefix='state-home-')
    ENV.update({k: v for k, v in os.environ.items()
                if not k.startswith(('PIPELINE_STATE_', 'GIT_')) or k == 'GIT_EXEC_PATH'})
    ENV.update(HOME=home, XDG_CONFIG_HOME=home, GIT_CONFIG_NOSYSTEM='1')


def tearDownModule():
    shutil.rmtree(ENV['HOME'], ignore_errors=True)


def git(cwd, *a):
    r = subprocess.run(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com'] + list(a),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, env=ENV)
    if r.returncode != 0:
        raise AssertionError('git %s failed: %s' % (' '.join(a), r.stderr))
    return r.stdout.strip()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='state-test-')
        self.env = dict(ENV)
        self.origin = os.path.join(self.tmp, 'origin.git')
        subprocess.run(['git', 'init', '-q', '--bare', self.origin], check=True, env=self.env)
        self.a, self.b = self.clone('a'), self.clone('b')
        git(self.a, 'commit', '-q', '--allow-empty', '-m', 'init')
        git(self.a, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
        git(self.b, 'fetch', '-q', 'origin')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def clone(self, name):
        d = os.path.join(self.tmp, name)
        subprocess.run(['git', 'clone', '-q', self.origin, d], check=True, env=self.env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        git(d, 'config', 'user.name', 't')
        git(d, 'config', 'user.email', 't@example.com')
        return d

    def run_state(self, repo, *args, stdin=None, code=0, env=None):
        e = dict(self.env)
        e.update(env or {})
        cmd = [sys.executable, STATE] + (['--repo', repo] if repo else []) + list(args)
        r = subprocess.run(cmd, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=e)
        self.assertEqual(r.returncode, code, 'exit %d, wanted %d: %s %s' % (
            r.returncode, code, r.stdout.decode(errors='replace'), r.stderr.decode(errors='replace')))
        return r

    def save(self, repo, text, path, *flags, code=0, env=None):
        r = self.run_state(repo, 'save', '-', '--as', path, *flags, stdin=text.encode(), code=code, env=env)
        return json.loads(r.stdout.decode())

    def origin_files(self, branch=BRANCH):
        return sorted(git(self.origin, 'ls-tree', '-r', '--name-only', branch).splitlines())

    def origin_show(self, path, branch=BRANCH):
        return git(self.origin, 'show', '%s:%s' % (branch, path))

    def origin_has(self, branch=BRANCH):
        return bool(git(self.origin, 'for-each-ref', 'refs/heads/' + branch))


class SaveGetList(Fixture):
    def test_first_save_creates_the_branch_as_a_root_commit(self):
        head, status = git(self.a, 'rev-parse', 'HEAD'), git(self.a, 'status', '--porcelain')
        checked_out = git(self.a, 'rev-parse', '--abbrev-ref', 'HEAD')
        r = self.save(self.a, 'the handoff\n', 'STATE.md')
        self.assertEqual((r['saved'], r['path'], r['branch'], r['pushed'], r['unchanged']),
                         (True, 'STATE.md', BRANCH, True, False))
        self.assertEqual(git(self.origin, 'rev-parse', BRANCH), r['commit'])
        self.assertEqual(git(self.origin, 'rev-list', '--parents', '-n', '1', BRANCH), r['commit'],
                         'the first save is a root commit')
        self.assertEqual(self.origin_files(), ['STATE.md'])
        # Written without a checkout: the clone's branch, index and working tree are untouched.
        self.assertEqual(git(self.a, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.a, 'status', '--porcelain'), status)
        self.assertEqual(git(self.a, 'rev-parse', '--abbrev-ref', 'HEAD'), checked_out)
        self.assertEqual(self.origin_files('main'), [])

    def test_saves_in_turn_from_two_clones_keep_every_file(self):
        first = self.save(self.a, 'plan a\n', 'plans/feat-a.md')
        second = self.save(self.b, 'ledger b\n', 'reviews/feat-b.json')
        self.assertEqual(self.origin_files(), ['plans/feat-a.md', 'reviews/feat-b.json'])
        self.assertEqual(git(self.origin, 'rev-parse', BRANCH + '^'), first['commit'], 'b built on a\'s commit')
        self.assertEqual(self.run_state(self.b, 'get', 'plans/feat-a.md').stdout, b'plan a\n')
        self.assertEqual(self.run_state(self.a, 'get', 'reviews/feat-b.json').stdout, b'ledger b\n')
        again = self.save(self.b, 'ledger b\n', 'reviews/feat-b.json')
        self.assertEqual((again['unchanged'], again['pushed'], again['commit']), (True, False, second['commit']))

    def test_a_save_replaces_the_path_and_keeps_history(self):
        self.save(self.a, 'v1\n', 'STATE.md')
        self.save(self.a, 'v2\n', 'STATE.md')
        self.assertEqual(self.origin_show('STATE.md'), 'v2')
        self.assertEqual(git(self.origin, 'rev-list', '--count', BRANCH), '2')

    def test_as_stdin_and_the_default_path(self):
        src = os.path.join(self.tmp, 'notes.md')
        with open(src, 'w') as f:
            f.write('from a file\n')
        r = json.loads(self.run_state(self.a, 'save', src).stdout.decode())
        self.assertEqual(r['path'], 'notes.md')
        r = json.loads(self.run_state(self.a, 'save', src, '--as', 'design/panel-synthesis.md',
                                      '-m', 'panel synthesis').stdout.decode())
        self.assertEqual(r['path'], 'design/panel-synthesis.md')
        self.assertEqual(git(self.origin, 'log', '-1', '--format=%s', BRANCH), 'panel synthesis')
        self.save(self.a, 'from stdin\n', 'runs/20261110T120000Z-brief-to-proposals.json')
        self.assertEqual(self.origin_show('runs/20261110T120000Z-brief-to-proposals.json'), 'from stdin')
        r = self.run_state(self.a, 'save', '-', stdin=b'x', code=2)
        self.assertFalse(json.loads(r.stdout.decode())['saved'])
        self.assertIn(b'--as', r.stderr)

    def test_get_prints_or_writes_to_a_file(self):
        self.save(self.a, '{"findings": []}\n', 'reviews/feat-x.json')
        self.assertEqual(self.run_state(self.b, 'get', 'reviews/feat-x.json').stdout, b'{"findings": []}\n')
        dst = os.path.join(self.tmp, 'home', '.claude', 'reviews', 'feat-x.json')
        r = self.run_state(self.b, 'get', 'reviews/feat-x.json', '--to', dst)
        self.assertEqual(r.stdout, b'')
        with open(dst) as f:
            self.assertEqual(f.read(), '{"findings": []}\n')

    def test_list_filters_by_prefix_and_an_absent_branch_lists_nothing(self):
        self.assertEqual(self.run_state(self.a, 'list').stdout, b'')
        self.assertEqual(self.run_state(self.a, 'list', 'reviews/').stdout, b'')
        for p in ('STATE.md', 'plans/feat-a.md', 'reviews/feat-a.json', 'reviews/proposal-docs-design-roadmap.json'):
            self.save(self.a, p + '\n', p)
        self.assertEqual(self.run_state(self.b, 'list').stdout.decode().splitlines(),
                         ['STATE.md', 'plans/feat-a.md', 'reviews/feat-a.json',
                          'reviews/proposal-docs-design-roadmap.json'])
        self.assertEqual(self.run_state(self.b, 'list', 'reviews/proposal-').stdout.decode().splitlines(),
                         ['reviews/proposal-docs-design-roadmap.json'])

    def test_get_exits_3_when_the_branch_or_the_path_is_absent(self):
        self.run_state(self.a, 'get', 'STATE.md', code=3)
        self.save(self.a, 'x\n', 'STATE.md')
        self.run_state(self.b, 'get', 'plans/none.md', code=3)
        self.run_state(self.b, 'get', 'STATE.md')

    def test_branch_flag_and_env_name_other_branches(self):
        self.save(self.a, 'x\n', 'STATE.md', '--branch', 'state/other')
        self.save(self.a, 'y\n', 'STATE.md', env={'PIPELINE_STATE_BRANCH': 'state/env'})
        self.assertFalse(self.origin_has())
        self.assertEqual(self.origin_show('STATE.md', 'state/other'), 'x')
        self.assertEqual(self.origin_show('STATE.md', 'state/env'), 'y')
        self.assertEqual(self.run_state(self.b, '--branch', 'state/other', 'get', 'STATE.md').stdout, b'x\n')

    def test_a_linked_worktree_saves_without_touching_its_checkout(self):
        wt = os.path.join(self.tmp, 'wt')
        git(self.a, 'worktree', 'add', '-q', '-b', 'feat/lane', wt)
        self.save(wt, 'plan\n', 'plans/feat-lane.md')
        self.assertEqual(self.origin_files(), ['plans/feat-lane.md'])
        self.assertEqual(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/lane')
        self.assertEqual(git(wt, 'status', '--porcelain'), '')

    def test_slug(self):
        self.assertEqual(self.run_state(None, 'slug', 'feat/42-foo').stdout, b'feat-42-foo\n')
        self.assertEqual(self.run_state(None, 'slug', 'Feat/Foo_bar.baz@x y').stdout, b'Feat-Foo_bar.baz-x-y\n')


class Contention(Fixture):
    def test_a_rejected_push_fetches_and_retries(self):
        # b saves while a's push is under way (a pre-push hook runs after a fetched origin's tip), so origin
        # rejects a's push as non-fast-forward; a must fetch b's commit, rebuild on it and push again.
        marker = os.path.join(self.tmp, 'raced')
        hook = os.path.join(self.a, '.git', 'hooks', 'pre-push')
        with open(hook, 'w') as f:
            # git exports GIT_DIR to hooks; clear it so the save runs in clone b, not in a
            f.write('#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\nif [ ! -e "%s" ]; then\n  touch "%s"\n'
                    '  echo "b wins" | "%s" "%s" --repo "%s" save - --as race.md >/dev/null || exit 1\n'
                    'fi\nexit 0\n' % (marker, marker, sys.executable, STATE, self.b))
        os.chmod(hook, 0o755)
        r = self.save(self.a, 'a retried\n', 'STATE.md')
        self.assertTrue(os.path.exists(marker), 'the race ran')
        self.assertEqual(r['attempts'], 2)
        self.assertEqual(self.origin_files(), ['STATE.md', 'race.md'])
        self.assertEqual(self.origin_show('race.md'), 'b wins')
        self.assertEqual(git(self.origin, 'rev-parse', BRANCH), r['commit'])
        self.assertEqual(git(self.origin, 'rev-list', '--count', BRANCH), '2', 'linear history, nothing forced')

    def test_concurrent_saves_from_two_clones_all_land(self):
        loop = ('import subprocess, sys\n'
                'for i in range(4):\n'
                '    r = subprocess.run([sys.executable, %r, "--repo", sys.argv[1], "save", "-", "--as",\n'
                '                        "%%s/%%d.md" %% (sys.argv[2], i)], input=b"x", stdout=subprocess.DEVNULL)\n'
                '    if r.returncode:\n'
                '        sys.exit(r.returncode)\n' % STATE)
        procs = [subprocess.Popen([sys.executable, '-c', loop, repo, name], env=self.env)
                 for repo, name in ((self.a, 'a'), (self.b, 'b'))]
        self.assertEqual([p.wait(timeout=300) for p in procs], [0, 0])
        self.assertEqual(self.origin_files(), sorted('%s/%d.md' % (n, i) for n in 'ab' for i in range(4)))
        self.assertEqual(git(self.origin, 'rev-list', '--count', BRANCH), '8')


class Local(Fixture):
    def test_no_push_commits_to_the_local_ref_and_local_reads_it(self):
        r = self.save(self.a, 'offline\n', 'STATE.md', '--no-push')
        self.assertEqual((r['pushed'], r['unchanged']), (False, False))
        self.assertEqual(git(self.a, 'rev-parse', 'refs/heads/' + BRANCH), r['commit'])
        self.assertFalse(self.origin_has(), 'nothing was pushed')
        self.assertEqual(self.run_state(self.a, 'get', 'STATE.md', '--local').stdout, b'offline\n')
        self.assertEqual(self.run_state(self.a, 'list', '--local').stdout, b'STATE.md\n')
        self.run_state(self.a, 'get', 'STATE.md', code=3)          # origin has no state branch
        self.run_state(self.b, 'get', 'STATE.md', '--local', code=3)
        self.assertEqual(self.run_state(self.b, 'list', '--local').stdout, b'')
        r2 = self.save(self.a, 'offline 2\n', 'plans/p.md', '--no-push')
        self.assertEqual(git(self.a, 'rev-parse', r2['commit'] + '^'), r['commit'])

    def test_a_pushed_save_never_drops_local_only_commits(self):
        local = self.save(self.a, 'offline\n', 'STATE.md', '--no-push')['commit']
        self.save(self.b, 'online\n', 'plans/p.md')
        self.save(self.a, 'online a\n', 'plans/q.md')
        self.assertEqual(self.origin_files(), ['plans/p.md', 'plans/q.md'])
        self.assertEqual(git(self.a, 'rev-parse', 'refs/heads/' + BRANCH), local, 'the local-only save is kept')

    def test_a_pushed_save_fast_forwards_the_local_ref(self):
        r = self.save(self.a, 'x\n', 'STATE.md')
        self.assertEqual(git(self.a, 'rev-parse', 'refs/heads/' + BRANCH), r['commit'])
        self.assertEqual(self.run_state(self.a, 'get', 'STATE.md', '--local').stdout, b'x\n')

    def test_no_push_refuses_a_checked_out_state_branch(self):
        self.save(self.a, 'x\n', 'STATE.md', '--no-push')
        git(self.a, 'worktree', 'add', '-q', os.path.join(self.tmp, 'statewt'), BRANCH)
        self.save(self.a, 'y\n', 'STATE.md', '--no-push', code=2)


class Failures(Fixture):
    def test_usage_and_git_failures_exit_2_never_1(self):
        solo = os.path.join(self.tmp, 'solo')
        os.makedirs(solo)
        git(solo, 'init', '-q')
        r = self.run_state(solo, 'save', '-', '--as', 'STATE.md', stdin=b'x', code=2)    # no origin
        result = json.loads(r.stdout.decode())
        self.assertFalse(result['saved'])
        self.assertIn('origin', result['error'])
        self.run_state(solo, 'get', 'STATE.md', code=2)
        self.run_state(solo, 'list', code=2)
        self.run_state(self.tmp, 'list', code=2)                                       # not a repository
        self.run_state(self.a, code=2)                                                 # no subcommand
        self.run_state(self.a, 'save', code=2)
        self.run_state(self.a, 'get', 'x', '--bogus', code=2)
        for bad in ('../x.md', '/abs.md', 'a//b.md', './a.md', 'dir/', '.git/config', 'a\\b.md'):
            self.save(self.a, 'x', bad, code=2)
            self.run_state(self.a, 'get', bad, code=2)
        self.save(self.a, 'SECRET=1\n', '.env', code=2)
        self.save(self.a, 'SECRET=1\n', 'config/.env.local', code=2)
        for b in ('main', 'master', '-x', 'bad..name', 'a@{1}'):
            self.assertFalse(self.save(self.a, 'x', 'STATE.md', '--branch=' + b, code=2)['saved'])
        self.assertFalse(self.origin_has())
        self.assertEqual(git(self.origin, 'rev-parse', 'main'), git(self.a, 'rev-parse', 'HEAD'))

    def test_an_unreachable_origin_exits_2_after_the_retries(self):
        git(self.a, 'remote', 'set-url', 'origin', os.path.join(self.tmp, 'gone.git'))
        r = self.save(self.a, 'x', 'STATE.md', code=2)
        self.assertIn('after 6 attempts', r['error'])


if __name__ == '__main__':
    unittest.main()

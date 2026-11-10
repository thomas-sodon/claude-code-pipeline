#!/usr/bin/env python3
"""Keep pipeline state files on a branch of origin (stdlib only, Python 3.8+).

pipeline-state.py [--repo DIR] [--branch NAME] save SRC [--as PATH] [-m MSG] [--no-push]
pipeline-state.py [--repo DIR] [--branch NAME] get PATH [--to FILE] [--local]
pipeline-state.py [--repo DIR] [--branch NAME] list [PREFIX] [--local]
pipeline-state.py slug NAME

The state branch (default pipeline/state; --branch or env PIPELINE_STATE_BRANCH
overrides) holds what the pipeline must not lose with a container: the
orchestrator's handoff (STATE.md), lane plans (plans/<branch-slug>.md), review
ledgers (reviews/<branch-slug>.json, reviews/proposal-<doc-slug>.json), the design
panel's synthesis (design/panel-synthesis.md) and run records
(runs/<YYYYMMDDTHHMMSSZ>-<workflow>.json). It is never main and never
force-pushed. It is written without a checkout, with git plumbing and a temporary
index (GIT_INDEX_FILE), so any worktree of the repository can save to it while its
own branch stays checked out, and nothing in the working tree or the real index
changes.

save SRC     store the file SRC at PATH (--as; default SRC's basename; SRC "-"
             reads stdin and then needs --as). It fetches origin's tip, builds a
             commit on it that changes only PATH, and pushes it. A push rejected
             because another clone saved first (non-fast-forward) fetches the new
             tip and rebuilds on it, up to 5 retries. When origin has no state
             branch, the first save creates it as a root commit. Prints
             {"saved": true, "path", "commit", "branch", "pushed", "unchanged",
             "attempts"}; saving identical content makes no commit (unchanged).
             --no-push commits to the local ref refs/heads/<branch> only (tests,
             offline use). A .env file is refused: the branch is as visible as the
             repository and never holds secrets.
get PATH     fetch, then print PATH's content from origin/<branch>, or write it to
             --to FILE (parent directories created). --local reads the local ref
             refs/heads/<branch> instead, without fetching.
list PREFIX  the stored paths that start with PREFIX (default: all), one per line.
             An absent branch lists nothing. --local as for get.
slug NAME    NAME as the state branch spells it in paths: the <branch-slug> of
             plans/<branch-slug>.md and reviews/<branch-slug>.json, and the
             <doc-slug> of reviews/proposal-<doc-slug>.json. Every character outside
             [A-Za-z0-9._-] becomes "-"; when any did, "-" and 8 lowercase hex digits
             of the FNV-1a 32-bit hash of NAME's UTF-8 bytes follow, so names that
             read the same once replaced (feat/x, feat-x, feat:x) get different
             paths. A name with nothing to replace is its own slug. The workflows'
             copy (stateSlug, behind planRefFor) must print the same for every
             name; ci/test-workflow-shipping.mjs checks that against this script.

Run it from inside any checkout of the product repository, or point --repo at one.
Network commands never prompt for credentials (GIT_TERMINAL_PROMPT=0).

Exit: 0 = done; 2 = usage error or git failure (not a repository, no origin, the
network still failing after the retries, a push still rejected after the retries);
3 = get: the branch or PATH is absent. Never 1. Saving is best effort for its
callers: a stage whose save exits 2 logs it and goes on.
"""

import argparse
import json
import os
import posixpath
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time

DEFAULT_BRANCH = 'pipeline/state'
REMOTE = 'origin'
RETRIES = 5                   # retries after the first attempt, for a rejected push and for network failures
NET_TIMEOUT = 60              # seconds for one network git call
MAX_BYTES = 5 * 1024 * 1024   # a state file is a handoff, a plan or a ledger, not an artifact store
PROTECTED = ('main', 'master')
SLUG_RE = re.compile(r'[^A-Za-z0-9._-]')
FNV_OFFSET, FNV_PRIME = 0x811c9dc5, 0x01000193
ZERO = '0' * 40


class Fail(Exception):
    """A usage error or a git failure: exit 2."""


class Absent(Exception):
    """get: the branch or the path does not exist: exit 3."""


def git(repo, *args, data=None, env=None, check=True, timeout=None):
    e = dict(os.environ)
    e['GIT_TERMINAL_PROMPT'] = '0'
    if env:
        e.update(env)
    try:
        r = subprocess.run(['git', '-C', repo] + list(args), input=data, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=e, timeout=timeout)
    except subprocess.TimeoutExpired:
        if check:
            raise Fail('git %s timed out after %ds' % (args[0], timeout))
        return subprocess.CompletedProcess(args, 124, b'', b'timed out after %ds' % timeout)
    except OSError as ex:
        raise Fail('cannot run git: %s' % ex)
    if check and r.returncode != 0:
        raise Fail('git %s failed: %s' % (args[0], err(r)))
    return r


def out(r):
    return r.stdout.decode('utf-8', 'replace').strip()


def err(r):
    return (r.stderr or b'').decode('utf-8', 'replace').strip() or 'exit %d' % r.returncode


def fnv1a32(data):
    """FNV-1a, 32 bits, over bytes."""
    h = FNV_OFFSET
    for b in bytearray(data):
        h = ((h ^ b) * FNV_PRIME) & 0xffffffff
    return h


def slug(name):
    """NAME as the state branch spells it in paths (see slug NAME above). Injective: a name with nothing to replace
    is itself, and every other one carries the hash of the name as given, so feat/x and feat-x never share a file.
    surrogateescape gives back the exact bytes of a command-line argument that is not valid UTF-8."""
    out = SLUG_RE.sub('-', name)
    if out == name:
        return out
    return '%s-%08x' % (out, fnv1a32(name.encode('utf-8', 'surrogateescape')))


def rev(repo, name):
    """The commit a ref or revision names, or None."""
    r = git(repo, 'rev-parse', '--verify', '--quiet', name + '^{commit}', check=False)
    return out(r) if r.returncode == 0 and out(r) else None


def state_path(p, what='PATH'):
    """A normalized relative path inside the branch, or Fail."""
    if not p or '\\' in p or '\0' in p or '\n' in p or p.startswith('/') or p.endswith('/'):
        raise Fail('%s %r must be a relative file path inside the state branch' % (what, p))
    parts = p.split('/')
    if posixpath.normpath(p) != p or any(x in ('', '.', '..', '.git') for x in parts):
        raise Fail('%s %r must be a normalized relative path (no ".", "..", ".git" or empty parts)' % (what, p))
    return p


def prefix_path(p):
    if not p:
        return ''
    if '\\' in p or '\0' in p or p.startswith('/') or any(x in ('.', '..') for x in p.split('/')):
        raise Fail('PREFIX %r must be a relative path prefix' % p)
    return p


def branch_name(a, repo):
    b = a.branch or os.environ.get('PIPELINE_STATE_BRANCH') or DEFAULT_BRANCH
    if b.startswith('-') or '@{' in b or git(repo, 'check-ref-format', 'refs/heads/' + b,
                                              check=False).returncode != 0:
        raise Fail('%r is not a valid branch name' % b)
    head = out(git(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/%s/HEAD' % REMOTE, check=False))
    default = head.split('/', 1)[1] if head.startswith(REMOTE + '/') else None
    if b in PROTECTED or b == default:
        raise Fail('the state branch is never the main branch (%s)' % b)
    return b


def repo_dir(a):
    d = os.path.abspath(a.repo or '.')
    if not os.path.isdir(d) or git(d, 'rev-parse', '--git-dir', check=False).returncode != 0:
        raise Fail('%s is not inside a git repository (run from a checkout, or pass --repo DIR)' % d)
    return d


def need_origin(repo):
    if git(repo, 'remote', 'get-url', REMOTE, check=False).returncode != 0:
        raise Fail('the repository has no remote "%s" (save --no-push and get/list --local work without one)'
                   % REMOTE)


def backoff(attempt):
    time.sleep(min(0.2 * 2 ** (attempt - 1), 3.2) + random.uniform(0, 0.2))


def remote_tip(repo, branch):
    """Fetch origin's state branch into refs/remotes/origin/<branch> and return its commit, or None when origin
    has no such branch. A network failure is retried; still failing after the retries is Fail."""
    ref, track = 'refs/heads/' + branch, 'refs/remotes/%s/%s' % (REMOTE, branch)
    last = ''
    for attempt in range(RETRIES + 1):
        if attempt:
            backoff(attempt)
        r = git(repo, 'ls-remote', '--exit-code', REMOTE, ref, check=False, timeout=NET_TIMEOUT)
        if r.returncode == 2:
            # origin answered and has no such branch: forget a stale tracking ref so nothing builds on it
            git(repo, 'update-ref', '-d', track, check=False)
            return None
        if r.returncode != 0:
            last = err(r)
            continue
        sha = next((l.split()[0] for l in out(r).splitlines() if l.split()[1:] == [ref]), None)
        if not sha:
            last = 'ls-remote listed no %s' % ref
            continue
        if rev(repo, sha):
            git(repo, 'update-ref', track, sha)
            return sha
        f = git(repo, 'fetch', '--quiet', '--no-tags', REMOTE, '+%s:%s' % (ref, track), check=False,
                timeout=NET_TIMEOUT)
        if f.returncode != 0:
            last = err(f)
            continue
        tip = rev(repo, track)
        if tip:
            return tip
        last = 'fetch left no %s' % track
    raise Fail('cannot read %s from %s after %d attempts: %s' % (branch, REMOTE, RETRIES + 1, last))


def identity(repo):
    """Author and committer for the state commits: the repository's own, else a fixed pipeline identity."""
    if all(git(repo, 'var', v, check=False).returncode == 0 for v in ('GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT')):
        return {}
    env = {}
    for who in ('AUTHOR', 'COMMITTER'):
        env.setdefault('GIT_%s_NAME' % who, os.environ.get('GIT_%s_NAME' % who) or 'pipeline-state')
        env.setdefault('GIT_%s_EMAIL' % who, os.environ.get('GIT_%s_EMAIL' % who) or 'pipeline-state@localhost')
    return env


def checked_out(repo, branch):
    """The worktree that has the state branch checked out, or None."""
    r = git(repo, 'worktree', 'list', '--porcelain', check=False)
    wt = None
    for line in out(r).splitlines():
        if line.startswith('worktree '):
            wt = line[len('worktree '):]
        elif line == 'branch refs/heads/' + branch:
            return wt or '?'
    return None


def build(repo, parent, path, blob, msg, env):
    """A commit on parent (None: a root commit) whose tree is parent's with PATH set to blob, built in a temporary
    index. Returns (commit, unchanged): unchanged when parent already holds that content (no commit is made)."""
    tmp = tempfile.mkdtemp(prefix='pipeline-state-')
    try:
        e = dict(env)
        e['GIT_INDEX_FILE'] = os.path.join(tmp, 'index')
        git(repo, *(['read-tree', parent] if parent else ['read-tree', '--empty']), env=e)
        git(repo, 'update-index', '--add', '--cacheinfo', '100644,%s,%s' % (blob, path), env=e)
        tree = out(git(repo, 'write-tree', env=e))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if parent and tree == out(git(repo, 'rev-parse', parent + '^{tree}')):
        return parent, True
    args = ['commit-tree', tree, '-m', msg] + (['-p', parent] if parent else [])
    return out(git(repo, *args, env=env)), False


def advance_local(repo, branch, commit):
    """Fast-forward refs/heads/<branch> to commit when that loses nothing (absent, or an ancestor of commit), so
    get --local after a pushed save reads it too. Never moves a checked-out branch or drops local-only commits."""
    ref = 'refs/heads/' + branch
    old = rev(repo, ref)
    if old == commit or checked_out(repo, branch):
        return
    if old and git(repo, 'merge-base', '--is-ancestor', old, commit, check=False).returncode != 0:
        return
    git(repo, 'update-ref', ref, commit, old or ZERO, check=False)


def cmd_save(a, repo):
    branch = branch_name(a, repo)
    if a.src == '-' and not a.as_path:
        raise Fail('save - reads stdin and needs --as PATH')
    path = state_path(a.as_path or os.path.basename(a.src.rstrip('/')), '--as' if a.as_path else 'SRC basename')
    base = posixpath.basename(path)
    if base == '.env' or base.startswith('.env.'):
        raise Fail('refusing to store %s: the state branch never holds .env files or secrets' % path)
    try:
        if a.src == '-':
            data = sys.stdin.buffer.read(MAX_BYTES + 1)
        else:
            with open(a.src, 'rb') as f:
                data = f.read(MAX_BYTES + 1)
    except OSError as e:
        raise Fail('cannot read %s: %s' % (a.src, e.strerror or e))
    if len(data) > MAX_BYTES:
        raise Fail('%s is over %d bytes; the state branch is for handoffs, plans and ledgers' % (a.src, MAX_BYTES))
    blob = out(git(repo, 'hash-object', '-w', '--stdin', data=data))
    msg = a.message or 'pipeline-state: save %s' % path
    env = identity(repo)
    result = {'saved': True, 'path': path, 'branch': branch}
    if a.no_push:
        where = checked_out(repo, branch)
        if where:
            raise Fail('the state branch %s is checked out in %s; it is only ever written without a checkout'
                       % (branch, where))
        ref = 'refs/heads/' + branch
        old = rev(repo, ref)
        parent = old or rev(repo, 'refs/remotes/%s/%s' % (REMOTE, branch))
        commit, unchanged = build(repo, parent, path, blob, msg, env)
        if not unchanged or not old:
            git(repo, 'update-ref', ref, commit, old or ZERO)
        result.update(commit=commit, pushed=False, unchanged=unchanged, attempts=0)
        return result
    need_origin(repo)
    last = ''
    for attempt in range(RETRIES + 1):
        if attempt:
            backoff(attempt)
        tip = remote_tip(repo, branch)
        commit, unchanged = build(repo, tip, path, blob, msg, env)
        if unchanged:
            advance_local(repo, branch, commit)
            result.update(commit=commit, pushed=False, unchanged=True, attempts=attempt + 1)
            return result
        # A plain push, never --force: when another clone saved after our fetch, origin rejects it as
        # non-fast-forward and the next attempt rebuilds on the new tip.
        r = git(repo, 'push', '--quiet', '--porcelain', REMOTE, '%s:refs/heads/%s' % (commit, branch),
                check=False, timeout=NET_TIMEOUT)
        if r.returncode == 0:
            git(repo, 'update-ref', 'refs/remotes/%s/%s' % (REMOTE, branch), commit, check=False)
            advance_local(repo, branch, commit)
            result.update(commit=commit, pushed=True, unchanged=False, attempts=attempt + 1)
            return result
        last = ' '.join((out(r) + ' ' + err(r)).split())
    raise Fail('push to %s/%s still failing after %d attempts: %s' % (REMOTE, branch, RETRIES + 1, last))


def source_ref(a, repo, branch):
    """The commit get/list read: the local ref with --local, else origin's freshly fetched tip; None when absent."""
    if a.local:
        return rev(repo, 'refs/heads/' + branch)
    need_origin(repo)
    return remote_tip(repo, branch)


def cmd_get(a, repo):
    branch = branch_name(a, repo)
    path = state_path(a.path)
    commit = source_ref(a, repo, branch)
    if not commit:
        raise Absent('%s has no state branch %s' % ('the local repository' if a.local else REMOTE, branch))
    obj = '%s:%s' % (commit, path)
    t = git(repo, 'cat-file', '-t', obj, check=False)
    if t.returncode != 0 or out(t) != 'blob':
        raise Absent('%s has no file %s' % (branch, path))
    data = git(repo, 'cat-file', 'blob', obj).stdout
    if a.to:
        dst = os.path.abspath(os.path.expanduser(a.to))
        d = os.path.dirname(dst)
        tmp = '%s.tmp.%d' % (dst, os.getpid())
        try:
            os.makedirs(d, exist_ok=True)
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, dst)
        except OSError as e:
            if os.path.lexists(tmp):
                os.remove(tmp)
            raise Fail('cannot write %s: %s' % (dst, e.strerror or e))
    else:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    return None


def cmd_list(a, repo):
    branch = branch_name(a, repo)
    prefix = prefix_path(a.prefix)
    commit = source_ref(a, repo, branch)
    if not commit:
        return None
    names = git(repo, 'ls-tree', '-r', '-z', '--name-only', commit).stdout.decode('utf-8', 'replace').split('\0')
    for n in names:
        if n and n.startswith(prefix):
            sys.stdout.write(n + '\n')
    sys.stdout.flush()
    return None


def parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--repo', default=argparse.SUPPRESS,
                        help='a checkout of the product repository (default: the working directory)')
    common.add_argument('--branch', default=argparse.SUPPRESS,
                        help='the state branch (default: env PIPELINE_STATE_BRANCH, else %s)' % DEFAULT_BRANCH)
    p = argparse.ArgumentParser(prog='pipeline-state.py', parents=[common],
                                description='Keep pipeline state files on a branch of origin.')
    sub = p.add_subparsers(dest='cmd', metavar='{save,get,list,slug}')
    sub.required = True
    s = sub.add_parser('save', parents=[common], help='store a file on the state branch')
    s.add_argument('src', metavar='SRC', help='the file to store; - reads stdin (needs --as)')
    s.add_argument('--as', dest='as_path', metavar='PATH', help="path inside the branch (default: SRC's basename)")
    s.add_argument('-m', dest='message', metavar='MSG', help='commit message')
    s.add_argument('--no-push', action='store_true', help='commit to the local ref refs/heads/<branch> only')
    g = sub.add_parser('get', parents=[common], help="print a file from origin's state branch")
    g.add_argument('path', metavar='PATH')
    g.add_argument('--to', metavar='FILE', help='write it to FILE instead (parent directories created)')
    g.add_argument('--local', action='store_true', help='read the local ref instead of fetching')
    ls = sub.add_parser('list', parents=[common], help='list the stored paths')
    ls.add_argument('prefix', metavar='PREFIX', nargs='?', default='')
    ls.add_argument('--local', action='store_true', help='read the local ref instead of fetching')
    sl = sub.add_parser('slug', help='print a branch name as the state branch spells it in paths')
    sl.add_argument('name', metavar='NAME')
    return p


def main(argv=None):
    a = parser().parse_args(argv)   # usage errors exit 2
    a.repo = getattr(a, 'repo', None)
    a.branch = getattr(a, 'branch', None)
    try:
        if a.cmd == 'slug':
            print(slug(a.name))
            return 0
        repo = repo_dir(a)
        if a.cmd == 'save':
            print(json.dumps(cmd_save(a, repo)))
        elif a.cmd == 'get':
            cmd_get(a, repo)
        else:
            cmd_list(a, repo)
        return 0
    except Absent as e:
        print('pipeline-state: %s' % e, file=sys.stderr)
        return 3
    except Fail as e:
        if a.cmd == 'save':
            print(json.dumps({'saved': False, 'error': str(e)}))
        print('pipeline-state: %s' % e, file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 2
    except Exception as e:   # never exit 1: an unexpected error is a failure like any other
        print('pipeline-state: unexpected error: %r' % e, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())

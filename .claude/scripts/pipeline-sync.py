#!/usr/bin/env python3
"""Install or update the pipeline's files in a repository (stdlib only, Python 3.8+).

pipeline-sync.py [--target DIR] [--from DIR | --repo URL] [--ref REF]
                 [--update] [--force] [--dry-run] [--check] [--json]

Copies .claude/commands/, .claude/skills/, .claude/workflows/ and .claude/scripts/
from a pipeline source into the target repository, and .claude/settings.json only
when the target has none. It records what it installed in
.claude/pipeline-manifest.json: the source (repo URL, ref, commit) and the sha256 of
every pipeline file as the source shipped it. That record is the base of a three-way
comparison on the next run, so an update can tell an upstream change from a local
edit:

  target == source                      identical    (nothing to do)
  target absent, never installed        added        (copied)
  target absent, installed before       removed_locally (kept removed: you deleted it)
  target == base, source changed        outdated     -> updated with --update
  target edited, source == base         local_edit   (kept)
  target edited, source changed too     conflict     (kept; --update --force takes the source's)
  no base recorded, target differs      differs      (kept; --update takes the source's)
  in base, gone from source, unedited   obsolete     -> deleted with --update
  in base, gone from source, edited     obsolete_edited (kept)

Without --update it only adds missing files (what /seed does on a first install).
It never touches CLAUDE.md, never follows a symlink, never commits.

Source: --from DIR (a checkout of the pipeline, or a project that has it), else
--repo URL cloned at --ref (default: the manifest's repo and ref, else
https://github.com/thomas-sodon/claude-code-pipeline at main).

--check: change nothing; exit 1 when anything would be added, updated or deleted,
or a conflict / differs is pending (for a scheduled CI job).
--dry-run: change nothing; report what would happen.

Exit: 0 = done (or, with --check, up to date); 1 = --check found pending changes;
2 = usage error, missing source, or a git failure.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

DIRS = ('commands', 'skills', 'workflows', 'scripts')
MANIFEST = os.path.join('.claude', 'pipeline-manifest.json')
DEFAULT_REPO = 'https://github.com/thomas-sodon/claude-code-pipeline'
DEFAULT_REF = 'main'
# A pipeline source must hold these (the same check /seed makes).
REQUIRED = (os.path.join('.claude', 'workflows', 'brief-to-proposals.js'),
            os.path.join('.claude', 'scripts', 'proposal-lint.py'))
PENDING = ('added', 'outdated', 'conflict', 'differs', 'obsolete')


class Fail(Exception):
    pass


def git(cwd, *a, check=True):
    r = subprocess.run(['git', '-C', cwd] + list(a), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True)
    if check and r.returncode != 0:
        raise Fail('git %s failed: %s' % (' '.join(a), r.stderr.strip()))
    return r.stdout.strip() if r.returncode == 0 else None


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def is_git(d):
    return git(d, 'rev-parse', '--show-toplevel', check=False) is not None


def source_files(src):
    """Repo-relative paths (with / separators) of every regular, non-symlink pipeline file in src."""
    out = []
    if is_git(src):
        for d in DIRS:
            listed = git(src, 'ls-files', '--cached', '--others', '--exclude-standard', '--', '.claude/' + d)
            out += [p for p in (listed or '').splitlines() if p]
    else:
        for d in DIRS:
            base = os.path.join(src, '.claude', d)
            for root, dirs, files in os.walk(base):
                dirs[:] = [x for x in dirs if x != '__pycache__' and not os.path.islink(os.path.join(root, x))]
                for f in files:
                    if not f.endswith('.pyc'):
                        out.append(os.path.relpath(os.path.join(root, f), src).replace(os.sep, '/'))
    return sorted(p for p in set(out)
                  if os.path.isfile(os.path.join(src, p)) and not os.path.islink(os.path.join(src, p)))


def load_manifest(target):
    p = os.path.join(target, MANIFEST)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding='utf-8') as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        raise Fail('%s is unreadable (%s): fix or delete it' % (MANIFEST, e))
    if not isinstance(m, dict) or not isinstance(m.get('files'), dict):
        raise Fail('%s has no "files" object: fix or delete it' % MANIFEST)
    return m


def atomic_copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = '%s.tmp.%d' % (dst, os.getpid())
    shutil.copyfile(src, tmp)
    shutil.copymode(src, tmp)
    os.replace(tmp, dst)


def write_manifest(target, data):
    p = os.path.join(target, MANIFEST)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = '%s.tmp.%d' % (p, os.getpid())
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write('\n')
    os.replace(tmp, p)


def classify(rel, src, target, base):
    s = os.path.join(src, rel) if src else None
    t = os.path.join(target, rel)
    if os.path.islink(t):
        return 'symlink'
    s_hash = sha(s) if s else None
    t_hash = sha(t) if os.path.isfile(t) else None
    if s_hash is None:  # in the base, gone from the source
        if t_hash is None:
            return 'gone'
        return 'obsolete' if t_hash == base else 'obsolete_edited'
    if t_hash is None:
        return 'removed_locally' if base else 'added'
    if t_hash == s_hash:
        return 'identical'
    if base is None:
        return 'differs'
    if t_hash == base:
        return 'outdated'
    if s_hash == base:
        return 'local_edit'
    return 'conflict'


def sync(a):
    target = git(os.path.abspath(a.target), 'rev-parse', '--show-toplevel', check=False)
    if not target:
        raise Fail('%s is not a git repository' % a.target)
    manifest = load_manifest(target)
    prev = (manifest or {}).get('source') or {}
    tmpdir = None
    try:
        if a.source:
            src = os.path.abspath(a.source)
            repo = git(src, 'remote', 'get-url', 'origin', check=False) if is_git(src) else None
            ref = a.ref or (git(src, 'rev-parse', '--abbrev-ref', 'HEAD', check=False) if is_git(src) else None)
        else:
            repo = a.repo or prev.get('repo') or DEFAULT_REPO
            ref = a.ref or prev.get('ref') or DEFAULT_REF
            tmpdir = tempfile.mkdtemp(prefix='pipeline-sync-')
            src = os.path.join(tmpdir, 'src')
            r = subprocess.run(['git', 'clone', '--quiet', '--depth', '1', '--branch', ref, repo, src],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            if r.returncode != 0:
                raise Fail('git clone %s at %s failed: %s' % (repo, ref, r.stderr.strip()))
        missing = [p for p in REQUIRED if not os.path.isfile(os.path.join(src, p))]
        if missing:
            raise Fail('%s is not a pipeline source: missing %s' % (src, ', '.join(missing)))
        same = os.path.realpath(src) == os.path.realpath(target)
        commit = git(src, 'rev-parse', 'HEAD', check=False) if is_git(src) else None
        dirty = []
        if is_git(src) and not tmpdir:
            st = git(src, 'status', '--porcelain', '--', *['.claude/' + d for d in DIRS], check=False) or ''
            dirty = [l[3:] for l in st.splitlines() if l]

        files = [] if same else source_files(src)
        bases = dict((manifest or {}).get('files') or {})
        if same:
            # Nothing to copy: the target is the source. Record the files as they are.
            files = source_files(src)
        report = {k: [] for k in ('added', 'identical', 'outdated', 'updated', 'local_edit', 'conflict',
                                  'differs', 'removed_locally', 'obsolete', 'deleted', 'obsolete_edited',
                                  'symlink')}
        new_bases = {}
        write = not (a.dry_run or a.check)
        for rel in files:
            base = bases.get(rel)
            kind = 'identical' if same else classify(rel, src, target, base)
            s_hash = sha(os.path.join(src, rel))
            take = (kind == 'added' or (a.update and kind in ('outdated', 'differs'))
                    or (a.update and a.force and kind == 'conflict'))
            if take:
                if write:
                    atomic_copy(os.path.join(src, rel), os.path.join(target, rel))
                report['added' if kind == 'added' else 'updated'].append(rel)
                new_bases[rel] = s_hash
            else:
                report[kind].append(rel)
                # The base stays what the source last shipped and the target last took: identical files take the
                # source's; a kept edit or conflict keeps the old base, so it stays an edit on the next run.
                if kind == 'identical':
                    new_bases[rel] = s_hash
                elif kind in ('local_edit', 'conflict', 'outdated', 'removed_locally'):
                    new_bases[rel] = base
        if not same:
            for rel in sorted(set(bases) - set(files)):
                kind = classify(rel, None, target, bases[rel])
                if kind == 'obsolete' and a.update:
                    if write:
                        os.remove(os.path.join(target, rel))
                    report['deleted'].append(rel)
                elif kind == 'gone':
                    continue
                else:
                    report[kind].append(rel)
                    new_bases[rel] = bases[rel]
        settings = os.path.join('.claude', 'settings.json')
        settings_copied = (not same and os.path.isfile(os.path.join(src, settings))
                           and not os.path.lexists(os.path.join(target, settings)))
        if settings_copied and write:
            atomic_copy(os.path.join(src, settings), os.path.join(target, settings))
        if write:
            write_manifest(target, {
                'source': {'repo': repo, 'ref': ref, 'commit': commit},
                'files': {k: v for k, v in sorted(new_bases.items()) if v},
            })
        # Work still left: before writing (check, dry-run), every change; after writing, what was kept back.
        pending = [k for k in ('added', 'updated', 'deleted') + PENDING[1:] if report[k]
                   and (not write or k in PENDING[1:])]
        out = {
            'target': target, 'source': {'path': None if tmpdir else src, 'repo': repo, 'ref': ref,
                                         'commit': commit, 'uncommitted': dirty},
            'previous_commit': prev.get('commit'), 'same_dir': same, 'mode': 'check' if a.check else
            'dry-run' if a.dry_run else 'update' if a.update else 'install',
            'settings_json_copied': settings_copied, 'pending': pending,
            **{k: v for k, v in report.items()},
        }
        return out
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


def human(r):
    lines = ['Pipeline sync (%s): %s from %s%s' % (
        r['mode'], r['target'], r['source']['path'] or r['source']['repo'],
        ' @ %s' % r['source']['commit'][:12] if r['source']['commit'] else '')]
    if r['previous_commit'] and r['previous_commit'] != r['source']['commit']:
        lines.append('  previously installed: %s' % r['previous_commit'][:12])
    if r['same_dir']:
        lines.append('  source and target are the same directory: nothing to copy; manifest recorded')
    labels = [('added', 'added'), ('updated', 'updated'), ('deleted', 'deleted (removed upstream)'),
              ('outdated', 'outdated (run with --update)'), ('differs', 'differs, no install record (--update takes the source\'s)'),
              ('conflict', 'conflict: edited here and upstream (kept; --update --force takes the source\'s)'),
              ('local_edit', 'edited here, unchanged upstream (kept)'),
              ('obsolete', 'removed upstream (run with --update to delete)'),
              ('obsolete_edited', 'removed upstream but edited here (kept)'),
              ('removed_locally', 'deleted here (kept deleted)'), ('symlink', 'symlink in the target (skipped)')]
    for key, label in labels:
        if r[key]:
            lines.append('  %s: %d' % (label, len(r[key])))
            lines += ['    %s' % p for p in r[key]]
    lines.append('  identical: %d' % len(r['identical']))
    if r['settings_json_copied']:
        lines.append('  .claude/settings.json copied (the target had none)')
    if r['source']['uncommitted']:
        lines.append('  WARNING: the source has uncommitted changes (an unreleased version): %s'
                     % ', '.join(r['source']['uncommitted']))
    if r['pending']:
        lines.append('  pending: %s' % ', '.join(r['pending']))
    return '\n'.join(lines)


def main(argv=None):
    p = argparse.ArgumentParser(description='Install or update the pipeline\'s .claude files in a repository.')
    p.add_argument('--target', default='.', help='repository to install into (default: the working directory)')
    g = p.add_mutually_exclusive_group()
    g.add_argument('--from', dest='source', help='a local pipeline source directory')
    g.add_argument('--repo', help='pipeline git URL to clone (default: the manifest\'s, else %s)' % DEFAULT_REPO)
    p.add_argument('--ref', help='branch or tag to clone (default: the manifest\'s, else %s)' % DEFAULT_REF)
    p.add_argument('--update', action='store_true', help='replace outdated files and delete obsolete ones')
    p.add_argument('--force', action='store_true', help='with --update: also take the source\'s version of conflicts')
    p.add_argument('--dry-run', action='store_true', help='change nothing; report what would happen')
    p.add_argument('--check', action='store_true', help='change nothing; exit 1 when anything is pending')
    p.add_argument('--json', action='store_true', help='print the report as JSON')
    a = p.parse_args(argv)
    if a.force and not a.update:
        p.error('--force needs --update')
    try:
        r = sync(a)
    except Fail as e:
        if a.json:
            print(json.dumps({'error': str(e)}))
        else:
            print('pipeline-sync: %s' % e, file=sys.stderr)
        return 2
    print(json.dumps(r, indent=2) if a.json else human(r))
    return 1 if a.check and r['pending'] else 0


if __name__ == '__main__':
    sys.exit(main())

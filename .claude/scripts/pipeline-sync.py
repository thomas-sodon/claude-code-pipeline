#!/usr/bin/env python3
"""Install or update the pipeline's files in a repository (stdlib only, Python 3.8+).

pipeline-sync.py [--target DIR] [--from DIR | --repo URL] [--ref REF]
                 [--update] [--force] [--dry-run] [--check] [--check-claude-md] [--json]

Copies .claude/commands/, .claude/skills/, .claude/workflows/ and .claude/scripts/
from a pipeline source into the target repository, and .claude/settings.json only
when the target has none. It records what it installed in
.claude/pipeline-manifest.json: the source (repo URL, ref, commit) and the sha256 of
every pipeline file as the source shipped it. That record is the base of a three-way
comparison on the next run, so an update can tell an upstream change from a local
edit:

  target == source                      identical    (nothing to do)
  same contents, executable bit changed mode         -> mode applied with --update
  target absent, never installed        added        (copied)
  target absent, installed before       removed_locally (kept removed: you deleted it)
  target == base, source changed        outdated     -> updated with --update
  target edited, source == base         local_edit   (kept)
  target edited, source changed too     conflict     (kept; --update --force takes the source's)
  no base recorded, target differs      differs      (kept; --update --force takes the source's)
  no base, target is an older upstream  outdated     (adopted: a legacy cp -r install, see below)
  in base, gone from source, unedited   obsolete     -> deleted with --update
  in base, gone from source, edited     obsolete_edited (kept)

Without --update it only adds missing files (what /seed does on a first install).
It never edits CLAUDE.md, never follows a symlink, never commits.

Adopting a legacy install: a target file with no recorded base that differs from the
source is looked up in the source's git history (when the source is a git checkout).
If some upstream commit shipped exactly that content, the file is an unedited older
version: it is classified outdated (and listed under "adopted") with that version as
its base, so --update replaces it and a later run tells edits from upstream changes.
One that matches no shipped version may hold edits: it stays differs, and only
--update --force replaces it.

CLAUDE.md: the report's "claude_md" compares the target's "## How work happens here"
section with the source's template (.claude/scripts/claude-md-base.md), ignoring the
marker comment /seed writes in it: status current, differs (marked by /seed, and
different), unmarked (different, no marker: written by hand or by an older /seed),
missing (no CLAUDE.md or no such section) or no_template (an older source), with a
unified diff. It only reports; a person applies the change.

Source: --from DIR (a checkout of the pipeline, or a project that has it), else
--repo URL cloned at --ref (default: the manifest's repo and ref, else
https://github.com/thomas-sodon/claude-code-pipeline at main). The clone keeps the
full commit history without file contents (--filter=blob:none), so adopting a
legacy install can search it. --ref takes a branch or a release tag.

--check: change nothing; exit 1 when anything would be added, updated or deleted,
or a conflict / differs is pending (for a scheduled CI job).
--check-claude-md: also count a CLAUDE.md section marked by /seed that differs from
the template as pending ("claude_md"), so --check exits 1 on it.
--dry-run: change nothing; report what would happen.

Exit: 0 = done (or, with --check, up to date); 1 = --check found pending changes;
2 = any failure: usage error, missing or ignored source, malformed manifest, git or filesystem error.
"""

import argparse
import difflib
import hashlib
import json
import os
import posixpath
import re
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
PENDING = ('added', 'outdated', 'conflict', 'differs', 'obsolete', 'mode')
CLAUDE_MD = 'CLAUDE.md'
CLAUDE_MD_TEMPLATE = '.claude/scripts/claude-md-base.md'
SECTION = '## How work happens here'
MARKER = '<!-- How work happens here written by /seed'


class Fail(Exception):
    pass


def git(cwd, *a, check=True, strip=True):
    r = subprocess.run(['git', '-C', cwd] + list(a), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True)
    if check and r.returncode != 0:
        raise Fail('git %s failed: %s' % (' '.join(a), r.stderr.strip()))
    if r.returncode != 0:
        return None
    return r.stdout.strip() if strip else r.stdout


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def is_git(d):
    """d is the top of its own git checkout: a plain copy that merely sits inside another repository (a dotfiles
    home, a monorepo) is not, or that repository's origin, commit, history and ignore rules would be taken for it."""
    top = git(d, 'rev-parse', '--show-toplevel', check=False)
    return top is not None and os.path.realpath(top) == os.path.realpath(d)


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
    src = m.get('source')
    if src is not None and (not isinstance(src, dict) or any(
            src.get(k) is not None and not isinstance(src.get(k), str) for k in ('repo', 'ref', 'commit'))):
        raise Fail('%s has a malformed "source" object (repo, ref and commit must be strings): fix or delete it'
                   % MANIFEST)
    return m


_USERINFO = re.compile(r'([a-zA-Z][a-zA-Z0-9+.-]*)://([^/@\s]*)@')


def _redact_userinfo(m):
    scheme, info = m.group(1), m.group(2)
    if 'ssh' in scheme.lower():
        # ssh://git@host: the user name is how the host knows whom to log in as, and no credential; only a password goes.
        user = info.split(':', 1)[0]
        return '%s://%s' % (scheme, user + '@' if user else '')
    # http(s) and the rest: the user name itself may be the token (https://<token>@github.com/...), so all of it goes.
    return '%s://' % scheme


def redact_url(url):
    """A URL with no credential in it, so a token in a remote never reaches the manifest or a report."""
    return _USERINFO.sub(_redact_userinfo, url) if url else url


def is_pipeline_path(rel):
    """A normalized relative path under one of the pipeline directories, and nothing else."""
    if not isinstance(rel, str) or not rel or '\\' in rel or posixpath.isabs(rel) or os.path.isabs(rel):
        return False
    parts = rel.split('/')
    return (posixpath.normpath(rel) == rel and '..' not in parts and len(parts) >= 3
            and parts[0] == '.claude' and parts[1] in DIRS)


def inside(target, rel):
    """The path rel resolves to (following symlinked directories) stays inside the target."""
    root = os.path.realpath(target)
    return os.path.realpath(os.path.join(target, rel)).startswith(root + os.sep)


def atomic_copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = '%s.tmp.%d' % (dst, os.getpid())
    try:
        shutil.copyfile(src, tmp)
        shutil.copymode(src, tmp)
        os.replace(tmp, dst)
    except BaseException:
        if os.path.lexists(tmp):
            os.remove(tmp)
        raise


def write_manifest(target, data):
    p = os.path.join(target, MANIFEST)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = '%s.tmp.%d' % (p, os.getpid())
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.write('\n')
        os.replace(tmp, p)
    except BaseException:
        if os.path.lexists(tmp):
            os.remove(tmp)
        raise


def history_blobs(src, rel):
    """Ids of every blob the source's history stored at rel. Tree diffs only, so a blob-less clone fetches nothing."""
    out = git(src, 'log', '-m', '--format=', '--raw', '--no-abbrev', '--no-renames', 'HEAD', '--', rel,
              check=False) or ''
    blobs = set()
    for line in out.splitlines():
        parts = line.split()  # :old_mode new_mode old_id new_id status path
        if line.startswith(':') and len(parts) >= 5 and set(parts[3]) != {'0'}:
            blobs.add(parts[3])
    return blobs


def shipped_before(src, rel, t):
    """True when some commit in the source's history shipped rel with exactly the target file's bytes."""
    blob = git(src, 'hash-object', '--no-filters', '--', t, check=False)
    return bool(blob) and blob in history_blobs(src, rel)


def classify(rel, src, target, base, src_git=False):
    """(kind, base): the recorded base, or for an adopted legacy file the history version it matched."""
    s = os.path.join(src, rel) if src else None
    t = os.path.join(target, rel)
    if os.path.islink(t):
        return 'symlink', base
    s_hash = sha(s) if s else None
    t_hash = sha(t) if os.path.isfile(t) else None
    if s_hash is None:  # in the base, gone from the source
        if t_hash is None:
            return 'gone', base
        return ('obsolete' if t_hash == base else 'obsolete_edited'), base
    if t_hash is None:
        return ('removed_locally' if base else 'added'), base
    if t_hash == s_hash:
        return 'identical', base
    if base is None:
        if src_git and shipped_before(src, rel, t):
            # The matched blob holds the target's exact bytes (--no-filters), so its content hash is t_hash.
            return 'adopted', t_hash
        return 'differs', base
    if t_hash == base:
        return 'outdated', base
    if s_hash == base:
        return 'local_edit', base
    return 'conflict', base


def section(text):
    """The lines of the How-work-happens-here section, heading included, up to the next heading; or None."""
    lines, start, fence = text.splitlines(), None, False
    for i, line in enumerate(lines):
        if line.lstrip().startswith(('```', '~~~')):
            fence = not fence
            continue
        if fence:
            continue
        if start is None:
            if line.rstrip() == SECTION:
                start = i
        elif line.startswith(('# ', '## ')):
            return lines[start:i]
    return lines[start:] if start is not None else None


def normalized(lines):
    """The section without the marker, trailing spaces and runs of blank lines, so only its wording counts."""
    out = []
    for l in lines:
        l = l.rstrip()
        if MARKER in l or (not l and (not out or not out[-1])):
            continue
        out.append(l)
    while out and not out[-1]:
        out.pop()
    return out


def read_text(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()


def claude_md(src, target):
    """Compare the target's CLAUDE.md base section with the source's template. Reads only."""
    r = {'path': CLAUDE_MD, 'template': CLAUDE_MD_TEMPLATE, 'status': 'no_template', 'added': 0, 'removed': 0,
         'diff': ''}
    tpl = os.path.join(src, CLAUDE_MD_TEMPLATE)
    want = section(read_text(tpl)) if os.path.isfile(tpl) and not os.path.islink(tpl) else None
    if want is None:
        return r
    t = os.path.join(target, CLAUDE_MD)
    have = section(read_text(t)) if os.path.isfile(t) and not os.path.islink(t) else None
    if have is None:
        r['status'] = 'missing'
        return r
    a, b = normalized(have), normalized(want)
    if a == b:
        r['status'] = 'current'
        return r
    r['status'] = 'differs' if any(MARKER in l for l in have) else 'unmarked'
    diff = list(difflib.unified_diff(a, b, CLAUDE_MD, CLAUDE_MD_TEMPLATE, lineterm=''))
    r['added'] = sum(1 for l in diff[2:] if l.startswith('+'))
    r['removed'] = sum(1 for l in diff[2:] if l.startswith('-'))
    r['diff'] = '\n'.join(diff)
    return r


def sync(a):
    target = git(os.path.abspath(a.target), 'rev-parse', '--show-toplevel', check=False)
    if not target:
        raise Fail('%s is not a git repository' % a.target)
    # .claude itself linked outside the repository (to ~/.claude, say): every write would land there, the manifest
    # and settings.json included, so nothing is synced at all.
    if os.path.lexists(os.path.join(target, '.claude')) and not inside(target, MANIFEST):
        raise Fail('%s/.claude resolves outside the repository (a symlink?): not syncing into it' % target)
    manifest = load_manifest(target)
    prev = (manifest or {}).get('source') or {}
    tmpdir = None
    try:
        if a.source:
            src = os.path.abspath(a.source)
            repo = git(src, 'remote', 'get-url', 'origin', check=False) if is_git(src) else None
            ref = a.ref
            if not ref and is_git(src):
                # A ref a later run can clone from the recorded repo (origin): the branch's upstream on origin, else
                # the release tag a detached checkout sits on (a clone of --branch <tag>), else none (main later).
                # Never a local branch name, which may not exist on origin.
                up = git(src, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}', check=False)
                ref = up[len('origin/'):] if up and up.startswith('origin/') else None
                if not ref:
                    tag = git(src, 'describe', '--tags', '--exact-match', 'HEAD', check=False)
                    # Only a tag origin has: a local-only one would make a later clone of it fail.
                    if tag and git(src, 'ls-remote', '--exit-code', '--tags', 'origin', 'refs/tags/' + tag,
                                   check=False) is not None:
                        ref = tag
        else:
            repo = a.repo or prev.get('repo') or DEFAULT_REPO
            ref = a.ref or prev.get('ref') or DEFAULT_REF
            tmpdir = tempfile.mkdtemp(prefix='pipeline-sync-')
            src = os.path.join(tmpdir, 'src')
            # Full history without file contents: fast, and enough to adopt a legacy install (see classify).
            r = subprocess.run(['git', 'clone', '--quiet', '--filter=blob:none', '--branch', ref, repo, src],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            if r.returncode != 0:
                raise Fail('git clone %s at %s failed: %s' % (redact_url(repo), ref, redact_url(r.stderr.strip())))
        # Cloned with the URL as given; from here on only its redacted form is stored or reported.
        repo = redact_url(repo)
        missing = [p for p in REQUIRED if not os.path.isfile(os.path.join(src, p))]
        if missing:
            raise Fail('%s is not a pipeline source: missing %s' % (src, ', '.join(missing)))
        same = os.path.realpath(src) == os.path.realpath(target)
        src_git = is_git(src)
        commit = git(src, 'rev-parse', 'HEAD', check=False) if src_git else None
        dirty = []
        if is_git(src) and not tmpdir:
            # Unstripped: the first line's status column can start with a space (" M path").
            st = git(src, 'status', '--porcelain', '--', *['.claude/' + d for d in DIRS], check=False,
                     strip=False) or ''
            dirty = [l[3:] for l in st.splitlines() if l]

        files = [] if same else source_files(src)
        # A source whose git checkout ignores its .claude/ files (a project with the pipeline installed and ignored)
        # lists nothing: syncing from it would add nothing, and --update would delete every installed file as obsolete.
        unlisted = [p.replace(os.sep, '/') for p in REQUIRED if p.replace(os.sep, '/') not in files]
        if not same and unlisted:
            raise Fail('%s does not list %s (ignored by its git checkout?): not syncing from it'
                       % (src, ', '.join(unlisted)))
        # The manifest is an ordinary committed file: trust none of its paths. Only pipeline paths are compared,
        # updated or deleted; anything else (absolute, '..', outside .claude/<dir>/) is ignored and reported.
        raw = (manifest or {}).get('files') or {}
        bases = {k: v for k, v in raw.items() if is_pipeline_path(k) and isinstance(v, str)}
        ignored_manifest = sorted(str(k) for k in raw if k not in bases)
        if same:
            # Nothing to copy: the target is the source. Record the files as they are.
            files = source_files(src)
        report = {k: [] for k in ('added', 'identical', 'outdated', 'updated', 'local_edit', 'conflict',
                                  'differs', 'removed_locally', 'obsolete', 'deleted', 'obsolete_edited',
                                  'symlink', 'adopted', 'mode')}
        new_bases = {}
        write = not (a.dry_run or a.check)
        for rel in files:
            base = bases.get(rel)
            kind, base = ('identical', base) if same else classify(rel, src, target, base, src_git)
            if kind == 'adopted':
                report['adopted'].append(rel)
                kind = 'outdated'
            s_hash = sha(os.path.join(src, rel))
            # Same contents, but the executable bit changed upstream (a script made runnable): only the mode is
            # applied, under --update; until then it is pending.
            if (kind == 'identical' and not same and inside(target, rel)
                    and (os.stat(os.path.join(src, rel)).st_mode ^ os.stat(os.path.join(target, rel)).st_mode) & 0o111):
                if a.update:
                    if write:
                        shutil.copymode(os.path.join(src, rel), os.path.join(target, rel))
                    report['updated'].append(rel)
                else:
                    report['mode'].append(rel)
                new_bases[rel] = s_hash
                continue
            # A file with no install record that matches no shipped version may hold someone's edits: like a
            # conflict, only --force replaces it.
            take = (kind == 'added' or (a.update and kind == 'outdated')
                    or (a.update and a.force and kind in ('conflict', 'differs')))
            # Anything an update would write (so --check and --dry-run judge it too) must stay inside the repository.
            would_write = kind in ('added', 'outdated') or (a.force and kind in ('conflict', 'differs'))
            if would_write and not inside(target, rel):
                # Resolves outside the repository (a symlinked directory): skipped, as a removal there is, in every
                # mode, so --check and --dry-run report what a real run does, and the rest of the run goes on.
                report['symlink'].append(rel)
                if base:
                    new_bases[rel] = base
                continue
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
                elif kind in ('local_edit', 'conflict', 'outdated', 'removed_locally', 'symlink'):
                    new_bases[rel] = base
        if not same:
            for rel in sorted(set(bases) - set(files)):
                kind, _ = classify(rel, None, target, bases[rel])
                # In every mode, so --check never reports a deletion no --update would make.
                if kind == 'obsolete' and not inside(target, rel):
                    report['symlink'].append(rel)
                    new_bases[rel] = bases[rel]
                elif kind == 'obsolete' and a.update:
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
        if settings_copied and write and inside(target, settings):
            atomic_copy(os.path.join(src, settings), os.path.join(target, settings))
        if write:
            write_manifest(target, {
                'source': {'repo': repo, 'ref': ref, 'commit': commit},
                'files': {k: v for k, v in sorted(new_bases.items()) if v},
            })
        # Work still left: before writing (check, dry-run), every change; after writing, what was kept back.
        pending = [k for k in ('added', 'updated', 'deleted') + PENDING[1:] if report[k]
                   and (not write or k in PENDING[1:])]
        cmd = claude_md(src, target)
        if a.check_claude_md and cmd['status'] == 'differs':
            pending.append('claude_md')
        out = {
            'target': target, 'source': {'path': None if tmpdir else src, 'repo': repo, 'ref': ref,
                                         'commit': commit, 'uncommitted': dirty},
            'previous_commit': prev.get('commit'), 'same_dir': same, 'mode': 'check' if a.check else
            'dry-run' if a.dry_run else 'update' if a.update else 'install',
            'settings_json_copied': settings_copied, 'ignored_manifest_paths': ignored_manifest, 'pending': pending, 'claude_md': cmd,
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
              ('outdated', 'outdated (run with --update)'), ('differs', 'differs, no install record and matches no shipped version (kept; --update --force takes the source\'s)'),
              ('conflict', 'conflict: edited here and upstream (kept; --update --force takes the source\'s)'),
              ('local_edit', 'edited here, unchanged upstream (kept)'),
              ('obsolete', 'removed upstream (run with --update to delete)'),
              ('obsolete_edited', 'removed upstream but edited here (kept)'),
              ('removed_locally', 'deleted here (kept deleted)'), ('symlink', 'symlink in the target (skipped)'),
              ('mode', 'executable bit changed upstream (run with --update)')]
    for key, label in labels:
        if r[key]:
            lines.append('  %s: %d' % (label, len(r[key])))
            lines += ['    %s' % p for p in r[key]]
    lines.append('  identical: %d' % len(r['identical']))
    if r['adopted']:
        lines.append('  adopted (no install record, but an unedited older upstream version): %d'
                     % len(r['adopted']))
        lines += ['    %s' % p for p in r['adopted']]
    c = r['claude_md']
    if c['status'] in ('differs', 'unmarked'):
        lines.append('  CLAUDE.md "%s" differs from %s (+%d -%d lines; never edited here: apply by hand)%s'
                     % (SECTION, c['template'], c['added'], c['removed'],
                        '' if c['status'] == 'differs' else '; unmarked: no /seed marker'))
        lines += ['    %s' % l for l in c['diff'].splitlines()]
    elif c['status'] in ('current', 'missing'):
        lines.append('  CLAUDE.md "%s": %s' % (SECTION, c['status']))
    if r['settings_json_copied']:
        lines.append('  .claude/settings.json copied (the target had none)')
    if r['ignored_manifest_paths']:
        lines.append('  WARNING: ignored manifest paths outside the pipeline directories (never touched): %s'
                     % ', '.join(r['ignored_manifest_paths']))
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
    p.add_argument('--force', action='store_true', help='with --update: also take the source\'s version of conflicts and of differing files with no install record')
    p.add_argument('--dry-run', action='store_true', help='change nothing; report what would happen')
    p.add_argument('--check', action='store_true', help='change nothing; exit 1 when anything is pending')
    p.add_argument('--check-claude-md', action='store_true',
                   help='count a /seed-marked CLAUDE.md section that differs from the template as pending')
    p.add_argument('--json', action='store_true', help='print the report as JSON')
    a = p.parse_args(argv)
    if a.force and not a.update:
        p.error('--force needs --update')
    try:
        r = sync(a)
    except (Fail, OSError) as e:
        # Any failure is exit 2, never 1: under --check, 1 means "an update is pending".
        if a.json:
            print(json.dumps({'error': str(e)}))
        else:
            print('pipeline-sync: %s' % e, file=sys.stderr)
        return 2
    print(json.dumps(r, indent=2) if a.json else human(r))
    return 1 if a.check and r['pending'] else 0


if __name__ == '__main__':
    sys.exit(main())

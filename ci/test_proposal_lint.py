#!/usr/bin/env python3
"""Contract tests for .claude/scripts/proposal-lint.py (stdlib only, Python 3.8+).

Run from the repo root: python3 ci/test_proposal_lint.py

The tests check the documented format (docs/PROPOSALS.md) and CLI, not the
implementation: every error and warning code, --repo, --tick, --lanes and
--roadmap. The script is always run as a subprocess, in temp directories.
Fixtures: ci/fixtures/valid-*.md lint clean; ci/fixtures/invalid/<code>[--variant].md
must fail with <code>; ci/fixtures/warn/<code>[--variant].md must pass with warning <code>.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINT = os.path.join(ROOT, '.claude', 'scripts', 'proposal-lint.py')
FIXTURES = os.path.join(ROOT, 'ci', 'fixtures')

PROPOSAL_SECTIONS = ('Context', 'Goals', 'Non-goals', 'Current state', 'Design', 'Decisions',
                     'Security and privacy', 'Rollout and operations', 'Risks and open questions')
ARCH_SECTIONS = ('Context', 'System overview', 'Components', 'Data model', 'Decisions',
                 'Security and privacy', 'Invariants', 'Repository layout', 'Quality gates',
                 'Environments and deployment', 'Testing', 'Risks and open questions')

# Every code the format defines. Each must be exercised by a fixture or by a test below.
ERROR_CODES = {'malformed_step', 'duplicate_step', 'step_numbering', 'missing_files', 'files_format',
               'missing_acceptance', 'missing_depends', 'bad_dependency', 'self_dependency',
               'unknown_dependency', 'forward_dependency', 'done_before_dependency', 'xref_missing_step',
               'bad_gate', 'gate_with_files', 'bad_lane', 'gate_in_lane', 'duplicate_key', 'bad_status',
               'no_steps', 'missing_section', 'missing_proposal', 'gate_with_proposal', 'files_in_roadmap'}
WARNING_CODES = {'unknown_key', 'missing_acceptance', 'lane_mixed', 'step_too_big', 'no_kind',
                 'missing_status', 'gate_without_outcome', 'outcome_on_code_step', 'proposal_not_written',
                 'xref_unreadable'}
INLINE_WARNINGS = {'file_not_found', 'new_file_exists', 'missing_section', 'unexpected_steps',
                   'milestone_ticked_incomplete', 'milestone_complete_unticked'}


def run(*args, cwd=None):
    p = subprocess.run([sys.executable, LINT] + [str(a) for a in args], cwd=cwd,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return p.returncode, p.stdout, p.stderr


def codes(items):
    return [i['code'] for i in items]


def fmt_file(f):
    if f.endswith(' (new)'):
        return '`%s` (new)' % f[:-6]
    return '`%s`' % f


def step(n, title=None, files=None, deps='none', acc='a test passes', lane=None, gate=None,
         outcome=None, done=False, desc='Change one thing.', ind=3, extra=()):
    """One step in the documented grammar. files=None -> one unique (new) file for code steps."""
    sp = ' ' * ind
    out = ['%d. [%s] **%s** %s' % (n, 'x' if done else ' ', title or 'Step %d.' % n, desc)]
    if gate:
        out.append(sp + '- Human gate: ' + gate)
    elif files is None:
        files = ['src/s%d.ts (new)' % n]
    if files:
        out.append(sp + '- Files: ' + ', '.join(fmt_file(f) for f in files))
    if deps is not None:
        out.append(sp + '- Depends on: ' + deps)
    if acc is not None:
        out.append(sp + '- Acceptance: ' + acc)
    if lane:
        out.append(sp + '- Lane: ' + lane)
    if outcome:
        out.append(sp + '- Outcome: ' + outcome)
    out.extend(extra)
    return '\n'.join(out) + '\n'


def gate(n, kind='research', deps='none', done=False, outcome=None, acc='evidence recorded', title=None):
    return step(n, title=title or 'Gate %d.' % n, gate='%s — a person does it' % kind, deps=deps,
                done=done, outcome=outcome, acc=acc)


def proposal(*steps, status='accepted', source=None, title='Test', full=True, before_steps=''):
    head = '# Proposal: %s\n\n' % title
    if status is not None:
        head += 'Status: %s\n' % status
    if source:
        head += 'Source: %s\n' % source
    body = ''.join('\n## %s\n\nText.\n' % s for s in PROPOSAL_SECTIONS) if full else ''
    tail = '\n## Out of scope\n\n- Nothing.\n' if full else ''
    return head + body + before_steps + '\n## Steps\n\n' + ''.join(steps) + tail


def roadmap(*milestones, status='accepted'):
    return '# Roadmap: Test\n\nStatus: %s\n\n## Milestones\n\n' % status + ''.join(milestones)


def milestone(n, proposal_file=None, gate_kind=None, deps='none', done=False, acc='exit criteria met'):
    if gate_kind:
        return step(n, gate='%s — a person does it' % gate_kind, deps=deps, done=done, acc=acc,
                    outcome='recorded' if done and gate_kind in ('research', 'decision') else None)
    return step(n, files=[], deps=deps, done=done, acc=acc,
                extra=['   - Proposal: %s' % proposal_file] if proposal_file else [])


def architecture(skip=(), status='accepted', extra=''):
    body = ''.join('## %s\n\nText.\n\n' % s for s in ARCH_SECTIONS if s not in skip)
    head = '# Architecture: Test\n\n' + ('Status: %s\n\n' % status if status else '')
    return head + body + extra


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='proposal-lint-test.')
        self.addCleanup(shutil.rmtree, self.tmp)

    def write(self, rel, text):
        path = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = text if isinstance(text, bytes) else text.encode('utf-8')
        with open(path, 'wb') as f:
            f.write(data)
        return path

    def read(self, path):
        with open(path, 'rb') as f:
            return f.read()

    def lint(self, path, *extra, cwd=None):
        rc, out, err = run(path, '--json', *extra, cwd=cwd)
        self.assertIn(rc, (0, 1), err)
        return rc, json.loads(out)

    def lint_text(self, text, *extra, name='doc.md'):
        return self.lint(self.write(name, text), *extra)

    def assertClean(self, text, *extra):
        rc, out = self.lint_text(text, *extra)
        self.assertEqual((rc, out['errors']), (0, []))
        return out

    def assertError(self, text, code, *extra):
        rc, out = self.lint_text(text, *extra)
        self.assertEqual(rc, 1, out)
        self.assertIn(code, codes(out['errors']))
        return out

    def assertWarning(self, text, code, *extra):
        rc, out = self.lint_text(text, *extra)
        self.assertEqual((rc, out['errors']), (0, []))
        self.assertIn(code, codes(out['warnings']))
        return out

    def lanes(self, path, *extra, cwd=None, rc=0):
        code, out, err = run(path, '--lanes', *extra, cwd=cwd)
        self.assertEqual(code, rc, out + err)
        return json.loads(out)

    def lanes_text(self, text, *extra, name='doc.md', rc=0):
        return self.lanes(self.write(name, text), *extra, rc=rc)


def all_lanes(out):
    return dict((l['key'], l) for c in out['chains'] for l in c['lanes'])


def chain_keys(out):
    return sorted([l['key'] for l in c['lanes']] for c in out['chains'])


def blocked(out):
    return dict((b['lane'], b) for b in out['blocked'])


# ---- fixtures and codes ------------------------------------------------------------------------

class TestFixtures(Base):
    def fixture_files(self, sub):
        d = os.path.join(FIXTURES, sub)
        return sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith('.md'))

    def test_valid_fixtures_lint_with_no_errors_or_warnings(self):
        for name in ('valid-proposal.md', 'valid-roadmap.md', 'valid-architecture.md'):
            with self.subTest(name=name):
                rc, out = self.lint(os.path.join(FIXTURES, name))
                self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))
                self.assertEqual(out['kind'], name[len('valid-'):-3])

    def test_valid_fixtures_from_another_cwd(self):
        # cross-doc refs and Proposal: files resolve against the doc's directory, not the cwd
        for name in ('valid-proposal.md', 'valid-roadmap.md'):
            rc, out = self.lint(os.path.join('ci', 'fixtures', name), cwd=ROOT)
            self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))

    def test_each_invalid_fixture_fails_with_its_code(self):
        files = self.fixture_files('invalid')
        self.assertTrue(files)
        for path in files:
            code = os.path.basename(path)[:-3].split('--')[0]
            with self.subTest(fixture=os.path.basename(path)):
                rc, out = self.lint(path)
                self.assertEqual(rc, 1)
                self.assertIn(code, codes(out['errors']))

    def test_each_warning_fixture_passes_with_its_code(self):
        files = self.fixture_files('warn')
        self.assertTrue(files)
        for path in files:
            code = os.path.basename(path)[:-3].split('--')[0]
            with self.subTest(fixture=os.path.basename(path)):
                rc, out = self.lint(path)
                self.assertEqual((rc, out['errors']), (0, []))
                self.assertIn(code, codes(out['warnings']))

    def test_every_contract_code_has_a_fixture(self):
        got_e = set(os.path.basename(p)[:-3].split('--')[0] for p in self.fixture_files('invalid'))
        got_w = set(os.path.basename(p)[:-3].split('--')[0] for p in self.fixture_files('warn'))
        self.assertEqual(ERROR_CODES - got_e, set())
        self.assertEqual(WARNING_CODES - got_w, set())


# ---- output and exit codes ---------------------------------------------------------------------

class TestCli(Base):
    def test_plain_output_lines_and_summary(self):
        path = self.write('d.md', proposal(step(1, deps=None), step(2, extra=['   - Owner: me'])))
        rc, out, _ = run(path)
        self.assertEqual(rc, 1)
        lines = out.strip().splitlines()
        self.assertRegex(lines[0], '^' + re.escape(path) + r':\d+: E missing_depends: ')
        self.assertTrue(any(l.startswith(path + ':') and ': W unknown_key: ' in l for l in lines))
        self.assertIn('1 errors', lines[-1])

    def test_crlf_doc_lints_like_lf(self):
        with open(os.path.join(FIXTURES, 'valid-proposal.md'), 'rb') as f:
            data = f.read()
        self.write('valid-proposal.md', data.replace(b'\n', b'\r\n'))
        self.write('valid-roadmap.md', proposal(step(1), step(2)))
        rc, out = self.lint(os.path.join(self.tmp, 'valid-proposal.md'))
        self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))
        self.assertEqual([s['acceptance'] for s in out['steps']][2],
                         'uploading a fixture returns its line items; an oversized upload is rejected with 413')

    def test_json_schema(self):
        out = self.assertClean(proposal(step(1, lane='core'), gate(2), step(3, deps='1, 2', files=['a.ts', 'b.ts (new)'])))
        for k in ('doc', 'kind', 'errors', 'warnings', 'steps'):
            self.assertIn(k, out)
        s1, s2, s3 = out['steps']
        for k in ('n', 'title', 'done', 'line', 'human_gate', 'files', 'depends', 'acceptance', 'lane'):
            self.assertIn(k, s1)
        self.assertEqual((s1['n'], s1['title'], s1['done'], s1['lane'], s1['human_gate']),
                         (1, 'Step 1.', False, 'core', None))
        self.assertEqual(s2['human_gate'], {'kind': 'research', 'text': 'a person does it'})
        self.assertEqual(s3['files'], [{'path': 'a.ts', 'new': False}, {'path': 'b.ts', 'new': True}])
        self.assertEqual(s3['depends'], [{'doc': None, 'n': 1}, {'doc': None, 'n': 2}])
        self.assertEqual(s3['acceptance'], 'a test passes')
        with open(out['doc'], encoding='utf-8') as f:
            self.assertTrue(f.read().splitlines()[s1['line'] - 1].startswith('1. [ ] **Step 1.**'))

    def test_exit_codes(self):
        self.assertEqual(run(os.path.join(self.tmp, 'missing.md'))[0], 2)
        self.assertEqual(run(self.write('bin.md', b'# Proposal: x\n\xff\xfe\n'))[0], 2)
        ok = self.write('ok.md', proposal(step(1)))
        self.assertEqual(run(ok)[0], 0)
        self.assertEqual(run(ok, '--no-such-flag')[0], 2)
        self.assertEqual(run(ok, '--lanes', '--tick', '1')[0], 2)
        self.assertEqual(run(ok, '--lanes', '--remote-heads', os.path.join(self.tmp, 'nope'))[0], 2)
        self.assertEqual(run(ok, '--tick', 'one')[0], 2)
        self.assertEqual(run(ok, '--tick', ',')[0], 2)
        self.assertEqual(run(self.write('warn.md', proposal(step(1), full=False)))[0], 0)
        self.assertEqual(run(self.write('bad.md', proposal(step(1, acc=None))))[0], 1)

    def test_lanes_and_roadmap_print_json_without_flag(self):
        p = self.write('p.md', proposal(step(1)))
        json.loads(run(p, '--lanes')[1])
        r = self.write('r.md', roadmap(milestone(1, gate_kind='ops')))
        json.loads(run(r, '--roadmap')[1])


# ---- step grammar ------------------------------------------------------------------------------

class TestGrammar(Base):
    def test_code_fences_are_ignored(self):
        fenced = ('\n```md\n## Steps\n\n7. [ ] **Fenced step.** Not real.\n9. [ broken\n   - Files: x\n```\n'
                  '\n~~~\n1. [ ] **Also fenced.**\n~~~\n')
        text = proposal(step(1), step(2, extra=['   ```', '3. [ ] **Fenced inside a step.**', '   ```',
                                               '   - Lane: tail']),
                        before_steps=fenced)
        text = text.replace('## Steps\n\n', '## Steps\n\n```\n1) [ nope\n```\n', 1)
        out = self.assertClean(text)
        self.assertEqual([s['n'] for s in out['steps']], [1, 2])
        # a sub-bullet after a fence inside the step still belongs to the step
        self.assertEqual(out['steps'][1]['lane'], 'tail')
        self.assertEqual(out['warnings'], [])

    def test_status_inside_fence_is_not_the_header(self):
        text = '# Proposal: T\n\n```\nStatus: nonsense\n```\n\n## Steps\n\n' + step(1)
        out = self.assertWarning(text, 'missing_status')
        self.assertNotIn('bad_status', codes(out['errors']))

    def test_two_digit_steps_with_four_space_sub_bullets(self):
        steps = [step(n) for n in range(1, 10)]
        steps.append(step(10, ind=4, files=['src/ten.ts (new)'], deps='9', lane='tens'))
        steps.append(step(11, ind=4, files=['src/eleven.ts'], deps='10', acc='eleven works'))
        out = self.assertClean(proposal(*steps))
        s10, s11 = out['steps'][9], out['steps'][10]
        self.assertEqual(s10['files'], [{'path': 'src/ten.ts', 'new': True}])
        self.assertEqual((s10['lane'], s10['depends']), ('tens', [{'doc': None, 'n': 9}]))
        self.assertEqual((s11['acceptance'], s11['depends']), ('eleven works', [{'doc': None, 'n': 10}]))
        self.assertEqual(out['warnings'], [])

    def test_multi_line_sub_bullet_values(self):
        text = proposal(step(1), step(2), step(
            3, files=[], deps=None, acc=None, desc='First line.',
            extra=['   More description.',
                   '   - Files: `src/a.ts` (new),',
                   '     `src/b.ts`',
                   '   - Depends on: 1,',
                   '     2',
                   '   - Acceptance: first part;',
                   '     second part']))
        s3 = self.assertClean(text)['steps'][2]
        self.assertEqual([f['path'] for f in s3['files']], ['src/a.ts', 'src/b.ts'])
        self.assertEqual(s3['depends'], [{'doc': None, 'n': 1}, {'doc': None, 'n': 2}])
        self.assertEqual(s3['acceptance'], 'first part; second part')

    def test_keys_are_case_insensitive(self):
        text = proposal(step(1, files=[], deps=None, acc=None,
                             extra=['   - FILES: `a.ts` (new)', '   - depends ON: none', '   - acceptance: ok']))
        self.assertEqual(self.assertClean(text)['steps'][0]['acceptance'], 'ok')

    def test_unknown_key_is_a_warning_only(self):
        self.assertWarning(proposal(step(1, extra=['   - Reviewer: someone'])), 'unknown_key')

    def test_indented_step_line_is_not_a_step(self):
        out = self.assertClean(proposal(step(1, extra=['   2. [ ] **Nested.** Continuation, not a step.'])))
        self.assertEqual(len(out['steps']), 1)

    def test_malformed_step_variants(self):
        for bad in ('2. [y] **Bad box.** x', '2. [ ] No bold title.', '2. [ ]**Glued.** x', '2. [] **Empty.** x'):
            with self.subTest(line=bad):
                self.assertError(proposal(step(1), bad + '\n'), 'malformed_step')

    def test_numbering(self):
        self.assertError(proposal(step(2)), 'step_numbering')
        self.assertError(proposal(step(1), step(3)), 'step_numbering')
        self.assertError(proposal(step(1), step(1)), 'duplicate_step')
        self.assertError(proposal(step(2), step(1)), 'step_numbering')

    def test_depends_on_forms(self):
        out = self.assertClean(proposal(step(1, deps='none'), step(2, deps='None.'), step(3, deps='1, 2')))
        self.assertEqual([s['depends'] for s in out['steps']],
                         [[], [], [{'doc': None, 'n': 1}, {'doc': None, 'n': 2}]])
        self.assertError(proposal(step(1, deps='')), 'missing_depends')
        self.assertError(proposal(step(1, deps='first')), 'bad_dependency')

    def test_same_doc_dependency_errors(self):
        self.assertError(proposal(step(1, deps='1')), 'self_dependency')
        self.assertError(proposal(step(1), step(2, deps='3')), 'unknown_dependency')
        self.assertError(proposal(step(1, deps='2'), step(2)), 'forward_dependency')
        self.assertError(proposal(step(1), step(2, done=True, deps='1')), 'done_before_dependency')
        self.assertClean(proposal(step(1, done=True), step(2, done=True, deps='1')))
        self.assertClean(proposal(step(1, done=True), step(2, deps='1')))

    def test_missing_depends_on_every_kind_of_step(self):
        self.assertError(proposal(gate(1, deps=None)), 'missing_depends')
        self.assertError(proposal(step(1, done=True, deps=None)), 'missing_depends')

    def test_code_step_requirements(self):
        self.assertError(proposal(step(1, files=[])), 'missing_files')
        self.assertError(proposal(step(1, files=[], extra=['   - Files:'])), 'missing_files')
        self.assertError(proposal(step(1, files=[], extra=['   - Files: none'])), 'files_format')
        self.assertError(proposal(step(1, acc=None)), 'missing_acceptance')

    def test_human_gate_rules(self):
        for sep in (' — ', ' - ', ' -- '):
            with self.subTest(sep=sep):
                out = self.assertClean(proposal(step(1, gate='decision%spick a vendor' % sep)))
                self.assertEqual(out['steps'][0]['human_gate'], {'kind': 'decision', 'text': 'pick a vendor'})
        for kind in ('research', 'decision', 'ops', 'release'):
            self.assertClean(proposal(gate(1, kind=kind)))
        self.assertError(proposal(step(1, gate='legal — counsel signs')), 'bad_gate')
        self.assertError(proposal(step(1, gate='research')), 'bad_gate')
        self.assertError(proposal(step(1, gate='ops — do it', files=['a.ts'])), 'gate_with_files')
        self.assertWarning(proposal(gate(1, acc=None)), 'missing_acceptance')

    def test_lane_rules(self):
        self.assertClean(proposal(step(1, lane='a' * 31)))
        self.assertClean(proposal(step(1, lane='0-api')))
        for bad in ('a' * 32, '-api', 'Api', 'api_v2', 'api v2'):
            with self.subTest(lane=bad):
                self.assertError(proposal(step(1, lane=bad)), 'bad_lane')
        self.assertError(proposal(step(1, gate='ops — x', extra=['   - Lane: core'])), 'gate_in_lane')
        self.assertWarning(proposal(step(1, done=True, lane='core'), step(2, lane='core')), 'lane_mixed')

    def test_step_size_boundaries(self):
        eight = ['src/f%d.ts (new)' % i for i in range(8)]
        out = self.assertClean(proposal(step(1, files=eight)))
        self.assertNotIn('step_too_big', codes(out['warnings']))
        self.assertWarning(proposal(step(1, files=eight + ['src/x.ts (new)'])), 'step_too_big')
        seven = ' '.join('Sentence %d.' % i for i in range(7))
        out = self.assertClean(proposal(step(1, desc=seven)))
        self.assertNotIn('step_too_big', codes(out['warnings']))
        self.assertWarning(proposal(step(1, desc=seven + '\n   One more sentence on a continuation line.')), 'step_too_big')

    def test_kind_detection(self):
        self.assertEqual(self.assertClean(proposal(step(1)))['kind'], 'proposal')
        out = self.assertWarning('Status: draft\n\n## Steps\n\n' + step(1), 'no_kind')
        self.assertEqual(out['kind'], 'proposal')
        self.assertError('# Notes\n\nStatus: draft\n\n## Design\n', 'missing_section')
        self.assertError(roadmap().replace('## Milestones', '## Steps') + milestone(1, gate_kind='ops'),
                         'missing_section')

    def test_proposal_sections_are_warnings(self):
        out = self.assertWarning(proposal(step(1), full=False), 'missing_section')
        self.assertEqual(out['errors'], [])


class TestStatusAndOutcome(Base):
    def test_status_values(self):
        for value in ('draft', 'accepted', 'in-progress', 'done', 'Accepted',
                      'draft            <!-- draft | accepted | in-progress | done -->'):
            with self.subTest(status=value):
                out = self.assertClean(proposal(step(1), status=value))
                self.assertNotIn('missing_status', codes(out['warnings']))
        for value in ('approved', 'wip', 'accepted, mostly'):
            with self.subTest(status=value):
                self.assertError(proposal(step(1), status=value), 'bad_status')
        self.assertWarning(proposal(step(1), status=None), 'missing_status')

    def test_status_on_roadmap_and_architecture(self):
        self.assertError(roadmap(milestone(1, gate_kind='ops'), status='approved'), 'bad_status')
        self.assertError(architecture(status='final'), 'bad_status')
        self.assertWarning(architecture(status=None), 'missing_status')

    def test_outcome_rules(self):
        for kind in ('research', 'decision'):
            self.assertWarning(proposal(gate(1, kind=kind, done=True)), 'gate_without_outcome')
            out = self.assertClean(proposal(gate(1, kind=kind, done=True, outcome='chose B')))
            self.assertEqual(out['warnings'], [])
        for kind in ('ops', 'release'):
            out = self.assertClean(proposal(gate(1, kind=kind, done=True)))
            self.assertEqual(out['warnings'], [])
        out = self.assertClean(proposal(gate(1, kind='research')))
        self.assertEqual(out['warnings'], [])
        self.assertWarning(proposal(step(1, outcome='nothing')), 'outcome_on_code_step')
        rm = roadmap(step(1, gate='decision — go or stop', done=True, acc='recorded'))
        self.assertWarning(rm, 'gate_without_outcome')


# ---- cross-doc refs ----------------------------------------------------------------------------

class TestCrossDoc(Base):
    def test_refs_resolve_relative_to_the_doc_directory(self):
        # a decoy with no step 2 sits in the cwd; the real one sits next to the doc
        self.write('other.md', proposal(step(1)))
        self.write('sub/other.md', proposal(step(1), step(2)))
        self.write('up/third.md', proposal(step(1)))
        doc = self.write('sub/doc.md', proposal(step(1, deps='other.md#2, ../up/third.md#1')))
        for cwd in (self.tmp, ROOT):
            rc, out = self.lint(doc, cwd=cwd)
            self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))
        self.assertEqual(out['steps'][0]['depends'],
                         [{'doc': 'other.md', 'n': 2}, {'doc': '../up/third.md', 'n': 1}])
        rc, out = self.lint(os.path.join('sub', 'doc.md'), cwd=self.tmp)
        self.assertEqual((rc, out['errors']), (0, []))

    def test_missing_step_in_other_doc_is_an_error(self):
        self.write('other.md', proposal(step(1)))
        doc = self.write('doc.md', proposal(step(1, deps='other.md#2')))
        rc, out = self.lint(doc)
        self.assertEqual(rc, 1)
        self.assertIn('xref_missing_step', codes(out['errors']))
        rc, out = self.lint(doc, '--no-resolve-xrefs')
        self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))

    def test_unreadable_other_doc_is_a_warning(self):
        doc = self.write('doc.md', proposal(step(1, deps='later.md#1')))
        rc, out = self.lint(doc)
        self.assertEqual((rc, out['errors']), (0, []))
        self.assertIn('xref_unreadable', codes(out['warnings']))


# ---- roadmap and architecture lint -------------------------------------------------------------

class TestRoadmapLint(Base):
    def test_roadmap_rules(self):
        self.write('p.md', proposal(step(1)))
        rc, out = self.lint_text(roadmap(milestone(1, gate_kind='ops'), milestone(2, 'p.md', deps='1')),
                                 name='roadmap.md')
        self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))
        self.assertEqual(out['kind'], 'roadmap')
        self.assertError(roadmap(milestone(1)), 'missing_proposal')
        self.assertError(roadmap(milestone(1, 'p.md', acc=None)), 'missing_acceptance')
        self.assertError(roadmap(step(1, gate='release — submit', files=[],
                                      extra=['   - Proposal: p.md'])), 'gate_with_proposal')
        self.assertError(roadmap(step(1, files=['a.ts'], extra=['   - Proposal: p.md'])), 'files_in_roadmap')
        self.assertError(roadmap(milestone(1, 'p.md', deps=None)), 'missing_depends')
        self.assertError(roadmap(milestone(1, 'p.md', deps='2'), milestone(2, 'p.md')), 'forward_dependency')
        self.assertWarning(roadmap(milestone(1, gate_kind='ops', acc=None)), 'missing_acceptance')

    def test_proposal_not_written_resolves_from_the_roadmap_directory(self):
        self.write('design/p.md', proposal(step(1)))
        path = self.write('design/roadmap.md', roadmap(milestone(1, 'p.md'), milestone(2, 'q.md')))
        rc, out = self.lint(path, cwd=ROOT)
        self.assertEqual(rc, 0)
        self.assertEqual([(w['code'], 'q.md' in w['message']) for w in out['warnings']],
                         [('proposal_not_written', True)])

    def test_done_milestone_without_proposal_file_does_not_warn(self):
        out = self.assertClean(roadmap(milestone(1, 'gone.md', done=True)))
        self.assertNotIn('proposal_not_written', codes(out['warnings']))


class TestArchitectureLint(Base):
    def test_complete_architecture_is_clean(self):
        out = self.assertClean(architecture())
        self.assertEqual((out['kind'], out['warnings']), ('architecture', []))

    def test_each_required_section(self):
        for name in ARCH_SECTIONS:
            with self.subTest(section=name):
                out = self.assertError(architecture(skip=(name,)), 'missing_section')
                self.assertTrue(any(name in e['message'] for e in out['errors']))

    def test_step_list_is_unexpected(self):
        self.assertWarning(architecture(extra='## Steps\n\n' + step(1)), 'unexpected_steps')


# ---- --repo -----------------------------------------------------------------------------------

class TestRepoFiles(Base):
    def setUp(self):
        Base.setUp(self)
        self.repo = os.path.join(self.tmp, 'repo')
        os.makedirs(os.path.join(self.repo, 'src'))
        with open(os.path.join(self.repo, 'src', 'old.ts'), 'w') as f:
            f.write('x\n')

    def repo_warnings(self, *steps):
        rc, out = self.lint_text(proposal(*steps), '--repo', self.repo)
        self.assertEqual((rc, out['errors']), (0, []))
        return [w['code'] for w in out['warnings']]

    def test_existing_file_is_fine(self):
        self.assertEqual(self.repo_warnings(step(1, files=['src/old.ts', './src/old.ts'])), [])

    def test_new_file_that_exists(self):
        self.assertEqual(self.repo_warnings(step(1, files=['src/old.ts (new)'])), ['new_file_exists'])

    def test_missing_non_new_file(self):
        self.assertEqual(self.repo_warnings(step(1, files=['src/gone.ts'])), ['file_not_found'])

    def test_file_created_by_an_earlier_step(self):
        self.assertEqual(self.repo_warnings(step(1, files=['src/a.ts (new)']),
                                            step(2, files=['src/a.ts'], deps='1')), [])

    def test_file_created_by_a_later_step_still_warns(self):
        self.assertEqual(self.repo_warnings(step(1, files=['src/a.ts']), step(2, files=['src/a.ts (new)'])),
                         ['file_not_found'])

    def test_without_repo_no_file_checks(self):
        out = self.assertClean(proposal(step(1, files=['src/gone.ts'])))
        self.assertEqual(out['warnings'], [])


# ---- --tick -----------------------------------------------------------------------------------

class TestTick(Base):
    TEXT = (proposal(step(1), step(2, title='Handle "2. [ ]" text.', desc='Trailing space  \t'),
                     gate(3), step(4, done=True),
                     before_steps='\n```\n2. [ ] **Handle "2. [ ]" text.** Fenced copy.\n5. [ ] **Fenced only.**\n```\n')
            .replace('Text.', 'Text — with unicode “quotes”.', 1).rstrip('\n'))  # no final newline

    def tick(self, path, nums, rc=0):
        code, out, err = run(path, '--tick', nums)
        self.assertEqual(code, rc, out + err)
        return json.loads(out)

    def expected(self, before, n):
        line = b'%d. [ ] **' % n
        idx = before.index(b'\n' + line) + 1 if not before.startswith(line) else 0
        # the first match outside the fence is the real step: skip the fenced copy
        fence_end = before.index(b'```\n', before.index(b'```') + 3)
        if idx < fence_end:
            idx = before.index(b'\n' + line, fence_end) + 1
        return before[:idx] + b'%d. [x]' % n + before[idx + len(b'%d. [ ]' % n):]

    def test_byte_exact_apart_from_the_checkbox(self):
        path = self.write('d.md', self.TEXT)
        before = self.read(path)
        out = self.tick(path, '2')
        self.assertEqual(out['ticked'], [2])
        self.assertEqual(self.read(path), self.expected(before, 2))
        self.assertEqual(os.listdir(self.tmp), ['d.md'])  # no temp file left behind

    def test_several_and_human_gate(self):
        path = self.write('d.md', self.TEXT)
        before = self.read(path)
        out = self.tick(path, '3,1, 4')
        self.assertEqual((sorted(out['ticked']), out['already']), ([1, 3], [4]))
        self.assertEqual(self.read(path), self.expected(self.expected(before, 1), 3))

    def test_crlf_preserved(self):
        path = self.write('d.md', self.TEXT.replace('\n', '\r\n'))
        before = self.read(path)
        self.tick(path, '2')
        after = self.read(path)
        self.assertEqual(after, self.expected(before.replace(b'\r\n', b'\n'), 2).replace(b'\n', b'\r\n'))
        self.assertEqual(after.count(b'\r\n'), before.count(b'\r\n'))

    def test_missing_number_changes_nothing(self):
        path = self.write('d.md', self.TEXT)
        before = self.read(path)
        out = self.tick(path, '1,99', rc=1)
        self.assertEqual(out['ticked'], [])
        self.assertEqual(self.read(path), before)

    def test_already_ticked_is_a_no_op(self):
        path = self.write('d.md', self.TEXT)
        before, ino = self.read(path), os.stat(path).st_ino
        out = self.tick(path, '4')
        self.assertEqual((out['ticked'], out['already']), ([], [4]))
        self.assertEqual(self.read(path), before)
        self.assertEqual(os.stat(path).st_ino, ino)

    def test_uppercase_x_counts_as_ticked(self):
        path = self.write('d.md', proposal(step(1).replace('[ ]', '[X]')))
        self.assertEqual(self.tick(path, '1')['already'], [1])

    def test_cannot_tick_inside_a_code_fence(self):
        path = self.write('d.md', self.TEXT)
        before = self.read(path)
        self.tick(path, '5', rc=1)
        self.assertEqual(self.read(path), before)

    def test_file_mode_kept(self):
        for mode in (0o640, 0o755):
            path = self.write('d.md', self.TEXT)
            os.chmod(path, mode)
            self.tick(path, '1')
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), mode)

    def test_tick_roadmap_milestone(self):
        path = self.write('roadmap.md', roadmap(milestone(1, gate_kind='ops'), milestone(2, 'p.md', deps='1')))
        self.tick(path, '1')
        self.assertIn(b'\n1. [x] **Step 1.**', self.read(path))


# ---- --lanes ----------------------------------------------------------------------------------

class TestLanes(Base):
    def test_output_shape_and_single_step_lanes(self):
        out = self.lanes_text(proposal(step(1), step(2), step(3, done=True)))
        for k in ('doc', 'slug', 'errors', 'warnings', 'chains', 'blocked', 'human_gates_pending', 'done'):
            self.assertIn(k, out)
        self.assertEqual((out['errors'], out['blocked'], out['done']), ([], [], [3]))
        self.assertEqual(chain_keys(out), [['s1'], ['s2']])
        for c in out['chains']:
            self.assertEqual(c['key'], c['lanes'][0]['key'])
        l1 = all_lanes(out)['s1']
        self.assertEqual((l1['steps'], l1['titles'], l1['bases'], l1['files'], l1['already_built'], l1['dir']),
                         ([1], ['Step 1.'], [], ['src/s1.ts'], False, None))
        self.assertEqual(l1['branch'], 'feat/doc-s1-undated')

    def test_lane_groups(self):
        out = self.lanes_text(proposal(step(1, lane='api'), step(2, lane='api', deps='1'), step(3)))
        api = all_lanes(out)['api']
        self.assertEqual((api['steps'], api['titles']), ([1, 2], ['Step 1.', 'Step 2.']))
        self.assertEqual(chain_keys(out), [['api'], ['s3']])

    def test_file_overlap_stacks_later_lane(self):
        out = self.lanes_text(proposal(step(1, files=['src/x.ts (new)']), step(2, files=['src/x.ts', 'src/y.ts']),
                                       step(3)))
        self.assertEqual(chain_keys(out), [['s1', 's2'], ['s3']])
        self.assertEqual(all_lanes(out)['s2']['bases'], ['feat/doc-s1-undated'])

    def test_dependency_stacking_and_bases_in_chain_order(self):
        out = self.lanes_text(proposal(step(1), step(2, deps='1'), step(3, deps='1'), step(4)), '--date', '20261104')
        self.assertEqual(chain_keys(out), [['s1', 's2', 's3'], ['s4']])
        self.assertEqual(all_lanes(out)['s3']['bases'], ['feat/doc-s1-20261104', 'feat/doc-s2-20261104'])

    def test_linearised_topologically_not_by_number(self):
        # lane b = steps 2 and 4; step 4 depends on step 3, so lane s3 must come before lane b
        out = self.lanes_text(proposal(step(1), step(2, lane='b'), step(3), step(4, lane='b', deps='3')))
        chain = [c for c in out['chains'] if len(c['lanes']) == 2][0]
        self.assertEqual((chain['key'], [l['key'] for l in chain['lanes']]), ('s3', ['s3', 'b']))
        self.assertEqual(chain['lanes'][1]['bases'], ['feat/doc-s3-undated'])

    def test_done_steps_satisfy_dependencies(self):
        out = self.lanes_text(proposal(step(1, done=True), gate(2, done=True, outcome='ok'),
                                       step(3, deps='1, 2'), step(4, deps='1')))
        self.assertEqual((chain_keys(out), out['blocked'], out['human_gates_pending']),
                         ([['s3'], ['s4']], [], []))
        self.assertEqual(out['done'], [1, 2])

    def test_human_gate_blocks_and_propagates(self):
        out = self.lanes_text(proposal(gate(1), step(2, deps='1'), step(3, deps='2'), step(4, lane='g'),
                                       step(5, lane='g', deps='1, 4'), step(6)))
        self.assertEqual(chain_keys(out), [['s6']])
        b = blocked(out)
        self.assertEqual(sorted(b), ['g', 's2', 's3'])
        self.assertEqual([(w['n'], w['reason']) for w in b['s2']['waiting_on']], [(1, 'human_gate')])
        self.assertEqual(b['s2']['waiting_on'][0]['title'], 'Gate 1.')
        self.assertEqual([(w['n'], w['reason']) for w in b['s3']['waiting_on']], [(2, 'blocked_lane')])
        self.assertEqual(b['g']['steps'], [4, 5])
        self.assertIn((1, 'human_gate'), [(w['n'], w['reason']) for w in b['g']['waiting_on']])

    def test_blocking_propagates_to_a_fixed_point(self):
        # lane e (steps 2, 5) is listed before s4, yet waits on it: one pass in lane order is not enough
        out = self.lanes_text(proposal(gate(1), step(2, lane='e'), step(3, deps='1'), step(4, deps='3'),
                                       step(5, lane='e', deps='4'), step(6, deps='2'), step(7)))
        self.assertEqual(chain_keys(out), [['s7']])
        b = blocked(out)
        self.assertEqual(sorted(b), ['e', 's3', 's4', 's6'])
        self.assertEqual([(w['n'], w['reason']) for w in b['e']['waiting_on']], [(4, 'blocked_lane')])
        self.assertEqual([(w['n'], w['reason']) for w in b['s6']['waiting_on']], [(2, 'blocked_lane'), (5, 'blocked_lane')])

    def test_lane_sharing_a_file_with_a_blocked_lane_waits(self):
        out = self.lanes_text(proposal(gate(1), step(2, deps='1', files=['src/x.ts (new)']),
                                       step(3, files=['src/x.ts'])))
        self.assertEqual(out['chains'], [])
        self.assertEqual([w['reason'] for w in blocked(out)['s3']['waiting_on']], ['blocked_lane'])

    def test_human_gates_pending_ready_and_waiting_on(self):
        self.write('other.md', proposal(step(1), step(2, done=True)))
        out = self.lanes_text(proposal(step(1), gate(2, deps='1'), gate(3), gate(4, deps='other.md#1'),
                                       gate(5, deps='other.md#2'), gate(6, done=True, kind='ops')))
        g = dict((x['n'], x) for x in out['human_gates_pending'])
        self.assertEqual(sorted(g), [2, 3, 4, 5])
        self.assertEqual((g[2]['ready'], g[2]['waiting_on']), (False, [{'doc': None, 'n': 1}]))
        self.assertEqual((g[3]['ready'], g[3]['waiting_on']), (True, []))
        self.assertEqual((g[4]['ready'], g[4]['waiting_on']), (False, [{'doc': 'other.md', 'n': 1}]))
        self.assertEqual((g[5]['ready'], g[5]['waiting_on']), (True, []))
        self.assertEqual((g[3]['title'], g[3]['kind'], g[3]['text']), ('Gate 3.', 'research', 'a person does it'))

    def test_pending_cross_doc_dependency(self):
        self.write('d/other.md', proposal(step(1, title='Other one.'), step(2, done=True)))
        doc = self.write('d/doc.md', proposal(step(1, deps='other.md#1'), step(2, deps='other.md#2'),
                                              step(3, deps='unwritten.md#4')))
        out = self.lanes(doc, cwd=ROOT)
        self.assertEqual(chain_keys(out), [['s2']])
        b = blocked(out)
        self.assertEqual(b['s1']['waiting_on'], [{'doc': 'other.md', 'n': 1, 'title': 'Other one.',
                                                  'reason': 'pending_external'}])
        self.assertEqual([(w['doc'], w['n'], w['reason']) for w in b['s3']['waiting_on']],
                         [('unwritten.md', 4, 'pending_external')])

    def roadmap_case(self, first_done, first_steps_done, gated_first=False):
        if gated_first:
            m1 = milestone(1, gate_kind='ops', done=first_done)
        else:
            m1 = milestone(1, 'first.md', done=first_done)
            self.write('first.md', proposal(step(1, done=first_steps_done), step(2, done=first_steps_done)))
        self.write('roadmap.md', roadmap(m1, milestone(2, 'doc.md', deps='1')))
        return self.lanes_text(proposal(step(1), source='roadmap.md#2'))

    def test_roadmap_milestone_gate_blocks(self):
        out = self.roadmap_case(False, False, gated_first=True)
        self.assertEqual(out['chains'], [])
        self.assertEqual([(w['n'], w['reason']) for w in blocked(out)['s1']['waiting_on']],
                         [(1, 'milestone_gate')])
        self.assertEqual(chain_keys(self.roadmap_case(True, False, gated_first=True)), [['s1']])

    def test_roadmap_milestone_pending_blocks(self):
        out = self.roadmap_case(False, False)
        self.assertEqual([(w['n'], w['reason']) for w in blocked(out)['s1']['waiting_on']],
                         [(1, 'milestone_pending')])

    def test_roadmap_milestone_satisfied_by_completed_proposal(self):
        out = self.roadmap_case(False, True)
        self.assertEqual((chain_keys(out), out['blocked']), ([['s1']], []))

    def test_status_gates_every_lane(self):
        for status in ('draft', 'done', None):
            with self.subTest(status=status):
                out = self.lanes_text(proposal(step(1), step(2, deps='1'), gate(3), status=status))
                self.assertEqual(out['chains'], [])
                self.assertEqual(sorted(blocked(out)), ['s1', 's2'])
                for b in out['blocked']:
                    self.assertIn('proposal_not_accepted', [w['reason'] for w in b['waiting_on']])
                self.assertEqual([g['n'] for g in out['human_gates_pending']], [3])
        out = self.lanes_text(proposal(step(1), step(2, deps='1'), status='draft'), '--allow-draft')
        self.assertEqual((chain_keys(out), out['blocked']), ([['s1', 's2']], []))
        for status in ('accepted', 'in-progress'):
            self.assertEqual(chain_keys(self.lanes_text(proposal(step(1), status=status))), [['s1']])

    def heads(self, *names):
        return self.write('heads.txt', ''.join('%040x\trefs/heads/%s\n' % (i + 1, n) for i, n in enumerate(names))
                          + '%040x\trefs/tags/feat/doc-s1-29990101\n' % 99)

    def ten_steps(self):
        return proposal(*([step(1)] + [step(n) for n in range(2, 10)] + [step(10, deps='1')]))

    def test_remote_heads_already_built_latest_match_and_stacking(self):
        h = self.heads('main', 'feat/doc-s1-20261101', 'feat/doc-s1-20261103', 'feat/doc-s1-20261102',
                       'feat/other-s1-20261231')
        out = self.lanes_text(self.ten_steps(), '--remote-heads', h, '--date', '20261104')
        lanes = all_lanes(out)
        self.assertEqual((lanes['s1']['already_built'], lanes['s1']['branch']), (True, 'feat/doc-s1-20261103'))
        self.assertEqual((lanes['s10']['already_built'], lanes['s10']['branch']), (False, 'feat/doc-s10-20261104'))
        self.assertEqual(lanes['s10']['bases'], ['feat/doc-s1-20261103'])
        self.assertFalse(lanes['s2']['already_built'])

    def test_remote_heads_s1_does_not_match_s10(self):
        h = self.heads('feat/doc-s10-20261105')
        lanes = all_lanes(self.lanes_text(self.ten_steps(), '--remote-heads', h))
        self.assertEqual((lanes['s1']['already_built'], lanes['s1']['branch']), (False, 'feat/doc-s1-undated'))
        self.assertEqual((lanes['s10']['already_built'], lanes['s10']['branch']), (True, 'feat/doc-s10-20261105'))
        self.assertEqual(lanes['s10']['bases'], ['feat/doc-s1-undated'])

    def test_remote_heads_lane_key_prefix_of_another(self):
        h = self.heads('feat/doc-api-v2-20261105')
        lanes = all_lanes(self.lanes_text(proposal(step(1, lane='api'), step(2, lane='api-v2')),
                                          '--remote-heads', h))
        self.assertEqual((lanes['api']['already_built'], lanes['api']['branch']), (False, 'feat/doc-api-undated'))
        self.assertTrue(lanes['api-v2']['already_built'])

    def test_remote_heads_respect_branch_prefix(self):
        h = self.heads('feat/doc-s1-20261101')
        lanes = all_lanes(self.lanes_text(proposal(step(1)), '--remote-heads', h, '--branch-prefix', 'wip/'))
        self.assertEqual((lanes['s1']['already_built'], lanes['s1']['branch']), (False, 'wip/doc-s1-undated'))

    def test_lane_cycle_is_an_error(self):
        # lane a = steps 1 and 3; step 2 depends on 1 (s2 after a), step 3 depends on 2 (a after s2)
        out = self.lanes_text(proposal(step(1, lane='a'), step(2, deps='1'), step(3, lane='a', deps='2')), rc=1)
        self.assertEqual(codes(out['errors']), ['lane_cycle'])
        self.assertEqual(out['chains'], [])

    def test_concern_text(self):
        path = self.write('docs/design/doc.md',
                          proposal(step(1, title='Parse bills.'), step(2, title='Add the importer.', lane='io'),
                                   step(3, title='Wire the screen', lane='io', deps='2')))
        out = self.lanes(os.path.join('docs', 'design', 'doc.md'), cwd=self.tmp)
        lanes = all_lanes(out)
        self.assertEqual(lanes['io']['concern'],
                         'Steps 2, 3 of docs/design/doc.md: Add the importer; Wire the screen. Implement exactly '
                         'these steps — their description, Files and Acceptance criteria — as one increment.')
        self.assertEqual(lanes['s1']['concern'],
                         'Step 1 of docs/design/doc.md: Parse bills. Implement exactly this step — its '
                         'description, Files and Acceptance criteria — as one increment.')
        self.assertEqual(out['doc'], os.path.join('docs', 'design', 'doc.md'))
        self.assertTrue(path)

    def test_branch_and_dir_naming(self):
        out = self.lanes_text(proposal(step(1, lane='api')), '--date', '20261104', '--branch-prefix', 'chore/',
                              '--root', '../wt', name='My_Doc.V2.md')
        self.assertEqual(out['slug'], 'my-doc-v2')
        lane = all_lanes(out)['api']
        self.assertEqual((lane['branch'], lane['dir']), ('chore/my-doc-v2-api-20261104', '../wt/my-doc-v2-api'))

    def test_refuses_on_lint_errors(self):
        out = self.lanes_text(proposal(step(1, acc=None)), rc=1)
        self.assertIn('missing_acceptance', codes(out['errors']))
        self.assertEqual(out['chains'], [])
        self.write('p.md', proposal(step(1)))
        out = self.lanes_text(roadmap(milestone(1, 'p.md')), name='roadmap.md', rc=1)
        self.assertIn('not_a_proposal', codes(out['errors']))

    def test_gated_steps_are_never_lanes(self):
        out = self.lanes_text(proposal(gate(1), gate(2, kind='release')))
        self.assertEqual((out['chains'], out['blocked']), ([], []))
        self.assertEqual([g['n'] for g in out['human_gates_pending']], [1, 2])


# ---- --roadmap --------------------------------------------------------------------------------

class TestRoadmapMode(Base):
    def test_progress_and_next(self):
        self.write('a.md', proposal(step(1, done=True), step(2), gate(3)))
        self.write('c.md', proposal(step(1, done=True), gate(2, kind='ops', done=True)))
        self.write('d.md', proposal(step(1)))
        path = self.write('roadmap.md', roadmap(
            milestone(1, gate_kind='ops', done=True),
            milestone(2, 'a.md', deps='1'),
            milestone(3, 'b.md', deps='2'),
            milestone(4, gate_kind='decision', deps='1'),
            milestone(5, 'c.md'),
            milestone(6, 'd.md', done=True),
            milestone(7, 'b.md', deps='5')))
        rc, stdout, _ = run(path, '--roadmap', cwd=ROOT)
        self.assertEqual(rc, 0)
        out = json.loads(stdout)
        m = dict((x['n'], x) for x in out['milestones'])
        self.assertEqual((m[2]['proposal_exists'], m[2]['progress'], m[2]['complete']),
                         (True, {'done': 1, 'total': 2, 'gates_pending': 1}, False))
        self.assertEqual((m[3]['proposal_exists'], m[3]['progress']), (False, None))
        self.assertTrue(m[5]['complete'])
        self.assertEqual(sorted(out['next']), [2, 4, 7])
        w = dict((x['code'], x['line']) for x in out['warnings'])
        self.assertIn('milestone_complete_unticked', w)
        self.assertIn('milestone_ticked_incomplete', w)
        with open(path, encoding='utf-8') as f:
            lines = f.read().splitlines()
        self.assertTrue(lines[w['milestone_complete_unticked'] - 1].startswith('5. '))
        self.assertTrue(lines[w['milestone_ticked_incomplete'] - 1].startswith('6. '))

    def test_roadmap_mode_errors(self):
        rc, stdout, _ = run(self.write('p.md', proposal(step(1))), '--roadmap')
        self.assertEqual(rc, 1)
        self.assertIn('not_a_roadmap', codes(json.loads(stdout)['errors']))
        rc, stdout, _ = run(self.write('roadmap.md', roadmap(milestone(1))), '--roadmap')
        self.assertEqual(rc, 1)
        self.assertIn('missing_proposal', codes(json.loads(stdout)['errors']))


if __name__ == '__main__':
    unittest.main(verbosity=1)

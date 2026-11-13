#!/usr/bin/env python3
"""Contract tests for .claude/scripts/proposal-lint.py (stdlib only, Python 3.8+).

Run from the repo root: python3 ci/test_proposal_lint.py

The tests check the documented format (docs/PROPOSALS.md) and CLI, not the
implementation: every error and warning code, the size budgets, the D-record
provenance tags, --repo, --as, --tick, --lanes, --roadmap, --decisions and
--claude-md. The script is always run as a subprocess, in temp directories; docs
at the size limits are generated, not committed as fixtures.
It also checks ci/lint-doc-examples.py finds the examples it must lint, and that the
`docs` CI job script in /bootstrap's template and examples/docs-lint-job.yml is one
script that works.
Fixtures: ci/fixtures/valid-*.md lint clean; ci/fixtures/invalid/<code>[--variant].md
must fail with <code>; ci/fixtures/warn/<code>[--variant].md must pass with warning <code>.
"""

import importlib.util
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
               'no_steps', 'missing_section', 'missing_proposal', 'gate_with_proposal', 'files_in_roadmap',
               'bad_proposal'}
WARNING_CODES = {'unknown_key', 'missing_acceptance', 'lane_mixed', 'step_too_big', 'no_kind',
                 'missing_status', 'gate_without_outcome', 'outcome_on_code_step', 'proposal_not_written',
                 'xref_unreadable', 'proposal_in_steps', 'source_unresolved', 'decision_untagged',
                 'bad_decision_tag', 'bad_decision_heading', 'duplicate_decision'}
INLINE_WARNINGS = {'file_not_found', 'new_file_exists', 'missing_section', 'unexpected_steps',
                   'milestone_ticked_incomplete', 'milestone_complete_unticked'}
# Errors only a mode reports (--lanes, --roadmap, --claude-md): each is exercised by a test below.
MODE_ERRORS = {'lane_cycle', 'not_a_proposal', 'not_a_roadmap', 'not_an_architecture', 'claude_md_drift'}
# Size budgets, W at the soft limit and E at the hard one: exercised by TestSizeBudgets on generated docs.
BUDGET_CODES = {'doc_too_big', 'too_many_steps', 'too_many_milestones'}


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


def record(n, title, tag=None):
    """One D-record: its heading, ending in "(TAG)" when TAG is given, and a short body."""
    return '### D%d: %s%s\n\n- Options: a; b.\n- Choice: a.\n\n' % (n, title, ' (%s)' % tag if tag else '')


def with_decisions(text, *records):
    """TEXT (from proposal() or architecture()) with RECORDS as the body of its ## Decisions section."""
    old = '## Decisions\n\nText.\n'
    assert text.count(old) == 1, text
    return text.replace(old, '## Decisions\n\n' + ''.join(records).rstrip('\n') + '\n', 1)


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

    def test_lint_codes_table_lists_exactly_the_known_codes(self):
        with open(os.path.join(ROOT, 'docs', 'PROPOSALS.md'), encoding='utf-8') as f:
            text = f.read()
        table = text.split('## Lint codes', 1)[1]
        documented = set()
        for line in table.splitlines():
            if line.startswith('| `'):
                documented.update(re.findall(r'`([a-z_]+)`', line.split('|')[1]))
        self.assertEqual(documented, ERROR_CODES | WARNING_CODES | INLINE_WARNINGS | MODE_ERRORS | BUDGET_CODES)


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
        with open(os.path.join(FIXTURES, 'valid-roadmap.md'), 'rb') as f:
            self.write('valid-roadmap.md', f.read())
        rc, out = self.lint(os.path.join(self.tmp, 'valid-proposal.md'))
        self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))
        self.assertEqual([s['acceptance'] for s in out['steps']][2],
                         'uploading a fixture returns its line items; an oversized upload is rejected with 413')

    def test_json_schema(self):
        out = self.assertClean(proposal(step(1, lane='core'), gate(2), step(3, deps='1, 2', files=['a.ts', 'b.ts (new)'])))
        for k in ('doc', 'kind', 'errors', 'warnings', 'steps', 'decisions'):
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

    def test_as_resolves_refs_from_the_given_path(self):
        # a draft kept outside the repo resolves Source: and <file>.md#N beside its real path under --as
        self.write('repo/docs/design/roadmap.md', roadmap(milestone(1, gate_kind='ops', done=True),
                                                           milestone(2, 'draft.md', deps='1')))
        self.write('repo/docs/design/other.md', proposal(step(1, done=True), step(2, done=True)))
        real = os.path.join(self.tmp, 'repo', 'docs', 'design', 'draft.md')
        text = proposal(step(1, deps='other.md#2'), step(2, deps='1'), source='roadmap.md#2')
        draft = self.write('outside/draft.md', text)
        rc, out = self.lint(draft)
        self.assertEqual((rc, out['errors']), (0, []))
        self.assertIn('source_unresolved', codes(out['warnings']))
        self.assertIn('xref_unreadable', codes(out['warnings']))
        for as_path, cwd in ((real, None), (os.path.join('repo', 'docs', 'design', 'draft.md'), self.tmp)):
            with self.subTest(as_path=as_path):
                rc, out = self.lint(draft, '--as', as_path, cwd=cwd)
                self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))
                code, stdout, err = run(draft, '--lanes', '--as', as_path, cwd=cwd)
                self.assertEqual(code, 0, stdout + err)
                self.assertEqual(chain_keys(json.loads(stdout)), [['s1', 's2']])
        # the refs are really read there: a step the other doc lacks is an error
        draft = self.write('outside/bad.md', proposal(step(1, deps='other.md#3'), source='roadmap.md#2'))
        rc, out = self.lint(draft, '--as', real)
        self.assertEqual(rc, 1)
        self.assertIn('xref_missing_step', codes(out['errors']))


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


# ---- D-records: who decided ---------------------------------------------------------------------

DECISION_KEYS = ['id', 'n', 'title', 'line', 'by', 'date', 'ref']
DECISION_CODES = ('decision_untagged', 'bad_decision_tag', 'bad_decision_heading', 'duplicate_decision')
# Trailing parentheticals that start like a tag and are not one of the closed forms.
BAD_TAGS = ('person', "person's decision, 2026-11-05", 'person 2026-11-05', 'person, 2026-02-30',
            'person, 05-11-2026', 'person, 2026-11-05, two words', 'person, 2026-11-05, intake.q2, edit',
            'Person, 2026-11-05', 'source: the brief', 'source of truth', 'assumed by the author', 'Assumed',
            'person, \uff12\uff10\uff12\uff16-\uff11\uff11-\uff10\uff15')    # the last: a date in full-width digits
# Headings under ## Decisions that number a decision without being "### D<N>: <title>": (its number, the heading).
BAD_HEADINGS = ((1, '### D1 \u2014 Licence (assumed)'), (2, '### D2. Price'), (3, '### Decision 3: Hosting (assumed)'),
                (4, '### D4 No colon (assumed)'), (5, '#### D5: A deeper heading (source)'),
                (6, ' ### D6: Indented (assumed)'), (7, '### d7: Lowercase d (person, 2026-11-05)'),
                (8, '### D\uff18: A full-width number (assumed)'))


def brief(decisions):
    return [(d['id'], d['title'], d['by'], d['date'], d['ref']) for d in decisions]


class TestDecisions(Base):
    def found(self, out):
        return [w for w in out['warnings'] if w['code'] in DECISION_CODES]

    def heading(self, out, item):
        with open(out['doc'], encoding='utf-8') as f:
            return f.read().splitlines()[item['line'] - 1]

    def decisions_mode(self, path, *extra, cwd=None):
        rc, stdout, err = run(path, '--decisions', *extra, cwd=cwd)
        self.assertEqual(rc, 0, stdout + err)
        return json.loads(stdout)

    def test_each_tag_form_is_parsed(self):
        text = with_decisions(proposal(step(1)),
                              record(1, 'Language and framework', 'source'),
                              record(3, 'Data store', 'assumed'),
                              record(7, 'Free-check input', 'person, 2026-11-05'),
                              record(12, 'Auth', 'person, 2026-11-12, architecture.q2'))
        out = self.assertClean(text)
        self.assertEqual(out['warnings'], [])
        self.assertEqual(brief(out['decisions']),
                         [('D1', 'Language and framework', 'source', '', ''),
                          ('D3', 'Data store', 'assumed', '', ''),
                          ('D7', 'Free-check input', 'person', '2026-11-05', ''),
                          ('D12', 'Auth', 'person', '2026-11-12', 'architecture.q2')])
        for d in out['decisions']:
            self.assertEqual(list(d), DECISION_KEYS)
            self.assertEqual(d['id'], 'D%d' % d['n'])
            self.assertTrue(self.heading(out, d).startswith('### %s: %s (' % (d['id'], d['title'])))

    def test_person_refs(self):
        refs = ('intake.q2', 'intake.d3', 'framing', 'roadmap.md#4', '01-status-page.md#4', 'edit')
        text = with_decisions(proposal(step(1)), *[record(n, 'Choice %d' % n, 'person, 2026-11-05, ' + ref)
                                                   for n, ref in enumerate(refs, 1)])
        out = self.assertClean(text)
        self.assertEqual(out['warnings'], [])
        self.assertEqual([(d['by'], d['date'], d['ref']) for d in out['decisions']],
                         [('person', '2026-11-05', ref) for ref in refs])

    def test_an_ordinary_trailing_parenthetical_is_part_of_the_title(self):
        text = with_decisions(proposal(step(1)),
                              record(1, 'Client', 'web'),
                              record(2, 'Retention', 'personal data'),
                              record(3, 'Hosting', 'see D1'),
                              record(4, 'Layout (monorepo)', 'assumed'),
                              record(5, 'Store (web)', 'person, 2026-11-05'))
        out = self.assertClean(text)
        self.assertEqual(brief(out['decisions']),
                         [('D1', 'Client (web)', '', '', ''),
                          ('D2', 'Retention (personal data)', '', '', ''),
                          ('D3', 'Hosting (see D1)', '', '', ''),
                          ('D4', 'Layout (monorepo)', 'assumed', '', ''),
                          ('D5', 'Store (web)', 'person', '2026-11-05', '')])
        # untagged records, not bad tags
        self.assertEqual(codes(self.found(out)), ['decision_untagged'])

    def test_records_are_read_under_decisions_and_outside_fences_only(self):
        text = with_decisions(proposal(step(1)),
                              '```md\n' + record(8, 'Fenced', 'assumed') + '```\n\n',
                              '~~~\n### D9: Also fenced\n~~~\n\n',
                              '### Notes on the records\n\n',
                              '#### Decision records, 2026\n\n',
                              record(2, 'Real', 'source'))
        text = text.replace('## Design\n\nText.\n', '## Design\n\n### D1: A heading in another section\n', 1)
        out = self.assertClean(text)
        self.assertEqual(brief(out['decisions']), [('D2', 'Real', 'source', '', '')])
        self.assertEqual(out['warnings'], [])

    def test_architecture_records_and_none_in_a_roadmap(self):
        out = self.assertClean(with_decisions(architecture(), record(1, 'Data store', 'person, 2026-10-30'),
                                              record(2, 'One repository')))
        self.assertEqual(brief(out['decisions']), [('D1', 'Data store', 'person', '2026-10-30', ''),
                                                   ('D2', 'One repository', '', '', '')])
        self.assertEqual(codes(out['warnings']), ['decision_untagged'])
        rm = roadmap(milestone(1, gate_kind='ops')) + '\n## Decisions\n\n' + record(1, 'Untagged') + record(2, 'Bad', 'person')
        out = self.assertClean(rm)
        self.assertEqual((out['kind'], out['decisions'], out['warnings']), ('roadmap', [], []))

    def test_docs_without_records_have_an_empty_list_and_no_warning(self):
        for text in (proposal(step(1)), architecture(), proposal(step(1), full=False)):
            out = self.assertClean(text)
            self.assertEqual((out['decisions'], self.found(out)), ([], []))

    def test_untagged_is_one_warning_per_doc_naming_every_record(self):
        text = with_decisions(proposal(step(1)),
                              record(1, 'Tagged', 'assumed'),
                              record(2, 'Untagged'),
                              record(3, 'Bad', 'person'),
                              record(4, 'Also untagged', 'web'),
                              record(10, 'Untagged too'))
        rc, out = self.lint_text(text)
        self.assertEqual((rc, out['errors']), (0, []))
        untagged = [w for w in out['warnings'] if w['code'] == 'decision_untagged']
        self.assertEqual(len(untagged), 1)
        self.assertTrue(self.heading(out, untagged[0]).startswith('### D2: '))
        self.assertEqual(re.findall(r'\bD\d+\b', untagged[0]['message']), ['D2', 'D4', 'D10'])
        for form in ('(person, YYYY-MM-DD)', '(person, YYYY-MM-DD, <ref>)', '(source)', '(assumed)'):
            self.assertIn(form, untagged[0]['message'])
        # one record: the same single warning
        out = self.assertWarning(with_decisions(proposal(step(1)), record(1, 'Only')), 'decision_untagged')
        self.assertEqual(codes(self.found(out)), ['decision_untagged'])
        self.assertIn('D1 has no provenance tag', self.found(out)[0]['message'])

    def test_bad_tag_is_one_warning_per_record_and_counts_as_untagged(self):
        text = with_decisions(proposal(step(1)), *[record(n, 'Choice %d' % n, tag)
                                                   for n, tag in enumerate(BAD_TAGS, 1)])
        rc, out = self.lint_text(text)
        self.assertEqual((rc, out['errors']), (0, []))
        # each record is reported by bad_decision_tag only: no decision_untagged beside it
        self.assertEqual(codes(self.found(out)), ['bad_decision_tag'] * len(BAD_TAGS))
        for n, (tag, d, w) in enumerate(zip(BAD_TAGS, out['decisions'], self.found(out)), 1):
            with self.subTest(tag=tag):
                self.assertEqual(brief([d]), [('D%d' % n, 'Choice %d (%s)' % (n, tag), '', '', '')])
                self.assertEqual(w['line'], d['line'])
                self.assertTrue(w['message'].startswith('D%d: "(%s)" is not a provenance tag' % (n, tag)))
                self.assertIn('(person, YYYY-MM-DD, <ref>)', w['message'])

    def test_a_heading_that_is_not_the_record_form_is_listed_and_warned(self):
        # Such a record was invisible: no warning, and --decisions listed nothing, so nobody was shown the choice.
        text = with_decisions(proposal(step(1)), record(9, 'Real', 'source'),
                              *[h + '\n\n- Options: a; b.\n- Choice: a.\n\n' for _, h in BAD_HEADINGS])
        path = self.write('d.md', text)
        rc, out = self.lint(path)
        self.assertEqual((rc, out['errors']), (0, []))
        # one warning per heading, and none of them is also reported as untagged
        self.assertEqual(codes(self.found(out)), ['bad_decision_heading'] * len(BAD_HEADINGS))
        for (n, h), d, w in zip(BAD_HEADINGS, out['decisions'][1:], self.found(out)):
            with self.subTest(heading=h):
                # no tag is read from it, whatever its parenthetical says: the title is the heading's whole text
                self.assertEqual(brief([d]), [('D%d' % n, h.strip().lstrip('#').strip(), '', '', '')])
                self.assertEqual(list(d), DECISION_KEYS)
                self.assertEqual((w['line'], self.heading(out, d)), (d['line'], h))
                self.assertTrue(w['message'].startswith('D%d: "%s" is not written as a D-record' % (n, d['title'])))
                self.assertIn('"### D<N>: <title> (<tag>)"', w['message'])
                self.assertIn('(person, YYYY-MM-DD, <ref>)', w['message'])
        # --decisions lists each as unconfirmed, so the person is shown it before the doc is accepted
        res = self.decisions_mode(path)
        self.assertEqual([d['id'] for d in res['decisions']], ['D9'] + ['D%d' % n for n, _ in BAD_HEADINGS])
        self.assertEqual([d['id'] for d in res['unconfirmed']], ['D%d' % n for n, _ in BAD_HEADINGS])
        # an architecture reads them the same way; a roadmap still records none
        out = self.assertWarning(with_decisions(architecture(), BAD_HEADINGS[0][1] + '\n'), 'bad_decision_heading')
        self.assertEqual([d['id'] for d in out['decisions']], ['D1'])
        rm = roadmap(milestone(1, gate_kind='ops')) + '\n## Decisions\n\n' + BAD_HEADINGS[0][1] + '\n'
        out = self.assertClean(rm)
        self.assertEqual((out['decisions'], out['warnings']), ([], []))

    def test_a_repeated_number_is_one_warning_at_each_later_record(self):
        text = with_decisions(proposal(step(1)),
                              record(1, 'Language', 'source'),
                              record(2, 'Data store', 'source'),
                              record(2, 'Repeated', 'assumed'),
                              record(3, 'Auth', 'person, 2026-11-05'),
                              record(2, 'Repeated again', 'source'))
        rc, out = self.lint_text(text)
        self.assertEqual((rc, out['errors']), (0, []))
        self.assertEqual(codes(self.found(out)), ['duplicate_decision', 'duplicate_decision'])
        first = out['decisions'][1]
        for d, w in zip((out['decisions'][2], out['decisions'][4]), self.found(out)):
            self.assertEqual(w['line'], d['line'])
            self.assertTrue(w['message'].startswith('D2 is numbered twice (also line %d)' % first['line']), w['message'])
        # every record is still listed, the repeated ones too
        self.assertEqual([d['title'] for d in out['decisions']],
                         ['Language', 'Data store', 'Repeated', 'Auth', 'Repeated again'])
        # a number written once draws nothing
        out = self.assertClean(with_decisions(proposal(step(1)), record(1, 'A', 'source'), record(2, 'B', 'source')))
        self.assertEqual(out['warnings'], [])

    def test_tag_warnings_never_fail_the_lint(self):
        path = self.write('d.md', with_decisions(proposal(step(1)), record(1, 'Untagged'), record(2, 'Bad', 'person')))
        rc, out, _ = run(path)
        self.assertEqual(rc, 0)
        lines = out.strip().splitlines()
        self.assertRegex(lines[0], '^' + re.escape(path) + r':\d+: W decision_untagged: D1 has no provenance tag')
        self.assertRegex(lines[1], '^' + re.escape(path) + r':\d+: W bad_decision_tag: D2: "\(person\)" is not ')
        self.assertIn('0 errors, 2 warnings', lines[-1])
        # --lanes still derives: the warnings ride along
        lanes = self.lanes(path)
        self.assertEqual(chain_keys(lanes), [['s1']])
        self.assertEqual(codes(lanes['warnings']), ['decision_untagged', 'bad_decision_tag'])

    def test_tolerated_spacing_and_trailing_comment(self):
        text = with_decisions(proposal(step(1)),
                              '### D1:  Spaced  ( person , 2026-11-05 , intake.d3 )   <!-- confirmed -->\n\n',
                              '### D2: Tight (person,2026-11-05)\n\n')
        out = self.assertClean(text)
        self.assertEqual(out['warnings'], [])
        self.assertEqual(brief(out['decisions']), [('D1', 'Spaced', 'person', '2026-11-05', 'intake.d3'),
                                                   ('D2', 'Tight', 'person', '2026-11-05', '')])

    def test_crlf_headings(self):
        text = with_decisions(proposal(step(1)), record(1, 'Data store', 'assumed'), record(2, 'Auth'))
        out = self.assertClean(text.replace('\n', '\r\n'))
        self.assertEqual(brief(out['decisions']), [('D1', 'Data store', 'assumed', '', ''), ('D2', 'Auth', '', '', '')])

    def mode_doc(self):
        long_line = 'The price is 9 a month (proposed; the person fixes it at the pricing confirmation). ' + 'x' * 300
        text = with_decisions(proposal(step(1, desc='Alert above 5 failures an hour (proposed).')),
                              record(1, 'Language', 'source'),
                              record(2, 'Data store', 'assumed'),
                              record(3, 'Price', 'person, 2026-11-05, intake.q2'),
                              record(4, 'Hosting'),
                              record(5, 'Licence', 'person'),
                              '   Retention is 30 days (proposed: fixed at roadmap gate "Approve the privacy notice").  \n\n',
                              '```\nA fenced value (proposed) is not listed.\n```\n\n',
                              long_line + '\n')
        return text, long_line

    def test_decisions_mode_lists_unconfirmed_and_proposed(self):
        text, long_line = self.mode_doc()
        path = self.write('d.md', text)
        before = self.read(path)
        out = self.decisions_mode(path)
        self.assertEqual(list(out), ['doc', 'kind', 'decisions', 'unconfirmed', 'proposed'])
        self.assertEqual((out['doc'], out['kind']), (path, 'proposal'))
        self.assertEqual(out['decisions'], self.lint(path)[1]['decisions'])
        self.assertEqual([d['id'] for d in out['decisions']], ['D1', 'D2', 'D3', 'D4', 'D5'])
        # assumed, untagged, and a bad tag (which counts as untagged): everything but source and person
        self.assertEqual(brief(out['unconfirmed']), [('D2', 'Data store', 'assumed', '', ''),
                                                     ('D4', 'Hosting', '', '', ''),
                                                     ('D5', 'Licence (person)', '', '', '')])
        for d in out['unconfirmed']:
            self.assertIn(d, out['decisions'])
        lines = text.splitlines()
        self.assertEqual([p['text'] for p in out['proposed']],
                         ['Retention is 30 days (proposed: fixed at roadmap gate "Approve the privacy notice").',
                          long_line[:200],
                          '1. [ ] **Step 1.** Alert above 5 failures an hour (proposed).'])
        for p in out['proposed']:
            self.assertEqual(list(p), ['line', 'text'])
            self.assertTrue(lines[p['line'] - 1].strip().startswith(p['text']))
        self.assertEqual(self.read(path), before)

    def test_decisions_mode_ignores_lint_errors_and_budgets(self):
        text = with_decisions(proposal(step(1, deps=None), 'not a step\n2. [ ] broken\n', status='nonsense'),
                              record(1, 'Data store', 'assumed'))
        path = self.write('d.md', text)
        rc, out = self.lint(path)
        self.assertEqual(rc, 1)
        self.assertTrue({'missing_depends', 'malformed_step', 'bad_status'} <= set(codes(out['errors'])))
        res = self.decisions_mode(path)
        self.assertEqual((brief(res['decisions']), brief(res['unconfirmed'])),
                         ([('D1', 'Data store', 'assumed', '', '')], [('D1', 'Data store', 'assumed', '', '')]))
        self.assertNotIn('errors', res)
        # an architecture with a section missing, and a doc over its error limit
        arch = self.write('a.md', with_decisions(architecture(skip=('Testing',)), record(1, 'Store', 'source')))
        self.assertEqual(self.lint(arch)[0], 1)
        res = self.decisions_mode(arch)
        self.assertEqual((res['kind'], brief(res['decisions']), res['unconfirmed']),
                         ('architecture', [('D1', 'Store', 'source', '', '')], []))
        big = self.write('big.md', sized('proposal', 80 * KB + 1, with_decisions(proposal(step(1)), record(1, 'Store'))))
        self.assertEqual(self.lint(big)[0], 1)
        self.assertEqual([d['id'] for d in self.decisions_mode(big)['unconfirmed']], ['D1'])

    def test_decisions_mode_on_a_roadmap_and_a_doc_with_no_kind(self):
        rm = roadmap(step(1, gate='decision — continue only if 20 teams post within 60 days (proposed)', acc='recorded'))
        path = self.write('roadmap.md', rm + '\n## Decisions\n\n' + record(1, 'Not a roadmap\'s to record'))
        res = self.decisions_mode(path)
        self.assertEqual((res['kind'], res['decisions'], res['unconfirmed']), ('roadmap', [], []))
        self.assertEqual(len(res['proposed']), 1)
        self.assertIn('20 teams post within 60 days (proposed)', res['proposed'][0]['text'])
        # a doc with no kind is read as a proposal, as the lint reads it
        notes = self.write('notes.md', '# Notes\n\n## Decisions\n\n' + record(1, 'Store', 'assumed'))
        res = self.decisions_mode(notes)
        self.assertEqual((res['kind'], brief(res['decisions'])), ('proposal', [('D1', 'Store', 'assumed', '', '')]))
        empty = self.decisions_mode(self.write('p.md', proposal(step(1))))
        self.assertEqual((empty['decisions'], empty['unconfirmed'], empty['proposed']), ([], [], []))

    def test_decisions_mode_resolves_nothing_from_any_cwd(self):
        # refs to docs that do not exist are not read: the mode needs only the doc itself
        text = with_decisions(proposal(step(1, deps='gone.md#3'), source='roadmap.md#9'), record(1, 'Store', 'assumed'))
        self.write('sub/d.md', text)
        res = self.decisions_mode(os.path.join('sub', 'd.md'), cwd=self.tmp)
        self.assertEqual((res['doc'], [d['id'] for d in res['decisions']]), (os.path.join('sub', 'd.md'), ['D1']))

    def test_decisions_mode_exit_codes_and_usage(self):
        ok = self.write('ok.md', with_decisions(proposal(step(1)), record(1, 'Store', 'assumed')))
        self.assertEqual(run(os.path.join(self.tmp, 'missing.md'), '--decisions')[0], 2)
        self.assertEqual(run(self.write('bin.md', b'# Proposal: x\n\xff\xfe\n'), '--decisions')[0], 2)
        self.assertEqual(run(ok, '--decisions')[0], 0)
        self.assertEqual(run(ok, '--decisions', '--json')[1], run(ok, '--decisions')[1])
        for other in (['--lanes'], ['--tick', '1'], ['--roadmap'], ['--claude-md', ok]):
            with self.subTest(other=other):
                self.assertEqual(run(ok, '--decisions', *other)[0], 2)


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

    def test_unresolved_source_milestone_blocks_every_lane(self):
        # fails closed: a Source: that names a roadmap milestone the lint cannot resolve never skips its gates
        self.write('roadmap.md', roadmap(milestone(1, gate_kind='ops', done=True), milestone(2, 'doc.md', deps='1')))
        self.write('other.md', proposal(step(1), step(2)))
        for source in ('no-such-roadmap.md#2', 'other.md#2', 'roadmap.md#9', 'roadmap.md, milestone 2'):
            with self.subTest(source=source):
                out = self.lanes_text(proposal(step(1), step(2, deps='1'), source=source))
                self.assertEqual(out['chains'], [])
                self.assertEqual(sorted(blocked(out)), ['s1', 's2'])
                for b in out['blocked']:
                    self.assertIn('milestone_unresolved', [w['reason'] for w in b['waiting_on']])
                self.assertIn('source_unresolved', codes(out['warnings']))
                self.assertIn('source_unresolved', codes(self.lint_text(proposal(step(1), source=source))[1]['warnings']))
        # a resolvable milestone and a plain brief or concern source cause neither
        for source in ('roadmap.md#2', 'docs/brief.md', 'concern'):
            with self.subTest(source=source):
                out = self.lanes_text(proposal(step(1), step(2, deps='1'), source=source))
                self.assertEqual((chain_keys(out), out['blocked']), ([['s1', 's2']], []))
                self.assertNotIn('source_unresolved', codes(out['warnings']))

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

    def test_lane_cycle_is_found_among_blocked_lanes(self):
        cyc = (step(1, lane='a'), step(2, deps='1'), step(3, lane='a', deps='2'))
        # a draft: the preview with --allow-draft, and without it, where every lane is blocked
        for extra in (('--allow-draft',), ()):
            with self.subTest(extra=extra):
                out = self.lanes_text(proposal(*cyc, status='draft'), *extra, rc=1)
                self.assertEqual((codes(out['errors']), out['chains']), (['lane_cycle'], []))
        # an accepted doc whose cyclic lanes all wait on a pending gate
        out = self.lanes_text(proposal(gate(1), step(2, lane='a', deps='1'), step(3, deps='2'),
                                       step(4, lane='a', deps='3')), rc=1)
        self.assertEqual((codes(out['errors']), out['chains']), (['lane_cycle'], []))

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


# ---- --claude-md ------------------------------------------------------------------------------

INVARIANTS = '- Never log a secret.\n- Every parser change ships with a fixture.\n'
TESTING = 'Unit tests per package; fixtures are synthetic.\n\n```sh\nnpm test\n```\n'
POINTER = 'These come from `docs/design/architecture.md` and change in both places together.\n'


def arch_with_rules(invariants=INVARIANTS, testing=TESTING):
    text = architecture()
    text = text.replace('## Invariants\n\nText.\n', '## Invariants\n\n' + invariants, 1)
    return text.replace('## Testing\n\nText.\n', '## Testing\n\n' + testing, 1)


def claude_md(invariants=INVARIANTS, testing=TESTING, pointer=POINTER, pointer_last=False, tail='## Other\n\nx\n'):
    out = '# Product\n\n## Pipeline config\n\nMAIN_BRANCH: main\n\n'
    if invariants is not None:
        if pointer:
            invariants = invariants + '\n' + pointer if pointer_last else pointer + '\n' + invariants
        out += '## Invariants\n\n' + invariants + '\n'
    if testing is not None:
        out += '## Testing\n\n' + testing + '\n'
    return out + tail


class TestClaudeMd(Base):
    def drift(self, arch, cm, rc=None):
        a = self.write('docs/design/architecture.md', arch)
        c = self.write('CLAUDE.md', cm)
        code, out, err = run(a, '--claude-md', c, '--json')
        self.assertIn(code, (0, 1), err)
        res = json.loads(out)
        self.assertEqual(code, 1 if res['errors'] else 0)
        return res, c

    def test_matching_copy_with_the_bootstrap_pointer_is_clean(self):
        for last in (False, True):
            with self.subTest(pointer_last=last):
                res, _ = self.drift(arch_with_rules(), claude_md(pointer_last=last))
                self.assertEqual((res['kind'], res['errors'], res['warnings']), ('architecture', [], []))

    def test_a_hand_written_section_above_the_bootstrap_copy_is_not_compared(self):
        # /seed appends to an existing CLAUDE.md and /bootstrap appends its copies after its marker: a person's own
        # ## Testing above them is theirs, and the copy /bootstrap wrote is the one checked.
        own = '# Product\n\n## Testing\n\nRun `make test` before pushing.\n\n'
        marked = own + claude_md().replace('## Pipeline config\n\n', '## Pipeline config\n\n<!-- Pipeline config written by /bootstrap -->\n', 1).replace('# Product\n\n', '', 1)
        res, _ = self.drift(arch_with_rules(), marked)
        self.assertEqual(res['errors'], [], 'the copy after the /bootstrap marker matches')
        res, _ = self.drift(arch_with_rules(), marked.replace('fixtures are synthetic', 'fixtures are real'))
        self.assertEqual(codes(res['errors']), ['claude_md_drift'], 'and a drifted copy is still caught')
        # No marker: the last section of a name (the appended one) is checked.
        res, _ = self.drift(arch_with_rules(), own + claude_md().replace('# Product\n\n', '', 1))
        self.assertEqual(res['errors'], [])

    def test_without_pointer_line_and_crlf_is_clean(self):
        res, _ = self.drift(arch_with_rules(), claude_md(pointer='').replace('\n', '\r\n'))
        self.assertEqual(res['errors'], [])

    def test_drift_names_the_section_and_line(self):
        cm = claude_md(testing=TESTING.replace('synthetic', 'real'))
        res, c = self.drift(arch_with_rules(), cm)
        self.assertEqual(codes(res['errors']), ['claude_md_drift'])
        e = res['errors'][0]
        self.assertIn('## Testing', e['message'])
        self.assertEqual(e['path'], c)
        self.assertTrue(cm.splitlines()[e['line'] - 1].startswith('Unit tests'))

    def test_changed_invariant_is_drift(self):
        for inv in (INVARIANTS + '- A third rule.\n', '- Never log a secret.\n', INVARIANTS.replace('secret', 'token')):
            with self.subTest(inv=inv):
                res, _ = self.drift(arch_with_rules(), claude_md(invariants=inv))
                self.assertEqual(codes(res['errors']), ['claude_md_drift'])
                self.assertIn('## Invariants', res['errors'][0]['message'])

    def test_only_one_pointer_line_is_ignored(self):
        res, _ = self.drift(arch_with_rules(), claude_md(invariants=POINTER + '\n' + INVARIANTS))
        self.assertEqual(codes(res['errors']), ['claude_md_drift'])
        # a line naming architecture.md in the middle of the body is content, not the pointer
        mid = '- Never log a secret.\n' + POINTER + '- Every parser change ships with a fixture.\n'
        res, _ = self.drift(arch_with_rules(), claude_md(invariants=mid, pointer=''))
        self.assertEqual(codes(res['errors']), ['claude_md_drift'])
        # nor is a pointer under ## Testing
        res, _ = self.drift(arch_with_rules(), claude_md(testing=POINTER + '\n' + TESTING))
        self.assertEqual(codes(res['errors']), ['claude_md_drift'])

    def test_missing_section_in_claude_md(self):
        for kw, name in (({'invariants': None}, 'Invariants'), ({'testing': None}, 'Testing')):
            with self.subTest(section=name):
                res, _ = self.drift(arch_with_rules(), claude_md(**kw))
                self.assertEqual(codes(res['errors']), ['claude_md_drift'])
                self.assertIn('## %s' % name, res['errors'][0]['message'])

    def test_headings_inside_fences_do_not_end_a_body(self):
        testing = 'Rules.\n\n```md\n## Not a heading\n```\n\nMore rules.\n'
        res, _ = self.drift(arch_with_rules(testing=testing), claude_md(testing=testing))
        self.assertEqual(res['errors'], [])
        res, _ = self.drift(arch_with_rules(testing=testing), claude_md(testing='Rules.\n'))
        self.assertEqual(codes(res['errors']), ['claude_md_drift'])

    def test_architecture_lint_errors_still_reported(self):
        res, _ = self.drift(arch_with_rules().replace('## Data model\n\nText.\n\n', ''), claude_md())
        self.assertEqual(codes(res['errors']), ['missing_section'])

    def test_plain_output_names_claude_md(self):
        a = self.write('docs/design/architecture.md', arch_with_rules())
        c = self.write('CLAUDE.md', claude_md(testing='Other rules.\n'))
        rc, out, _ = run(a, '--claude-md', c)
        self.assertEqual(rc, 1)
        self.assertRegex(out.splitlines()[0], '^' + re.escape(c) + r':\d+: E claude_md_drift: "## Testing"')

    def test_mode_errors_and_usage(self):
        c = self.write('CLAUDE.md', claude_md())
        p = self.write('p.md', proposal(step(1)))
        rc, out, _ = run(p, '--claude-md', c, '--json')
        self.assertEqual(rc, 1)
        self.assertEqual(codes(json.loads(out)['errors']), ['not_an_architecture'])
        a = self.write('architecture.md', arch_with_rules())
        self.assertEqual(run(a, '--claude-md', os.path.join(self.tmp, 'nope.md'))[0], 2)
        self.assertEqual(run(a, '--claude-md', c, '--lanes')[0], 2)
        self.assertEqual(run(a, '--claude-md', c, '--roadmap')[0], 2)


# ---- size budgets ------------------------------------------------------------------------------

KB = 1024
# The budgets (docs/PROPOSALS.md, Size budgets): KB per doc kind and items per list, as (warning above, error above).
SIZE_BUDGETS = {'architecture': (48, 96), 'roadmap': (24, 48), 'proposal': (40, 80)}
STEP_BUDGET = (12, 20)
MILESTONE_BUDGET = (20, None)
PAD = 'Padding prose that a size-budget test adds; no lint rule reads it.\n'
# Where padding goes: a section (or the roadmap's paragraph before its list) the lint does not parse.
PAD_AFTER = {'architecture': '## Context\n\n', 'roadmap': 'Status: accepted\n\n', 'proposal': '## Context\n\n'}


def grow(text, size, after):
    """TEXT as UTF-8 bytes, grown to exactly SIZE bytes by prose lines inserted after the first AFTER."""
    data, mark = text.encode('utf-8'), after.encode('utf-8')
    need = size - len(data)
    assert need >= 0, 'the doc is already %d bytes' % len(data)
    unit = PAD.encode('utf-8')
    pad = unit * (need // len(unit))
    if need > len(pad):
        pad += b'p' * (need - len(pad) - 1) + b'\n'
    at = data.index(mark) + len(mark)
    return data[:at] + pad + data[at:]


def steps_doc(n):
    return proposal(*[step(i) for i in range(1, n + 1)])


def milestones_doc(n):
    return roadmap(*[milestone(i, gate_kind='ops') for i in range(1, n + 1)])


def sized(kind, size, text=None):
    """A doc of KIND that lints clean (or TEXT), grown to SIZE bytes."""
    base = {'architecture': architecture, 'roadmap': lambda: milestones_doc(1), 'proposal': lambda: steps_doc(1)}
    return grow(text if text is not None else base[kind](), size, PAD_AFTER[kind])


class TestSizeBudgets(Base):
    def found(self, out, code):
        return [e for e in out['errors'] if e['code'] == code], [w for w in out['warnings'] if w['code'] == code]

    def line_text(self, out, finding):
        with open(out['doc'], encoding='utf-8') as f:
            return f.read().splitlines()[finding['line'] - 1]

    def test_doc_size_limits_per_kind(self):
        for kind, (soft, hard) in sorted(SIZE_BUDGETS.items()):
            for size, want in ((soft * KB, (0, 0, 0)), (soft * KB + 1, (0, 0, 1)), (hard * KB, (0, 0, 1)),
                               (hard * KB + 1, (1, 1, 0))):
                with self.subTest(kind=kind, size=size):
                    rc, out = self.lint_text(sized(kind, size), name='%s.md' % kind)
                    self.assertEqual(out['kind'], kind)
                    errors, warnings = self.found(out, 'doc_too_big')
                    self.assertEqual((rc, len(errors), len(warnings)), want)
                    self.assertEqual([x for x in out['errors'] + out['warnings'] if x['code'] != 'doc_too_big'], [])

    def test_size_messages_name_the_size_the_limit_and_the_fix(self):
        fixes = {'architecture': 'to the proposal that builds it', 'roadmap': 'one or two sentences',
                 'proposal': 'new milestone after the last one'}
        for kind, (soft, hard) in sorted(SIZE_BUDGETS.items()):
            with self.subTest(kind=kind):
                _, out = self.lint_text(sized(kind, soft * KB + 1), name='%s.md' % kind)
                w = self.found(out, 'doc_too_big')[1][0]
                self.assertEqual(w['line'], 1)
                self.assertIn('is %d.1 KB, over the %d KB warning limit (error above %d KB): ' % (soft, soft, hard),
                              w['message'])
                self.assertIn(fixes[kind], w['message'])
                _, out = self.lint_text(sized(kind, hard * KB + 1), name='%s.md' % kind)
                e = self.found(out, 'doc_too_big')[0][0]
                self.assertIn('is %d.1 KB, over the %d KB error limit: ' % (hard, hard), e['message'])
                self.assertIn(fixes[kind], e['message'])

    def test_size_counts_bytes_not_characters(self):
        text = steps_doc(1).replace('## Context\n\n', '## Context\n\n' + '—' * (14 * KB) + '\n', 1)
        self.assertLess(len(text), SIZE_BUDGETS['proposal'][0] * KB)
        self.assertGreater(len(text.encode('utf-8')), SIZE_BUDGETS['proposal'][0] * KB)
        self.assertWarning(text, 'doc_too_big')

    def test_a_doc_with_no_kind_is_measured_as_a_proposal(self):
        rc, out = self.lint_text(grow('Status: draft\n\n## Steps\n\n' + step(1), 40 * KB + 1, 'Status: draft\n\n'))
        self.assertEqual((rc, out['kind']), (0, 'proposal'))
        self.assertIn('no_kind', codes(out['warnings']))
        self.assertIn('this proposal is 40.1 KB', self.found(out, 'doc_too_big')[1][0]['message'])

    def test_step_limits(self):
        soft, hard = STEP_BUDGET
        for n, want in ((soft, (0, 0, 0)), (soft + 1, (0, 0, 1)), (hard, (0, 0, 1)), (hard + 1, (1, 1, 0))):
            with self.subTest(steps=n):
                rc, out = self.lint_text(steps_doc(n))
                errors, warnings = self.found(out, 'too_many_steps')
                self.assertEqual((rc, len(errors), len(warnings)), want)
                self.assertEqual([x for x in out['errors'] + out['warnings'] if x['code'] != 'too_many_steps'], [])
                for f in errors + warnings:
                    self.assertEqual(self.line_text(out, f), '## Steps')
                    self.assertIn('new milestone after the last one', f['message'])
        out = self.assertWarning(steps_doc(soft + 1), 'too_many_steps')
        self.assertIn('this proposal has %d steps, over the %d-step warning limit (error above %d): '
                      % (soft + 1, soft, hard), self.found(out, 'too_many_steps')[1][0]['message'])
        out = self.assertError(steps_doc(hard + 1), 'too_many_steps')
        self.assertIn('this proposal has %d steps, over the %d-step error limit: ' % (hard + 1, hard),
                      self.found(out, 'too_many_steps')[0][0]['message'])

    def test_every_step_counts_ticked_and_gated(self):
        steps = [step(1, done=True), gate(2, kind='ops', done=True), gate(3)]
        steps += [step(n) for n in range(4, STEP_BUDGET[0] + 2)]
        out = self.assertWarning(proposal(*steps), 'too_many_steps')
        self.assertIn('has %d steps' % (STEP_BUDGET[0] + 1), self.found(out, 'too_many_steps')[1][0]['message'])

    def test_milestone_limit_warns_and_never_errors(self):
        soft = MILESTONE_BUDGET[0]
        for n, warned in ((soft, False), (soft + 1, True), (3 * soft, True)):
            with self.subTest(milestones=n):
                rc, out = self.lint_text(milestones_doc(n), name='roadmap.md')
                self.assertEqual((rc, out['errors']), (0, []))
                warnings = self.found(out, 'too_many_milestones')[1]
                self.assertEqual(len(warnings), 1 if warned else 0)
                for w in warnings:
                    self.assertEqual(self.line_text(out, w), '## Milestones')
                    self.assertIn('this roadmap has %d milestones, over the %d-milestone warning limit: merge '
                                  'milestones that ship together' % (n, soft), w['message'])

    def test_list_budgets_apply_to_their_own_kind(self):
        out = self.assertClean(roadmap(*[milestone(i, gate_kind='ops') for i in range(1, STEP_BUDGET[1] + 2)]))
        self.assertNotIn('too_many_steps', codes(out['warnings']))
        out = self.assertWarning(architecture(extra='## Steps\n\n' + ''.join(step(n) for n in range(1, 30))),
                                 'unexpected_steps')
        self.assertEqual(set(codes(out['warnings'])) & BUDGET_CODES, set())

    def test_no_size_limits_turns_every_check_off(self):
        docs = {'architecture.md': sized('architecture', 97 * KB),
                'roadmap.md': sized('roadmap', 49 * KB, milestones_doc(MILESTONE_BUDGET[0] + 1)),
                'p.md': sized('proposal', 81 * KB, steps_doc(STEP_BUDGET[1] + 1))}
        for name, text in sorted(docs.items()):
            with self.subTest(doc=name):
                path = self.write(name, text)
                rc, out = self.lint(path)
                self.assertEqual(rc, 1)
                self.assertIn('doc_too_big', codes(out['errors']))
                rc, out = self.lint(path, '--no-size-limits')
                self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))

    def test_lanes_refuse_a_doc_over_an_error_limit(self):
        for name, text, code in (('big.md', sized('proposal', 80 * KB + 1), 'doc_too_big'),
                                 ('long.md', steps_doc(STEP_BUDGET[1] + 1), 'too_many_steps')):
            with self.subTest(doc=name):
                path = self.write(name, text)
                out = self.lanes(path, rc=1)
                self.assertEqual(codes(out['errors']), [code])
                self.assertEqual((out['chains'], out['blocked'], out['human_gates_pending'], out['done']),
                                 ([], [], [], []))
                self.assertNotIn('slug', out)
                out = self.lanes(path, '--no-size-limits')
                self.assertEqual(out['errors'], [])
                self.assertTrue(out['chains'])

    def test_lanes_derive_over_a_warning_limit(self):
        out = self.lanes_text(sized('proposal', 40 * KB + 1, steps_doc(STEP_BUDGET[0] + 1)))
        self.assertEqual(sorted(codes(out['warnings'])), ['doc_too_big', 'too_many_steps'])
        self.assertEqual(chain_keys(out), sorted([['s%d' % n] for n in range(1, STEP_BUDGET[0] + 2)]))

    def test_roadmap_mode_reports_progress_and_the_budget_error(self):
        path = self.write('roadmap.md', sized('roadmap', 48 * KB + 1, milestones_doc(MILESTONE_BUDGET[0] + 1)))
        rc, stdout, _ = run(path, '--roadmap')
        out = json.loads(stdout)
        self.assertEqual((rc, codes(out['errors']), codes(out['warnings'])), (1, ['doc_too_big'], ['too_many_milestones']))
        self.assertEqual(out['next'], list(range(1, MILESTONE_BUDGET[0] + 2)))
        rc, stdout, _ = run(path, '--roadmap', '--no-size-limits')
        out = json.loads(stdout)
        self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))

    def test_claude_md_mode_reports_the_budget_error_beside_any_drift(self):
        a = self.write('docs/design/architecture.md', sized('architecture', 96 * KB + 1, arch_with_rules()))
        for cm, want in ((claude_md(), ['doc_too_big']), (claude_md(testing='Other rules.\n'), ['claude_md_drift', 'doc_too_big'])):
            with self.subTest(errors=want):
                c = self.write('CLAUDE.md', cm)
                rc, out, _ = run(a, '--claude-md', c, '--json')
                self.assertEqual((rc, sorted(codes(json.loads(out)['errors']))), (1, want))
        rc, out, _ = run(a, '--claude-md', c, '--json', '--no-size-limits')
        self.assertEqual((rc, codes(json.loads(out)['errors'])), (1, ['claude_md_drift']))

    def test_tick_ignores_the_budgets(self):
        path = self.write('d.md', sized('proposal', 80 * KB + 1, steps_doc(STEP_BUDGET[1] + 1)))
        before = self.read(path)
        for n, flags in (('21', ()), ('20', ('--no-size-limits',))):
            code, out, err = run(path, '--tick', n, *flags)
            self.assertEqual(code, 0, out + err)
            self.assertEqual(json.loads(out), {'ticked': [int(n)], 'already': [], 'missing': []})
        self.assertEqual(self.read(path), before.replace(b'\n21. [ ] **', b'\n21. [x] **', 1)
                         .replace(b'\n20. [ ] **', b'\n20. [x] **', 1))

    def test_only_the_doc_given_is_measured(self):
        # the roadmap its Source: names, and a doc a step depends on, are over their limits; this doc is not
        self.write('roadmap.md', sized('roadmap', 48 * KB + 1, roadmap(milestone(1, 'doc.md'))))
        self.write('other.md', steps_doc(STEP_BUDGET[1] + 1))
        text = proposal(step(1, deps='other.md#21'), step(2), source='roadmap.md#1')
        rc, out = self.lint_text(text, name='doc.md')
        self.assertEqual((rc, out['errors'], out['warnings']), (0, [], []))
        out = self.lanes_text(text, name='doc.md')
        self.assertEqual((chain_keys(out), [b['lane'] for b in out['blocked']]), ([['s2']], ['s1']))

    def test_plain_output(self):
        path = self.write('d.md', sized('proposal', 81 * KB, steps_doc(STEP_BUDGET[1] + 1)))
        rc, out, _ = run(path)
        self.assertEqual(rc, 1)
        lines = out.strip().splitlines()
        self.assertTrue(lines[0].startswith(path + ':1: E doc_too_big: this proposal is 81.0 KB, over the 80 KB '
                                            'error limit: '), lines[0])
        self.assertRegex(lines[1], '^' + re.escape(path) + r':\d+: E too_many_steps: this proposal has 21 steps')
        self.assertIn('21 steps, 2 errors, 0 warnings', lines[-1])

    def test_budget_table_in_proposals_md_matches(self):
        with open(os.path.join(ROOT, 'docs', 'PROPOSALS.md'), encoding='utf-8') as f:
            section = f.read().split('\n## Size budgets\n', 1)[1].split('\n## ', 1)[0]
        rows = [[c.strip() for c in l.strip().strip('|').split('|')] for l in section.splitlines()
                if l.startswith('| ')]
        want = [[kind, '%d KB' % SIZE_BUDGETS[kind][0], '%d KB' % SIZE_BUDGETS[kind][1], '`doc_too_big`']
                for kind in ('architecture', 'roadmap', 'proposal')]
        want += [['steps in a proposal', str(STEP_BUDGET[0]), str(STEP_BUDGET[1]), '`too_many_steps`'],
                 ['milestones in a roadmap', str(MILESTONE_BUDGET[0]), 'none', '`too_many_milestones`']]
        self.assertEqual(rows[1:], want)


# ---- the docs CI job (/bootstrap's template and examples/docs-lint-job.yml) ----------------------

def docs_job_script(path):
    """The `run: |` script of the "Lint design docs" step in PATH, dedented."""
    with open(path, encoding='utf-8') as f:
        lines = f.read().splitlines()
    i = next(k for k, l in enumerate(lines) if l.strip() == '- name: Lint design docs')
    run_line = lines[i + 1]
    assert run_line.strip() == 'run: |', run_line
    indent = len(run_line) - len(run_line.lstrip())
    body = []
    for l in lines[i + 2:]:
        if l.strip() and len(l) - len(l.lstrip()) <= indent:
            break
        body.append(l)
    pad = min(len(l) - len(l.lstrip()) for l in body if l.strip())
    return '\n'.join(l[pad:] for l in body).strip() + '\n'


class TestDocsJob(Base):
    BOOTSTRAP = os.path.join(ROOT, '.claude', 'commands', 'bootstrap.md')
    EXAMPLE = os.path.join(ROOT, 'examples', 'docs-lint-job.yml')
    MARKER = '<!-- Pipeline config written by /bootstrap -->'

    def setUp(self):
        Base.setUp(self)
        self.script = docs_job_script(self.EXAMPLE)
        shutil.copy(LINT, self.write('.claude/scripts/proposal-lint.py', ''))
        self.write('docs/design/architecture.md', arch_with_rules())
        self.write('docs/design/roadmap.md', roadmap(milestone(1, '01-p.md')))
        self.write('docs/design/01-p.md', proposal(step(1)))
        self.write('docs/design/README.md', '# Design docs\n\n1. not a step list\n')
        self.write('docs/design/brief.md', 'A brief with no heading.\n')
        self.write('CLAUDE.md', claude_md().replace('MAIN_BRANCH: main', self.MARKER + '\nMAIN_BRANCH: main'))

    def run_job(self):
        env = dict(os.environ, PROPOSALS_DIR='docs/design')
        p = subprocess.run(['bash', '-c', self.script], cwd=self.tmp, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        return p.returncode, p.stdout

    def test_bootstrap_template_runs_the_example_script(self):
        self.assertEqual(docs_job_script(self.BOOTSTRAP), self.script)
        with open(self.BOOTSTRAP, encoding='utf-8') as f:
            self.assertIn(self.MARKER, f.read())

    def test_clean_docs_pass_and_non_design_files_are_skipped(self):
        rc, out = self.run_job()
        self.assertEqual(rc, 0, out)
        for name in ('architecture.md', 'roadmap.md', '01-p.md'):
            self.assertIn('docs/design/%s: ' % name, out)
        self.assertNotIn('README.md', out)
        self.assertNotIn('brief.md', out)
        self.assertIn('"milestones"', out)

    def test_a_malformed_doc_fails(self):
        self.write('docs/design/02-q.md', proposal(step(1, deps=None)))
        rc, out = self.run_job()
        self.assertEqual(rc, 1, out)
        self.assertIn('missing_depends', out)

    def test_a_doc_over_an_error_limit_fails(self):
        self.write('docs/design/02-q.md', steps_doc(STEP_BUDGET[1] + 1))
        rc, out = self.run_job()
        self.assertEqual(rc, 1, out)
        self.assertIn('E too_many_steps', out)

    def test_a_doc_written_before_the_decision_tag_still_passes(self):
        self.write('docs/design/02-q.md', with_decisions(proposal(step(1)), record(1, 'Data store'),
                                                         record(2, 'Price', 'person')))
        rc, out = self.run_job()
        self.assertEqual(rc, 0, out)
        self.assertIn('W decision_untagged', out)
        self.assertIn('W bad_decision_tag', out)

    def test_claude_md_drift_fails_only_when_bootstrapped(self):
        with open(os.path.join(self.tmp, 'CLAUDE.md'), encoding='utf-8') as f:
            text = f.read()
        self.write('CLAUDE.md', text.replace('fixtures are synthetic', 'fixtures are real'))
        rc, out = self.run_job()
        self.assertEqual(rc, 1, out)
        self.assertIn('claude_md_drift', out)
        self.write('CLAUDE.md', text.replace(self.MARKER + '\n', '').replace('fixtures are synthetic', 'x'))
        rc, out = self.run_job()
        self.assertEqual(rc, 0, out)


# ---- ci/lint-doc-examples.py -------------------------------------------------------------------

class TestDocExamples(Base):
    def load(self):
        spec = importlib.util.spec_from_file_location('lint_doc_examples', os.path.join(ROOT, 'ci', 'lint-doc-examples.py'))
        mod = importlib.util.module_from_spec(spec)
        keep, sys.dont_write_bytecode = sys.dont_write_bytecode, True   # no __pycache__ in ci/
        try:
            spec.loader.exec_module(mod)
        finally:
            sys.dont_write_bytecode = keep
        return mod

    def test_any_info_string_opens_a_fence_and_only_md_examples_are_linted(self):
        doc = proposal(step(1))
        text = ('Intro.\n\n```sh\npython3 lint.py doc.md\n```\n\n```md\n' + doc + '```\n\n'
                '```js\n# Proposal: not an example\n```\n\n~~~yaml\n```\n~~~\n\n'
                '````markdown\n' + doc + '```\ninner fence\n```\n````\n')
        path = self.write('README.md', text)
        found = list(self.load().examples(path))
        self.assertEqual(len(found), 2)
        self.assertTrue(found[0][1].startswith('# Proposal: Test'))
        self.assertIn('inner fence', found[1][1])
        lines = text.splitlines()
        self.assertEqual([lines[n - 1] for n, _ in found], ['```md', '````markdown'])

    def test_proposals_md_examples_tag_every_record_with_each_form_once(self):
        forms = set()
        for n, (_line, text) in enumerate(self.load().examples(os.path.join(ROOT, 'docs', 'PROPOSALS.md'))):
            rc, out = self.lint(self.write('example-%d.md' % n, text), '--no-resolve-xrefs')
            self.assertEqual(rc, 0, out['errors'])
            self.assertEqual([w for w in out['warnings'] if w['code'] in DECISION_CODES], [])
            if out['kind'] != 'roadmap':
                self.assertTrue(out['decisions'], 'the %s example has no D-record' % out['kind'])
            forms.update((d['by'], bool(d['ref'])) for d in out['decisions'])
        self.assertEqual(forms, {('person', False), ('person', True), ('source', False), ('assumed', False)})

    def test_cli_reports_a_broken_example(self):
        path = self.write('doc.md', 'x\n\n```sh\nls\n```\n\n```md\n' + proposal(step(1, deps=None)) + '```\n')
        p = subprocess.run([sys.executable, os.path.join('ci', 'lint-doc-examples.py'), path], cwd=ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn('missing_depends', p.stdout)
        self.assertIn('1 example design docs, 1 with lint errors', p.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=1)

#!/usr/bin/env python3
"""Lint a pipeline design doc, derive its build lanes, or tick its steps.

A design doc is a proposal (`# Proposal: ...`, with a `## Steps` list), a roadmap
(`# Roadmap: ...`, with a `## Milestones` list) or an architecture doc
(`# Architecture: ...`, no list). The format is documented in docs/PROPOSALS.md
of claude-code-pipeline.

Usage:
  proposal-lint.py DOC [--repo DIR] [--json] [--no-resolve-xrefs] [--as PATH] [--no-size-limits]
  proposal-lint.py DOC --lanes [--root DIR] [--date YYYYMMDD] [--branch-prefix PREFIX]
                               [--remote-heads FILE] [--repo DIR] [--allow-draft]
  proposal-lint.py DOC --tick N[,N...]
  proposal-lint.py DOC --decisions
  proposal-lint.py ROADMAP --roadmap
  proposal-lint.py ARCHITECTURE --claude-md PATH [--json]

Exit status: 0 = no errors (warnings allowed); 1 = lint errors, or a --tick /
--lanes request that cannot be met; 2 = usage error or unreadable DOC.
--lanes, --roadmap, --tick and --decisions always print JSON. --claude-md lints
ARCHITECTURE and checks that CLAUDE.md at PATH carries its ## Invariants and ## Testing
bodies verbatim (claude_md_drift). --decisions only reads: it lists the D-records under
## Decisions with who decided each (the provenance tag that ends the heading), those
nobody confirmed with the person, and every line that carries a (proposed) value; it
never lints, so it exits 0 on any DOC it can read. Every mode that lints (all but --tick
and --decisions) applies the size budgets: bytes per doc kind (doc_too_big), steps per
proposal (too_many_steps) and milestones per roadmap (too_many_milestones), warning
above the soft limit and erroring above the hard one; --no-size-limits turns them off.
The script never runs git and never touches the network: it reads only the files it is
given.
"""

import argparse
import datetime
import json
import math
import os
import re
import sys
import tempfile

STEP_RE = re.compile(r'^(\d+)\. \[( |x|X)\] \*\*(.+?)\*\*(.*)$')
STEP_LIKE_RE = re.compile(r'^\d+\.\s')
SUB_RE = re.compile(r'^ {2,6}- ([A-Za-z][A-Za-z ]{0,20}?):\s*(.*)$')
CONT_RE = re.compile(r'^ {2,}\S')
H1_RE = re.compile(r'^# (Proposal|Roadmap|Architecture):\s*(.*?)\s*$')
H2_RE = re.compile(r'^## (.+?)\s*$')
HEADER_RE = re.compile(r'^(Status|Source|Architecture|Roadmap):\s*(.*?)\s*$')
FENCE_RE = re.compile(r'^\s*(```|~~~)')
LANE_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,30}$')
GATE_RE = re.compile(r'^([A-Za-z]+)\s*(?:—|–|--|-|:)\s*(.+)$')
FILE_RE = re.compile(r'`([^`]+)`(\s*\(new\))?')
XREF_RE = re.compile(r'^(\S+?\.md)#(\d+)$')
SOURCE_REF_RE = re.compile(r'(\S+?\.md)#(\d+)')
COMMENT_RE = re.compile(r'<!--.*?-->')
DECISION_RE = re.compile(r'^### D(\d+):\s*(.*?)\s*$', re.ASCII)
# A heading under ## Decisions that numbers a decision without being "### D<N>: ...": "### D1 — Licence",
# "### D2. Price", "### Decision 3: Hosting", "#### D4: Deeper", "### d5: Lowercase", a number in non-ASCII digits.
DECISION_LIKE_RE = re.compile(r'^\s{0,3}#{3,4}\s*((?:D|Decision)\s*(\d+)\b.*?)\s*$', re.I)
PAREN_RE = re.compile(r'^(.*?)\s*\(([^()]*)\)$')      # a heading's trailing parenthetical
PERSON_TAG_RE = re.compile(r'^person\s*,\s*(\d{4}-\d{2}-\d{2})(?:\s*,\s*([^\s,()]+))?$', re.ASCII)
TAG_WORD_RE = re.compile(r'^(person|source|assumed)\b', re.I)

GATE_KINDS = ('research', 'decision', 'ops', 'release')
KEYS = {'files': 'files', 'depends on': 'depends', 'acceptance': 'acceptance',
        'lane': 'lane', 'human gate': 'gate', 'proposal': 'proposal', 'outcome': 'outcome'}
STATUSES = ('draft', 'accepted', 'in-progress', 'done')
BUILDABLE_STATUSES = ('accepted', 'in-progress')
PROPOSAL_SECTIONS = ('Context', 'Goals', 'Non-goals', 'Current state', 'Design', 'Decisions',
                     'Security and privacy', 'Rollout and operations', 'Risks and open questions',
                     'Steps', 'Out of scope')
ARCH_SECTIONS = ('Context', 'System overview', 'Components', 'Data model', 'Decisions',
                 'Security and privacy', 'Invariants', 'Repository layout', 'Quality gates',
                 'Environments and deployment', 'Testing', 'Risks and open questions')
CLAUDE_MD_SECTIONS = ('Invariants', 'Testing')   # /bootstrap copies these bodies verbatim
# Who decided a D-record (docs/PROPOSALS.md, Who decided): the closed tags that end its heading.
DECISION_KEYS = ('id', 'n', 'title', 'line', 'by', 'date', 'ref')
TAG_FORMS = '(person, YYYY-MM-DD), (person, YYYY-MM-DD, <ref>), (source) or (assumed)'
BAD_TAG_HINTS = {
    'person': 'person is lowercase and is followed by the date the person said it, a real YYYY-MM-DD, then at '
              'most one ref with no space in it',
    'source': 'source stands alone, in lowercase',
    'assumed': 'assumed stands alone, in lowercase',
}
PROPOSED_MARK = '(proposed'
PROPOSED_TEXT_MAX = 200
MAX_FILES = 8
MAX_SENTENCES = 7

# Size budgets (docs/PROPOSALS.md, Size budgets): (warning above, error above), None = no error. An agent that builds
# a milestone reads the architecture, the roadmap and its proposal together: ~112 KB, ~28k tokens, at the warning limits.
KB = 1024
SIZE_BUDGETS = {'architecture': (48 * KB, 96 * KB), 'roadmap': (24 * KB, 48 * KB), 'proposal': (40 * KB, 80 * KB)}
LIST_BUDGETS = {'proposal': ('Steps', 'steps', 'step', 'too_many_steps', 12, 20),
                'roadmap': ('Milestones', 'milestones', 'milestone', 'too_many_milestones', 20, None)}
SPLIT_PROPOSAL = ('keep the steps that ship first and move the rest to a new milestone after the last one in the roadmap, '
                  'with its own proposal (for a concern, to a follow-up proposal)')
SIZE_ADVICE = {
    'architecture': 'leave each milestone\'s detail (its endpoints, columns, screens, step-level rationale) to the '
                    'proposal that builds it, keep what binds every milestone, and link research instead of quoting it',
    'roadmap': 'cut each milestone to its title, one or two sentences, Depends on and Acceptance (its design belongs '
               'in the architecture or its proposal), and merge milestones that ship together',
    'proposal': 'move detail out (cite the architecture instead of restating it, and keep each step to one to three '
                'sentences), or ' + SPLIT_PROPOSAL,
}
LIST_ADVICE = {
    'proposal': SPLIT_PROPOSAL,
    'roadmap': 'merge milestones that ship together, and keep the milestones after the go/no-go coarse until its '
               'Outcome is recorded',
}


class Doc(object):
    def __init__(self, path):
        self.path = path
        self.ref_dir = os.path.dirname(path)   # where <file>.md#N and Source: refs resolve from (--as moves it)
        self.kind = None
        self.title = ''
        self.size = 0               # bytes, as the file is written (UTF-8, its own line endings)
        self.header = {}
        self.sections = []          # (name, line)
        self.steps = []
        self.decisions = []         # D-records under ## Decisions (architecture and proposal)
        self.proposed = []          # {line, text} of every line outside a code fence that has "(proposed"
        self.errors = []
        self.warnings = []

    def err(self, line, code, msg, path=None):
        e = {'line': line, 'code': code, 'message': msg}
        if path is not None:
            e['path'] = path    # the error is in another file than DOC (--claude-md)
        self.errors.append(e)

    def warn(self, line, code, msg):
        self.warnings.append({'line': line, 'code': code, 'message': msg})

    def step(self, n):
        for s in self.steps:
            if s['n'] == n:
                return s
        return None

    def has_section(self, name):
        return any(s[0].lower() == name.lower() for s in self.sections)


def read_lines(path):
    # newline='' keeps each line's own ending (LF or CRLF), so --tick rewrites nothing but the checkbox
    with open(path, 'r', encoding='utf-8', newline='') as f:
        return f.readlines()


def parse(path):
    """Parse DOC into a Doc. Raises OSError when the file cannot be read."""
    doc = Doc(path)
    lines = read_lines(path)
    doc.size = sum(len(raw.encode('utf-8')) for raw in lines)
    in_fence = False
    section = None
    cur = None
    last_key = None
    seen_h2 = False
    for i, raw in enumerate(lines, 1):
        line = raw.rstrip('\r\n')
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if PROPOSED_MARK in line:
            doc.proposed.append({'line': i, 'text': line.strip()[:PROPOSED_TEXT_MAX]})
        if doc.kind is None and line.startswith('# '):
            m = H1_RE.match(line)
            if m:
                doc.kind = m.group(1).lower()
                doc.title = m.group(2)
            else:
                doc.kind = 'unknown'
                doc.title = line[2:].strip()
            continue
        m = H2_RE.match(line)
        if m:
            seen_h2 = True
            section = m.group(1)
            doc.sections.append((section, i))
            cur = None
            last_key = None
            continue
        if not seen_h2:
            m = HEADER_RE.match(line)
            if m:
                doc.header[m.group(1).lower()] = COMMENT_RE.sub('', m.group(2)).strip()
            continue
        if section is not None and section.lower() == 'decisions':
            heading = COMMENT_RE.sub('', line)
            m = DECISION_RE.match(heading)
            if m:
                doc.decisions.append(decision(i, int(m.group(1)), m.group(2)))
            else:
                m = DECISION_LIKE_RE.match(heading)
                if m:
                    doc.decisions.append(malformed_decision(i, int(m.group(2)), m.group(1)))
            continue
        if section is None or section.lower() not in ('steps', 'milestones'):
            continue
        m = STEP_RE.match(line)
        if m:
            cur = {'n': int(m.group(1)), 'done': m.group(2) != ' ', 'title': m.group(3).strip(),
                   'line': i, 'description': m.group(4).strip(), 'files': [], 'depends': [],
                   'acceptance': '', 'lane': None, 'human_gate': None, 'proposal': None,
                   'outcome': '', 'has_depends': False, '_keys': {}}
            doc.steps.append(cur)
            last_key = None
            continue
        if STEP_LIKE_RE.match(line):
            doc.err(i, 'malformed_step', 'a numbered line in the step list must read '
                    '"N. [ ] **Title.** description" (checkbox, then a bold title): %r' % line[:80])
            cur = None
            continue
        if cur is None:
            continue
        m = SUB_RE.match(line)
        if m and m.group(1).strip().lower() in KEYS:
            key = KEYS[m.group(1).strip().lower()]
            if key in cur['_keys']:
                doc.err(i, 'duplicate_key', 'step %d has a second "%s:" line' % (cur['n'], m.group(1).strip()))
            cur['_keys'][key] = [i, m.group(2).strip()]
            last_key = key
            continue
        if m and len(m.group(1).split()) <= 3 and not line.strip().startswith('- `'):
            doc.warn(i, 'unknown_key', 'step %d: unknown sub-bullet key "%s:" (known: Files, Depends on, '
                     'Acceptance, Lane, Human gate, Outcome%s)' % (cur['n'], m.group(1).strip(),
                                                         ', Proposal' if doc.kind == 'roadmap' else ''))
            last_key = None
            continue
        if CONT_RE.match(line):
            text = line.strip()
            if last_key and not text.startswith('- '):
                cur['_keys'][last_key][1] = (cur['_keys'][last_key][1] + ' ' + text).strip()
            else:
                cur['description'] = (cur['description'] + ' ' + text).strip()
                last_key = None
            continue
        if line.strip():
            cur = None
            last_key = None
    if doc.kind is None:
        doc.kind = 'unknown'
    if doc.kind == 'roadmap':
        doc.decisions = []      # a roadmap records no decisions: they live in the architecture and the proposals
    for s in doc.steps:
        interpret_keys(doc, s)
    return doc


def valid_date(text):
    try:
        datetime.date(*[int(p) for p in text.split('-')])
    except ValueError:
        return False
    return True


def decision(line, n, text):
    """One D-record from its heading text (what follows "### D<N>:"). The trailing parenthetical is its
    provenance tag when it is one of the closed forms (TAG_FORMS); the title is the text without it. Any other
    trailing parenthetical stays in the title and the record is untagged; one that starts like a tag without
    being one is also kept in '_bad_tag', for bad_decision_tag."""
    d = {'id': 'D%d' % n, 'n': n, 'title': text, 'line': line, 'by': '', 'date': '', 'ref': ''}
    m = PAREN_RE.match(text)
    if not m:
        return d
    tag = m.group(2).strip()
    person = PERSON_TAG_RE.match(tag)
    if person and valid_date(person.group(1)):
        d.update(by='person', date=person.group(1), ref=person.group(2) or '')
    elif tag in ('source', 'assumed'):
        d['by'] = tag
    else:
        if TAG_WORD_RE.match(tag):
            d['_bad_tag'] = tag
        return d
    d['title'] = m.group(1)
    return d


def malformed_decision(line, n, text):
    """A heading under ## Decisions that numbers a decision but is not written "### D<N>: <title>". It is still a
    record, so it is listed (and counts as unconfirmed): its title is the heading's whole text, and no tag is read
    from it. '_bad_heading' marks it for bad_decision_heading."""
    return {'id': 'D%d' % n, 'n': n, 'title': text, 'line': line, 'by': '', 'date': '', 'ref': '',
            '_bad_heading': True}


def public_decision(d):
    return dict((k, d[k]) for k in DECISION_KEYS)


def interpret_keys(doc, s):
    keys = s.pop('_keys')
    if 'files' in keys:
        line, value = keys['files']
        found = FILE_RE.findall(value)
        if not found and value:
            doc.err(line, 'files_format', 'step %d: list files as backticked paths, '
                    'e.g. `src/a.ts` (new), `src/b.ts`' % s['n'])
        s['files'] = [{'path': p.strip()[2:] if p.strip().startswith('./') else p.strip(),
                       'new': bool(new)} for p, new in found]
        s['_files_line'] = line
    if 'outcome' in keys:
        s['outcome'] = keys['outcome'][1]
    if 'depends' in keys:
        line, value = keys['depends']
        s['_depends_line'] = line
        s['has_depends'] = True
        v = COMMENT_RE.sub('', value).strip().rstrip('.')
        if not v:
            s['has_depends'] = False
        elif v.lower() not in ('none', 'nothing', '-'):
            for tok in [t.strip() for t in v.split(',') if t.strip()]:
                tok = re.sub(r'^(steps?|milestones?)\s+', '', tok, flags=re.I)
                if tok.isdigit():
                    s['depends'].append({'doc': None, 'n': int(tok)})
                    continue
                m = XREF_RE.match(tok)
                if m:
                    s['depends'].append({'doc': m.group(1), 'n': int(m.group(2))})
                    continue
                doc.err(line, 'bad_dependency', 'step %d: "Depends on:" takes "none" or comma-separated '
                        'step numbers or <file>.md#N refs; got %r' % (s['n'], tok))
    if 'acceptance' in keys:
        s['acceptance'] = keys['acceptance'][1]
    if 'lane' in keys:
        line, value = keys['lane']
        value = value.strip().strip('`')
        if not LANE_RE.match(value):
            doc.err(line, 'bad_lane', 'step %d: lane key %r must match [a-z0-9][a-z0-9-]{0,30}' % (s['n'], value))
        s['lane'] = value
    if 'gate' in keys:
        line, value = keys['gate']
        m = GATE_RE.match(value)
        if not m or m.group(1).lower() not in GATE_KINDS:
            doc.err(line, 'bad_gate', 'step %d: write "Human gate: <%s> — <what a person does>"; got %r'
                    % (s['n'], '|'.join(GATE_KINDS), value[:60]))
            s['human_gate'] = {'kind': (m.group(1).lower() if m else 'unknown'), 'text': (m.group(2) if m else value)}
        else:
            s['human_gate'] = {'kind': m.group(1).lower(), 'text': m.group(2).strip()}
    if 'proposal' in keys:
        line, value = keys['proposal']
        m = re.search(r'`?([^`\s]+\.md)`?', value)
        if m:
            s['proposal'] = m.group(1)
        elif value.strip().lower() not in ('', 'none'):
            doc.err(line, 'bad_proposal', 'milestone %d: "Proposal:" takes a file name ending in .md' % s['n'])


def sentences(text):
    return len([p for p in re.split(r'(?<=[.!?])\s+', text.strip()) if p.strip()])


def check(doc, repo=None, resolve_xrefs=True, cache=None, size_limits=True):
    """Validate a parsed doc in place."""
    if doc.kind == 'unknown':
        doc.warn(1, 'no_kind', 'the first heading should be "# Proposal: <title>", "# Roadmap: <title>" or '
                 '"# Architecture: <title>"; treating this as a proposal')
        doc.kind = 'proposal'
    if size_limits:
        check_budgets(doc)
    status = doc.header.get('status', '')
    if not status:
        doc.warn(1, 'missing_status', 'add a "Status: draft|accepted|in-progress|done" line under the title '
                 '(authors write draft; a person sets accepted)')
    elif status.lower() not in STATUSES:
        doc.err(1, 'bad_status', 'Status must be one of %s; got %r' % (', '.join(STATUSES), status))
    check_decisions(doc)
    if doc.kind == 'architecture':
        for name in ARCH_SECTIONS:
            if not doc.has_section(name):
                doc.err(1, 'missing_section', 'architecture docs need a "## %s" section' % name)
        if doc.steps:
            doc.warn(doc.steps[0]['line'], 'unexpected_steps', 'an architecture doc has no step list; '
                     'put the work in proposals and the order in the roadmap')
        return
    list_name = 'Milestones' if doc.kind == 'roadmap' else 'Steps'
    if not doc.has_section(list_name):
        doc.err(1, 'missing_section', '%s docs need a "## %s" list' % (doc.kind, list_name))
    elif not doc.steps:
        doc.err(dict((n.lower(), l) for n, l in doc.sections)[list_name.lower()], 'no_steps',
                'the "## %s" section has no "N. [ ] **Title.**" items' % list_name)
    if doc.kind == 'proposal':
        for name in PROPOSAL_SECTIONS:
            if not doc.has_section(name):
                doc.warn(1, 'missing_section', 'proposals should have a "## %s" section' % name)
    seen = {}
    for idx, s in enumerate(doc.steps, 1):
        n = s['n']
        if n in seen:
            doc.err(s['line'], 'duplicate_step', 'step %d is numbered twice (also line %d)' % (n, seen[n]))
        seen.setdefault(n, s['line'])
        if n != idx:
            doc.err(s['line'], 'step_numbering', 'steps are numbered 1, 2, 3, ... in document order; '
                    'expected %d, got %d' % (idx, n))
    by_n = dict((s['n'], s) for s in doc.steps)
    for s in doc.steps:
        n, gate = s['n'], s['human_gate']
        what = 'milestone' if doc.kind == 'roadmap' else 'step'
        if doc.kind == 'roadmap':
            if gate and s['proposal']:
                doc.err(s['line'], 'gate_with_proposal', 'milestone %d is human-gated and names a proposal; '
                        'a person does a gated milestone, the pipeline builds a proposal' % n)
            if not gate and not s['proposal']:
                doc.err(s['line'], 'missing_proposal', 'milestone %d needs "Proposal: <file>.md" or '
                        '"Human gate: <kind> — <text>"' % n)
            if s['files']:
                doc.err(s.get('_files_line', s['line']), 'files_in_roadmap', 'milestone %d lists Files; '
                        'files belong in the proposal\'s steps' % n)
        else:
            if s['proposal']:
                doc.warn(s['line'], 'proposal_in_steps', 'step %d has a "Proposal:" key; only roadmap milestones do' % n)
            if gate and s['files']:
                doc.err(s.get('_files_line', s['line']), 'gate_with_files', 'step %d is human-gated and lists Files; '
                        'a gated step is done by a person, so split the code into its own step' % n)
            if not gate and not s['files']:
                doc.err(s['line'], 'missing_files', 'step %d needs "Files: `path` (new), `path`" '
                        '(or a "Human gate:" if a person does it)' % n)
            if gate and s['lane']:
                doc.err(s['line'], 'gate_in_lane', 'step %d is human-gated and has a Lane; lanes are built by '
                        'the pipeline' % n)
            if len(s['files']) > MAX_FILES:
                doc.warn(s['line'], 'step_too_big', 'step %d touches %d files; one step should fit one '
                         'focused PR' % (n, len(s['files'])))
            if sentences(s['description']) > MAX_SENTENCES:
                doc.warn(s['line'], 'step_too_big', 'step %d has a long description; one step should fit '
                         'one focused PR' % n)
        if not s['has_depends']:
            doc.err(s['line'], 'missing_depends', '%s %d needs "Depends on:" (write "none" when it depends on '
                    'nothing, so independence from every human gate is explicit)' % (what, n))
        if s['outcome'] and not gate:
            doc.warn(s['line'], 'outcome_on_code_step', '%s %d: "Outcome:" records what a human gate found; '
                     'a code step has none' % (what, n))
        if gate and s['done'] and not s['outcome'] and gate['kind'] in ('research', 'decision'):
            doc.warn(s['line'], 'gate_without_outcome', '%s %d is a ticked %s gate with no "Outcome:"; record what '
                     'it found or decided so the steps that depend on it can follow it' % (what, n, gate['kind']))
        if not s['acceptance']:
            if gate:
                doc.warn(s['line'], 'missing_acceptance', '%s %d: say what evidence closes this gate in '
                         '"Acceptance:"' % (what, n))
            else:
                doc.err(s['line'], 'missing_acceptance', '%s %d needs "Acceptance:" criteria' % (what, n))
        for d in s['depends']:
            line = s.get('_depends_line', s['line'])
            if d['doc'] is None:
                if d['n'] == n:
                    doc.err(line, 'self_dependency', '%s %d depends on itself' % (what, n))
                elif d['n'] not in by_n:
                    doc.err(line, 'unknown_dependency', '%s %d depends on %d, which does not exist' % (what, n, d['n']))
                elif d['n'] > n:
                    doc.err(line, 'forward_dependency', '%s %d depends on later %s %d; list %ss in build order'
                            % (what, n, what, d['n'], what))
                elif s['done'] and not by_n[d['n']]['done']:
                    doc.err(line, 'done_before_dependency', '%s %d is ticked but %s %d it depends on is not'
                            % (what, n, what, d['n']))
            elif resolve_xrefs:
                other = load_ref(doc, d['doc'], cache)
                if other is None:
                    doc.warn(line, 'xref_unreadable', '%s %d depends on %s#%d, which cannot be read yet'
                             % (what, n, d['doc'], d['n']))
                elif other.step(d['n']) is None:
                    doc.err(line, 'xref_missing_step', '%s %d depends on %s#%d, which has no step %d'
                            % (what, n, d['doc'], d['n'], d['n']))
    if doc.kind == 'proposal' and resolve_xrefs:
        state, _r, _m, why = source_milestone(doc, cache if cache is not None else {})
        if state == 'unresolved':
            doc.warn(1, 'source_unresolved', '%s; until it resolves, --lanes blocks every lane '
                     '(milestone_unresolved)' % why)
        check_lanes_shape(doc)
        if repo:
            check_repo_files(doc, repo)
    if doc.kind == 'roadmap':
        base = doc.ref_dir
        for s in doc.steps:
            if s['proposal'] and not os.path.isfile(os.path.join(base, s['proposal'])) and not s['done']:
                doc.warn(s['line'], 'proposal_not_written', 'milestone %d: %s does not exist yet'
                         % (s['n'], s['proposal']))


def check_decisions(doc):
    """decision_untagged, once per doc at its first untagged D-record; bad_decision_tag per record whose trailing
    parenthetical starts like a tag without being one; bad_decision_heading per heading that numbers a decision
    without being "### D<N>: <title>"; duplicate_decision per D-number used again (docs/PROPOSALS.md, Who
    decided). All are warnings, so a doc written before the tag keeps passing."""
    untagged = [d['id'] for d in doc.decisions if not d['by'] and '_bad_tag' not in d and '_bad_heading' not in d]
    reported = False
    seen = {}
    for d in doc.decisions:
        if d['n'] in seen:
            doc.warn(d['line'], 'duplicate_decision', '%s is numbered twice (also line %d); give each D-record its own '
                     'number, because answers and reviews name a record by it' % (d['id'], seen[d['n']]))
        seen.setdefault(d['n'], d['line'])
        if '_bad_heading' in d:
            doc.warn(d['line'], 'bad_decision_heading', '%s: "%s" is not written as a D-record, so no provenance tag is '
                     'read from it and the record counts as unconfirmed; write the heading as "### D<N>: <title> (<tag>)", '
                     'the tag being %s' % (d['id'], d['title'][:80], TAG_FORMS))
        elif '_bad_tag' in d:
            word = TAG_WORD_RE.match(d['_bad_tag']).group(1).lower()
            doc.warn(d['line'], 'bad_decision_tag', '%s: "(%s)" is not a provenance tag (%s); end the heading '
                     'with %s' % (d['id'], d['_bad_tag'], BAD_TAG_HINTS[word], TAG_FORMS))
        elif not d['by'] and not reported:
            reported = True
            doc.warn(d['line'], 'decision_untagged', '%s %s no provenance tag; end each D-record heading with who '
                     'decided it: %s' % (', '.join(untagged), 'has' if len(untagged) == 1 else 'have', TAG_FORMS))


def kb(size):
    """SIZE in KB, rounded up to one decimal, so a doc one byte over a limit never reads as at it."""
    return '%.1f KB' % (math.ceil(size * 10.0 / KB) / 10.0)


def check_budgets(doc):
    """doc_too_big on the file's bytes for its kind, and too_many_steps / too_many_milestones on its list:
    a warning above the soft limit, an error above the hard one (docs/PROPOSALS.md, Size budgets)."""
    soft, hard = SIZE_BUDGETS[doc.kind]
    if doc.size > soft:
        what = 'this %s is %s' % ('architecture doc' if doc.kind == 'architecture' else doc.kind, kb(doc.size))
        if doc.size > hard:
            doc.err(1, 'doc_too_big', '%s, over the %d KB error limit: %s' % (what, hard // KB, SIZE_ADVICE[doc.kind]))
        else:
            doc.warn(1, 'doc_too_big', '%s, over the %d KB warning limit (error above %d KB): %s'
                     % (what, soft // KB, hard // KB, SIZE_ADVICE[doc.kind]))
    if doc.kind not in LIST_BUDGETS:
        return
    section, plural, singular, code, soft, hard = LIST_BUDGETS[doc.kind]
    n = len(doc.steps)      # every item counts: ticked or not, gates included
    if n <= soft:
        return
    line = dict((name.lower(), l) for name, l in doc.sections).get(section.lower(), doc.steps[0]['line'])
    what = 'this %s has %d %s' % (doc.kind, n, plural)
    if hard is not None and n > hard:
        doc.err(line, code, '%s, over the %d-%s error limit: %s' % (what, hard, singular, LIST_ADVICE[doc.kind]))
    else:
        doc.warn(line, code, '%s, over the %d-%s warning limit%s: %s'
                 % (what, soft, singular, ' (error above %d)' % hard if hard is not None else '',
                    LIST_ADVICE[doc.kind]))


def check_lanes_shape(doc):
    lanes = {}
    for s in doc.steps:
        if s['lane']:
            lanes.setdefault(s['lane'], []).append(s)
    for key, steps in lanes.items():
        if len(set(x['done'] for x in steps)) > 1:
            doc.warn(steps[0]['line'], 'lane_mixed', 'lane %s mixes ticked and unticked steps' % key)


def check_repo_files(doc, repo):
    created = set()
    for s in doc.steps:
        for f in s['files']:
            exists = os.path.exists(os.path.join(repo, f['path']))
            if f['new']:
                if exists and not s['done']:
                    doc.warn(s.get('_files_line', s['line']), 'new_file_exists',
                             'step %d marks %s (new) but it already exists' % (s['n'], f['path']))
                created.add(f['path'])
            elif not exists and f['path'] not in created and not s['done']:
                doc.warn(s.get('_files_line', s['line']), 'file_not_found',
                         'step %d edits %s, which does not exist and no earlier step creates it '
                         '(mark it (new) if this step creates it)' % (s['n'], f['path']))


def load_ref(doc, rel, cache):
    path = os.path.normpath(os.path.join(doc.ref_dir, rel))
    if cache is not None and path in cache:
        return cache[path]
    try:
        other = parse(path)
    except (OSError, UnicodeDecodeError):
        other = None
    if cache is not None:
        cache[path] = other
    return other


def public_step(s):
    out = dict((k, v) for k, v in s.items() if not k.startswith('_'))
    return out


def slugify(text):
    s = re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
    return re.sub(r'-+', '-', s) or 'doc'


# ---- lanes ------------------------------------------------------------------------------------

def milestone_satisfied(roadmap, m, cache):
    if m['done']:
        return True
    if m['human_gate'] or not m['proposal']:
        return False
    prop = load_ref(roadmap, m['proposal'], cache)
    return bool(prop and prop.steps and all(s['done'] for s in prop.steps))


def source_milestone(doc, cache):
    """Resolve the doc's `Source: <roadmap>.md#N`. Returns (state, roadmap, milestone, why):
    state 'none' (the source is not a roadmap milestone), 'ok', or 'unresolved' (it names a roadmap or a
    milestone that cannot be read). Unresolved fails closed: lanes stay blocked, so a typo never skips a gate."""
    src = doc.header.get('source', '')
    m = SOURCE_REF_RE.search(src)
    if not m:
        if re.search(r'roadmap|milestone|#\d', src, re.I):
            return 'unresolved', None, None, 'Source: %r names a roadmap milestone but not as <file>.md#N' % src
        return 'none', None, None, ''
    roadmap = load_ref(doc, m.group(1), cache)
    if roadmap is None:
        return 'unresolved', None, None, 'Source: %s cannot be read' % m.group(1)
    if roadmap.kind != 'roadmap':
        return 'unresolved', None, None, 'Source: %s is a %s, not a roadmap' % (m.group(1), roadmap.kind)
    ms = roadmap.step(int(m.group(2)))
    if ms is None:
        return 'unresolved', roadmap, None, 'Source: %s has no milestone %s' % (m.group(1), m.group(2))
    return 'ok', roadmap, ms, ''


def milestone_wait(doc, cache):
    """Pending milestones the doc's roadmap milestone still waits on (via its Source: roadmap.md#N)."""
    state, roadmap, ms, why = source_milestone(doc, cache)
    if state == 'none':
        return []
    if state == 'unresolved':
        return [{'doc': None, 'n': 0, 'title': why, 'reason': 'milestone_unresolved'}]
    waits = []
    rel = os.path.relpath(roadmap.path, doc.ref_dir)
    for d in ms['depends']:
        if d['doc'] is not None:
            continue
        dep = roadmap.step(d['n'])
        if dep is not None and not milestone_satisfied(roadmap, dep, cache):
            waits.append({'doc': rel, 'n': dep['n'], 'title': dep['title'],
                          'reason': 'milestone_gate' if dep['human_gate'] else 'milestone_pending'})
    return waits


def derive_lanes(doc, args, cache):
    slug = slugify(os.path.splitext(os.path.basename(doc.path))[0])
    prefix = args.branch_prefix
    date = args.date or 'undated'
    by_n = dict((s['n'], s) for s in doc.steps)
    lanes, order = {}, []
    for s in doc.steps:
        if s['done'] or s['human_gate']:
            continue
        key = s['lane'] or 's%d' % s['n']
        if key not in lanes:
            lanes[key] = {'key': key, 'steps': [], 'titles': [], 'files': [], 'min': s['n'],
                          'waiting_on': [], 'after': set()}
            order.append(key)
        lane = lanes[key]
        lane['steps'].append(s['n'])
        lane['titles'].append(s['title'])
        for f in s['files']:
            if f['path'] not in lane['files']:
                lane['files'].append(f['path'])
    lane_of = {}
    for key in order:
        for n in lanes[key]['steps']:
            lane_of[n] = key
    gate_wait = milestone_wait(doc, cache)
    status = doc.header.get('status', '').lower()
    if status not in BUILDABLE_STATUSES and not args.allow_draft:
        gate_wait = gate_wait + [{'doc': None, 'n': 0, 'title': 'Status: %s' % (status or 'missing'),
                                  'reason': 'proposal_not_accepted'}]
    for key in order:
        lane = lanes[key]
        lane['waiting_on'].extend(gate_wait)
        for n in lane['steps']:
            for d in by_n[n]['depends']:
                if d['doc'] is None:
                    dep = by_n.get(d['n'])
                    if dep is None or dep['done']:
                        continue
                    if dep['human_gate']:
                        lane['waiting_on'].append({'doc': None, 'n': dep['n'], 'title': dep['title'],
                                                   'reason': 'human_gate'})
                    elif lane_of[dep['n']] != key:
                        lane['after'].add(lane_of[dep['n']])
                else:
                    other = load_ref(doc, d['doc'], cache)
                    dep = other.step(d['n']) if other else None
                    if dep is None or not dep['done']:
                        lane['waiting_on'].append({'doc': d['doc'], 'n': d['n'],
                                                   'title': dep['title'] if dep else '',
                                                   'reason': 'pending_external'})
    for i, k in enumerate(order):
        for l in order[i + 1:]:
            a, b = lanes[k], lanes[l]
            first, second = (a, b) if a['min'] < b['min'] else (b, a)
            if set(a['files']) & set(b['files']):
                second['after'].add(first['key'])
    # Cycle check over every lane, blocked or not, so a draft or a gated doc reports it before acceptance.
    indeg_all = dict((k, len([p for p in lanes[k]['after'] if p in lanes])) for k in order)
    ready_all = [k for k in order if indeg_all[k] == 0]
    seen_all = []
    while ready_all:
        k = ready_all.pop(0)
        seen_all.append(k)
        for l in order:
            if k in lanes[l]['after'] and l not in seen_all and l not in ready_all:
                indeg_all[l] -= 1
                if indeg_all[l] == 0:
                    ready_all.append(l)
    if len(seen_all) != len(order):
        stuck = [k for k in order if k not in seen_all]
        return {'doc': doc.path, 'slug': slug, 'warnings': doc.warnings, 'chains': [], 'blocked': [],
                'human_gates_pending': [], 'milestone_waits': [], 'done': [s['n'] for s in doc.steps if s['done']],
                'errors': [{'line': by_n[lanes[stuck[0]]['steps'][0]]['line'], 'code': 'lane_cycle',
                            'message': 'lanes %s depend on each other in a cycle (check Lane: groups against '
                                       'Depends on and shared Files)' % ', '.join(stuck)}]}
    blocked = set(k for k in order if lanes[k]['waiting_on'])
    changed = True
    while changed:
        changed = False
        for k in order:
            if k in blocked:
                continue
            bad = [p for p in lanes[k]['after'] if p in blocked]
            if bad:
                for p in sorted(bad):
                    for n in lanes[p]['steps']:
                        lanes[k]['waiting_on'].append({'doc': None, 'n': n, 'title': by_n[n]['title'],
                                                       'reason': 'blocked_lane'})
                blocked.add(k)
                changed = True
    live = [k for k in order if k not in blocked]
    # connected components over the live lanes
    adj = dict((k, set()) for k in live)
    for k in live:
        for p in lanes[k]['after']:
            if p in adj:
                adj[k].add(p)
                adj[p].add(k)
    seen, comps = set(), []
    for k in live:
        if k in seen:
            continue
        stack, comp = [k], []
        seen.add(k)
        while stack:
            x = stack.pop()
            comp.append(x)
            for y in adj[x]:
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        comps.append(comp)
    heads = parse_heads(args.remote_heads) if args.remote_heads else None
    chains, errors = [], []
    for comp in comps:
        members = set(comp)
        indeg = dict((k, len([p for p in lanes[k]['after'] if p in members])) for k in comp)
        ready = sorted([k for k in comp if indeg[k] == 0], key=lambda k: lanes[k]['min'])
        ordered = []
        while ready:
            k = ready.pop(0)
            ordered.append(k)
            for l in comp:
                if k in lanes[l]['after'] and l not in ordered:
                    indeg[l] -= 1
                    if indeg[l] == 0:
                        ready.append(l)
            ready.sort(key=lambda x: lanes[x]['min'])
        if len(ordered) != len(comp):
            stuck = sorted(set(comp) - set(ordered))
            errors.append({'line': by_n[lanes[stuck[0]]['steps'][0]]['line'], 'code': 'lane_cycle',
                           'message': 'lanes %s depend on each other in a cycle (check Lane: groups against '
                                      'Depends on and shared Files)' % ', '.join(stuck)})
            continue
        chain_lanes, bases = [], []
        for k in ordered:
            lane = lanes[k]
            stem = '%s%s-%s-' % (prefix, slug, k)
            branch = stem + date
            built = False
            if heads is not None:
                # the rest must be a date, not another lane's key: lane `api` must not match `api-v2-...`
                matches = sorted(h for h in heads if h.startswith(stem) and h[len(stem):] and
                                 (h[len(stem):] == date or not re.search(r'[-/]', h[len(stem):])))
                if matches:
                    branch, built = matches[-1], True
            steps = lane['steps']
            label = 'Step %d' % steps[0] if len(steps) == 1 else 'Steps %s' % ', '.join(str(n) for n in steps)
            chain_lanes.append({
                'key': k, 'steps': steps, 'titles': lane['titles'],
                'concern': '%s of %s: %s. Implement exactly %s — %s description, Files and Acceptance '
                           'criteria — as one increment.' % (
                               label, doc.path, '; '.join(t.rstrip('.') for t in lane['titles']),
                               'this step' if len(steps) == 1 else 'these steps',
                               'its' if len(steps) == 1 else 'their'),
                'branch': branch,
                'dir': os.path.join(args.root, '%s-%s' % (slug, k)) if args.root else None,
                'bases': list(bases), 'files': lane['files'], 'already_built': built,
            })
            bases.append(branch)
        chains.append({'key': ordered[0], 'lanes': chain_lanes})
    blocked_out = []
    for k in order:
        if k in blocked:
            uniq, seen_w = [], set()
            for w in lanes[k]['waiting_on']:
                sig = (w['doc'], w['n'], w['reason'])
                if sig not in seen_w:
                    seen_w.add(sig)
                    uniq.append(w)
            blocked_out.append({'lane': k, 'steps': lanes[k]['steps'], 'waiting_on': uniq})
    gates = []
    for s in doc.steps:
        if not s['human_gate'] or s['done']:
            continue
        waits = []
        for d in s['depends']:
            if d['doc'] is None:
                dep = by_n.get(d['n'])
                if dep is not None and not dep['done']:
                    waits.append({'doc': None, 'n': d['n']})
            else:
                other = load_ref(doc, d['doc'], cache)
                dep = other.step(d['n']) if other else None
                if dep is None or not dep['done']:
                    waits.append({'doc': d['doc'], 'n': d['n']})
        gates.append({'n': s['n'], 'title': s['title'], 'kind': s['human_gate']['kind'],
                      'text': s['human_gate']['text'], 'ready': not waits, 'waiting_on': waits})
    return {'doc': doc.path, 'slug': slug, 'errors': errors, 'warnings': doc.warnings,
            'chains': chains, 'blocked': blocked_out, 'human_gates_pending': gates,
            'milestone_waits': gate_wait,
            'done': [s['n'] for s in doc.steps if s['done']]}


def parse_heads(path):
    heads = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            parts = line.strip().split()
            ref = parts[-1] if parts else ''
            if ref.startswith('refs/heads/'):
                heads.append(ref[len('refs/heads/'):])
    return heads


# ---- roadmap progress -------------------------------------------------------------------------

def roadmap_report(doc, cache):
    out = []
    by_n = dict((s['n'], s) for s in doc.steps)
    sat = {}
    for m in doc.steps:
        entry = {'n': m['n'], 'title': m['title'], 'done': m['done'], 'human_gate': m['human_gate'],
                 'proposal': m['proposal'], 'proposal_exists': False, 'progress': None, 'complete': False,
                 'depends': [d['n'] for d in m['depends'] if d['doc'] is None]}
        if m['proposal']:
            prop = load_ref(doc, m['proposal'], cache)
            if prop is not None:
                code = [s for s in prop.steps if not s['human_gate']]
                entry['proposal_exists'] = True
                entry['progress'] = {'done': len([s for s in code if s['done']]), 'total': len(code),
                                     'gates_pending': len([s for s in prop.steps if s['human_gate'] and not s['done']])}
                entry['complete'] = bool(prop.steps) and all(s['done'] for s in prop.steps)
                if m['done'] and not entry['complete']:
                    doc.warn(m['line'], 'milestone_ticked_incomplete', 'milestone %d is ticked but %s still has '
                             'unticked steps' % (m['n'], m['proposal']))
                if entry['complete'] and not m['done']:
                    doc.warn(m['line'], 'milestone_complete_unticked', 'every step of %s is ticked; tick '
                             'milestone %d' % (m['proposal'], m['n']))
        sat[m['n']] = m['done'] or entry['complete']
        entry['satisfied'] = sat[m['n']]
        out.append(entry)
    nxt = [e['n'] for e in out if not e['satisfied'] and all(sat.get(d, False) for d in e['depends'] if d in by_n)]
    return {'doc': doc.path, 'kind': 'roadmap', 'errors': doc.errors, 'warnings': doc.warnings,
            'milestones': out, 'next': nxt}


# ---- decisions --------------------------------------------------------------------------------

def decisions_report(doc):
    """--decisions: every D-record with who decided it, the ones nobody confirmed with the person (assumed, or
    untagged) and the lines that carry a (proposed) value. Read from the parse alone: nothing is linted."""
    decisions = [public_decision(d) for d in doc.decisions]
    return {'doc': doc.path, 'kind': 'proposal' if doc.kind == 'unknown' else doc.kind, 'decisions': decisions,
            'unconfirmed': [d for d in decisions if d['by'] in ('assumed', '')], 'proposed': doc.proposed}


# ---- tick -------------------------------------------------------------------------------------

def tick(path, numbers):
    lines = read_lines(path)
    doc = parse(path)
    want = set(numbers)
    found = dict((s['n'], s) for s in doc.steps if s['n'] in want)
    missing = sorted(want - set(found))
    if missing:
        return 1, {'ticked': [], 'already': [], 'missing': missing}
    ticked, already = [], []
    for n in sorted(found):
        s = found[n]
        if s['done']:
            already.append(n)
            continue
        idx = s['line'] - 1
        lines[idx] = lines[idx].replace('%d. [ ]' % n, '%d. [x]' % n, 1)
        ticked.append(n)
    if ticked:
        d = os.path.dirname(os.path.abspath(path))
        fd, tmp = tempfile.mkstemp(prefix='.proposal-lint.', dir=d)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8', newline='') as f:
                f.write(''.join(lines))
            mode = os.stat(path).st_mode & 0o777
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
    return 0, {'ticked': ticked, 'already': already, 'missing': []}


# ---- CLAUDE.md drift --------------------------------------------------------------------------

BOOTSTRAP_CONFIG_MARKER = '<!-- Pipeline config written by /bootstrap -->'


def section_bodies(path, appended=False):
    """{lowercased H2 name: (heading line, [body lines])} outside code fences; a body ends at the next
    # or ## heading. The first section of a name wins; with appended=True (a CLAUDE.md, where /bootstrap appends
    its copies after its Pipeline config marker, possibly below sections of the same name a person wrote), the
    first one after that marker wins, else the last one in the file."""
    found = {}
    in_fence = False
    cur = None
    marker_line = None
    for i, raw in enumerate(read_lines(path), 1):
        line = raw.rstrip('\r\n')
        if marker_line is None and BOOTSTRAP_CONFIG_MARKER in line:
            marker_line = i
        if FENCE_RE.match(line):
            in_fence = not in_fence
        elif not in_fence and (line.startswith('# ') or line.startswith('## ')):
            m = H2_RE.match(line)
            name = m.group(1).lower() if m and line.startswith('## ') else None
            cur = None
            if name:
                found.setdefault(name, []).append((i, []))
                cur = found[name][-1][1]
            continue
        if cur is not None:
            cur.append((i, line))
    out = {}
    for name, secs in found.items():
        if not appended:
            out[name] = secs[0]
        else:
            after = [sec for sec in secs if marker_line is not None and sec[0] > marker_line]
            out[name] = after[0] if after else secs[-1]
    return out


def trim_blank(lines):
    lo, hi = 0, len(lines)
    while lo < hi and not lines[lo][1].strip():
        lo += 1
    while hi > lo and not lines[hi - 1][1].strip():
        hi -= 1
    return lines[lo:hi]


def body_matches(mine, theirs):
    """Compare CLAUDE.md's body with the architecture's, line by line. Returns None when they match, else
    (CLAUDE.md line, architecture line) of the first difference (0 when one side ran out)."""
    a, b = [t for _i, t in mine], [t for _i, t in theirs]
    if a == b:
        return None
    k = 0
    while k < len(a) and k < len(b) and a[k] == b[k]:
        k += 1
    return (mine[k][0] if k < len(mine) else 0, theirs[k][0] if k < len(theirs) else 0)


def check_claude_md(doc, claude_path):
    """claude_md_drift for each CLAUDE_MD_SECTIONS body in CLAUDE.md that differs from the architecture's.
    Blank lines at either end are ignored, and so, under ## Invariants, is the one pointer line /bootstrap
    adds: the first or last line of the body, when it names architecture.md and the architecture's body
    does not have it."""
    arch = section_bodies(doc.path)
    mine = section_bodies(claude_path, appended=True)
    rel = doc.path
    for name in CLAUDE_MD_SECTIONS:
        key = name.lower()
        if key not in arch:
            continue    # the architecture lint already reports missing_section
        theirs = trim_blank(arch[key][1])
        if key not in mine:
            doc.err(1, 'claude_md_drift', '%s has no "## %s" section; copy %s\'s body into it verbatim'
                    % (claude_path, name, rel), path=claude_path)
            continue
        head, body = mine[key][0], trim_blank(mine[key][1])
        diff = body_matches(body, theirs)
        if diff and key == 'invariants':
            texts = set(t for _i, t in theirs)
            for idx in (0, len(body) - 1):
                if body and 'architecture.md' in body[idx][1] and body[idx][1] not in texts:
                    rest = trim_blank(body[:idx] + body[idx + 1:])
                    if body_matches(rest, theirs) is None:
                        diff = None
                        break
        if diff:
            at_mine, at_arch = diff
            where = ('first difference at %s line %d' % (claude_path, at_mine) if at_mine else
                     '%s ends early' % claude_path) + (', %s line %d' % (rel, at_arch) if at_arch else
                                                       ', %s ends early' % rel)
            doc.err(at_mine or head, 'claude_md_drift', '"## %s" in %s differs from %s\'s (%s); the two '
                    'change together: copy the architecture\'s body verbatim' % (name, claude_path, rel, where),
                    path=claude_path)


# ---- main -------------------------------------------------------------------------------------

def main(argv=None):
    p = argparse.ArgumentParser(description='Lint a pipeline design doc, derive its lanes, or tick its steps.')
    p.add_argument('doc')
    p.add_argument('--repo', help='checkout to check Files against')
    p.add_argument('--json', action='store_true')
    p.add_argument('--no-resolve-xrefs', action='store_true', help='skip reading docs named in <file>.md#N refs')
    p.add_argument('--as', dest='as_path', metavar='PATH', help='resolve cross-doc refs (Source:, <file>.md#N, Proposal:) as if DOC were at PATH, '
                   'e.g. to lint a draft kept outside the repo against the docs beside its real path')
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--lanes', action='store_true', help='derive build lanes and chains (JSON)')
    mode.add_argument('--tick', metavar='N[,N...]', help='tick these steps in place (JSON)')
    mode.add_argument('--roadmap', action='store_true', help='report roadmap progress (JSON)')
    mode.add_argument('--decisions', action='store_true', help='list the D-records with who decided each, those '
                      'nobody confirmed with the person, and the (proposed) lines (JSON); reads only, never lints')
    mode.add_argument('--claude-md', metavar='PATH', help='lint an architecture doc and check that CLAUDE.md at PATH '
                      'carries its ## Invariants and ## Testing bodies verbatim')
    p.add_argument('--root', help='--lanes: directory for lane worktrees')
    p.add_argument('--date', help='--lanes: branch name suffix, e.g. 20261104 (default "undated")')
    p.add_argument('--branch-prefix', default='feat/', help='--lanes: branch prefix (default feat/)')
    p.add_argument('--remote-heads', help='--lanes: output of `git ls-remote --heads origin`, to find lanes already built')
    p.add_argument('--allow-draft', action='store_true', help='--lanes: derive lanes even when Status is not accepted / in-progress')
    p.add_argument('--no-size-limits', action='store_true', help='skip the size budgets (doc_too_big, too_many_steps, '
                   'too_many_milestones), e.g. for a doc written before them until it is split')
    a = p.parse_args(argv)
    if not os.path.isfile(a.doc):
        print('proposal-lint: cannot read %s' % a.doc, file=sys.stderr)
        return 2
    try:
        if a.tick is not None:
            try:
                nums = [int(x) for x in a.tick.split(',') if x.strip()]
            except ValueError:
                print('proposal-lint: --tick takes step numbers, e.g. --tick 3,4', file=sys.stderr)
                return 2
            if not nums:
                print('proposal-lint: --tick takes step numbers, e.g. --tick 3,4', file=sys.stderr)
                return 2
            rc, out = tick(a.doc, nums)
            print(json.dumps(out, indent=1))
            return rc
        cache = {}
        doc = parse(a.doc)
        if a.as_path:
            doc.ref_dir = os.path.dirname(a.as_path)
        if a.claude_md is not None and not os.path.isfile(a.claude_md):
            print('proposal-lint: cannot read %s' % a.claude_md, file=sys.stderr)
            return 2
        if a.remote_heads and not os.path.isfile(a.remote_heads):
            print('proposal-lint: cannot read %s' % a.remote_heads, file=sys.stderr)
            return 2
        if a.decisions:
            print(json.dumps(decisions_report(doc), indent=1))
            return 0
        check(doc, repo=a.repo, resolve_xrefs=not a.no_resolve_xrefs, cache=cache, size_limits=not a.no_size_limits)
        if a.lanes:
            if doc.kind != 'proposal':
                doc.err(1, 'not_a_proposal', '--lanes needs a proposal ("# Proposal: ..."), not a %s' % doc.kind)
            if doc.errors:
                print(json.dumps({'doc': doc.path, 'errors': doc.errors, 'warnings': doc.warnings,
                                  'chains': [], 'blocked': [], 'human_gates_pending': [], 'done': []}, indent=1))
                return 1
            out = derive_lanes(doc, a, cache)
            print(json.dumps(out, indent=1))
            return 1 if out['errors'] else 0
        if a.roadmap:
            if doc.kind != 'roadmap':
                doc.err(1, 'not_a_roadmap', '--roadmap needs a roadmap ("# Roadmap: ..."), not a %s' % doc.kind)
                print(json.dumps({'doc': doc.path, 'kind': doc.kind, 'errors': doc.errors,
                                  'warnings': doc.warnings, 'milestones': [], 'next': []}, indent=1))
                return 1
            out = roadmap_report(doc, cache)
            print(json.dumps(out, indent=1))
            return 1 if doc.errors else 0
        if a.claude_md is not None:
            if doc.kind != 'architecture':
                doc.err(1, 'not_an_architecture', '--claude-md needs an architecture doc ("# Architecture: ..."), '
                        'not a %s' % doc.kind)
            else:
                check_claude_md(doc, a.claude_md)
        if a.json:
            print(json.dumps({'doc': doc.path, 'kind': doc.kind, 'title': doc.title, 'header': doc.header,
                              'errors': doc.errors, 'warnings': doc.warnings,
                              'steps': [public_step(s) for s in doc.steps],
                              'decisions': [public_decision(d) for d in doc.decisions]}, indent=1))
        else:
            for e in sorted(doc.errors, key=lambda x: (x.get('path', ''), x['line'])):
                print('%s:%d: E %s: %s' % (e.get('path', doc.path), e['line'], e['code'], e['message']))
            for w in sorted(doc.warnings, key=lambda x: x['line']):
                print('%s:%d: W %s: %s' % (doc.path, w['line'], w['code'], w['message']))
            print('%s: %s, %d steps, %d errors, %d warnings' % (doc.path, doc.kind, len(doc.steps),
                                                               len(doc.errors), len(doc.warnings)))
        return 1 if doc.errors else 0
    except (OSError, UnicodeDecodeError) as e:
        print('proposal-lint: %s' % e, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Lint every example design doc embedded in the pipeline's docs and commands.

Any fence line (``` or ~~~, with any info string: sh, js, yaml, ...) opens a
block, and only the same fence (same character, at least as long, nothing after
it) closes it. A block whose info string is empty, md or markdown and whose first
non-empty line is `# Proposal: ...`, `# Roadmap: ...` or `# Architecture: ...` is
an example of a format proposal-lint.py enforces, so it must lint with zero errors
(warnings, such as sections a short example leaves out, are allowed). This keeps
the docs and the script from drifting apart.

Usage: python3 ci/lint-doc-examples.py [FILE...]   (default: README.md docs/*.md .claude/commands/*.md)
"""
import glob
import os
import re
import subprocess
import sys
import tempfile

LINT = os.path.join('.claude', 'scripts', 'proposal-lint.py')
# A backtick fence's info string may not contain a backtick (so ```` ``` ```` inline code is no fence).
OPEN = re.compile(r'^(\s*)(```+(?=[^`]*$)|~~~+)\s*(\S*)')
DOC_INFO = ('', 'md', 'markdown')
KIND = re.compile(r'^# (Proposal|Roadmap|Architecture):')


def examples(path):
    with open(path, encoding='utf-8') as f:
        lines = f.read().splitlines()
    i = 0
    while i < len(lines):
        m = OPEN.match(lines[i])
        if not m:
            i += 1
            continue
        indent, fence, info = m.group(1), m.group(2), m.group(3).lower()
        close = re.compile(r'^\s*' + re.escape(fence[0]) + r'{%d,}\s*$' % len(fence))
        start, body = i + 1, []
        i += 1
        while i < len(lines) and not close.match(lines[i]):
            body.append(lines[i][len(indent):] if lines[i].startswith(indent) else lines[i])
            i += 1
        i += 1
        first = next((l for l in body if l.strip()), '')
        if info in DOC_INFO and KIND.match(first):
            yield start, '\n'.join(body) + '\n'


def main(argv):
    files = argv or (['README.md'] + sorted(glob.glob('docs/*.md')) + sorted(glob.glob('.claude/commands/*.md')))
    failed = checked = 0
    with tempfile.TemporaryDirectory() as tmp:
        for path in files:
            for line, text in examples(path):
                checked += 1
                doc = os.path.join(tmp, 'example-%d.md' % checked)
                with open(doc, 'w', encoding='utf-8') as f:
                    f.write(text)
                r = subprocess.run([sys.executable, LINT, doc, '--no-resolve-xrefs'],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    failed += 1
                    errs = [l.replace(doc, '%s:%d (example)' % (path, line))
                            for l in r.stdout.splitlines() if ': E ' in l]
                    print('FAIL %s:%d\n  %s' % (path, line, '\n  '.join(errs or [r.stderr.strip()])))
    if not checked:
        print('FAIL no example design docs found')
        return 1
    print('%s  %d example design docs, %d with lint errors' % ('ok' if not failed else 'FAIL', checked, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

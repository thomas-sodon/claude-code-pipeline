#!/usr/bin/env python3
"""Contract tests for .claude/scripts/context-guard.py and its registration in .claude/settings.json
(stdlib only, Python 3.8+).

Run from the repo root: python3 ci/test_context_guard.py

Each test runs the script as Claude Code does, with hook or status-line JSON on stdin, and a private guard
directory (PIPELINE_GUARD_DIR) and HOME in a temp directory. The SessionStart tests build a state branch with
pipeline-state.py. The guard nags and blocks only an orchestrating session, so the tests of its nags and blocks
start each session with a Workflow tool call (Orchestrating); CI and GITHUB_ACTIONS are cleared, as CI sets them.
"""

import fcntl
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD = os.path.join(ROOT, '.claude', 'scripts', 'context-guard.py')
STATE = os.path.join(ROOT, '.claude', 'scripts', 'pipeline-state.py')
SETTINGS = os.path.join(ROOT, '.claude', 'settings.json')
EVENTS = ('SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact')


def git(cwd, *a, env=None):
    r = subprocess.run(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com'] + list(a),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, env=env)
    if r.returncode != 0:
        raise AssertionError('git %s failed: %s' % (' '.join(a), r.stderr))
    return r.stdout.strip()


def load_guard():
    """The guard as a module in this process. No bytecode cache: .claude/scripts/__pycache__ would carry this
    machine's paths, which CI's project-agnostic grep over .claude/ rejects."""
    spec = importlib.util.spec_from_file_location('context_guard_in_process', GUARD)
    g = importlib.util.module_from_spec(spec)
    keep, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(g)
    finally:
        sys.dont_write_bytecode = keep
    return g


class Guard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='guard-test-')
        self.dir = os.path.join(self.tmp, 'guard')
        # Inside a Claude Code session or a CI job these are set for real; the tests must not pick them up.
        self.env = {k: v for k, v in os.environ.items()
                    if (not k.startswith(('PIPELINE_', 'CLAUDE_', 'GIT_')) or k == 'GIT_EXEC_PATH')
                    and k not in ('CI', 'GITHUB_ACTIONS')}
        self.env.update(HOME=self.tmp, XDG_CONFIG_HOME=self.tmp, GIT_CONFIG_NOSYSTEM='1',
                        PIPELINE_GUARD_DIR=self.dir, PIPELINE_STATE_OFFLINE='1')
        self.repo = os.path.join(self.tmp, 'repo')
        os.makedirs(self.repo)
        git(self.repo, 'init', '-q', env=self.env)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_guard(self, *args, stdin=b'', env=None, cwd=None):
        e = dict(self.env)
        e.update(env or {})
        r = subprocess.run([sys.executable, GUARD] + list(args), input=stdin, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=e, cwd=cwd or self.repo)
        return r

    def hook(self, event, sid='s1', env=None, **fields):
        ev = {'session_id': sid, 'transcript_path': fields.pop('transcript_path', ''), 'cwd': self.repo,
              'hook_event_name': event}
        ev.update(fields)
        r = self.run_guard('hook', stdin=json.dumps(ev).encode(), env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = r.stdout.decode()
        return out

    def hook_json(self, event, **kw):
        out = self.hook(event, **kw)
        return json.loads(out) if out else None

    def statusline(self, payload, env=None):
        r = self.run_guard('statusline', stdin=json.dumps(payload).encode() if not isinstance(payload, bytes)
                           else payload, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.decode().rstrip('\n')

    def at(self, pct, sid='s1', size=200000):
        self.statusline({'session_id': sid, 'context_window': {'used_percentage': pct, 'context_window_size': size}})

    def record(self, sid='s1'):
        with open(os.path.join(self.dir, '%s.json' % sid)) as f:
            return json.load(f)

    def write_record(self, sid, **rec):
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, '%s.json' % sid), 'w') as f:
            json.dump(rec, f)

    def transcript(self, *entries):
        p = os.path.join(self.tmp, 'transcript-%d.jsonl' % len(os.listdir(self.tmp)))
        with open(p, 'w') as f:
            for e in entries:
                f.write((e if isinstance(e, str) else json.dumps(e)) + '\n')
        return p

    def status(self, sid='s1', transcript=None, env=None):
        args = ['status', '--session', sid] + (['--transcript', transcript] if transcript else [])
        r = self.run_guard(*args, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.decode())

    def mark(self, sid='s1', cwd=None, code=0):
        env = {'CLAUDE_CODE_SESSION_ID': sid} if sid else {}
        r = self.run_guard('mark-handoff', env=env, cwd=cwd)
        self.assertEqual(r.returncode, code, r.stderr)
        return r

    def orchestrate(self, sid='s1', env=None, **fields):
        """The session's Workflow tool call, which makes it orchestrating; its output ('' with no usage known)."""
        return self.hook('PostToolUse', sid=sid, env=env, tool_name='Workflow', **fields)

    def hook_state(self, sid='s1'):
        with open(os.path.join(self.dir, '%s.hook.json' % sid)) as f:
            return json.load(f)

    def marked(self, sid='s1'):
        """Whether the session's orchestration mark, <session>.orchestrating, exists."""
        return os.path.exists(os.path.join(self.dir, '%s.orchestrating' % sid))

    def repo_mark(self):
        """The repository's handoff mark, handoff-<repo-key>.json: the tests use one repository."""
        (name,) = [n for n in os.listdir(self.dir) if n.startswith('handoff-')]
        with open(os.path.join(self.dir, name)) as f:
            return json.load(f)

    def worktree(self):
        """A second worktree of the test repository, as another session of it would use."""
        wt = os.path.join(self.tmp, 'wt')
        git(self.repo, 'commit', '-q', '--allow-empty', '-m', 'init', env=self.env)
        git(self.repo, 'worktree', 'add', '-q', wt, env=self.env)
        return wt

    def save_state(self, repo, text, *flags):
        r = subprocess.run([sys.executable, STATE, '--repo', repo, 'save', '-', '--as', 'STATE.md'] + list(flags),
                           input=text.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        self.assertEqual(r.returncode, 0, r.stderr)


class Orchestrating(Guard):
    """A session that has run a workflow: its Workflow call comes first, before any usage is known."""

    def setUp(self):
        super().setUp()
        self.assertEqual(self.orchestrate(), '', 'with no usage known, the Workflow call only marks the session')


def assistant(model='claude-opus-4-8', sidechain=False, **usage):
    e = {'type': 'assistant', 'message': {'model': model, 'role': 'assistant', 'content': [], 'usage': usage}}
    if sidechain:
        e['isSidechain'] = True
    return e


class StatusLine(Guard):
    def test_writes_the_session_record_and_prints_the_line(self):
        line = self.statusline({'session_id': 's1', 'transcript_path': '/x/s1.jsonl', 'exceeds_200k_tokens': False,
                                'context_window': {'used_percentage': 12, 'context_window_size': 200000,
                                                   'current_usage': {'input_tokens': 24000}}})
        self.assertEqual(line, 'ctx 12%')
        rec = self.record()
        self.assertEqual((rec['used_percentage'], rec['context_window_size'], rec['transcript_path']),
                         (12, 200000, '/x/s1.jsonl'))
        self.assertRegex(rec['at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')

    def test_handoff_due_at_or_over_the_threshold_in_an_orchestrating_session(self):
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 90}}), 'ctx 90%',
                         'a session that has run no workflow is never told to hand off')
        self.orchestrate()
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 39.4}}),
                         'ctx 39%')
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 40}}),
                         'ctx 40% \u00b7 handoff due')
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 35}},
                                         env={'PIPELINE_HANDOFF_PCT': '30'}), 'ctx 35% \u00b7 handoff due')
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 90}},
                                         env={'PIPELINE_CONTEXT_GUARD': 'off'}), 'ctx 90%')

    def test_falls_back_to_current_usage_then_to_unknown(self):
        self.orchestrate()
        line = self.statusline({'session_id': 's1', 'context_window': {
            'used_percentage': None, 'context_window_size': 1000000,
            'current_usage': {'input_tokens': 5, 'cache_creation_input_tokens': 100000,
                              'cache_read_input_tokens': 349995, 'output_tokens': 99999}}})
        self.assertEqual(line, 'ctx 45% \u00b7 handoff due')
        self.assertEqual(self.statusline({'session_id': 's2', 'context_window': {'used_percentage': None,
                                                                                 'current_usage': None}}), 'ctx --')
        self.assertIsNone(self.record('s2')['used_percentage'])

    def test_a_smaller_auto_compaction_window_moves_the_line_as_it_moves_the_hooks(self):
        payload = {'session_id': 's1', 'context_window': {'used_percentage': 25, 'context_window_size': 1000000}}
        early = {'CLAUDE_CODE_AUTO_COMPACT_WINDOW': '400000'}
        # 25% of a 1M window is 62.5% of a 400k one, which the line rounds as it always does (round(62.5) is 62).
        self.assertEqual(self.statusline(payload, env=early), 'ctx 62%',
                         'a session that runs no workflow is never due')
        self.orchestrate()
        self.assertEqual(self.statusline(payload, env=early), 'ctx 62% \u00b7 handoff due')
        self.assertEqual(self.record()['used_percentage'], 25, "the record keeps Claude Code's own figure")
        u = self.status(env=early)['usage']
        self.assertEqual((u['source'], u['window'], u['window_source']),
                         ('statusline', 400000, 'auto_compact_window'))
        self.assertAlmostEqual(u['pct'], 62.5)
        self.assertEqual(self.hook_json('Stop', env=early)['decision'], 'block', 'the hooks see what the line shows')
        self.assertEqual(self.statusline(payload), 'ctx 25%')
        self.assertEqual(self.statusline(payload, env={'CLAUDE_CODE_AUTO_COMPACT_WINDOW': '2000000'}), 'ctx 25%',
                         'a larger compaction window changes nothing')

    def test_garbage_input_still_prints_and_exits_0(self):
        for raw in (b'', b'not json', b'[1, 2]', b'\x00\xff', b'{"session_id": "../../x", "context_window": 7}'):
            self.assertEqual(self.statusline(raw), 'ctx --')
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'x.json')), 'a session id never escapes the dir')


class Usage(Guard):
    def test_transcript_fallback_sums_input_and_cache_tokens(self):
        t = self.transcript({'type': 'user', 'message': {'role': 'user', 'content': 'go'}},
                            assistant(input_tokens=10, cache_creation_input_tokens=20000,
                                      cache_read_input_tokens=60000, output_tokens=7000),
                            assistant(sidechain=True, input_tokens=900000),
                            assistant(model='<synthetic>', input_tokens=0),
                            'not json at all',
                            {'type': 'attachment'})
        u = self.status(transcript=t)['usage']
        self.assertEqual((u['source'], u['tokens'], u['window'], u['window_source']),
                         ('transcript', 80010, 200000, 'default'))
        self.assertAlmostEqual(u['pct'], 40.005)
        u = self.status(transcript=t, env={'PIPELINE_CONTEXT_WINDOW': '1000000'})['usage']
        self.assertEqual((u['window'], u['window_source']), (1000000, 'env'))
        self.assertAlmostEqual(u['pct'], 8.001)
        # A stale status-line record no longer gives the usage, but its window size still applies.
        self.write_record('s1', used_percentage=99, context_window_size=400000, ts=time.time() - 1200)
        u = self.status(transcript=t, env={'PIPELINE_CONTEXT_WINDOW': '1000000'})['usage']
        self.assertEqual((u['source'], u['window'], u['window_source']), ('transcript', 400000, 'statusline'))

    def test_the_window_follows_the_model_and_the_count(self):
        t = self.transcript(assistant(model='claude-opus-5-5', input_tokens=300000))
        self.assertEqual(self.status(transcript=t)['usage']['window_source'], 'model')
        self.assertAlmostEqual(self.status(transcript=t)['usage']['pct'], 30.0)
        t = self.transcript(assistant(model='claude-opus-4-8[1m]', input_tokens=100000))
        self.assertEqual(self.status(transcript=t)['usage']['window'], 1000000)
        t = self.transcript(assistant(model='claude-opus-4-8', input_tokens=300000))
        u = self.status(transcript=t)['usage']
        self.assertEqual((u['window'], u['window_source']), (1000000, 'observed'))
        t = self.transcript(assistant(model='claude-haiku-4-5', input_tokens=100000))
        self.assertEqual(self.status(transcript=t)['usage']['window'], 200000)

    def test_an_earlier_auto_compaction_moves_the_measure_and_the_threshold(self):
        t = self.transcript(assistant(model='claude-opus-5-5', input_tokens=150000))
        u = self.status(transcript=t, env={'CLAUDE_CODE_AUTO_COMPACT_WINDOW': '300000'})['usage']
        self.assertEqual((u['window'], u['window_source']), (300000, 'auto_compact_window'))
        self.assertAlmostEqual(u['pct'], 50.0)
        self.write_record('s1', used_percentage=20, context_window_size=1000000, ts=time.time())
        u = self.status(transcript=t, env={'CLAUDE_CODE_AUTO_COMPACT_WINDOW': '500000'})['usage']
        self.assertEqual((u['source'], u['window']), ('statusline', 500000))
        self.assertAlmostEqual(u['pct'], 40.0)
        self.assertEqual(self.status()['threshold'], 40.0)
        self.assertEqual(self.status(env={'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE': '30'})['threshold'], 20.0)
        self.assertEqual(self.status(env={'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE': '80'})['threshold'], 40.0)
        self.assertEqual(self.status(env={'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE': '12'})['threshold'], 6.0)

    def test_a_compaction_after_the_last_count_makes_usage_unknown(self):
        t = self.transcript(assistant(input_tokens=150000),
                            {'type': 'system', 'subtype': 'compact_boundary'},
                            {'type': 'user', 'isCompactSummary': True, 'message': {'content': 'summary'}})
        self.assertIsNone(self.status(transcript=t)['usage']['pct'])
        t = self.transcript(assistant(input_tokens=150000), {'type': 'system', 'subtype': 'compact_boundary'},
                            assistant(input_tokens=20000))
        self.assertAlmostEqual(self.status(transcript=t)['usage']['pct'], 10.0)

    def test_a_fresh_status_line_record_wins_over_the_transcript(self):
        t = self.transcript(assistant(input_tokens=20000))
        self.at(55)
        u = self.status(transcript=t)['usage']
        self.assertEqual((u['source'], u['pct']), ('statusline', 55))
        self.write_record('s1', used_percentage=55, context_window_size=200000, ts=time.time() - 660)
        u = self.status(transcript=t)['usage']
        self.assertEqual((u['source'], u['pct']), ('transcript', 10.0))

    def test_a_long_transcript_is_read_from_its_tail(self):
        filler = json.dumps({'type': 'user', 'message': {'content': 'x' * 4000}})
        t = self.transcript(assistant(input_tokens=1), *([filler] * 200), assistant(input_tokens=120000),
                            *([filler] * 100))
        self.assertAlmostEqual(self.status(transcript=t)['usage']['pct'], 60.0)


class PostToolUse(Orchestrating):
    def warns(self, **kw):
        out = self.hook_json('PostToolUse', tool_name='Bash', **kw)
        if out is None:
            return False
        self.assertEqual(out['hookSpecificOutput']['hookEventName'], 'PostToolUse')
        self.assertNotIn('decision', out)
        self.assertIn('/handoff', out['hookSpecificOutput']['additionalContext'])
        return True

    def test_silent_under_the_threshold(self):
        self.at(39)
        self.assertFalse(self.warns())
        self.assertEqual(self.hook('PostToolUse'), '')

    def test_first_crossing_then_every_10th_call_or_5_points(self):
        self.at(41)
        self.assertTrue(self.warns(), 'the first crossing warns')
        self.assertEqual([self.warns() for _ in range(9)], [False] * 9)
        self.assertTrue(self.warns(), 'the 10th call after a warning warns')
        self.at(45.9)
        self.assertFalse(self.warns())
        self.at(46.1)
        self.assertTrue(self.warns(), '5 points over the last warning warns at once')
        self.assertFalse(self.warns())

    def test_dropping_under_the_threshold_starts_over(self):
        self.at(42)
        self.assertTrue(self.warns())
        self.assertFalse(self.warns())
        self.at(12)                     # compacted
        self.assertFalse(self.warns())
        self.at(41)
        self.assertTrue(self.warns(), 'a new crossing warns again')

    def test_the_warning_mentions_a_recorded_handoff(self):
        self.at(50)
        self.hook('UserPromptSubmit')   # records the crossing
        self.mark()
        out = self.hook_json('PostToolUse')
        self.assertIn('A handoff was saved at', out['hookSpecificOutput']['additionalContext'])


class PromptAndStop(Orchestrating):
    def test_user_prompt_submit_adds_context_and_never_blocks(self):
        self.at(30)
        self.assertEqual(self.hook('UserPromptSubmit', prompt='hello'), '')
        self.at(48)
        out = self.hook_json('UserPromptSubmit', prompt='hello')
        self.assertNotIn('decision', out)
        self.assertEqual(out['hookSpecificOutput']['hookEventName'], 'UserPromptSubmit')
        self.assertIn('/handoff', out['hookSpecificOutput']['additionalContext'])

    def test_stop_blocks_until_a_handoff_is_marked(self):
        self.at(20)
        self.assertEqual(self.hook('Stop', stop_hook_active=False), '')
        self.at(44)
        out = self.hook_json('Stop', stop_hook_active=False)
        self.assertEqual(out['decision'], 'block')
        self.assertIn('/handoff', out['reason'])
        self.assertEqual(self.hook('Stop', stop_hook_active=True), '', 'an already continued stop is allowed')
        self.assertEqual(self.hook_json('Stop', stop_hook_active=False)['decision'], 'block')
        r = self.mark()
        self.assertTrue(json.loads(r.stdout.decode())['marked'])
        self.assertEqual(self.hook('Stop', stop_hook_active=False), '')

    def test_a_handoff_before_the_crossing_does_not_count(self):
        self.at(30)
        self.mark()
        time.sleep(0.05)
        self.at(41)
        self.assertEqual(self.hook_json('Stop', stop_hook_active=False)['decision'], 'block')

    def test_a_repository_mark_counts_without_a_session_id(self):
        self.at(41)
        self.assertEqual(self.hook_json('Stop')['decision'], 'block')
        wt = self.worktree()
        r = self.mark(sid=None, cwd=wt)      # another worktree of the same repository
        self.assertEqual(json.loads(r.stdout.decode())['scope'], ['repository'])
        self.assertIsNone(self.repo_mark()['session_id'], 'a mark no session wrote is the fallback for every one')
        self.assertEqual(self.hook('Stop'), '')

    def test_another_sessions_handoff_does_not_release_this_one(self):
        wt = self.worktree()
        self.orchestrate(sid='s2', cwd=wt)   # session B, in another worktree of the repository
        self.at(41)
        self.at(41, sid='s2')
        for sid, cwd in (('s1', self.repo), ('s2', wt)):
            self.assertEqual(self.hook_json('Stop', sid=sid, cwd=cwd)['decision'], 'block', sid)
        r = self.mark(sid='s2', cwd=wt)
        self.assertEqual(json.loads(r.stdout.decode())['scope'], ['session', 'repository'])
        self.assertEqual(self.repo_mark()['session_id'], 's2', 'the repository mark names the session that wrote it')
        self.assertEqual(self.hook('Stop', sid='s2', cwd=wt), '', "B's own handoff releases B")
        self.assertEqual(self.hook_json('Stop')['decision'], 'block', "B's handoff does not release A")
        for event in ('PostToolUse', 'UserPromptSubmit'):
            out = self.hook_json(event, tool_name='Bash', prompt='go on')
            self.assertNotIn('A handoff was saved', out['hookSpecificOutput']['additionalContext'], event)
        self.assertIsNone(self.status()['handoff_at'])
        self.mark()                          # A's own handoff
        self.assertEqual(self.hook('Stop'), '', "A's own handoff releases A")
        self.assertIsNotNone(self.status()['handoff_at'])

    def test_mark_handoff_with_neither_session_nor_repository_exits_2(self):
        elsewhere = os.path.join(self.tmp, 'not-a-repo')
        os.makedirs(elsewhere)
        self.mark(sid=None, cwd=elsewhere, code=2)

    def test_the_guard_switched_off_does_nothing(self):
        self.at(70)
        off = {'PIPELINE_CONTEXT_GUARD': 'off'}
        for event in ('UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact'):
            self.assertEqual(self.hook(event, env=off, trigger='auto'), '')


class PreCompact(Orchestrating):
    def test_auto_blocks_once_then_allows_with_summary_instructions(self):
        self.at(92)
        out = self.hook_json('PreCompact', trigger='auto', custom_instructions=None)
        self.assertEqual(out['decision'], 'block')
        self.assertIn('/handoff', out['reason'])
        text = self.hook('PreCompact', trigger='auto', custom_instructions=None)
        self.assertFalse(text.lstrip().startswith('{'), 'plain stdout: summary instructions, not JSON')
        self.assertIn('pipeline state', text)
        self.assertIn('/handoff', text)
        self.assertNotIn('decision', self.hook('PreCompact', trigger='auto'))

    def test_manual_is_allowed(self):
        self.at(92)
        self.assertEqual(self.hook('PreCompact', trigger='manual', custom_instructions='keep the plan'), '')
        self.assertEqual(self.hook_json('PreCompact', trigger='auto')['decision'], 'block',
                         'a manual compaction does not use up the one block')

    def test_under_the_threshold_auto_is_allowed_without_using_the_block(self):
        self.at(15)
        self.assertNotIn('decision', self.hook('PreCompact', trigger='auto'))
        self.at(93)
        self.assertEqual(self.hook_json('PreCompact', trigger='auto')['decision'], 'block')

    def test_an_early_auto_compaction_keeps_the_state_and_asks_for_no_handoff(self):
        self.at(15)
        text = self.hook('PreCompact', trigger='auto')
        self.assertTrue(text.startswith('Keep the pipeline state in this summary'), text)
        self.assertTrue(text.endswith('and the exact next action.'), text)
        # An answer is kept with what a later run needs to pass it back: its id, who asked, the question text and the date.
        self.assertIn("the answers the person gave, each with its id, what asked it (the workflow, and its lane or doc), "
                      "the question's text, the answer in their words and its date; the standing rules the person set;", text)
        for said in ('handoff', 'end the session', 'fresh session'):
            self.assertNotIn(said, text, 'the guard asked for no handoff, so the session goes on with its budget')
        self.assertIsNone(self.status()['precompact_blocked'])

    def test_over_the_threshold_the_compaction_that_goes_ahead_keeps_the_state_and_the_handoff(self):
        self.at(92)
        self.assertEqual(self.hook_json('PreCompact', trigger='auto')['decision'], 'block')
        text = self.hook('PreCompact', trigger='auto')
        self.assertTrue(text.startswith('Keep the pipeline state in this summary'), text)
        self.assertIn('the exact next action. Keep this too: the context guard asked for a handoff, so the first '
                      'thing after this compaction is to run /handoff', text)
        self.assertTrue(text.endswith('and end the session; the work continues in a fresh session.'), text)
        self.assertEqual(self.hook('PreCompact', trigger='auto'), text, 'every later one says the same')

    def test_the_block_is_per_session(self):
        self.orchestrate(sid='s2')
        self.at(92, sid='s1')
        self.at(92, sid='s2')
        self.assertEqual(self.hook_json('PreCompact', sid='s1', trigger='auto')['decision'], 'block')
        self.assertEqual(self.hook_json('PreCompact', sid='s2', trigger='auto')['decision'], 'block')


class Subagents(Guard):
    def test_events_inside_a_subagent_are_ignored(self):
        self.at(80)
        sub = {'agent_id': 'agent-abc123', 'agent_type': 'general-purpose'}
        for event in EVENTS:
            self.assertEqual(self.hook(event, trigger='auto', stop_hook_active=False, **sub), '', event)
        self.assertEqual(self.orchestrate(**sub), '', 'a subagent that runs a workflow orchestrates nothing')
        self.assertEqual(self.orchestrate(transcript_path='/p/s1/subagents/agent-x.jsonl'), '')
        self.assertFalse(os.path.exists(os.path.join(self.dir, 's1.hook.json')), 'no state recorded')
        self.assertEqual(self.hook('Stop', stop_hook_active=False), '', 'so the main session is not orchestrating')
        # ... and once the main session runs a workflow, a subagent's tool calls never count toward its rate limit
        self.assertIn('/handoff', self.orchestrate(), 'the first crossing warns')
        for _ in range(12):
            self.hook('PostToolUse', **sub)
        self.assertEqual(self.hook('PostToolUse'), '')

    def test_a_main_session_started_with_agent_is_guarded(self):
        self.orchestrate(agent_type='security-reviewer')
        self.at(80)
        out = self.hook_json('Stop', agent_type='security-reviewer', stop_hook_active=False)
        self.assertEqual(out['decision'], 'block')


class Orchestration(Guard):
    def events(self, env=None):
        """The output of each event the guard nags or blocks on, in turn: PostToolUse, UserPromptSubmit, Stop and
        PreCompact (auto); '' where it did nothing."""
        return [self.hook(e, env=env, tool_name='Bash', prompt='go on', stop_hook_active=False, trigger='auto')
                for e in ('PostToolUse', 'UserPromptSubmit', 'Stop', 'PreCompact')]

    def line(self, pct=80, env=None):
        return self.statusline({'session_id': 's1', 'context_window': {'used_percentage': pct}}, env=env)

    def test_over_the_threshold_without_orchestration_nothing_nags_or_blocks(self):
        self.at(80)
        for _ in range(2):
            self.assertEqual(self.events(), ['', '', '', ''])
        self.assertEqual(self.line(), 'ctx 80%')
        st = self.status()
        self.assertEqual((st['orchestrating'], st['over'], st['crossed_at'], st['precompact_blocked']),
                         (False, True, None, None), 'nothing measured, crossed or used up')
        self.assertNotIn('orchestrating', self.hook_state())
        self.assertFalse(self.marked())

    def test_a_workflow_call_marks_the_session_and_the_next_event_over_the_threshold_nags(self):
        self.at(80)
        self.assertEqual(self.events(), ['', '', '', ''])
        out = json.loads(self.orchestrate())
        self.assertIn('/handoff', out['hookSpecificOutput']['additionalContext'], 'the Workflow call is measured')
        self.assertTrue(self.marked())
        out = self.hook_json('UserPromptSubmit', prompt='go on')
        self.assertIn('/handoff', out['hookSpecificOutput']['additionalContext'])
        self.assertEqual(self.hook_json('Stop', stop_hook_active=False)['decision'], 'block')
        self.assertEqual(self.hook_json('PreCompact', trigger='auto')['decision'], 'block')
        self.assertTrue(self.marked(), 'the mark stays for the rest of the session')
        self.assertTrue(self.status()['orchestrating'])
        self.assertEqual(self.line(), 'ctx 80% · handoff due')
        self.at(80, sid='s2')
        self.assertEqual(self.hook('Stop', sid='s2', stop_hook_active=False), '', 'another session is not marked')

    def test_pipeline_orchestrator_1_makes_a_session_orchestrating_without_a_workflow_call(self):
        on = {'PIPELINE_ORCHESTRATOR': '1'}
        self.at(80)
        post, prompt, stop, precompact = self.events(env=on)
        for out in (post, prompt):
            self.assertIn('/handoff', json.loads(out)['hookSpecificOutput']['additionalContext'])
        self.assertEqual([json.loads(stop)['decision'], json.loads(precompact)['decision']], ['block', 'block'])
        self.assertEqual(self.line(env=on), 'ctx 80% · handoff due')
        self.assertTrue(self.status(env=on)['orchestrating'])
        self.assertFalse(self.status()['orchestrating'], 'nothing recorded: the variable decides')
        self.assertEqual(self.events(env={'PIPELINE_ORCHESTRATOR': '0'})[1:3], ['', ''])

    def test_ci_suppresses_everything_unless_pipeline_orchestrator_is_1(self):
        self.save_state(self.repo, '# Pipeline handoff: demo\n\n## Next\n\nRun the workflow.\n', '--no-push')
        self.orchestrate()
        self.at(80)
        for ci in ({'CI': 'true'}, {'GITHUB_ACTIONS': 'true'}, {'CI': '1', 'GITHUB_ACTIONS': 'false'}):
            self.assertEqual(self.events(env=ci), ['', '', '', ''], ci)
            self.assertEqual(self.orchestrate(env=ci), '', ci)
            self.assertEqual(self.hook('SessionStart', env=ci, source='startup'), '', '%s: no handoff pointer' % ci)
            self.assertEqual(self.line(env=ci), 'ctx 80%', ci)
            self.assertFalse(self.status(env=ci)['orchestrating'], ci)
        # A falsy CI is none ...
        falsy = {'CI': 'false', 'GITHUB_ACTIONS': ''}
        self.assertEqual(self.hook_json('Stop', env=falsy, stop_hook_active=False)['decision'], 'block')
        out = self.hook_json('SessionStart', env=falsy, source='startup')
        self.assertIn('Read it before acting', out['hookSpecificOutput']['additionalContext'])
        # ... and PIPELINE_ORCHESTRATOR=1 orchestrates under CI too, its SessionStart pointer included.
        forced = {'CI': 'true', 'GITHUB_ACTIONS': 'true', 'PIPELINE_ORCHESTRATOR': '1'}
        self.assertEqual(self.hook_json('PreCompact', env=forced, trigger='auto')['decision'], 'block')
        out = self.hook_json('SessionStart', env=forced, source='startup')
        self.assertIn('Read it before acting', out['hookSpecificOutput']['additionalContext'])
        self.assertEqual(self.line(env=forced), 'ctx 80% · handoff due')


class SessionState(Orchestrating):
    """Hooks close together (PostToolUse for parallel tool calls, or UserPromptSubmit and Stop) each load, change and
    write the session's state file: orchestration is kept apart from it, and the hooks take turns on its lock."""

    def event(self, name, **fields):
        ev = {'session_id': 's1', 'transcript_path': '', 'cwd': self.repo, 'hook_event_name': name}
        ev.update(fields)
        return ev

    def test_a_full_rewrite_of_the_state_file_cannot_clear_orchestration(self):
        mark = os.path.join(self.dir, 's1.orchestrating')
        self.assertTrue(self.marked(), "setUp's Workflow call created the mark")
        self.assertNotIn('orchestrating', self.hook_state(), 'the state file does not hold it')
        def seen():                          # not its mtime: each hook touches the mark (touch_session)
            with open(mark) as f:
                return os.stat(mark).st_ino, f.read()
        before = seen()
        # A hook that loaded the state before the Workflow call writes all of it back after it.
        with open(os.path.join(self.dir, 's1.hook.json'), 'w') as f:
            json.dump({'source': 'startup', 'updated_at': '2026-11-11T00:00:00Z'}, f)
        self.at(80)
        self.assertTrue(self.status()['orchestrating'])
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 80}}),
                         'ctx 80% · handoff due')
        self.assertEqual(self.hook_json('Stop', stop_hook_active=False)['decision'], 'block')
        self.assertIn('/handoff', self.orchestrate())
        self.assertEqual(seen(), before, 'the mark is only ever created, never rewritten')

    def test_two_interleaved_updates_keep_both_changes(self):
        """PreCompact (A) records its one block while PostToolUse (B) records the crossing and its rate limit. A has
        loaded and changed the state and not written it yet when B starts: B waits for the lock A holds, then builds
        on A's write. The hooks run in this process, in two threads, so the order is forced, never timed."""
        self.at(92)
        g = load_guard()
        g.LOCK_WAIT = 60                    # B waits for as long as the test takes: nothing here is timed
        a_changed, release_a, b_stopped = threading.Event(), threading.Event(), threading.Event()
        precompact = g.HANDLERS['PreCompact']

        def paused(ev, sid, st):             # A, between its handler and its write
            out = precompact(ev, sid, st)
            a_changed.set()
            release_a.wait(30)
            return out
        g.HANDLERS['PreCompact'] = paused

        class Flock:                         # tells the test when B finds the session's lock taken
            def __getattr__(self, name):
                return getattr(fcntl, name)

            def flock(self, fd, op):
                try:
                    return fcntl.flock(fd, op)
                except BlockingIOError:
                    b_stopped.set()
                    raise
        g.fcntl = Flock()
        out = {}

        def run(key, ev):
            out[key] = g.run_hook(ev)
            if key == 'B':
                b_stopped.set()

        a = threading.Thread(target=run, args=('A', self.event('PreCompact', trigger='auto')), daemon=True)
        b = threading.Thread(target=run, args=('B', self.event('PostToolUse', tool_name='Bash')), daemon=True)
        with mock.patch.dict(os.environ, self.env, clear=True):
            a.start()
            try:
                self.assertTrue(a_changed.wait(30), 'A loaded and changed the state')
                b.start()
                self.assertTrue(b_stopped.wait(30), 'B finds the lock taken (unlocked, it would finish first)')
            finally:
                release_a.set()
                a.join(30)
                if b.ident is not None:
                    b.join(30)
        self.assertEqual(json.loads(out['A'])['decision'], 'block')
        self.assertIn('/handoff', json.loads(out['B'])['hookSpecificOutput']['additionalContext'])
        st = self.hook_state()
        self.assertIn('precompact_blocked', st, "A's change is kept")
        self.assertEqual((st.get('crossed_pct'), st.get('last_warn_pct'), st.get('calls_since_warn')), (92, 92, 0),
                         "and so is B's")

    def test_a_hook_that_cannot_take_the_lock_does_nothing_and_never_hangs(self):
        self.at(92, sid='s2')
        fd = os.open(os.path.join(self.dir, 's2.hook.lock'), os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)   # another hook of session s2, holding it
            t = time.monotonic()
            self.assertEqual(self.orchestrate(sid='s2'), '', 'no warning built on a state it could not lock')
            self.assertLess(time.monotonic() - t, 8, 'it gives up well inside the 10 s hook timeout')
            self.assertFalse(os.path.exists(os.path.join(self.dir, 's2.hook.json')), 'and it writes no state')
        finally:
            os.close(fd)
        self.assertTrue(self.marked('s2'), 'the Workflow call is marked before the lock, so a busy lock never loses it')
        with open(os.path.join(self.dir, 'errors.log')) as f:
            self.assertIn('PostToolUse skipped', f.read())
        self.assertEqual(self.hook_json('Stop', sid='s2', stop_hook_active=False)['decision'], 'block')

    def test_a_session_resumed_after_31_days_keeps_its_lock_and_its_mark(self):
        """SessionStart removes records over 30 days old while its hook holds the session's lock. Removing the
        session's own would unlink that lock (the next hook would lock a new file and run beside it) and its mark
        (the guard would stop acting on it). Each hook also touches the lock and the mark, so another session's
        SessionStart keeps them later; other sessions' old records still go."""
        self.orchestrate(sid='s2')           # another session, idle as long
        self.at(80)                          # s1's last status-line record before it went idle
        old = time.time() - 31 * 86400
        for n in os.listdir(self.dir):
            os.utime(os.path.join(self.dir, n), (old, old))
        lock = os.path.join(self.dir, 's1.hook.lock')
        inode = os.stat(lock).st_ino
        self.assertEqual(self.hook('SessionStart', source='resume'), '')
        self.assertEqual(os.stat(lock).st_ino, inode, 'the lock its hook held is the one the next hook takes')
        self.assertTrue(self.marked(), 'it keeps its mark')
        self.assertTrue(os.path.exists(os.path.join(self.dir, 's1.json')), 'and its other records')
        self.assertEqual([n for n in os.listdir(self.dir) if n.startswith('s2.')], [],
                         "another session's old records are removed")
        self.assertEqual(self.hook_json('Stop', stop_hook_active=False)['decision'], 'block',
                         'the guard still acts on the resumed session')
        self.assertEqual(self.hook('SessionStart', sid='s3', source='startup'), '')
        self.assertEqual(os.stat(lock).st_ino, inode, "its hooks touch it: another session's SessionStart keeps it")
        self.assertTrue(self.marked(), 'and the mark')


class SessionStart(Guard):
    STATE_MD = ('# Pipeline handoff: demo\n\n## Goal\nShip it.\n\n## Next\n\nRun the workflow '
                '`brief-to-proposals` with these args:\n\n```json\n{"from": "proposals"}\n'
                '## not a heading: inside a fence\n```\n\n## Environment\n\nA cloud session.\n')

    def context(self, env=None, **fields):
        out = self.hook_json('SessionStart', source='startup', env=env, **fields)
        if out is None:
            return None
        self.assertEqual(out['hookSpecificOutput']['hookEventName'], 'SessionStart')
        return out['hookSpecificOutput']['additionalContext']

    def test_injects_the_handoff_from_a_local_state_branch(self):
        self.save_state(self.repo, self.STATE_MD, '--no-push')
        text = self.context()
        self.assertIn('Read it before acting', text)
        self.assertIn('python3 .claude/scripts/pipeline-state.py get STATE.md', text)
        # The new session asks before it acts: the open questions and the assumptions to review, in one batch.
        self.assertIn('Before you do its Next: follow its "Standing rules from the person", and put its "Waiting on the '
                      'person" questions and its "Assumptions to review" to the person in one batch', text)
        self.assertIn('Never answer or confirm one for them.\n\nIts ## Next section:', text)
        self.assertRegex(text, r'saved \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(just now\)')
        self.assertIn('Run the workflow `brief-to-proposals`', text)
        self.assertIn('## not a heading: inside a fence', text)
        self.assertNotIn('A cloud session', text, 'only the ## Next section is quoted')

    def test_a_long_next_section_is_cut_at_2000_characters(self):
        self.save_state(self.repo, '# Pipeline handoff: demo\n\n## Next\n\n' + 'n' * 5000 + '\n', '--no-push')
        text = self.context()
        self.assertIn('n' * 2000, text)
        self.assertNotIn('n' * 2001, text)
        self.assertIn('cut at 2000 characters', text)

    def test_no_state_branch_or_no_repository_adds_nothing(self):
        self.assertIsNone(self.context())
        elsewhere = os.path.join(self.tmp, 'plain')
        os.makedirs(elsewhere)
        self.assertIsNone(self.context(cwd=elsewhere))

    def test_reads_origins_state_branch_after_a_fetch(self):
        origin = os.path.join(self.tmp, 'origin.git')
        git(self.tmp, 'init', '-q', '--bare', origin, env=self.env)
        git(self.repo, 'remote', 'add', 'origin', origin, env=self.env)
        other = os.path.join(self.tmp, 'other')
        git(self.tmp, 'clone', '-q', origin, other, env=self.env)
        self.save_state(other, self.STATE_MD)        # another clone saved it to origin
        self.assertIsNone(self.context(), 'offline, this clone has no copy of the state branch yet')
        text = self.context(env={'PIPELINE_STATE_OFFLINE': '0'})
        self.assertIn("origin's state branch pipeline/state", text)
        self.assertIn('brief-to-proposals', text)
        self.assertIn('pipeline-state.py get STATE.md\n', text)
        self.assertNotIn('--local', text, "origin's copy is read without --local")

    def test_a_state_branch_deleted_on_origin_is_not_read_from_its_stale_tracking_ref(self):
        origin = os.path.join(self.tmp, 'origin.git')
        git(self.tmp, 'init', '-q', '--bare', origin, env=self.env)
        git(self.repo, 'remote', 'add', 'origin', origin, env=self.env)
        other = os.path.join(self.tmp, 'other')
        git(self.tmp, 'clone', '-q', origin, other, env=self.env)
        self.save_state(other, self.STATE_MD)        # another clone saved it to origin
        online, track = {'PIPELINE_STATE_OFFLINE': '0'}, 'refs/remotes/origin/pipeline/state'
        self.assertIn("origin's state branch", self.context(env=online), 'the fetch copies it here')
        # origin out of reach: a network failure, so the copy last fetched is still read, as before
        os.rename(origin, origin + '.away')
        self.assertIn("origin's state branch", self.context(env=online))
        os.rename(origin + '.away', origin)
        # origin answers, and its state branch is gone (ls-remote exits 2): the stale copy is neither read nor kept
        git(other, 'push', '-q', 'origin', '--delete', 'pipeline/state', env=self.env)
        self.assertIsNone(self.context(env=online), 'no handoff from a branch origin deleted')
        self.assertEqual(git(self.repo, 'for-each-ref', track, env=self.env), '', 'its tracking ref is deleted')

    def test_never_fails_the_session(self):
        for raw in (b'', b'garbage', b'[]', b'{"hook_event_name": 5}', b'\xff\xfe',
                    json.dumps({'hook_event_name': 'SessionStart', 'session_id': 's1', 'cwd': 7}).encode(),
                    json.dumps({'hook_event_name': 'Unknown', 'session_id': 's1'}).encode()):
            r = self.run_guard('hook', stdin=raw)
            self.assertEqual((r.returncode, r.stdout), (0, b''), raw)


class Prompts(Guard):
    """No git command of the guard waits on a prompt: ssh opens /dev/tty itself for an unknown host key or a key's
    passphrase, whatever GIT_TERMINAL_PROMPT says, so it runs with BatchMode=yes, unless the person has an ssh
    command of their own. run_git runs in this process, and each command it starts is seen on its way."""

    def git_env(self, env=None):
        """GIT_TERMINAL_PROMPT and GIT_SSH_COMMAND (None: unset) as run_git gives them to git, with env added to the
        test's. Only these two: a failure never prints the rest of the environment, a CI runner's included."""
        g, seen, real = load_guard(), [], subprocess.run

        def spy(cmd, **kw):
            seen.append((cmd, kw.get('env')))
            return real(cmd, **kw)
        with mock.patch.dict(os.environ, dict(self.env, **(env or {})), clear=True), \
                mock.patch.object(subprocess, 'run', spy):
            self.assertEqual(g.run_git(self.repo, 'rev-parse', '--git-dir').returncode, 0)
        (e,) = [e for cmd, e in seen if 'rev-parse' in cmd]
        return e.get('GIT_TERMINAL_PROMPT'), e.get('GIT_SSH_COMMAND')

    def test_ssh_runs_in_batch_mode_unless_the_person_has_their_own(self):
        self.assertEqual(self.git_env(), ('0', 'ssh -o BatchMode=yes'))
        self.assertEqual(self.git_env({'GIT_SSH_COMMAND': 'ssh -i ~/.ssh/own'}), ('0', 'ssh -i ~/.ssh/own'),
                         'their GIT_SSH_COMMAND is kept')
        # git ranks GIT_SSH_COMMAND over core.sshCommand and GIT_SSH: one set here would replace theirs.
        self.assertEqual(self.git_env({'GIT_SSH': 'own-ssh'}), ('0', None), 'so their GIT_SSH is kept')
        git(self.repo, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/repo', env=self.env)
        self.assertEqual(self.git_env(), ('0', None), 'and so is their core.sshCommand')


class Settings(unittest.TestCase):
    def test_registers_the_status_line_and_the_five_hooks(self):
        with open(SETTINGS) as f:
            s = json.load(f)
        self.assertEqual(s['statusLine']['type'], 'command')
        self.assertIn('/.claude/scripts/context-guard.py" statusline', s['statusLine']['command'])
        self.assertEqual(sorted(s['hooks']), sorted(EVENTS))
        for event in EVENTS:
            groups = s['hooks'][event]
            self.assertEqual(len(groups), 1, event)
            self.assertLessEqual(set(groups[0]), {'matcher', 'hooks'})
            (h,) = groups[0]['hooks']
            self.assertEqual(h['type'], 'command')
            self.assertEqual(h['command'], 'python3 "${CLAUDE_PROJECT_DIR}/.claude/scripts/context-guard.py" hook')
            self.assertGreater(h['timeout'], 0)
        self.assertEqual(s['hooks']['PostToolUse'][0]['matcher'], '*')
        for event in ('UserPromptSubmit', 'Stop'):          # no matcher support
            self.assertNotIn('matcher', s['hooks'][event][0])


if __name__ == '__main__':
    unittest.main()

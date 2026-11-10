#!/usr/bin/env python3
"""Contract tests for .claude/scripts/context-guard.py and its registration in .claude/settings.json
(stdlib only, Python 3.8+).

Run from the repo root: python3 ci/test_context_guard.py

Each test runs the script as Claude Code does, with hook or status-line JSON on stdin, and a private guard
directory (PIPELINE_GUARD_DIR) and HOME in a temp directory. The SessionStart tests build a state branch with
pipeline-state.py.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

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


class Guard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='guard-test-')
        self.dir = os.path.join(self.tmp, 'guard')
        # Inside a Claude Code session these are set for real; the tests must not pick them up.
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('PIPELINE_', 'CLAUDE_', 'GIT_')) or k == 'GIT_EXEC_PATH'}
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

    def test_handoff_due_at_or_over_the_threshold(self):
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 39.4}}),
                         'ctx 39%')
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 40}}),
                         'ctx 40% \u00b7 handoff due')
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 35}},
                                         env={'PIPELINE_HANDOFF_PCT': '30'}), 'ctx 35% \u00b7 handoff due')
        self.assertEqual(self.statusline({'session_id': 's1', 'context_window': {'used_percentage': 90}},
                                         env={'PIPELINE_CONTEXT_GUARD': 'off'}), 'ctx 90%')

    def test_falls_back_to_current_usage_then_to_unknown(self):
        line = self.statusline({'session_id': 's1', 'context_window': {
            'used_percentage': None, 'context_window_size': 1000000,
            'current_usage': {'input_tokens': 5, 'cache_creation_input_tokens': 100000,
                              'cache_read_input_tokens': 349995, 'output_tokens': 99999}}})
        self.assertEqual(line, 'ctx 45% \u00b7 handoff due')
        self.assertEqual(self.statusline({'session_id': 's2', 'context_window': {'used_percentage': None,
                                                                                 'current_usage': None}}), 'ctx --')
        self.assertIsNone(self.record('s2')['used_percentage'])

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


class PostToolUse(Guard):
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


class PromptAndStop(Guard):
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
        wt = os.path.join(self.tmp, 'wt')
        git(self.repo, 'commit', '-q', '--allow-empty', '-m', 'init', env=self.env)
        git(self.repo, 'worktree', 'add', '-q', wt, env=self.env)
        r = self.mark(sid=None, cwd=wt)      # another worktree of the same repository
        self.assertEqual(json.loads(r.stdout.decode())['scope'], ['repository'])
        self.assertEqual(self.hook('Stop'), '')

    def test_mark_handoff_with_neither_session_nor_repository_exits_2(self):
        elsewhere = os.path.join(self.tmp, 'not-a-repo')
        os.makedirs(elsewhere)
        self.mark(sid=None, cwd=elsewhere, code=2)

    def test_the_guard_switched_off_does_nothing(self):
        self.at(70)
        off = {'PIPELINE_CONTEXT_GUARD': 'off'}
        for event in ('UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact'):
            self.assertEqual(self.hook(event, env=off, trigger='auto'), '')


class PreCompact(Guard):
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

    def test_the_block_is_per_session(self):
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
        self.assertEqual(self.hook('PostToolUse', transcript_path='/p/s1/subagents/agent-x.jsonl'), '')
        self.assertFalse(os.path.exists(os.path.join(self.dir, 's1.hook.json')), 'no state recorded')
        # ... so a subagent's tool calls never count toward the main session's rate limit
        self.assertIsNotNone(self.hook_json('PostToolUse'))
        for _ in range(12):
            self.hook('PostToolUse', **sub)
        self.assertEqual(self.hook('PostToolUse'), '')

    def test_a_main_session_started_with_agent_is_guarded(self):
        self.at(80)
        out = self.hook_json('Stop', agent_type='security-reviewer', stop_hook_active=False)
        self.assertEqual(out['decision'], 'block')


class SessionStart(Guard):
    STATE_MD = ('# Pipeline handoff: demo\n\n## Goal\nShip it.\n\n## Next\n\nRun the workflow '
                '`brief-to-proposals` with these args:\n\n```json\n{"from": "proposals"}\n'
                '## not a heading: inside a fence\n```\n\n## Environment\n\nA cloud session.\n')

    def save_state(self, repo, text, *flags):
        r = subprocess.run([sys.executable, STATE, '--repo', repo, 'save', '-', '--as', 'STATE.md'] + list(flags),
                           input=text.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        self.assertEqual(r.returncode, 0, r.stderr)

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

    def test_never_fails_the_session(self):
        for raw in (b'', b'garbage', b'[]', b'{"hook_event_name": 5}', b'\xff\xfe',
                    json.dumps({'hook_event_name': 'SessionStart', 'session_id': 's1', 'cwd': 7}).encode(),
                    json.dumps({'hook_event_name': 'Unknown', 'session_id': 's1'}).encode()):
            r = self.run_guard('hook', stdin=raw)
            self.assertEqual((r.returncode, r.stdout), (0, b''), raw)


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

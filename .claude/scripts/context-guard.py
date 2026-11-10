#!/usr/bin/env python3
"""Context guard: the main Claude Code session hands off before its context passes 50% (stdlib only, 3.8+).

context-guard.py statusline     the status-line command: reads Claude Code's status-line JSON on stdin,
                                records this session's context usage and prints "ctx NN%" (" · handoff due"
                                added at or over the threshold).
context-guard.py hook           one hook entry for SessionStart, UserPromptSubmit, PostToolUse, Stop and
                                PreCompact; it dispatches on hook_event_name and always exits 0.
context-guard.py mark-handoff   record that a handoff was written now (/handoff runs it after saving STATE.md).
context-guard.py status         print what the guard sees for a session, as JSON.

Main session only: an event fired inside a subagent or a workflow agent (its input carries agent_id, see the
hooks reference) is ignored, so a subagent is never told to hand off.

Usage is this session's status-line record when it is under 10 minutes old, else the transcript: the last
main-chain assistant entry's message.usage (input_tokens + cache_creation_input_tokens +
cache_read_input_tokens, the formula of the status line's used_percentage) over the window size. The window
size is the status line's last context_window_size, else env PIPELINE_CONTEXT_WINDOW, else 1000000 when the
transcript's model is one whose window is 1M (the 5-series and later, Fable, Mythos, or an id ending in
[1m]), else 200000; a token count above the assumed window means the window is 1M.

At or over the threshold (env PIPELINE_HANDOFF_PCT, default 40):
  PostToolUse       additionalContext: start no new work, run /handoff, end the session and continue in a
                    fresh one. Rate-limited: the first crossing, then every further 5 points or every 10th
                    tool call.
  UserPromptSubmit  additionalContext only; the person's prompt is never blocked.
  Stop              decision "block" until a handoff is recorded after the first crossing; a Stop that
                    stop_hook_active marks as already continued is allowed, so it never loops.
  PreCompact        auto: the first one in a session is blocked with the handoff instruction; a later one is
                    allowed, with summary instructions on stdout to keep the pipeline state. manual: allowed.
SessionStart, at any usage: when the state branch has STATE.md (a git fetch of at most 10 s; env
PIPELINE_STATE_OFFLINE=1 skips it and reads the local refs), additionalContext says when the handoff was
written, to read it before acting, and quotes its ## Next section (at most 2,000 characters).

Environment:
  PIPELINE_HANDOFF_PCT     handoff threshold, percent of the context window (default 40)
  PIPELINE_CONTEXT_WINDOW  window size in tokens when no status line reports one
  PIPELINE_GUARD_DIR       per-session records (default ~/.claude/context-guard)
  PIPELINE_CONTEXT_GUARD   "off" (or 0, false, no) makes the hooks no-ops and drops "handoff due"
  PIPELINE_STATE_BRANCH    the state branch SessionStart reads (default pipeline/state)
  PIPELINE_STATE_OFFLINE   1: SessionStart does not fetch
  CLAUDE_CODE_SESSION_ID   the session mark-handoff and status act on (set by Claude Code in Bash commands)

Files in the guard directory: <session>.json (status line: used_percentage, context_window_size, at),
<session>.hook.json (crossing and rate-limit state), <session>.handoff.json and
handoff-<repo-key>.json (handoff marks), errors.log. Records older than 30 days are removed at SessionStart.
The hook never fails the session: any error exits 0 with no output (and a line in errors.log).
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time

DEFAULT_PCT = 40.0
DEFAULT_WINDOW = 200000
LARGE_WINDOW = 1000000
FRESH_SECONDS = 600            # a status-line record younger than this is preferred over the transcript
WARN_EVERY_POINTS = 5
WARN_EVERY_CALLS = 10
NEXT_MAX = 2000
FETCH_TIMEOUT = 10
KEEP_DAYS = 30
TAIL_CHUNKS = (262144, 2097152, 8388608)
STATE_BRANCH = 'pipeline/state'
# Models whose context window is 1M by default (claude-api model table): the 5-series and later, Fable, Mythos.
LARGE_MODEL = re.compile(r'\[1m\]|claude-(?:(?:opus|sonnet|haiku)-(?:[5-9]|[1-9][0-9])|fable|mythos)', re.I)
USAGE_KEYS = ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')


# ---- small helpers ----------------------------------------------------------------------------

def now():
    return time.time()


def iso(ts):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts))


def guard_dir():
    return os.environ.get('PIPELINE_GUARD_DIR') or os.path.join(os.path.expanduser('~'), '.claude',
                                                                'context-guard')


def enabled():
    return (os.environ.get('PIPELINE_CONTEXT_GUARD') or '').strip().lower() not in ('off', '0', 'false', 'no')


def threshold():
    try:
        t = float(os.environ.get('PIPELINE_HANDOFF_PCT', ''))
        if 0 < t <= 100:
            return t
    except ValueError:
        pass
    return DEFAULT_PCT


def env_window():
    try:
        w = int(os.environ.get('PIPELINE_CONTEXT_WINDOW', ''))
        return w if w > 0 else None
    except ValueError:
        return None


def number(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None


def posint(v):
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None


def safe_id(s):
    """A session id usable as a file name; anything else is hashed, so input can never name another path."""
    s = str(s or '')
    if not s:
        return None
    if re.match(r'^[A-Za-z0-9._-]{1,128}$', s) and s not in ('.', '..'):
        return s
    return hashlib.sha256(s.encode('utf-8', 'replace')).hexdigest()[:32]


def path_for(name):
    return os.path.join(guard_dir(), name)


def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = '%s.tmp.%d' % (path, os.getpid())
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, sort_keys=True)
        os.replace(tmp, path)
    finally:
        if os.path.lexists(tmp):
            os.remove(tmp)


def log_error(where, e):
    try:
        p = path_for('errors.log')
        os.makedirs(guard_dir(), exist_ok=True)
        mode = 'w' if os.path.exists(p) and os.path.getsize(p) > 65536 else 'a'
        with open(p, mode, encoding='utf-8') as f:
            f.write('%s %s: %r\n' % (iso(now()), where, e))
    except Exception:
        pass


def emit(text):
    sys.stdout.buffer.write(text.encode('utf-8'))
    sys.stdout.buffer.flush()


def git(cwd, *args, timeout=5):
    env = dict(os.environ)
    env['GIT_TERMINAL_PROMPT'] = '0'
    try:
        r = subprocess.run(['git', '-C', cwd] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           env=env, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.decode('utf-8', 'replace') if r.returncode == 0 else None


# ---- usage ------------------------------------------------------------------------------------

def statusline_record(sid):
    return read_json(path_for('%s.json' % sid)) if sid else {}


def transcript_usage(path):
    """(tokens, model) of the last main-chain assistant entry with usage in the transcript, or (None, None).
    A compaction marker after it means the context was replaced, so the old count no longer applies."""
    if not path:
        return None, None
    path = os.path.expanduser(str(path))
    try:
        size = os.path.getsize(path)
    except OSError:
        return None, None
    for chunk in TAIL_CHUNKS:
        start = max(0, size - chunk)
        try:
            with open(path, 'rb') as f:
                f.seek(start)
                data = f.read()
        except OSError:
            return None, None
        lines = data.split(b'\n')
        if start:
            lines = lines[1:]       # the first line of a tail may be cut
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            if (o.get('type') == 'system' and o.get('subtype') == 'compact_boundary') or o.get('isCompactSummary'):
                return None, None
            if o.get('type') != 'assistant' or o.get('isSidechain'):
                continue
            m = o.get('message')
            if not isinstance(m, dict) or m.get('model') == '<synthetic>' or not isinstance(m.get('usage'), dict):
                continue
            tokens = sum(int(number(m['usage'].get(k)) or 0) for k in USAGE_KEYS)
            if tokens > 0:
                return tokens, m.get('model') if isinstance(m.get('model'), str) else None
        if not start:
            break
    return None, None


def window_for(recorded, model, tokens):
    """(size, source) of the context window the transcript count is measured against."""
    if recorded:
        return recorded, 'statusline'
    w = env_window()
    if w:
        return w, 'env'
    if model and LARGE_MODEL.search(model):
        return LARGE_WINDOW, 'model'
    if tokens and tokens > DEFAULT_WINDOW:
        return LARGE_WINDOW, 'observed'   # a window cannot hold more than its size
    return DEFAULT_WINDOW, 'default'


def measure(sid, transcript_path):
    """{'pct', 'source', 'window', 'tokens', 'window_source'}: pct is None when usage is unknown."""
    rec = statusline_record(sid)
    pct = number(rec.get('used_percentage'))
    ts = number(rec.get('ts'))
    if pct is not None and ts is not None and 0 <= now() - ts < FRESH_SECONDS:
        return {'pct': pct, 'source': 'statusline', 'window': posint(rec.get('context_window_size')),
                'tokens': None, 'window_source': 'statusline'}
    tokens, model = transcript_usage(transcript_path or rec.get('transcript_path'))
    if tokens is None:
        return {'pct': None, 'source': None, 'window': None, 'tokens': None, 'window_source': None}
    window, wsrc = window_for(posint(rec.get('context_window_size')), model, tokens)
    return {'pct': tokens * 100.0 / window, 'source': 'transcript', 'window': window, 'tokens': tokens,
            'window_source': wsrc}


# ---- per-session state ------------------------------------------------------------------------

def state_file(sid):
    return path_for('%s.hook.json' % sid)


def repo_key(cwd):
    """A key for the repository cwd is in, shared by all its worktrees (its common git dir), or None."""
    common = (git(cwd, 'rev-parse', '--git-common-dir') or '').strip() if cwd else ''
    if not common:
        return None
    common = os.path.realpath(os.path.join(cwd, common))   # older git prints it relative to cwd
    return hashlib.sha256(common.encode('utf-8', 'replace')).hexdigest()[:24]


def last_handoff(sid, cwd):
    """The time of the latest recorded handoff for this session or its repository, or None."""
    marks = [read_json(path_for('%s.handoff.json' % sid)).get('ts')] if sid else []
    key = repo_key(cwd)
    if key:
        marks.append(read_json(path_for('handoff-%s.json' % key)).get('ts'))
    marks = [number(m) for m in marks if number(m) is not None]
    return max(marks) if marks else None


def track(st, pct):
    """Record the first crossing of the threshold; a measurement back under it (after a compaction) starts a
    new epoch. True when at or over the threshold."""
    if pct is None:
        return False
    if pct >= threshold():
        if not number(st.get('crossed_ts')):
            st['crossed_ts'] = now()
            st['crossed_at'] = iso(st['crossed_ts'])
            st['crossed_pct'] = round(pct, 1)
        return True
    for k in ('crossed_ts', 'crossed_at', 'crossed_pct', 'last_warn_pct', 'calls_since_warn'):
        st.pop(k, None)
    return False


# ---- messages ---------------------------------------------------------------------------------

CONTINUE = 'start a new session in this repository and say "Continue from the pipeline handoff"'


def usage_text(m):
    w = m.get('window')
    return '%d%% of its %s-token window' % (round(m['pct']), '{:,}'.format(w)) if w else '%d%%' % round(m['pct'])


def msg_post(m, handed):
    head = ('Context guard: this session\'s context is at %s, at or over the pipeline\'s handoff threshold of '
            '%g%% (PIPELINE_HANDOFF_PCT).' % (usage_text(m), threshold()))
    if handed:
        return (head + ' A handoff was saved at %s. If anything has changed since, run /handoff again; then '
                'end the session. To continue, the person will %s.' % (iso(handed), CONTINUE))
    return (head + ' The pipeline rule from here: start no new work; finish or park the step in progress; run '
            '/handoff, which saves STATE.md to the state branch; then end the session. The work continues in a '
            'fresh session: %s.' % CONTINUE)


def msg_prompt(m, handed):
    head = ('Context guard: this session\'s context is at %s, over the pipeline\'s handoff threshold of %g%%.'
            % (usage_text(m), threshold()))
    if handed:
        return (head + ' A handoff was saved at %s. Answer this message; for further pipeline work, run /handoff '
                'again if anything changed, and tell the person to %s.' % (iso(handed), CONTINUE))
    return (head + ' Answer this message, but start no new pipeline work in this session: run /handoff, then '
            'tell the person to %s.' % CONTINUE)


def msg_stop(m):
    return ('Context guard: this session\'s context is at %s, at or over the pipeline\'s handoff threshold of '
            '%g%%, and no handoff has been saved since it crossed it. Run /handoff now (it saves STATE.md to the '
            'state branch and records the handoff), then end your turn telling the person to %s. If the '
            'handoff cannot be saved, say so plainly.' % (usage_text(m), threshold(), CONTINUE))


MSG_PRECOMPACT_BLOCK = ('Context guard: this auto-compaction was blocked once, because the pipeline hands off '
                        'instead of compacting. Run /handoff, then %s. The next auto-compaction in this session '
                        'is allowed.' % CONTINUE)

SUMMARY_INSTRUCTIONS = (
    'Keep the pipeline state in this summary, exact where it is exact: the goal; each workflow run in flight or '
    'stopped, with its exact args; branches and open pull requests; open questions with their ids, options and '
    'the recommendation; the answers the person gave, by question id; assumptions not yet reviewed; environment '
    'notes; and the exact next action. Keep this too: the context guard asked for a handoff, so the first thing '
    'after this compaction is to run /handoff (it saves STATE.md to the state branch) and end the session; the '
    'work continues in a fresh session.')


# ---- SessionStart: the handoff on the state branch ----------------------------------------------

FENCE = re.compile(r'^\s*(`{3,}|~{3,})(.*)$')


def section(text, name):
    """The body of the `## <name>` section, up to the next heading outside a code fence, or ''."""
    body, inside, fence = [], False, None
    for line in text.splitlines():
        m = FENCE.match(line)
        if fence is not None:
            # only the same fence character, at least as long, with nothing after it, closes a fence
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not m.group(2).strip():
                fence = None
        elif m:
            fence = m.group(1)
        elif line.startswith(('# ', '## ')):
            if inside:
                break
            inside = line.rstrip() == '## ' + name
            continue
        if inside:
            body.append(line)
    return '\n'.join(body).strip()


def ago(seconds):
    seconds = max(0, int(seconds))
    for unit, n in (('day', 86400), ('hour', 3600), ('minute', 60)):
        if seconds >= n:
            k = seconds // n
            return '%d %s%s ago' % (k, unit, '' if k == 1 else 's')
    return 'just now'


def handoff_context(cwd):
    branch = os.environ.get('PIPELINE_STATE_BRANCH') or STATE_BRANCH
    if not cwd or not re.match(r'^[A-Za-z0-9._/-]+$', branch) or '..' in branch:
        return None
    if git(cwd, 'rev-parse', '--git-dir') is None:
        return None
    local, track_ref = 'refs/heads/' + branch, 'refs/remotes/origin/' + branch
    order = [local, track_ref]
    if os.environ.get('PIPELINE_STATE_OFFLINE') != '1' and git(cwd, 'remote', 'get-url', 'origin') is not None:
        fetched = git(cwd, 'fetch', '--quiet', '--no-tags', 'origin', '+%s:%s' % (local, track_ref),
                      timeout=FETCH_TIMEOUT)
        if fetched is not None:
            order = [track_ref, local]
    for ref in order:
        text = git(cwd, 'show', '%s:STATE.md' % ref)
        if text is None:
            continue
        stamp = (git(cwd, 'log', '-1', '--format=%ct', ref, '--', 'STATE.md') or '').strip()
        when = ''
        if stamp.isdigit():
            when = ', saved %s (%s)' % (iso(int(stamp)).replace('T', ' ').replace('Z', ' UTC'),
                                        ago(now() - int(stamp)))
        nxt = section(text, 'Next')
        if len(nxt) > NEXT_MAX:
            nxt = nxt[:NEXT_MAX].rstrip() + '\n[cut at %d characters; read STATE.md]' % NEXT_MAX
        where = 'origin\'s state branch' if ref == track_ref else 'the local state branch'
        msg = ('This repository has a pipeline handoff: STATE.md on %s %s%s. Read it before acting: '
               'python3 .claude/scripts/pipeline-state.py get STATE.md%s' % (
                   where, branch, when, '' if ref == track_ref else ' --local'))
        return msg + ('\n\nIts ## Next section:\n\n' + nxt if nxt else '\n\nIt has no ## Next section.')
    return None


def cleanup():
    cutoff = now() - KEEP_DAYS * 86400
    d = guard_dir()
    try:
        names = os.listdir(d)
    except OSError:
        return
    for n in names:
        if n.endswith('.json') or '.json.tmp.' in n:
            p = os.path.join(d, n)
            try:
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass


# ---- hook events --------------------------------------------------------------------------------

def in_subagent(ev):
    """The hooks reference: agent_id is present when a hook fires inside a subagent (workflow agents are
    subagents too); agent_type alone also marks a main session started with --agent, so it does not count."""
    if ev.get('agent_id') or ev.get('agent_transcript_path'):
        return True
    return '/subagents/' in str(ev.get('transcript_path') or '').replace('\\', '/')


def additional(event, text):
    return json.dumps({'hookSpecificOutput': {'hookEventName': event, 'additionalContext': text}})


def on_session_start(ev, sid, st):
    st['main_transcript'] = ev.get('transcript_path')
    st['source'] = ev.get('source')
    cleanup()
    text = handoff_context(ev.get('cwd') or os.environ.get('CLAUDE_PROJECT_DIR') or os.getcwd())
    return additional('SessionStart', text) if text else None


def on_prompt(ev, sid, st):
    m = measure(sid, ev.get('transcript_path'))
    if not track(st, m['pct']):
        return None
    handed = last_handoff(sid, ev.get('cwd'))
    handed = handed if handed and handed >= st['crossed_ts'] else None
    return additional('UserPromptSubmit', msg_prompt(m, handed))


def on_post_tool(ev, sid, st):
    m = measure(sid, ev.get('transcript_path'))
    if not track(st, m['pct']):
        return None
    last = number(st.get('last_warn_pct'))
    calls = int(number(st.get('calls_since_warn')) or 0) + 1
    if last is not None and m['pct'] < last + WARN_EVERY_POINTS and calls < WARN_EVERY_CALLS:
        st['calls_since_warn'] = calls
        return None
    st['last_warn_pct'] = round(m['pct'], 1)
    st['calls_since_warn'] = 0
    handed = last_handoff(sid, ev.get('cwd'))
    handed = handed if handed and handed >= st['crossed_ts'] else None
    return additional('PostToolUse', msg_post(m, handed))


def on_stop(ev, sid, st):
    if ev.get('stop_hook_active'):
        return None
    m = measure(sid, ev.get('transcript_path'))
    if not track(st, m['pct']):
        return None
    handed = last_handoff(sid, ev.get('cwd'))
    if handed and handed >= st['crossed_ts']:
        return None
    return json.dumps({'decision': 'block', 'reason': msg_stop(m)})


def on_precompact(ev, sid, st):
    if ev.get('trigger') == 'manual':
        return None
    m = measure(sid, ev.get('transcript_path'))
    if m['pct'] is not None and m['pct'] < threshold():
        return SUMMARY_INSTRUCTIONS        # under the threshold (an idle compaction): nothing to hand off yet
    if not st.get('precompact_blocked'):
        st['precompact_blocked'] = iso(now())
        return json.dumps({'decision': 'block', 'reason': MSG_PRECOMPACT_BLOCK})
    return SUMMARY_INSTRUCTIONS            # a second auto-compaction goes ahead: a guard failure never bricks it


HANDLERS = {'SessionStart': on_session_start, 'UserPromptSubmit': on_prompt, 'PostToolUse': on_post_tool,
            'Stop': on_stop, 'PreCompact': on_precompact}


def cmd_hook():
    try:
        ev = json.loads(sys.stdin.buffer.read().decode('utf-8', 'replace'))
        if not isinstance(ev, dict) or not enabled() or in_subagent(ev):
            return 0
        handler = HANDLERS.get(ev.get('hook_event_name'))
        sid = safe_id(ev.get('session_id'))
        if handler is None or sid is None:
            return 0
        st = read_json(state_file(sid))
        result = handler(ev, sid, st)
        st['updated_at'] = iso(now())
        write_json(state_file(sid), st)
        if result:
            emit(result)
    except Exception as e:   # never fail the session
        log_error('hook', e)
    return 0


# ---- status line, marks, status -----------------------------------------------------------------

def cmd_statusline():
    pct = None
    try:
        d = json.loads(sys.stdin.buffer.read().decode('utf-8', 'replace'))
        if not isinstance(d, dict):
            raise ValueError('not an object')
        cw = d.get('context_window') if isinstance(d.get('context_window'), dict) else {}
        size = posint(cw.get('context_window_size'))
        pct = number(cw.get('used_percentage'))
        cu = cw.get('current_usage')
        if pct is None and size and isinstance(cu, dict):
            tokens = sum(int(number(cu.get(k)) or 0) for k in USAGE_KEYS)
            pct = tokens * 100.0 / size if tokens else None
        sid = safe_id(d.get('session_id'))
        if sid:
            t = now()
            write_json(path_for('%s.json' % sid), {
                'used_percentage': pct, 'context_window_size': size, 'at': iso(t), 'ts': t,
                'transcript_path': d.get('transcript_path') if isinstance(d.get('transcript_path'), str) else None,
                'exceeds_200k_tokens': d.get('exceeds_200k_tokens') is True})
    except Exception as e:
        log_error('statusline', e)
    line = 'ctx %d%%' % round(pct) if pct is not None else 'ctx --'
    if pct is not None and enabled() and pct >= threshold():
        line += ' · handoff due'
    emit(line + '\n')
    return 0


def session_arg(argv):
    if '--session' in argv:
        i = argv.index('--session')
        return argv[i + 1] if i + 1 < len(argv) else ''
    return os.environ.get('CLAUDE_CODE_SESSION_ID') or ''


def cmd_mark_handoff(argv):
    sid = safe_id(session_arg(argv))
    t = now()
    rec = {'at': iso(t), 'ts': t, 'session_id': sid}
    written = []
    try:
        if sid:
            write_json(path_for('%s.handoff.json' % sid), rec)
            written.append('session')
        key = repo_key(os.getcwd())
        if key:
            write_json(path_for('handoff-%s.json' % key), rec)
            written.append('repository')
    except OSError as e:
        print('context-guard: cannot record the handoff in %s: %s' % (guard_dir(), e), file=sys.stderr)
        return 2
    if not written:
        print('context-guard: no session id (CLAUDE_CODE_SESSION_ID or --session) and not in a git repository; '
              'nothing recorded', file=sys.stderr)
        return 2
    print(json.dumps({'marked': True, 'at': rec['at'], 'session_id': sid, 'scope': written}))
    return 0


def cmd_status(argv):
    sid = safe_id(session_arg(argv))
    transcript = argv[argv.index('--transcript') + 1] if '--transcript' in argv[:-1] else None
    st = read_json(state_file(sid)) if sid else {}
    m = measure(sid, transcript or st.get('main_transcript'))
    handed = last_handoff(sid, os.getcwd())
    print(json.dumps({'session_id': sid, 'enabled': enabled(), 'threshold': threshold(), 'usage': m,
                      'over': m['pct'] is not None and m['pct'] >= threshold(),
                      'crossed_at': st.get('crossed_at'), 'handoff_at': iso(handed) if handed else None,
                      'precompact_blocked': st.get('precompact_blocked'), 'guard_dir': guard_dir()}, indent=2))
    return 0


def main(argv):
    cmd = argv[0] if argv else ''
    if cmd == 'statusline':
        return cmd_statusline()
    if cmd == 'hook':
        return cmd_hook()
    if cmd == 'mark-handoff':
        return cmd_mark_handoff(argv[1:])
    if cmd == 'status':
        return cmd_status(argv[1:])
    print('usage: context-guard.py statusline | hook | mark-handoff [--session ID] | status [--session ID] '
          '[--transcript PATH]', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

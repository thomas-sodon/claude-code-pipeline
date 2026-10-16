Review the changes on the current branch (read-only) and classify findings as bug / concern / suggestion / nit.

`$ARGUMENTS` selects scope:
- *(empty)* — auto: `all` when both uncommitted and committed-vs-`<base>` work exist; otherwise whichever side has work; otherwise stop
- `uncommitted` — only the working-tree diff (staged + unstaged + untracked)
- `committed[:<base>]` — only commits on this branch not on `<base>`
- `all[:<base>]` — both uncommitted and committed since branching from `<base>`

`<base>` defaults to `$MAIN_BRANCH`; pass `:<base>` (e.g. `committed:feat/parent`, `all:origin/release/v2`) for a stacked or release branch. A malformed `:<base>` — empty after the colon, or containing whitespace — is a stop, never a silent fallback.

## Project configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines):

- `MAIN_BRANCH` — default base; defaults to `main`.
- `PLANS_DIR` — where plan files live; defaults to `~/.claude/plans`.
- `QUALITY_GATES` / `QUALITY_GATES_FAST` / `GATE_WRAPPER` — used only if you choose to run the gates (Step 9). If `QUALITY_GATES` is missing, note `error=missing_quality_gates` in the review and ask the user to add it; the review itself still proceeds.
- `TEST_GUIDELINES` — where the project's testing rules live; defaults to the project's `CLAUDE.md`.

## Steps

1. **Pull plan context.** Before reading the diff, recover what the branch was *trying* to do.

   **1a — Plan file (primary).** Read `~/.claude/last-plan-by-folder.json` (keyed by absolute working directory, maintained by `/plan`). If this directory's entry points at an existing, non-empty plan, use it and announce `Plan context: <path> (written <written_at>)`. Otherwise fall back to the most recently modified non-empty `*.md` in `$PLANS_DIR` and warn `No folder plan pointer — using the most-recent plan globally; verify it matches this branch`. If none exists, `plan_path` is null. Read the plan in full: goal, files/symbols touched, verification/acceptance criteria. If most paths it cites do not exist in the tree, warn that it looks unrelated, set `plan_path` to null, and lean on 1b and the code. Never edit the plan.

   **1b — Session transcript (supplement).** Claude Code stores sessions under `~/.claude/projects/<slug>/`, where `<slug>` is the absolute working directory with every non-alphanumeric character replaced by `-`. From the most recent non-empty `.jsonl` there, extract the first user message, any `ExitPlanMode` plan inputs, and the final `TodoWrite` snapshot. These files are large — parse them with a script, never Read them whole:

   ```bash
   python3 - <<'PY'
   import json, os, glob, re
   d = os.path.expanduser("~/.claude/projects/" + re.sub(r"[^A-Za-z0-9]", "-", os.getcwd()))
   files = sorted((f for f in glob.glob(d + "/*.jsonl") if os.path.getsize(f) > 0),
                  key=os.path.getmtime, reverse=True)
   if not files:
       print(f"NO_SESSION (looked in {d})"); raise SystemExit
   first, plans, todos = None, [], []
   for line in open(files[0]):
       try: o = json.loads(line)
       except Exception: continue
       if o.get("type") == "user" and first is None:
           c = o.get("message", {}).get("content")
           parts = [c] if isinstance(c, str) else [p.get("text", "") for p in c or [] if isinstance(p, dict) and p.get("type") == "text"]
           first = next((t.strip() for t in parts if t.strip() and not t.lstrip().startswith("<")), None)
       if o.get("type") == "assistant":
           for p in o.get("message", {}).get("content", []) or []:
               if isinstance(p, dict) and p.get("type") == "tool_use":
                   if p.get("name") == "ExitPlanMode": plans.append(p.get("input", {}).get("plan", ""))
                   elif p.get("name") == "TodoWrite": todos = p.get("input", {}).get("todos", [])
   print("ORIGINAL REQUEST:\n" + (first or "")[:2000])
   for i, p in enumerate(plans, 1): print(f"\nAPPROVED PLAN #{i}:\n{p[:2000]}")
   for t in todos: print(f"  [{t.get('status', '?')}] {t.get('content', '')}")
   PY
   ```

   **Synthesize** a 3–5 line **Plan Context**: the plan file is the authoritative intent; the transcript supplies the original ask and what landed (and its `ExitPlanMode` plan stands in when there is no plan file). Prefer the plan file when they disagree and note the divergence. If nothing was recovered, say so — never invent intent. If the context is unrelated to the diff, say so and set `plan_path` to null.

   Then recall this branch's **review-findings ledger** (below).

2. **Determine scope.** Parse `$ARGUMENTS` first.
   - **`uncommitted`**: no base needed — skip base resolution entirely; run `git status --porcelain` and go to Step 3.
   - **Otherwise**: `<base>` is the `:<base>` suffix if given, else `$MAIN_BRANCH`. Stop on a malformed suffix. Verify with `git rev-parse --verify <base>`; if it fails, stop naming the missing base — never fall back silently.
   - Run `git status --porcelain`, `git rev-parse --abbrev-ref HEAD`, and `git rev-list --left-right --count <base>...HEAD` (the right count `N` is commits ahead of `<base>`).
   - Explicit `committed`/`all` are honoured. Empty: uncommitted work **and** `N > 0` → `all`; only uncommitted → `uncommitted`; only `N > 0` → `committed`; neither → stop, nothing to review.

3. **Gather the diff.**
   - Uncommitted: `git diff HEAD` plus untracked files from `git status --porcelain`. Bound untracked reads: skip or head-truncate (~50 KB) any file over 50 KB, and skip build/vendor/artifact directories (e.g. `node_modules/`, `dist/`, `build/`, `.venv/`, `__pycache__/`, `logs/`); note each skip.
   - Committed: `git diff <base>...HEAD` and `git log <base>..HEAD --oneline`.
   - All: both, reviewed as one change.

4. **Understand the change.** Read every modified/added file in full. Grep for callers, tests, and type definitions of changed symbols. Classify the change (bug fix, feature, refactor, config, test-only, docs). Cross-check against the Plan Context: plan items with no code, and code with no motivating plan item, are both findings.

5. **Check project rules.** The change must respect the architecture invariants and conventions in the project's `CLAUDE.md` (and any docs it points to). Ground each claim in today's tree — cite the code, not memory. Any new data flowing into a prompt, log, or persisted file must be bounded.

6. **Look for bugs and logic errors.** Off-by-one, edge cases, null/empty handling; races in async code or file I/O; unbounded growth; exceptions caught at the wrong level or swallowed; type escape hatches; command injection, path traversal, secrets in logs.

7. **Evaluate tests.** Every new function, branch, and error path needs a test that exercises real logic (not only the happy path) and follows `TEST_GUIDELINES`. A bug fix needs a regression test that would have caught it.

8. **Check docs and leftovers.** If modules, CLI/public interfaces, or documented design decisions changed, `CLAUDE.md` and docs must match. Flag debug output, commented-out code, context-free `TODO`/`FIXME`, breakpoints, hard-coded paths, secrets; for uncommitted scope, flag staged secret files.

9. **Gates (optional).** You may run the gates — `$GATE_WRAPPER bash -c '<QUALITY_GATES>'` when `GATE_WRAPPER` is set (the text of `QUALITY_GATES` between the single quotes; write any `'` inside the gate command as `'\''`), else `$QUALITY_GATES` — in the foreground (Bash `timeout` `600000`) to confirm the change would pass, but never modify code here.

10. **Assess the "why".** Did the change solve the stated problem? Did planned items fail to land? Is there a simpler approach? Plan/diff disagreement is a finding.

11. **Persist the ledger** (below) — on every run, clean or not. This is the command's only write.

12. **Hand off — do not fix.** Never invoke `/polish` from here. Recommend it in a fresh session when there are findings; it recalls the ledger and fixes every recorded finding. If the scope is `committed` only and the working tree is clean, `/polish` cannot apply the findings — ask the user how to proceed (revert, follow-up branch, fix-forward).

## Severities

- **bug** — will cause incorrect behavior; blocks merge.
- **concern** — design, safety, or invariant issue that needs discussion; may block merge.
- **suggestion** — a meaningful improvement; not blocking alone.
- **nit** — trivial polish (wording, naming, small cleanup); never blocking.

## Review-findings ledger

A durable per-branch record at `~/.claude/reviews/<branch-slug>.json` (outside the repo) so a later `/review-changes` or `/polish` can recall what was raised and what has been fixed. `<branch-slug>`: branch name lowercased, non-alphanumeric runs → `-`, repeats collapsed, leading/trailing `-` trimmed (e.g. `feat/42-foo` → `feat-42-foo`). On a detached HEAD, skip the ledger and say so.

    {
      "repo": "<absolute working directory>",
      "branch": "<full branch name>",
      "base": "<base used, or null for uncommitted scope>",
      "plan_context": "<Plan Context from step 1, ≤800 chars, or null>",
      "plan_path": "<absolute plan file path, or null>",
      "updated_at": "2026-01-01T12:00:00Z",
      "findings": [
        {
          "id": "r1",
          "severity": "bug",          // bug | concern | suggestion | nit
          "file": "src/parser.ts",
          "line": 42,                  // best-effort; never the match key
          "title": "off-by-one in chunk split",
          "detail": "<one or two lines: why it matters + the fix>",
          "status": "new",             // new | open | fixed
          "first_seen": "2026-01-01T12:00:00Z",
          "resolved_at": null
        }
      ]
    }

**Recall.** Treat the file as absent when missing, malformed (warn; never overwrite blindly), or when its `repo`/`branch` do not match this working directory and branch.

**Persist & reconcile** (after the review is written; timestamps `YYYY-MM-DDTHH:MM:SSZ` UTC):
1. Match recalled findings to this run's by `file` + semantic `title`, never by line.
2. Recalled `new`/`open` still present → `open`, keep `first_seen`, refresh `line`/`detail`. Recalled `new`/`open` absent → `fixed`, `resolved_at` now (report as *fixed since last review*). Recalled `fixed` that reappears → `open`, clear `resolved_at`, call it a **regression**. Unmatched new finding → append with next `r<N>`, `status: new`. Recalled `fixed` still absent → leave as history.
3. Set `plan_context`/`plan_path` from step 1; if this run recovered none, keep the prior values rather than clearing them.
4. Set `repo`, `branch`, `base`, `updated_at`; create `~/.claude/reviews/` if needed; write `<branch-slug>.json.tmp.<pid>` then rename. On failure, warn and continue — the ledger is an aid, not a correctness requirement. Never overwrite a malformed or foreign file.

## What to skip

- Style and formatting the project's linters/formatters already enforce.
- Annotation tweaks on obvious cases.
- Naming preferences unless genuinely confusing (at most a nit).
- Changes outside the diff.

## Output format

Plain text in the response:

1. Scope header: `Scope: uncommitted` / `Scope: committed (N commits vs <base>)` / `Scope: all (N commits vs <base>)`.
2. **Plan Context** (3–5 lines), or one line saying it was unavailable.
3. A 2–3 sentence summary and overall assessment.
4. Findings grouped **Bugs**, **Concerns**, **Suggestions**, **Nits** — each with `path:line`, the quoted code, what is wrong, why it matters, and a concrete fix or question.
5. **Ledger** line (unless skipped): new, carried over, fixed since last review, regressions.

If the change is good, say so briefly — don't manufacture issues. End with exactly one of:
- `Run /polish in a fresh session to apply fixes — it will recall the ledger and fix every recorded finding.`
- `No fixes needed; no /polish required.`
- `Findings are in committed scope with no uncommitted edits; /polish cannot apply them. <question for the user>`

## Safety

- Read-only: never modify the repo working tree. The sole write is the ledger under `~/.claude/reviews/`.
- Never invoke `/polish` from this command.
- Read-only against `$PLANS_DIR`, `~/.claude/last-plan-by-folder.json`, and session transcripts.
- Do not commit, push, stage, unstage, stash, or discard changes; no destructive git operations (`reset --hard`, `checkout --`, `clean -f`, branch deletes).

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

   **1a — Plan file (primary).** Read `~/.claude/last-plan-by-folder.json` (keyed by absolute working directory, maintained by `/plan`). If this directory's entry points at an existing, non-empty plan, use it and announce `Plan context: <path> (written <written_at>)`. Otherwise fall back to the most recently modified non-empty `*.md` in `$PLANS_DIR` and warn `No folder plan pointer — using the most-recent plan globally; verify it matches this branch`. If none exists, `plan_path` is null. Read the plan in full: goal, files/symbols touched, verification/acceptance criteria, and its `## Rollout` if any. If most paths it cites do not exist in the tree, warn that it looks unrelated, set `plan_path` to null, and lean on 1b and the code. Never edit the plan.

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

   **1c — Proposal.** When the plan's Context (or the caller) names a proposal or design doc, read its named steps and its `## Security and privacy` and `## Rollout and operations` sections; Steps 5 and 6 judge the diff against them too. A named doc that does not exist is a concern, not a stop.

   Then recall this branch's **review-findings ledger** (below).

2. **Determine scope.** Parse `$ARGUMENTS` first.
   - **`uncommitted`**: no base needed — skip base resolution entirely; run `git status --porcelain` and go to Step 3.
   - **Otherwise**: `<base>` is the `:<base>` suffix if given, else `$MAIN_BRANCH`. Stop on a malformed suffix. Verify with `git rev-parse --verify <base>`; if it fails, stop naming the missing base — never fall back silently.
   - Run `git status --porcelain`, `git rev-parse --abbrev-ref HEAD`, and `git rev-list --left-right --count <base>...HEAD` (the right count `N` is commits ahead of `<base>`).
   - Explicit `committed`/`all` are honoured. Empty: uncommitted work **and** `N > 0` → `all`; only uncommitted → `uncommitted`; only `N > 0` → `committed`; neither → stop, nothing to review.

3. **Gather the diff.**
   - Uncommitted: `git diff HEAD` plus untracked files from `git status --porcelain`. Bound untracked reads: head-truncate (~50 KB) any text file over 50 KB, and skip build/vendor/artifact directories (e.g. `node_modules/`, `dist/`, `build/`, `.venv/`, `__pycache__/`, `logs/`); note each truncation and skip.
   - Committed: `git diff <base>...HEAD` and `git log <base>..HEAD --oneline`.
   - All: both, reviewed as one change.
   - **Fixture and data files.** In every scope, list each file added under a test-fixture or data directory (e.g. `fixtures/`, `__fixtures__/`, `testdata/`, `test/data/`, `data/`, `samples/`, `seeds/`) — from `git diff --name-status --diff-filter=A` over the scope's range plus untracked files — with its size and type (`file -b`), including large and binary ones the diff elides and ones over the read bound. None is ever silently skipped; each is judged in Step 5.

4. **Understand the change.** Read every modified/added file in full. Grep for callers, tests, and type definitions of changed symbols. Classify the change (bug fix, feature, refactor, config, test-only, docs). Cross-check against the Plan Context: plan items with no code, and code with no motivating plan item, are both findings.

5. **Check project rules.** The change must respect the architecture invariants and conventions in the project's `CLAUDE.md` (and any docs it points to). Ground each claim in today's tree — cite the code, not memory. Any new data flowing into a prompt, log, or persisted file must be bounded.
   - **Data handling.** Trace personal data (names, emails, addresses, phone or account numbers, identifiers) into fixtures, logs, error messages, analytics events, prompts sent to third-party APIs, and persisted data; judge each against the `CLAUDE.md` invariants and the proposal's Security and privacy. Breaking an invariant is a bug; an unjudged new flow is a concern. A listed fixture or data file that could hold personal data or secrets, with no provenance or redaction note beside it (a README in its directory, a header comment, a sidecar), is a concern.
   - **Deploy readiness.** A migration, new env var or secret, feature flag or scheduled job in the diff with no entry in the plan's `## Rollout` (or the proposal's Rollout and operations) is a concern. A destructive or non-reversible migration (dropping or renaming a table or column, a data-rewriting backfill, a narrowing type change) with no stated plan for it (backup, expand/contract, rollback) is a bug.

6. **Look for bugs and logic errors.** Off-by-one, edge cases, null/empty handling; races in async code or file I/O; unbounded growth; exceptions caught at the wrong level or swallowed; type escape hatches; command injection, path traversal, secrets in logs.

7. **Evaluate tests.** Every new function, branch, and error path needs a test that exercises real logic (not only the happy path) and follows `TEST_GUIDELINES`. A bug fix needs a regression test that would have caught it.

8. **Check docs and leftovers.** If modules, CLI/public interfaces, or documented design decisions changed, `CLAUDE.md` and docs must match. Flag debug output, commented-out code, context-free `TODO`/`FIXME`, breakpoints, hard-coded paths, secrets; for uncommitted scope, flag staged secret files.

9. **Gates (optional).** You may run the gates — `$GATE_WRAPPER bash -c '<QUALITY_GATES>'` when `GATE_WRAPPER` is set (the text of `QUALITY_GATES` between the single quotes; write any `'` inside the gate command as `'\''`), else `$QUALITY_GATES` — in the foreground (Bash `timeout` `600000`) to confirm the change would pass, but never modify code here.

10. **Assess the "why".** Did the change solve the stated problem? Did planned items fail to land? Is there a simpler approach? Plan/diff disagreement is a finding.

11. **Persist the ledger** (below) — on every run, clean or not. It and its copy on the state branch are the command's only writes.

12. **Hand off — do not fix.** Never invoke `/polish` from here. Recommend it in a fresh session when there are findings; it recalls the ledger and fixes every recorded finding. If the scope is `committed` only and the working tree is clean, `/polish` cannot apply the findings — ask the user how to proceed (revert, follow-up branch, fix-forward).

## Severities

- **bug** — will cause incorrect behavior; blocks merge.
- **concern** — design, safety, or invariant issue that needs discussion; may block merge.
- **suggestion** — a meaningful improvement; not blocking alone.
- **nit** — trivial polish (wording, naming, small cleanup); never blocking.

## Review-findings ledger

A durable per-branch record at `~/.claude/reviews/<branch-slug>.json` (outside the repo) so a later `/review-changes` or `/polish` can recall what was raised and what has been fixed. `<branch-slug>`: branch name lowercased, non-alphanumeric runs → `-`, repeats collapsed, leading/trailing `-` trimmed (e.g. `feat/42-foo` → `feat-42-foo`). On a detached HEAD, skip the ledger and say so.

A copy lives on the repository's state branch (origin's `pipeline/state`, written by `.claude/scripts/pipeline-state.py` without a checkout) at `reviews/<state-slug>.json`, so the ledger outlives the container that wrote it. `<state-slug>` is what `python3 .claude/scripts/pipeline-state.py slug <branch>` prints: the state branch's spelling, which keeps apart branches that read the same once replaced (`feat/42-foo` → `feat-42-foo-ebcc2a79`, while `feat-42-foo` stays `feat-42-foo`) and can differ from `<branch-slug>`. Run the script; never spell it by hand.

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

**Recall.** When `~/.claude/reviews/<branch-slug>.json` is missing, first restore it from the state branch: `python3 .claude/scripts/pipeline-state.py get reviews/<state-slug>.json --to ~/.claude/reviews/<branch-slug>.json`. Exit 3 → none was saved; exit 2 → the state branch is unreachable: say so and go on without it. A restored ledger is this repository's, written from another checkout (another container's path), so when its `branch` matches, set its `repo` to this working directory right away; one whose `branch` differs is deleted again. Then treat the file as absent when missing, malformed (warn; never overwrite blindly), or when its `repo`/`branch` do not match this working directory and branch.

**Persist & reconcile** (after the review is written; timestamps `YYYY-MM-DDTHH:MM:SSZ` UTC):
1. Match recalled findings to this run's by `file` + semantic `title`, never by line.
2. Recalled `new`/`open` still present → `open`, keep `first_seen`, refresh `line`/`detail`. Recalled `new`/`open` absent → `fixed`, `resolved_at` now (report as *fixed since last review*). Recalled `fixed` that reappears → `open`, clear `resolved_at`, call it a **regression**. Unmatched new finding → append with next `r<N>`, `status: new`. Recalled `fixed` still absent → leave as history.
3. Set `plan_context`/`plan_path` from step 1; if this run recovered none, keep the prior values rather than clearing them.
4. Set `repo`, `branch`, `base`, `updated_at`; create `~/.claude/reviews/` if needed; write `<branch-slug>.json.tmp.<pid>` then rename. On failure, warn and continue — the ledger is an aid, not a correctness requirement. Never overwrite a malformed or foreign file.
5. Once the write succeeded, save a copy to the state branch, best effort: `python3 .claude/scripts/pipeline-state.py save ~/.claude/reviews/<branch-slug>.json --as reviews/<state-slug>.json -m "review ledger: <branch>"`. Exit 2 (no origin, offline, a push still rejected after its retries) → warn in the Ledger line and go on; the local ledger stands.

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
4. Findings grouped **Bugs**, **Concerns**, **Suggestions**, **Nits** — each with `path:line`, the quoted code (secrets and personal data redacted), what is wrong, why it matters, and a concrete fix or question.
5. **Fixture and data files** (when Step 3 listed any): `path — size — type — provenance note found / missing`.
6. **Ledger** line (unless skipped): new, carried over, fixed since last review, regressions; whether it was restored from the state branch, and whether its copy reached the state branch (or why not).

If the change is good, say so briefly — don't manufacture issues. End with exactly one of:
- `Run /polish in a fresh session to apply fixes — it will recall the ledger and fix every recorded finding.`
- `No fixes needed; no /polish required.`
- `Findings are in committed scope with no uncommitted edits; /polish cannot apply them. <question for the user>`

## Safety

- Read-only: never modify the repo working tree. The sole writes are the ledger under `~/.claude/reviews/` and its copy on the state branch (a commit `pipeline-state.py` pushes to origin's `pipeline/state` without touching the checkout).
- Never invoke `/polish` from this command.
- Read-only against `$PLANS_DIR`, `~/.claude/last-plan-by-folder.json`, design docs, and session transcripts.
- Never quote credentials or personal data (names, addresses, phone or account numbers) into the review or the ledger; cite the file and line and redact the value.
- Do not commit, push (beyond the ledger's state-branch save), stage, unstage, stash, or discard changes; no destructive git operations (`reset --hard`, `checkout --`, `clean -f`, branch deletes).

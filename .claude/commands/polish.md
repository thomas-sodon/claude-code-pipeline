Review the current uncommitted changes, fix any bugs found (plus every open review-ledger finding), and run the quality gates.

This is the pre-commit polish workflow: review → fix bugs and **all** open review-ledger findings → record any *fresh* unresolved findings back to the ledger → verify gates pass. It does not commit, push, or open a PR — use `/create-pr` (or commit and push yourself) once this completes cleanly. A fix that is the person's call is asked first, never applied on a guess and never set aside for later (see *Questions before assumptions*).

## Project configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines):

- `QUALITY_GATES` — required. If missing, stop with `error=missing_quality_gates` and ask the user to add it.
- `QUALITY_GATES_FAST` — optional quicker subset for iterative re-runs; defaults to `QUALITY_GATES`.
- `GATE_WRAPPER` — optional prefix for every gate run (e.g. `.claude/scripts/gate-slot.sh`); none by default.
- `PLANS_DIR` — defaults to `~/.claude/plans`.
- `TEST_GUIDELINES` — where the project's testing rules live; defaults to the project's `CLAUDE.md`.

## Flags

`$ARGUMENTS` may contain (whitespace-separated, order-independent):

- `--fix-suggestions` — also fix **fresh** Suggestions and Nits discovered in this run. Without it, fresh Suggestions/Nits are reported and appended to the ledger (Step 10) so a later `/polish` fixes them. This flag never affects ledger findings: every open ledger finding is a fix target with or without it.

Any other tokens are free-form context (e.g. a findings list pasted from `/review-changes`).

## Steps

1. **Verify there is work.** `git status --porcelain`; if empty, stop — nothing to polish.

2. **Gather the diff.** `git diff HEAD` (staged + unstaged), read every untracked text file from `git status --porcelain` in full, and note the branch (`git rev-parse --abbrev-ref HEAD`). Recall this branch's **review-findings ledger** (below) so findings from a prior `/review-changes` session are in scope even without `$ARGUMENTS`. List every file added under a test-fixture or data directory (e.g. `fixtures/`, `__fixtures__/`, `testdata/`, `test/data/`, `data/`, `samples/`, `seeds/`) with its size and type (`file -b`), large and binary ones included — none is silently skipped; Step 4 judges each.

3. **Understand the change.** Read every modified/added file in full, not just the hunks. Trace callers and tests with Grep where logic is non-trivial. Classify each file: bug fix, feature, refactor, config, test-only, docs. Check the change against the invariants and rules in the project's `CLAUDE.md` — a violation is a bug.

4. **Look for bugs.** A *bug* is incorrect behavior, a leak, a race, a broken invariant, or a missing test for new behavior; a *suggestion* is taste, naming, or cosmetic refactor. Look for:
   - Off-by-one, missing edge cases, null / empty-collection handling
   - Races in async code or file operations
   - Unbounded growth (lists, strings, files, prompt inputs)
   - Errors caught at the wrong level or swallowed silently
   - Type escape hatches hiding real type bugs
   - Command injection, path traversal, secrets or tokens leaking into logs
   - Personal data (names, emails, addresses, phone or account numbers, identifiers) in fixtures, logs, error messages, analytics events, prompts sent to third-party APIs, or persisted data, judged against the `CLAUDE.md` invariants — breaking one is a bug
   - A listed fixture or data file that could hold personal data or secrets with no provenance or redaction note beside it (a README in its directory, a header comment, a sidecar) — a concern; never invent the provenance, surface it
   - Leftover debug output, breakpoints, hard-coded paths, secrets
   - Test gaps: new functions, branches, or error paths without a test; tests that only cover the happy path; a bug fix without a regression test; tests that break the rules in `TEST_GUIDELINES` (e.g. real I/O, network, or sleeps where the project requires mocks)

5. **Decide before fixing.** Open ledger findings (status `new`/`open`) are fix targets in **every** run, whatever their severity and regardless of `--fix-suggestions`. For findings discovered *fresh* in this run:
   - **Bugs** — fix now. A fix that changes observable behaviour the plan and the design doc do not call for is a blocking question (see *Questions before assumptions*), never applied on a guess. Any other non-trivial fix: when someone can answer, ask first; when no one can, apply it and name it in the report.
   - **Concerns** — fix when the fix is straightforward and contained. A concern whose resolution is the person's call (a product or trade-off choice that neither the plan nor the design doc settles) is a blocking question. Every other concern stays unfixed and is reported with the reason.
   - **Suggestions / Nits** — report only, unless `--fix-suggestions` is set; then fix with small, scoped edits. Anything that would change behavior or widen scope is reported instead of fixed.

   A ledger finding is fixed, whatever a fresh finding of its severity would get. Two things alone keep one unfixed: a *Safety* hard stop, and a blocking question (the fix changes behaviour the plan and the design doc do not call for, would change what the person settled, or is the question the review recorded for the person): that one is asked, not fixed on a guess. A fresh finding the user (or the ledger's `plan_context`) explicitly declined is reported but **not** appended to the ledger, since appending it would turn the decline into a fix target next run.

   Collect every blocking question here, before step 6 applies anything.

6. **Apply fixes.** Edit directly. Every production bug fix gets a regression test that would have caught it, following `TEST_GUIDELINES`. If the change adds/removes a module, changes a CLI or public interface, or alters a design decision the project documents, update `CLAUDE.md` and the relevant docs. Keep the change set scoped — no unrelated refactors.

7. **Re-review.** `git diff` again: every fix addresses its finding, no new bugs, no debug leftovers.

8. **Run the quality gates.** Run `$GATE_WRAPPER bash -c '<QUALITY_GATES>'` when `GATE_WRAPPER` is set, with the text of `QUALITY_GATES` between the single quotes (so the whole compound command runs under the wrapper, and any `$VAR` in it is expanded by the wrapper's shell; write any `'` inside the gate command as `'\''`), or plain `$QUALITY_GATES` when it is unset. You may use `QUALITY_GATES_FAST` (in the same form) while iterating, but the final run must be the full `QUALITY_GATES`.
   - Run gates in the **foreground** with an explicit Bash `timeout` of `600000` — never `run_in_background`; a backgrounded run is reaped when the turn yields. If the gate is too slow for one call, split it into separate foreground calls. Never end the turn while a gate run is pending.
   - If the wrapper exits `75` (all gate slots busy), re-run; `125` means the wrapper itself cannot run — report it.
   - A failure that already enumerated failing tests is an answered red: fix it, do not blindly re-run. Re-run once only when the failure looks like a resource artifact (runner killed, timeout, OOM), and let that result decide.

9. **Fix gate failures.** Find and fix the root cause; re-run the failing gate plus any whose inputs changed, until green. Do not silence errors with suppression comments or test skips unless there is a real, narrow reason and the user is told. An existing test that fails because one of this run's fixes changed the behaviour it asserts shows that the fix changes behaviour: when the plan and the design doc do not call for that change, never edit the assertion; it is a blocking question (see *Questions before assumptions*). If the same gate fails three times on the same root cause, stop: that too is a blocking question, with what you tried and the ways forward as its options.

10. **Update the ledger, then report.** Update the ledger (*Mark fixed & append* below), then summarize:
    - Files reviewed; whether `--fix-suggestions` was active.
    - Bugs fixed (one line each, `path:line`).
    - Bugs and concerns left unfixed (one line each, `path:line`, with the reason).
    - Ledger findings: each marked fixed, or not fixed with the reason (a *Safety* hard stop, a blocking question still open, or a reverted fix).
    - Fresh Suggestions/Nits: fixed/skipped (with `--fix-suggestions`) or not fixed this run.
    - Fresh findings appended to the ledger — what the next `/polish` will pick up; whether the ledger was restored from the state branch, and whether its copy reached it (or why not).
    - Gate results: what ran, what passed, how many fix iterations.
    - Questions asked and what the person answered.
    - **Assumptions** — each choice a fix made that the plan and the design doc do not settle (non-obvious decisions and trade-offs included), and each question taken on assumptions with the option taken.

    End with a one-line machine-readable tally: `polish: fixed=<N> deferred=<M> gates=<green|red>`. A run that stops with `error=needs_input` prints that error and its questions instead of the tally.

## Questions before assumptions

A **blocking question** is one only the person can answer. A polish run can meet five: a fix, fresh or from the ledger, that changes observable behaviour (what the product does for its users, or a public interface) in a way neither the plan nor the design doc calls for (a fix that only makes the code do what the plan, the design doc, `CLAUDE.md` or an existing test already says it should, or that only removes a crash, a leak, a race or a data-handling violation, is not one); a concern whose resolution is a product or trade-off choice that neither of them settles; a finding whose fix would change what the person settled (an answer the invoking prompt carries, an `answered` line of the plan's `## Assumptions to review` section, a decision the design doc tags `(person, …)`): make no such change and drop no such finding, ask, naming both what they settled and what the finding says; a ledger finding the review recorded as a question to ask the person; and a gate that fails three times on the same root cause (step 9). The plan and the design doc are the ones the invoking prompt hands over, else the ledger's `plan_context` and `plan_path` and the design doc that plan names; with none of them, only `CLAUDE.md`, the existing tests and plain correctness say what the code should do, and any fix that changes behaviour beyond that is a question. A choice nobody confirmed (a bullet of the plan's `## Assumptions` section, an `assumed` line of its `## Assumptions to review` section, or one the invoking prompt hands over as assumed) is kept while the code follows it: it is no finding, it is never asked again, and a reason to change one is a blocking question. Settle yourself anything the tree, `CLAUDE.md`, the plan, the design doc or desk research can settle; never ask about it. A question, its options and the recommendation name steps and decisions by title; a number may follow the title, but a number alone is never enough, because numbers move between revisions.

- **One pass, before the first fix.** Collect every blocking question at step 5, before step 6 applies anything. Never guess the answer to one, and never set one aside as a finding for a later run. One that surfaces only at step 9 is asked there (when no one can answer, it stops the run there), with the fixes applied so far left in place and listed.
- **Someone can answer** (an interactive session with a question tool, such as AskUserQuestion): ask them all at once, each with 2–4 concrete options and your recommended one first, and wait. The answers bind like explicit constraints.
- **No one can answer** (the invoking prompt says the run is unattended, or there is no question tool): make no further change and leave the ledger as it is; stop with `error=needs_input` and print each question with an id (`q1`, `q2`, …), why it blocks (what changes with the answer), its options and the one you recommend. When the invoking prompt says to proceed on assumptions instead, take the recommended option and list the question with it under **Assumptions** in the report; a question about departing from what the person settled is never taken that way: keep what the person said and list the question as open.
- **Answers handed in** by the invoking prompt bind the same way; never re-ask one, and never change what one settled: a reason to change it is a blocking question.
- **Everything else is an assumption:** where a fix must make a choice the plan and the design doc do not settle, take the smallest one consistent with the surrounding code, and list each under **Assumptions** in the report. None stays silent.

## Review-findings ledger

`/review-changes` persists its findings to a per-branch ledger at `~/.claude/reviews/<branch-slug>.json` (schema in `.claude/commands/review-changes.md`), with a copy on the repository's state branch (origin's `pipeline/state`) at `reviews/<state-slug>.json`, so the ledger outlives the container. `<state-slug>` is what `python3 .claude/scripts/pipeline-state.py slug <branch>` prints (the state branch's spelling, which keeps `feat/x` and `feat-x` apart; run the script, never spell it by hand; it can differ from `<branch-slug>`). This command reads it, marks what it fixes as `fixed`, and appends fresh unresolved findings in the same schema, so unresolved work survives across sessions.

### Recall (start of run)

`<branch-slug>` is the current branch lowercased, non-alphanumeric runs replaced with `-`, repeats collapsed, leading/trailing `-` trimmed. On a detached HEAD, skip the ledger entirely. When `~/.claude/reviews/<branch-slug>.json` is missing, first restore it from the state branch: `python3 .claude/scripts/pipeline-state.py get reviews/<state-slug>.json --to ~/.claude/reviews/<branch-slug>.json` (exit 3: none was saved; exit 2: the state branch is unreachable — say so and go on without it). A restored ledger is this repository's, written from another checkout's path, so when its `branch` is the current branch, set its `repo` to this working directory right away; one whose `branch` differs is deleted again. Treat the file as **absent** when it is missing, malformed JSON (warn; never overwrite blindly), or its `repo` is not this working directory or its `branch` is not the current branch — never apply fixes for another tree's findings. Union the ledger's `new`/`open` findings with any passed in `$ARGUMENTS`, de-duplicated by `file` + `title`; all of them are fix targets.

The ledger's `plan_context` (and `plan_path`, if it still exists) carries the design intent the review captured. Keep every fix consistent with it: it can narrow a ledger fix or justify declining a *fresh* finding, but never skips a ledger finding. It is also the plan that *Questions before assumptions* judges a behaviour change against when the invoking prompt hands over none.

### Mark fixed & append (after fixes land and gates pass)

Timestamps are ISO 8601 UTC, `YYYY-MM-DDTHH:MM:SSZ`.

1. **Mark fixed.** Each recalled `new`/`open` finding actually resolved in the working tree → `status: fixed`, `resolved_at: <now>`. Leave unresolved, blocked, or reverted ones unchanged.
2. **Append fresh unresolved findings.** Each fresh finding not fixed this run (deferred Bug, open Concern, unfixed Suggestion/Nit) → new entry with `id` the next free `r<N>`, `severity`, `file`, best-effort `line`, `title`, one-to-two-line `detail`, `status: new`, `first_seen: <now>`, `resolved_at: null`. Skip findings already tracked (same `file` + `title`) and ones the user or `plan_context` declined.
3. **Write back** atomically and best-effort: set `updated_at`, create `~/.claude/reviews/` if needed, write `<branch-slug>.json.tmp.<pid>`, then rename. On failure, warn and continue. If no ledger file existed and there is something to append, create one with `repo` (this working directory), `branch`, `base: null`, `plan_context: null`, `plan_path: null`, and the new findings. If an existing file was treated as absent because it was malformed or foreign, do **not** overwrite it — warn and skip the write.
4. **Copy to the state branch** once a write succeeded, best effort: `python3 .claude/scripts/pipeline-state.py save ~/.claude/reviews/<branch-slug>.json --as reviews/<state-slug>.json -m "review ledger: <branch>"`. Exit 2 (no origin, offline, a push still rejected after its retries) → warn and continue; the local ledger stands.

## What to skip

- Style and formatting the project's linters/formatters already enforce.
- Type-annotation tightening that does not fix a real type bug.
- Anything outside the diff, and renames/restructuring for taste.

## Safety

- Do not commit, push (beyond the ledger's state-branch save), stage, unstage, or discard changes. Never use `git stash` (other worktrees may share the stash).
- No destructive git operations (`reset --hard`, `checkout --`, `clean -f`, branch deletes).
- The only file written outside the working tree is the review-findings ledger under `~/.claude/reviews/`, with its copy on the state branch (a commit `pipeline-state.py` pushes to origin's `pipeline/state` without touching the checkout); a malformed or foreign ledger is never overwritten.
- Never bypass a gate failure with a workaround — fix the root cause.
- A fix, fresh or from the ledger, that changes observable behaviour the plan and the design doc do not call for is never applied on a guess: it is a blocking question (see *Questions before assumptions*).
- Never change what the person settled (*Questions before assumptions* says what counts); a reason to change it is a blocking question.
- Gitignored local env files (`.env`, `.env.local`, …) are expected: never read, edit, stage, or delete them, and do not stop because one exists. Stop and tell the user only when a secret-looking file (`.env`, credentials, tokens, keys) is tracked, staged, or would be committed.
- Never quote credentials or personal data into the report or the ledger; cite the file and line and redact the value.
- If the same gate fails three times on the same root cause, stop: it is a blocking question (see *Questions before assumptions*).

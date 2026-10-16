Review the current uncommitted changes, fix any bugs found (plus every open review-ledger finding), and run the quality gates.

This is the pre-commit polish workflow: review → fix bugs and **all** open review-ledger findings → record any *fresh* unresolved findings back to the ledger → verify gates pass. It does not commit, push, or open a PR — use `/create-pr` (or commit and push yourself) once this completes cleanly.

## Project configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines):

- `QUALITY_GATES` — required. If missing, stop with `error=missing_quality_gates` and ask the user to add it.
- `QUALITY_GATES_FAST` — optional quicker subset for iterative re-runs; defaults to `QUALITY_GATES`.
- `GATE_WRAPPER` — optional prefix for every gate run (e.g. `.claude/scripts/gate-slot.sh`); none by default.
- `PLANS_DIR` — defaults to `~/.claude/plans`.
- `TEST_GUIDELINES` — where the project's testing rules live; defaults to the project's `CLAUDE.md`.

## Flags

`$ARGUMENTS` may contain (whitespace-separated, order-independent):

- `--fix-suggestions` — also fix **fresh** Suggestions and Nits discovered in this run. Without it, fresh Suggestions/Nits are reported and appended to the ledger (Step 10) so a later `/polish` fixes them. This flag never affects ledger findings: every open ledger finding is always fixed.

Any other tokens are free-form context (e.g. a findings list pasted from `/review-changes`).

## Steps

1. **Verify there is work.** `git status --porcelain`; if empty, stop — nothing to polish.

2. **Gather the diff.** `git diff HEAD` (staged + unstaged), read every untracked file from `git status --porcelain` in full, and note the branch (`git rev-parse --abbrev-ref HEAD`). Recall this branch's **review-findings ledger** (below) so findings from a prior `/review-changes` session are in scope even without `$ARGUMENTS`.

3. **Understand the change.** Read every modified/added file in full, not just the hunks. Trace callers and tests with Grep where logic is non-trivial. Classify each file: bug fix, feature, refactor, config, test-only, docs. Check the change against the invariants and rules in the project's `CLAUDE.md` — a violation is a bug.

4. **Look for bugs.** A *bug* is incorrect behavior, a leak, a race, a broken invariant, or a missing test for new behavior; a *suggestion* is taste, naming, or cosmetic refactor. Look for:
   - Off-by-one, missing edge cases, null / empty-collection handling
   - Races in async code or file operations
   - Unbounded growth (lists, strings, files, prompt inputs)
   - Errors caught at the wrong level or swallowed silently
   - Type escape hatches hiding real type bugs
   - Command injection, path traversal, secrets or tokens leaking into logs
   - Leftover debug output, breakpoints, hard-coded paths, secrets
   - Test gaps: new functions, branches, or error paths without a test; tests that only cover the happy path; a bug fix without a regression test; tests that break the rules in `TEST_GUIDELINES` (e.g. real I/O, network, or sleeps where the project requires mocks)

5. **Decide before fixing.** Open ledger findings (status `new`/`open`) are **always** fixed in this run, whatever their severity and regardless of `--fix-suggestions`. For findings discovered *fresh* in this run:
   - **Bugs** — fix now. If a fix is non-trivial or changes observable behavior the user may not intend, ask first.
   - **Concerns** — fix only if straightforward and contained; otherwise surface to the user.
   - **Suggestions / Nits** — report only, unless `--fix-suggestions` is set; then fix with small, scoped edits. Anything that would change behavior or widen scope is surfaced instead.

   For a ledger finding, apply the fix and record any behavior-changing decision in the report — only the *Safety* hard stops override. A fresh finding the user (or the ledger's `plan_context`) explicitly declined is reported but **not** appended to the ledger, since appending it would turn the decline into an always-fixed finding next run.

6. **Apply fixes.** Edit directly. Every production bug fix gets a regression test that would have caught it, following `TEST_GUIDELINES`. If the change adds/removes a module, changes a CLI or public interface, or alters a design decision the project documents, update `CLAUDE.md` and the relevant docs. Keep the change set scoped — no unrelated refactors.

7. **Re-review.** `git diff` again: every fix addresses its finding, no new bugs, no debug leftovers.

8. **Run the quality gates.** Run `$GATE_WRAPPER bash -c '<QUALITY_GATES>'` when `GATE_WRAPPER` is set, with the text of `QUALITY_GATES` between the single quotes (so the whole compound command runs under the wrapper, and any `$VAR` in it is expanded by the wrapper's shell; write any `'` inside the gate command as `'\''`), or plain `$QUALITY_GATES` when it is unset. You may use `QUALITY_GATES_FAST` (in the same form) while iterating, but the final run must be the full `QUALITY_GATES`.
   - Run gates in the **foreground** with an explicit Bash `timeout` of `600000` — never `run_in_background`; a backgrounded run is reaped when the turn yields. If the gate is too slow for one call, split it into separate foreground calls. Never end the turn while a gate run is pending.
   - If the wrapper exits `75` (all gate slots busy), re-run; `125` means the wrapper itself cannot run — report it.
   - A failure that already enumerated failing tests is an answered red: fix it, do not blindly re-run. Re-run once only when the failure looks like a resource artifact (runner killed, timeout, OOM), and let that result decide.

9. **Fix gate failures.** Find and fix the root cause; re-run the failing gate plus any whose inputs changed, until green. Do not silence errors with suppression comments or test skips unless there is a real, narrow reason and the user is told. If the same gate fails three times on the same root cause, stop and ask the user.

10. **Update the ledger, then report.** Update the ledger (*Mark fixed & append* below), then summarize:
    - Files reviewed; whether `--fix-suggestions` was active.
    - Bugs fixed (one line each, `path:line`).
    - Concerns surfaced but not fixed (with reason).
    - Ledger findings: each marked fixed, or not fixed with the reason (a *Safety* hard stop or a reverted fix).
    - Fresh Suggestions/Nits: fixed/skipped (with `--fix-suggestions`) or not fixed this run.
    - Fresh findings appended to the ledger — what the next `/polish` will pick up.
    - Gate results: what ran, what passed, how many fix iterations.
    - Non-obvious decisions or trade-offs.

    End with a one-line machine-readable tally: `polish: fixed=<N> deferred=<M> gates=<green|red>`.

## Review-findings ledger

`/review-changes` persists its findings to a per-branch ledger at `~/.claude/reviews/<branch-slug>.json` (schema in `.claude/commands/review-changes.md`). This command reads it, marks what it fixes as `fixed`, and appends fresh unresolved findings in the same schema, so unresolved work survives across sessions.

### Recall (start of run)

`<branch-slug>` is the current branch lowercased, non-alphanumeric runs replaced with `-`, repeats collapsed, leading/trailing `-` trimmed. On a detached HEAD, skip the ledger entirely. Treat the file as **absent** when it is missing, malformed JSON (warn; never overwrite blindly), or its `repo` is not this working directory or its `branch` is not the current branch — never apply fixes for another tree's findings. Union the ledger's `new`/`open` findings with any passed in `$ARGUMENTS`, de-duplicated by `file` + `title`; all of them are fix targets.

The ledger's `plan_context` (and `plan_path`, if it still exists) carries the design intent the review captured. Keep every fix consistent with it: it can narrow a ledger fix or justify declining a *fresh* finding, but never skips a ledger finding.

### Mark fixed & append (after fixes land and gates pass)

Timestamps are ISO 8601 UTC, `YYYY-MM-DDTHH:MM:SSZ`.

1. **Mark fixed.** Each recalled `new`/`open` finding actually resolved in the working tree → `status: fixed`, `resolved_at: <now>`. Leave unresolved, blocked, or reverted ones unchanged.
2. **Append fresh unresolved findings.** Each fresh finding not fixed this run (deferred Bug, open Concern, unfixed Suggestion/Nit) → new entry with `id` the next free `r<N>`, `severity`, `file`, best-effort `line`, `title`, one-to-two-line `detail`, `status: new`, `first_seen: <now>`, `resolved_at: null`. Skip findings already tracked (same `file` + `title`) and ones the user or `plan_context` declined.
3. **Write back** atomically and best-effort: set `updated_at`, create `~/.claude/reviews/` if needed, write `<branch-slug>.json.tmp.<pid>`, then rename. On failure, warn and continue. If no ledger file existed and there is something to append, create one with `repo` (this working directory), `branch`, `base: null`, `plan_context: null`, `plan_path: null`, and the new findings. If an existing file was treated as absent because it was malformed or foreign, do **not** overwrite it — warn and skip the write.

## What to skip

- Style and formatting the project's linters/formatters already enforce.
- Type-annotation tightening that does not fix a real type bug.
- Anything outside the diff, and renames/restructuring for taste.

## Safety

- Do not commit, push, stage, unstage, or discard changes. Never use `git stash` (other worktrees may share the stash).
- No destructive git operations (`reset --hard`, `checkout --`, `clean -f`, branch deletes).
- The only file written outside the working tree is the review-findings ledger under `~/.claude/reviews/`; a malformed or foreign ledger is never overwritten.
- Never bypass a gate failure with a workaround — fix the root cause.
- If a *fresh* fix would change observable behavior the user may not intend, surface it before applying; ledger findings are still fixed, with the decision recorded in the report.
- If the working tree contains files that look like secrets (`.env`, credentials, tokens), stop and tell the user — never edit, stage, or delete them.
- If the same gate fails three times on the same root cause, stop and ask the user.

Run the project's quality gates — plus any failure class the current PR's live CI is red on — fix failures at the root, then commit and push the fixes.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:
- `QUALITY_GATES` — full gate command, exit 0 when green. If missing, stop with `error=missing_quality_gates` and ask the user to add it.
- `QUALITY_GATES_FAST` — optional quicker subset for re-running a single failure (default `QUALITY_GATES`).
- `GATE_WRAPPER` — optional prefix for every gate run (e.g. `.claude/scripts/gate-slot.sh`: exit 75 = all slots busy, wait and re-run; 125 = the wrapper cannot run, surface it).
- `GH_WRAPPER` — optional prefix for `gh` / `git fetch` / `git push`.
- `MAIN_BRANCH` — integration branch (default `main`).
- `TEST_GUIDELINES` — where the project's testing rules live (default `CLAUDE.md`).

## Arguments

`$ARGUMENTS` is a space-separated list of mode tokens (unknown tokens: warn and ignore):
- *(empty or `fix`)* — run gates, fix failures, commit and push once green (default).
- `check` — run and report only; never modify, commit, or push. The CI inspection still runs (read-only).
- `no-commit` — fix, but leave the changes uncommitted.
- `no-ci` — skip the PR CI inspection; local gates only.

## Steps

1. **Locate the repo root.** `cd "$(git rev-parse --show-toplevel)"`; stop on failure.

2. **Inspect the current PR's CI** (skip under `no-ci`). Read-only.
   - `$GH_WRAPPER gh pr view --json number,state,url`. Skip the rest of this step — noting why — when there is no PR, the branch is `$MAIN_BRANCH`, `gh` is unavailable, or the PR is not `OPEN`.
   - `$GH_WRAPPER gh pr checks <PR#> --json name,state,bucket,link,workflow`. Capture output regardless of exit code (it exits non-zero when checks are pending or failing). Buckets: `fail`/`cancel` = failing, `pending` = inconclusive, `pass`/`skipping` = fine.
   - Classify each failing check: a **gate check** is one whose job runs (part of) the same lint / type-check / test / coverage commands as `$QUALITY_GATES` — read the CI workflow files to map it. Gate checks are folded into this run: their failure class must be reproduced and fixed here even if the local run is otherwise green. Any other check (AI review, deploy, …) is **out of scope** — record it for the report; route AI review findings to `/process-comments`.
   - Record each failing gate check's `link` for step 4.

3. **Run the gates** in the foreground with the maximum tool timeout — never in the background, since a backgrounded run can be reaped when the turn yields:
   ```
   $GATE_WRAPPER $QUALITY_GATES
   ```
   Capture which stage failed (lint, types, tests, coverage, browser/e2e, …) and the concrete errors.

4. **Fix failures** (skip in `check` mode). Fix in upstream-first order — lint → types → tests → coverage → browser/e2e — so earlier noise doesn't mask later signal. After each fix, re-run the narrowest gate that covers it (`$QUALITY_GATES_FAST` or the single failing tool); allow **3 fix rounds per failure class**, then stop and surface what remains. Finish with one full `$GATE_WRAPPER $QUALITY_GATES` run.
   - **CI-red class that is green locally.** Pull the failing log: derive the run id from the recorded `link` and run `$GH_WRAPPER gh run view <run-id> --log-failed`. The usual cause is drift from `$MAIN_BRANCH` (CI tested a tree with commits you lack) — the merge in step 5 normally resolves it; let the fresh CI run confirm. A genuine runner-only failure you cannot reproduce goes in the report, never silently pushed over.

5. **Commit and push** (fix mode only; skip in `check` / `no-commit`, or when nothing changed). Only when the final full run is green.
   - Stop and skip if on `$MAIN_BRANCH`.
   - Stage only the files changed during the fix rounds, by explicit name — never `git add -A`, never `.env` or secrets.
   - Commit with a message explaining *why* each fix was needed, ending with the session's `Co-Authored-By` trailer.
   - `$GH_WRAPPER git fetch origin $MAIN_BRANCH` and `git merge origin/$MAIN_BRANCH --no-edit` (never rebase), resolving conflicts preserving both sides. If the merge changed the tree, re-run `$QUALITY_GATES`; if no longer green, abort the push and surface it.
   - `$GH_WRAPPER git push -u origin HEAD` — never `--force`. On a non-fast-forward rejection, fetch and merge `origin/<branch>`, re-run the gates, and push again only when green (at most 3 cycles). Any other push failure: stop and surface it.
   - Do not wait for the re-triggered CI run.

6. **Report.**
   - **PR CI:** PR URL and the starting rollup (pass / pending / failing), which failing checks were folded in, and which were out of scope (with a pointer to `/process-comments` for AI review findings). If skipped, why.
   - Per gate stage: `PASS` with a headline metric; `FAIL` with up to ~10 `file:line — message` extracts (or a count plus the re-run command); for a CI-red class that stayed green locally, quote the CI log extract.
   - In fix mode: files modified; for each fix, the stage, whether it came from the local run or a folded-in CI check, the diagnosis (source bug / test bug / coverage gap / lint / types), and a one-line description; the commit subject and pushed branch, or why commit/push was skipped.
   - End with `OVERALL: PASS` or `OVERALL: FAIL (<stages>)`, and if anything is still red, name the most upstream remaining failure and what blocks fixing it.

## Fix discipline — at the root, never by suppression

- **Lint:** apply the tool's safe autofix first, inspect the diff, then fix the rest by hand. Never disable a rule project-wide; a per-line suppression only when the rule is genuinely wrong for that line, with a comment saying why.
- **Types:** decide whether the code or the annotation is wrong and fix that. No blanket ignores, and no `any`/cast-style escape hatches to make errors disappear.
- **Test failures:** read the test and the code under test and decide which is the source of truth. A production bug is fixed in production code (the failing test already captures the correct behaviour); an outdated test is updated after understanding why it was written. Never skip, xfail, filter, or delete a failing test without an equal-or-stronger replacement.
- **Coverage:** add a focused test that exercises the missing lines through realistic inputs, following `$TEST_GUIDELINES`. Never lower the threshold or add no-cover pragmas except for genuinely unreachable lines, with a comment.
- **Browser/e2e:** separate a timing/selector issue from a real app bug and fix the actual cause. Never raise timeouts as the fix.
- Stay focused: no unrelated refactors. Re-read each modified file for leftover debug code or dead branches.

## Safety

- Never commit or push in `check` / `no-commit` mode, while any gate is red, or on `$MAIN_BRANCH`.
- Never force-push, rebase, `reset`, `checkout --`, or `git stash` (parallel worktrees share the stash). The only git mutations allowed are staging fix files, committing, merging upstream, and a plain push of the current branch.
- The CI inspection is read-only: never re-run, cancel, or restart CI, edit the PR, or post comments.
- Never fix out-of-scope (non-gate) CI checks here; name them and point to the right place.
- Respect the 3-round budget per failure class; surface what remains rather than looping.

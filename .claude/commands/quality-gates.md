Run the project's quality gates — plus any gate check the current PR's live CI is red on — fix failures at the root, then commit and push the fixes.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:
- `QUALITY_GATES` — full gate command, exit 0 when green. If missing, stop with `error=missing_quality_gates` and ask the user to add it.
- `QUALITY_GATES_FAST` — optional quicker subset for re-running a single failure (default `QUALITY_GATES`).
- `GATE_WRAPPER` — optional prefix for every gate run (e.g. `.claude/scripts/gate-slot.sh`: exit 75 = all slots busy, wait and re-run; 125 = the wrapper cannot run, surface it).
- `GH_WRAPPER` — optional prefix for `gh` / `git fetch` / `git push`.
- `GITHUB_ACCESS` — `gh` or `connector` (unset: gh when it is authenticated, else the GitHub MCP tools). Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. Only step 2 and its log read in step 4 touch GitHub; `git fetch` and `git push` stay plain git either way.
- `MAIN_BRANCH` — integration branch (default `main`).
- `PLANS_DIR` — where plan files live (default `~/.claude/plans`); read only when a failing test or a merge conflict needs the branch's design intent (*Fix discipline*, step 5).
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
   - `$GH_WRAPPER gh pr view --json number,state,url` (connector: `list_pull_requests` with `head: "<owner>:<branch>"` and `state: "open"`). Skip the rest of this step — noting why — when there is no PR, the branch is `$MAIN_BRANCH`, no GitHub access is usable (note `github_unavailable`; the local gates still run), or the PR is not `OPEN`.
   - `$GH_WRAPPER gh pr checks <PR#> --json name,state,bucket,link,workflow`. Capture output regardless of exit code (it exits non-zero when checks are pending or failing). Buckets: `fail`/`cancel` = failing, `pending` = inconclusive, `pass`/`skipping` = fine. Connector: `pull_request_read` `get_check_runs`, plus `get_status` for commit statuses; derive each run's bucket as the reference's *Checks on the head* row says, and use its `details_url` as the `link`.
   - Classify each failing check: a **gate check** is one whose job runs (part of) the same lint / type-check / test / coverage commands as `$QUALITY_GATES` — read the CI workflow files to map it. Gate checks are folded into this run: their failure class must be reproduced and fixed here even if the local run is otherwise green. Any other check (AI review, deploy, …) is **out of scope** — record it for the report; route AI review findings to `/process-comments`.
   - Record each failing gate check's `link` for step 4.

3. **Run the gates** in the foreground with the maximum tool timeout — never in the background, since a backgrounded run can be reaped when the turn yields. Run exactly one of these, with the text of `QUALITY_GATES` in place of `<QUALITY_GATES>`:
   ```
   $GATE_WRAPPER bash -c '<QUALITY_GATES>'   # GATE_WRAPPER set: the whole compound command runs under it
   $QUALITY_GATES                            # GATE_WRAPPER unset
   ```
   The single quotes leave any `$VAR` in the gate command (such as `$GATE_SLOT_WORKERS`) for the wrapper's shell to expand; write any `'` inside the gate command as `'\''`.
   Capture which stage failed (lint, types, tests, coverage, browser/e2e, …) and the concrete errors.

4. **Fix failures** (skip in `check` mode). Fix in upstream-first order — lint → types → tests → coverage → browser/e2e — so earlier noise doesn't mask later signal. After each fix, re-run the narrowest gate that covers it (`$QUALITY_GATES_FAST` or the single failing tool, in the step 3 form); allow **3 fix rounds per failure class**, then stop and surface what remains. Finish with one full run in the step 3 form.
   - **CI-red class that is green locally.** Pull the failing log: derive the run id from the recorded `link` and run `$GH_WRAPPER gh run view <run-id> --log-failed` (connector: `get_job_logs` with `run_id`, `failed_only: true` and `return_content: true`). The usual cause is drift from `$MAIN_BRANCH` (CI tested a tree with commits you lack) — the merge in step 5 normally resolves it; let the fresh CI run confirm. A genuine runner-only failure you cannot reproduce goes in the report, never silently pushed over.

5. **Commit and push** (fix mode only; skip in `check` / `no-commit`, or when there is nothing to commit or push: no file changed in this run, and no earlier run of this command left work behind). Only when the final full run is green. An earlier run left work behind when it stopped with `error=needs_input` and this run was handed the answer to its question: fixes left uncommitted in the working tree (a test or gate question, *Fix discipline*), or a fix commit left unpushed (a merge conflict, the merge bullet below; `git log @{u}..HEAD` shows it). With only such an unpushed commit, skip the staging and the commit, and go on from the merge, which the answer now decides, to the push.
   - Stop and skip if on `$MAIN_BRANCH`.
   - Stage only the files changed during the fix rounds, by explicit name — never `git add -A`, never `.env` or secrets. The fixes an earlier run left uncommitted when it stopped for the question this run was handed the answer to are staged with them: each tracked file `git status --porcelain` shows as modified whose diff is such a gate fix, named in the report. Any other modified file stays unstaged and is named in the report.
   - Commit with a message explaining *why* each fix was needed, ending with the session's `Co-Authored-By` trailer.
   - `$GH_WRAPPER git fetch origin $MAIN_BRANCH` and `git merge origin/$MAIN_BRANCH --no-edit` (never rebase), resolving conflicts as `/merge-main` step 5 does: read both sides of every hunk and what each side was doing, and keep both intents. A conflict that neither the branch's plan nor either side's intent decides, or whose resolution would change what the person settled, is the person's call, as that step says: never pick a side. Run `git merge --abort` (the fix commit stays, unpushed), push nothing, and ask the person with the options (keep ours, keep theirs, a named combination) and the one you recommend; when no one can answer (the invoking prompt says the run is unattended, or there is no question tool), stop with `error=needs_input` and print that question with an id, why it blocks, its options and the one you recommend. (When the invoking prompt says to proceed on assumptions, do as that step says instead: resolve with the option you recommend, without aborting, and list the question with it in the report.) If the merge changed the tree, re-run the full gates in the step 3 form; if no longer green, abort the push and surface it.
   - `$GH_WRAPPER git push -u origin HEAD` — never `--force`. On a non-fast-forward rejection, fetch and merge `origin/<branch>` (conflicts as in the bullet above), re-run the gates in the step 3 form, and push again only when green (at most 3 cycles). Any other push failure: stop and surface it.
   - Do not wait for the re-triggered CI run.

6. **Report.**
   - **PR CI:** PR URL and the starting rollup (pass / pending / failing), which failing checks were folded in, and which were out of scope (with a pointer to `/process-comments` for AI review findings). If skipped, why.
   - Per gate stage: `PASS` with a headline metric; `FAIL` with up to ~10 `file:line — message` extracts (or a count plus the re-run command); for a CI-red class that stayed green locally, quote the CI log extract.
   - In fix mode: files modified; for each fix, the stage, whether it came from the local run or a folded-in CI check, the diagnosis (source bug / test bug / coverage gap / lint / types), and a one-line description; every existing test whose assertion changed (the test, what it asserted before, what it asserts now, and the plan or design-doc line that calls for the change), and every change to a gate itself, listed the same way; each question asked, with the person's answer or, on assumptions, the option taken; the commit subject and pushed branch, or why commit/push was skipped.
   - End with `OVERALL: PASS` or `OVERALL: FAIL (<stages>)`, and if anything is still red, name the most upstream remaining failure and what blocks fixing it.

## Fix discipline — at the root, never by suppression

- **Lint:** apply the tool's safe autofix first, inspect the diff, then fix the rest by hand. Never disable a rule project-wide; a per-line suppression only when the rule is genuinely wrong for that line, with a comment saying why.
- **Types:** decide whether the code or the annotation is wrong and fix that. No blanket ignores, and no `any`/cast-style escape hatches to make errors disappear.
- **Test failures:** read the test and the code under test and decide which is the source of truth. A production bug is fixed in production code (the failing test already captures the correct behaviour); an outdated test is updated after understanding why it was written, and only when the branch's plan or the design doc that plan names calls for the new behaviour. The plan is the one the caller handed over, else the one `/merge-main`'s *Originating plan* lookup finds for this branch (never the newest plan in `$PLANS_DIR`). When neither the plan nor the design doc says whether the test or the code is right (or there is no plan), never edit what the test asserts: that is the person's call. Ask the person, naming the test, what it asserts and the two readings (the test is right and the code changes; the code is right and the assertion changes) as the options, with the one you recommend, and go on as they answer. When no one can answer (the invoking prompt says the run is unattended, or there is no question tool), stop with `error=needs_input`: commit and push nothing, leave the fixes made so far in the working tree and list them, and print that question with an id, why it blocks, its options and the one you recommend. When the invoking prompt says to proceed on assumptions instead, take the option you recommend and list the question with it in the report. An answer the invoking prompt hands in settles the question: do as it says and never ask it again. Never skip, xfail, filter, or delete a failing test without an equal-or-stronger replacement.
- **The gates themselves:** never get green by editing a CI workflow, a required check or the `QUALITY_GATES` line, unless the plan or the design doc calls for that change; when neither does, it is the same question as for a test.
- **Coverage:** add a focused test that exercises the missing lines through realistic inputs, following `$TEST_GUIDELINES`. Never lower the threshold or add no-cover pragmas except for genuinely unreachable lines, with a comment.
- **Browser/e2e:** separate a timing/selector issue from a real app bug and fix the actual cause. Never raise timeouts as the fix.
- Stay focused: no unrelated refactors. Re-read each modified file for leftover debug code or dead branches.

## Safety

- Never commit or push in `check` / `no-commit` mode, while any gate is red, or on `$MAIN_BRANCH`.
- Never force-push, rebase, `reset`, `checkout --`, or `git stash` (parallel worktrees share the stash). The only git mutations allowed are staging fix files, committing, merging upstream (or `git merge --abort` on a conflict that is the person's call), and a plain push of the current branch.
- The CI inspection is read-only, through either access: never re-run, cancel, or restart CI, edit the PR, or post comments.
- Never fix out-of-scope (non-gate) CI checks here; name them and point to the right place.
- Never get green by changing what an existing test asserts, or by editing a gate itself, unless the plan or the design doc calls for that change; otherwise it is a question for the person (*Fix discipline*).
- Respect the 3-round budget per failure class; surface what remains rather than looping.

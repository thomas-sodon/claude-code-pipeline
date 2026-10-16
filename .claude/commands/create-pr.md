Create a non-draft pull request for the current changes, or report the open PR the branch already has.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:
- `MAIN_BRANCH` — integration branch (default `main`).
- `GH_WRAPPER` — optional prefix for every `gh`, `git push` and `git fetch` command (e.g. a script that loads a token from `.env`). When unset, run them bare and rely on the ambient `gh auth`.
- `PLANS_DIR` — where plan files live (default `~/.claude/plans`).
- `QUALITY_GATES` — the project's gate command; named only in the PR body's test plan (this command never runs it).

## Arguments

`$ARGUMENTS` is optional free text: a branch-name hint or a short description of the change. The token `--no-issue` skips Step 7 (issue detection); a caller (e.g. a workflow that already knows there is no issue, or that writes its own closing keyword) may also say "skip step 7".

## Steps

1. **Check prerequisites.** Confirm `gh` is authenticated (`$GH_WRAPPER gh auth status`); if not, stop with `error=gh_unauthenticated`. Then confirm there is work to turn into a PR — *either*:
   - uncommitted work: `git status --porcelain` is non-empty, or
   - unpushed commits: `git log @{u}..HEAD` is non-empty when an upstream exists, otherwise `git log origin/$MAIN_BRANCH..HEAD`.

   Stop with `error=nothing_to_pr` only if *both* are empty. A clean tree with unpushed commits is a valid start.

2. **Determine the branch name.** If already on a branch other than `$MAIN_BRANCH`, use it. Otherwise derive one from `$ARGUMENTS` (or ask): `feat/<short-description>`, `fix/<short-description>`, or `refactor/<short-description>`.

3. **Create and switch to the branch** if not already on a feature branch: `git checkout -b <branch-name>`.

4. **Stage and commit.** Skip when `git status --porcelain` is empty. Otherwise review `git diff` / `git status`, stage relevant files by explicit name (not `git add -A`; never `.env` or secrets), and commit with a HEREDOC message that explains *why*, ending with the `Co-Authored-By` trailer the session uses.

5. **Push the branch.** Never force-push:
   ```
   $GH_WRAPPER git push -u origin HEAD
   ```
   - Success → continue.
   - Rejected as non-fast-forward (the remote branch has commits you lack) → stop with `error=push_rejected_non_ff` and surface it; for a new PR branch this usually means a name collision. Do not force-push or blindly merge.
   - Any other failure (auth, protected branch, hook) → stop and surface the error.

6. **Detect an existing open PR for the branch.** The push in Step 5 already updated any open PR on this branch, so a second `gh pr create` would only fail. Check first:
   ```
   $GH_WRAPPER gh pr view --json number,url,state
   ```
   - **Open PR exists** (`state` is `OPEN`) → report its URL and stop. Do not run `gh pr create`.
   - **No PR** (output says "no pull requests found"), or the branch's PR is `CLOSED`/`MERGED` → continue; only an *open* PR short-circuits.
   - **Any other error** (auth, network, rate limit) → stop and surface it. Do not treat it as "no PR".

7. **Detect the issue to close (skippable).** Skip when `--no-issue` was passed or the caller asked to skip this step. A bug-fix PR should close its issue on merge via `Fixes #<N>` in the body. Gather candidates from all three sources before deciding:
   - **Branch name (authoritative)** — an issue number after a `fix` segment: `fix/<N>-…`, `fix-<N>-…`, `feat/fix-<N>-…`. Call it `branch_issue`.
   - **Plan file** — the first `Fixes: #<N>` (or `Closes: #<N>`) line under the plan's title. Prefer the branch-derived plan: strip a leading `feat/`/`fix/`/`refactor/` and read `$PLANS_DIR/<slug>.md`; if absent and the branch ends in a `/impl` uid segment (`-<token>` matching `^[0-9]{12}[0-9a-f]*$`), strip only that segment and retry once. Only if no branch-derived plan exists, fall back to `~/.claude/last-plan-by-folder.json` (keyed by absolute working directory; the named plan must still exist). That pointer is the most recently written plan for the folder, not for this branch, so discard it when it disagrees with `branch_issue`, and when `branch_issue` is absent unless `commit_issue` corroborates it. Call the survivor `plan_issue`.
   - **Commits** — a `Fixes #<N>` / `Closes #<N>` in `git log origin/$MAIN_BRANCH..HEAD`. Call it `commit_issue`.

   Reconcile: no number → not an issue-closing PR, add no keyword. All surfaced numbers agree → that issue. Distinct numbers → ask the user; never guess.

   Verify a settled number with `$GH_WRAPPER gh issue view <N> --json number,state,title`. Open → use it. Closed or not found → omit the keyword and tell the user what was found.

8. **Create the PR** (only when Step 6 found no open PR). Non-draft; include `Fixes #<N>` only when Step 7 settled an open issue:
   ```
   $GH_WRAPPER gh pr create --base "$MAIN_BRANCH" --title "<title>" --body "$(cat <<'EOF'
   ## Summary
   <1-3 bullets>

   Fixes #<N>

   ## Test plan
   - [ ] `$QUALITY_GATES` pass
   - [ ] <additional items>
   EOF
   )"
   ```
   Keep the title under 70 characters. End the body with the attribution line the session uses for PRs.

9. **Report.** Show the PR URL (new from Step 8, or the existing one from Step 6), and which issue, if any, auto-closes on merge.

## Safety

- Never commit `.env`, credentials, or secrets.
- Never force-push, and never push to `$MAIN_BRANCH`.
- Never open a draft PR.
- Do not run the quality gates here — `/quality-gates` (or the project's stop hook) owns that.
- Add a `Fixes #<N>` only for an open issue identified with confidence; never invent one for a `feat`/`refactor` PR.

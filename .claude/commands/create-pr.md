Create a non-draft pull request for the current changes, or report the open PR the branch already has.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:
- `MAIN_BRANCH` — integration branch (default `main`); the PR's base unless the caller names another (*Arguments*).
- `GH_WRAPPER` — optional prefix for every `gh`, `git push` and `git fetch` command (e.g. a script that loads a token from `.env`). When unset, run them bare and rely on the ambient `gh auth`.
- `GITHUB_ACCESS` — `gh` or `connector` (unset: gh when it is authenticated, else the GitHub MCP tools). Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. `git push` and `git fetch` stay plain git either way.
- `PLANS_DIR` — where plan files live (default `~/.claude/plans`).
- `QUALITY_GATES` — the project's gate command; named only in the PR body's test plan (this command never runs it).

## Arguments

`$ARGUMENTS` is optional free text: a branch-name hint or a short description of the change. Tokens:
- `--no-issue` skips Step 7 (issue detection); a caller (e.g. a workflow that already knows there is no issue, or that writes its own closing keyword) may also say "skip step 7".
- `--base=<branch>` — the PR's base branch; a caller may instead say "its base branch is <branch>". `<base>` below is that branch, else `$MAIN_BRANCH`; it overrides `$MAIN_BRANCH` for the work check, the existing-PR check, the issue-detection commit range and the new PR's base (`gh pr create --base`, or the connector's `base`). Empty after `=`, containing whitespace, or a bare `--base` → stop with `error=invalid_argument`.

A caller may also hand over the branch's plan (a path or its text); it is then *the plan* for Steps 7 and 8, ahead of any plan file found by name or pointer.

## Steps

1. **Check prerequisites.** Resolve the GitHub access (`.claude/scripts/github-access.md`, *Which access*). When the access named is `gh`, confirm `gh` is authenticated (`$GH_WRAPPER gh auth status`); if not, stop with `error=gh_unauthenticated`. When no access is usable, stop with `error=github_unavailable`. If `origin/<base>` does not resolve (`git rev-parse --verify --quiet origin/<base>`), run `$GH_WRAPPER git fetch origin <base>` once; still missing → stop with `error=base_not_found`. Then confirm there is work to turn into a PR — *either*:
   - uncommitted work: `git status --porcelain` is non-empty, or
   - unpushed commits: `git log @{u}..HEAD` is non-empty when an upstream exists, otherwise `git log origin/<base>..HEAD`.

   Stop with `error=nothing_to_pr` only if *both* are empty. A clean tree with unpushed commits is a valid start.

2. **Determine the branch name.** If already on a branch other than `$MAIN_BRANCH` and `<base>`, use it. Otherwise derive one from `$ARGUMENTS` (or ask): `feat/<short-description>`, `fix/<short-description>`, or `refactor/<short-description>`.

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
   $GH_WRAPPER gh pr view --json number,url,state,baseRefName
   ```
   Connector: `list_pull_requests` with `head: "<owner>:<branch>"` and `state: "all"`; an empty list is "no pull requests found", and `base.ref` is the base.
   - **Open PR exists** (`state` is `OPEN`) → report its URL and stop. Do not run `gh pr create`. If its `baseRefName` is not `<base>`, never retarget it: report both and stop with `error=pr_base_mismatch`.
   - **No PR** (output says "no pull requests found"), or the branch's PR is `CLOSED`/`MERGED` → continue; only an *open* PR short-circuits.
   - **Any other error** (auth, network, rate limit) → stop and surface it. Do not treat it as "no PR".

7. **Detect the issue to close (skippable).** Skip when `--no-issue` was passed or the caller asked to skip this step. A bug-fix PR should close its issue on merge via `Fixes #<N>` in the body. Gather candidates from all three sources before deciding:
   - **Branch name (authoritative)** — an issue number after a `fix` segment: `fix/<N>-…`, `fix-<N>-…`, `feat/fix-<N>-…`. Call it `branch_issue`.
   - **Plan file** — the first `Fixes: #<N>` (or `Closes: #<N>`) line under the plan's title. A plan the caller handed over wins. Otherwise prefer the branch-derived plan: strip a leading `feat/`/`fix/`/`refactor/` and read `$PLANS_DIR/<slug>.md`; if absent and the branch ends in a `/impl` uid segment (`-<token>` matching `^[0-9]{12}[0-9a-f]*$`), strip only that segment and retry once. Only if no branch-derived plan exists, fall back to `~/.claude/last-plan-by-folder.json` (keyed by absolute working directory; the named plan must still exist). That pointer is the most recently written plan for the folder, not for this branch, so discard it when it disagrees with `branch_issue`, and when `branch_issue` is absent unless `commit_issue` corroborates it. Call the survivor `plan_issue`.
   - **Commits** — a `Fixes #<N>` / `Closes #<N>` in `git log origin/<base>..HEAD`. Call it `commit_issue`.

   Reconcile: no number → not an issue-closing PR, add no keyword. All surfaced numbers agree → that issue. Distinct numbers → ask the user; never guess.

   Verify a settled number with `$GH_WRAPPER gh issue view <N> --json number,state,title` (connector: `issue_read` `get`). Open → use it. Closed or not found → omit the keyword and tell the user what was found.

8. **Create the PR** (only when Step 6 found no open PR). Non-draft; include `Fixes #<N>` only when Step 7 settled an open issue. **Deploy notes:** find the plan as Step 7's *Plan file* bullet does, even when Step 7 was skipped — but take the folder pointer's plan only when its `## Critical files` overlap the files `git diff --name-only origin/<base>...HEAD` lists. When that plan has a `## Rollout` section, copy its body verbatim (credentials redacted) under `## Deploy notes`; omit the section when there is no such plan or no Rollout.
   ```
   $GH_WRAPPER gh pr create --base "<base>" --title "<title>" --body "$(cat <<'EOF'
   ## Summary
   <1-3 bullets>

   Fixes #<N>

   ## Deploy notes
   <the plan's ## Rollout body>

   ## Test plan
   - [ ] `$QUALITY_GATES` pass
   - [ ] <additional items>
   EOF
   )"
   ```
   Connector: `create_pull_request` with `head: <branch>`, `base: <base>`, the same title, the body as a plain string, and `draft: false`.
   Keep the title under 70 characters. End the body with the attribution line the session uses for PRs.

9. **Report.** Show the PR URL (new from Step 8, or the existing one from Step 6), its base, which issue, if any, auto-closes on merge, and whether deploy notes were included (from which plan). Unless a workflow that called this command monitors the PR itself, add that nothing watches it now: CI, review comments and conflicts are babysat by the `plan-to-merged-pr` workflow in monitor-only mode, `{ pr: <N>, branch: <branch>, dir: <this checkout> }`, re-run (or scheduled) whenever the PR may have moved.

## Safety

- Never commit `.env`, credentials, or secrets.
- Never force-push, and never push to `$MAIN_BRANCH` or `<base>`.
- Never open a draft PR.
- Do not run the quality gates here — `/quality-gates` (or the project's stop hook) owns that.
- Add a `Fixes #<N>` only for an open issue identified with confidence; never invent one for a `feat`/`refactor` PR.

Triage a GitHub issue (specified, latest RCA-shaped, or oldest open actionable) against today's tree by its *intent*, then produce exactly one terminal outcome: a fix plan or an issue closure.

The triage answers one question: *does the wrong behavior the issue describes still apply to today's code?* Cited paths, line numbers, and symbols are anchors for the implementer, not gating evidence — line drift, renames, and file moves never by themselves veto a plan or fire a close. If the behavior is still wrong, write a plan at `$PLANS_DIR/fix-<NNN>-<slug>.md` framed around current code locations. If today's code already behaves correctly, or the whole feature surface the issue cited is gone, close the issue with a comment quoting the evidence. **When the verdict is not clear-cut, plan** — a wrong plan costs a file delete; a wrong close is public and notifies subscribers.

## Arguments

`$ARGUMENTS` is optional. Recognized tokens (any order, space-separated):

- A positive integer, with or without a leading `#` — the issue to triage (**targeted path**).
- `--rca` — auto-pick the **latest** (most recently created) open RCA-shaped issue (title starts with `[rca]` or label `rca`). Mutually exclusive with an integer.
- `--dry-run` — print the picked issue, the verdict, and the plan body or close comment; write no plan, post no comment, close nothing, write no claim, change no git state. Composes with every mode.
- *(no integer, no `--rca`)* — pick the oldest open actionable issue.

Reject anything else (`abc`, `1.2`, `0`, negatives, integer + `--rca`) with `error=invalid_argument` and the accepted forms: `/bug-fix 1234`, `/bug-fix --rca`, `/bug-fix`, each optionally with `--dry-run`.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:

- `PLANS_DIR` — default `~/.claude/plans`.
- `MAIN_BRANCH` — default `main`.
- `GH_WRAPPER` — when set, prefix every `gh`, `git fetch`, and `git push` command with it (e.g. a script that loads a token from `.env`). When unset, use ambient `gh auth`. If the first `gh` call fails on authentication, stop and tell the user to authenticate or configure `GH_WRAPPER`.
- `QUALITY_GATES`, `TEST_GUIDELINES` — referenced in the plan's verification and test steps only; this command never runs gates. If `QUALITY_GATES` is missing, still write the plan but note in its Verification section and in the addendum that the project must add `QUALITY_GATES` to its pipeline config.

Examples below write `$GH_WRAPPER gh ...`; drop the prefix when unset. Local reads (`git log`, `git show`, file checks) need no auth.

## Land on a current tree

Triage must read today's code, so refresh before triaging — only when provably safe, and never under `--dry-run` (print what would run and stay put).

1. `git rev-parse --abbrev-ref HEAD`.
   - Detached `HEAD` → warn, proceed without switching.
   - Dirty tree (`git status --porcelain` non-empty) → never switch or fast-forward; warn and proceed on the current branch, leaving changes untouched.
2. Best-effort `$GH_WRAPPER git fetch origin $MAIN_BRANCH`. On failure (offline, no auth), warn and fall back to the local `$MAIN_BRANCH` ref; skip any fast-forward.
3. Already on `$MAIN_BRANCH` and clean → `git merge --ff-only origin/$MAIN_BRANCH`. On failure (diverged), warn and proceed on local `$MAIN_BRANCH`.
4. On another clean branch → if `git merge-base --is-ancestor HEAD origin/$MAIN_BRANCH` exits 0 (fully merged), `git switch $MAIN_BRANCH` then `git merge --ff-only origin/$MAIN_BRANCH`, announcing `Switched from <branch> (fully merged) to $MAIN_BRANCH`. If either fails (e.g. the branch is checked out in a sibling worktree), warn and proceed on the current branch. Non-zero → the branch has unmerged work; warn and stay.

This never discards commits, never creates branches, and never rewrites history.

## Progress tracking (concurrent sessions)

Several sessions — terminal tabs, sibling worktrees, parallel agents — may run this command at once. They coordinate through one shared JSON file, `~/.claude/bug-fix-progress.json`. No broker, no lock, no daemon: the contract is *this session loses cleanly with a named error when it sees a sibling claim*, never *both sessions mutate*.

### Format

Object keyed by issue number (string). Missing file → `{}`. Malformed JSON → warn with the parse error, treat as `{}`, and do not silently overwrite.

```json
{
  "1234": {
    "folder": "<absolute working directory>",
    "started_at": "2026-01-01T12:34:56Z",
    "status": "in_progress",
    "completed_at": null,
    "outcome": null
  }
}
```

Timestamps are ISO 8601 UTC, second precision, literal `Z` (`YYYY-MM-DDTHH:MM:SSZ`). Identity checks compare `started_at` as raw strings — never parse-then-reformat.

`status` is `in_progress`, or one of two terminals: `plan_complete` (`outcome` = absolute plan path) or `issue_closed` (`outcome` = one-line close reason).

Every write is an atomic read-modify-write: re-read, change only this issue's key, write the whole object to `~/.claude/bug-fix-progress.json.tmp.<pid>`, rename into place. Write failures warn and proceed — tracking is best-effort.

### Read an existing entry

| Entry | Targeted path | Auto-pick paths |
|---|---|---|
| none | proceed | proceed |
| `in_progress`, same folder | warn `stale claim from <started_at>`, proceed | warn, proceed |
| `in_progress`, other folder, < 24h old | stop `error=issue_claimed_by_other_folder` (print URL, folder, `started_at`) | skip, reason `claimed_by <folder>` |
| `in_progress`, other folder, ≥ 24h old | warn `abandoned claim`, proceed (overwrite) | warn, proceed |
| terminal, any folder | warn with prior `outcome`, proceed | skip |

The 24-hour TTL is the only automatic stale-claim recovery. Earlier, the user deletes the entry by hand. This command never deletes another folder's claim.

### Claim, finish, release

- **Claim** — write `in_progress` for this folder once the issue is identified (see each path below), before further prechecks and triage. Under `--dry-run`, print the claim that would be written.
- **Finish** — as the last step before the final print, set the terminal `status`, `completed_at`, and `outcome`. Under `--dry-run`, print it instead.
- **Release** — on any stop after the claim was written: re-read the file; if the entry's `folder` *and* `started_at` both match this session's claim, delete the entry; otherwise (missing, or a sibling reclaimed it) leave the file alone. Release is silent, idempotent, and runs before the error is printed, so a failed run never locks other folders out for 24h.

## Resolve the target issue

### Closing-keyword PR detection

Used by every path and re-check below. Run one search, then post-filter:

```
$GH_WRAPPER gh pr list --state open --search "#<NNN> in:body" --json number,url,body
```

Keep only PRs whose body matches, case-insensitively, `\b(close[sd]?|fix(es|ed)?|resolve[sd]?):?\s+#<NNN>\b` — every GitHub closing keyword, with or without a colon, whole-word, and with the number bounded so `#12` does not match `#123`. A bare mention (`see #<NNN>`) does not count. Titles are not auto-linked, so search bodies only.

### Fetching an issue

`gh issue view --json` does **not** accept `locked` (it aborts with `Unknown JSON field`). Fetch lock state with a separate REST call; never merge the two:

```
$GH_WRAPPER gh issue view <NNN> --json number,title,body,state,labels,createdAt,closedAt,url
$GH_WRAPPER gh api repos/{owner}/{repo}/issues/<NNN> --jq .locked
```

### Targeted path — explicit number

1. Strip a leading `#`; validate a positive integer, else `error=invalid_argument`.
2. Fetch the issue.
   - Not found → `error=issue_not_found`.
   - Closed → `error=issue_already_closed`, quoting `closedAt`; suggest reopening only if the bug is still observable today.
   - Locked → `error=issue_locked` with the URL.
   - Title contains `duplicate`/`dup` or label `duplicate` → `error=duplicate`; ask the user to point at the canonical issue.
   - Label `wontfix`, `question`, `discussion`, or `epic` → warn and **proceed** (the user named it); repeat the label in the final message.
3. Check the progress file (targeted column); then write the claim.
4. Glob `$PLANS_DIR/fix-<NNN>-*.md`. A match → warn, name the path, proceed (the new plan replaces it).
5. Run closing-keyword PR detection. **A match → warn that an open PR already claims to close this issue, print its URL, and proceed** (the user may want a fresh take); repeat the PR in the final message.

Steps 1–5 halt identically under `--dry-run`. Steps 1–2 and the claim check fire before any claim exists, so they release nothing.

### `--rca` path — latest RCA-shaped issue

1. List open RCA-shaped issues, union the two queries, dedupe by number (prefer the label row), sort by `createdAt` descending:

   ```
   $GH_WRAPPER gh issue list --state open --label rca --sort created --order desc --limit 50 --json number,title,createdAt,labels,url
   $GH_WRAPPER gh issue list --state open --search '"[rca]" in:title' --sort created --order desc --limit 50 --json number,title,createdAt,labels,url
   ```

   Empty → `error=no_open_rca_issues`.
2. Iterate newest to oldest, applying the **auto-pick skip rules** below.
3. First survivor is the pick; exhausted → `error=no_actionable_rca_issue` with the skip table.
4. Claim, then run the **post-pick re-check** below.

### Oldest-first path — no arguments

1. List open issues oldest first (pull requests are excluded by `gh issue list`):

   ```
   $GH_WRAPPER gh issue list --state open --search "sort:created-asc" --limit 200 --json number,title,labels,createdAt,url
   ```

2. Iterate oldest to newest, applying the **auto-pick skip rules** below.
3. First survivor is the pick; exhausted → `error=no_actionable_issue` with the skip table (number, title, reason). Do not loosen the rules to force an action — an empty or all-skipped list is a valid end state.
4. Claim, then run the **post-pick re-check** below.

### Auto-pick skip rules

The user did not target these issues, so skip silently (recording each reason for the skip table) when, cheapest first:

1. A label is `wontfix`, `duplicate`, `question`, `discussion`, or `epic` (reason: the label).
2. The progress file shows a sibling `in_progress` claim within 24h (`claimed_by <folder>`) or any terminal entry (`previously <status>`).
3. A plan already exists at `$PLANS_DIR/fix-<NNN>-*.md` (`plan exists`).
4. Closing-keyword PR detection finds an open PR (`open PR <url>`).

Lock state is not in `gh issue list`, so a locked pick is caught at the post-pick re-check (`locked`).

### Post-pick re-check (auto-pick paths)

Between pick and act a sibling may close, lock, label, plan, or open a PR against the issue. Right after claiming, re-fetch the issue (with the separate lock call) and re-run the plan glob and PR detection. If any skip rule now fires — or the issue is closed or locked — release the claim, drop the pick, and resume iteration at the next entry. Cap re-picks at 3; beyond that stop with `error=picking_thrash` and print the picked-then-dropped table. The targeted path never re-picks.

## Read the picked issue

The issue is **RCA-shaped** if its title starts with `[rca]`, a label is `rca`, or the body has both `## Symptom` and `## Root cause`. An `rca`-labeled issue missing both sections routes as RCA but parses loosely; say so in the final message.

For full-shape RCA issues, extract the summary, symptom, proximate cause (`file:line`), root cause (`file:line`, or an explicit "root cause unidentified" note), suggested fix (often absent), cross-checks (suspect commit SHAs, hypotheses), and evidence pointers. For other issues, extract whatever is there: failure description, cited paths, errors, repro steps, SHAs.

A missing `file:line` or an unidentified root cause does not stop the command — an issue that describes a clear symptom is still triageable.

## Triage against today's tree — by intent

This is a critique pass over the issue as a snapshot in time. Mechanical checks produce evidence; they do not render verdicts. Findings feed the decision and are **never** written back to the issue.

1. **Already fixed?** For each cited file: `git log --since="<createdAt>" --pretty=format:'%h %ad %s' --date=iso -- <path>`, then `git show <SHA>` on each hit. A fix-shaped commit (`fix:` prefix, "Fix …", `Fixes #<NNN>`, or naming the issue) at or near the cited code is a strong signal; capture SHA, date, and subject.
2. **Cited files exist?** Locate renamed/moved files by name and neighbouring symbols; the plan uses current paths. A file *removed* with no equivalent surface favors close.
3. **Cited spans still match?** Read each cited `path:line`. Shifted lines are drift; a symbol rewritten so the behavior changed is stronger evidence.
4. **Suspect SHAs still in tree?** `git show <SHA> --stat`. Missing is drift, not a verdict.
5. **Adjacent tests.** Find the tests nearest the cited code. Note where a regression test fits. A test that already asserts the corrected behavior is strong close evidence.
6. **Project rules.** Check the candidate fix shape against the invariants and rules in the project's `CLAUDE.md`. If the only implementable fix would break one the issue does not address, that is an invariant collision — plan, and name the rule in the addendum.

Sort findings into:

- **Intent-killing evidence** — the bug's behavior is provably absent: a fix landed and current behavior matches the request; the whole surface was removed; a test asserts the correct behavior; the contested option no longer exists. Weak signals can converge into this; no single check is the trigger.
- **Anchor drift** — shifted lines, renamed/moved symbols, missing SHAs, missing anchors with a clear symptom. Never a verdict; becomes an addendum note.
- **Invariant collision** — the only fix would violate a load-bearing project rule.

### Forbidden remedies

If the issue suggests a fix, the plan may inherit it only if it is not a forbidden remedy. Otherwise drop it and design the fix from the root cause. Forbidden:

- **Suppressing errors** — empty or broad catch-all handlers, widening an exception handler to swallow the symptom, log-and-continue on a non-transient error, demoting an error log's severity, reclassifying a real failure as transient/retryable.
- **Masking with recovery** — retries or restarts around non-transient failures, top-level catch-alls that keep a process alive past a broken state.
- **Symptomatic tuning** — raising a timeout, limit, or cap, or adding a retry, unless evidence shows the limit itself is the root cause.
- **Gate bypasses** — skipping, disabling, or deleting tests; marking them expected-to-fail (except the failing-test-first step); weakening assertions; coverage exclusions or lowered thresholds; lint or type-check ignore comments or disabled rules (e.g. `# type: ignore`, `eslint-disable`, `#[allow(...)]`, `@ts-ignore`).
- **Deletion without replacement** — unless the code is provably dead.

Encouraged: fix the upstream defect; turn a silent bad state into an earlier, louder failure (assertion, type narrowing, explicit error); add a regression test capturing the bad state; tighten an existing bound when evidence shows it caused the problem.

A forbidden suggestion invalidates only the suggestion, never the bug.

## Decide: plan or close

First match wins:

1. **Intent-killing evidence converges → close.** Keep the evidence verbatim for the comment.
2. **Otherwise → plan.** Drift, missing anchors, invariant collisions, forbidden-only suggestions, and weak evidence all default to plan.

## Re-checks before mutating

The early prechecks happened before triage; a sibling may have acted since. Run these immediately before the plan write or the close. Under `--dry-run` every outcome below is a **warning printed alongside the prepared output**, not a stop. Every stop here releases the own claim first, then prints the error with the contended URL. Never retry automatically.

**Both paths:**

- Re-fetch the issue (with the separate lock call).
  - Closed → `error=issue_already_closed_race` with `closedAt`. Do not reopen or comment.
  - Locked → `error=issue_locked_race`.
  - New `duplicate` label → targeted: `error=duplicate_race`; auto-pick: treat as a stale pick (post-pick re-check rules).
  - New `wontfix`/`question`/`discussion`/`epic` → targeted: warn, proceed; auto-pick: stale pick.
- Re-read the progress file and compare this issue's entry to this session's claim (raw-string `started_at`):
  - Same folder, same `started_at`, `in_progress` → proceed.
  - Other folder (`in_progress` or terminal), or entry missing → `error=progress_claim_lost`, printing both folders/timestamps or the prior `outcome` (or `claim file mutated by external editor`). Do not mutate.

**Close path only:**

- Re-run closing-keyword PR detection. A match → `error=linked_pr_appeared` with the PR URL — the PR will close the issue on merge; closing now would double-notify.

**Plan path only:**

- Re-glob `$PLANS_DIR/fix-<NNN>-*.md`. A *different* slug written by a sibling → write anyway and add `sibling plan at <path>` to the addendum. Same slug → overwrite.

## Close path

1. Build a comment of at most 8 lines:
   - One-line reason: `bug behavior no longer present in tree`, `feature surface cited by the issue removed from tree`, or `today's code already behaves as the issue requested`.
   - One bullet per signal: ``Resolved by `<SHA>` (<date>) — "<subject>".`` / ``- `<path>` removed in `<SHA>` (<date>); no equivalent surface remains.`` / ``Test `<name>` asserts the corrected behavior.`` / ``Current code at `<path>:<line>` exhibits the requested behavior.``
   - `Reopen if the behavior is still observable against today's tree, with a fresh repro.`
   - `Closed by /bug-fix after verifying intent against current $MAIN_BRANCH.` (substitute the real branch name)

   No `Fixes #<NNN>`, no log dumps or stack traces, nothing secret-shaped.
2. Run the re-checks.
3. `--dry-run` → print URL, reason, and comment; stop.
4. Post and close in one call so a partial failure cannot leave a comment on an open issue:

   ```
   $GH_WRAPPER gh issue close <NNN> --reason completed --comment "$(cat <<'EOF'
   <comment body>
   EOF
   )"
   ```

   If `gh` reports the issue already closed or cannot close it, release the claim and stop with `error=issue_already_closed_race`, quoting stderr. Do not retry.
5. Finish the progress claim (`issue_closed`, outcome = reason line).
6. Print `Closed: <url> — <reason> (<short evidence>)`.

Do not change labels, assignees, or lock state. Do not write a plan.

## Plan path

1. **Path:** `$PLANS_DIR/fix-<NNN>-<slug>.md`. Slug from the title: strip a leading `[rca] `, lowercase, collapse non-alphanumeric runs to `-`, trim `-`, truncate to ≤60 chars at a word boundary; empty → `issue-<NNN>`.
2. **Frame around intent.** Describe the wrong behavior in terms of *today's* code. Point only at current paths and lines — never copy stale anchors forward. Where the issue cited a now-split file, name each current location. With no anchors at all, open with the symptom and name where the implementer should start.
3. Run the re-checks.
4. `--dry-run` → print the plan body; stop.
5. Write atomically: `$PLANS_DIR/fix-<NNN>-<slug>.md.tmp.<pid>`, then rename into place (create `$PLANS_DIR` if missing). Finish the progress claim (`plan_complete`, outcome = absolute plan path). Record the plan pointer. Print `Wrote plan: <path>`, followed — only when any apply — by addendum bullets:
   - each anchor drift (`issue cited X → plan targets Y`);
   - non-RCA or loosely parsed issue;
   - no `file:line` anchor (name the symptom the plan anchors to);
   - invariant collision (name the project rule);
   - an existing plan was replaced (name it);
   - `sibling plan at <path>`;
   - **an open PR already closes this issue** (URL);
   - a `wontfix`/`question`/`discussion`/`epic` label;
   - the suggested fix was a forbidden remedy and was replaced;
   - `QUALITY_GATES` is missing from the pipeline config.
6. Do not comment on, label, or link the issue. The eventual PR's `Fixes #<NNN>` closes it on merge.

### Plan layout

The plan reads as freshly authored — no "the issue said", no drift section, no comparison with prior versions.

1. `# Plan: <title>` — issue title with `[rca]` stripped; no issue number.
2. `Fixes: #<NNN>` — on its own line, so `/create-pr` puts `Fixes #<NNN>` in the PR body.
3. `## Context` — what is broken, why it matters, the intended outcome, in fresh prose. Cite the root-cause location once (current path:line). No pasted logs.
4. `## Implementation steps` — numbered; each with a short title, files and current line ranges, and 1–3 sentences:
   1. **Add a regression test capturing the bad state** — name the test file and test; describe the triggering inputs and the asserted bad state. Follow the project's testing rules (`$TEST_GUIDELINES`, default the project's `CLAUDE.md`): mock external systems, no real network or sleeps. The test lands in the same commit as the fix — never a failing test on its own.
   2. **Fix the root cause** at the current location, reusing patterns found during triage.
   3. **Tighten the invariant** (optional) — make the same defect fail loudly and earlier at the same site.
   4. **Update docs** — only if the fix changes a documented rule or module purpose.

   Order steps so an interrupted run leaves a working tree.
5. `## Critical files` — files to modify, current paths.
6. `## Reused functions and utilities` — `path:line — symbol — purpose`, or `None — fix is self-contained.`
7. `## Verification` — run `$QUALITY_GATES` (name the configured command) plus the new test by name; add a manual repro step when the original failure needed a runtime trigger. End with: `When opening the PR, include "Fixes #<NNN>" in the body so the issue auto-closes on merge.`
8. `## Out of scope` — forward-looking boundaries (surrounding refactors, adjacent hardening, other call sites).

### Record the plan pointer

After a real (non-dry-run) write, record this folder's latest plan so `/impl` with no argument picks it. In `~/.claude/last-plan-by-folder.json` (object keyed by absolute working directory), set:

```json
{ "<absolute working directory>": { "plan": "<absolute plan path>", "written_at": "YYYY-MM-DDTHH:MM:SSZ" } }
```

Atomic read-modify-write via `~/.claude/last-plan-by-folder.json.tmp.<pid>` and rename; preserve other keys; malformed JSON → warn, treat as `{}`. Best-effort — a failure warns and proceeds.

## Errors

All errors print as `error=<code>` with the issue or PR URL where relevant. Races are loud, never silent, and never retried (the bounded auto-pick re-pick is the only exception).

| Code | When |
|---|---|
| `invalid_argument` | bad token shape, or integer + `--rca` |
| `issue_not_found`, `issue_already_closed`, `issue_locked`, `duplicate` | targeted early checks |
| `issue_claimed_by_other_folder` | sibling claim within 24h (targeted) |
| `no_actionable_issue`, `no_open_rca_issues`, `no_actionable_rca_issue` | auto-pick exhausted (print skip table) |
| `picking_thrash` | more than 3 post-pick invalidations |
| `issue_already_closed_race`, `issue_locked_race`, `duplicate_race`, `linked_pr_appeared`, `progress_claim_lost` | re-checks before mutating |

## Scope limits

- One issue per invocation.
- Never edit issue bodies, labels, milestones, or assignees. The close path's only GitHub mutation is the single `gh issue close --comment`.
- Never run quality gates, invoke `/impl`, create branches, push, open PRs, or merge — gates belong in the plan's Verification, executed later.
- Never let anchor drift decide the verdict.

## Safety

- Read-only against the repo and GitHub except for exactly one of: the plan file (plan path) or the single close-with-comment (close path) — never both. The progress file and plan pointer under `~/.claude/` are local coordination state, never a substitute for either.
- Close only when intent-killing evidence converges; mixed evidence means plan.
- If a cited location no longer exists, re-target the same intent at the current location — but confirm the symptom maps there in today's code; never retarget on name-matching alone.
- If the suggested fix is entirely forbidden remedies, plan against the underlying intent and say what was substituted. If no clean fix exists at any scope, plan the constraint and the safest partial improvement.
- Redact tokens, auth headers, API keys, and other secret-shaped strings from anything quoted into a plan or comment. Never edit the issue to redact.
- Leave uncommitted changes untouched. The only git state changes are the guarded `git switch $MAIN_BRANCH` and `--ff-only` fast-forward described above; otherwise use `git log`, `git show`, `git status` only. Never amend, reset, force-push, use `git stash`, or rewrite history.
- Touch no source files, runtime data, or deployment config.

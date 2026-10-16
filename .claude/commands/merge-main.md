Merge the latest `origin/$MAIN_BRANCH` into the current branch, resolve conflicts preserving both sides' intent, run the quality gates, and push.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:
- `MAIN_BRANCH` — integration branch (default `main`).
- `QUALITY_GATES` — full gate command, exit 0 when green. If missing, stop with `error=missing_quality_gates` and ask the user to add it.
- `GATE_WRAPPER` — optional prefix for every gate run (e.g. `.claude/scripts/gate-slot.sh`; exit 75 means all slots are busy — re-run).
- `GH_WRAPPER` — optional prefix for `git fetch` / `git push` / `gh` commands.
- `PLANS_DIR` — where plan files live (default `~/.claude/plans`); `PROPOSALS_DIR` — optional proposal docs.

## Steps

1. **Check prerequisites.** Stop and surface the reason if any fails:
   - the current branch is not `$MAIN_BRANCH` (`error=on_main_branch`);
   - HEAD is attached to a branch, not detached (`error=detached_head`);
   - `git status --porcelain` is empty (`error=dirty_tree` — commit first; never stash).

2. **Fetch.** `$GH_WRAPPER git fetch origin $MAIN_BRANCH`

3. **Check whether a merge is needed.** If `git log HEAD..origin/$MAIN_BRANCH --oneline` is empty, report "already up to date" and stop.

4. **Merge — never rebase.** `git merge origin/$MAIN_BRANCH --no-edit`. If it is clean, go to step 6.

5. **Resolve conflicts.**
   - List them: `git diff --name-only --diff-filter=U`.
   - Locate the *originating plan* (below) and announce which one, if any, informs the resolution.
   - For each conflicted file, read the whole file and both sides of every hunk. Read `git log --oneline HEAD..origin/$MAIN_BRANCH -- <file>` and `git log --oneline origin/$MAIN_BRANCH..HEAD -- <file>` to learn what each side was doing.
   - Produce a merged result that keeps **both** intents: the branch's intended change (as the plan states it, when there is one) *and* main's change. Never silently drop either side to match the plan.
   - Remove all conflict markers, `git add <file>`, and finish with `git commit --no-edit`.
   - For an ambiguous or high-risk resolution (both sides changed the same logic incompatibly), explain it to the user, citing the plan step or acceptance criterion that drove it.

6. **Run the quality gates** in the foreground with the maximum tool timeout — never in the background, since a backgrounded run can be reaped when the turn yields:
   ```
   $GATE_WRAPPER $QUALITY_GATES
   ```
   On failure (usually a merge incompatibility), fix the root cause — no suppressions, skips, or lowered thresholds — stage the fix, amend the merge commit, and re-run until green.

7. **Push** — only once every gate passed, and never with `--force`:
   ```
   $GH_WRAPPER git push -u origin HEAD
   ```
   - Success → step 8.
   - Rejected as non-fast-forward (someone pushed to this branch) → recovery cycle:
     1. `$GH_WRAPPER git fetch origin <branch>` then `git merge origin/<branch> --no-edit` (no rebase).
     2. Resolve any conflicts as in step 5.
     3. Re-run `$QUALITY_GATES`; fix failures as new commits (do not amend), so each upstream round stays auditable.
     4. Push again. At most 3 recovery cycles; then stop with `error=push_contended` — the branch is being actively pushed and the user must coordinate.
   - Any other failure (auth, protected branch, hook) → stop and surface it; do not retry blindly.

8. **Report.** Commits merged from `origin/$MAIN_BRANCH`; conflicts and how each was resolved; which originating plan informed them and how it was found (branch name, folder pointer, or none); gate result; whether upstream branch commits had to be integrated; whether the push succeeded.

## Originating plan (for conflict resolution)

Only when step 5 has conflicts. Read-only, best-effort context: a missing or unclear plan never blocks, reorders, or aborts the merge — fall back to git history.

1. **From the branch name.** `git rev-parse --abbrev-ref HEAD`, strip a leading `feat/`/`fix/`/`refactor/`, and read `$PLANS_DIR/<slug>.md`. If absent and the branch ends in a `/impl` uid segment (`-<token>` matching `^[0-9]{12}[0-9a-f]*$`), strip only that segment and retry once — never strip an ordinary slug word. When `$PROPOSALS_DIR` is set and the slug names a proposal number, a matching proposal doc's steps and acceptance criteria may serve as the intent source if no plan file exists.
2. **Folder pointer fallback.** Otherwise read `~/.claude/last-plan-by-folder.json`, look up this absolute working directory, and use the named plan if it still exists and is non-empty — announcing that it came from the pointer so the user can object.
3. **Never** fall back to the globally newest plan in `$PLANS_DIR`; it is shared across checkouts and may belong to another branch.
4. **Confirm relevance.** Read the plan in full. If none of its cited files intersect the conflicted (or merged) files, use it only as weak background, never as the tie-breaker; if most cited paths do not exist in the tree, discard it.

## Safety

- Never run on `$MAIN_BRANCH`; never rebase; never force-push.
- Never push while a gate is failing.
- Never discard the branch's changes in favour of main, or main's in favour of the plan — always a proper merge.
- Never `git stash` (parallel worktrees share the stash); stop on a dirty tree instead.
- Never write plan files or `~/.claude/last-plan-by-folder.json`.
- Explain every non-trivial conflict resolution.

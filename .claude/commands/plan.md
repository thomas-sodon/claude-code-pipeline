Plan the work for the free-text concern `$ARGUMENTS`: ground it in today's tree and write a self-contained plan file for `/impl`.

This command is the **free-text entry point to the plan pipeline**. It takes a concern in your own words, grounds it first-hand in the current code, writes a plan to `$PLANS_DIR/plan-<slug>.md`, and records that plan as this folder's most-recent plan in `~/.claude/last-plan-by-folder.json` so a later `/impl` with no argument picks it up. The plan is the whole deliverable: no code is written, nothing is committed, no branch is created, no issue is filed.

The plan covers **only the next increment** — the smallest coherent, independently-mergeable chunk of work that resolves the concern's core and lands as one focused PR. If the concern is large, plan the first unbuilt slice and name later increments in `## Out of scope`.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines). This command uses:

- `MAIN_BRANCH` — integration branch (default `main`).
- `PLANS_DIR` — where plans are written (default `~/.claude/plans`).
- `PROPOSALS_DIR` — optional design/proposal docs (default: none; skip proposal checks).
- `GH_WRAPPER` — optional prefix for `gh` and git network commands (default: none; use ambient auth).
- `QUALITY_GATES` / `QUALITY_GATES_FAST` — named in the plan's `## Verification` section. If `QUALITY_GATES` is missing, still write the plan but add a report addendum asking the user to add it (`/impl` will stop with `error=missing_quality_gates` without it).
- `TEST_GUIDELINES` — where the project's testing rules live (default: the project's `CLAUDE.md`).

## Arguments

`$ARGUMENTS` is a space-separated list of tokens. Recognized flags are below; **everything else is joined into the free-text concern** (required).

- `--dry-run` — print the plan body to stdout; write nothing (no plan file, no pointer update) and change no git state.
- `--slug=<slug>` — force the output slug. Must be kebab-case and ≤60 chars, else `error=invalid_argument`. A leading `plan-` is stripped, so `--slug=plan-foo` and `--slug=foo` both write `plan-foo.md`.
- `--no-switch` — skip the switch to `$MAIN_BRANCH` (and its refresh) and plan against the branch currently checked out. Use it when the concern is about work in flight on this branch.

An unrecognized `--`-prefixed token is never swallowed into the concern: stop with `error=invalid_argument`, naming the token and the recognized forms (a typo'd `--dryrun` or a space-separated `--slug foo` must not turn a write-nothing run into a real write). No concern text → stop with `error=missing_concern` and an example (`/plan the status endpoint recomputes the full report on every poll and should cache it per request`).

## Route the concern elsewhere first

Run this text-only check **before** any git operation, so a routed-away run never moves the user off their branch:

- **The concern names a GitHub issue** (`#NNN` or an `.../issues/NNN` URL) → recommend `/bug-fix NNN`, which verifies the issue and writes a plan whose PR auto-closes it. Stop. A `#` that is plainly not an issue reference (a heading, a shell comment) does not trigger this.

Two more checks run after *Read the concern*, once its nouns are known:

- **A proposal already covers it.** When `$PROPOSALS_DIR` is set, grep it for the concern's nouns. If an open proposal/design doc covers this concern's substance (not merely the same module), stop and name it — `/impl <path-to-doc>` implements its next step.
- **The concern is a structural class, not one change.** If it reads "keeps happening", "every fix adds another", or lands on code with a visible trail of point fixes, the right deliverable is a design doc that closes the class, not an increment plan. Say so and stop.

These are recommendations, never delegations: do not invoke another command from inside this one.

## Switch to the main branch if on a merged branch

Land on a current tree before grounding, so the plan is not grounded in a stale, already-merged branch. Skip this whole section under `--no-switch` (announce it) or `--dry-run` (print the switch it *would* have run). Otherwise switch only when provably safe:

1. `git rev-parse --abbrev-ref HEAD`:
   - `$MAIN_BRANCH` → no switch needed, but refresh: on a clean tree, `$GH_WRAPPER git fetch origin $MAIN_BRANCH` then `git merge --ff-only origin/$MAIN_BRANCH`. Dirty tree, fetch failure, or a failed fast-forward (diverged) → warn and proceed on the local branch as-is.
   - `HEAD` (detached) → warn and proceed without switching.
2. **Dirty-tree guard.** If `git status --porcelain` is non-empty, do not switch; warn and proceed on the current branch. Uncommitted changes are never touched.
3. **Refresh (best-effort).** `$GH_WRAPPER git fetch origin $MAIN_BRANCH`; on failure fall back to the local `$MAIN_BRANCH` ref.
4. **Fully-merged test.** `git merge-base --is-ancestor HEAD origin/$MAIN_BRANCH` (or the local ref on fallback):
   - exit 0 → `git switch $MAIN_BRANCH`, then `git merge --ff-only origin/$MAIN_BRANCH` (skip on fetch fallback). Announce `Switched from <branch> (fully merged) to $MAIN_BRANCH`. If either command fails (e.g. the branch is checked out in a sibling worktree, or local main diverged), warn and proceed on the current branch.
   - non-zero → the branch carries unmerged work; leave it, warn, and proceed on it.

The switch never discards commits, never runs on a dirty tree, creates no branch, and rewrites no history.

## Read the concern

Pin the concern down before touching code. Extract:

1. **The observable** — what is wrong, missing, or wanted, in the user's words. The finished plan must address exactly this.
2. **The nouns** — modules, symbols, config keys, file paths, CLI commands, domain terms. These are the grep targets.
3. **The shape** — exactly one of:
   - **bug-shaped** — existing behavior is wrong. The plan leads with a regression test.
   - **feature-shaped** — behavior that does not exist yet should.
   - **refactor-shaped** — behavior is correct; structure, ownership, or duplication is the problem.
   - **docs-shaped** — the code is right; the documentation has drifted.

   When two fit, pick the one the observable describes, not the one the suggested remedy implies.
4. **The stated remedy**, if any — a hypothesis to confirm or replace during grounding, never the plan itself. A remedy matching *Forbidden remedies* is dropped even when asked for.
5. **Explicit constraints** — approaches the concern rules in or out. They bind the plan.

If no observable can be extracted, stop with `error=concern_too_vague`, quote what you extracted, and name the specifics that would make it plannable.

## Ground the concern in today's tree

The plan must rest on code you read first-hand, not on the concern's description of it. Do not delegate this to subagents.

1. **Map nouns to code.** Grep each noun across the source, tests, docs, and config. Read the implicated functions **in full, plus their direct callers** — skipping callers is how a plan breaks call sites it never saw.
2. **Confirm the observable exists.** For a bug, find the code path that produces it and state it in one sentence. If it is not reproducible today (already fixed, surface gone), stop with `error=concern_not_reproducible`, citing the current code and the commit that changed it (`git log -S<symbol> --oneline -5`).
3. **Check the project's rules.** Read the sections of the project's `CLAUDE.md` covering the implicated area, and any structural/lint tests that enforce them. A concern that asks for something a project invariant forbids is not planned around the invariant — find the compliant route, or report the collision.
4. **Find the adjacent tests.** Read the tests nearest the change site: they reveal the intended contract, supply fixtures to reuse, and sometimes assert the very behavior the concern calls wrong — which the plan must confront, not silently break. Follow the rules in `TEST_GUIDELINES`.
5. **Check the config surface.** If the concern implies a new setting, look for an existing one first. Reusing a key beats adding a rival.

Every path and symbol in the plan comes from this step. Cite by file path and symbol; a line range is acceptable but the symbol is what survives drift.

## Research what the concern does not say

Use the **Explore** subagent for discovery only: usage patterns, prior implementations to reuse, other call sites of a helper being changed. One call by default; up to 3 in parallel only when the concern spans several layers. Give each the one-sentence observable, a short summary of the implicated code, and one specific question. Explore never substitutes for the first-hand reading above.

## Scope to one increment

1. State the **core**: the one change without which the concern is not addressed.
2. Keep only what the core needs to be safe and testable; move tempting adjacent improvements to `## Out of scope`.
3. If the core is still too big for one focused PR, plan its first slice. More than ~7 implementation steps signals the increment was not cut.
4. Order steps so an interrupted run leaves the tree working. Put risky behavior changes behind a flag defaulting to today's behavior when the project has such a convention.

### Forbidden remedies

The plan must not be built from these, even when the concern asks for one:

- Bumping a timeout, cap, retry count, or threshold as the primary fix, unless grounding proves the limit itself is the root cause.
- Silencing: broad catch-and-continue, log-level demotions, type-checker or linter suppressions on a real bug, or any gate bypass (test skips, coverage pragmas, `--no-verify`).
- Auto-recovery that hides the failure (blind retries on a non-transient error, restart loops).
- One more special-case guard added to an existing pile for this one symptom — that is a structural class (see routing).

When the stated remedy matches one of these, the plan carries a clean replacement and the report says which remedy was dropped and why.

## Write the plan file

1. **Title and slug.** Synthesize a short imperative title (≤8 words) describing the end state, not the symptom (`Cache the status report per request`, not `Status is slow`). Slug: `--slug` if given; otherwise lowercase the title, replace non-alphanumeric runs with `-`, trim and collapse `-`, truncate to ≤60 chars at a word boundary; empty → `concern`.
2. **Candidate path:** `$PLANS_DIR/plan-<slug>.md`. The `plan-` prefix distinguishes these from `/bug-fix`'s `fix-<N>-…` plans.
3. **Supersede check.** Glob `$PLANS_DIR/plan-*.md` and read the title and `## Context` of any whose slug overlaps this one's significant words. If one covers the same concern, **rebind the output path to it** and overwrite in place rather than writing a near-duplicate; note it in the report. The rebound value is the **resolved output path** used by every later step.
4. Under `--dry-run`, print the plan body and stop — no file, no pointer.
5. **Write atomically:** write to `<resolved path>.tmp.<pid>`, then rename into place, so a concurrent reader never sees a truncated plan.

### Plan layout

The plan reads as **freshly authored**: it does not quote the request, does not mention this command, and has no drift/comparison section.

1. **`# Plan: <Title>`**
2. **`## Context`** — what is wrong or missing, why it matters, the intended end state. Cite the target file and symbol once. No pasted concern text or log excerpts.
3. **`## Implementation steps`** — numbered, one increment only. Each step: a short title, the file(s) and symbol(s) touched, and a 1–3 sentence description. Ordering by shape:
   - **bug** — step 1 adds the regression test (file, test name, triggering inputs); step 2 applies the root-cause fix; optionally a step that makes the defect fail loudly and earlier. The test lands in the same commit as the fix — never a failing test alone.
   - **feature** — smallest working surface, then its tests, then wiring into its caller.
   - **refactor** — new structure alongside the old, move call sites, delete the old last. Name the characterization tests that prove equivalence.
   - **docs** — the drifted claim, the code that contradicts it, the corrected wording.
4. **`## Critical files`** — files to be modified, by current path.
5. **`## Reused functions and utilities`** — `path — symbol — purpose` per helper to call instead of reimplementing; or the single bullet `None — change is self-contained.`
6. **`## Verification`** — concrete end-to-end checks. Default to `$QUALITY_GATES` (and `$QUALITY_GATES_FAST` for iteration), name every new test explicitly, and add a one-line manual repro when the behavior needs a runtime trigger.
7. **`## Out of scope`** — forward-looking boundaries ("Reworking the surrounding module is out of scope"), later increments, and constraints the concern ruled out.

## Record the plan pointer

Skipped under `--dry-run`. After writing, record the plan in `~/.claude/last-plan-by-folder.json`, keyed by the absolute working directory:

    {
      "<absolute path of the working directory>": {
        "plan": "<absolute path of the plan just written>",
        "written_at": "2026-05-24T12:34:56Z"
      }
    }

Read-modify-write atomically: read the file (missing → `{}`; malformed → warn and treat as `{}`), set this directory's entry (ISO 8601 UTC, no fractional seconds, literal `Z`), preserve every other key, write to `~/.claude/last-plan-by-folder.json.tmp.<pid>`, rename into place. Best-effort: on failure, warn and continue — the pointer is an optimization for `/impl`, not a correctness requirement.

## Report

Print the resolved output path as the final message:

    Wrote plan: $PLANS_DIR/plan-<slug>.md

Add bullet addenda only when they apply:

- The stated remedy was dropped — which one, which forbidden pattern, and the replacement.
- The concern collides with a project rule in `CLAUDE.md` — name it.
- An existing plan was superseded — the path overwritten.
- The concern was cut to an increment — what moved to `## Out of scope`.
- The switch or refresh was skipped (dirty tree, unmerged branch, `--no-switch`, fetch failure, diverged main) — say which tree the plan was grounded in.
- An open PR or branch already touches the implicated code (`$GH_WRAPPER gh pr list --search <noun>`) — name it.
- `QUALITY_GATES` is missing from the pipeline config.

Close with the next step: `/impl` (no argument needed — the pointer is recorded).

Under `--dry-run`, print the full plan body instead, clearly marked as not written. When a routing check or `error=` stop fired, report that and the recommended next action instead of a path.

## What to skip

- Do not write code, tests, or docs; do not run the quality gates.
- Do not commit, stage, push, open a PR, or create a branch.
- Do not file or comment on issues, and do not author a design doc.
- Do not enter plan mode or invoke other commands.
- One concern per invocation. Two unrelated concerns → plan the first and say so, or stop with `error=concern_too_vague` if neither dominates.

## Safety

- Read-only against the repo, except the safe git-state changes above: a best-effort fetch, a `git switch $MAIN_BRANCH` from a clean fully-merged branch, and a fast-forward of local `$MAIN_BRANCH`.
- Writes go only to the resolved plan path and the pointer file, both outside the repo.
- Never delete a plan file; the supersede rule overwrites one path in place.
- No destructive git: no `reset --hard`, no force-push, no branch deletion, no history rewrite.
- Redact tokens, `Bearer ` headers, API keys, and other credentials from anything quoted into the plan — plans are often pasted into PRs.

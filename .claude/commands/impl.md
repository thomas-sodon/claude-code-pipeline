Review a plan (or the next step of a design doc) against today's tree and, if it is clean, implement it and run the quality gates — without committing.

This command takes a unit of work, validates that every claim in it still holds against the current code, and — only when that review comes back clean — implements it step by step and runs the quality gates. It stops before commit: review the result with `/review-changes` (which hands off to `/polish`), then ship with `/create-pr`.

The unit of work is either a **plan file** in `$PLANS_DIR` (written by `/plan`, `/bug-fix`, or by hand) or, in **doc mode**, the **next unimplemented step** of a proposal/design doc in `$PROPOSALS_DIR`.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines). This command uses:

- `QUALITY_GATES` — **required**. If missing, stop with `error=missing_quality_gates` and ask the user to add it (e.g. `QUALITY_GATES: npm run lint && npm run typecheck && npm test`, or `make check`, or `cargo clippy && cargo test`). Check this before any git operation or edit.
- `QUALITY_GATES_FAST` — quicker subset for iterative runs (default: `QUALITY_GATES`).
- `GATE_WRAPPER` — prefix for every gate run (default: none; `.claude/scripts/gate-slot.sh` is recommended when several agents share a host).
- `MAIN_BRANCH` — integration branch (default `main`).
- `PLANS_DIR` — plan location (default `~/.claude/plans`).
- `PROPOSALS_DIR` — design docs (default: none; doc mode unavailable).
- `GH_WRAPPER` — optional prefix for git network commands (default: none).
- `TEST_GUIDELINES` — the project's testing rules (default: the project's `CLAUDE.md`).

## Arguments

`$ARGUMENTS` is optional:

- *(empty)* — implement this folder's most recent plan (see *Locate the work*).
- `<slug>` — resolve to `$PLANS_DIR/<slug>.md` (`.md` optional).
- `<path>` — a file path. If it resolves inside `$PROPOSALS_DIR`, this is **doc mode**; otherwise it is used as the plan file.

## Locate the work

1. **Detect the mode.** Doc mode when the argument is a path inside `$PROPOSALS_DIR` (and `PROPOSALS_DIR` is set); otherwise plan-file mode. A path into a proposals directory when `PROPOSALS_DIR` is unset → stop with `error=invalid_argument` and ask the user to configure it.
2. **Resolve the plan file** (plan-file mode).
   - Non-empty argument: a path is used directly; anything else is a slug under `$PLANS_DIR`. Missing file → stop with `error=plan_not_found` and list the five most recent files in `$PLANS_DIR`.
   - Empty argument, two tiers:
     - **Folder pointer.** Read `~/.claude/last-plan-by-folder.json` and look up the current working directory's absolute path. If its `plan` exists and is non-empty, use it and announce `Plan pointer: <path> (written <written_at>)`.
     - **Fallback.** Otherwise pick the most recently modified non-empty `*.md` in `$PLANS_DIR` and warn `No folder plan pointer — falling back to the most-recent plan globally`. Nothing found → `error=no_plan_found`.
3. **Read the plan in full.** Layouts vary (`/plan` writes `# Plan:` / `## Context` / `## Implementation steps` / `## Critical files` / `## Reused functions and utilities` / `## Verification` / `## Out of scope`). Extract what it does, which files and symbols it cites, which utilities it reuses, and what verification it specifies.
4. **Project sanity check.** If most cited paths do not exist in this tree, stop with `error=plan_project_mismatch`. Never auto-pick a different plan.

The pointer file is read-only here — `/impl` never writes it. A missing or malformed file, a missing entry, or a deleted plan all fall back to the global most-recent plan. An explicit argument bypasses the pointer.

## Doc mode

Run only when *Detect the mode* chose doc mode. It selects one step from the doc and turns it into a unit of work; from then on, read "the plan" as "the selected step". This command **never edits the design doc**.

1. **Read the doc in full**, including any metadata (status, dependencies) and any "what landed / what is missing" notes.
2. **Locate the step list.** Expect an ordered checkbox list — `N. [x] **Title.** …` for shipped steps, `N. [ ] **Title.** …` for pending — optionally with `Depends on:` and `Acceptance:` sub-bullets. No checkbox step list → stop with `error=no_step_list` and suggest running `/plan` on the doc's next increment instead.
3. **Select the next step** — the first `[ ]` in document order. Then validate:
   - **Human-gated steps.** If the step is explicitly held for a human decision (a rollout, flag flip, or deletion gated on an observation window or sign-off), skip it when a later `[ ]` step still writes code and select that one instead; if every remaining step is gated, stop with `error=step_human_gated`.
   - **Dependencies.** Every step named in its `Depends on:` must be `[x]`. Otherwise stop with `error=step_dependency_unmet` and name the blocker.
   - **Checkbox vs. prose.** If the doc's prose says this step landed (or the tree already meets its acceptance criteria), the checkbox is stale: stop with `error=doc_stale` and tell the user to tick it before re-invoking. Do not edit the doc yourself.
   - **Nothing pending.** Every step `[x]` → stop with `error=doc_complete`.
4. **Extract the unit of work:** step number `M`, title, the files and symbols it names, its description, its dependencies, and its `Acceptance:` criteria — which become binding success criteria, treated like a plan's `## Verification`.

## Review the plan against today's tree

A critique pass: every cited fact must still hold and every step must still be implementable as written. Findings feed *Decide* and are **never** written back to the plan or doc.

1. **Working tree.** Run `git status --porcelain` and `git rev-parse --abbrev-ref HEAD`.
   - **Dirty-tree gate.** Uncommitted changes clearly unrelated to the plan → surface them and ask before proceeding. Never branch over an unrelated dirty tree.
   - **Record HEAD; do not branch yet.** Branch creation waits until *Decide* returns Go, so a run that stops on a blocker leaves no stray branch.
   - **Refresh (HEAD on `$MAIN_BRANCH`, clean tree only).** `$GH_WRAPPER git fetch origin $MAIN_BRANCH` then `git merge --ff-only origin/$MAIN_BRANCH`, before the checks below, so the review sees the tree the branch will be cut from. On fetch failure or divergence, warn and continue on local `$MAIN_BRANCH` as-is. Never fetch or touch a non-main branch the user is on.
2. **Cited files exist.** Renamed or deleted → find the current path by name and neighbouring symbols; if you cannot, that is a blocker.
3. **Cited symbols and line ranges still match.** Shifted line numbers are a concern; a symbol rewritten so the planned change no longer applies is a blocker.
4. **Reused utilities still exist.** A missing reuse target is a blocker.
5. **Config keys.** A setting the plan adds that already exists, partly exists, or conflicts with a sibling is a blocker until the plan accounts for it.
6. **Dependencies.** Prerequisite work the plan names must have shipped (grep for its symbols, or check its doc status). Unshipped → blocker.
7. **Already implemented.** If most of the plan's end state already exists, stop — nothing to implement. In doc mode this is `error=doc_stale`.
8. **Project rules.** Cross-check the plan against the invariants in the project's `CLAUDE.md`. A violation is a blocker until the plan accounts for it.

## Decide

- **Blockers** (drift, missing dependency, conflicting state, rule violation, project mismatch) → stop. Print a `Plan review` report listing each blocker with the plan section or step it affects, any concerns, and a one-line recommendation (revise the plan — e.g. re-run `/plan` or `/bug-fix` — and re-invoke). Do not implement.
- **Concerns only** (shifted lines, a renamed-but-findable helper, a removed adjacent test) → surface them in the same shape and ask the user to confirm. Do not assume yes.
- **Clean** → print `Plan review: clean — proceeding to implementation` and continue.

## Create the implementation branch

Only after *Decide* returns Go, and before the first edit.

1. **Re-check the tree.** Re-run `git status --porcelain`; if something unrelated appeared while waiting on the user, ask. Without confirmation, stop — no branch, no implementation.
2. **Re-read HEAD.** On a non-main branch, leave it: the user chose it (or a workflow created it). No second branch, no fetch.
3. **On `$MAIN_BRANCH`, auto-create the branch** from the already-refreshed local main (do not re-fetch — that could cut the branch from code the review never saw):
   - Plan-file mode: `feat/<plan-slug>-<uid>` (plan basename without `.md`).
   - Doc mode: `feat/<doc-slug>-step<M>-<step-slug>-<uid>`.
   - Sanitize the base slug: lowercase, non-alphanumeric runs → `-`, trim and collapse `-`. Empty → fall back to `feat/plan` (or `feat/<doc-slug>-step<M>`).
   - `<uid>` is generated once per invocation and **must carry random entropy**: `date -u +%y%m%d%H%M%S` followed by `od -An -N3 -tx1 /dev/urandom | tr -d ' '` (six random hex digits). Do not assign it to a shell variable named `UID` (read-only in bash); use e.g. `SUFFIX`.
   - `git checkout -b <name>`. If it already exists, regenerate the suffix with fresh random hex and retry. Never ask the user for a branch name, never reuse or clobber existing work.
4. Print `Branch: <name> (<auto-created from $MAIN_BRANCH | pre-existing>)`. Implementation never begins with HEAD on `$MAIN_BRANCH`.

## Implement the plan

1. **Track the steps.** Create a todo list with one item per plan step (in doc mode, one per discrete change and acceptance criterion of the selected step), in an order that keeps the tree working. Mark each in-progress before starting and completed as soon as it is done.
2. **Implement step by step.**
   - Apply the change, reusing the helpers the plan named instead of reimplementing.
   - Add or update tests in the same step as any behavior change, following `TEST_GUIDELINES` (typically: mock external services, the network, subprocesses, clocks, and sleeps; never touch real user state). For a bug, the regression test must fail before the fix and pass after.
   - If the step adds or removes a module, changes a CLI/API surface, or changes a documented design decision, update the project's docs (and `CLAUDE.md` if an invariant changed) in the same step.
   - If a step proves infeasible as written, stop and surface it. Do not improvise a materially different scope.
3. **Self-review.** Run `git diff` after each step and check for leftover debug code, breakpoints, hard-coded paths, secrets, dead branches, happy-path-only tests, and missing error handling.
4. **Run the quality gates.** Use `$QUALITY_GATES_FAST` while iterating and finish with `$QUALITY_GATES` — each as `$GATE_WRAPPER bash -c '<gate command>'` when `GATE_WRAPPER` is set, so the whole compound command runs under the wrapper and any `$VAR` in it is expanded by the wrapper's shell (write any `'` inside the gate command as `'\''`) — plus every check in the plan's `## Verification` (in doc mode, each `Acceptance:` criterion must be demonstrably met).
   - Run gates in the **foreground** with an explicit long Bash timeout (e.g. `600000`), never in the background — a backgrounded run is reaped when the turn yields and the work stalls silently. If the full gate exceeds the ceiling, split it into its component commands as separate foreground calls.
   - Under `.claude/scripts/gate-slot.sh`: exit `75` means every slot is busy — re-run; `125` means the wrapper could not run — report it rather than treating it as a red gate.
   - Classify a red run before re-running: enumerated test/lint/type failures are an answered red — fix them; a timeout, an OOM-killed worker, or a runner that never started is a resource artifact — re-run once and let that result decide.
5. **Fix failures at the root cause.** No suppression comments, test skips, coverage pragmas, or `any`-style escape hatches unless there is a real, narrow reason you state to the user. After each fix, re-run the failing gate plus any whose inputs changed. The same gate failing three times on the same root cause → stop and ask.

## Report

End with a plain-text summary:

- **Implemented** — plan path and title; in doc mode, the doc path and `step <M> — <title>`.
- **Branch** — name, starting commit short SHA, and whether it was auto-created (and whether main was refreshed first) or pre-existing.
- **Review verdict** — `clean` or `clean-with-concerns`, with the concerns.
- **Files modified** — one line per file with its purpose.
- **Tests added or changed** — what each covers.
- **Quality gates** — which ran, which passed, how many fix iterations.
- **Acceptance criteria** *(doc mode)* — each criterion and how it was met.
- **Deviations from the plan** — anything done differently, and why.
- **Next step** — `/review-changes` (in a fresh session) to review the branch against the plan; it hands off to `/polish`. Only once that is clean, commit and push and `/create-pr`. In doc mode, remind the user to tick step `M`'s checkbox in the doc (in the same PR or after it merges).

## What to skip

- Do not edit the plan file or the design doc.
- Do not implement more than the selected step (doc mode) — one step, one PR.
- Do not refactor outside what the plan touches, and do not invent steps it does not specify. Small unspecified details: make a minimal choice consistent with surrounding code; load-bearing ones: ask.
- **Do not commit, stage, push, or open a PR.**
- Do not switch branches once implementation has begun.
- Do not rewrite the plan or invoke other commands. If the plan is unsalvageable, say so and stop.

## Safety

- Any blocker → stop before implementing; never "implement what is implementable".
- A step that would violate a project invariant mid-implementation → stop and surface; never silently relax it.
- If the working tree contains secret-looking files (`.env`, credentials, tokens), never edit, stage, or delete them; tell the user.
- Never bypass a gate failure with a workaround — fix the root cause.
- No destructive git: no `reset --hard`, `checkout --`, `clean -f`, `git stash` (unsafe across parallel worktrees), branch deletion, or force-push.
- Read-only against `$PLANS_DIR`, `$PROPOSALS_DIR`, and `~/.claude/last-plan-by-folder.json`. The only git-state changes are the best-effort fetch, a fast-forward of local `$MAIN_BRANCH`, and the feature-branch create.

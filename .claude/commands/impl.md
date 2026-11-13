Review a plan (or the next step of a design doc) against today's tree and, if it is clean, implement it and run the quality gates — without committing.

This command takes a unit of work, validates that every claim in it still holds against the current code, and — only when that review comes back clean — implements it step by step and runs the quality gates. It stops before commit: review the result with `/review-changes` (which hands off to `/polish`), then ship with `/create-pr`.

The unit of work is either a **plan file** in `$PLANS_DIR` (written by `/plan`, `/bug-fix`, or by hand) or, in **doc mode**, the **next buildable step** of a proposal/design doc in `$PROPOSALS_DIR` — the first pending code step whose dependencies are done.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines). This command uses:

- `QUALITY_GATES` — **required**. If missing, stop with `error=missing_quality_gates` and ask the user to add it (e.g. `QUALITY_GATES: npm run lint && npm run typecheck && npm test`, or `make check`, or `cargo clippy && cargo test`). Check this before any git operation or edit.
- `QUALITY_GATES_FAST` — quicker subset for iterative runs (default: `QUALITY_GATES`).
- `GATE_WRAPPER` — prefix for every gate run (default: none; `.claude/scripts/gate-slot.sh` is recommended when several agents share a host).
- `MAIN_BRANCH` — integration branch (default `main`).
- `PLANS_DIR` — plan location (default `~/.claude/plans`).
- `PROPOSALS_DIR` — design docs (default: none; doc mode still applies to any `# Proposal:` doc passed by path).
- `GH_WRAPPER` — optional prefix for git network commands (default: none).
- `GITHUB_ACCESS` — not needed here: this command makes no GitHub API call, and its one network command, `git fetch`, stays plain git under either access (`.claude/scripts/github-access.md`).
- `TEST_GUIDELINES` — the project's testing rules (default: the project's `CLAUDE.md`).

## Arguments

`$ARGUMENTS` is optional:

- *(empty)* — implement this folder's most recent plan (see *Locate the work*).
- `<slug>` — resolve to `$PLANS_DIR/<slug>.md` (`.md` optional).
- `<path>` — a file path. A `# Proposal:` doc (wherever it lives) or a path inside `$PROPOSALS_DIR` is **doc mode**; anything else is used as the plan file (see *Detect the mode*).

## Locate the work

1. **Detect the mode.** Doc mode when the argument is a path inside `$PROPOSALS_DIR` (and `PROPOSALS_DIR` is set), or a file whose first heading is `# Proposal:` (the format `/propose` writes, wherever it lives); otherwise plan-file mode. An `# Architecture:` or `# Roadmap:` doc is not a unit of work → stop with `error=invalid_argument`, recommending `/propose --milestone=N` for a roadmap milestone.
2. **Resolve the plan file** (plan-file mode).
   - Non-empty argument: a path is used directly; anything else is a slug under `$PLANS_DIR`. Missing file → stop with `error=plan_not_found` and list the five most recent files in `$PLANS_DIR`.
   - Empty argument, two tiers:
     - **Folder pointer.** Read `~/.claude/last-plan-by-folder.json` and look up the current working directory's absolute path. If its `plan` exists and is non-empty, use it and announce `Plan pointer: <path> (written <written_at>)`.
     - **Fallback.** Otherwise pick the most recently modified non-empty `*.md` in `$PLANS_DIR` and warn `No folder plan pointer — falling back to the most-recent plan globally`. Nothing found → `error=no_plan_found`.
3. **Read the plan in full.** Layouts vary (`/plan` writes `# Plan:` / `## Context` / `## Implementation steps` / `## Critical files` / `## Reused functions and utilities` / `## Verification` / optional `## Rollout` / `## Out of scope` / optional `## Assumptions`; a plan a workflow saved may end with `## Assumptions to review`). A bullet of `## Assumptions`, or an `assumed` line of `## Assumptions to review`, is a choice nobody confirmed: keep it, never ask it again, and treat a reason to change one as a blocking question. An `answered` line of `## Assumptions to review` is what the person settled: it binds like an answer the invoking prompt hands in (see *Questions before assumptions*). Extract what it does, which files and symbols it cites — split into files it **modifies** and files it **creates** (marked `(new)`) — which utilities it reuses, and what verification it specifies.
4. **Project sanity check.** If most cited paths the plan modifies do not exist in this tree, stop with `error=plan_project_mismatch`. Files marked `(new)` never count, so a plan that only creates files is not a mismatch. Never auto-pick a different plan.

The pointer file is read-only here — `/impl` never writes it. A missing or malformed file, a missing entry, or a deleted plan all fall back to the global most-recent plan. An explicit argument bypasses the pointer.

## Doc mode

Run only when *Detect the mode* chose doc mode. It selects one step from the doc and turns it into a unit of work; from then on, read "the plan" as "the selected step". This command **never edits the design doc**.

1. **Lint the doc.** If `.claude/scripts/proposal-lint.py` exists, run `python3 .claude/scripts/proposal-lint.py <doc> --json` first. Any `errors` (exit 1) → stop with `error=doc_malformed`, listing each as `line: code: message`; exit 2 (unreadable) → the same stop, quoting its stderr. Warnings are reported, never blocking. On a clean lint, use its `steps` (number, done, `human_gate`, `files` with their `new` flag, `depends`, `acceptance`) as the parse of the step list.
2. **Read the doc in full**, including its header (`Status:`, `Architecture:`) and any "what landed / what is missing" notes.
3. **Check its status.** `Status: draft` → stop with `error=doc_not_accepted`: a person sets `accepted` before anything is built. No `Status:` line → warn and proceed.
4. **Locate the step list.** Expect an ordered checkbox list — `N. [x] **Title.** …` for shipped steps, `N. [ ] **Title.** …` for pending — with `Files:`, `Depends on:`, `Acceptance:`, `Lane:` and `Human gate:` sub-bullets (three-space indent, `- Key: value`; an older doc may lack some — no `Depends on:` there means no dependencies). No checkbox step list → stop with `error=no_step_list` and suggest running `/plan` on the doc's next increment instead.
5. **Classify each pending step.** A step with a `Human gate:` sub-bullet is human-gated: a person does it and ticks it. In a doc that uses no `Human gate:` key anywhere, judge from the prose instead: a step explicitly held for a human decision (a rollout, flag flip, or deletion gated on an observation window or sign-off) is gated. Every other step is a code step.
6. **Check the roadmap's gates.** When the script exists, run `python3 .claude/scripts/proposal-lint.py <doc> --lanes --allow-draft` (the status check above already ran; the flag only stops it from re-gating on status). A non-empty `milestone_waits` → stop with `error=step_dependency_unmet`, naming each roadmap milestone it waits on (`doc`, `n`, `title`, and whether it is a human gate or an unfinished milestone): the doc's `Source:` milestone still depends on it. An entry with reason `milestone_unresolved` means the `Source:` header names a roadmap milestone that cannot be resolved — the fix is to correct that header (`<roadmap file>.md#N`), not to wait. Lane `errors` (`lane_cycle`) → `error=doc_malformed`, quoting them.
7. **Select the next step** — the first `[ ]` code step in document order whose every `Depends on:` ref is `[x]`: `N` in this doc, `<file>.md#N` in that doc — a proposal step, or a roadmap milestone, met once ticked (path relative to this doc's directory; an unreadable doc or a missing step there is unmet). A code step that depends on a pending human gate is therefore never selected. Then check, in order:
   - **Nothing pending.** Every step `[x]` → stop with `error=doc_complete`.
   - **Only gates pending.** No `[ ]` code step remains → stop with `error=step_human_gated`, listing each pending gate (number, kind, text).
   - **Nothing selectable.** Pending code steps exist but each has an unmet dependency → stop with `error=step_dependency_unmet`, naming for the first one each blocker and whether it is a human gate or a step in another doc.
   - **Checkbox vs. prose.** If the doc's prose says this step landed (or the tree already meets its acceptance criteria), the checkbox is stale: stop with `error=doc_stale` and tell the user to tick it before re-invoking. Do not edit the doc yourself.
8. **Extract the unit of work:** step number `M`, title, its `Files:` — the cited files, those marked `(new)` to be created — and the symbols it names, its description, its dependencies, and its `Acceptance:` criteria — which become binding success criteria, treated like a plan's `## Verification`. The doc's Decisions, Security and privacy, and Rollout and operations sections bind it like `CLAUDE.md` invariants.

## Review the plan against today's tree

A critique pass: every cited fact must still hold and every step must still be implementable as written. Findings feed *Decide* and are **never** written back to the plan or doc.

1. **Working tree.** Run `git status --porcelain` and `git rev-parse --abbrev-ref HEAD`.
   - **Dirty-tree gate.** Uncommitted changes clearly unrelated to the plan → surface them and ask before proceeding. Never branch over an unrelated dirty tree.
   - **Record HEAD; do not branch yet.** Branch creation waits until *Decide* returns Go, so a run that stops on a blocker leaves no stray branch.
   - **Refresh (HEAD on `$MAIN_BRANCH`, clean tree only).** `$GH_WRAPPER git fetch origin $MAIN_BRANCH` then `git merge --ff-only origin/$MAIN_BRANCH`, before the checks below, so the review sees the tree the branch will be cut from. On fetch failure or divergence, warn and continue on local `$MAIN_BRANCH` as-is. Never fetch or touch a non-main branch the user is on.
2. **Cited files exist.** Applies only to files the plan modifies. Renamed or deleted → find the current path by name and neighbouring symbols; if you cannot, that is a blocker. A file marked `(new)`: its parent directory must exist or be one the plan itself creates (an area it names, e.g. from the architecture's repository layout) — otherwise a blocker; a `(new)` file that already exists is a concern, or *already implemented* when it holds the planned end state.
3. **Cited symbols and line ranges still match.** Shifted line numbers are a concern; a symbol rewritten so the planned change no longer applies is a blocker.
4. **Reused utilities still exist.** A missing reuse target is a blocker.
5. **Config keys.** A setting the plan adds that already exists, partly exists, or conflicts with a sibling is a blocker until the plan accounts for it.
6. **Dependencies.** Prerequisite work the plan names must have shipped (grep for its symbols, or check its doc status). Unshipped → blocker.
7. **Already implemented.** If most of the plan's end state already exists, stop — nothing to implement. In doc mode this is `error=doc_stale`.
8. **Project rules.** Cross-check the plan against the invariants in the project's `CLAUDE.md`. A violation is a blocker until the plan accounts for it.

## Decide

- **Blockers** (drift, missing dependency, conflicting state, rule violation, project mismatch) → stop. A blocker whose way forward is the person's call (re-plan around the rewritten code, drop the step, wait for the dependency) is also a blocking question, asked with those options (see *Questions before assumptions*). Print a `Plan review` report listing each blocker with the plan section or step it affects, any concerns, and a one-line recommendation (revise the plan — e.g. re-run `/plan` or `/bug-fix` — and re-invoke). Do not implement.
- **Concerns only** (shifted lines, a renamed-but-findable helper, a removed adjacent test) → surface them in the same shape and ask the user to confirm. Do not assume yes. Unattended (see *Questions before assumptions*), proceed and report them as concerns: by definition none changes what gets built.
- **Clean** → print `Plan review: clean — proceeding to implementation` and continue.

## Questions before assumptions

A **blocking question** is one only the person can answer — what they intend, a requirement or constraint the plan (or the selected step) leaves out or states two incompatible ways, a trade-off that is theirs to make, a conflict between what the person said (an answer or framing the invoking prompt carries, a decision the design doc tags `(person, …)`) and the plan, the tree or your research, or a blocker whose way forward is their call — and whose plausible answers lead to materially different work: a different design, promise, cost or legal exposure. What the person said outranks the concern and the plan. On the point it addresses, it replaces what they say: follow it, and never ask it again. That difference is not a conflict. The conflict that is a blocking question is the other one: another part of the concern, the plan or the design doc, the tree or your research makes what the person said impossible to follow. Then pick no side and ask, naming both. Settle yourself anything the tree, `CLAUDE.md`, the design doc or desk research can settle; never ask about it. A **person-owned choice** that no doc, plan or answer settles is asked as a blocking question, never assumed. The classes a single change can meet: money or an account in the person's name; a new third-party service or dependency that receives data; a change to what the product promises its users or to its public interface; a licence; a name (product, package, domain, organization or bundle id). In doc mode, the doc's Decisions settle what they cover, and one tagged `(person, …)` is never departed from: a reason to depart from it is a blocking question. A question, its options and the recommendation name steps, decisions and milestones by title; a number may follow the title, but a number alone is never enough, because numbers move between revisions.

- **One pass, before writing.** Collect every blocking question at *Decide*, and again whenever a step proves infeasible as written or a load-bearing detail or a person-owned choice turns out to be open mid-implementation (stop there, leaving the edits so far in place, and report them). Never guess the answer to one.
- **Someone can answer** (an interactive session with a question tool, such as AskUserQuestion): ask them all at once, each with 2–4 concrete options and your recommended one first, and wait. The answers bind like explicit constraints.
- **No one can answer** (the invoking prompt says the run is unattended, or there is no question tool): make no further change; stop with `error=needs_input` and print each question with an id (`q1`, `q2`, …), why it blocks (what changes with the answer), its options and the one you recommend. When the invoking prompt says to proceed on assumptions instead, take the recommended option and list the question with it under *Assumptions*; a question about departing from what the person settled is never taken that way: keep what the person said and list the question as open.
- **Answers handed in** by the invoking prompt bind the same way; never re-ask one, and never change what one settled: a reason to change it is a blocking question.
- **Everything else is an assumption:** take the smallest choice consistent with the sources and the surrounding code, and list each under **Assumptions** in the report. None stays silent.

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
   - If a step proves infeasible as written, stop and surface it as a blocking question, with the ways forward as its options. Do not improvise a materially different scope.
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
- **Assumptions** — each detail the plan left open and the choice made.
- **Next step** — `/review-changes` (in a fresh session) to review the branch against the plan; it hands off to `/polish`. Only once that is clean, commit and push and `/create-pr`. In doc mode, remind the user to tick step `M` in the same PR: `python3 .claude/scripts/proposal-lint.py <doc> --tick M` (without the script, change only that step's `[ ]` to `[x]`).

## What to skip

- Do not edit the plan file or the design doc.
- Do not implement more than the selected step (doc mode) — one step, one PR.
- Do not refactor outside what the plan touches, and do not invent steps it does not specify. Small unspecified details: make a minimal choice consistent with surrounding code and list it under **Assumptions**; load-bearing ones, and every person-owned choice the plan leaves open, are blocking questions (see *Questions before assumptions*).
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

# claude-code-pipeline

[![ci](https://github.com/thomas-sodon/claude-code-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/thomas-sodon/claude-code-pipeline/actions/workflows/ci.yml)

A plan → implement → review → polish → PR → monitor pipeline for
[Claude Code](https://claude.com/claude-code), packaged as three workflows and the
nine slash commands they drive. Drop the `.claude/` directory into any repository,
tell it how to run your quality gates, and one concern goes from a sentence to a
review-clean, CI-green pull request, with every stage run in a fresh session.

## Why this exists

These workflows were extracted from
[Maestro](https://github.com/thomas-sodon/maestro-agent), an autonomous engineering
agent that tried to close the whole loop itself: pick its own work, plan it,
implement it, review it, open the PR and tend it until merged, all without a human
in the loop between approvals.

The lesson from running it: **the autonomous loop spent most of its effort on
deciding what to do and on proving to itself that it had done it.** Self-chosen
work drifted, self-reported outcomes needed ever more machinery to keep honest, and
the cost went into the loop rather than into the code. The same building blocks,
run as *human-steered* workflows, delivered what the loop was trying to deliver: a
person picks the concern (or the bug list, or the proposal lanes), and the
workflow does the long, disciplined middle part reliably: grounded plan, failing
test first, independent review until clean, gates green, PR opened and babysat
until it settles.

Keep the judgment of *what* to build with a human; automate *how* it gets built and
shipped.

Related: [maestro-agent](https://github.com/thomas-sodon/maestro-agent),
[maestro-sdk](https://github.com/thomas-sodon/maestro-sdk) and
[maestro-review](https://github.com/thomas-sodon/maestro-review).

## What is in here

```
.claude/
  workflows/
    plan-to-merged-pr.js      the engine: one concern from plan to a watched PR
    bug-fix-backlog.js        triage + adversarial verification + ship, per bug lane
    proposal-build-chain.js   stacked lanes of a design doc, built in order
  commands/
    plan.md  impl.md  review-changes.md  polish.md  create-pr.md
    process-comments.md  merge-main.md  quality-gates.md  bug-fix.md
  scripts/
    gate-slot.sh              optional host-wide semaphore for gate runs
examples/
  CLAUDE.pipeline-config.md   the config section to paste into your CLAUDE.md
```

| Command | Does |
|---|---|
| `/plan <concern>` | Grounds a free-text concern in today's tree and writes one increment's plan to the plans directory. Writes no code. |
| `/impl [plan]` | Re-validates the plan against the tree, then implements it and runs the gates. Does not commit. |
| `/review-changes [scope]` | Read-only review of the branch's changes; findings are `bug` / `concern` / `suggestion` / `nit`. |
| `/polish` | Fixes what review found, runs the gates, reports how many issues it fixed (0 = clean). |
| `/create-pr` | Commits, pushes, detects issues to close, opens a non-draft PR. |
| `/process-comments <pr>` | Fixes or declines every unresolved review thread (including outdated ones), pushes, then replies to each with a terminal marker. Never resolves threads or merges. |
| `/merge-main` | Merges the latest main (never rebases), resolves conflicts using the originating plan, runs gates, pushes. |
| `/quality-gates` | Runs the project's gates plus whatever the PR's CI is red on, fixes failures at the root, commits and pushes. |
| `/bug-fix <n>` | Triages an issue by intent against today's code: writes a fix plan, or closes it with evidence. `--dry-run` changes nothing. |

## The workflows

### `plan-to-merged-pr`

One concern from a sentence to a PR, then babysit it:

1. **Plan**: `/plan` (medium effort) writes the plan; the branch is cut afterwards
   (or set up first when you pass one).
2. **Implement**: `/impl` (low effort) builds it with tests.
3. **Review / fix until clean**: `/review-changes` (high effort) judged against the
   plan; a fixer (low effort) applies or declines each finding; the change is
   re-reviewed until no `bug` or `concern` remains. Suggestions and nits go to the
   fixer but never block. A defect still standing after `max_review_rounds` stops
   the run before anything is pushed.
4. **Polish**: `/polish` until a round finds nothing and the gates are green, for at
   most `max_polish` rounds (default 6). If no round comes back clean, the run goes
   on anyway and reports `polish_clean: false`; the merge check then always re-runs
   the full gates and stops before any push or PR unless they are green.
5. **PR**: commit, merge `origin/main` (and any stacked bases), re-run the gates,
   then `/create-pr`.
6. **Monitor**: each round observes CI, the AI review check (if you have one),
   conflicts and unanswered comments on the current head, then runs only the steps
   that are needed: `/merge-main`, `/process-comments`, or a CI fix. It stops when
   the PR merges or closes, or after two quiet rounds with green CI. Merging is left
   to a human.

Modes:

| Mode | args | Use |
|---|---|---|
| full (default) | `{ concern }` | one concern from plan to a watched PR |
| build-only | `{ concern, ship: false, branch, dir, bases }` | a stacked lane whose predecessors are not merged yet: everything up to the merge check, then push, no PR |
| ship-only | `{ ship_only: true, branch, dir, title \| existing_pr, predecessor_prs }` | open (or ready) the PR for a built lane once every PR below it has merged, then monitor |
| monitor-only | `{ pr, branch, dir }` | babysit an existing PR |

### `bug-fix-backlog`

One lane per issue, or per group of issues that share a code site. Each lane runs:

1. **Triage**: `/bug-fix <n> --dry-run` in the lane's own worktree, then one
   combined fix plan for the lane.
2. **Verify** every verdict independently before acting on it:
   - a *plan* verdict gets a **reproducer**, which writes the failing regression
     test against today's code, plus a read-only **skeptic** that tries to show
     the bug is not real. The bug survives on a reproduction, or on a skeptic who
     could not refute it.
   - a *close* verdict needs **two refuters** with different lenses (trace the
     failure path end to end; hunt sibling sites) to both fail. A wrong close is
     public, so it has to clear the higher bar.
3. **Close** the confirmed-fixed issues, re-checking first that each is still
   open and that no open PR claims it. A refuted close is folded back into the
   plan instead.
4. **Ship** the confirmed bugs through `plan-to-merged-pr`, with the verified plan
   and the already-failing tests, and `Fixes #N` in the PR body.

Anything that is neither reproduced nor survives the skeptic is reported for a
human (`needs_human`), never closed and never shipped.

### `proposal-build-chain`

For a design doc too big for one PR. Split its steps into **lanes**: a lane that
edits the same files as an earlier lane stacks on it, and lanes with disjoint files
can run as separate chains. The chain runs `plan-to-merged-pr` in build-only mode
for each lane in stack order, stopping at the first lane that does not push.

Shipping stays in your hands, in merge order. A stacked lane's PR must not exist,
not even as a draft someone might ready, until every PR below it has merged,
otherwise a merge bot could merge the unmerged base commits it carries. Once
those merges land, run `plan-to-merged-pr` with `ship_only: true` and
`predecessor_prs`; it refuses to open anything until each one reads `MERGED`.

## Install

Requirements:

- Claude Code with **workflows** support (the `.claude/workflows/*.js` scripts run
  through its Workflow tool), plus Skill and Agent support for the commands.
- `git` and an authenticated `gh` CLI, for the PR and issue stages.
- `python3`, which `/review-changes` uses to read the session transcript.
- A GitHub repository with CI. An AI review check is optional.
- For `gate-slot.sh`: Linux, bash 4.3+, `flock` (util-linux) and, to pin CPUs,
  `taskset`.

Steps:

```sh
git clone https://github.com/thomas-sodon/claude-code-pipeline /tmp/ccp
cd your-project
mkdir -p .claude
cp -r /tmp/ccp/.claude/commands /tmp/ccp/.claude/workflows /tmp/ccp/.claude/scripts .claude/
```

Then add a `## Pipeline config` section to your project's root `CLAUDE.md` (see
[`examples/CLAUDE.pipeline-config.md`](examples/CLAUDE.pipeline-config.md)):

| Key | Meaning | Default |
|---|---|---|
| `QUALITY_GATES` | full gate command; must exit 0 when green | **required** |
| `QUALITY_GATES_FAST` | quicker subset for iterating | `QUALITY_GATES` |
| `MAIN_BRANCH` | integration branch, read by the commands | `main` |
| `PLANS_DIR` | where plans are written | `~/.claude/plans` |
| `PROPOSALS_DIR` | design / proposal docs | none |
| `GH_WRAPPER` | prefix for gh / git network commands (e.g. a script that loads a token) | none (ambient `gh auth`) |
| `GATE_WRAPPER` | prefix for every gate run | none; use `./.claude/scripts/gate-slot.sh` when several agents share a host |
| `TEST_GUIDELINES` | where your testing rules live | `CLAUDE.md` |

The workflows do not read `MAIN_BRANCH`; pass `main_branch` when your integration
branch is not `main`. They also take two settings only as args: `ai_review_check`,
the name of a CI check that posts AI review comments (default none), which the
monitor waits for before counting comments; and `gate`, a gate wrapper that
the agents use instead of `GATE_WRAPPER`, never nesting the two (default `''`: the
agents use `GATE_WRAPPER` when it is set, else run the gates directly).

With a wrapper set, every gate runs as `$GATE_WRAPPER bash -c '<QUALITY_GATES>'`,
with the gate command's text between the single quotes, so a compound command such
as `lint && typecheck && test` runs whole under the wrapper rather than only its
first command. The single quotes leave a variable such as `$GATE_SLOT_WORKERS` for
the wrapper's shell to expand; write a `'` inside the gate command as `'\''`.

### State outside the repo

The commands and `gate-slot.sh` keep a little state in your home directory, shared
by every checkout:

- `~/.claude/plans/` (`PLANS_DIR`): the plans `/plan` and `/bug-fix` write.
- `~/.claude/last-plan-by-folder.json`: the latest plan per working directory,
  written by `/plan` and `/bug-fix` and read by the other commands.
- `~/.claude/reviews/<branch-slug>.json`: the review-findings ledger that
  `/review-changes` writes and `/polish` updates.
- `~/.claude/bug-fix-progress.json`: claims that stop two `/bug-fix` sessions
  working on one issue.
- `~/.cache/gate-slot-locks/` (`GATE_LOCK_DIR`): `gate-slot.sh`'s lock files and
  its `gate-runs.log`.

`/review-changes` also reads Claude Code's own session transcripts under
`~/.claude/projects/`, without writing to them.

## Worked example

This example is illustrative: the project, findings and runs are made up to show
the flow. A TypeScript service with lint, typecheck and Jest. In `CLAUDE.md`:

```md
## Pipeline config

QUALITY_GATES: npm run lint && npm run typecheck && npm test
QUALITY_GATES_FAST: npm run lint && npm test -- --onlyChanged
GATE_WRAPPER: ./.claude/scripts/gate-slot.sh
```

**One concern.** In Claude Code, ask for the workflow:

> Run the plan-to-merged-pr workflow with
> `{ concern: "GET /orders re-reads the price table on every request; cache it per process and invalidate on the price-update webhook", ai_review_check: "AI Code Review" }`

What happens:

- `/plan` finds the handler and the webhook, and writes
  `~/.claude/plans/plan-cache-price-table.md`: the acceptance criteria, the
  per-file edits, a failing test for the cache and one for invalidation, and the
  gate command.
- An agent creates `feat/cache-price-table-20261016`, and `/impl` builds the plan.
- Review round 1 reports a `bug` (the webhook clears the wrong key) and a `nit`.
  The fixer fixes both, and round 2 comes back clean.
- `/polish` finds nothing on its first round, and the gates are green.
- The merge check brings in two commits from `main`, the gates are re-run green,
  and `/create-pr` opens the PR.
- Monitor: the AI reviewer leaves one suggestion, which `/process-comments`
  applies and answers with `Fixed locally …`. CI goes green and stays quiet for
  two rounds, so the run hands the PR to you to merge.

**A bug backlog.**

```js
{ root: '/abs/path/worktrees', date: '20261016',
  lanes: [{ key: 'tz', issues: [212, 230] }, { key: 'retry', issues: [218] }] }
```

Lane `tz` reproduces #212 with a failing test and ships the fix as one PR with
`Fixes #212`. Two refuters fail to find any remaining instance of #230, so it is
closed with the evidence quoted. Lane `retry`'s reproducer runs the code, finds
the behaviour already correct, and puts #218 in `needs_human`.

**A design doc in two stacked lanes.**

```js
{ lanes: [
  { key: 'a', dir: '/abs/wt/a', branch: 'feat/events-a', proposal: 'docs/design/events.md',
    concern: 'Steps 1-2: the event schema and the writer' },
  { key: 'b', dir: '/abs/wt/b', branch: 'feat/events-b', bases: ['feat/events-a'],
    proposal: 'docs/design/events.md', concern: 'Step 3: the reader, on top of the writer' } ] }
```

Both branches are built and pushed. Ship lane `a` with
`{ ship_only: true, branch: 'feat/events-a', dir: '/abs/wt/a', title: '…' }`.
After it merges, ship `b` with `predecessor_prs: [<a's PR>]`.

## Operating rules baked in

- **Fresh session per stage.** Context stays small, and the reviewer did not
  write the code it is reviewing.
- **A denied action stays denied.** If a permission check refuses something, the
  agent reports it as blocked and does not try another route.
- **No `git stash` in parallel worktrees.** Every worktree of a repo shares one
  stash list, so one lane can pop another lane's entry. For a before/after check,
  save the fix as a diff file, check out `HEAD` for those paths, run the test, then
  `git apply` the diff, or make a WIP commit on your own branch.
- **Never force-push and never push to main.** Merges, not rebases.
- **Gates in the foreground, or in the background and watched.** Run on their own,
  the commands run gates in the foreground with a long timeout, since a background
  run can be reaped when the turn ends. Inside a workflow, the agents run long gates
  in the background by design, write the output to a log and watch it, and do not
  end their turn until the run exits.
- **Gate slots.** When several agents share a machine, route every gate run
  through `.claude/scripts/gate-slot.sh <command>`. It plans CPU-disjoint slots
  from the CPU affinity, any cgroup CPU quota and the memory bound (tune with
  `GATE_SLOTS`, `GATE_SLOT_CPUS`, `GATE_SLOT_MEM_MB`), pins the run with
  `taskset`, and exports `GATE_SLOT_WORKERS` so your test runner can size itself
  (`jest --maxWorkers=$GATE_SLOT_WORKERS`, `pytest -n $GATE_SLOT_WORKERS`, …).
  Exit 75 means every slot is busy, so re-run the same command. Exit 125 means
  the wrapper itself cannot run: report it, never bypass it. Every checkout on a
  host must share `GATE_LOCK_DIR`.

## Workflow args reference

`plan-to-merged-pr` (a plain string is taken as `concern`):

```js
{
  concern: 'what to change',
  planner: 'plan',                 // or your own planning skill, which gets planner_args
  planner_args: '...',             // args for a custom planner (default: the concern)
  proposal: 'docs/design/x.md',    // design doc: handed to the planner and frames the review
  context: 'scouting hints for the planner',
  plan_text: '...',                // an already-written plan (skips planning; needs branch)
  dir: '/abs/path/to/checkout',    // work only here; created as a worktree if absent
  branch: 'feat/...',
  bases: ['feat/earlier-lane'],    // stacked-on branches, last contains the others
  ship: true,                      // false = build only
  ship_only: false, existing_pr: 123, predecessor_prs: [120, 121],
  title: 'PR title', pr_note: 'extra PR body text, e.g. Fixes #12',
  main_branch: 'main', ai_review_check: '',
  gate: '',                        // '' = GATE_WRAPPER from the Pipeline config, if set;
                                   // e.g. './.claude/scripts/gate-slot.sh' to force the semaphore
  commit_trailers: ['Co-Authored-By: Claude <noreply@anthropic.com>'],
  max_review_rounds: 5, max_polish: 6, max_monitor_rounds: 10,   // max_rounds is an alias of max_monitor_rounds
  efforts: { plan: 'medium', impl: 'low', review: 'high', fix: 'low', polish: 'low', merge_check: 'low', monitor: 'low' },
                                   // efforts.pr (unset) sets /create-pr's effort; unset keys inherit the session's
}
```

`bug-fix-backlog`: `{ lanes: [{ key, issues, branch?, dir? }], root, date, ship, close, efforts: { triage, verify, close }, ... }`.
`date` suffixes the default lane branch names (`bugfix/<key>-<issues>-<date>`).
Only `gate`, `main_branch`, `ai_review_check`, `commit_trailers`,
`max_review_rounds`, `max_polish`, `max_monitor_rounds`, `efforts` (the whole
object, so it may carry `plan-to-merged-pr`'s keys too) and `ship: false` are passed
through to `plan-to-merged-pr`. Lanes must not share a key, an issue, a `dir` or a
`branch`.

`proposal-build-chain`: `{ lanes: [{ key, dir, branch, bases?, proposal, concern, planner_args? }], planner, ... }`.
`planner`, `gate`, `main_branch`, `commit_trailers`, `max_review_rounds`,
`max_polish` and `efforts` are passed through to every lane; a lane's own
`planner_args` goes to its custom planner.

Every result carries a `status`:

- `pushed` (build-only)
- `failed_at_plan`, `failed_at_impl`
- `review_failed`, `blocked_at_review`
- `blocked_at_predecessors`
- `failed_at_merge_check`, `blocked_at_merge_check`
- `failed_at_push`, `blocked_at_pr`
- after monitoring: the PR's last state (`OPEN` / `MERGED` / `CLOSED`), or `monitor_failed`

To resume a stopped run, ask Claude Code to call the Workflow tool again with the
same args and `resumeFromRunId` set to the run id the tool reported for the stopped
run. `resumeFromRunId` is a parameter of the Workflow tool, not a workflow arg.
Completed agent calls are replayed from the record up to the first call whose order
or inputs differ; everything after it runs live. In `bug-fix-backlog` the lanes run
in parallel and spawn in completion order, so a resume can diverge early and repeat
finished work; its close and ship stages re-check the issue and PR state before
acting.

## License

MIT, see [LICENSE](LICENSE).

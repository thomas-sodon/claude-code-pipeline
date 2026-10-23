# Reference

Detailed reference for [claude-code-pipeline](../README.md): workflow modes and
args, configuration, gate wrappers, the state kept outside the repo, result
statuses and resuming a stopped run.

## `plan-to-merged-pr` modes

| Mode | args | Use |
|---|---|---|
| full (default) | `{ concern }` | one concern from plan to a watched PR |
| build-only | `{ concern, ship: false, branch, dir, bases }` | a stacked lane whose predecessors are not merged yet: everything up to the merge check, then push, no PR |
| ship-only | `{ ship_only: true, branch, dir, title \| existing_pr, predecessor_prs }` | open (or ready) the PR for a built lane once every PR below it has merged, then monitor |
| monitor-only | `{ pr, branch, dir }` | babysit an existing PR |

## Install and configuration

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
[`examples/CLAUDE.pipeline-config.md`](../examples/CLAUDE.pipeline-config.md)):

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

## Gate wrappers

With a wrapper set, every gate runs as `$GATE_WRAPPER bash -c '<QUALITY_GATES>'`,
with the gate command's text between the single quotes, so a compound command such
as `lint && typecheck && test` runs whole under the wrapper rather than only its
first command. The single quotes leave a variable such as `$GATE_SLOT_WORKERS` for
the wrapper's shell to expand; write a `'` inside the gate command as `'\''`.

**Gate slots.** When several agents share a machine, route every gate run
through `.claude/scripts/gate-slot.sh <command>`. It plans CPU-disjoint slots
from the CPU affinity, any cgroup CPU quota and the memory bound (tune with
`GATE_SLOTS`, `GATE_SLOT_CPUS`, `GATE_SLOT_MEM_MB`), pins the run with
`taskset`, and exports `GATE_SLOT_WORKERS` so your test runner can size itself
(`jest --maxWorkers=$GATE_SLOT_WORKERS`, `pytest -n $GATE_SLOT_WORKERS`, …).
Exit 75 means every slot is busy, so re-run the same command. Exit 125 means
the wrapper itself cannot run: report it, never bypass it. Every checkout on a
host must share `GATE_LOCK_DIR`.

## Workflow args

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

## Resuming a stopped run

To resume a stopped run, ask Claude Code to call the Workflow tool again with the
same args and `resumeFromRunId` set to the run id the tool reported for the stopped
run. `resumeFromRunId` is a parameter of the Workflow tool, not a workflow arg.
Completed agent calls are replayed from the record up to the first call whose order
or inputs differ; everything after it runs live. In `bug-fix-backlog` the lanes run
in parallel and spawn in completion order, so a resume can diverge early and repeat
finished work; its close and ship stages re-check the issue and PR state before
acting.

## State outside the repo

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

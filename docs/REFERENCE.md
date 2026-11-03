# Reference

Detailed reference for [claude-code-pipeline](../README.md): workflow modes and
args, configuration, gate wrappers, the state kept outside the repo, result
statuses, the inception gates, resuming a stopped run and testing the workflows.

## `plan-to-merged-pr` modes

| Mode | args | Use |
|---|---|---|
| full (default) | `{ concern }` | one concern from plan to a watched PR |
| build-only | `{ concern, ship: false, branch, dir, bases }` | a stacked lane whose predecessors are not merged yet: everything up to the merge check, then push, no PR |
| ship-only | `{ ship_only: true, branch, dir, title \| existing_pr, predecessor_prs }` | open (or ready) the PR for a built lane once every PR below it has merged, then monitor |
| monitor-only | `{ pr, branch, dir }` | babysit an existing PR |

In ship-only and monitor-only runs, pass the lane's plan as `plan_text` (a build-only
run returns it as `plan`), so the merge and comment steps judge against it. Without
it, they never fall back to the newest plan file.

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
  plan_text: '...',                // an already-written plan (skips planning; needs branch);
                                   // in ship-only / monitor-only runs, the plan the merge and comment steps use
  dir: '/abs/path/to/checkout',    // work only here; created as a worktree if absent
  repo: '/abs/path/to/repo',       // the repository a missing dir is created from (default: the current one)
  branch: 'feat/...',
  bases: ['feat/earlier-lane'],    // stacked-on branches, last contains the others
  review_base: 'origin/main',      // what the review measures the change from (default: origin/<last base>,
                                   // else origin/<main_branch>); a ref or a commit id
  lane: 'a',                       // prefix for every agent label and log line (concurrent runs)
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
`planner_args` goes to its custom planner. With `proposal` set, the default planner
runs as `/plan --proposal=<path>`, which plans the lane as an increment of the doc
rather than routing it back to the doc.

A `plan-to-merged-pr` result carries a `status`:

- `pushed` (build-only)
- `failed_at_plan`, `failed_at_impl`, both with `stop_reason`: the skill's error or
  recommendation, or the question only a human can answer. The run stops rather
  than guess.
- `review_failed`, `blocked_at_review`
- `blocked_at_predecessors`
- `failed_at_merge_check`, `blocked_at_merge_check`
- `failed_at_push`, `blocked_at_pr`
- after monitoring: the PR's last state (`OPEN` / `MERGED` / `CLOSED`), or `monitor_failed`

It also carries `open_questions`: fixes `/polish` left unapplied because they need a
person's call. The same questions appear in the PR body under "Questions for the
reviewer". A PR on a repository without CI settles once no check has reported, rather
than waiting out every monitor round.

## `idea-to-inception`

Start it with `/inception <idea>`, which runs the gate loop below for you. Run
directly, the workflow takes:

```js
{
  idea: 'the idea, in your words',  // required on every run
  context: '...',                   // anything else every stage should know
  repo: '/abs/path/to/repo',        // where to start it (default: the current checkout's repository)
  root: '/abs/path/to/worktrees',   // inception + lane worktrees (default: <repo>-worktrees)
  slug: 'recipe-swap',              // default: derived from the idea
  answers: { i1: 'Web app', i3: ['Running cost'] },   // by question id
  state: { ... },                   // from the previous next_args, unchanged
  main_branch: 'main', record_dir: 'docs/inception',
  max_questions: 8, intake_rounds: 2, directions: 4, critics: 3, judges: 3,
  efforts: { intake: 'high', brief: 'medium', directions: 'high', propose: 'high', critique: 'medium',
             revise: 'medium', judge: 'high', synthesize: 'medium', design: 'high', docs: 'high', publish: 'low' },
  // for the build, passed to plan-to-merged-pr:
  planner, gate, ai_review_check, commit_trailers, max_review_rounds, max_polish, max_monitor_rounds,
  build_efforts: { ... },           // plan-to-merged-pr's efforts
}
```

**The gate loop.** A run stops at the next decision and returns
`{ status: 'needs_input', gate, summary, artifacts, questions, next_args, how_to_continue }`.
Each question is shaped for AskUserQuestion (`id`, `header` of at most 12 characters,
`question`, 2–4 `options`, `multiSelect`, `why`), with any recommended option first.
Ask every question, set `next_args.answers[id]` (a label, an array of labels for a
multi-select, `[]` for none, or the user's own words), and run the workflow again with
`next_args`. A run with a question still unanswered asks it again and spends no agent.

| Gate | Question ids | Asked after |
|---|---|---|
| `intake` | `i1`, `i2`, … (a follow-up round continues the numbering) | the read-only intake, or a brief whose answers opened a question |
| `directions` | `directions` (multi-select, two to four) | the brief and the candidate directions |
| `decision` | `winner`, `grafts` | the proposals, critiques, revisions, judging and comparison |
| `design` | `d1`, `d2`, … (skipped when nothing is open) | the design check of your choice |
| `build` | `build` | the ADR, design doc and `CLAUDE.md` are committed |

`state` holds everything decided so far: question texts, directions, proposal paths,
scores, document paths and steps. A stage whose result is in `state` never runs again,
so each answer stays bound to what it answered. Answering `winner` with "none of them"
clears the proposals and asks the directions question again.

Terminal statuses:

- `built`: `pr`, `pr_status`, `skeleton`, `lanes` (step, branch, status per lane;
  human-gated steps are skipped, or stop the chain when a later step depends on
  them), `open_questions` and `ship_plan`, which holds the `plan-to-merged-pr`
  ship-only args per lane in merge order. The first lane's args name the inception
  PR as predecessor. Each later lane's args carry its `bases` and no
  `predecessor_prs`, so `plan-to-merged-pr` refuses them until you add the PR of
  every lane below it.
- `docs_pr`: the docs-only PR. `docs_committed`: nothing pushed; `resume_args` asks
  the build question again.
- `blocked`: the repository has no first commit on `origin/<main>` (the pipeline
  never pushes to main), or the inception worktree could not be set up.
- `failed_at_intake` … `failed_at_docs`, `failed_at_docs_pr`, `failed_at_skeleton`:
  `retry_args` re-runs that stage and keeps everything decided before it.

Where things go: the inception worktree is `<root>/inception-<slug>` on branch
`inception/<slug>`; the record (brief, proposals, comparison) is in
`<record_dir>/<slug>/`; the ADR follows the repository's convention or
`docs/adr/0001-<slug>-architecture.md`; the design doc is `docs/design/<slug>.md` (or
in `PROPOSALS_DIR`). Lane `N` builds `feat/<slug>-step<N>-<title>` in
`<root>/<slug>-step<N>`.

## Resuming a stopped run

To resume a stopped run, ask Claude Code to call the Workflow tool again with the
same args and `resumeFromRunId` set to the run id the tool reported for the stopped
run. `resumeFromRunId` is a parameter of the Workflow tool, not a workflow arg.
Completed agent calls are replayed from the record up to the first call whose order
or inputs differ; everything after it runs live. In `bug-fix-backlog` the lanes run
in parallel and spawn in completion order, so a resume can diverge early and repeat
finished work; its close and ship stages re-check the issue and PR state before
acting.

`idea-to-inception` needs `resumeFromRunId` only for a run that stopped mid-stage. Its
decisions travel in `next_args.state`, so moving from gate to gate never re-runs a
stage, even from another session. Within a stage its agents run in barriers that
issue them in a fixed order, so a resume replays them. Once the build stage runs
the inception PR and the lanes concurrently, a resume can diverge there.

## Testing the workflows

```sh
node ci/check-workflows.mjs .claude/workflows   # static: meta, phases, clock/random calls, nesting
node --test ci/*.test.mjs                        # control flow, with stubbed agents
```

`ci/harness.mjs` runs a workflow script with scripted agents. It checks every agent's
phase against `meta.phases`, every schema against what the StructuredOutput tool
accepts, and every stub reply against its schema. It forbids clock and random calls
and nested `workflow()` calls, and can run a real child workflow one level down. A test
answers agents by label:

```js
const t = await run('plan-to-merged-pr', { concern: 'x' }, { agent: call => replies[call.label] })
t.result; t.calls; t.logs   // the script's return value, every agent call (prompt, label, phase), its log lines
```

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

`idea-to-inception` also creates worktrees under its `root` (default:
`<repo>-worktrees`, next to the repository). Remove one with `git worktree remove`
once its branch has merged.

`/review-changes` also reads Claude Code's own session transcripts under
`~/.claude/projects/`, without writing to them.

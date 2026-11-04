# Reference

Detailed reference for [claude-code-pipeline](../README.md): workflow modes and
args, configuration, gate wrappers, the proposal lint, the state kept outside the
repo, result statuses and resuming a stopped run. The design-doc format is in
[PROPOSALS.md](PROPOSALS.md).

## `plan-to-merged-pr` modes

| Mode | args | Use |
|---|---|---|
| full (default) | `{ concern }` | one concern from plan to a watched PR |
| build-only | `{ concern, ship: false, branch, dir, bases }` | a stacked lane whose predecessors are not merged yet: everything up to the merge check, then push, no PR |
| ship-only | `{ ship_only: true, branch, dir, title \| existing_pr, predecessor_prs, proposal?, plan_text? }` | open (or ready) the PR for a built lane once every PR below it has merged, then monitor |
| monitor-only | `{ pr, branch, dir, plan_text? }` | babysit an existing PR |

## Install and configuration

Requirements:

- Claude Code with **workflows** support (the `.claude/workflows/*.js` scripts run
  through its Workflow tool), plus Skill and Agent support for the commands.
- `git` and an authenticated `gh` CLI, for the PR and issue stages.
- `python3` (3.8+, standard library only), which `/review-changes` uses to read the
  session transcript and every design-doc command runs `proposal-lint.py` with.
- A GitHub repository with CI. An AI review check is optional. A greenfield project
  needs none yet: `/bootstrap` writes the CI and you create the repository.
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
[`examples/CLAUDE.pipeline-config.md`](../examples/CLAUDE.pipeline-config.md)).
On a greenfield project, `/bootstrap` writes it for you.

| Key | Meaning | Default |
|---|---|---|
| `QUALITY_GATES` | full gate command; must exit 0 when green | **required** |
| `QUALITY_GATES_FAST` | quicker subset for iterating | `QUALITY_GATES` |
| `MAIN_BRANCH` | integration branch, read by the commands | `main` |
| `PLANS_DIR` | where plans are written | `~/.claude/plans` |
| `PROPOSALS_DIR` | design docs: where `/roadmap` and `/propose` write, and where `/impl` doc mode and `/plan` look | `docs/design` for `/roadmap`, `/propose` and `/review-proposal`; none for `/plan` and `/impl` (set it to use `/impl <doc>`) |
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

## `proposal-lint.py`

`.claude/scripts/proposal-lint.py` is the deterministic gate on design docs. It
reads only the files it is given: no git, no network.

```
proposal-lint.py DOC [--repo DIR] [--json] [--no-resolve-xrefs]
proposal-lint.py DOC --lanes [--root DIR] [--date YYYYMMDD] [--branch-prefix feat/]
                             [--remote-heads FILE] [--repo DIR] [--allow-draft]
proposal-lint.py DOC --tick N[,N...]
proposal-lint.py ROADMAP --roadmap
```

- **Lint** (default): prints `path:line: E|W code: message` lines and a summary, or
  with `--json` `{doc, kind, title, header, errors, warnings, steps}`; each step is
  `{n, title, done, line, description, human_gate: null | {kind, text}, files: [{path, new}], depends: [{doc: null | path, n}], acceptance, lane, outcome, …}`.
  `--repo DIR` checks `Files:` against that checkout; `--no-resolve-xrefs` skips
  reading the docs named in `<file>.md#N` refs. The codes are listed in
  [PROPOSALS.md](PROPOSALS.md#lint-codes).
- **`--lanes`**: derives lanes and chains ([how](PROPOSALS.md#lanes-and-chains)) and
  prints `{doc, slug, errors, warnings, chains: [{key, lanes: [{key, steps, titles, concern, branch, dir, bases, files, already_built}]}], blocked: [{lane, steps, waiting_on: [{doc, n, title, reason}]}], human_gates_pending: [{n, title, kind, text, ready, waiting_on}], milestone_waits, done}`.
  A doc with lint errors gets no lanes (exit 1). `dir` is null without `--root`;
  `--remote-heads` takes the output of `git ls-remote --heads origin`;
  `--allow-draft` builds a doc whose `Status:` is not `accepted` / `in-progress`.
- **`--tick N,…`**: ticks those steps in place (atomic, no other byte changes, file
  mode kept) and prints `{ticked, already, missing}`; any missing number ticks
  nothing (exit 1).
- **`--roadmap`**: prints `{doc, kind, errors, warnings, milestones: [{n, title, done, human_gate, proposal, proposal_exists, progress: {done, total, gates_pending}, complete, satisfied, depends}], next}`.

Exit 0 = no errors (warnings allowed); 1 = lint errors, or a `--tick` / `--lanes`
request that cannot be met; 2 = usage error or unreadable file. `--lanes`,
`--roadmap` and `--tick` always print JSON.

## Workflow args

`plan-to-merged-pr` (a plain string is taken as `concern`):

```js
{
  concern: 'what to change',
  planner: 'plan',                 // or your own planning skill, which gets planner_args
  planner_args: '...',             // args for a custom planner (default: the concern)
  proposal: 'docs/design/x.md',    // design doc: /plan gets --proposal=<path>; frames review, polish and monitor
  proposal_steps: [3, 4],          // the proposal's steps this run builds: ticked in the same commit (needs proposal; not ship-only)
  context: 'scouting hints for the planner',
  plan_text: '...',                // an already-written plan (skips planning; needs branch). In ship-only and
                                   // monitor-only modes: the branch's own plan, for comment fixes and conflicts
  dir: '/abs/path/to/checkout',    // work only here; created as a worktree if absent
  branch: 'feat/...',
  bases: ['feat/earlier-lane'],    // stacked-on branches, last contains the others
  ship: true,                      // false = build only
  ship_only: false, existing_pr: 123, predecessor_prs: [120, 121],
  title: 'PR title', pr_note: 'extra PR body text, e.g. Fixes #12',
  main_branch: 'main', ai_review_check: '',
  required_checks: ['ios-build'],  // CI checks outside the quality gates that must be green too; one this PR
                                   // turns red gets the CI-fix step (reproduced locally if possible, else from its log)
  gate: '',                        // '' = GATE_WRAPPER from the Pipeline config, if set;
                                   // e.g. './.claude/scripts/gate-slot.sh' to force the semaphore
  commit_trailers: ['Co-Authored-By: Claude <noreply@anthropic.com>'],
  max_review_rounds: 5, max_polish: 6, max_monitor_rounds: 10,   // max_rounds is an alias of max_monitor_rounds
  efforts: { plan: 'medium', impl: 'low', review: 'high', fix: 'low', polish: 'low', merge_check: 'low', monitor: 'low' },
                                   // efforts.pr (unset) sets /create-pr's effort; unset keys inherit the session's
}
```

The workflow passes its `main_branch` to `/create-pr` (as the PR base) and to
`/merge-main` explicitly. In ship-only mode, a merge check that had to resolve
conflicts gets one `/review-changes` round before the PR opens.

`bug-fix-backlog`: `{ lanes: [{ key, issues, branch?, dir? }], root, date, ship, close, efforts: { triage, verify, close }, ... }`.
`date` suffixes the default lane branch names (`bugfix/<key>-<issues>-<date>`).
Only `gate`, `main_branch`, `ai_review_check`, `commit_trailers`,
`max_review_rounds`, `max_polish`, `max_monitor_rounds`, `efforts` (the whole
object, so it may carry `plan-to-merged-pr`'s keys too) and `ship: false` are passed
through to `plan-to-merged-pr`. Lanes must not share a key, an issue, a `dir` or a
`branch`.

`brief-to-proposals` (pass exactly one of `brief` and `concern`):

```js
{
  brief: 'docs/brief.md',          // product brief, relative to dir or absolute: architecture, roadmap, a proposal per milestone
  concern: '...',                  // or one change too big for one PR: a single proposal, no architecture or roadmap
  dir: '/abs/path/to/project',     // required; may be an empty directory
  out: 'docs/design',              // proposals directory, relative to dir (default: PROPOSALS_DIR, else docs/design)
  context: '...',                  // framing every author treats as binding: builder, budget, constraints the source omits
  panel: 3,                        // independent architecture sketches judged before /roadmap; 0 = no panel
  milestones: [2, 4],              // propose only these milestones (default: every pending code milestone)
  max_milestones: 1,               // propose at most the first N of those, in roadmap order (try the flow on one)
  force: false,                    // let /roadmap overwrite architecture.md / roadmap.md (never once a milestone is ticked)
  max_review_rounds: 3,            // revise rounds per doc
  efforts: { sketch: 'medium', judge: 'high', roadmap: 'high', propose: 'medium', review: 'high', revise: 'medium', consistency: 'high', lint: 'low' },
}
```

It writes docs only: no code, no commits, no git-state change. Every doc it writes
is `Status: draft`.

`proposal-build-chain` has two modes; `planner`, `gate`, `main_branch`,
`commit_trailers`, `max_review_rounds`, `max_polish` and `efforts` pass through to
every lane in both.

Derive mode, the lanes computed from the proposal's step list:

```js
{
  proposal: 'docs/design/01-x.md', // path relative to the repo root; must be on origin/<main>
  dir: '/abs/path/to/checkout',    // an existing, up-to-date checkout, used only to read the doc and the remote's branches
  root: '/abs/path/to/worktrees',  // lane worktrees go to <root>/<slug>-<lane>
  date: '20261104',                // branch suffix: feat/<slug>-<lane>-<date> (default 'undated')
  branch_prefix: 'feat/',
  parallel_chains: true,           // false = one chain after another
  allow_draft: false,              // true = build a doc whose Status is not accepted / in-progress
}
```

An agent fetches origin, copies the proposals directory as it is on `origin/<main>`
into a scratch directory, lists the remote's branches, runs
`proposal-lint.py <proposal> --lanes --repo <dir> --root <root> --date <date> --remote-heads <file>`
and returns its JSON verbatim. Preconditions: the doc lints clean, it is on
`origin/<main>` (every lane worktree is cut from there and must read it), and its
`Status:` is `accepted` or `in-progress` (else every lane is blocked). Chains then
build concurrently, lanes within a chain in order, each with `proposal_steps` set to
its steps. An `already_built` lane is skipped but stays a base; a lane that does not
push stops only its own chain.

Explicit mode, the lanes given by hand (serial, in the order given, stopping at the
first lane that does not push):

```js
{ lanes: [{ key, dir, branch, bases?, proposal, concern, planner_args?, steps? }], planner, ... }
```

`steps` are the proposal's step numbers the lane builds; they are ticked in the
lane's own commit. List `bases` in stack order: every earlier lane the lane stacks
on, so that the **last base contains the others** (the worktree is cut from it and
the review is scoped against it). A lane's own `planner_args` goes to its custom
planner.

## Result statuses

Every result carries a `status`.

`plan-to-merged-pr`:

- `pushed` (build-only)
- `failed_at_plan`, `failed_at_impl`
- `review_failed`, `blocked_at_review` (also in ship-only, after a conflicted merge)
- `blocked_at_predecessors`
- `failed_at_merge_check`, `blocked_at_merge_check`
- `failed_at_push`, `blocked_at_pr`
- after monitoring: the PR's last state (`OPEN` / `MERGED` / `CLOSED`), or `monitor_failed`

`proposal-build-chain`, explicit mode: an array of `{ lane, branch, steps, status, result }`,
one per lane attempted, `status` being the lane's `plan-to-merged-pr` status (or
`failed`). Derive mode: `{ status, proposal, source, chains, blocked, human_gates_pending, milestone_waits, ship_plan }`, where:

- `pushed` — every lane is pushed or `already_built`
- `partial` — some lane did not push; its chain stopped there (`not_built` lists the rest), other chains carried on
- `all_blocked` — no lane can build: each waits on a gate, another doc, a milestone or acceptance (see `blocked`)
- `nothing_to_build` — no pending code step
- `proposal_lint_errors` — the doc has lint errors (listed); fix it before building
- `proposal_not_on_main` — the doc is only in the working copy; land it through a docs PR first (a `preview` of its lanes is included)
- `failed_at_derive` — the derive agent failed or did not return the script's JSON

Each chain lists its lanes with a per-lane status (a `plan-to-merged-pr` status,
`already_built` or `failed`). `ship_plan` gives, per chain in merge order, the
`ship_only` args for each built lane (`branch`, `dir`, `proposal`, its `plan_text`,
and `predecessor_prs` placeholders for every lane after the first).

`brief-to-proposals`:

- `ready` — every doc lints clean and every proposal's review came back clean
- `proposals_need_attention` — a proposal was not written, its review did not finish, or it still has a `bug` or `concern` after `max_review_rounds` (`findings_remaining`)
- `lint_errors` — a doc still has lint errors; `lint_failed` — the lint stage did not report
- `blocked_at_architecture_review` — architecture.md or roadmap.md still has a `bug` or `concern` after `max_review_rounds`; no proposal was written
- `review_failed` — a review or revise stage of the architecture failed to report
- `failed_at_roadmap` — `/roadmap` did not finish (e.g. `error=exists`: pass `force`, or revise instead)
- `failed_at_propose` — concern mode: `/propose` did not finish

The result also carries the doc paths, the panel's scores, each doc's review
outcome, the consistency findings, the lint and lane summary, and `next_steps`.

## Resuming a stopped run

To resume a stopped run, ask Claude Code to call the Workflow tool again with the
same args and `resumeFromRunId` set to the run id the tool reported for the stopped
run. `resumeFromRunId` is a parameter of the Workflow tool, not a workflow arg.
Completed agent calls are replayed from the record up to the first call whose order
or inputs differ; everything after it runs live.

Parallel work spawns in completion order, so a resume can diverge early and repeat
finished work: the lanes of `bug-fix-backlog`, the chains of `proposal-build-chain`
(unless `parallel_chains: false`), and the sketches and per-milestone proposals of
`brief-to-proposals`. `bug-fix-backlog`'s close and ship stages re-check the issue
and PR state before acting. For `proposal-build-chain`, a fresh run with the same
args (and the same `date`) is often simpler than a resume: lanes already on origin
come back `already_built` and are not rebuilt.

## State outside the repo

The commands and `gate-slot.sh` keep a little state in your home directory, shared
by every checkout:

- `~/.claude/plans/` (`PLANS_DIR`): the plans `/plan` and `/bug-fix` write.
- `~/.claude/last-plan-by-folder.json`: the latest plan per working directory,
  written by `/plan` and `/bug-fix` and read by the other commands.
- `~/.claude/reviews/<branch-slug>.json`: the review-findings ledger that
  `/review-changes` writes and `/polish` updates.
- `~/.claude/reviews/proposal-<doc-slug>.json`: the design-doc review ledger that
  `/review-proposal` writes and `/propose --revise` updates (findings applied are
  marked fixed, declined ones keep their reason). The slug is the working
  directory's base name plus the doc's repo-relative path (`docs/design/roadmap.md`
  in `~/src/acme` → `proposal-acme-docs-design-roadmap.json`), so two projects'
  `roadmap.md` never share a ledger; one belonging to another checkout or doc is
  never overwritten.
- `~/.claude/bug-fix-progress.json`: claims that stop two `/bug-fix` sessions
  working on one issue.
- `~/.cache/gate-slot-locks/` (`GATE_LOCK_DIR`): `gate-slot.sh`'s lock files and
  its `gate-runs.log`.

`/review-changes` also reads Claude Code's own session transcripts under
`~/.claude/projects/`, without writing to them. The design docs themselves live in
the repo (`PROPOSALS_DIR`).

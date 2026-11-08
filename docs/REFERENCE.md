# Reference

Detailed reference for [claude-code-pipeline](../README.md): workflow modes and
args, configuration, gate wrappers, the proposal lint, the state kept outside the
repo, result statuses, resuming a stopped run and watching a handed-off PR. The design-doc format is in
[PROPOSALS.md](PROPOSALS.md).

## `plan-to-merged-pr` modes

| Mode | args | Use |
|---|---|---|
| full (default) | `{ concern }` | one concern from plan to a watched PR |
| build-only | `{ concern, ship: false, branch, dir, bases }` | a stacked lane whose predecessors are not merged yet: everything up to the merge check, then push, no PR |
| ship-only | `{ ship_only: true, branch, title \| existing_pr, dir?, predecessor_prs?, proposal?, plan_text? }` | open (or ready) the PR for a built branch (a lane, or the bootstrap branch) once every PR below it has merged, then monitor; `predecessor_prs` lists the PRs below a stacked lane (the chain's ship plan gives a placeholder for every lane after the first in its chain; `ship-chain` fills it in as each PR below merges), and nothing is opened or readied until each reads `MERGED`. A run given `bases` that opens or readies a PR is refused without it |
| monitor-only | `{ pr, branch, dir?, plan_text?, proposal? }` | babysit an existing PR; a run that hands it off returns these args as `resume_monitor` ([Watching a handed-off PR](#watching-a-handed-off-pr)) |

## Install and configuration

Requirements:

- Claude Code with **workflows** support (the `.claude/workflows/*.js` scripts run
  through its Workflow tool), plus Skill and Agent support for the commands.
- `git` and an authenticated `gh` CLI, for the PR and issue stages.
- `python3` (3.8+, standard library only), which `/review-changes` uses to read the
  session transcript and every design-doc command runs `proposal-lint.py` with.
- A GitHub repository with CI. An AI review check is optional (see *AI review*
  below). The repository must exist before any run (for a new product, a clean
  clone of a new repository with an `origin` remote): the pipeline never creates one. A greenfield project needs no CI
  yet: `/bootstrap` writes it, on a `bootstrap/<date>` branch shipped as the first
  PR (or, when the remote has no commits at all, as the root commit on local `main`,
  which a person pushes by hand).
- For `gate-slot.sh`: Linux, bash 4.3+, `flock` (util-linux) and, to pin CPUs,
  `taskset`.

Steps:

```sh
git clone https://github.com/thomas-sodon/claude-code-pipeline /tmp/ccp
cd your-project
python3 /tmp/ccp/.claude/scripts/pipeline-sync.py --from /tmp/ccp
```

Then add a `## Pipeline config` section to your project's root `CLAUDE.md` (see
[`examples/CLAUDE.pipeline-config.md`](../examples/CLAUDE.pipeline-config.md)).

Or open Claude Code in the pipeline checkout
(`cd /tmp/ccp && claude`) and run `/seed /abs/path/to/your-project`. The project
must be a git repository with an `origin` remote and no uncommitted changes to
tracked files. `/seed` copies the same directories (plus `.claude/skills/` when the
source has one, and `.claude/settings.json` when the project has none), never
replaces a file that differs without `--update`, and writes a base `CLAUDE.md`, or
appends to an existing one the sections it lacks: `## How work happens here` and a
`## Pipeline config` with `MAIN_BRANCH` and `PROPOSALS_DIR` but no `QUALITY_GATES`.
It commits nothing: on an existing project, land the files with `/create-pr`.
`brief-to-proposals` runs `/seed` as its first phase.

**Updating.** `.claude/scripts/pipeline-sync.py` installs and updates the
pipeline's files; `/seed` runs it. It records the source (repo, ref, commit) and
the sha256 of each file as installed in `.claude/pipeline-manifest.json`; commit
that file with the rest of `.claude/`.

```
pipeline-sync.py [--target DIR] [--from DIR | --repo URL] [--ref REF]
                 [--update] [--force] [--dry-run] [--check] [--json]
```

With no `--from`, it clones `--repo` at `--ref` (default: the manifest's, else this
repository at `main`). Without `--update` it only adds missing files. `--update`
replaces files unedited since install, deletes unedited files the source no longer
ships, and keeps local edits (`local_edit`) and files changed on both sides
(`conflict`; `--force` takes the source's). A file a person deleted stays deleted.
`--check` changes nothing and exits 1 when anything is pending; `--dry-run` reports
without writing; exit 2 is a usage error, a source that is not a pipeline, or a git
failure. `CLAUDE.md` is never touched: compare its `## How work happens here` with
`/seed`'s template after a large update. [`examples/pipeline-update.yml`](../examples/pipeline-update.yml)
runs it weekly in GitHub Actions and opens a PR.

**Linting the design docs in CI.** `/bootstrap` gives a new repository's CI a
`docs` job: `proposal-lint.py` on every design doc in `PROPOSALS_DIR` (a `.md` file
whose first `# ` heading is `# Proposal:`, `# Roadmap:` or `# Architecture:`; other
files there are skipped), `--roadmap` on `roadmap.md`, and, when `CLAUDE.md` carries
`/bootstrap`'s Pipeline config marker, `--claude-md CLAUDE.md` on `architecture.md`.
For a repository bootstrapped before that, or an existing project, paste the job
from [`examples/docs-lint-job.yml`](../examples/docs-lint-job.yml) under `jobs:` in
your CI workflow, set its `PROPOSALS_DIR` and pin its checkout as your other jobs
do, and once it has run require the `docs` check on `main` beside your gates check.
Docs PRs (accepting a doc, ticking a gate, writing an `Outcome:`) are then linted
before they merge, instead of surfacing as `proposal_lint_errors` when a build
starts.

On an existing project, add `QUALITY_GATES` yourself (`/seed` reports the commands
your CI runs as the candidate value). On a greenfield project, `/bootstrap`
completes the section from the accepted architecture, adding `QUALITY_GATES`,
`QUALITY_GATES_FAST` and `TEST_GUIDELINES`.

| Key | Meaning | Default |
|---|---|---|
| `QUALITY_GATES` | full gate command; must exit 0 when green | **required** |
| `QUALITY_GATES_FAST` | quicker subset for iterating | `QUALITY_GATES` |
| `MAIN_BRANCH` | integration branch, read by the commands | `main` |
| `PLANS_DIR` | where plans are written | `~/.claude/plans` |
| `PROPOSALS_DIR` | design docs: where `/roadmap` and `/propose` write, and where `/impl` doc mode and `/plan` look | `docs/design` for `/roadmap`, `/propose` and `/review-proposal`; none for `/plan` and `/impl` (`/impl` doc mode still applies to any `# Proposal:` doc passed by path) |
| `GH_WRAPPER` | prefix for gh / git network commands (e.g. a script that loads a token) | none (ambient `gh auth`) |
| `GATE_WRAPPER` | prefix for every gate run | none; use `./.claude/scripts/gate-slot.sh` when several agents share a host |
| `TEST_GUIDELINES` | where your testing rules live | `CLAUDE.md` |

The workflows do not read `MAIN_BRANCH`; pass `main_branch` when your integration
branch is not `main`. They also take two settings only as args: `ai_review_check`,
the name of a CI check that posts AI review comments (default none), which the
monitor waits for before counting comments; and `gate`, a gate wrapper that
the agents use instead of `GATE_WRAPPER`, never nesting the two (default `''`: the
agents use `GATE_WRAPPER` when it is set, else run the gates directly).

**AI review.** [`examples/answerable-ai-review.yml`](../examples/answerable-ai-review.yml)
is a GitHub Action that reviews each PR push with Claude and posts findings as review
comments. Copy it to `.github/workflows/` and add the secret `CLAUDE_CODE_OAUTH_TOKEN`
by name (`gh secret set CLAUDE_CODE_OAUTH_TOKEN`; never write the value down). Its
checks:

| Check | Does | Use |
|---|---|---|
| `Review` | reviews the diff and posts findings; skipped on fork PRs (no secrets) | pass `ai_review_check: 'Review'` |
| `Reply coverage` | fails while a finding has no reply; re-runs on each review-comment reply | require it on `main` to block merge on unanswered findings |

`/process-comments`, which the monitor runs, fixes or answers each finding, so
`Reply coverage` turns green without another push. `/bootstrap`'s next steps offer
it; `/seed` offers it on an existing repository with no AI review check.

## Gate wrappers

With a wrapper set, every gate runs as `$GATE_WRAPPER bash -c '<QUALITY_GATES>'`,
with the gate command's text between the single quotes, so a compound command such
as `lint && typecheck && test` runs whole under the wrapper rather than only its
first command. The single quotes leave a variable such as `$GATE_SLOT_WORKERS` for
the wrapper's shell to expand; write a `'` inside the gate command as `'\''`.

**Gate slots.** When several agents share a machine, route every gate run
through `.claude/scripts/gate-slot.sh <command>`. It plans CPU-disjoint slots
from the CPU affinity, any cgroup CPU quota and the memory bound (tune with
`GATE_SLOTS`, `GATE_SLOT_CPUS` (default 4) and `GATE_SLOT_MEM_MB` (default 4096)),
pins the run with
`taskset`, and exports `GATE_SLOT_WORKERS` so your test runner can size itself
(`jest --maxWorkers=$GATE_SLOT_WORKERS`, `pytest -n $GATE_SLOT_WORKERS`, …).
Exit 75 means every slot stayed busy for `GATE_WAIT` seconds (default 300), so
re-run the same command. Exit 125 means
the wrapper itself cannot run: report it, never bypass it. Every checkout on a
host must share `GATE_LOCK_DIR`.

## `proposal-lint.py`

`.claude/scripts/proposal-lint.py` is the deterministic gate on design docs. It
reads only the files it is given: no git, no network.

```
proposal-lint.py DOC [--repo DIR] [--json] [--no-resolve-xrefs] [--as PATH]
proposal-lint.py DOC --lanes [--root DIR] [--date YYYYMMDD] [--branch-prefix feat/]
                             [--remote-heads FILE] [--repo DIR] [--allow-draft]
proposal-lint.py DOC --tick N[,N...]
proposal-lint.py ROADMAP --roadmap
proposal-lint.py ARCHITECTURE --claude-md PATH [--json]
```

- **Lint** (default): prints `path:line: E|W code: message` lines and a summary, or
  with `--json` `{doc, kind, title, header, errors, warnings, steps}`; each step is
  `{n, title, done, line, description, human_gate: null | {kind, text}, files: [{path, new}], depends: [{doc: null | path, n}], acceptance, lane, outcome, …}`.
  `--repo DIR` checks `Files:` against that checkout; `--no-resolve-xrefs` skips
  reading other docs (`<file>.md#N` refs, `Source:`) and, with it, the
  `source_unresolved`, `lane_mixed` and `--repo` `Files:` checks. `--as PATH` (also with `--lanes`
  and `--roadmap`) resolves cross-doc refs — `Source:`, `<file>.md#N`, a roadmap's
  `Proposal:` — as if DOC sat at PATH, so a draft kept outside the repo (a
  `--dry-run` copy) lints against the docs beside its real path; without it, those
  refs warn `source_unresolved` / `xref_unreadable`. The codes are listed in
  [PROPOSALS.md](PROPOSALS.md#lint-codes).
- **`--lanes`**: derives lanes and chains ([how](PROPOSALS.md#lanes-and-chains)) and
  prints `{doc, slug, errors, warnings, chains: [{key, lanes: [{key, steps, titles, concern, branch, dir, bases, files, already_built}]}], blocked: [{lane, steps, waiting_on: [{doc, n, title, reason}]}], human_gates_pending: [{n, title, kind, text, ready, waiting_on}], milestone_waits, done}`.
  A doc with lint errors gets no lanes (exit 1): the output is then
  `{doc, errors, warnings, chains: [], blocked: [], human_gates_pending: [], done: []}`,
  with no `slug` or `milestone_waits`; a `lane_cycle` error, found while deriving, returns
  the full shape with empty `chains`, `blocked`, `human_gates_pending` and `milestone_waits`.
  `dir` is null without `--root`;
  `--remote-heads` takes the output of `git ls-remote --heads origin`;
  `--allow-draft` builds a doc whose `Status:` is not `accepted` / `in-progress`.
  A `Source:` that names a roadmap milestone the lint cannot resolve (the file is
  unreadable or not a roadmap, it has no milestone N, or the header is not in the
  `<file>.md#N` form) blocks every lane with reason `milestone_unresolved` (fail
  closed; the lint warns W `source_unresolved`). `lane_cycle` is checked over every
  lane, blocked or not, so a draft's `--lanes --allow-draft` preview reports it.
- **`--tick N,…`**: ticks those steps in place (atomic, no other byte changes, file
  mode kept) and prints `{ticked, already, missing}`; any missing number ticks
  nothing (exit 1).
- **`--roadmap`**: prints `{doc, kind, errors, warnings, milestones: [{n, title, done, human_gate, proposal, proposal_exists, progress: {done, total, gates_pending}, complete, satisfied, depends}], next}`.
- **`--claude-md PATH`**: lints the architecture doc and checks that the `CLAUDE.md`
  at PATH carries its `## Invariants` and `## Testing` bodies verbatim, as
  `/bootstrap` copied them. Each section that differs, or is missing, is E
  `claude_md_drift`, at the `CLAUDE.md` line of the first difference; the error
  carries `path: PATH` (and plain output prints PATH). Blank lines at either end of a
  body are ignored, and so is the one pointer line `/bootstrap` adds under
  `## Invariants` (a first or last line of the body naming `architecture.md` that the
  architecture's body lacks). A non-architecture DOC is E `not_an_architecture`.
  Output as in lint mode (`--json` for JSON).

Exit 0 = no errors (warnings allowed); 1 = lint errors (`claude_md_drift` included),
or a `--tick` / `--lanes` request that cannot be met; 2 = usage error or unreadable
file (DOC, or `--claude-md`'s PATH). `--lanes`,
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
  allow_draft: false,              // true = /plan gets --allow-draft after --proposal=<path>, to plan from a draft doc
  context: 'scouting hints for the planner',
  plan_text: '...',                // an already-written plan (skips planning; needs branch). In ship-only and
                                   // monitor-only modes: the branch's own plan, for comment fixes and conflicts
  dir: '/abs/path/to/checkout',    // work only here; in full and build-only modes with `branch`, created if absent as a
                                   // worktree on it (from origin/<last base>, else origin/<main_branch>);
                                   // ship-only and monitor-only need an existing checkout
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
  efforts: { plan: 'medium', impl: 'low', review: 'high', fix: 'low', polish: 'low', merge_check: 'low', monitor: 'low', closeout: 'low' },
                                   // efforts.pr (unset) sets /create-pr's effort; unset keys inherit the session's
  on_question: 'stop',             // 'stop' = a blocking question ends the run with needs_input; 'assume' = take the
                                   // recommended option and list it in the result's assumptions
  answers: [{ id: 'plan.q1', answer: '...' }],   // answers to a needs_input result's questions (see Answering questions)
}
```

The workflow passes its `main_branch` to `/create-pr` (as the PR base) and to
`/merge-main` explicitly. In ship-only mode, a merge check that had to resolve
conflicts gets one `/review-changes` round before the PR opens. When `/impl` finds
the plan's end state already in the checkout (a re-run on a kept worktree whose
earlier run built it), it reports `already_implemented` and the run reviews that
work instead of stopping at `failed_at_impl`. The monitor treats the branch's plan
as design intent and ignores any one-time instruction in it to the implementer
(deleting, reverting or cleaning up files): that already happened.

`bug-fix-backlog`: `{ lanes: [{ key, issues, branch?, dir? }], intake, labels, dir, root, date, ship, close, efforts: { intake, triage, verify, close }, ... }`.
`date` suffixes the default lane branch names (`bugfix/<key>-<issues>-<date>`;
default `undated`). `root` is required unless every lane gives its own `dir`
(default `<root>/fix-<issues>`, the issue numbers joined by `-`), and always with
the Intake. `ship` and
`close` default to true; `close: false` lists confirmed-fixed issues in
`confirmed_fixed_unclosed` instead of closing them. `efforts` defaults to
`{ intake: 'medium', triage: 'medium', verify: 'high', close: 'low' }`.

Without `lanes` (or with `intake: true`, which ignores any `lanes` given), the
**Intake** runs first: one read-only agent in `dir` (default: the working
directory) lists the open issues carrying any of `labels` (default `['bug']`),
locates each one's code on `origin/<main_branch>`, groups issues that share a code
site into one lane (every other issue is a lane of its own; an issue an open PR
already closes, or that is not a bug report, is left out as `unlaned`), and lists
the red CI runs (failure, timed out, startup failure) on the five newest commits of
`origin/<main_branch>`. It reports only: it never files, edits, labels, comments on
or closes an issue, and a red run becomes an issue only if the person files one.
The run then stops with `needs_input` (stage `intake`) whatever `on_question` says,
since which issues to work and how they group is the person's call. Its one
question, `intake.q1`, has the proposed lanes as its `recommended` answer (JSON).
Re-run with the same args (still without `lanes`) plus
`answers: [{ id: 'intake.q1', answer }]`, where `answer` is the lanes the person
confirmed or edited, as a JSON array of `{ key, issues }` (`'[]'` runs nothing), or
`'accept'`, which takes the lanes the Intake proposes on that run, so pass it only
with `resumeFromRunId` (the Intake then replays from the record). Any other answer
throws. The intake answer reaches no lane. `intake: false` without `lanes` throws.
Only `gate`, `main_branch`, `ai_review_check`, `commit_trailers`,
`max_review_rounds`, `max_polish`, `max_monitor_rounds`, `efforts` (the whole
object, so it may carry `plan-to-merged-pr`'s keys too), `on_question` and
`ship: false` are passed through to `plan-to-merged-pr`; `answers` (each with the
`lane` it belongs to) go to their own lane only. Lanes must not share a key, an issue, a `dir` or a
`branch`.

`brief-to-proposals` (pass exactly one of `brief` and `concern`):

```js
{
  brief: 'docs/brief.md',          // product brief, relative to dir or absolute: architecture, roadmap, a proposal per code milestone
  concern: '...',                  // or one change too big for one PR: a single proposal, no architecture or roadmap
  dir: '/abs/path/to/project',     // required; the project's repository: a clean clone (the pipeline never creates one)
  pipeline: '/abs/path/to/ccp',    // a checkout of this pipeline: the Seed phase (/seed) installs its skills, workflows
                                   // and scripts into dir and writes a base CLAUDE.md before any design work.
                                   // Omit only when dir already holds the pipeline: /seed then copies nothing, still checks
                                   // the repo, and writes CLAUDE.md or appends the base sections it lacks (a dir without
                                   // .claude/commands/seed.md stops with failed_at_seed, no_source).
  out: 'docs/design',              // proposals directory, relative to dir (default: PROPOSALS_DIR, else docs/design)
  context: '...',                  // framing every author treats as binding: builder, budget, constraints the source omits
  panel: 3,                        // independent architecture sketches judged before /roadmap; 0 = no panel
  milestones: [2, 4],              // propose only these milestones (default: every pending code milestone)
  max_milestones: 1,               // propose at most the first N of those, in roadmap order (try the flow on one; 1 is
                                   // recommended for a long roadmap: later proposals go stale as earlier milestones land)
  force: false,                    // let /roadmap overwrite architecture.md / roadmap.md (never once a milestone is ticked)
  max_review_rounds: 3,            // revise rounds per doc
  efforts: { intake: 'medium', sketch: 'medium', judge: 'high', roadmap: 'high', propose: 'medium', review: 'high', revise: 'medium', consistency: 'high', lint: 'low' },
  on_question: 'stop',             // 'assume' = proceed on the recommended answers; the Intake's are shared by every later stage
  answers: [{ id: 'intake.q1', answer: '...' }],  // answers to a needs_input result's questions
}
```

Apart from the Seed phase, which copies the pipeline's `.claude` files into `dir`
and writes or appends its base `CLAUDE.md`, it writes design docs only: no code, no
commits, no git-state change. On a new repository those files ship in the bootstrap
commit; on an existing one, land them and the docs through an ordinary PR
(`/create-pr`). Every doc it writes is `Status: draft`. Each per-doc reviser edits only the doc(s) under review;
findings about any other doc are deferred to the Consistency phase. Concern mode
has no Consistency phase, so its result returns those as `deferred_findings`.

`proposal-build-chain` has two modes; `planner`, `gate`, `main_branch`,
`commit_trailers`, `max_review_rounds`, `max_polish`, `efforts`, `allow_draft` and
`on_question` pass through to every lane in both, and each of `answers` (with the
`lane` it belongs to) to its own lane only. `ai_review_check` and `required_checks` are
not used to build: derive mode copies them, with `main_branch`, `gate` and
`commit_trailers`, into each `ship_plan` entry's args.

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
into a scratch directory (and the roadmap's directory too, when the proposal's
`Source:` names a roadmap elsewhere), lists the remote's branches, runs
`proposal-lint.py <proposal> --lanes --repo <dir> --root <root> --date <date> --remote-heads <file>`
and returns its JSON verbatim. Preconditions: the doc lints clean, it is on
`origin/<main>` (every lane worktree is cut from there and must read it), and its
`Status:` is `accepted` or `in-progress` (else every lane is blocked, unless
`allow_draft`), and its `Source:` milestone, if any, resolves (else every lane is
blocked: `milestone_unresolved`). Chains then
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

`ship-chain` ships one chain of a derive-mode `ship_plan`, in merge order:

```js
{
  chain: { chain: 's1', order: [{ lane: 's1', branch: 'feat/x-s1-20261104', steps: [1], args: { ship_only: true, ... } }, ...] },
                                   // one ship_plan entry (its ship_chain_args.chain); each lane's args are its
                                   // plan-to-merged-pr ship-only args and must name its checkout as dir
  title_prefix: '[status page] ',  // prepended to every lane's PR title, unless it already starts with it
  max_wait_rounds: 48,             // wait rounds per PR, each polling up to ~30 minutes, before stopping with not_merged
  main_branch: 'main', ai_review_check: '', required_checks: [], gate: '', commit_trailers: [...],
  max_monitor_rounds: 10, efforts: {...}, on_question: 'stop',
                                   // shared ship settings: each one given overrides the lanes' own args
  answers: [{ lane: 's2', id: 'merge_check.q1', answer: '...' }],   // each to its own lane only
}
```

Per lane, a read-only agent first looks for a PR from the lane's branch to
`main_branch` (`gh pr list --head <branch> --state all`). A `MERGED` one is skipped
and counts as merged; a `CLOSED` one stops the chain; an `OPEN` one (an earlier run
opened it) is monitored with `plan-to-merged-pr` monitor-only mode, never opened
twice. With none, the lane runs `plan-to-merged-pr { ship_only: true }` with its
`title` (a placeholder, empty or `<...>`, is written from the lane's proposal steps,
`steps` or the numbers in the placeholder, else from the branch's commits) and
`predecessor_prs` (placeholders replaced by the merged PR numbers of the lanes
above; numbers already given are kept). A run that ends `OPEN` is then waited on:
an agent polls `gh pr view <n> --json state` with the Monitor tool until it reads
`MERGED` or `CLOSED`. No stage merges, approves, closes or edits a PR, or enables
auto-merge; the next lane's PR is opened only once the one below has merged.

## Result statuses

Every result carries a `status`.

`plan-to-merged-pr`:

- `pushed` (build-only)
- `needs_input` — a stage (`stage`: `plan`, `impl`, `fix`, `merge_check` or `monitor`) hit questions only the person can answer and stopped there, changing nothing further; `questions` lists them and `relay` says what to do (see [Answering questions](#answering-questions))
- `failed_at_plan`, `failed_at_impl`
- `review_failed`, `blocked_at_review` (also in ship-only, after a conflicted merge)
- `blocked_at_predecessors`
- `failed_at_merge_check`, `blocked_at_merge_check`
- `failed_at_push`, `blocked_at_pr`
- after monitoring: the PR's last state (`OPEN` / `MERGED` / `CLOSED`), or `monitor_failed`

Every result also carries `assumptions`: each choice a stage made that its inputs
did not settle, with the stage that made it.

After monitoring, the result also carries:

- `resume_monitor` and `handoff`, when the monitor hands off a PR that is still
  open (`OPEN`: settled, the `max_monitor_rounds` cap hit, or red CI outside the
  PR; or `monitor_failed`). `resume_monitor` is the exact monitor-only args,
  `{ pr, branch, dir?, plan_text? }` plus whichever of `proposal`, `main_branch`,
  `ai_review_check`, `required_checks`, `gate`, `commit_trailers`, `efforts`,
  `on_question` and `max_monitor_rounds` the run was given; `handoff` is one line
  saying why it stopped and how to re-run it. A `needs_input` result from the
  `monitor` stage carries `resume_monitor` too.
- `closeout`, when the run was given `proposal` and the PR reads `MERGED`. One
  read-only agent (`efforts.closeout`, default low) lints the proposal as it is on
  `origin/<main_branch>` (`proposal-lint.py --json`), and `--roadmap` on the
  roadmap its `Source:` names, when that resolves. Every step ticked gives
  `{ proposal_complete: true, edits, next_milestone, roadmap }`: `edits` lists
  `{ file, line, before, after }` for the `Status:` → `Status: done` change and
  the milestone's `[ ]` → `[x]` tick (an `- Outcome:` line too, only when the
  milestone is a human gate: on a code milestone it is W `outcome_on_code_step`),
  each left out when already made; `next_milestone` is `--roadmap`'s `next`, as
  `[{ n, title }]` (empty without a roadmap). Steps left give
  `{ proposal_complete: false, pending_steps }`. The run never makes these edits:
  a person does, in a docs PR. No `closeout` means the check could not run (the
  log says why).

`proposal-build-chain`, explicit mode: an array of `{ lane, branch, steps, status, result }`,
one per lane attempted, `status` being the lane's `plan-to-merged-pr` status (or
`failed`); a `needs_input` lane also carries `questions` (each with its `lane`) and
`relay`. Derive mode: `{ status, proposal, source, chains, blocked, human_gates_pending, milestone_waits, ship_plan }`, where:

- `pushed` — every lane is pushed or `already_built`
- `needs_input` — some lane stopped with `needs_input` (its chain stopped there; other chains carried on); `questions` lists every lane's questions, each with its `lane`, and `relay` says what to do
- `partial` — some lane did not push; its chain stopped there (`not_built` lists the rest), other chains carried on
- `all_blocked` — no lane can build: each waits on a gate, another doc, a milestone (or an unresolvable `Source:` milestone) or acceptance (see `blocked`)
- `nothing_to_build` — no pending code step
- `proposal_lint_errors` — the doc has lint errors (listed); fix it before building
- `proposal_not_on_main` — the doc is only in the working copy; land it through a docs PR first (a `preview` of its lanes is included)
- `failed_at_derive` — the derive agent failed or did not return the script's JSON

Each chain lists its lanes with a per-lane status (a `plan-to-merged-pr` status,
`already_built` or `failed`). `ship_plan` gives, per chain in merge order, the
`ship_only` args for each built lane (`branch`, `dir`, `proposal`, its `plan_text`,
the `main_branch`, `ai_review_check`, `required_checks`, `gate` and
`commit_trailers` given to the chain, and `predecessor_prs` placeholders for every
lane after the first). Each `order` entry also lists the lane's `steps`, and each
chain carries `ship_chain_args`, `{ chain }` for `ship-chain`.

`ship-chain`: `{ status, chain, lanes, merged_prs, stopped_at?, not_shipped, questions?, relay? }`.
`lanes` lists each lane reached, `{ lane, branch, title, pr, status, result }`, its
`status` the PR's last state (`MERGED`, `OPEN`, `CLOSED`) or the lane's
`plan-to-merged-pr` status (`failed` when it threw or returned nothing),
`already_merged` on a lane skipped because its PR had merged, and `wait_notes` on
one still open at the wait cap. `merged_prs` are the chain's merged PRs in order;
`stopped_at` names the lane the run stopped at and why; `not_shipped` lists the
lanes never reached. `status` is:

- `merged` — every lane's PR reads `MERGED`
- `needs_input` — a lane's run stopped with `needs_input`; `questions` lists them, each with its `lane`, and `relay` says what to do
- `closed` — a lane's PR was closed without merging (by a person, or before this run)
- `not_merged` — a lane's PR is still open after `max_wait_rounds`; `stopped_at.reason` carries what holds it (conflicts, red checks, review comments). Merge it (or act on it) and re-run with the same args
- `lane_failed` — a lane's lookup did not report, or its `plan-to-merged-pr` run ended with any other status (`blocked_at_predecessors`, `blocked_at_merge_check`, `blocked_at_pr`, `monitor_failed`, ...); `stopped_at.reason` names it

`brief-to-proposals`:

- `needs_input` — blocking questions only the person can answer: from the Intake (no design written yet), `/roadmap` or the architecture's reviser (no proposal written), a milestone's author or reviser (that milestone waits, the others finish, and the Consistency phase is skipped), or a consistency reviser; `questions` lists them and `relay` says what to do
- `ready` — every doc lints clean, every proposal's lane preview has no errors, every proposal's review came back clean, and the Consistency phase (brief mode) reported, revised every affected doc and got each revised doc back clean from its re-review
- `proposals_need_attention` — a proposal was not written (listed `failed`, with its `stop_reason` when `/propose` stopped or routed the work elsewhere), its review did not finish, or it still has a `bug` or `concern` after `max_review_rounds` (`findings_remaining`); or the Consistency pass failed to report, a consistency revision failed, a revised doc did not come back clean from its re-review, or a finding named a doc this run did not write (`consistency.unrouted`)
- `lint_errors` — a doc still has lint errors, or a proposal's lane preview (`--lanes --allow-draft`, e.g. `lane_cycle`) has errors; `lint_failed` — the lint stage did not report
- `blocked_at_architecture_review` — architecture.md or roadmap.md still has a `bug` or `concern` after `max_review_rounds`; no proposal was written
- `review_failed` — a review or revise stage of the architecture failed to report
- `failed_at_seed` — `/seed` stopped (`no_source`: pass `pipeline`; `not_a_repo`, `no_remote`, `dirty_tree`: tracked changes outside `.claude/` and `CLAUDE.md`); `stop_reason` quotes it, and the result carries nothing else
- `failed_at_roadmap` — `/roadmap` stopped or did not finish (e.g. `error=exists`: pass `force`, or revise instead); `stop_reason` quotes it
- `failed_at_propose` — concern mode: `/propose` stopped, routed the work elsewhere (e.g. to `/plan`) or did not finish; `stop_reason` quotes it

Every result past the Intake carries `assumptions`. `failed_at_roadmap` and every status the Lint phase sets (`ready`,
`proposals_need_attention`, `lint_errors`, `lint_failed`) also carry `seeded`: what
was copied, kept and written; `review_failed`, `blocked_at_architecture_review` and
`failed_at_propose` do not. The Lint-phase result also carries the doc paths, the panel's scores, each doc's review
outcome, the consistency findings, revisions and re-reviews, the lint and lane
summary, and `next_steps`. A review that reports only suggestions and nits is clean
once a revise round has run, or once `max_review_rounds` is reached.

`bug-fix-backlog`: a run that stops at the Intake returns one object, not an array:

- `needs_input` — `stage: 'intake'`, `questions` (the one `intake.q1`), `relay`,
  `labels`, `proposed_lanes` (each `{ key, issues, code_site, why }`), `unlaned`
  (`{ number, reason }`), `ci_red` (`{ workflow, url, sha, conclusion,
  failing_jobs, summary, tracked_by }`, report only) and `issues` (each listed
  issue with its `code_sites`)
- `failed_at_intake` — the Intake failed to report; nothing else

An intake answer of `'[]'` returns `[]`. Otherwise the result is an array, one
entry per lane, `{ lane, status, ... }` with `lane` the lane's key. `status` is:

- `failed_at_triage` — the triage stage failed to report; `branch_mismatch` — the
  lane's worktree is on a branch other than the lane's (it is never switched). Both
  carry only `lane` and `status`.
- `nothing_to_ship` — no issue in the lane is a confirmed bug; the reproducer's
  uncommitted tests are removed (`dirty` and `unresolved_tests` report what is left,
  or `cleanup_failed` with `uncommitted_tests` when that step failed)
- otherwise the `plan-to-merged-pr` status of the lane's run (`failed` when it threw
  or returned nothing), with `pr`, `review_clean`, `polish_clean`, `final_state` and
  `spared_tests` (tests the implementer was told to delete but had to spare, because
  their file held work from before the run); a `needs_input` lane also carries
  `questions` (each with its `lane`) and `relay`
- `failed` — also a lane that failed outright: `{ lane, status }` only

Every entry past triage also lists `branch`, `dir`, `closed`, `not_closed`,
`confirmed_fixed_unclosed` (filled only with `close: false`), `needs_human`,
`skipped` and `bugs`.

## Answering questions

A **blocking question** is one only the person can answer: what they intend, a
requirement or constraint the brief, concern, plan or design doc leaves out or
states two incompatible ways, a trade-off that is theirs, or a blocker whose way
forward is their call, where the plausible answers lead to materially different
work. Anything the tree, `CLAUDE.md`, the docs or desk research can settle is
settled, not asked. Data a person must gather stays a `research` gate, and a choice
that waits on evidence the plan produces stays a `decision` gate.

Run interactively, a command (`/roadmap`, `/propose`, `/plan`, `/impl`,
`/merge-main`) asks every such question at once, each with options and a
recommendation, and waits. Inside a workflow no one can answer mid-run, so the
stage stops and the workflow returns `status: 'needs_input'` with:

```js
questions: [{ id: 'plan.q1', stage: 'plan', question: '...', why: 'what changes with the answer',
              options: ['...', '...'], recommended: '...' }],   // a lane workflow adds lane: '<key>'
relay: 'Ask the person these questions yourself ...',
```

The session that ran the workflow asks the person (never answers for them), then
re-runs it with the same args plus `answers`, the questions with an `answer` field
added (`[{ id, answer }]`, or `{ '<id>': '<answer>' }`), and `resumeFromRunId` set
to the stopped run's id. Each answer reaches the stage that asked and every later
stage, never an earlier one, so the stages before it replay from the record:

- `plan-to-merged-pr`: stages run `plan` → `impl` → `fix` → `merge_check` → `monitor`.
  An answer to a `monitor` question (an incompatible conflict `/merge-main` would
  not pick a side in) is given in monitor-only mode instead: the result's `resume_monitor` plus `answers`.
- `brief-to-proposals`: `intake` → `architecture` → a milestone (`m<N>`; in concern
  mode `proposal`) → `consistency`. A milestone's answer reaches only that
  milestone's author, reviewers and revisers, and the Consistency phase.
- `proposal-build-chain` and `bug-fix-backlog`: each answer keeps the `lane` its
  question carried and goes to that lane only. Re-run with the same args (the same
  `date`): pushed lanes come back `already_built`, closed or shipped issues are
  re-checked and skipped, and the lane that asked builds again in its kept worktree.
  `bug-fix-backlog`'s Intake question (`intake.q1`, no `lane`) is answered with the
  confirmed lanes instead and reaches no lane ([args](#workflow-args)).
- `ship-chain`: each answer keeps its `lane` and goes to that lane's
  `plan-to-merged-pr` run only. Re-run with the same args: lanes whose PR merged are
  skipped, and the lane that asked ships again (monitor-only, with its answers, when
  its PR is already open, as a `monitor` question needs).

`on_question: 'assume'` is for runs no one will answer: each blocking question is
settled by its recommended option instead, and listed in the result's `assumptions`.
Every result lists `assumptions` either way, the choices the agents made that their
inputs did not settle, so none is silent.

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
come back `already_built` and are not rebuilt. `ship-chain` is the same: a fresh
run with the same args skips lanes whose PR merged and picks up an open PR where it
is.

## Watching a handed-off PR

Once the monitor hands a PR off, nothing watches it: a review comment, a conflict
from `main` moving, or CI turning red is picked up only when monitor-only mode runs
again. Re-run it with the hand-off result's `resume_monitor` as args. To have that
happen on its own, re-run it on a schedule; no extra infrastructure is needed:

- **In a session**, with `/loop`:
  `/loop 2h Run the plan-to-merged-pr workflow with args <resume_monitor JSON>. Stop looping when its status is MERGED or CLOSED, or needs_input (then ask me its questions).`
- **Unattended**, as a recurring scheduled task (Claude Code's scheduled tasks, or
  your own cron running `claude -p`) with the same prompt and a fresh session per
  run, in a checkout of the branch (`dir`).

Each re-run is a full monitor of up to `max_monitor_rounds`; pass a small one (2 or
3) so a quiet PR costs one or two observe rounds. Never run two monitors on one PR
at once: both would push to its branch. A re-run that sees the PR `MERGED` with
`proposal` set reports `closeout`, so the scheduled watch also prompts the close-out.
Stop the schedule once the PR merges or closes.

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

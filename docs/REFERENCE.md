# Reference

Detailed reference for [claude-code-pipeline](../README.md): workflow modes and
args, configuration and GitHub access, gate wrappers, the proposal lint, result
statuses, answering questions, resuming a run in this session or a new one,
watching a handed-off PR, the context guard, the state branch and the state kept
outside the repo. The design-doc format and its size budgets are in
[PROPOSALS.md](PROPOSALS.md).

## `plan-to-merged-pr` modes

| Mode | args | Use |
|---|---|---|
| full (default) | `{ concern }` | one concern from plan to a watched PR |
| build-only | `{ concern, ship: false, branch, dir, bases }` | a stacked lane whose predecessors are not merged yet: everything up to the merge check, then push, no PR |
| ship-only | `{ ship_only: true, branch, title \| existing_pr, dir?, predecessor_prs?, proposal?, plan_ref?, plan_text?, repo?, github_access? }` | open (or ready) the PR for a built branch (a lane, or the bootstrap branch) once every PR below it has merged, then monitor; `predecessor_prs` lists the PRs below a stacked lane (the chain's ship plan gives a placeholder for every lane after the first in its chain; `ship-chain` fills it in as each PR below merges), and nothing is opened or readied until each reads `MERGED`. A run given `bases` that opens or readies a PR is refused without it |
| monitor-only | `{ pr, branch, dir?, plan_ref?, plan_text?, proposal?, repo?, github_access?, answers? }` | babysit an existing PR; a run that hands it off returns these args as `resume_monitor`, with the answers it was given ([Watching a handed-off PR](#watching-a-handed-off-pr)) |

## Install and configuration

Requirements:

- Claude Code with **workflows** support (the `.claude/workflows/*.js` scripts run
  through its Workflow tool), plus Skill and Agent support for the commands.
- `git`, and for the PR and issue stages either an authenticated `gh` CLI or the
  GitHub MCP connector (Claude Code cloud sessions, where `gh` is not logged in):
  see *GitHub access* below. `git fetch` and `git push` stay plain git either way.
- `python3` (3.8+, standard library only), which `/review-changes` uses to read the
  session transcript, every design-doc command runs `proposal-lint.py` with, and
  the context guard and `pipeline-state.py` run on.
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
source has one, and `.claude/settings.json`, the [context guard](#the-context-guard)'s
hooks, when the project has none; one it has is never edited, and `/seed` reports
the guard's entries it lacks as a snippet to merge by hand), never
replaces a file that differs without `--update`, and writes a base `CLAUDE.md`, or
appends to an existing one the sections it lacks: `## How work happens here` (the
template in `.claude/scripts/claude-md-base.md`, with a marker comment) and a
`## Pipeline config` with `MAIN_BRANCH` and `PROPOSALS_DIR` but no `QUALITY_GATES`.
It commits nothing: on an existing project, land the files with `/create-pr`.
`brief-to-proposals` runs `/seed` as its first phase. For a new product from a
`new-software-idea` brief, run `/start-product <brief> <repo>` from the pipeline
checkout first: it checks the brief's verdict and the repository, asks the person
its one batch of questions, writes `docs/brief.md` and `docs/builder-context.md`
(both listed in `.git/info/exclude`, never committed), and prints a setup checklist
and the `brief-to-proposals` call.

**What `/start-product` asks.** The idea skill never interviews the person, so the
brief's choices are its defaults. The command asks, in one batch and before it
writes anything:

| Id | Question | Where the answer goes |
|---|---|---|
| `q1` | should the design follow the builder framing drafted from the brief's `**Assumed builder:**` field (who builds, time, budget, skills, revenue target)? | `docs/builder-context.md` |
| `q2` to `q5` | the hours a week, the monthly budget, the skills and the revenue target, each only when the draft does not state it | `docs/builder-context.md` |
| `intake.d<N>` | one confirmation per product choice the brief made, with the brief's value as the recommended option: who it is for, the platforms of the first release, what is free and each price, the licence (and its variant; when the repository already holds a `LICENSE`, `LICENCE` or `COPYING` file of another licence, the confirmation names both and recommends neither), the stack sketch, what the first release leaves out, the first experiment with its stop criteria (and a check the brief dates before it), each caveat of the verdict and each open legal question; then the repository's owner and visibility | the printed call's `answers` |
| `q6` | keep the builder framing on the state branch, as `context/builder-context.md`? Asked only while no consent is on record | the file's header comment |

A choice the brief has no field for is not asked here (the personal data collected,
the product's final name, the accounts opened in the person's name): the design
run's Intake asks it. Each `intake.d<N>` answer the person gave is printed in the
call as `{ "id", "question", "answer", "date" }`; a choice they did not confirm is
never printed as an answer, so the Intake asks it as a confirmation. The framing
file holds who builds and the limits only: a product decision given while answering
`q1` to `q5` becomes one more `intake.d<N>` entry. `q6` defaults to no: only the
person's own yes is consent, and with it the command saves the file to the
[state branch](#the-state-branch), its one push. With no one to answer (an
unattended run, or no question tool) it writes nothing and stops with
`error=needs_input`, printing the draft and every question. Told to proceed on
assumptions, it takes each recommended option, prints no `answers` entry for a
choice taken that way, never assumes the consent, and, when `q1` was taken that
way, ends the framing file with a line starting `- Not confirmed by me yet`, which
the design run reads ([`context_file`](#workflow-args)). `--dry-run` prints the
draft, the questions and the call, and asks and writes nothing.

**Updating.** `.claude/scripts/pipeline-sync.py` installs and updates the
pipeline's files; `/seed` runs it. It records the source (repo, ref, commit) and
the sha256 of each file as installed in `.claude/pipeline-manifest.json`; commit
that file with the rest of `.claude/`.

```
pipeline-sync.py [--target DIR] [--from DIR | --repo URL] [--ref REF]
                 [--update] [--force] [--dry-run] [--check] [--check-claude-md] [--json]
```

With no `--from`, it clones `--repo` at `--ref` (a branch or a release tag;
default: the manifest's, else this repository at `main`) with its full commit
history but no file contents (`--filter=blob:none`). With `--from`, the ref is the
checkout's branch, or the tag a detached checkout sits on. Without `--update` it
only adds missing files. `--update`
replaces files unedited since install, deletes unedited files the source no longer
ships, and keeps local edits (`local_edit`) and files changed on both sides
(`conflict`; `--force` takes the source's). A file a person deleted stays deleted.
A file whose contents match but whose executable bit changed upstream is `mode`:
pending, and `--update` applies the mode without rewriting the file.
The manifest is an ordinary committed file, so its paths are not trusted: only
normalized paths under `.claude/{commands,skills,workflows,scripts}/` that resolve
inside the repository are compared, replaced or deleted; any other entry is left
alone and listed in the report as `ignored_manifest_paths`.
A file with no install record that differs from the source (a `cp -r` install,
before the manifest) is looked up in the source's git history: when some commit
shipped exactly its bytes (`git hash-object` against the blobs `git log --raw`
lists for that path), it is an unedited older version, classified `outdated` and
listed under `adopted`, with that version recorded as its base; otherwise it is
`differs`: it may hold local edits, so it is kept like a conflict, and only
`--update --force` replaces it.
`--check` changes nothing and exits 1 when anything is pending; `--dry-run` reports
without writing; exit 2 is any failure: a usage error, a source that is not a
pipeline (or whose git checkout ignores its pipeline files), a malformed manifest, a
git failure or a filesystem error. It is never 1, which `--check` keeps for pending.

`CLAUDE.md` is never edited. The report's `claude_md` compares its
`## How work happens here` section with the source's template,
`.claude/scripts/claude-md-base.md` (which `/seed` copies, marker comment
included), ignoring the marker, trailing spaces and blank-line runs:

| `claude_md.status` | Meaning |
|---|---|
| `current` | the section matches the template |
| `differs` | the section carries `/seed`'s marker and differs; `diff` holds a unified diff, `added` / `removed` its line counts |
| `unmarked` | the section differs and has no marker (written by hand, or by a `/seed` older than the marker); reported, never pending |
| `missing` | no `CLAUDE.md`, or no such section (`/seed` appends it) |
| `no_template` | the source ships no `claude-md-base.md` (an older pipeline) |

Apply a difference by hand. `--check-claude-md` adds `claude_md` to `pending` when
the status is `differs`, so `--check --check-claude-md` exits 1 on it; without the
flag `--check` ignores it. [`examples/pipeline-update.yml`](../examples/pipeline-update.yml)
runs the sync weekly in GitHub Actions and opens a PR on `pipeline/update-<sha>`
(one branch per upstream commit), closing the older open `pipeline/update-*` PRs
with a comment that points to the new one. `PIPELINE_REF` there, like `--ref`, pins
a release tag; see the README's *Pinning a release*.

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
starts. Docs written before the [size budgets](PROPOSALS.md#size-budgets) can fail
them: until they are split, add `--no-size-limits` to the job's three lint calls,
as the example's header says (off by default). It covers the job only: the builds
(`proposal-build-chain`, `/plan --proposal`, `/impl`, `/bootstrap`) never pass it,
so a proposal over an error limit is split (`refresh-proposal`) before it builds.

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
| `GITHUB_ACCESS` | how commands and workflows reach GitHub: `gh`, or `connector` (the GitHub MCP tools) | none: `gh` when it is authenticated, else the connector |
| `GATE_WRAPPER` | prefix for every gate run | none; use `./.claude/scripts/gate-slot.sh` when several agents share a host |
| `TEST_GUIDELINES` | where your testing rules live | `CLAUDE.md` |

The workflows do not read `MAIN_BRANCH`; pass `main_branch` when your integration
branch is not `main`. They also take two settings only as args: `ai_review_check`,
the name of a CI check that posts AI review comments (default none), which the
monitor waits for before counting comments; and `gate`, a gate wrapper that
the agents use instead of `GATE_WRAPPER`, never nesting the two (default `''`: the
agents use `GATE_WRAPPER` when it is set, else run the gates directly). Every
workflow but `refresh-proposal` takes `github_access` too (`'gh'` or `'connector'`;
default `''`: the agents use `GITHUB_ACCESS`, else `gh` when it is authenticated,
else the connector), names it in every prompt that touches GitHub, and passes it to
the workflows it runs; any other value throws before an agent runs.

**GitHub access.** [`.claude/scripts/github-access.md`](../.claude/scripts/github-access.md)
says which access a run uses and maps each `gh` operation the pipeline performs to
its connector tool. A named access is used alone: `gh` keeps each command's own
error (`gh_unauthenticated`, `gh_auth_failed`), and `connector` without the
`mcp__github__*` tools, or any other `GITHUB_ACCESS` value, stops with
`error=github_unavailable`. Agents load the connector's tools with ToolSearch and
take the owner and name from `origin`. In connector mode, `gh pr checks --watch`
becomes reads with timed waits between them (the Monitor tool). Secrets and
repository settings (branch protection, rulesets) have no connector path: a person
adds them, with `gh` on their own machine or under Settings. `/quality-gates` and
`/plan` skip their GitHub read and say so, rather than stop, when no access works.
A headless or scheduled run may lack the connector even where an interactive
session has it, and connector use inside a workflow run is not verified yet
([PROCESS.md](PROCESS.md), G14).

**AI review.** [`examples/answerable-ai-review.yml`](../examples/answerable-ai-review.yml)
is a GitHub Action that reviews each PR push with Claude, posts findings as review
comments and resolves its threads whose defect is fixed;
[`answerable-ai-review-replies.yml`](../examples/answerable-ai-review-replies.yml)
re-runs the reply gate when a finding is answered. Copy both to `.github/workflows/` and add the secret `CLAUDE_CODE_OAUTH_TOKEN`
by name (`gh secret set CLAUDE_CODE_OAUTH_TOKEN`; never write the value down). Its
checks:

| Check | Does | Use |
|---|---|---|
| `Review` | reviews the diff and posts findings; skipped on fork PRs (no secrets) | pass `ai_review_check: 'Review'` (the name holds while the file is copied unchanged) |
| `Reply coverage` | fails while a finding has no reply; re-runs after each review and on each reply or review (from `answerable-ai-review-replies.yml`) | require it on `main` to block merge on unanswered findings |

A check is named after its job's `name:`, or after the job's key under `jobs:` when
it has none: for an edited copy, or another review workflow, pass that name as
`ai_review_check` instead. `/process-comments`, which the monitor runs, fixes or
answers each finding, so `Reply coverage` turns green without another push.
`/bootstrap`'s next steps offer it; `/seed` offers it on an existing repository
with no AI review check, and on one that has a check reports its name as read from
the workflow file.

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
proposal-lint.py DOC [--repo DIR] [--json] [--no-resolve-xrefs] [--as PATH] [--no-size-limits]
proposal-lint.py DOC --lanes [--root DIR] [--date YYYYMMDD] [--branch-prefix feat/]
                             [--remote-heads FILE] [--repo DIR] [--allow-draft]
proposal-lint.py DOC --tick N[,N...]
proposal-lint.py DOC --decisions
proposal-lint.py ROADMAP --roadmap
proposal-lint.py ARCHITECTURE --claude-md PATH [--json]
```

- **Lint** (default): prints `path:line: E|W code: message` lines and a summary, or
  with `--json` `{doc, kind, title, header, errors, warnings, steps, decisions}`; each step is
  `{n, title, done, line, description, human_gate: null | {kind, text}, files: [{path, new}], depends: [{doc: null | path, n}], acceptance, lane, outcome, …}`,
  and each decision, a D-record under `## Decisions`, is
  `{id, n, title, line, by, date, ref}`: `by` is `person`, `source`, `assumed` or
  `''` (no tag), from the tag that ends its heading
  ([who decided](PROPOSALS.md#who-decided)); a roadmap has none. A record with no
  tag is W `decision_untagged` (one warning per doc) and a malformed tag W
  `bad_decision_tag`.
  `--repo DIR` checks `Files:` against that checkout; `--no-resolve-xrefs` skips
  reading other docs (`<file>.md#N` refs, `Source:`) and, with it, the
  `source_unresolved`, `lane_mixed` and `--repo` `Files:` checks. `--as PATH` (also with `--lanes`
  and `--roadmap`) resolves cross-doc refs — `Source:`, `<file>.md#N`, a roadmap's
  `Proposal:` — as if DOC sat at PATH, so a draft kept outside the repo (a
  `--dry-run` copy) lints against the docs beside its real path; without it, those
  refs warn `source_unresolved` / `xref_unreadable`. The codes are listed in
  [PROPOSALS.md](PROPOSALS.md#lint-codes).
- **Size budgets** (every mode but `--tick` and `--decisions`): the file's bytes per doc kind (W
  `doc_too_big` above 48 / 24 / 40 KB for an architecture / roadmap / proposal, E
  above 96 / 48 / 80 KB), the steps in a proposal (W `too_many_steps` above 12, E
  above 20) and the milestones in a roadmap (W `too_many_milestones` above 20).
  Only the doc given is measured. Each message names the size, the limit and the
  split. An error is a lint error like any other: `--lanes` gives the doc no lanes,
  `--roadmap` still reports progress (exit 1) and `--claude-md` reports it beside
  any drift. `--no-size-limits` (any mode) turns the checks off, for a doc written
  before them until it is split. The numbers and why:
  [PROPOSALS.md](PROPOSALS.md#size-budgets).
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
- **`--decisions`**: reads only, and prints
  `{doc, kind, decisions: [{id, n, title, line, by, date, ref}], unconfirmed, proposed: [{line, text}]}`:
  `unconfirmed` holds the decisions no person confirmed (`by` is `assumed` or `''`,
  a record with a malformed tag included), and `proposed` every line outside a code
  fence that contains `(proposed`, its text cut at 200 characters. It works on any
  kind (a roadmap has no decisions; its proposed values are listed) and never
  lints: it exits 0 on any doc it can read, so exit 0 does not mean the doc lints
  clean. The Lint stages of `brief-to-proposals` and `refresh-proposal` run it to
  fill `lint.unconfirmed` and `lint.proposed`. The tags and what each means:
  [PROPOSALS.md](PROPOSALS.md#who-decided).
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
`--roadmap`, `--tick` and `--decisions` always print JSON.

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
                                   // monitor-only modes: the branch's own plan, used when there is no plan_ref
  plan_ref: 'plans/feat-x.md',     // ship-only and monitor-only: the branch's plan on the state branch, as a build's
                                   // result gives it; restored into PLANS_DIR for /create-pr and the monitor
  dir: '/abs/path/to/checkout',    // work only here; in full and build-only modes with `branch`, created if absent as a
                                   // worktree on it (from origin/<last base>, else origin/<main_branch>); in ship-only
                                   // and monitor-only modes, recreated on `branch` from origin when absent
  repo: 'acme/app',                // GitHub owner/name: a missing dir is cloned from it when the checkout an agent starts
                                   // in is not this repository's; also the owner/name of connector calls
  github_access: '',               // 'gh' | 'connector'; '' = GITHUB_ACCESS, else gh when authenticated, else the connector
  branch: 'feat/...',
  replan: false,                   // true = plan again although an earlier run of this branch saved its plan (the new
                                   // plan is saved over it); default: the planner of a given branch continues from it
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
                                   // recommended option (in a conflict with what the person said, what the person
                                   // said) and list it in the result's assumptions
  answers: [{ id: 'plan.q1', question: '...', answer: '...', date: '2026-11-12' }],
                                   // answers to a needs_input result's questions, each with its question text and the
                                   // date the person gave it; <stage>.d<N> for an assumption the person corrected
                                   // (see Answering questions)
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

**Plans travel by reference.** The plan is saved to the
[state branch](#the-state-branch) twice
(`pipeline-state.py save <file> --as plans/<branch-slug>.md`, best effort: a failed
save stops nothing): by the planner when the planning skill has written it, and
again by the merge check, then ending with its `## Assumptions to review` section
(below). The result carries `plan_ref` (`''` when it was not saved), from the first
save on, so a run that stops at a later stage's question already has it.
A ship-only or monitor-only run given `plan_ref` reads it with `pipeline-state.py
get` and restores it into `PLANS_DIR` as `<branch without a leading feat/, fix/ or
refactor/>.md`, the name `/create-pr`'s and `/merge-main`'s own lookup reads. With
both `plan_ref` and `plan_text`, `plan_ref` wins and the text is the fallback when
the get fails. A ship-only run given only `plan_text` saves it at its merge check,
so its `resume_monitor` carries `plan_ref`.

**A re-run continues from the saved plan.** In full and build-only modes, a run
given `branch` (and no `plan_text`) first reads `plans/<branch-slug>.md`. It uses
that plan, and runs no planning skill, only when all three hold: the plan is there,
its `## Context` shows it is for the same work (the concern, or the proposal and
steps), and it contradicts no answer the run was given. So a run that stopped on an
`impl`, `fix`, `polish` or `merge_check` question does not plan a second time when
it is re-run from a session with no run record. A run that created its own branch
names that branch in the re-run (`branch`), as its relay says. `replan: true` plans
again and saves the new plan over the old one: pass it when the person's answer is
to plan the work again, or when the saved plan itself is what stopped `/impl` (a
`failed_at_impl` result whose plan stays saved says so in `hint`).

**Assumptions travel with the plan.** Each choice a stage made that its inputs did
not settle reaches every later stage of the run, which keeps it, never asks it
again and does not report it as a defect; a reason to change one is a blocking
question (for the reviewer, a concern that names the question). The plan the merge
check saves ends with `## Assumptions to review`: a line `- assumed (<stage>): …`
per assumption and a line `- answered (<id>[, <date>]): <question> -> <answer>` per
answer. `/create-pr` copies that section into the PR body, after the Deploy notes,
so the person can correct a line before merging; a ship-only run adds the lines of
the plan it restores, and when `pr_note` gives lines for the same section
(`bootstrap-repo`'s does) the body keeps one section that holds both. A later
ship-only or monitor-only run reads the `answered` lines as binding, like answers
given to it, and keeps the `assumed` ones; a change that would depart from either
(a reviewer's request, a conflict resolution, a CI fix) is a blocking question. The
optional `## Assumptions` section that `/plan` and `/bug-fix` write is another
heading: its bullets are the plan's own choices, kept the same way, and `/create-pr`
run by hand lists them as `- assumed (plan): …` when the plan has no
`## Assumptions to review`. `/impl` reads both sections the same way: it keeps a
bullet of `## Assumptions` and an `assumed` line, and treats an `answered` line as
what the person settled. `resume_monitor` carries the run's `answers`, so a
monitor-only re-run keeps what the person settled during the build.

**A missing checkout is recreated.** In ship-only and monitor-only modes, the first
agent that finds `dir` absent (a new container, a removed worktree) recreates it on
`branch` as it is on origin: a worktree added from the checkout the agent starts
in, when that is a checkout of this repository (the branch is fetched by explicit
refspec, so a single-branch clone works), else a fresh clone of `repo`. With
neither, it reports `error=checkout_missing`.

**GitHub access.** `github_access` is named in every prompt that touches GitHub
(planning, merge check, PR, observe, merge-main, process-comments, CI fix,
close-out). In connector mode the observe step reads the checks through MCP and
makes timed waits of about 2 minutes between reads. A step that cannot read the PR
at all (`github_unavailable`, `gh_unauthenticated`, `gh_auth_failed`,
`checkout_missing`) stops the monitor there.

**Kept out of every commit.** Every stage that commits (merge check, `/create-pr`,
`/merge-main`, `/process-comments`, the CI fix) stages by explicit path, never with
`git add -A`, `git add .` or `git commit -a`, and never stages `docs/brief.md`,
`docs/builder-context.md` or a file the plan or `/bootstrap`'s report lists as left
out. Those stay in the checkout, are no dirty tree to stop on, and are listed in the
result's `left_uncommitted`.

`bug-fix-backlog`: `{ lanes: [{ key, issues, branch?, dir? }], intake, labels, dir, root, date, ship, close, github_access, efforts: { intake, triage, verify, close }, ... }`.
`date` suffixes the default lane branch names (`bugfix/<key>-<issues>-<date>`;
default `undated`). `root` is required unless every lane gives its own `dir`
(default `<root>/fix-<issues>`, the issue numbers joined by `-`), and always with
the Intake. `ship` and
`close` default to true. With `close` true, an issue that triage and two
independent refuters find already fixed on main is closed in public, with a comment
quoting the evidence; `close: false` closes nothing and lists those issues in
`confirmed_fixed_unclosed`, with the close each would have got in `prepared_closes`
(`[{ number, close_reason, close_comment }]`), for the person to post. `efforts`
defaults to `{ intake: 'medium', triage: 'medium', verify: 'high', close: 'low' }`.

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
question, `intake.q1`, has the proposed lanes as its `recommended` answer (JSON),
and its `why` says what confirming them also allows, unless `close` is false: the
public closes above (the re-run takes `close: false` when the person wants such
issues only reported).
Re-run with the same args (still without `lanes`) plus
`answers: [{ id: 'intake.q1', answer }]`, where `answer` is the lanes the person
confirmed or edited, as a JSON array of `{ key, issues }` (`'[]'` runs nothing), or
the accept option exactly as offered, `accept <fingerprint> …`. The fingerprint names
the proposal the person saw: the re-run runs the Intake's proposal only if it has the
same fingerprint (a replay with `resumeFromRunId` does). A bare `accept`, or a
proposal that changed in between (issues regrouped, new ones opened), stops again
with `needs_input` and `accept_not_applied` (`no_fingerprint` / `proposal_changed`),
never building lanes nobody confirmed. Any other answer throws. The intake answer reaches no lane. `intake: false` without `lanes` throws.
Only `gate`, `main_branch`, `ai_review_check`, `commit_trailers`,
`max_review_rounds`, `max_polish`, `max_monitor_rounds`, `efforts` (the whole
object, so it may carry `plan-to-merged-pr`'s keys too), `on_question`,
`github_access` (when not `''`) and `ship: false` are passed through to
`plan-to-merged-pr`. Each lane's run also gets the verified plan as `plan_text`
(ending with `## Assumptions to review` when triage assumed anything) and a `pr_note`
naming the issues the PR fixes and those no failing test reproduced before the
fix. Triage's `/bug-fix --dry-run` asks nobody: a question it prints for the person
goes into that plan as an open choice (the question, why it blocks, its options and
the recommended one), no edit of the plan rests on it, and the lane's `impl` stage
returns it as a question. A lane's own question is not answered by re-running this
workflow ([Answering questions](#answering-questions)); an entry of `answers` other
than the Intake's (`[{ lane, id, answer, question?, date? }]`) is still passed on
to the lane it names. Lanes must not share a key, an issue, a `dir` or a `branch`.

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
  context: '...',                  // framing from the person, binding on every author: builder, budget, constraints the
                                   // source omits. On the point it addresses it replaces what the source says
  context_file: 'docs/builder-context.md',  // a file, relative to dir, every author reads as binding framing, like
                                   // context (/start-product writes this one). Never committed, and never saved by this
                                   // workflow. It must exist: a missing one is restored from the state branch
                                   // (context/builder-context.md, there only with the person's consent) and listed in
                                   // the checkout's local exclude file, else the run ends failed_at_start
                                   // (context_not_found). A file with a line starting
                                   // "- Not confirmed by me yet" was assumed by /start-product: the Intake returns
                                   // the framing as one confirmation
  from: 'proposals',               // brief mode: 'intake' | 'architecture' | 'proposals' | 'consistency' | 'lint'; default
                                   // inferred from the answers and the docs on disk (see Re-running a design run)
  branch: 'design/20261110',       // check this branch out before seeding and checkpoint the docs on it (never main)
  commit_trailers: ['Co-Authored-By: Claude <noreply@anthropic.com>'],  // lines each checkpoint commit ends with
  github_access: '',               // 'gh' | 'connector'; only the branch and checkpoint prompts reach the remote, with
                                   // plain git either way
  panel: 3,                        // independent architecture sketches judged before /roadmap; 0 = no panel
  milestones: [2, 4],              // propose exactly these milestones, written or not (default: every pending code
                                   // milestone; when the docs existed already, the ones not written yet). Answers
                                   // select none: a needs_input relay names the milestones that asked
  max_milestones: 1,               // propose at most the first N of those, in roadmap order (1 is recommended: later
                                   // proposals go stale as earlier milestones land; a re-run with from: 'proposals' writes
                                   // the next). 0 proposes none: the run stops after the reviewed architecture and
                                   // roadmap, and lints them, so the person can confirm them first
  force: false,                    // regenerate from scratch: /roadmap --force (never once a milestone is ticked); with
                                   // from: 'architecture', on the saved panel synthesis; never with a later from. A
                                   // re-run keeps force only until this run's /roadmap has written the docs (see
                                   // Re-running a design run)
  max_review_rounds: 3,            // revise rounds per doc
  efforts: { intake: 'medium', sketch: 'medium', judge: 'high', roadmap: 'high', propose: 'medium', review: 'high', revise: 'medium', consistency: 'high', lint: 'low' },
                                   // lint also sets the mechanical agents: branch, seed, existing-docs, context-check,
                                   // save-answers, save-panel, milestones and the checkpoints
  on_question: 'stop',             // 'stop' = blocking questions and confirmations end the run with needs_input before
                                   // anything is built on a guess. 'assume' = take each recommended option instead:
                                   // the Intake's and the judge's become shared answers for every later stage, each is
                                   // listed in assumptions, and the authors tag the decisions so taken (assumed)
  answers: [{ id: 'intake.q1', question: '...', answer: '...', date: '2026-11-12' }],
                                   // answers to a needs_input result's questions, each with its question text and the
                                   // date the person gave it; a decision made outside a question is passed the same
                                   // way, as intake.d<N> (architecture.d<N> or m<N>.d<K> for a correction to written
                                   // docs). See Answering questions
}
```

Apart from the Seed phase, which copies the pipeline's `.claude` files into `dir`
and writes or appends its base `CLAUDE.md`, it writes design docs only, never code.
Without `branch` it makes no commit and changes no git state. With `branch` it
checks that branch out before seeding (origin's when it exists, fast-forwarded to
it, else a new one from `origin/<MAIN_BRANCH>`; never main, and an empty remote
stops with `failed_at_branch`, `no_main`), first committing design docs an
interrupted run left changed on it, and after Architecture, Proposals and
Consistency commits the docs, the seeded `.claude` files and `CLAUDE.md` on it,
staged by explicit path (never the brief or the context file), and pushes it, never
forced. Each checkpoint is best effort and listed in `branch.checkpoints`. On a new
repository, the files ship in the bootstrap commit, or, with `branch`, land the
branch on `main` through a PR before `/bootstrap`, which cuts its branch from
`origin/main`; on an existing one, land them and the docs through an ordinary PR
(`/create-pr`). Every doc it writes is `Status: draft`. Each per-doc reviser edits only the doc(s) under review;
findings about any other doc are deferred to the Consistency phase. Concern mode
has no Consistency phase, so its result returns those as `deferred_findings`.

**Where it asks.** Every stage follows the rules under
[Answering questions](#answering-questions); four stages have a part of their own:

- **Intake.** It goes through the
  [person-owned choices](PROPOSALS.md#who-decided) class by class. For each class
  the source touches it either finds where the person settled it (the framing, an
  answer, a source the person wrote themselves) or returns it: a blocking question
  when the source is silent or states it two ways, a confirmation when the source
  was drafted for the person or the framing lists it as open. All of them come back
  in one `needs_input` batch, before any design is written. A framing
  `/start-product` assumed is in that batch as one confirmation, with *follow it as
  the file states it* recommended: its `why` gives the limits in the Intake's own
  words and never the file's text, since questions and answers are saved to the
  state branch (`/roadmap` and `/propose` run by hand ask it the same way). What
  the Intake takes as given beyond that is listed in `assumptions` and handed to
  every later author, who keeps each or returns a question to change it.
- **The panel's judge.** A decision the sketches chose differently, or a
  person-owned choice, that the source, the framing and the answers do not settle
  is marked OPEN in the synthesis and returned as a question (`architecture.q<N>`).
  The synthesis is saved first, and the run stops there (`resume_from:
  'architecture'`): the re-run builds on the saved synthesis, with no new panel.
  When that save failed, the run goes on and `/roadmap` carries the judge's
  questions, returning the ones still open with its own.
- **A resumed architecture.** A run that reviews existing docs (`from: 'intake'` or
  `'architecture'` with the docs on disk and no `force`) first applies the Intake's
  and the architecture's answers the docs do not yet reflect (stage
  `revise:architecture-answers`: `/propose --revise` on each of the two docs that
  needs it, tagging each decision an answer settles `(person, <date>, <id>)`), then
  runs the review loop. A change only the person can settle stops the run like any
  reviser's question.
- **Consistency.** A part of the brief no milestone plans or rules out (a coverage
  gap) is planned in a milestone. Leaving it out is the person's choice, so a
  reviser that would not plan it returns it as a blocking question (plan it in a
  milestone named by title, defer it past the first release, or drop it), every
  such gap in one batch. A part the framing or an answer already replaces or rules
  out is no gap.

**Answers are kept on the state branch.** In brief mode, a run given `answers`
saves every answer it holds to `design/answers.json`
(`{ source, answers: [{ id, stage, question, answer, date }] }`, `source` being the
brief's path) right after it has looked for existing docs (stage `save-answers`,
best effort); the result's `answers_saved` says whether that worked. Every
brief-mode run reads the file when its `source` names this brief and restores the
answers it was not passed: `answers_restored` lists their ids. Restored
answers reach every stage and never move the inferred start. An answer passed again
without its question takes it from the saved copy, and its date too when the answer
is unchanged. Concern mode saves its answers as `design/answers-concern.json`,
after the Intake; no run restores that file.

`proposal-build-chain` has two modes; `planner`, `gate`, `main_branch`,
`commit_trailers`, `max_review_rounds`, `max_polish`, `efforts`, `allow_draft`,
`on_question` and `github_access` (when not `''`) pass through to every lane in
both, and each of `answers` (`[{ lane, id, answer, question?, date? }]`) to the lane
it names only ([Answering questions](#answering-questions) says what one without a
lane does). `replan` is `true`, or
the keys of the lanes whose planner plans again instead of continuing from the plan
an earlier run saved (those lanes get `replan: true`; default: no lane).
`ai_review_check` and `required_checks` are not used to build: derive mode copies
them, with `main_branch`, `gate`, `commit_trailers` and `github_access`, into each
`ship_plan` entry's args, beside the lane's `plan_ref` and `repo` (origin's
owner/name, which the derive agent reports).

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
  max_wait_rounds: 48,             // wait rounds per PR, each polling up to ~30 minutes, before stopping with not_merged;
                                   // a round that leaves the PR open and needing action re-runs the lane's monitor
  main_branch: 'main', ai_review_check: '', required_checks: [], gate: '', commit_trailers: [...],
  max_monitor_rounds: 10, efforts: {...}, on_question: 'stop',
                                   // shared ship settings: each one given overrides the lanes' own args
  github_access: '',               // 'gh' | 'connector' | '': default each lane's own (the ship plan's); given, it
                                   // overrides them; reaches the lookup, the wait and every lane's run
  repo: 'acme/app',                // default each lane's own: a missing lane checkout is cloned from it
  answers: [{ lane: 's2', id: 'merge_check.q1', question: '...', answer: '...', date: '2026-11-12' }],
                                   // each to its own lane only
}
```

Per lane, a read-only agent first looks for a PR from the lane's branch to
`main_branch` (`gh pr list --head <branch> --state all`). A `MERGED` one is skipped
and counts as merged; a `CLOSED` one stops the chain; an `OPEN` one (an earlier run
opened it) is monitored with `plan-to-merged-pr` monitor-only mode, never opened
twice; an `OPEN` draft (`isDraft`) instead runs ship-only with `existing_pr`, which
checks `predecessor_prs` merged, then readies it, since a draft cannot be merged. With none, the lane runs `plan-to-merged-pr { ship_only: true }` with its
`title` (a placeholder, empty or `<...>`, is written from the lane's proposal steps,
`steps` or the numbers in the placeholder, else from the branch's commits) and
`predecessor_prs` (placeholders replaced by the merged PR numbers of the lanes
above; numbers already given are kept). A run that ends `OPEN` is then waited on:
an agent polls `gh pr view <n> --json state` with the Monitor tool until it reads
`MERGED` or `CLOSED`. A wait round that ends with the PR still open and needing
action from the pipeline (a person's review thread or comment with no reply after
it, requested changes, a conflict with its base, a red check) re-runs the lane's
monitor (`plan-to-merged-pr` monitor-only), at most three times per lane; past
that the wait only reports what holds the PR, in `wait_notes`. A PR that only waits
for a person to merge it, a pending check and a draft need no such run. No stage
merges, approves, closes or edits a PR, or enables
auto-merge; the next lane's PR is opened only once the one below has merged. Once
the last lane's PR has merged, a lane given `proposal` gets the close-out check: the
`closeout` of the last lane's own run when its monitor saw the merge, else one
`plan-to-merged-pr` monitor-only round on that PR (`max_monitor_rounds: 1`), which
sees it `MERGED` and runs the check. A lane checkout that does not exist (a new
container) is recreated on its branch from origin by the lookup, or from a fresh
clone of `repo`. In connector mode the wait reads the PR through the GitHub MCP
tools and makes timed waits of about 3 minutes between reads. A lookup or wait that
cannot read GitHub stops the chain with `lane_failed`.

`bootstrap-repo`:

```js
{
  architecture: 'docs/design/architecture.md',  // required: the accepted architecture doc, relative to dir
  dir: '/abs/path/to/repo',        // required: a clean clone with origin, seeded, its design docs accepted and on main
  ship: true,                      // false = bootstrap only: next_steps carry the plan-to-merged-pr ship-only args
  title: 'Bootstrap repository',   // the bootstrap PR's title
  main_branch: 'main', ai_review_check: '', github_access: '', gate: '', commit_trailers: [...], on_question: 'stop',
                                   // passed to plan-to-merged-pr for the ship; github_access, gate and
                                   // commit_trailers reach the /bootstrap stage too
  efforts: { bootstrap: 'medium' },  // the /bootstrap stage's effort; other keys go to plan-to-merged-pr
  answers: [{ id: 'bootstrap.q1', question: '...', answer: '...', date: '2026-11-12' }],
                                   // also bootstrap.d<N>, and a design run's answers passed on (intake.d<N>, ...)
}
```

The bootstrap stage asks before its first write. `/bootstrap` collects every
blocking question once its checks have passed: the copyright holder, when it writes
a `LICENSE` whose text has a holder line and no Decision or answer names one; an
existing `LICENSE` of another licence than the architecture's licence Decision; the
licence, when there is neither a Decision nor a file; a published name no Decision
settles; and, as confirmations, each Decision the skeleton bakes in (a name, the
licence, a namespace, an org or bundle id) that the architecture tags `(assumed)`
or leaves untagged, since accepting the doc did not confirm it. The skeleton is
built on what the person answers, and the architecture still has to record it:
`/bootstrap` never edits the doc, its report names each such Decision under
**Answers**, and a `refresh-proposal` run on the architecture with that answer (or
`/propose --revise`) tags it `(person, …)`. With `on_question: 'assume'` such a
Decision is built on as the doc states it and listed in `assumptions`. A stop
before the first write leaves no branch and no file. A question that surfaces only
after the first write (the install or a gate shows a `(person, …)` Decision cannot
hold as written) stops the run with nothing committed and the files kept on the
unfinished `bootstrap/<date>` branch, which `bootstrap.branch` names and the re-run
resumes on. What the skeleton
bakes in waits on no gate: `/roadmap` asks the person the name and the licence and
records each in a D-record. `/bootstrap` stops with `bootstrap_gates_pending` only
while a gate the Bootstrap gate depends on (for what needs an outside party or an
account) is unticked, and with `architecture_outdated` when a ticked gate's
`Outcome:` names another name, licence, namespace or id than the architecture
states (`/propose --revise <architecture>`, re-accept, re-run).

`/bootstrap` always integrates into `main`; `main_branch` only reaches the ship run.
Leave `ai_review_check` unset on a new repository unless a review app already posts
that check: the example AI review workflow is installed after the bootstrap PR
merges, and a check that never registers keeps the monitor from settling. The ship
run gets exactly `{ ship_only: true, branch: '<bootstrap/date>', title, dir }` plus
those of the settings above that were given, every answer, and, when the bootstrap
stage reported assumptions, a `pr_note` that puts them in the PR body under
`## Assumptions to review`, in the one section the ship run's own lines go to. Only
a `bootstrap/<date>` branch that holds a bootstrap commit (trailer
`Bootstrapped-by: /bootstrap`) is ever shipped. `github_access` is `'gh'`,
`'connector'` or unset (any other value throws).

`refresh-proposal`:

```js
{
  doc: 'docs/design/03-export.md', // required: a proposal, architecture.md or roadmap.md, relative to dir
  dir: '/abs/path/to/checkout',    // required: the checkout the doc is judged against, up to date with main
  roadmap: false,                  // true = /review-proposal --roadmap: also against the whole roadmap; it reads every
                                   // proposal the roadmap names, so it costs more
  context: '...',                  // framing from the person for the reviewer and the reviser, as brief-to-proposals' context
  context_file: 'docs/builder-context.md',  // as brief-to-proposals' context_file: read as binding, never edited; a missing
                                   // one is restored from the state branch, else the run ends failed (context_not_found)
  max_review_rounds: 3,            // revise rounds; 0 = review only
  efforts: { review: 'high', revise: 'medium', lint: 'low' },
  on_question: 'stop',             // 'assume' = take each recommended option, tag it (assumed) in the doc and list it
  answers: [{ id: 'revise.q1', question: '...', answer: '...', date: '2026-11-12' }],
                                   // also revise.d<N>: an assumption the person corrected, or a decision they made
                                   // outside the questions
}
```

It edits only `doc` (the commands keep their review ledger, with its copy on the
state branch), and never commits, fetches or switches. Suggestions and nits get one
revise round. Every review and revise reads the framing (`context`,
`context_file`) as binding, as a design run's stages do. The first review is the
stage that finds a missing `context_file`: it restores the file from the state
branch (`context/builder-context.md`) and lists it in the checkout's local exclude
file, and when the restore fails it reviews nothing and the run ends `failed`, its
`stop_reason` starting `context_not_found:`. Every review and revise also reads the
answers the person gave the design run, when `brief-to-proposals` saved them
(`design/answers.json` on the state branch): they bind the doc like the answers
passed here, and where the two settle one point differently the one passed here is
the newer and holds. A reviewer reports a doc that departs from the framing, an
answer or a decision tagged `(person, …)` as a bug whose fix is the question to
ask, and an answer passed to this run that the doc does not yet reflect as a bug
the reviser applies, tagging the decision it settles `(person, <date>, <id>)`. It
reports a person-owned decision tagged `(assumed)`, or `(source)` when the source
was drafted for the person, as a concern whose fix is the question to ask; with
`on_question: 'assume'` a decision tagged `(assumed)` is no defect. The lint stage
runs `--lanes --allow-draft` on a proposal, `--roadmap` on a roadmap, `--claude-md`
on a bootstrapped architecture and `--decisions` on any kind, and reports how far
the checkout is behind origin's main branch as last fetched, so a review grounded
in a stale tree is flagged in the next steps.

## Result statuses

Every result carries a `status`.

`plan-to-merged-pr`:

- `pushed` (build-only)
- `needs_input` — a stage (`stage`: `plan`, `impl`, `fix`, `polish`, `merge_check` or `monitor`) hit questions only the person can answer and stopped there, changing nothing further; `questions` lists them and `relay` says what to do (see [Answering questions](#answering-questions)). A `monitor` question comes from `/merge-main` (a conflict that is the person's call), from `/process-comments` (a reviewer's request that contradicts the plan, the design doc or an answer, or an item whose fix is a product or trade-off choice neither settles: every other item is handled, and that thread gets no reply, so the re-run still finds it) or from the CI fix (neither the plan nor the design doc says whether the test or the code is right)
- `failed_at_plan`, `failed_at_impl` (with `hint` when its plan stays saved: a re-run continues from that plan unless it passes `replan: true`)
- `review_failed`, `blocked_at_review` (also in ship-only, after a conflicted merge)
- `blocked_at_predecessors`
- `failed_at_merge_check`, `blocked_at_merge_check`
- `failed_at_push`, `blocked_at_pr`
- after monitoring: the PR's last state (`OPEN` / `MERGED` / `CLOSED`), or `monitor_failed`; an observe step that cannot read the PR at all (`error=github_unavailable`, `gh_unauthenticated`, `gh_auth_failed`, `checkout_missing`) stops the monitor at once, `OPEN` when an earlier round observed it, else `monitor_failed`

Every result also carries `assumptions`: each choice a stage made that its inputs
did not settle, as `{ stage, assumption }`; `plan_ref`, the plan's path on the
state branch (`''` when it was not saved); `plan`, whose text ends with its
`## Assumptions to review` section once there is an assumption or an answer; and,
when there are any, `left_uncommitted` (files a committing stage kept out),
`declined` (review findings the fixer judged wrong: `[{ round, finding, reason }]`)
and `polish_unfixed` (bugs and concerns the last polish round left unfixed:
`[{ file, severity, description }]`; `polish_clean` is then false).

After monitoring, the result also carries:

- `resume_monitor` and `handoff`, when the monitor hands off a PR that is still
  open (`OPEN`: settled, the `max_monitor_rounds` cap hit, or red CI outside the
  PR; or `monitor_failed`). `resume_monitor` is the exact monitor-only args,
  `{ pr, branch, dir?, plan_ref? }` (`plan_text` instead, only when the plan was
  never saved) plus whichever of `proposal`, `main_branch`, `ai_review_check`,
  `required_checks`, `gate`, `commit_trailers`, `efforts`, `on_question`,
  `github_access`, `repo`, `max_monitor_rounds` and `answers` the run was given;
  `handoff` is one line saying why it stopped and how to re-run it. A `needs_input`
  result from the `monitor` stage carries `resume_monitor` too: its new answers are
  added to the `answers` in it.
- `closeout`, when the run was given `proposal` and the PR reads `MERGED`. One
  read-only agent (`efforts.closeout`, default low) lints the proposal as it is on
  `origin/<main_branch>` (`proposal-lint.py --json`), and `--roadmap` on the
  roadmap its `Source:` names, when that resolves. Every step ticked gives
  `{ proposal_complete: true, edits, next_milestone, roadmap, milestone }`: `edits` lists
  `{ file, line, before, after }` for the `Status:` → `Status: done` change and
  the milestone's `[ ]` → `[x]` tick (an `- Outcome:` line too, only when the
  milestone is a human gate: on a code milestone it is W `outcome_on_code_step`),
  each left out when already made; `next_milestone` is `--roadmap`'s `next`, as
  `[{ n, title }]` (empty without a roadmap); `milestone` is the one the person
  ticks, `{ n, title, acceptance }`, with the `Acceptance:` they check first (null
  when no roadmap resolved). Steps left give
  `{ proposal_complete: false, pending_steps, pending }`, `pending` naming each
  unticked step as `{ n, title, human_gate }` (`human_gate` the gate's text, `''`
  for a code step). The run never makes these edits:
  a person does, in a docs PR. No `closeout` means the check could not run (the
  log says why).

`proposal-build-chain`, explicit mode: an array of `{ lane, branch, steps, status, result }`,
one per lane attempted, `status` being the lane's `plan-to-merged-pr` status (or
`failed`) and `result` slim, as in derive mode (below); a `needs_input` lane also carries `questions` (each with its `lane`) and
`relay`. There is no ship plan in explicit mode, so a lane that pushed with `plan_ref` `''`
(its plan could not be saved) also carries `plan_text` in its `result`: the fallback
derive mode's `ship_plan` gives it, for the ship-only run that opens its PR. Derive mode: `{ status, assumptions, proposal, source, chains, blocked, human_gates_pending, milestone_waits, ship_plan }`, where `assumptions` lists what the lanes this run built assumed, as `[{ lane, stage, assumption }]` (each lane's PR body lists its own once it is shipped), and `status` is:

- `pushed` — every lane is pushed or `already_built`
- `needs_input` — some lane stopped with `needs_input` (its chain stopped there; other chains carried on); `questions` lists every lane's questions, each with its `lane`, and `relay` says what to do
- `partial` — some lane did not push; its chain stopped there (`not_built` lists the rest), other chains carried on
- `all_blocked` — no lane can build: each waits on a gate, another doc, a milestone (or an unresolvable `Source:` milestone) or acceptance (see `blocked`)
- `nothing_to_build` — no pending code step
- `proposal_lint_errors` — the doc has lint errors (listed), a size budget's error limit included; fix or split it before building
- `proposal_not_on_main` — the doc is only in the working copy; land it through a docs PR first (a `preview` of its lanes is included)
- `failed_at_derive` — the derive agent failed or did not return the script's JSON

Each chain lists its lanes with a per-lane status (a `plan-to-merged-pr` status,
`already_built` or `failed`). Each lane's `result` is slim and never holds the plan
text: `{ status, branch, plan_ref, review_clean, polish_clean, assumptions }`, with
`questions`, `left_uncommitted`, `declined` and `polish_unfixed` when it has them,
and on a lane that did not push what stopped it (`stage`, `stop_reason`,
`blocked_reason`, `review_findings`, and `hint`: how to plan the lane again,
`replan: ['<its key>']`, when its saved plan is what stopped it).
`ship_plan` gives, per chain in merge order, the `ship_only` args for each built
lane (`branch`, `dir`, `proposal`, its `plan_ref` (`plan_text` instead only when the
lane's save failed; an `already_built` lane gets the `plan_ref` its earlier run
saved to), `repo`, the `main_branch`, `ai_review_check`, `required_checks`, `gate`,
`commit_trailers` and `github_access` given to the chain, and `predecessor_prs`
placeholders for every lane after the first). Each `order` entry also lists the
lane's `steps`, and each chain carries `ship_chain_args`, `{ chain }` for
`ship-chain`.

`ship-chain`: `{ status, chain, lanes, merged_prs, stopped_at?, not_shipped, questions?, relay?, closeout? }`.
`lanes` lists each lane reached, `{ lane, branch, title, pr, status, result }`, its
`result` a slim child result, `{ status, stage, pr, final_state, handoff, closeout,
reason, review_findings, assumptions, left_uncommitted }` (each only when present;
`final_state` the PR's last observation: `pr_state`, `head_sha`, `ci_state`,
`ai_review_done_on_head`, `actionable_comments`, `has_conflicts`, `behind_main`;
`reason` one line saying what stopped the run; `review_findings` the blocking ones,
one line each), and its
`status` the PR's last state (`MERGED`, `OPEN`, `CLOSED`) or the lane's
`plan-to-merged-pr` status (`failed` when it threw or returned nothing;
`lookup_failed` when its lookup did not report or could not run),
`already_merged` on a lane skipped because its PR had merged, `wait_notes` on
one the wait saw held up (what held it), and `re_monitored` (how many times) on
one whose monitor the wait ran again: its `result` is then that of the latest run,
keeping the `assumptions` and `left_uncommitted` of the runs before it.
`merged_prs` are the chain's merged PRs in order;
`stopped_at` names the lane the run stopped at and why (the lane's `reason`, and
the number of blocking findings, when its run stopped); `not_shipped` lists the
lanes never reached; `closeout`, on a `merged` run whose lanes name a `proposal`, is
`plan-to-merged-pr`'s (above), for the last lane's PR: whether the proposal is now
complete on `main` and the edits a person makes. `status` is:

- `merged` — every lane's PR reads `MERGED`
- `needs_input` — a lane's run stopped with `needs_input`, its ship run or a monitor the wait ran again; `questions` lists them, each with its `lane`, and `relay` says what to do
- `closed` — a lane's PR was closed without merging (by a person, or before this run)
- `not_merged` — a lane's PR is still open after `max_wait_rounds`; `stopped_at.reason` carries what holds it (conflicts, red checks, review comments) and how many times its monitor was run again. Merge it (or act on it) and re-run with the same args
- `lane_failed` — a lane's lookup did not report or could not run (`error=github_unavailable`, `checkout_missing`, ...), its PR could not be read while waiting for its merge, or its `plan-to-merged-pr` run ended with any other status (`blocked_at_predecessors`, `blocked_at_merge_check`, `blocked_at_pr`, `monitor_failed`, ...); `stopped_at.reason` names it

`brief-to-proposals`:

- `needs_input` — blocking questions and confirmations (`confirm: true`) only the person can answer: from the Intake (no design written yet), the panel's judge (the synthesis is saved, no doc written), `/roadmap`, the stage that applies answers to existing docs or the architecture's reviser (no proposal written), a milestone's author or reviser (that milestone waits, the others finish, and the Consistency phase is skipped), or a consistency reviser; `questions` lists them and `relay` says what to do; in brief mode `resume_from` names the stage to re-run from (`intake`, `architecture`, `proposals` or `consistency`: the earliest among the questions), and for a milestone's question the relay also names the `milestones` to pass (every milestone that asked, and every one whose `/propose` wrote nothing). The status hides a sibling milestone that failed or did not come back clean, so `also_needs_attention` lists each one, `{ milestone, doc, reason }`: answering the questions fixes none of them, the re-run the relay names writes the proposals that failed and keeps the others, and `refresh-proposal` revises one that still has findings
- `ready` — every doc lints clean, every proposal's lane preview has no errors, every proposal's review came back clean, and the Consistency phase (brief mode) reported, revised every affected doc and got each revised doc back clean from its re-review; after `from: 'consistency'` or `'lint'`, the stages this run ran came out clean
- `proposals_need_attention` — a proposal was not written (listed `failed`, with its `stop_reason` when `/propose` stopped or routed the work elsewhere), its review did not finish, or it still has a `bug` or `concern` after `max_review_rounds` (`findings_remaining`); or a consistency pair failed to report (the other pairs' findings are still revised), a consistency revision failed, a revised doc did not come back clean from its re-review, or a finding named a doc this run did not write (`consistency.unrouted`)
- `lint_errors` — a doc still has lint errors (a size budget's error limit included), or a proposal's lane preview (`--lanes --allow-draft`, e.g. `lane_cycle`) has errors; `lint_failed` — the lint stage did not report
- `blocked_at_architecture_review` — architecture.md or roadmap.md still has a `bug` or `concern` after `max_review_rounds`; no proposal was written; `resume_from: 'architecture'`. What happens to those findings is the person's choice: `relay` says to show them `architecture_review.findings_remaining` and the `assumptions`, with the ways forward `next_steps` lists: another pass (`from: 'architecture'` and a higher `max_review_rounds`), answering the findings that are theirs (each passed back as `architecture.d<N>`, the finding as its question, then `from: 'architecture'`), or going on with `from: 'proposals'`, accepting the findings that remain
- `review_failed` — a review or revise stage of the architecture failed to report; `resume_from: 'architecture'` (an inferred re-run would start at `proposals`)
- `failed_at_branch` — with `branch`, the design branch could not be checked out (`not_a_repo`, `no_remote`, `invalid_branch`, `branch_is_main`, `no_main`: a remote with no `main`, so push a first commit to it, `diverged`, `switch_blocked`); `stop_reason` names it, and the result carries `branch`
- `failed_at_seed` — `/seed` stopped (`no_source`: pass `pipeline`; `not_a_repo`, `no_remote`, `dirty_tree`: tracked changes outside `.claude/` and `CLAUDE.md`); `stop_reason` quotes it, and the result carries nothing else (with `branch`, `branch`)
- `failed_at_start` — before the Intake. Brief mode: `brief_not_found` (the checkpoints never commit the brief: copy it into the checkout), `partial_docs` (only one of `architecture.md` and `roadmap.md`; `force` regenerates both), `no_docs` (`from` past `architecture` without the docs), or the existing-docs stage did not report. Either mode: `context_not_found` (`context_file` does not exist and the state branch holds no `context/builder-context.md` to restore it from: copy it back or rewrite it with the person; concern mode checks it in a stage of its own, `context-check`). `stop_reason` says which
- `failed_at_roadmap` — `/roadmap` stopped or did not finish (e.g. `error=exists`: pass `force`, or revise instead); `stop_reason` quotes it
- `failed_at_propose` — concern mode: `/propose` stopped, routed the work elsewhere (e.g. to `/plan`) or did not finish; `stop_reason` quotes it

Every result past the Intake carries `assumptions`. `failed_at_start`,
`failed_at_roadmap` and every status the Lint phase sets (`ready`,
`proposals_need_attention`, `lint_errors`, `lint_failed`) also carry `seeded`: what
was copied, kept and written; `review_failed`, `blocked_at_architecture_review` and
`failed_at_propose` do not. When the Seed phase installed anything, the session
that ran the workflow loaded none of it: a `needs_input` relay, else a next step,
tells it to read the `How work happens here` section of the repository's
`CLAUDE.md` now and to start every other workflow from a new session there (a
re-run of this one can stay). In brief mode, every result past the start carries
`from`, the stage the run started at. Every result past the Seed phase carries
`answers_saved` (true or false) when the run was given answers and had reached the
stage that saves them, and `answers_restored` (the ids) when it restored any
([Workflow args](#workflow-args)). With `branch`, every result carries
`branch: { name, action, recovered, checkpoints }`: `action` is `created`,
`continued` or `current`, `recovered` the changed design docs committed before the
run, and each checkpoint `{ after, committed, commit, pushed, files, reason }`. The
Lint-phase result also carries the doc paths, `panel` (`{ winner, scores, saved }`,
`{ reused: true }` when the saved synthesis was used, or null), each doc's review
outcome, `kept` (the proposals kept from an earlier run, `{ milestone, title, doc }`,
consistency-checked and linted but not re-reviewed), the consistency findings (each
with its `pair`), `consistency.pairs` (`{ key, docs, findings, failed }`), revisions
and re-reviews, the lint and lane summary, and `next_steps`. `lint` also lists what
no person confirmed, read with `--decisions` from the architecture, the roadmap and
each proposal: `lint.unconfirmed`, the decisions tagged `(assumed)` or untagged
(`{ doc, id, title, by }`), and `lint.proposed`, the values an author proposed
(`{ doc, line, text }`). When there are any, or any `assumptions`, a next step says
to show all three to the person before a doc is accepted, and how a correction
comes back: as an answer (`architecture.d<N>`, or `m<N>.d<K>` with
`milestones: [N]`, its question naming the decision by title) with `from` set to
that stage, or through `refresh-proposal` on the one doc; the revise tags the
decision `(person, <date>)`. Deferred findings
(`architecture_review.deferred`, concern mode's `deferred_findings`) carry
`raised_by`, the docs under review. A review that reports only suggestions and nits is clean
once a revise round has run, or once `max_review_rounds` is reached.

`bug-fix-backlog`: a run that stops at the Intake returns one object, not an array:

- `needs_input` — `stage: 'intake'`, `questions` (the one `intake.q1`), `relay`,
  `labels`, `proposed_lanes` (each `{ key, issues, code_site, why }`), `unlaned`
  (`{ number, reason }`), `ci_red` (`{ workflow, url, sha, conclusion,
  failing_jobs, summary, tracked_by }`, report only) and `issues` (each listed
  issue with its `code_sites`)
- `failed_at_intake` — the Intake failed to report (nothing else), or could reach
  GitHub through neither access: `{ status: 'failed_at_intake', error: 'github_unavailable' }`

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
  their file held work from before the run), and, when that run has them, `stage`,
  `reason` (one line: what stopped it), `review_findings` (the blocking ones, one
  line each), `declined`, `polish_unfixed`, `plan_ref`, `handoff`, `resume_monitor`
  and `left_uncommitted`. A lane whose run ended before its PR was open (any status
  but `pushed`, `OPEN`, `MERGED` or `CLOSED`, with no `resume_monitor`) carries
  `resume_args`, the args that run was given (the verified plan as `plan_text`). A
  `needs_input` lane also carries `questions` (each with its `lane`) and `relay`
- `failed` — also a lane that failed outright: `{ lane, status }` only

Every entry past triage also lists `branch`, `dir`, `closed`, `not_closed`,
`confirmed_fixed_unclosed` (filled only with `close: false`, which also adds
`prepared_closes`), `needs_human`, `skipped`, `bugs` and `assumptions`
(`[{ stage, assumption }]`: triage's, as stage `triage`, then those of the lane's
run; the lane's PR body lists them too).

A lane's run that stopped is never continued by re-running `bug-fix-backlog`: its
triage would judge the kept worktree, which now holds the fix, or skip the issue
once the lane's own PR is open. Run `plan-to-merged-pr` with the lane's
`resume_args`, or, once its PR is open, with its `resume_monitor` (monitor-only),
adding the answers when it asked.

`bootstrap-repo`: `{ status, bootstrap, ship?, next_steps, assumptions, questions?, relay?, stop_reason? }`.
`bootstrap` is `{ outcome, root_mode, branch, commit, merged?, summary, left_out, stop_reason? }`
(`outcome`: `committed`, `already_bootstrapped` or `stopped`; `left_out`: the files
the commit left out on purpose, such as the brief). `ship` is the ship run's result,
slimmed to `{ status, stage?, pr?, final_state?, handoff?, resume_monitor?, reason?, review_findings? }`:
`final_state` is one line (state, head, CI, actionable comments), `reason` the
blocked or stop reason, `review_findings` the blocking ones, one line each.
`next_steps` starts with what this run leaves (merge the PR, push `main`, ship the
commit) and goes on with `/bootstrap`'s own. `assumptions` (`[{ stage, assumption }]`)
holds the bootstrap stage's, every line of `/bootstrap`'s report under
**Assumptions** included, and the ship run's as stage `ship.<its stage>`. The
bootstrap stage's also reach the PR body (`## Assumptions to review`) and the
commit's body, and the first next step says to show them to the person before the
merge (in root mode, before the push). `status` is:

- `pr_open` — the bootstrap PR is open and handed off (`plan-to-merged-pr` `OPEN`, or `monitor_failed`): review and merge it; `ship.resume_monitor` re-runs its monitor
- `merged` — the PR merged while the monitor watched it
- `closed` — the PR was closed without merging; reopen it, or re-run (a new PR is opened from the same branch)
- `ship_failed` — the ship run ended with any other status (`blocked_at_merge_check`, `blocked_at_pr`, `review_failed`, ...) or threw; `ship.status` and `ship.reason` say why, and the next steps give the args to ship again
- `committed` — `ship: false`: the commit is on its branch; the next steps give the ship-only args
- `root_commit` — the remote was empty: the root commit is on local `main`, nothing was shipped, and the first next step is the push you make by hand
- `already_bootstrapped` — the bootstrap commit (trailer `Bootstrapped-by: /bootstrap`) is already on `main`; nothing ran but the check. A bootstrap branch that holds the commit and still waits for its PR is shipped instead; a `bootstrap/<date>` branch with no bootstrap commit is an unfinished run, which `/bootstrap` resumes
- `failed_at_bootstrap` — `/bootstrap` stopped (`stop_reason` quotes its `error=`, and the next steps are the action it names), the stage did not report, it reported an earlier bootstrap with no bootstrap commit, or it reported a branch other than `bootstrap/<date>` (nothing is shipped)
- `needs_input` — the bootstrap stage (`bootstrap.q<N>`) or the ship run (`merge_check.q<N>`, `monitor.q<N>`) asked; `questions` and `relay`. From the bootstrap stage nothing is committed, and nothing was written unless `bootstrap.branch` names the unfinished branch that holds its files; a question from the ship run's monitor is answered in monitor-only mode (`ship.resume_monitor`)

`refresh-proposal`: `{ status, doc, doc_status, rounds, revisions, findings_remaining, other_docs?, lint, assumptions, next_steps, questions?, relay?, stop_reason? }`.
`rounds` counts reviews, `revisions` the revise rounds applied.
`findings_remaining` is one line per finding, `<severity>: <description>`, lint
errors first as `bug: lint: ...`, at most 20 plus a line counting the rest
(`/review-proposal`'s ledger holds them all); after `clean` it holds the
suggestions and nits left. `other_docs` lists findings that name another doc, which
are never applied here. `lint` is
`{ errors, warnings, lanes?, claude_md_drift?, unconfirmed?, proposed? }`
(`lanes`, for a proposal: `{ chains, lanes, blocked, human_gates_pending, errors }`;
`unconfirmed`, the decisions tagged `(assumed)` or untagged, and `proposed`, the
values an author proposed, each one line per item, at most 20 plus a line counting
the rest), or null when the lint did not run. The next steps say to show the
person the `assumptions`, `lint.unconfirmed` and `lint.proposed` before the doc is
accepted (a confirmation or a correction comes back as `revise.d<N>`, its question
naming the decision by title), to re-accept a revised doc (a
revise resets `Status:` to draft) and land it through a docs PR, to copy any
drifted `CLAUDE.md` section in the same PR, and, for a clean proposal, how to build
it. `status` is:

- `clean` — no `bug` or `concern` remains and the lint has no errors
- `findings_remain` — a `bug` or `concern` still stands after `max_review_rounds` revisions, or the lint reports errors (including `--lanes` errors such as `lane_cycle`)
- `needs_input` — a reviser hit a finding only the person can settle, or a confirmation (`confirm: true`); it changed nothing, and earlier revisions stay
- `failed` — a review did not complete (`stop_reason` quotes `/review-proposal`'s `error=`, or `context_not_found` when `context_file` is missing and could not be restored), or a revise or the lint stage did not report

## Answering questions

Where and how often the person is asked across the whole flow, and how to run
without being asked, is listed in one place, the README's
[When you are asked](../README.md#when-you-are-asked). This section is the contract
behind it.

A **blocking question** is one only the person can answer: what they intend, a
requirement or constraint the brief, concern, plan or design doc leaves out or
states two incompatible ways, a trade-off that is theirs, a conflict between what
the person said and the source, the tree or an agent's research, or a blocker whose
way forward is their call, where the plausible answers lead to a different design,
promise, cost or legal exposure. A **confirmation** is a question about a
[person-owned choice](PROPOSALS.md#who-decided) that already has a value nobody
confirmed with the person: the source's value when the source was drafted for the
person, an item the framing or a panel synthesis lists as open, recommended or not
yet decided, or the default the author would otherwise take. It is asked in the
same batch as the blocking questions, with that value as the recommended option.
Anything the tree, `CLAUDE.md`, the docs or desk research can settle is settled,
not asked, and so is a choice inside a component that an invariant, a recorded
decision or an official doc settles. A choice the person can make now is a
question, never a gate; data a person must gather stays a `research` gate, and a
choice that waits on evidence the plan produces stays a `decision` gate
([PROPOSALS.md](PROPOSALS.md#human-gates)).

**What the person said outranks the source.** The framing (`context`,
`context_file`), an answer, and a decision a doc tags `(person, …)` bind every
stage. On the point it addresses, what the person said replaces the source's value:
the author follows it, says so in the doc and never asks it again. A stage asks
only where another part of the source, the tree or its research makes what the
person said impossible to follow; it then names both and picks no side. What the
person settled changes only on a newer answer from them: a reviewer reports a doc
or a change that departs from it as a `bug` whose fix is the question to ask. A
`new-software-idea` brief (its header has `**Verdict:**` and `**Assumed builder:**`
fields) is drafted for the person by a skill that never interviews them. Its price,
licence, platforms and names are that skill's defaults, never the person's
confirmed requirements, so each person-owned one is asked as a confirmation. Any
other source counts as the person's own writing. `/roadmap` weighs each decision's
options against the framing and the answers where they speak, and against the
source's builder, budget and timeline where they are silent.

Run interactively, a command asks every such question at once, each with options
and a recommendation, and waits: `/start-product`, `/roadmap`, `/propose`, `/plan`,
`/impl`, `/bug-fix`, `/polish`, `/process-comments`, `/quality-gates`,
`/merge-main` and `/bootstrap`. With no one to answer, each stops with
`error=needs_input` and prints its questions; told to proceed on assumptions, it
takes each recommended option and lists it under **Assumptions**, except a question
about departing from what the person settled, which stays open with what the person
said kept. Three of them ask in a way of their own:

- `/polish` asks before its first fix: a fix that changes observable behaviour the
  plan and the design doc do not call for, a concern that is a product or trade-off
  choice neither settles, a finding whose fix would change what the person settled,
  and a ledger finding the review recorded as a question for the person. A gate
  that fails three times on the same root cause is asked where it happens.
- `/process-comments` gives an item `verdict=needs-person`, and neither applies nor
  declines it, when a human request contradicts the plan, the design doc or what the
  person settled, when its fix is a product or trade-off choice neither settles, or
  when a confirmed defect's only fix would change what the person settled.
  Unattended, it handles every other item, posts no reply on that one, and ends
  with `error=needs_input`, so the next run still finds the item and reaches it
  with the answer. A thread that already has a terminal reply is eligible again
  once a person replies after it, asking for a change or asking a question.
- `/quality-gates`, and the monitor's CI fix, never get green by changing what a
  test asserts, a CI workflow, a required check or the `QUALITY_GATES` line unless
  the plan or the design doc calls for that change. When neither says whether the
  test or the code is right, that is the question, naming the test, what it asserts
  and the two readings.

Inside a workflow no one can answer mid-run, so the stage stops and the workflow
returns `status: 'needs_input'` with:

```js
questions: [{ id: 'plan.q1', stage: 'plan', question: '...', why: 'what changes with the answer',
              options: ['...', '...'], recommended: '...' }],
              // a lane workflow adds lane: '<key>'; brief-to-proposals and refresh-proposal add
              // confirm: true on a confirmation, whose recommended option is the unconfirmed value
relay: 'Ask the person these questions yourself ...',
```

The session that ran the workflow asks the person, in one batch (it never answers
for them, and never adds `on_question: 'assume'` on its own). It shows the
confirmations as one list the person can accept whole or correct line by line, and
the result's `assumptions` with the questions. Then it re-runs the workflow as the
relay says, with the same args plus `answers`:

```js
answers: [{ id: 'intake.q2', question: 'the question as asked', answer: "the person's words", date: '2026-11-12' }],
              // a lane workflow's entries add lane: '<key>'; brief-to-proposals also reads stage, the
              // stage that asked; { '<id>': '<answer>' } is accepted too
```

`question` and `date` are optional and travel with the answer: into every prompt,
the saved plan and the PR body (a lane), `design/answers.json` (a design run), and
the `(person, <date>, <id>)` tag of the decision the answer settles. An answer
passed without its question still binds: the run logs its id, and a stage that
cannot tell from the answer alone what it settles treats it as settling nothing,
never guessing what it meant. Answers add up: every re-run passes the earlier ones
again.

**A decision made outside a question** (an assumption the person corrects, an
unconfirmed decision they confirm, something they decide in chat) is passed the
same way, under a `d<N>` id, its `question` saying what it settles. Such an id
takes no part in the `q<N>` numbering:

| Id | For | Read by |
|---|---|---|
| `intake.d<N>` | a decision for the whole product; `/start-product` prints the choices it confirmed this way | every stage of a design run, and of a `refresh-proposal`, `bootstrap-repo` or lane run it is passed to (`bug-fix-backlog` reads an `intake` id as its own Intake's and passes it to no lane) |
| `architecture.d<N>` | a correction to the written architecture or roadmap | a design run with `from: 'architecture'`, which applies it to both docs before their review |
| `m<N>.d<K>` | a correction to milestone N's written proposal | a design run with N in `milestones` |
| `<stage>.d<N>` (`plan.d1`, `impl.d2`) | a lane's assumption the person corrected | that lane's `plan-to-merged-pr` run, from that stage on |
| `bootstrap.d<N>`, `revise.d<N>` | the same, for `bootstrap-repo` and `refresh-proposal` | every stage of the run |

How an answer is routed, and how the re-run goes on:

- `plan-to-merged-pr`: stages run `plan` → `impl` → `fix` → `polish` →
  `merge_check` → `monitor`. Each answer reaches the stage that asked and every
  later stage, never an earlier one; an id whose first part names no stage reaches
  every stage. In the session that ran it, re-run with `resumeFromRunId` set to
  the stopped run's id: the stages before the one that asked replay from the
  record. A new session re-runs the same way without it, and the run continues
  from the branch's saved plan ([Workflow args](#workflow-args)). An answer to a
  `monitor` question is given in monitor-only mode instead: the result's
  `resume_monitor`, with the new answers added to the `answers` it already carries
  (the ones given before).
- `brief-to-proposals`: the scopes are `intake` → `architecture` → a milestone
  (`m<N>`; in concern mode `proposal`) → `consistency`, and an id with any other
  first part counts as an Intake answer. In brief mode every answer reaches every
  author, reviewer and consistency pair, whichever stage asked it, since the same
  choice can arise in another doc: it binds wherever that choice arises, and one
  plainly about another doc's detail does not. In concern mode each answer reaches
  the stage that asked and every later one. The scope decides where an inferred
  re-run starts ([below](#re-running-a-design-run)). A brief-mode `needs_input`
  result names `resume_from`: re-run with every
  answer given so far and `from` set to it, from this session or a new one; the
  docs already written are kept, and the stages before it are skipped rather than
  replayed (`resumeFromRunId` also works, in the same session). After a
  milestone's question, pass `milestones` as the relay names them: the answers are
  passed again on every later run, so they select no milestone, and without
  `milestones` an answer to a reviser of a written proposal would go unused. From
  the Proposals stage on, no stage applies an answer to the architecture or the
  roadmap: a correction to either is passed as `architecture.d<N>` with
  `from: 'architecture'`, and a correction to one written proposal as `m<N>.d<K>`
  with N in `milestones`.
- `proposal-build-chain`: each answer keeps the `lane` its question carried and
  goes to that lane only. Re-run with the same args (the same `date`): pushed lanes
  come back `already_built`, and the lane that asked continues from the plan its
  earlier run saved (`plan_ref`), so no planner re-asks or contradicts the answer;
  it plans again only when no plan for the same work is saved, when the saved plan
  contradicts an answer, or when its key is in `replan`. Its uncommitted work is
  kept only while its worktree exists: a new container builds the lane again from
  that plan, with the answers. A lane that already pushed is not built again, so a
  correction to one of its assumptions is no answer: the person makes it on that
  lane's PR, as a review comment.
- `bug-fix-backlog`: only the Intake's question (`intake.q1`, no `lane`) is
  answered by re-running it, with the confirmed lanes ([args](#workflow-args)). A
  lane's question is answered by re-running `plan-to-merged-pr` with that lane's
  `resume_args`, or with its `resume_monitor` (monitor-only) once its PR is open,
  plus `answers` without the lane key (added to any those args already hold) and
  without `resumeFromRunId`, as the lane's relay says.
- `ship-chain`: each answer keeps its `lane` and goes to that lane's
  `plan-to-merged-pr` run only. Re-run with the same args: lanes whose PR merged are
  skipped, and the lane that asked ships again (monitor-only, with its answers, when
  its PR is already open, as a `monitor` question needs).
- In the three lane workflows, an answer with no `lane` reaches every lane. That is
  for a decision the person made for the whole run, under an id no lane issues
  (`intake.d<N>`; `bug-fix-backlog` passes no `intake` id to a lane). The ids a
  lane's own run issues (`plan`, `impl`, `fix`, `polish`, `merge_check`, `monitor`;
  `.q<N>` or `.d<N>`) repeat across lanes, so one of those with no `lane` throws
  when the run has more than one lane (`answers: <ids> names no lane`): pass the
  lane its question carried. With one lane it goes to that lane.
- `bootstrap-repo`: `bootstrap` → the ship run. Every answer reaches the bootstrap
  stage and the ship run, a design run's `intake.d<N>` passed on included. The one
  exception is the ship run's own ids (`plan`, `impl`, `fix`, `polish`,
  `merge_check` and `monitor`): they reach the ship run only, which routes them to
  its stages, so a resume replays the bootstrap stage. A `monitor` question is
  answered in monitor-only mode instead: `ship.resume_monitor`, with the new
  answers added to the ones it carries, as its relay says.
- `refresh-proposal`: one scope. Every answer reaches every review (so a choice that
  follows it is not reported as a defect) and every revise, so a re-run starts again
  from the doc as it is now: the revisions already applied are kept, and
  `resumeFromRunId` has nothing to replay. The run also reads the design run's
  saved answers by itself ([Workflow args](#workflow-args)).

A question asked on a later run continues the numbering after the highest answered
`q<N>` in its scope (`revise.q2` after an answered `revise.q1`, `m2.q2` after
`m2.q1`; in `brief-to-proposals`, the Consistency phase's revisers and re-reviews
share one numbering), so ids never repeat across re-runs.

`on_question: 'assume'` is for runs no one will answer, and the person's choice to
make: the relays, and the working rules `/seed` writes into `CLAUDE.md`, tell the
session to pass it only when the person said to proceed on assumptions. Each
blocking question and each confirmation is then settled by its recommended option
instead (for a confirmation the unconfirmed value; in a conflict with what the
person said, what the person said) and listed in the result's `assumptions`; a
design author also tags the decision `(assumed)`. A merge conflict that is the
person's call (the merge check's, or the monitor's `/merge-main`) is handled the
same way: resolved with the recommended option, the side the person settled where
they settled one, and listed; with `'stop'` the merge is aborted, nothing is
pushed and the conflict comes back as a question. `bug-fix-backlog`'s Intake
stops whatever it says. Every result lists `assumptions` either way, the choices
the agents made that their inputs did not settle, so none is silent: the session
shows them to the person before a doc is accepted or a PR is merged (a lane's are
also in its PR body, under `## Assumptions to review`; `proposal-build-chain`
lists every lane's at the top level, and `bug-fix-backlog` in each lane's entry).

## Resuming, in this session or a new one

To resume a stopped run in the session that ran it, ask Claude Code to call the
Workflow tool again with the same args and `resumeFromRunId` set to the run id the
tool reported for the stopped run. `resumeFromRunId` is a parameter of the Workflow
tool, not a workflow arg. Completed agent calls are replayed from the record up to
the first call whose order or inputs differ; everything after it runs live.
Parallel work spawns in completion order, so a resume can diverge early and repeat
finished work: the lanes of `bug-fix-backlog` and the chains of
`proposal-build-chain` (unless `parallel_chains: false`). `bug-fix-backlog`'s close
and ship stages re-check the issue and PR state before acting.

A new session (after a handoff, or in a new container) has no run record to resume
from, and needs none: each workflow re-run with the same args starts where the
repository, origin and the [state branch](#the-state-branch) say the work is.

- `brief-to-proposals`: the same args plus every answer and `from` (the result's
  `resume_from`; inferred, it can start earlier: below), and after a milestone's
  question the `milestones` its relay names. With `branch`, a fresh
  clone checks the branch out and continues from the docs on it. The answers saved
  on the state branch are restored, so one the new session does not pass is not
  lost. The brief and the context file are never committed. Copy the brief into the
  checkout first, or the run stops with `failed_at_start` (`brief_not_found`). The
  context file is restored from the state branch when the person consented to keep
  it there; otherwise the person rewrites it or copies it back, or the run stops
  (`context_not_found`).
- `proposal-build-chain`: the same args and `date`: lanes already on origin come
  back `already_built` and are not rebuilt, and the ship plan points at the plans
  their runs saved. A lane that stopped before it pushed continues from its saved
  plan (`plan_ref`); what it had not committed and pushed is in its checkout alone,
  and a new container builds it again from that plan.
- `plan-to-merged-pr`, full or build-only: the same args, with `branch` naming the
  branch when an earlier run created it: the run continues from that branch's
  saved plan (`replan: true` plans again).
- `ship-chain`, and `plan-to-merged-pr` ship-only or monitor-only: each lane's plan
  comes from the state branch (`plan_ref`), and a missing checkout is recreated on
  its branch from origin, or cloned from `repo`. `ship-chain` skips lanes whose PR
  merged and picks up an open PR where it is; a handed-off PR's `resume_monitor`
  carries `plan_ref`, `dir` and the answers the run was given.
- `bootstrap-repo`: the same args: `/bootstrap` finds its commit and changes
  nothing, and an open PR is picked up, not opened twice. A run that stopped after
  its first write and before its commit (red gates, a question) left an unfinished
  `bootstrap/<date>` branch: `/bootstrap` resumes on it, in the checkout that holds
  its files.
- `refresh-proposal`: the same args plus `answers`: it starts from the doc as it
  is, and restores a missing `context_file` as a design run does.
- `bug-fix-backlog`: the same args (the same `date`): closed or shipped issues are
  re-checked and skipped. A lane whose run stopped is not continued this way: run
  `plan-to-merged-pr` with its `resume_args` or `resume_monitor`
  ([Answering questions](#answering-questions)).

**The handoff.** `/handoff` writes `STATE.md` to the state branch. Besides where
the work stands and the exact next action, it keeps what the person said: under
`## Answers given`, one line per answer,
`<id> (from <workflow or command>[, lane <key> | branch <name> | doc <path>]): <question> → <answer> (<date>)`,
never dropped and never reworded, a decision made outside a workflow question
included (under an `intake.d<N>` or `<scope>.d<N>` id, so it can be passed back);
under `## Standing rules from the person`, each rule they set for the work as a
whole, in their words, with its date; and under `## Assumptions to review`, the
choices a workflow, a command or the session made that no person has reviewed. The
ids of lane and doc questions repeat (every lane has a `plan.q1`, every refreshed
doc a `revise.q1`), so a line names the lane, the branch or the doc that asked:
without it the answer cannot be passed back. An unknown the tree, CI or GitHub can
settle is never listed under the assumptions: it is settled, or written as a check
to run under `## Next`. A lane a workflow stopped on a question is listed among the
branches with its checkout and its `plan_ref`: its plan is on the state branch,
and what it had not committed and pushed is in that checkout alone.
`## Environment` says how the brief and the builder context restore.

A session asked to "Continue from the pipeline handoff" reads `STATE.md`
(`python3 .claude/scripts/pipeline-state.py get STATE.md`; the SessionStart hook
says when one exists and quotes its `## Next`) and the files it links. It follows
the standing rules from its first action, re-checks what may have moved (PR states,
checks, branches) and runs the checks `## Next` lists, and restores the brief and
the builder context before a design run (the builder context from the state branch
when it is there, else from the person: never from memory or from the handoff).
It then shows the person `## Assumptions to review` together with the questions
under `## Waiting on the person`, in one batch; an assumption they confirm or
correct becomes an answer. It passes answers to the workflow `## Next` names as
`answers`, each with its id, question, answer and date; an entry whose question or
date was not recorded is passed without that field, never with a guess. Which
ones:

- every decision the person made for the whole product (`intake.d<N>`, or another
  id no workflow issued), and to a design run every answer an earlier design run
  asked. `bug-fix-backlog` reads an `intake` id as its own Intake's question, so it
  gets no design answer;
- every answer that same workflow asked: for `refresh-proposal`, the `revise` ids
  of the same doc only;
- an answer whose id starts `plan`, `impl`, `fix`, `polish`, `merge_check` or
  `monitor` only to a run of the branch that asked it: as it is to that
  `plan-to-merged-pr` run, or to `bootstrap-repo` for its bootstrap branch, and
  with the `lane` key its line records to `proposal-build-chain`, `ship-chain` or
  `bug-fix-backlog`.

An answer never goes to another lane, branch, doc or workflow than the one its line
names. Only then does the session do `## Next`. It runs `/handoff` again before it
ends. A checkout without the pipeline's files (a fresh clone of `main` before the
design branch has landed) can read the handoff with plain git:
`git fetch origin pipeline/state`, then `git show FETCH_HEAD:STATE.md`.

### Re-running a design run

`brief-to-proposals` starts at `from`. Without it, once `architecture.md` and
`roadmap.md` exist, the run starts at the earliest stage among the answers' ids,
the Intake's left out (`architecture.q<N>` or `architecture.d<N>` → `architecture`,
`m<N>.q<N>` or `m<N>.d<K>` → `proposals`, `consistency.q<N>` → `consistency`; the
docs were written after every `intake.q<N>` answer, and `intake.d<N>`, like an id
whose first part names no stage, counts as the Intake's), at `proposals` when no
other answer
is given, and at the Intake when the docs do not exist, or with `force`. Inference
counts every non-intake answer passed, an earlier run's included, but never one
restored from the state branch, so a re-run with answers added to earlier ones can
start before the stage that asked: an `architecture.q1` the docs already reflect
re-runs the architecture review, whose revisions can reset an accepted `Status:`
to draft. Pass `from` set to the result's `resume_from`, as its relay says.

| `from` | What it runs |
|---|---|
| `intake` | the Intake, then every later stage; with existing docs (and no `force`) the architecture review resumes on them instead of `/roadmap`, after the answers they do not yet reflect are applied, and only the milestones not yet written (or exactly `milestones`) are proposed |
| `architecture` | no Intake; with the docs, the Intake's and the architecture's answers applied to them, then their review loop; without them (or with `force`), `/roadmap` on the panel synthesis saved on the state branch (`design/panel-synthesis.md`, when its `Source:` names this brief), else on a new panel; then the later stages |
| `proposals` | the milestones whose proposal does not exist yet (`proposal_exists`; an author that asked wrote none), or exactly `milestones`, at most `max_milestones` (0: none), keeping every other proposal; then Consistency over all docs, then Lint. Answers select no milestone: `/propose` on a written proposal rewrites it as a draft, so a reviser's answer reaches it only through `milestones`. No answer is applied to the architecture or the roadmap from here on |
| `consistency` | Consistency over all docs, keeping every proposal, then Lint |
| `lint` | the Lint only |

Kept proposals take part in Consistency and Lint, and are not re-reviewed or
counted as unreviewed in the status. A `from` past `architecture` needs both docs
(`failed_at_start`, `no_docs`), and `force` with it throws.

`force` on a re-run: keep it while this run has not regenerated the docs yet (a
stop at the Intake, the judge or `/roadmap`), since without it the re-run would
resume the review of the docs `force` was to replace; leave it out once this run's
`/roadmap` has written them, or it would write them again. The relay and the next
steps of a run given `force` say which holds. `/roadmap --force` carries over every
D-record tagged `(person, …)` and every recorded `Outcome:` from the docs it
overwrites.

`max_milestones: 0` writes and reviews the architecture and the roadmap, lints
them and proposes nothing: a stop to confirm the two docs (the result's
`assumptions`, `lint.unconfirmed` and `lint.proposed`) before any proposal builds
on them. A re-run with `from: 'proposals'` then writes the proposals. A later
milestone's proposal is best written the same way (`from: 'proposals'`,
`milestones: [N]`): the workflow restores the person's saved answers, which
`/propose --milestone=N` run by hand does not get. `/bootstrap`'s next steps name
that re-run for each milestone without a proposal, and the bare command only for a
design written without the workflow.

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

`resume_monitor` carries the plan as `plan_ref` and the checkout as `dir`, so the
re-run works in a fresh session or container: it restores the plan from the state
branch and recreates a missing checkout from origin. It also carries the answers
the run was given, so no comment, conflict or CI fix reverses what the person
settled, and nothing is asked twice. Each re-run is a full monitor
of up to `max_monitor_rounds`; pass a small one (2 or 3) so a quiet PR costs one or
two observe rounds. Never run two monitors on one PR
at once: both would push to its branch. A re-run that sees the PR `MERGED` with
`proposal` set reports `closeout`, so the scheduled watch also prompts the close-out.
Stop the schedule once the PR merges or closes.

## The context guard

`.claude/scripts/context-guard.py` keeps the session that runs the workflows (the
orchestrator) under half its context window: it hands off with `/handoff` instead
of compacting. `.claude/settings.json` registers it as the status line
(`context-guard.py statusline`) and as one hook command for five events
(`context-guard.py hook`, which dispatches on the event).

It acts only on the orchestrator. A main session becomes one with its first
Workflow tool call (PostToolUse sees `tool_name` `Workflow` and creates the
session's orchestration mark, `<session>.orchestrating`, which is never rewritten,
so no hook writing the session's record can clear it), or from its start with
`PIPELINE_ORCHESTRATOR=1`. A session that runs no workflow, such as an ordinary
coding session or a `claude -p` run, gets the SessionStart pointer and a plain
`ctx NN%`, at any usage, and nothing else: it is never told to hand off, so it never
pushes a state branch. Under CI (`CI` or `GITHUB_ACTIONS` set to anything but empty,
`0`, `false`, `no` or `off`) the guard does nothing at all, SessionStart included,
so a review bot is left alone, unless `PIPELINE_ORCHESTRATOR=1`. In an orchestrating
session:

| Event | At or over the threshold | Otherwise |
|---|---|---|
| status line | prints `ctx NN% · handoff due` and records the usage in `~/.claude/context-guard/<session>.json` | `ctx NN%` (`ctx --` before the first response) |
| PostToolUse | context for Claude: start no new work, finish or park the step, run `/handoff`, end the session. Rate-limited: the first crossing (the Workflow call that makes the session orchestrating counts), then every 5 more points or every 10th tool call | nothing |
| UserPromptSubmit | context for Claude beside the prompt; never blocks it | nothing |
| Stop | blocks (`decision: block`) until `/handoff` in this session has recorded a handoff since the crossing (another session's, in another worktree of the repository say, does not count); a stop already continued once (`stop_hook_active`) goes through | nothing |
| PreCompact (auto) | the first in a session is blocked with the handoff instruction; a later one goes ahead, with summary instructions that keep the pipeline state and say to run `/handoff` first after it | allowed, with summary instructions that keep the pipeline state and no handoff: the guard asked for none, so the session goes on |
| PreCompact (manual) | allowed | allowed |
| SessionStart | at any usage, and in a session that does not orchestrate too: when the state branch has `STATE.md` (origin's, fetched; when the fetch fails, the refs as last fetched, unless origin answers that it no longer has the branch: then the stale tracking ref is deleted and only a local branch counts), says when it was saved, to read it first (`python3 .claude/scripts/pipeline-state.py get STATE.md`) and, before doing its `## Next`, to follow its standing rules and put its open questions and its assumptions to review to the person in one batch, and quotes its `## Next` (up to 2,000 characters) | the same |

The summary instructions a compaction gets name what to keep, exact where it is
exact: the goal, each run in flight or stopped with its args, branches and open
PRs, the open questions with their options and recommendation, each answer with its
id, what asked it (the workflow, and its lane or doc), the question's text, the
person's words and the date, the standing rules the person set, the assumptions not
yet reviewed, environment notes and the next action.

Usage comes from the status line's record when it is under 10 minutes old, else
from the session transcript: the last main-chain assistant response's input,
cache-creation and cache-read tokens over the window. The window is the status
line's last `context_window_size`, else `PIPELINE_CONTEXT_WINDOW`, else 1,000,000
for a model whose window is 1M (the 5-series and later, Fable, Mythos, an id ending
`[1m]`), else 200,000, and 1,000,000 once a count passes 200,000. A smaller
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` becomes the window, for the status line too, and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` lowers the threshold to 10 points under it (half
of it, below 20), so an earlier auto-compaction never comes first. Events fired
inside a subagent or a workflow agent (hook input with `agent_id`) are ignored, so a
subagent's Workflow call makes no session orchestrating, and any error exits 0 with
no output, so the hooks never fail a session. A session's hooks take turns: each
holds `<session>.hook.lock` while it reads, changes and writes the session's record,
so two close together (parallel tool calls, or a prompt and a stop) keep both
changes, and one that cannot take it within 2 seconds does nothing.

| Variable | Default | Effect |
|---|---|---|
| `PIPELINE_HANDOFF_PCT` | `40` | the threshold, in percent of the context window |
| `PIPELINE_CONTEXT_WINDOW` | inferred | the window in tokens when no status line reports it (`1000000` for a 1M model the guard does not recognize) |
| `PIPELINE_ORCHESTRATOR` | unset | `1`: the session orchestrates from its start, without a Workflow call, and under CI too |
| `CI`, `GITHUB_ACTIONS` | read, never set | either one set (not empty, `0`, `false`, `no` or `off`): no hook nags, blocks or points at `STATE.md`, and the status line drops "handoff due", unless `PIPELINE_ORCHESTRATOR=1` |
| `PIPELINE_CONTEXT_GUARD` | on | `off` (or `0`, `false`, `no`) makes every hook a no-op and drops "handoff due" |
| `PIPELINE_GUARD_DIR` | `~/.claude/context-guard` | per-session records (removed after 30 days) |
| `PIPELINE_STATE_BRANCH` | `pipeline/state` | the state branch, for the guard and `pipeline-state.py` |
| `PIPELINE_STATE_OFFLINE` | unset | `1`: SessionStart does not fetch, and reads the refs as last fetched |

To turn it off or adjust it:

- For yourself, keep the project file and set the variable in
  `.claude/settings.local.json` (not committed; it overrides the shared project
  settings): `{"env": {"PIPELINE_CONTEXT_GUARD": "off"}}`, or another
  `PIPELINE_HANDOFF_PCT`. A cloud session does not read that file: set the variable
  on its cloud environment instead.
- To keep your own status line, set `statusLine` in `.claude/settings.local.json`;
  the hooks keep working from the transcript.
- `"disableAllHooks": true` turns off every hook and the status line; deleting the
  entries from `.claude/settings.json` removes the guard for everyone.
- `PIPELINE_ORCHESTRATOR=1` has the guard act from a session's first event: for an
  orchestrator that relays runs it did not start itself, or one that runs under CI.
- `python3 .claude/scripts/context-guard.py status` prints what the guard sees for
  the current session (`CLAUDE_CODE_SESSION_ID`, or `--session ID`), whether it
  orchestrates included, and `mark-handoff` records a handoff by hand: for that
  session, or, run with no session id, for every session of the repository.

The guard runs only where Claude Code reads the repository's
`.claude/settings.json`: a local session in it, or a cloud session with that one
repository. A cloud session with several repositories attached, or a cloud thread
in a project, runs none of a repository's hooks (Claude Code's settings docs,
*Settings in cloud sessions*): there the orchestrator runs `/handoff` itself before
half its context. Whether the status line runs in cloud sessions is not verified;
the hooks measure from the transcript without it. The guard, `/handoff` and the
SessionStart pointer all act on the repository the session runs in, so the
orchestrator of a product runs in that product's repository, not in the pipeline
checkout.

## The state branch

The pipeline keeps what must outlive a container on a branch of origin,
`pipeline/state` (env `PIPELINE_STATE_BRANCH` or `--branch` overrides): never main,
never force-pushed, written with git plumbing and a temporary index, so any
worktree can save to it without a checkout and the working tree never changes. The
first save creates it as a root commit. It is as visible as the repository: it
never holds the brief, secrets or `.env` values, and it holds the builder context
only when the person consented to keep it there
(`pipeline-state.py` refuses a `.env` file, any file over 5 MB, and `main`, `master`
or origin's default branch as the state branch). A branch rule that blocks pushing
new branches blocks it too.

| Path | Written by | Holds |
|---|---|---|
| `STATE.md` | `/handoff` | the orchestrator handoff, with the person's answers and standing rules |
| `plans/<branch-slug>.md` | `plan-to-merged-pr`'s planner, and again its merge check | a lane's plan (`plan_ref`); from the merge check on, ending with `## Assumptions to review` |
| `reviews/<branch-slug>.json` | `/review-changes`, `/polish` | the review-findings ledger |
| `reviews/proposal-<doc-slug>.json` | `/review-proposal`, `/propose --revise` | design-review ledgers |
| `design/panel-synthesis.md` | `brief-to-proposals` | the judged architecture synthesis |
| `design/answers.json` | `brief-to-proposals`, brief mode | every answer the run holds, `{ source, answers: [{ id, stage, question, answer, date }] }`; a later brief-mode run on the same brief restores the ones it is not passed, and `refresh-proposal` reads it |
| `design/answers-concern.json` | `brief-to-proposals`, concern mode | the same, for a concern; no run restores it |
| `context/builder-context.md` | `/start-product`, `/handoff` | the builder framing (`docs/builder-context.md`), only with the person's consent; `brief-to-proposals` and `refresh-proposal` restore a missing `context_file` from it, and list the restored file in the checkout's local exclude file |
| `runs/<YYYYMMDDTHHMMSSZ>-<workflow>.json` | `/handoff` | a workflow's args too large for `STATE.md`, linked from it |

`<branch-slug>` is what `python3 .claude/scripts/pipeline-state.py slug <branch>`
prints, and `<doc-slug>` what it prints for the doc's repo-relative path without
`.md`. Every character outside `[A-Za-z0-9._-]` becomes `-`; when any did, `-` and
8 hex digits of the FNV-1a 32-bit hash of the name's UTF-8 bytes follow, so names
that read the same once replaced still get different files: `feat/x` →
`feat-x-d03c3cb6`, `feat:x` → `feat-x-ce5c8d3b`, `feat-x` → `feat-x`, and
`docs/design/roadmap` → `docs-design-roadmap-0c66c4d2`. The workflows compute it
with a copy of the script's function (`planRefFor`, checked against the script in
CI); the commands run the script.

```
python3 .claude/scripts/pipeline-state.py save SRC [--as PATH] [-m MSG] [--no-push]
python3 .claude/scripts/pipeline-state.py get PATH [--to FILE] [--local]
python3 .claude/scripts/pipeline-state.py list [PREFIX] [--local]
python3 .claude/scripts/pipeline-state.py slug NAME
(save, get and list also take --repo DIR and --branch NAME)
```

- `save` stores SRC (`-` = stdin, which needs `--as`) at PATH (default: SRC's
  basename) and prints `{"saved": true, "path", "commit", "branch", "pushed",
  "unchanged", "attempts"}`; identical content makes no commit (`unchanged`). A push
  rejected because another clone saved first is fetched, rebuilt on the new tip and
  retried, up to 5 times. `--no-push` commits to the local ref only.
- `get` fetches and prints PATH from origin's branch, or writes it to `--to FILE`
  (parent directories created); `list` prints the stored paths; `--local` reads the
  local ref without fetching.
- Exit 0 done; 2 usage error or git failure (no origin, network still failing after
  the retries); 3 `get`: no such branch or path. Never 1. Saving is best effort: a
  stage whose save exits 2 logs it and goes on; only `/handoff` reports the failure
  to the person, and then prints the whole handoff in its reply.

## State outside the repo

The commands and `gate-slot.sh` keep some state in your home directory, shared by
every checkout. What a new container must not lose is mirrored to the
[state branch](#the-state-branch), best effort; the rest is local only.

Mirrored to the state branch, and restored from it when the local copy is missing:

- `~/.claude/reviews/<branch-slug>.json`: the review-findings ledger that
  `/review-changes` writes and `/polish` updates, saved as
  `reviews/<state-slug>.json` after every write (`<state-slug>` is
  `pipeline-state.py slug <branch>`, which can differ from the local slug: lowercased,
  runs collapsed). A restored ledger's `repo` is reset to the new working directory.
- `~/.claude/reviews/proposal-<slug>.json`: the design-doc review ledger that
  `/review-proposal` writes and `/propose --revise` updates (findings applied are
  marked fixed, declined ones keep their reason). The local slug is the working
  directory's base name plus the doc's repo-relative path (`docs/design/roadmap.md`
  in `~/src/acme` → `proposal-acme-docs-design-roadmap.json`), so two projects'
  `roadmap.md` never share a ledger; one belonging to another checkout or doc is
  never overwritten. Its copy is `reviews/proposal-<doc-slug>.json`
  (`docs-design-roadmap-0c66c4d2`), restored with `repo` reset to the new working
  directory.
- `~/.claude/plans/` (`PLANS_DIR`): the plans `/plan` and `/bug-fix` write. A lane's
  plan is saved as `plans/<branch-slug>.md` when its planning ends and again at its
  merge check, and restored into `PLANS_DIR` by a ship-only or monitor-only run
  given `plan_ref`; other plans stay local.
- `docs/builder-context.md`, in the checkout, only when the person consented:
  saved as `context/builder-context.md` by `/start-product` and again by
  `/handoff`, and restored by a `brief-to-proposals` or `refresh-proposal` run that
  finds its `context_file` missing. The stage that restores it appends its path to
  the checkout's local exclude file (the one `git rev-parse --git-path info/exclude`
  prints) unless a line there names it, so a fresh clone keeps it out of commits
  too.

Only on the state branch: `STATE.md`, `design/panel-synthesis.md`, the saved
answers (`design/answers.json`, `design/answers-concern.json`) and the `runs/`
files.

Local only:

- `~/.claude/last-plan-by-folder.json`: the latest plan per working directory,
  written by `/plan` and `/bug-fix` and read by the other commands.
- `~/.claude/bug-fix-progress.json`: claims that stop two `/bug-fix` sessions
  working on one issue.
- `~/.claude/context-guard/` (`PIPELINE_GUARD_DIR`): the context guard's
  per-session records and handoff marks.
- `~/.cache/gate-slot-locks/` (`GATE_LOCK_DIR`): `gate-slot.sh`'s lock files and
  its `gate-runs.log`.
- `docs/brief.md` and `docs/builder-context.md`, in the checkout: untracked and
  listed in `.git/info/exclude`, never committed or pushed. The brief is never
  stored on the state branch, and the builder context only with the person's
  consent (above). A new container lacks them: copy the brief again from its source
  (the handoff's `## Environment` says where) and, without that consent, have the
  person rewrite the framing or copy it back; or re-run `/start-product` while the
  repository holds no code. To commit the brief on purpose, `git add -f` it. The
  person's product decisions are in neither file: they travel as answers.

`/review-changes` also reads Claude Code's own session transcripts under
`~/.claude/projects/`, without writing to them. The design docs themselves live in
the repo (`PROPOSALS_DIR`).

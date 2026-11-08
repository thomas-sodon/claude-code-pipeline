# claude-code-pipeline

Take a new idea from a written brief to merged code with Claude Code. Workflows and
commands write the architecture, the roadmap and one proposal per code milestone,
and review each until clean. Once you accept them, they build a skeleton with green
gates and CI, then each proposal lane by lane: plan, implement, review until clean,
polish, open the PR and babysit it, each stage in a fresh session. You accept the
docs, do the human-gated steps and merge. On an existing project the build half also
runs alone: one sentence describing a change becomes a review-clean, CI-green PR.

[![ci](https://github.com/thomas-sodon/claude-code-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/thomas-sodon/claude-code-pipeline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- demo screenshot goes here -->

Extracted from [maestro-agent](https://github.com/thomas-sodon/maestro-agent)
(see [Why this exists](#why-this-exists)).

## Quickstart

Requirements, the full config keys and the example config are in
[docs/REFERENCE.md](docs/REFERENCE.md#install-and-configuration).

### A new product, from a brief

```sh
git clone https://github.com/thomas-sodon/claude-code-pipeline /tmp/ccp
git clone git@github.com:you/my-product.git && cd my-product   # a new, clean repository
cp ~/my-brief.md brief.md
claude   # then: "Run the workflow at /tmp/ccp/.claude/workflows/brief-to-proposals.js with
         #        { brief: 'brief.md', dir: '<absolute path here>', pipeline: '/tmp/ccp' }"
```

The clone may be empty or hold just the README and licence a host creates.

0. **Seed.** The workflow's first step, `/seed`, installs the pipeline's commands
   (`.claude/commands`), workflows and scripts in the repository and writes a base
   `CLAUDE.md` (how work happens here, and a Pipeline config `/bootstrap`
   completes), so every later session runs from files in the repo. They are
   committed with the bootstrap branch, before any milestone builds.
1. **Design.** The workflow writes `docs/design/architecture.md`, `roadmap.md` and
   one proposal per code milestone, each reviewed until clean. No code, no commits.
2. **Accept** (you). Read and edit the docs, then set `Status: accepted` on each one
   you approve. `/bootstrap` and the builders refuse a draft.
3. **Bootstrap** (you run it). `/bootstrap docs/design/architecture.md` writes a
   skeleton whose gates pass, `CLAUDE.md` with the Pipeline config, CI, and one
   commit, holding the docs too, on a `bootstrap/<date>` branch. (An empty remote
   gets the root commit on local `main` instead, which you push, and step 4's
   ship-only run is skipped.)
4. **Ship it** (you merge). `plan-to-merged-pr` with `{ ship_only: true, branch,
   title }` opens the bootstrap PR and babysits its CI; you merge it, protect `main`
   and require its CI checks (the gates and `docs`, which lints the design docs), add
   the secrets by name and tick the roadmap's Bootstrap gate with its `Outcome:`
   through a docs PR: `/bootstrap` prints the steps. They also offer an AI review for
   the monitor (see *AI review* below).
5. **Build, milestone by milestone.** You do the human gates the next milestone
   waits on; `proposal-build-chain` builds its proposal's lanes; `ship-chain` ships
   each chain's lanes in merge order, one PR at a time, and you merge each. `python3 .claude/scripts/proposal-lint.py
   docs/design/roadmap.md --roadmap` names the next milestone.

### An existing project

```sh
git clone https://github.com/thomas-sodon/claude-code-pipeline /tmp/ccp
cd your-project
python3 /tmp/ccp/.claude/scripts/pipeline-sync.py --from /tmp/ccp   # copies .claude/, records a manifest
printf '\n## Pipeline config\n\nQUALITY_GATES: npm test\n' >> CLAUDE.md   # your gate command
claude   # then: "Run the plan-to-merged-pr workflow with { concern: '<what to change>' }"
```

Or seed them: `cd /tmp/ccp && claude`, then `/seed /abs/path/your-project`. It
copies the same files, appends to `CLAUDE.md` whichever of `## How work happens here`
and a base `## Pipeline config` it lacks, and, when that config has no
`QUALITY_GATES`, reports the commands your CI runs as the candidate value, for you
to add once they pass locally. Land the seeded files with `/create-pr` before you
build: lanes are cut from `origin` and need the commands there. To lint your design
docs in CI, as `/bootstrap` sets up on a new repository, paste the `docs` job from
[`examples/docs-lint-job.yml`](examples/docs-lint-job.yml) into your CI workflow and
require its check on `main`
([how](docs/REFERENCE.md#install-and-configuration)).

### AI review

The PR monitor waits for an AI review check before counting comments, but none is
installed by default: without one, the only independent review is `/review-changes`
before the PR. [`examples/answerable-ai-review.yml`](examples/answerable-ai-review.yml)
is the one this repository runs. Copy it to `.github/workflows/`, add the secret by
name (`gh secret set CLAUDE_CODE_OAUTH_TOKEN` prompts for the value, from
`claude setup-token`), and pass `ai_review_check: 'Review'` to the workflows. It
posts findings as review comments (check `Review`) and fails `Reply coverage` while
one has no reply; require `Reply coverage` on `main` if unanswered findings should
block merge. `/bootstrap`'s next steps offer it, and `/seed` does on an existing
repository with no AI review check.

### Keeping the pipeline up to date

`/seed` and `.claude/scripts/pipeline-sync.py` record what they installed in
`.claude/pipeline-manifest.json` (the source commit and a hash per file), so an
update can tell an upstream change from your own edit. From your repository:

```sh
python3 .claude/scripts/pipeline-sync.py --check     # exit 1 when the pipeline's ref has changes for you
python3 .claude/scripts/pipeline-sync.py --update    # take them; then land .claude/ through a PR
```

It clones the pipeline (the manifest's repo and ref, `--repo` / `--ref` to change
them, or `--from <checkout>`), replaces the files you have not edited, deletes the
ones upstream removed, and keeps your edits: a file changed on both sides is listed
as a `conflict` (`--update --force` takes upstream's). It never edits `CLAUDE.md`
and never commits, but it compares `CLAUDE.md`'s `## How work happens here` (which
`/seed` marks with a comment) with the pipeline's current template,
`.claude/scripts/claude-md-base.md`, and prints the diff for you to apply by hand;
`--check --check-claude-md` also fails on it. To have it come to you, copy
[`examples/pipeline-update.yml`](examples/pipeline-update.yml) to
`.github/workflows/`: once a week it opens a PR with the update and the sync report,
on a branch per upstream commit, and closes the older update PRs it supersedes.
A pipeline copied with `cp -r` has no manifest yet; the first run adopts it: a file
that matches some older upstream version is treated as unedited (`outdated`, listed
under `adopted`), and one that matches none is `differs`, which `--update` replaces,
so commit any local edits first and re-apply them.

**Pinning a release.** `PIPELINE_REF` (in the Action) and `--ref` take a branch or
a tag; the manifest records it, so later runs and `--check` compare against the
same ref until you change it. `main` tracks the tip. To pin, set
`PIPELINE_REF: v1.4.0` (or run `--update --ref v1.4.0` once), and bump the tag to
take the next release. For the pipeline's maintainer, the recommendation is to cut
an annotated semver tag on `main` (`git tag -a v1.4.0 -m '...'`, then
`git push origin v1.4.0`) once CI is green, with release notes that call out
renamed or removed commands and changes to `claude-md-base.md`, since those need a
person: a renamed command changes what workflows call, and the `CLAUDE.md` section
is applied by hand. Tags are never moved: a fix is a new tag.

For a brief or a change too big for one PR, run `brief-to-proposals` with
`{ brief }` or `{ concern }` and `dir` (no `pipeline`: the repo holds it now). It
seeds again, and `/seed` does not count its own uncommitted changes in `.claude/`
and `CLAUDE.md` as a dirty tree, so it runs whether or not the seeded files have
landed. Land the accepted docs (and the seeded files, if still uncommitted) through
an ordinary PR, since lanes read the commands and the proposal from `origin`, then
build each proposal with `proposal-build-chain`.

## The pipeline

```
 Design: a brief, or work too big for one PR             (brief-to-proposals runs this half)
 brief ──> /seed ─────> /roadmap ───────> /propose ───────> /review-proposal ──> consistency ──> accept
           pipeline,    sketch panel,     --milestone=N:    + /propose --revise   pass, lint     (human)
           CLAUDE.md    architecture.md,  one per code      until no bug or
                        roadmap.md        milestone         concern

 Bootstrap: new repo only                                (you run it)
 /bootstrap architecture.md ──> skeleton, gates green, CI on bootstrap/<date> ──> PR ──> merge (human)

 Build: one concern, or each lane of an accepted proposal
        (proposal-build-chain derives the lanes; a lane behind a human gate waits until you tick it)
 concern ──> 1. Plan ──> 2. Implement ──> 3. Review loop ──> 4. Polish / PR ──> 5. Monitor ──> merge (human)
             /plan       /impl            /review-changes    /polish            CI, AI review,
             grounded    tests first      + fixer until no   gates green,       conflicts, comments
             plan                         bug or concern     /create-pr         until it settles

 Ship: one chain of a proposal's built lanes, in merge order  (ship-chain runs this)
 lane 1 ──> ship-only PR + monitor ──> merged (human) ──> lane 2, predecessor_prs filled ──> ... ──> last lane merged
```

The full process, every hand-off between you and the workflows, and the gaps
in it are drawn in [docs/PROCESS.md](docs/PROCESS.md).

## How it works

- **Docs before code.** A new product, or any change bigger than one PR, starts as
  an architecture, a roadmap and proposals, each reviewed until clean.
  `proposal-lint.py` checks their format and derives the PR lanes from each
  proposal's step list, so the split is deterministic.
- **Nothing is built from a draft.** `/bootstrap` and `/impl <doc>` refuse one;
  `proposal-build-chain` derive mode builds only an `accepted` or `in-progress` doc,
  and `/plan --proposal` (run for a `proposal` with the default planner and no
  `plan_text`) stops on `draft` or `done`, unless `allow_draft` is passed
  ([details](docs/PROPOSALS.md#status-lifecycle)).
- **Fresh session per stage.** Each command runs in its own session, so context
  stays small and the reviewer did not write the code it reviews.
- **Review until clean.** `/review-changes` is judged against the plan and re-run
  after each fix until no `bug` or `concern` remains; a defect still standing stops
  the run before anything is pushed. Design docs get the same loop with
  `/review-proposal`.
- **Questions before assumptions.** What only you can answer (your intent, a
  requirement the brief leaves out or states two ways, a trade-off that is yours) is
  asked, never guessed. A command asks you directly; a workflow stops with
  `needs_input` and returns the questions, each with options and a recommendation,
  so the session that ran it asks you and re-runs with your `answers`.
  `brief-to-proposals` asks before any design is written. Everything else the
  agents decide is listed as an assumption in the result.
- **Gates decide, not the agent.** Your own `QUALITY_GATES` command must be green
  before the PR is opened and again after merging `main`.
- **A human keeps the judgment.** You choose the concern or write the brief. You
  accept the design docs, merge the bootstrap PR, do every human-gated
  step (research, decisions, accounts and secrets, releases) and merge. Each
  production release is gated exactly once, in its proposal by default. The
  workflows never force-push, never push to main and never merge.

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
person writes the brief (or picks the concern, or the bug list), accepts the design
docs, does the human-gated steps and merges, and the workflows do the long,
disciplined parts reliably: an architecture, roadmap and proposals reviewed until
clean, then for each change a grounded plan, failing test first, independent review
until clean, gates green, PR opened and babysat until it settles.

Keep the judgment of *what* to build with a human; automate *how* it gets built and
shipped.

Related: [maestro-agent](https://github.com/thomas-sodon/maestro-agent),
[maestro-sdk](https://github.com/thomas-sodon/maestro-sdk) and
[maestro-review](https://github.com/thomas-sodon/maestro-review).

## What is in here

```
.claude/
  workflows/
    brief-to-proposals.js     a brief to reviewed architecture, roadmap and proposals; no code
    proposal-build-chain.js   a proposal's lanes, derived from its steps, built as stacked chains
    ship-chain.js             one built chain shipped in merge order, each PR once the one below merged
    plan-to-merged-pr.js      the engine: a concern, a lane or the bootstrap branch to a watched PR
    bug-fix-backlog.js        triage + adversarial verification + ship, per bug lane
  commands/
    seed.md  roadmap.md  propose.md  review-proposal.md  bootstrap.md
    plan.md  impl.md  review-changes.md  polish.md  create-pr.md
    process-comments.md  merge-main.md  quality-gates.md  bug-fix.md
  scripts/
    proposal-lint.py          design-doc lint, lane derivation, step ticking, CLAUDE.md drift check
    gate-slot.sh              optional host-wide semaphore for gate runs
    pipeline-sync.py          install / update the pipeline's files in a repo (3-way, via a manifest)
    claude-md-base.md         the CLAUDE.md "How work happens here" template /seed writes and sync compares
docs/
  PROCESS.md                  the end-to-end process diagram, and the known gaps in the flow
  PROPOSALS.md                the design-doc format: architecture, roadmap, proposals
  REFERENCE.md                args, statuses, configuration, state outside the repo
examples/
  CLAUDE.pipeline-config.md   the config section to paste into your CLAUDE.md
  pipeline-update.yml         a scheduled GitHub Action that opens a PR updating the pipeline
  docs-lint-job.yml           the CI job /bootstrap writes to lint the design docs, for an existing repo
  answerable-ai-review.yml    an AI review GitHub Action for the PR monitor (ai_review_check: 'Review')
ci/                           checks: workflow syntax; every skill and flag the workflows call
                              exists; the workflows stop on blocking questions and route the
                              answers; the lint's tests and fixtures; every example design doc
                              in README, docs and commands lints clean
.github/workflows/ci.yml      runs them, plus shellcheck and a gate-slot smoke test
LICENSE
```

Each file in `.claude/commands/` is a command (a Claude Code skill): run it as
`/<name>`; the workflows invoke it with the Skill tool, except `brief-to-proposals`'
Seed phase, where an agent reads and follows `<pipeline>/.claude/commands/seed.md`
(the repo has no commands until `/seed` runs).

| Command | Does |
|---|---|
| `/seed [<repo>] [--from=<dir>] [--update] [--dry-run]` | Installs the pipeline's commands, workflows and scripts into a repository (default: the working directory) and writes a base `CLAUDE.md` (working rules, a Pipeline config `/bootstrap` completes). Never overwrites a differing file unless `--update` is given, only appends missing sections to an existing `CLAUDE.md` (never edits its lines), never commits. |
| `/roadmap <brief> [--out=DIR] [--force] [--dry-run]` | Turns a product brief (or free text) into draft `architecture.md` and `roadmap.md`: decisions with their options, milestones in validation order, every person-only step a human gate. |
| `/propose <concern>` | Writes one draft proposal: design, security, rollout and a build-ordered list of one-PR steps and human gates. `--milestone=N` for a roadmap milestone; `--revise <doc>` applies review findings; also `--out=DIR`, `--slug=`, `--dry-run`. |
| `/review-proposal <doc> [--roadmap]` | Read-only review of a design doc against its source, the tree and the architecture (with `--roadmap`, against the whole roadmap too); findings as in `/review-changes`. |
| `/bootstrap <architecture.md> [--dry-run]` | Greenfield only, in a clean clone with `origin` (no code yet): skeleton, `CLAUDE.md`, CI, gates green, one commit on a `bootstrap/<date>` branch to ship as a PR (or, when the remote has no commits, the root commit on local `main`, which you push). Never pushes. |
| `/plan <concern>` | Grounds a free-text concern in today's tree and writes one increment's plan to the plans directory. `--proposal=<doc>` plans that doc's steps (`--allow-draft` for a draft); also `--slug=`, `--no-switch`, `--dry-run`. Writes no code. |
| `/impl [plan \| doc]` | Re-validates the plan (or a doc's next buildable step) against the tree, then implements it and runs the gates. Does not commit. |
| `/review-changes [uncommitted \| committed[:<base>] \| all[:<base>]]` | Read-only review of the branch's changes; findings are `bug` / `concern` / `suggestion` / `nit`. |
| `/polish [--fix-suggestions]` | Fixes what review found, runs the gates, reports how many issues it fixed (0 = clean). |
| `/create-pr [<hint>] [--no-issue] [--base=<branch>]` | Commits, pushes, detects issues to close, opens a non-draft PR, with the plan's `## Rollout` as deploy notes. |
| `/process-comments [<pr> [<comment-id>]]` | Fixes or declines every unresolved review thread (including outdated ones), pushes, then replies to each with a terminal marker. Never resolves threads or merges. |
| `/merge-main` | Merges the latest main (never rebases), resolves conflicts using the originating plan, runs gates, pushes. |
| `/quality-gates [fix \| check \| no-commit \| no-ci]` | Runs the project's gates plus the failure class of any gate check the PR's CI is red on, fixes failures at the root, commits and pushes. |
| `/bug-fix [<n> \| --rca] [--dry-run]` | Triages an issue (the given one, the latest RCA-shaped one, or else the oldest open actionable one) by intent against today's code: writes a fix plan, or closes it with evidence. `--dry-run` changes nothing. |

## The workflows

### `brief-to-proposals`

The design half, from a product brief to reviewed docs. Apart from seeding the
pipeline's files and `CLAUDE.md`, it writes design docs only: no code, no commits.

0. **Seed**: `/seed <dir> --from=<pipeline>` copies the pipeline's commands,
   workflows and scripts into the repo and writes a base `CLAUDE.md`; a stop
   (`no_source`, `not_a_repo`, `no_remote`, `dirty_tree`) ends the run with
   `failed_at_seed`.
1. **Intake**: one read of the brief for blocking questions, the ones only you can
   answer whose answer changes the design. Any → the run stops with `needs_input`
   before anything is sketched or written. Pass `on_question: 'assume'` to proceed on
   the recommended answers instead; every later stage then shares them.
2. **Architecture**: three sketches (validation, trust, operations first) are
   scored by a judge and merged into one synthesis, which `/roadmap` builds on to
   write `architecture.md` and `roadmap.md`. Both are reviewed with
   `/review-proposal` and revised with `/propose --revise` until no `bug` or
   `concern` remains, or the run stops before any proposal is written.
3. **Proposals**: `/propose --milestone=N` for each pending code milestone, each
   reviewed and revised the same way. A milestone that needs your answer waits;
   the others carry on.
4. **Consistency**: one pass over every doc for interfaces that disagree, work
   planned twice or not at all, and parts of the brief no doc covers; each is
   revised in the one doc it names, and every revised doc is reviewed again.
5. **Lint**: `proposal-lint.py` on every doc, a preview of each proposal's lanes
   (as if accepted), and the roadmap's next milestones.

Every doc comes out `Status: draft`, for you to read, edit and accept. With
`{ concern }` instead of a brief it skips the architecture and writes one
proposal. On a new repository, you run `/bootstrap` next (Quickstart steps 3-4).
On an existing one, land the seeded pipeline files, the `CLAUDE.md` changes and the
accepted docs through an ordinary PR before building: lanes are cut from `main` and
read the proposal and the commands there.

Every proposal is grounded in the tree as it is when the run writes it, and each
milestone that merges changes that tree. Accept them one milestone at a time:
before accepting each proposal after the first, once the milestones before it have
merged, re-run `/review-proposal <doc>`, which reports a `Files:` path or interface
that no longer matches the tree as a `concern`, and revise on its findings. For a
long roadmap, pass `max_milestones: 1` and propose each later milestone with
`/propose --milestone=N` when it comes up.

### `proposal-build-chain`

Builds an accepted proposal, one PR per lane; each lane runs `plan-to-merged-pr` in
build-only mode, below. Pass `{ proposal, dir, root, date }` and the lanes are
derived from the doc's step list as it is on `origin/main`: steps sharing a `Lane:`
ship together, a lane that depends on or edits the same files as an earlier lane
stacks on it, and lanes with neither form separate chains, which build at the same
time. Each lane ticks its steps in its own commit; a lane that does not push stops
only its chain. Lanes waiting on a human gate, another doc, an earlier roadmap
milestone or the doc's acceptance are reported as blocked, never built (a `Source:`
milestone the lint cannot resolve blocks every lane); lanes already on origin are
not rebuilt. The rules are in [docs/PROPOSALS.md](docs/PROPOSALS.md#lanes-and-chains).
To give the lanes by hand, pass `{ lanes }` ([REFERENCE.md](docs/REFERENCE.md#workflow-args)):
they build in the order given, stopping at the first lane that does not push.

Shipping goes in merge order. A stacked lane's PR must not exist, not even as a
draft, until every PR below it has merged, or a merge bot could merge the unmerged
base commits it carries. Then run `plan-to-merged-pr` with `ship_only: true` and
`predecessor_prs`; it opens nothing until each reads `MERGED`. A derive-mode
result's `ship_plan` lists those args per chain, in merge order, and each chain's
`ship_chain_args` for `ship-chain`, below, which does the sequencing for you.

### `ship-chain`

Ships one chain of a `ship_plan`: pass the chain's `ship_chain_args` (`{ chain }`).
Lane by lane, in merge order:

1. **Lookup**: any PR already opened for the lane's branch. A merged one is
   skipped, a closed one stops the chain; a placeholder title is written from the
   lane's proposal steps (with `title_prefix` in front).
2. **Ship**: `plan-to-merged-pr` in ship-only mode, with `predecessor_prs` filled
   in with the PRs above it as merged: merge check, PR, monitor. A PR an earlier
   run already opened is monitored (monitor-only) instead of opened again.
3. **Wait**: an agent polls the PR until it reads `MERGED`, at most
   `max_wait_rounds` rounds of about 30 minutes (default 48). It never merges,
   approves or enables auto-merge: you merge. Then the next lane ships.

Anything other than `MERGED` stops the chain and names the lane and why: the PR was
closed, it is still open at the wait cap (`not_merged`, with what holds it), the
lane did not ship (`lane_failed`), or a stage asked a question only you can answer
(`needs_input`). Re-run with the same args once you have acted: merged lanes are
skipped, an open PR is picked up where it is. Independent chains can ship at the
same time, one `ship-chain` run each.

### `plan-to-merged-pr`

One concern from a sentence to a PR, then babysit it:

1. **Plan**: `/plan` (medium effort) writes the plan; the branch is cut afterwards
   (or set up first when you pass one).
2. **Implement**: `/impl` (low effort) builds it with tests.
3. **Review / fix until clean**: `/review-changes` (high effort) judged against the
   plan; a fixer (low effort) applies or declines each finding, and the change is
   re-reviewed until no `bug` or `concern` remains (suggestions and nits never
   block). A defect still standing after `max_review_rounds` stops the run.
4. **Polish**: `/polish` until a round finds nothing and the gates are green, at
   most `max_polish` rounds (default 6); if none is clean the run reports
   `polish_clean: false` and the merge check's full gate run still decides.
5. **PR**: commit (ticking the proposal's steps when `proposal_steps` is given),
   merge `origin/main` (and any stacked bases), re-run the gates, then `/create-pr`.
6. **Monitor**: each round observes CI, the AI review check (if you have one),
   conflicts and unanswered comments on the current head, then runs only the steps
   that are needed: `/merge-main`, `/process-comments`, or a CI fix. It stops when
   the PR merges or closes, after two quiet rounds with green CI (on a repo with no
   CI, on the local gates), when CI is red for a reason outside the PR and nothing
   else is actionable, or after `max_monitor_rounds` (default 10). Merging is left
   to a human. A PR handed off still open comes back with `resume_monitor`, the
   monitor-only args to re-run (or [schedule](docs/REFERENCE.md#watching-a-handed-off-pr))
   when it may have moved; given `proposal`, a merged PR's result says in
   `closeout` whether the proposal is now complete on `main` and which close-out
   edits a person should make.

Modes (full, build-only, ship-only, monitor-only) are listed in
[docs/REFERENCE.md](docs/REFERENCE.md#plan-to-merged-pr-modes).

### `bug-fix-backlog`

One lane per issue, or per group of issues that share a code site. Give the lanes
(`{ lanes: [{ key, issues }], root }`), or omit them for the **Intake**: one
read-only agent lists the open issues labelled `bug` (`labels` to change that),
locates the code each points at, groups issues that share a code site into one
lane, and lists the red CI runs on `main`'s latest commits (report only: it never
files, labels, comments on or closes an issue). The run then stops with
`needs_input`, one question whose recommended answer is the proposed lanes; re-run
with the lanes you confirmed or edited, as JSON, in
`answers: [{ id: 'intake.q1', answer }]` to work them
([details](docs/REFERENCE.md#workflow-args)). Each lane runs:

1. **Triage**: `/bug-fix <n> --dry-run` in the lane's own worktree, then one
   combined fix plan for the lane.
2. **Verify** every verdict before acting on it. A *plan* verdict gets a
   **reproducer** (the failing regression test) and a read-only **skeptic**; the
   bug survives on a reproduction, or on a skeptic who could not refute it. A
   *close* verdict needs **two refuters** with different lenses (trace the failure
   path; hunt sibling sites) to both fail: a wrong close is public.
3. **Close** the confirmed-fixed issues, re-checking first that each is still
   open and that no open PR claims it. A refuted close is folded back into the
   plan instead.
4. **Ship** the confirmed bugs through `plan-to-merged-pr`, with the verified plan
   and the already-failing tests, and `Fixes #N` in the PR body.

An issue goes to a human (`needs_human`), never closed and never shipped, when it
is neither reproduced nor survives the skeptic, its reproducer found the behaviour
already correct, triage left it out or gave it conflicting verdicts, its close
verdict has no close comment, its verdict was judged in a worktree that differs
from (close) or is behind (plan) `origin/main`, its close lacked two refuter
reports, or a refuted close could not be re-planned. An issue an open PR already
closes is skipped.

## Worked example

This example is illustrative: the projects, findings and runs are made up to show
the flow.

**A brief.** In a clean clone of a new repository, ask for `brief-to-proposals`
with `{ brief: 'docs/brief.md', dir: '/abs/status-page', pipeline: '/tmp/ccp' }`.
`/seed` installs the pipeline; the judge builds on the validation-first sketch.
`/roadmap` writes the docs in [PROPOSALS.md](docs/PROPOSALS.md#roadmap): the
Bootstrap `ops` gate, the status page, and two `decision` gates. Review round 1 finds
a `concern` (no rollback plan), one revision fixes it, round 2 is clean.
`/propose --milestone=2` writes `01-status-page.md`, reviewed until clean; the
consistency pass finds one coverage gap, which the roadmap revision plans for; the
status is `ready`. You edit the docs, set `Status: accepted`, run
`/bootstrap docs/design/architecture.md`, ship `bootstrap/20261016` with
`{ ship_only: true, branch: 'bootstrap/20261016', title: 'Bootstrap repository' }`,
merge it, protect `main` and tick the Bootstrap gate.

**A proposal, lanes derived.** `docs/design/01-status-page.md` is accepted and on
`main`, its research gate (step 4) done:

```js
{ proposal: 'docs/design/01-status-page.md', dir: '/abs/status-page', root: '/abs/wt', date: '20261016' }
```

Step 2 (post and list incidents) depends on step 1 (store incidents), so they form
the chain `s1 → s2`; step 3, the public page, shares no file with them, so it is its
own chain and builds at the same time; step 6 (email subscribers) waits on the `ops`
gate of step 5, which nobody has ticked yet, so it is reported blocked. Run
`ship-chain` once per chain with its `ship_chain_args`: chain `s3` opens its one PR;
chain `s1` opens `s1`'s PR, waits until you merge it, then ships `s2` with
`predecessor_prs: [<s1's PR>]`.

**One concern**, on an existing TypeScript service whose Pipeline config has
`QUALITY_GATES: npm run lint && npm run typecheck && npm test`. Ask Claude Code:

> Run the plan-to-merged-pr workflow with
> `{ concern: "GET /orders re-reads the price table on every request; cache it per process and invalidate on the price-update webhook", ai_review_check: "AI Code Review" }`

`/plan` writes `~/.claude/plans/plan-cache-price-table.md` (acceptance criteria,
per-file edits, failing tests for the cache and its invalidation, the gate command);
an agent creates `feat/cache-price-table-20261016` and `/impl` builds it. Review
round 1 reports a `bug` (the webhook clears the wrong key) and a `nit`; the fixer
fixes both and round 2 is clean. `/polish` finds nothing, the merge check brings in
two commits from `main` with the gates green, and `/create-pr` opens the PR. The AI
reviewer leaves one suggestion, which `/process-comments` applies and answers with
`Fixed locally …`; CI stays green for two quiet rounds, and the PR is yours to merge.

**A bug backlog**, on the same service.

```js
{ root: '/abs/path/worktrees', date: '20261016',
  lanes: [{ key: 'tz', issues: [212, 230] }, { key: 'retry', issues: [218] }] }
```

Lane `tz` reproduces #212 with a failing test and ships the fix as one PR with
`Fixes #212`. Two refuters fail to find any remaining instance of #230, so it is
closed with the evidence quoted. Lane `retry`'s reproducer runs the code, finds
the behaviour already correct, and puts #218 in `needs_human`.

## Operating rules baked in

- **Only a person accepts a design doc.** No command sets `Status: accepted`.
- **Secrets by name only.** The design docs and `.env.example` name each secret;
  values live in the CI secret store, the host's secret manager or a gitignored
  `.env`.
- **No new repositories or remotes.** Nothing creates a repository or adds a remote:
  `/seed`, `brief-to-proposals` and `/bootstrap` need a clone you made, with an
  `origin` and no uncommitted changes to tracked files (`/seed` lets its own through).
- **Asked, never guessed.** A stage that hits a question only you can answer stops
  (`needs_input`) rather than building on a guess. The result's `relay` tells the
  session that ran it to ask you and re-run with `answers` and `resumeFromRunId`;
  each answer reaches the stage that asked and every later one
  ([details](docs/REFERENCE.md#answering-questions)).
- **A denied action stays denied.** If a permission check refuses something, the
  agent reports it as blocked and does not try another route.
- **No `git stash` in parallel worktrees.** Every worktree of a repo shares one
  stash list. For a before/after check, save the fix as a diff, check out `HEAD` for
  those paths, run the test, then `git apply` the diff.
- **Gates in the foreground, or in the background and watched.** The commands run
  gates in the foreground with a long timeout; inside a workflow, agents run long
  gates in the background, log and watch them, and do not end the turn until done.
- **Gate slots.** When several agents share a machine, route every gate run through
  `.claude/scripts/gate-slot.sh` ([gate wrappers](docs/REFERENCE.md#gate-wrappers)).

## Reference

Workflow args, modes, result statuses, the `proposal-lint.py` command line,
resuming a stopped run, gate wrappers and the state kept in your home directory are
in [docs/REFERENCE.md](docs/REFERENCE.md). The design-doc format (architecture,
roadmap, proposals, human gates, lanes) is in [docs/PROPOSALS.md](docs/PROPOSALS.md).

## License

MIT, see [LICENSE](LICENSE).

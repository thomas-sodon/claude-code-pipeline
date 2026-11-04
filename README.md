# claude-code-pipeline

Turn one sentence describing a change into a review-clean, CI-green pull request:
Claude Code workflows that plan, implement, review, polish, open and babysit the PR,
with every stage run in a fresh session. For a new product, or work bigger than one
PR, it first writes and reviews the design docs, then builds them lane by lane.

[![ci](https://github.com/thomas-sodon/claude-code-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/thomas-sodon/claude-code-pipeline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- demo screenshot goes here -->

Extracted from [maestro-agent](https://github.com/thomas-sodon/maestro-agent)
(see [Why this exists](#why-this-exists)).

## Quickstart

```sh
git clone https://github.com/thomas-sodon/claude-code-pipeline /tmp/ccp
cd your-project && mkdir -p .claude
cp -r /tmp/ccp/.claude/commands /tmp/ccp/.claude/workflows /tmp/ccp/.claude/scripts .claude/
printf '\n## Pipeline config\n\nQUALITY_GATES: npm test\n' >> CLAUDE.md   # your gate command
claude   # then: "Run the plan-to-merged-pr workflow with { concern: '<what to change>' }"
```

Requirements, the full config keys and the example config are in
[docs/REFERENCE.md](docs/REFERENCE.md#install-and-configuration).

### From a brief (greenfield)

```sh
git clone git@github.com:you/my-product.git && cd my-product   # a new, clean repository
cp ~/my-brief.md brief.md
claude   # then: "Run the workflow at /tmp/ccp/.claude/workflows/brief-to-proposals.js with
         #        { brief: 'brief.md', dir: '<absolute path here>', pipeline: '/tmp/ccp' }"
```

Start from a clean clone of the new repository (an empty one, or just the
README and licence a host creates): the pipeline never creates a repository or a
remote.

0. **Seed.** The workflow's first step, `/seed`, installs the pipeline into the
   repository — its skills (`.claude/commands`), workflows and scripts — and writes
   a base `CLAUDE.md` (how work happens here, and a Pipeline config `/bootstrap`
   completes), so every later step and every session opened there runs from files
   installed in the repo. They are committed with the bootstrap branch, before any
   milestone builds. (`/seed <repo> --from=/tmp/ccp` does the same on its own, for
   example to add the pipeline to an existing project.)
1. **Design.** The workflow writes `docs/design/architecture.md`, `roadmap.md` and
   one proposal per code milestone, each reviewed until clean. No code, no commits.
2. **Accept** (you). Read and edit the docs, then set `Status: accepted` on each one
   you approve. `/bootstrap` and the builders refuse a draft (see
   [How it works](#how-it-works)).
3. **Bootstrap.** `/bootstrap docs/design/architecture.md` writes a skeleton whose
   gates pass, `CLAUDE.md` with the Pipeline config, CI, and one commit on a
   `bootstrap/<date>` branch that holds the docs too.
4. **Ship it** (you merge). `plan-to-merged-pr` with `{ ship_only: true, branch,
   title }` opens the bootstrap PR and babysits its CI; you merge it, protect `main`
   and require the CI check, add the secrets by name, and tick the roadmap's
   bootstrap milestone: `/bootstrap` prints the steps. (A repository with no commits
   at all gets a root commit on `main` instead, which you push.)
5. **Build, milestone by milestone.** You do the human gates the next milestone
   waits on; `proposal-build-chain` builds its proposal's lanes; you ship each lane
   in merge order and merge. `proposal-lint.py docs/design/roadmap.md --roadmap`
   names the next milestone.

## The pipeline

```
 Design: a product brief, or work too big for one PR          (brief-to-proposals runs this half)
 brief ──> /roadmap ──────────> /propose ───────────> /review-proposal ──> accept (human)
           architecture.md      --milestone=N: one     + /propose --revise   Status: accepted
           roadmap.md           proposal per           until no bug or
                                milestone              concern
 new repo only:  /bootstrap architecture.md ──> skeleton, CI on a bootstrap branch ──> PR ──> merge (human)

 Build: one concern, or each lane of an accepted proposal     (proposal-build-chain derives the lanes)
 concern ──> 1. Plan ──> 2. Implement ──> 3. Review loop ──> 4. Polish / PR ──> 5. Monitor ──> merge (human)
             /plan       /impl            /review-changes    /polish            CI, AI review,
             grounded    tests first      + fixer until no   gates green,       conflicts, comments
             plan                         bug or concern     /create-pr         until it settles
```

## How it works

- **Fresh session per stage.** Each command runs in its own session, so context
  stays small and the reviewer did not write the code it reviews.
- **Review until clean.** `/review-changes` is judged against the plan and re-run
  after each fix until no `bug` or `concern` remains; a defect still standing stops
  the run before anything is pushed.
- **Gates decide, not the agent.** Your own `QUALITY_GATES` command must be green
  before the PR is opened and again after merging `main`.
- **Docs before code, for big work.** `proposal-lint.py` checks every design doc's
  format and derives the PR lanes from its step list, so the split is deterministic.
- **Drafts are not built.** `proposal-build-chain` derive mode and
  `/plan --proposal` refuse a `Status: draft` doc unless the caller passes
  `allow_draft` (`--allow-draft`), and `/impl <doc>` always does. Explicit lanes and
  direct `plan-to-merged-pr` runs with a `proposal` plan through `/plan --proposal`,
  so they refuse it too. A legacy doc with no `Status:` line is still planned, with a warning.
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
    brief-to-proposals.js     a brief to reviewed architecture, roadmap and proposals; no code
    proposal-build-chain.js   a proposal's lanes, derived from its steps, built as stacked chains
  commands/
    seed.md  roadmap.md  propose.md  review-proposal.md  bootstrap.md
    plan.md  impl.md  review-changes.md  polish.md  create-pr.md
    process-comments.md  merge-main.md  quality-gates.md  bug-fix.md
  scripts/
    proposal-lint.py          design-doc lint, lane derivation and step ticking
    gate-slot.sh              optional host-wide semaphore for gate runs
docs/
  PROPOSALS.md                the design-doc format: architecture, roadmap, proposals
  REFERENCE.md                args, statuses, configuration, state outside the repo
examples/
  CLAUDE.pipeline-config.md   the config section to paste into your CLAUDE.md
```

| Command | Does |
|---|---|
| `/seed <repo> [--from=<pipeline>]` | Installs the pipeline's skills, workflows and scripts into a repository and writes a base `CLAUDE.md` (working rules, a Pipeline config `/bootstrap` completes). Never overwrites, never commits. |
| `/roadmap <brief>` | Turns a product brief (or free text) into draft `architecture.md` and `roadmap.md`: decisions with their options, milestones in validation order, every person-only step a human gate. |
| `/propose <concern>` | Writes one draft proposal: design, security, rollout and a build-ordered list of one-PR steps and human gates. `--milestone=N` for a roadmap milestone; `--revise <doc>` applies review findings. |
| `/review-proposal <doc>` | Read-only review of a design doc against its source, the tree and the architecture; findings as in `/review-changes`. |
| `/bootstrap <architecture.md>` | Greenfield only, in a clean clone with `origin` (no code yet): skeleton, `CLAUDE.md`, CI, gates green, one commit on a `bootstrap/<date>` branch to ship as a PR. Never pushes. |
| `/plan <concern>` | Grounds a free-text concern in today's tree and writes one increment's plan to the plans directory. `--proposal=<doc>` plans that doc's steps. Writes no code. |
| `/impl [plan \| doc]` | Re-validates the plan (or a doc's next buildable step) against the tree, then implements it and runs the gates. Does not commit. |
| `/review-changes [scope]` | Read-only review of the branch's changes; findings are `bug` / `concern` / `suggestion` / `nit`. |
| `/polish` | Fixes what review found, runs the gates, reports how many issues it fixed (0 = clean). |
| `/create-pr` | Commits, pushes, detects issues to close, opens a non-draft PR, with the plan's `## Rollout` as deploy notes. |
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
5. **PR**: commit (ticking the proposal's steps when `proposal_steps` is given),
   merge `origin/main` (and any stacked bases), re-run the gates, then `/create-pr`.
6. **Monitor**: each round observes CI, the AI review check (if you have one),
   conflicts and unanswered comments on the current head, then runs only the steps
   that are needed: `/merge-main`, `/process-comments`, or a CI fix. It stops when
   the PR merges or closes, or after two quiet rounds with green CI. Merging is left
   to a human.

Modes (full, build-only, ship-only, monitor-only) are listed in
[docs/REFERENCE.md](docs/REFERENCE.md#plan-to-merged-pr-modes).

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

### `brief-to-proposals`

The design half, from a product brief to reviewed docs. It writes docs only: no
code, no commits.

1. **Architecture**: three independent sketches (validation first, trust first,
   operations first) are scored by a judge and merged into one synthesis, which
   `/roadmap` builds on to write `architecture.md` and `roadmap.md`. Both are
   reviewed with `/review-proposal` and revised with `/propose --revise` until no
   `bug` or `concern` remains; a defect still standing stops the run before any
   proposal is written.
2. **Proposals**: `/propose --milestone=N` for each pending code milestone, each
   reviewed and revised the same way.
3. **Consistency**: one pass over every doc for interfaces that disagree, work
   planned twice or not at all, and parts of the brief no doc covers; each finding
   and coverage gap is revised in the one doc it names, and every revised doc is
   reviewed again.
4. **Lint**: `proposal-lint.py` on every doc, a preview of each proposal's lanes
   (as if accepted), and the roadmap's next milestones.

Every doc comes out `Status: draft`, for you to read, edit and accept. With
`{ concern }` instead of a brief it skips the architecture and writes one
proposal. On an existing repo, land the accepted docs through an ordinary docs PR
before building: lanes read the proposal from `main`.

### `proposal-build-chain`

Builds an accepted proposal, one PR per lane. Pass `{ proposal, dir, root, date }`
and the lanes are derived from the doc's step list as it is on `origin/main`: steps
sharing a `Lane:` ship together, a lane that depends on or edits the same files as
an earlier lane stacks on it, and lanes with neither form separate chains, which
build at the same time. Each lane runs `plan-to-merged-pr` in build-only mode and
ticks its steps in its own commit; a lane that does not push stops only its chain.
Lanes waiting on a human gate, another doc, an earlier roadmap milestone or the
doc's acceptance are reported as blocked, never built (a `Source:` milestone the
lint cannot resolve blocks every lane); lanes already on origin are not rebuilt. The rules are in [docs/PROPOSALS.md](docs/PROPOSALS.md#lanes-and-chains).

To give the lanes by hand, pass `{ lanes }`: they build in the order given,
stopping at the first lane that does not push.

Shipping stays in your hands, in merge order. A stacked lane's PR must not exist,
not even as a draft someone might ready, until every PR below it has merged,
otherwise a merge bot could merge the unmerged base commits it carries. Once
those merges land, run `plan-to-merged-pr` with `ship_only: true` and
`predecessor_prs`; it refuses to open anything until each one reads `MERGED`.
A derive-mode result's `ship_plan` lists those args per chain, in merge order.

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

**A proposal, lanes derived.** `docs/design/events.md` is accepted and on `main`:

```js
{ proposal: 'docs/design/events.md', dir: '/abs/repo', root: '/abs/wt', date: '20261016' }
```

Step 2 (the writer) depends on step 1 (the event schema), so they form the chain
`s1 → s2`; step 3, a dashboard sharing no file with them, is its own chain and
builds at the same time; step 4 needs a secret from an `ops` gate nobody has ticked
yet, so it is reported blocked. Ship `s1` and `s3` with their `ship_plan` args;
after `s1` merges, ship `s2` with `predecessor_prs: [<s1's PR>]`.

**Lanes by hand.**

```js
{ lanes: [
  { key: 'a', dir: '/abs/wt/a', branch: 'feat/events-a', proposal: 'docs/design/events.md',
    steps: [1, 2], concern: 'Steps 1-2: the event schema and the writer' },
  { key: 'b', dir: '/abs/wt/b', branch: 'feat/events-b', bases: ['feat/events-a'],
    proposal: 'docs/design/events.md', steps: [3], concern: 'Step 3: the reader, on top of the writer' } ] }
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
  through `.claude/scripts/gate-slot.sh`, which gives each run its own CPU slot.
  See [docs/REFERENCE.md](docs/REFERENCE.md#gate-wrappers).

## Reference

Workflow args, modes, result statuses, the `proposal-lint.py` command line,
resuming a stopped run, gate wrappers and the state kept in your home directory are
in [docs/REFERENCE.md](docs/REFERENCE.md). The design-doc format (architecture,
roadmap, proposals, human gates, lanes) is in [docs/PROPOSALS.md](docs/PROPOSALS.md).

## License

MIT, see [LICENSE](LICENSE).

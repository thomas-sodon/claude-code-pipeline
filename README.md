# claude-code-pipeline

Take a new idea from a written brief to merged code with Claude Code. Workflows and
commands write the architecture, the roadmap and one proposal per code milestone,
and review each until clean. Once you accept them, they build a skeleton with green
gates and CI, then each proposal lane by lane: plan, implement, review until clean,
polish, open the PR and babysit it, each stage in a fresh session. You answer the
questions that are yours to decide, accept the docs, do the human-gated steps and
merge. On an existing project the build half also runs alone: one sentence
describing a change becomes a review-clean, CI-green PR.

[![ci](https://github.com/thomas-sodon/claude-code-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/thomas-sodon/claude-code-pipeline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- demo screenshot goes here -->

Extracted from [maestro-agent](https://github.com/thomas-sodon/maestro-agent)
(see [Why this exists](#why-this-exists)).

## Quickstart

Requirements, the full config keys and the example config are in
[docs/REFERENCE.md](docs/REFERENCE.md#install-and-configuration).

### A new product, from a brief

Create the product's repository on GitHub and clone it. If it has no commits, push
one to `main` first (a README is enough): the first branch pushed to an empty
repository becomes its default, so the design branch would, and `/bootstrap` would
then stop with `no_main`.

```sh
git clone https://github.com/thomas-sodon/claude-code-pipeline /tmp/ccp
git clone git@github.com:you/my-product.git ~/my-product   # new: at most a README, licence and .gitignore
cd /tmp/ccp && claude   # then: /start-product ~/ideas/2026-11-05-my-idea.md ~/my-product
```

1. **Start.** `/start-product` takes a brief the `new-software-idea` skill wrote. It
   stops on one that did not pass vetting (`--force` builds it anyway; a brief of
   your own has no verdict and needs it) and on a repository that already holds
   code. The idea skill filled the brief with its own defaults and never asked
   you, so the command asks you first, in one batch and before it writes anything:
   who builds and with what time and money (recommended: Claude Code writes the
   code; you answer its questions, do the human gates and merge); a confirmation
   for each choice the brief made for you (who it is for, the platforms, what is
   free and each price, the licence, the stack, what the first release leaves out,
   the first experiment and when to stop, the open risks, the working name, the
   personal data collected, the accounts opened in your name); who owns the
   repository and whether it is public; and what the state branch keeps: the
   builder framing (recommended: no, local only) and your answers (recommended:
   yes, so a re-run or a new session has them). Then it copies the brief to
   `docs/brief.md` and writes the framing to `docs/builder-context.md`; every
   other answer goes into the next call's `answers`, with its question and date.
   Every design author treats both as binding. The two files stay out of every
   commit; the framing is also saved to the state branch only when you say yes,
   and a no to keeping your answers there puts `save_answers: false` in the call.
   It prints a setup checklist and the next call.
2. **Design.** Start Claude Code in your repository (`cd ~/my-product && claude`)
   and run the call as printed, your `answers` included: the workflow at
   `/tmp/ccp/.claude/workflows/brief-to-proposals.js` with
   `{ brief: 'docs/brief.md', dir: '/abs/my-product', pipeline: '/tmp/ccp',
   context_file: 'docs/builder-context.md', branch: 'design/20261110',
   max_milestones: 1, github_access: 'gh', answers: [...] }` (`'connector'` in a
   Claude Code cloud session). It seeds the pipeline's files and a base
   `CLAUDE.md`, keeps your answers on the state branch (not with
   `save_answers: false`), and asks, in one batch before any design is written,
   the choices that are yours and still open or unconfirmed. With questions it
   stops (`needs_input`): answer them, and re-run with every answer so far and
   `from` set to its `resume_from`. It writes the architecture, the roadmap and the
   first code milestone's proposal, each reviewed until clean, commits them on the
   design branch and pushes it, never `main`. The
   run installs `CLAUDE.md`, the commands and the context guard after this session
   started, so the session loaded none of them: its relay and next steps say to
   read `CLAUDE.md`'s `## How work happens here` then, to hand off by following
   `.claude/commands/handoff.md` before it leaves, and to start every other
   workflow from a new session in the repository, where the workflows run by name.
3. **Accept and land the design** (you). The result lists what nobody confirmed
   with you: its `assumptions`, the decisions no person made (`lint.unconfirmed`)
   and the values an author proposed (`lint.proposed`). Confirm or correct each
   first. A decision you confirm as it stands needs no re-run: its heading tag
   becomes `(person, <date>, edit)`, changed by you or, when you say so, by the
   session. A `(proposed)` value you confirm as it stands has no tag to edit: it
   goes back as an answer like a change (the revise writes it as yours and drops
   the label). What you change goes back as an answer, through `refresh-proposal`
   on the one doc or a re-run of the design run, as the next steps say. Then, on
   the
   design branch, read and edit the docs and set `Status: accepted` on each one you
   approve (`/bootstrap` and the builders refuse a draft). The name and the licence
   are not gates: you were asked before the docs were written, and the
   architecture records them as your decisions. A gate comes before Bootstrap only
   for what needs an outside party or an account (a trademark opinion, a domain
   registration): do and tick it, with its `Outcome:`. When that outcome settles
   another name or licence than the architecture states, revise the architecture
   first (`/propose --revise <architecture>` carries the outcome in) and accept it
   again: `/bootstrap` stops with `architecture_outdated` while the two differ.
   Then merge the branch into `main` through a PR: `/bootstrap` cuts its branch
   from `origin/main`.
4. **Bootstrap.** `bootstrap-repo` with
   `{ architecture: 'docs/design/architecture.md', dir: '/abs/my-product' }` runs
   `/bootstrap` (a skeleton whose gates pass, the completed Pipeline config, CI, one
   commit on `bootstrap/<date>`) and ships that branch as a PR. `/bootstrap` asks
   before it writes anything when a choice the skeleton bakes in is still open (the
   licence's copyright holder, a `LICENSE` of another licence than the
   architecture's, a published name) or was never confirmed with you (a name or
   licence the architecture records as assumed). It reads the answers the design
   run saved, so a choice you already made there is not asked again. The PR body
   lists what it assumed: you check those and correct one with a review comment on
   the PR. Then you merge the PR, protect `main` and require its CI checks (the
   gates and `docs`, which lints the design docs), add the secrets by name and
   tick the roadmap's Bootstrap gate through a docs PR, as its `next_steps` list;
   they also say how the architecture records what you answered here, and offer
   an AI review for the monitor (see *AI review* below).
5. **Build, milestone by milestone.** `python3 .claude/scripts/proposal-lint.py
   docs/design/roadmap.md --roadmap` names the next milestone. Do the human gates
   it waits on, then:
   - **Refresh** a later milestone's proposal once the milestones before it have
     merged: `brief-to-proposals` with the same args plus `from: 'proposals'`,
     `milestones: [N]`, a new `branch` and no `pipeline` writes it, reviewed and
     checked against the docs it builds on; `refresh-proposal` with
     `{ doc, dir, context_file }`, as the design run's next steps print it,
     re-reviews one already written against the tree, your framing and your saved
     answers. Accept it (you) and land it through
     a docs PR.
   - **Build**: `proposal-build-chain { proposal, dir, root, date }` builds its lanes.
   - **Ship**: `ship-chain` with each chain's `ship_chain_args` ships its lanes in
     merge order, one PR at a time, and you merge each. Each PR's body lists what
     its lane assumed (`## Assumptions to review`): read it before you merge, and
     correct a line with a review comment on the PR, which the monitor applies.

Where and how often you are asked along the way, and how to run without being
asked, is in [When you are asked](#when-you-are-asked).

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
and [`answerable-ai-review-replies.yml`](examples/answerable-ai-review-replies.yml) are
the ones this repository runs. Copy both to `.github/workflows/`, add the secret by
name (`gh secret set CLAUDE_CODE_OAUTH_TOKEN` prompts for the value, from
`claude setup-token`), and pass `ai_review_check: 'Review'` to the workflows
(`Review` is the example's review job: in an edited copy or another review
workflow, pass that job's `name:`, or its key under `jobs:` when it has none). It
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
under `adopted`), and one that matches none is `differs`: it may hold your edits, so
it is kept and reported like a conflict (`--update --force` takes upstream's).

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
`{ brief }` or `{ concern }` and `dir` (no `pipeline`: the repo holds it now), and
`branch: 'design/<date>'` to have the docs committed there. It seeds again, and
`/seed` does not count its own uncommitted changes in `.claude/` and `CLAUDE.md` as
a dirty tree, so it runs whether or not the seeded files have landed. Land the
accepted docs (and the seeded files, if still uncommitted) through an ordinary PR,
since lanes read the commands and the proposal from `origin`, then build each
proposal with `proposal-build-chain`.

## The pipeline

```
 Start: a new product, from a vetted brief               (you run it, in the pipeline checkout)
 /start-product brief repo ──> verdict and repo checks ──> one batch of questions ──> docs/brief.md, the framing,
                                                           (builder framing, the      the design call with your
                                                           brief's choices, the repo, answers
                                                           the state branch)

 Design: a brief, or work too big for one PR             (brief-to-proposals runs this half)
 brief ──> /seed ─────> Intake ────────> /roadmap ───────> /propose ───────> /review-proposal ──> consistency ──> accept
           pipeline,    your choices,    sketch panel,     --milestone=N:    + /propose --revise   two docs at    (human)
           CLAUDE.md    asked in one     architecture.md,  one per code      until no bug or       a time, lint
                        batch            roadmap.md        milestone         concern

 Bootstrap: new repo only                                (bootstrap-repo runs it)
 /bootstrap architecture.md ──> asks what the skeleton bakes in and no decision settles ──> skeleton, gates green,
                                CI on bootstrap/<date> ──> ship-only PR ──> merge (human)

 Build: one concern, or each lane of an accepted proposal
        (proposal-build-chain derives the lanes; a lane behind a human gate waits until you tick it)
 concern ──> 1. Plan ──> 2. Implement ──> 3. Review loop ──> 4. Polish / PR ──> 5. Monitor ──> merge (human)
             /plan       /impl            /review-changes    /polish            CI, AI review,
             grounded    tests first      + fixer until no   gates green,       conflicts, comments
             plan                         bug or concern     /create-pr         until it settles

 Ship: one chain of a proposal's built lanes, in merge order  (ship-chain runs this)
 lane 1 ──> ship-only PR + monitor ──> merged (human) ──> lane 2, predecessor_prs filled ──> ... ──> last lane merged
```

Any stage above that meets a choice that is yours stops and returns it as a
question, instead of choosing, and you review what was assumed before you accept a
doc or merge a PR ([When you are asked](#when-you-are-asked)). The full process,
every hand-off between you and the workflows, and the gaps in it are drawn in
[docs/PROCESS.md](docs/PROCESS.md).

## How it works

- **Docs before code.** A new product, or any change bigger than one PR, starts as
  an architecture, a roadmap and proposals, each reviewed until clean.
  `proposal-lint.py` checks their format and derives the PR lanes from each
  proposal's step list, so the split is deterministic.
- **Docs sized to a context.** Each design doc has a budget the lint enforces (an
  architecture 48 KB, a roadmap 24 KB and 20 milestones, a proposal 40 KB and 12
  steps; errors at twice the size, or 20 steps), so an agent that builds a
  milestone reads the architecture, the roadmap and its proposal in about 28k
  tokens. Work that does not fit is split into milestones, not squeezed
  ([details](docs/PROPOSALS.md#size-budgets)).
- **Nothing is built from a draft.** `/bootstrap` and `/impl <doc>` refuse one;
  `proposal-build-chain` derive mode builds only an `accepted` or `in-progress` doc,
  and `/plan --proposal` (run for a `proposal` with the default planner and no
  `plan_text`) stops on `draft` or `done`, unless `allow_draft` is passed
  ([details](docs/PROPOSALS.md#status-lifecycle)).
- **Fresh session per stage.** Each command runs in its own session, so context
  stays small and the reviewer did not write the code it reviews. The session that
  runs the workflows hands off before half its context (below).
- **Review until clean.** `/review-changes` is judged against the plan and re-run
  after each fix until no `bug` or `concern` remains; a defect still standing stops
  the run before anything is pushed. Design docs get the same loop with
  `/review-proposal`.
- **Questions before assumptions.** What only you can answer (your intent, a
  requirement the brief leaves out or states two ways, a trade-off that is yours) is
  asked, never guessed. So is every choice that is yours to make: who the product
  is for, platforms, money and accounts, the licence, personal data, names, the
  repository, stop and go criteria, a provider you must run
  ([the list](docs/PROPOSALS.md#who-decided)). One that already has a value nobody
  confirmed with you, such as a default in a generated brief, is asked as a
  *confirmation*, with that value recommended. A command asks you directly; a
  workflow stops with `needs_input` and returns the questions, each with options
  and a recommendation, so the session that ran it asks you and re-runs with your
  `answers`. Everything else the agents decide is an assumption: listed in the
  result, tagged in the design docs and shown in the PR
  ([When you are asked](#when-you-are-asked)).
- **What you said outranks the brief.** Your framing and your answers replace what
  the brief says on the same point, and no author asks that point again. A brief
  the `new-software-idea` skill wrote was drafted for you: it is never your
  confirmed requirements. Only a newer answer from you changes what you settled:
  an author or reviser with a reason to change it asks, and a reviewer reports a
  doc that departs from it as a `bug`. Each decision in the docs says who made it:
  `(person, <date>)`, `(source)` or `(assumed)`
  ([details](docs/PROPOSALS.md#who-decided)).
- **Gates decide, not the agent.** Your own `QUALITY_GATES` command must be green
  before the PR is opened and again after merging `main`.
- **GitHub through `gh` or the connector.** The PR and issue stages use the `gh`
  CLI or, where it is not logged in (Claude Code cloud sessions), the GitHub MCP
  connector: `GITHUB_ACCESS` in the Pipeline config, or a workflow's
  `github_access`; unset, `gh` when it is authenticated, else the connector
  ([mapping](.claude/scripts/github-access.md)). Pushes stay plain `git`; secrets
  and repository settings stay with you.
- **A human keeps the judgment.** You choose the concern or write the brief (one a
  tool drafted for you is confirmed with you first). You answer the questions,
  accept the design docs, merge the bootstrap PR, do every human-gated
  step (research, decisions, accounts and secrets, releases) and merge. Each
  production release is gated exactly once, in its proposal by default. The
  workflows never force-push, never push to main and never merge.

## When you are asked

A command you run yourself asks in the session, every question in one batch. A
workflow cannot wait mid-run: the stage that needs you stops, the result has
`status: 'needs_input'` with the questions (each with why it matters, options and a
recommendation), and its `relay` tells the session how to ask you and how to
re-run. Each stage returns all its questions in one pass and builds nothing on a
guess, and an answered question is not asked again.

| Where | What you are asked | How often |
|---|---|---|
| `/start-product` | the builder framing; a confirmation for each choice the brief made for you, the working name, the personal data collected and the accounts opened in your name included; the repository's owner and visibility; what the state branch keeps (the framing, your answers) | once, in one batch, before it writes anything |
| Design run: Intake | every choice that is yours and that the brief, your framing and your answers leave open or unconfirmed, such as how long personal data is kept and who receives it where the brief is silent, or an account the design turns out to need | once, before anything is written; nothing when all of it is settled |
| Design run: architecture panel | a decision the sketches chose differently, or a choice that is yours, that nothing you said settles | at most once; the re-run builds on the saved synthesis |
| Design run: authors and revisers (`/roadmap`, each milestone's `/propose`, every `/propose --revise`, Consistency), and `refresh-proposal`'s reviser | what only surfaces while writing: something that makes what you said impossible to follow, a review finding only you can settle, a part of the brief no milestone plans | only when it arises, one batch per stage; a milestone that asks waits while the others carry on |
| Before you accept a doc | to confirm or correct the result's `assumptions`, the decisions no person made (`lint.unconfirmed`) and the values an author proposed (`lint.proposed`). A decision confirmed as it stands only has its tag changed to `(person, <date>, edit)`; a `(proposed)` value you confirm, and what you change, goes back as an answer | once per design result, and after each `refresh-proposal` |
| `bootstrap-repo` | what the skeleton bakes in and neither a decision of yours nor an answer the design run saved settles: the licence's copyright holder, a `LICENSE` of another licence than the architecture's, the licence when there is none, a published name, and, as confirmations, a name or licence the architecture records as assumed | once, before the first write; often nothing. Again only when the install or a gate shows a decision of yours cannot hold as written |
| A lane (`plan-to-merged-pr`): plan, implement, review fix, polish, merge check | a choice the plan, the docs and your answers do not settle (money or an account in your name, a new service that receives data, a change to what the product promises, a licence, a name); a fix that changes behaviour the plan does not call for; a merge conflict neither side's intent decides | only when it arises; a lane asks nothing when its plan and docs settle the work |
| The PR monitor | a reviewer's request that contradicts the plan or what you settled; red CI where the plan does not say whether the test or the code is right; a merge conflict that is your call | only when it arises |
| Each PR | its body's `## Assumptions to review`: what the lane assumed and what you answered. You correct an assumed line with a review comment on the PR, which the monitor applies | every PR that has the section, before you merge (a lane that assumed nothing and was given no answer has none) |
| `bug-fix-backlog` | to confirm or edit the lanes its Intake proposes, which also allows closing in public the issues found already fixed (`close: false` only reports them) | once per run; then as any lane |

**Answering.** The session asks you (it never answers for you), then re-runs the
workflow as the relay says, with `answers`: each question's id and text, your answer
and the date, added to every answer given before. A decision you make outside a
question, and an assumption you correct, is passed the same way, under the id the
relay names; its number is the next one not yet in use, because an id is never
reused for another question. One exception: a run that builds nothing (it only
ships or monitors a PR) would apply no such correction, so you leave it as a
review comment on the PR, and the monitor applies it. A design run also saves the
answers, and what its Intake took as given, to the state branch
(`design/answers.json`) and restores what a re-run does not pass, so they outlive
the session; with `save_answers: false` it saves and restores neither, and every
re-run is passed every answer so far. `/handoff` records them too
([details](docs/REFERENCE.md#answering-questions)).

**Running without being asked.** Pass `on_question: 'assume'` to a workflow: each
stage then takes the option it recommends (in a conflict with what you said, what
you said) instead of stopping, and lists it in the result's `assumptions`; a design
author also tags the decision `(assumed)` in the doc. You review them before you
accept or merge. It is your choice to make: the relays, and the working rules
`/seed` writes into `CLAUDE.md`, tell the session never to add it on its own to
get past a `needs_input`. Three things are never assumed: the lanes
`bug-fix-backlog`'s Intake proposes; your consent to keep the builder framing or
your answers on the state branch (`/start-product` on assumptions takes both as
no); and a `/start-product` question that recommends no option (the licence, when
the repository holds a file of another one), which stays open for the design run
to ask.

## Context and handoffs

The session that runs the workflows and relays their questions hands off to a fresh
one before its context passes half the window, and never compacts. The work runs in
workflow agents that return compact results (`bootstrap-repo` and
`refresh-proposal` exist so `/bootstrap` and a doc's re-review do too).

- **The guard.** `.claude/settings.json` registers `.claude/scripts/context-guard.py`
  as the status line and five hooks (`/seed` copies it, or reports what to merge
  into yours). They act only in a session that orchestrates: one that has run a
  workflow (a Workflow tool call), or has `PIPELINE_ORCHESTRATOR=1`. There, at 40%
  of the window (`PIPELINE_HANDOFF_PCT`), the status line reads
  `ctx NN% · handoff due`, each tool result says to start no new work and run
  `/handoff`, the turn cannot end until a handoff is recorded, and the first
  auto-compaction is blocked. A session that runs no workflow (an ordinary coding
  session, a `claude -p` run) and a subagent are never told to hand off, and under
  CI (`CI` or `GITHUB_ACTIONS` set: a review bot, say) the guard does nothing,
  unless `PIPELINE_ORCHESTRATOR=1`. The hooks never fail a session;
  `PIPELINE_CONTEXT_GUARD=off` turns the guard off (in the `env` of
  `.claude/settings.local.json`, or a cloud environment's variables). A cloud
  session runs the repository's hooks only when that is its one repository (and
  not a project's thread): with several attached, run `/handoff` yourself
  ([details](docs/REFERENCE.md#the-context-guard)).
- **`/handoff`** saves `STATE.md` (where things stand, the runs in flight with their
  exact args, the questions waiting on you, each answer you gave with its question
  and date, the standing rules you set for the work, the assumptions nobody has
  reviewed, the exact next action) to the state branch, `pipeline/state` on origin,
  which also keeps each lane's plan, the review ledgers, the design panel's
  synthesis and the answers a design run was given, with what its Intake took as
  given (`design/answers.json`), so none of it is lost with a container. The
  branch never holds the brief or a secret. It holds the builder context
  (`context/builder-context.md`) only when you consented, and a design run's
  answers unless you declined (`save_answers: false`: the handoff then records
  them by id and date only, and the next session asks you for them). A new
  container needs the brief copied back, and the builder context too unless it
  restores from there; the handoff says which, and from where. Run it
  in the product repository: it and the guard act on the repository the session
  runs in.
- **Continuing.** Start a new session in the repository and say "Continue from the
  pipeline handoff". The SessionStart hook points it at `STATE.md`, quotes its next
  action and says what comes first: to follow your standing rules and to put the
  open questions and the assumptions to review to you, in one batch. What you say
  about an assumption goes where the assumption lives: the tag of a design doc's
  decision, an answer to the next run, or a review comment on the PR. The session
  then passes the workflow it runs next the recorded answers that belong to it (an
  answer one lane or one doc asked goes back to that lane or doc only). No run
  needs `resumeFromRunId` for this: a
  design run starts again at `from` (its `resume_from`) on the docs its branch
  holds, a lane continues from its saved plan (`plan_ref`), and a missing checkout
  is recreated from origin
  ([details](docs/REFERENCE.md#resuming-in-this-session-or-a-new-one)).

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
  settings.json               the context guard: its status line and hooks
  workflows/
    brief-to-proposals.js     a brief to reviewed architecture, roadmap and proposals; no code
    bootstrap-repo.js         /bootstrap, then its branch shipped as a PR, in subagents
    refresh-proposal.js       one design doc re-reviewed against today's tree and revised until clean
    proposal-build-chain.js   a proposal's lanes, derived from its steps, built as stacked chains
    ship-chain.js             one built chain shipped in merge order, each PR once the one below merged
    plan-to-merged-pr.js      the engine: a concern, a lane or the bootstrap branch to a watched PR
    bug-fix-backlog.js        triage + adversarial verification + ship, per bug lane
  commands/
    seed.md  start-product.md  roadmap.md  propose.md  review-proposal.md  bootstrap.md
    plan.md  impl.md  review-changes.md  polish.md  create-pr.md
    process-comments.md  merge-main.md  quality-gates.md  bug-fix.md  handoff.md
  scripts/
    proposal-lint.py          design-doc lint, size budgets, who decided each D-record, lane derivation, step ticking, CLAUDE.md drift check
    context-guard.py          the status line and hooks that have the orchestrating session hand off
    pipeline-state.py         save and read state files on the pipeline/state branch of origin
    github-access.md          which GitHub access a run uses (gh or the MCP connector) and each gh operation's connector call
    gate-slot.sh              optional host-wide semaphore for gate runs
    pipeline-sync.py          install / update the pipeline's files in a repo (3-way, via a manifest)
    claude-md-base.md         the CLAUDE.md "How work happens here" template /seed writes and sync compares
docs/
  PROCESS.md                  the end-to-end process diagram, and the known gaps in the flow
  PROPOSALS.md                the design-doc format: architecture, roadmap, proposals, size budgets
  REFERENCE.md                args, statuses, configuration, the context guard, the state branch
examples/
  CLAUDE.pipeline-config.md   the config section to paste into your CLAUDE.md
  pipeline-update.yml         a scheduled GitHub Action that opens a PR updating the pipeline
  docs-lint-job.yml           the CI job /bootstrap writes to lint the design docs, for an existing repo
  answerable-ai-review.yml    an AI review GitHub Action for the PR monitor (ai_review_check: 'Review')
  answerable-ai-review-replies.yml  its reply gate, re-run when a finding is answered; copy both
ci/                           checks: workflow syntax; every skill and flag the workflows call
                              exists, and every command a workflow tells how to ask defines
                              the needs_input stop; the workflows stop on blocking questions
                              and route the answers; design runs resume and compare docs in
                              pairs; shipping passes plans by reference; the wrappers return
                              compact results; the GitHub access reaches prompts and child
                              runs; the tests of the lint, the sync, the state branch and the
                              context guard; every example design doc in README, docs and
                              commands lints clean
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
| `/start-product <idea-brief> <repo-dir> [--force] [--dry-run]` | From a pipeline checkout: checks a `new-software-idea` brief's verdict (`--force` skips it) and that the repository is new and clean, then asks you in one batch, before it writes anything, what the brief chose for you: the builder framing, a confirmation for each product choice (the working name, the personal data and the accounts the brief implies included), the repository's owner and visibility, and what the state branch keeps (the framing, your answers). Then copies the brief to `docs/brief.md`, writes the framing to `docs/builder-context.md`, and prints a setup checklist and the `brief-to-proposals` call, with your answers as its `answers` (and `save_answers: false` when you keep them off the state branch). Both files stay out of commits; with your consent the framing is also saved to the state branch, its only push. Never commits. |
| `/roadmap <brief> [--out=DIR] [--force] [--dry-run]` | Turns a product brief (or free text) into draft `architecture.md` and `roadmap.md`: the choices that are yours asked in one batch before writing, decisions with their options and who decided each, milestones in validation order, every person-only step a human gate. |
| `/propose <concern>` | Writes one draft proposal: design, security, rollout and a build-ordered list of one-PR steps and human gates. `--milestone=N` for a roadmap milestone; `--revise <doc>` applies review findings and never changes a decision you made; also `--out=DIR`, `--slug=`, `--dry-run`. Asks as `/roadmap` does. |
| `/review-proposal <doc> [--roadmap]` | Read-only review of a design doc against its source, the tree and the architecture (with `--roadmap`, against the whole roadmap too); findings as in `/review-changes`. A doc that changes what you settled is a `bug`; a choice of yours that nobody confirmed, or that is parked in a gate, is a `concern`. |
| `/bootstrap <architecture.md> [--dry-run]` | Greenfield only, in a clean clone with `origin` (no code yet): skeleton, `CLAUDE.md`, CI, gates green, one commit on a `bootstrap/<date>` branch to ship as a PR (or, when the remote has no commits, the root commit on local `main`, which you push). Asks before its first write what the skeleton bakes in and neither a decision of yours nor an answer the design run saved settles, a decision recorded as assumed included; a run that stopped before its commit is resumed. Never pushes. |
| `/plan <concern>` | Grounds a free-text concern in today's tree and writes one increment's plan to the plans directory, with what it assumed under `## Assumptions`. `--proposal=<doc>` plans that doc's steps (`--allow-draft` for a draft); also `--slug=`, `--no-switch`, `--dry-run`. Writes no code. |
| `/impl [plan \| doc]` | Re-validates the plan (or a doc's next buildable step) against the tree, then implements it and runs the gates. Keeps what the plan lists as assumed, and follows what it records as answered. Does not commit. |
| `/review-changes [uncommitted \| committed[:<base>] \| all[:<base>]]` | Read-only review of the branch's changes; findings are `bug` / `concern` / `suggestion` / `nit`. |
| `/polish [--fix-suggestions]` | Fixes what review found, runs the gates, reports how many issues it fixed (0 = clean). A fix that changes behaviour the plan does not call for, or that is your call, is asked first. |
| `/create-pr [<hint>] [--no-issue] [--base=<branch>]` | Commits, pushes, detects issues to close, opens a non-draft PR, with the plan's `## Rollout` as deploy notes and what was assumed under `## Assumptions to review`, for you to correct with a review comment. |
| `/process-comments [<pr> [<comment-id>]]` | Fixes or declines every unresolved review thread (including outdated ones), pushes, then replies to each with a terminal marker. A reviewer's request that contradicts the plan or what you settled is neither applied nor declined: you are asked. Your comment that corrects a choice nobody confirmed (an assumed line of `## Assumptions to review`) is applied like any other request. Never resolves threads or merges. |
| `/merge-main` | Merges the latest main (never rebases), resolves conflicts using the originating plan, runs gates, pushes. A conflict neither the plan nor either side's intent decides is asked, never picked. |
| `/quality-gates [fix \| check \| no-commit \| no-ci]` | Runs the project's gates plus the failure class of any gate check the PR's CI is red on, fixes failures at the root, commits and pushes. Never gets green by changing what a test asserts or a gate itself unless the plan calls for it: otherwise it asks. |
| `/bug-fix [<n> \| --rca] [--dry-run]` | Triages an issue (the given one, the latest RCA-shaped one, or else the oldest open actionable one) by intent against today's code: writes a fix plan, or closes it with evidence. A fix that needs a choice only you can make is asked before the plan is written. `--dry-run` changes nothing and asks nothing: it prints the question. |
| `/handoff [--note=<text>]` | Writes `STATE.md` (where things stand, runs in flight with their args, open questions, your answers with their question and date, your standing rules, assumptions to review, the exact next action) to the state branch, records it for the context guard, and says how to continue in a new session. |

## The workflows

### `brief-to-proposals`

The design half, from a product brief to reviewed docs. Apart from seeding the
pipeline's files and `CLAUDE.md`, it writes design docs only, never code. It commits
only when given `branch`, and then only on that design branch.

0. **Seed**: with `branch` (e.g. `design/20261110`), the checkout first switches to
   it: origin's branch when it exists, else a new one from `origin/main`.
   `/seed <dir> --from=<pipeline>` then copies the pipeline's commands, workflows
   and scripts into the repo and writes a base `CLAUDE.md`; a stop (`no_source`,
   `not_a_repo`, `no_remote`, `dirty_tree`) ends the run with `failed_at_seed`.
   Last, an agent notes which design docs exist, reads the answers an earlier run
   saved on the state branch (`design/answers.json`) and checks that `context_file`
   exists, restoring it from the state branch when you chose to keep it there; one
   that is missing and cannot be restored ends the run with `failed_at_start`,
   before any design agent runs. The saved answers the run was not passed are
   restored (`answers_restored`), and, in a run that starts past the Intake, what
   an earlier Intake took as given. An id is never reused: one passed for another
   question than its saved answer holds also ends the run with `failed_at_start`
   (`answer_id_reused`). The run saves its answers back once (`answers_saved`):
   after the Intake, with what the Intake took as given, or right after this step
   when it skips the Intake. With `save_answers: false` neither is saved or
   restored. The run starts at the stage the docs and your answers call for
   (*Re-running*, below).
1. **Intake**: one read of the brief, going through the choices that are yours class
   by class, for blocking questions (the ones only you can answer whose answer
   changes the design) and confirmations (a choice of yours whose value nobody
   confirmed with you: the brief's own, when the brief was drafted for you). Any →
   the run stops with `needs_input`, all of them in one batch, before anything is
   sketched or written. What the Intake takes as given instead, never a choice
   that is yours, is listed in `assumptions` and handed to every later author, who
   keeps it or asks. An Intake that does not report ends the run
   (`failed_at_intake`) before anything is designed. Pass `on_question: 'assume'`
   only when you choose to proceed on the recommended answers; every later stage
   then shares them.
2. **Architecture**: three sketches (validation, trust, operations first) are
   scored by a judge and merged into one synthesis, saved on the state branch. The
   judge asks too: when the sketches differ on a decision that nothing you said
   settles, the run stops once the synthesis is saved, and the re-run builds on it.
   `/roadmap` then writes `architecture.md` and `roadmap.md` from the synthesis.
   Both are reviewed with `/review-proposal` and revised with `/propose --revise`
   until no `bug` or `concern` remains; when findings still stand, the run stops
   before any proposal is written and returns the choices you have (another pass,
   answer the findings that are yours, or go on). When the two docs exist already,
   the answers they do not reflect yet are applied first, then their review
   resumes.
3. **Proposals**: `/propose --milestone=N` for each pending code milestone, each
   reviewed and revised the same way. A milestone that needs your answer waits;
   the others carry on, and the result names apart (`also_needs_attention`) any
   proposal that failed or did not come back clean, which your answers alone do
   not fix. When the docs existed already, only the milestones whose proposal is
   not written yet are proposed, or exactly the ones `milestones` lists (after a
   milestone's question, the relay names the ones that asked). The result lists
   the pending milestones left without a proposal (`not_proposed`), and a next
   step says how to write them.
4. **Consistency**: the docs are compared two at a time, so no agent holds the
   whole design: the architecture with each proposal, the proposals of two
   milestones where one builds on the other, and the brief with the roadmap for
   coverage. Each finding is revised in the one doc it names, and every revised doc
   is reviewed again. A part of the brief that no milestone plans is planned, or
   put to you as a question: leaving it out is your choice, and the roadmap then
   records it.
5. **Lint**: `proposal-lint.py` on every doc, a preview of each proposal's lanes
   (as if accepted), the roadmap's next milestones, and what nobody confirmed with
   you: the decisions tagged `(assumed)` or not tagged (`lint.unconfirmed`) and the
   values an author proposed (`lint.proposed`). The next steps say to show you
   these, with the run's `assumptions`, before a doc is accepted, and how each
   comes back: a decision you confirm as it stands by an edit of its tag; a
   `(proposed)` value you confirm, and what you change, as an answer.

Every doc comes out `Status: draft`, for you to read, edit and accept. With
`{ concern }` instead of a brief it skips the architecture and writes one
proposal. `context_file` names a file, such as `/start-product`'s
`docs/builder-context.md`, that every author treats as binding framing: like your
answers, it replaces what the brief says on the same point. A framing
`/start-product` took without you (a run on assumptions) is not your word yet: the
Intake asks it again, as one confirmation.

**Checkpoints.** With `branch`, the docs written so far, the seeded `.claude` files
and `CLAUDE.md` are committed on it after Architecture, Proposals and Consistency,
and pushed, so the drafts outlive the session; the brief and the context file never
are. Land the branch on `main` through a PR before `bootstrap-repo` or a build: both
start from `origin/main`.

**Re-running.** A re-run keeps the docs already written, from this session or a new
one (with `branch`, from any clone), and starts at `from` (`intake`,
`architecture`, `proposals`, `consistency` or `lint`): a `needs_input` result names
it in `resume_from`, and without it the run infers it from your answers and the
docs on disk ([how](docs/REFERENCE.md#re-running-a-design-run)). `force` still
regenerates everything; a re-run keeps it only until `/roadmap` has written the
docs again, and the relay and the next steps say which holds. With
`max_milestones: 0` the run writes and reviews the architecture and the roadmap and
no proposal, a stop to confirm them first; with `max_milestones: 1`, a re-run with
`from: 'proposals'` writes the next proposal once the milestones before it have
merged, grounded in the tree they left. The cap applies to the default set only: a
`milestones` list is never cut by it. In a new checkout or container, point `dir`
at the new checkout, and `pipeline` at the pipeline's checkout there until the
checkout holds the seeded files. Proposals written ahead go stale as those
milestones merge: run `refresh-proposal` on each before accepting it.

### `bootstrap-repo`

`/bootstrap`, then `plan-to-merged-pr` ship-only on its `bootstrap/<date>` branch,
in subagents, so the skeleton, the installs and the gate runs never reach the
session that runs it. Pass `{ architecture, dir }` once the architecture is accepted
and on `main` and the gates Bootstrap depends on, if any, are ticked; you merge the
PR. `/bootstrap` collects its questions before its first write (the licence's
copyright holder, a `LICENSE` of another licence than the architecture's, a
published name no decision settles, and, as confirmations, a name or licence the
architecture records without your confirmation): the run then stops with
`needs_input` and nothing is written. It reads the answers the design run saved
on the state branch, and asks nothing one of them settles. What it assumed goes
into the PR body and the first next step, for you to check before you merge: you
correct one with a review comment on the PR, which the monitor applies. An empty
remote gets the root commit on local `main` instead (`root_commit`), which you
push. The result keeps the PR, a one-line
final state, `resume_monitor` and `/bootstrap`'s other next steps; a re-run finds
the commit and an open PR instead of making them twice, and resumes a run that
stopped before its commit (red gates, a question) on the branch it left.

### `refresh-proposal`

One design doc re-reviewed against today's tree, in subagents: pass `{ doc, dir }`,
with `dir` a checkout of `main`, and `context_file` when the design run had one
(its next steps print the call). `/review-proposal <doc>` and `/propose --revise
<doc>` alternate until no `bug` or `concern` remains (else `findings_remain` after
`max_review_rounds`, default 3), then `proposal-lint.py` checks the doc and
previews a proposal's lanes. It edits only that doc and commits nothing; findings
about other docs are listed, never applied. It follows what you settled as the
design run does: every review and revise reads your framing and the answers the
design run saved on the state branch, a reviser never changes a decision you made,
a finding only you can settle stops the run with `needs_input`, and an answer
passed in `answers` is applied to the doc and tagged `(person, <date>, <id>)`,
which is also how you correct a written doc. The lint lists the doc's unconfirmed
decisions and proposed values, to review before you accept it; a decision you
confirm as it stands needs no re-run, only its tag changed to
`(person, <date>, edit)`, while a `(proposed)` value you confirm goes back as an
answer, like a change. A revise resets
`Status:` to draft: re-accept the doc and land it through a docs PR. Use it before
accepting a proposal written ahead of its milestone, after a gate's `Outcome:`
changes what a doc plans, or whenever a doc may have gone stale.

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

A lane that stops on a question carries it up into this result, tagged with the
lane's key. Re-run with the same args plus `answers`, each with its `lane` (an
array: a map cannot name a lane), and the result's `assumptions`: lanes already
pushed are not rebuilt, and the lane that asked continues from the plan it saved
instead of planning again (`replan: true`, or the lanes' keys, plans again, for
when your answer is to plan the work differently; it is for one run, and the relay
says what the next re-run passes). A derive-mode result lists every built lane's
`assumptions` at the top level, and any answer given for a lane the run does not
have (`answers_unused`).

Shipping goes in merge order. A stacked lane's PR must not exist, not even as a
draft, until every PR below it has merged, or a merge bot could merge the unmerged
base commits it carries. Then run `plan-to-merged-pr` with `ship_only: true` and
`predecessor_prs`; it opens nothing until each reads `MERGED`. A derive-mode
result's `ship_plan` lists those args per chain, in merge order, and each chain's
`ship_chain_args` for `ship-chain`, below, which does the sequencing for you. Each
lane saves its plan to the state branch when its planning ends and again at its
merge check, so those args carry a reference to it (`plan_ref`), not its text.

### `ship-chain`

Ships one chain of a `ship_plan`: pass the chain's `ship_chain_args` (`{ chain }`).
Lane by lane, in merge order:

1. **Lookup**: any PR already opened for the lane's branch. A merged one is
   skipped, a closed one stops the chain; a placeholder title is written from the
   lane's proposal steps (with `title_prefix` in front).
2. **Ship**: `plan-to-merged-pr` in ship-only mode, with `predecessor_prs` filled
   in with the PRs above it as merged: merge check, PR, monitor. A PR an earlier
   run already opened is monitored (monitor-only) instead of opened again; an open
   draft is readied instead (ship-only with `existing_pr`), as nobody can merge one.
3. **Wait**: an agent polls the PR until it reads `MERGED`, at most
   `max_wait_rounds` rounds of about 30 minutes (default 48). When a round finds
   the PR open and needing action (your comment with no reply after it, requested
   changes, a conflict, a red check), the lane's monitor runs again, at most three
   times per lane; after that the wait only reports. It never merges, approves or
   enables auto-merge: you merge. Then the next lane ships.
4. **Close-out**: once the last PR has merged, the result's `closeout` says whether
   the proposal is now complete on `main` and lists the close-out edits
   (`Status: done`, the milestone tick) for you to make in a docs PR.

Anything other than `MERGED` stops the chain and names the lane and why: the PR was
closed, it is still open at the wait cap (`not_merged`, with what holds it), the
lane did not ship (`lane_failed`, with the stage, the reason and the blocking
findings), or a stage asked a question only you can answer (`needs_input`: re-run
with `answers`, each with its `lane`; an assumption you correct is a review
comment on that lane's PR, never an answer, since a chain builds nothing). Re-run
with the same args once you have
acted: merged lanes are skipped, an open PR is picked up where it is. Nothing is
carried but references, so a re-run works from a new session: each lane's plan
comes from the state branch, and a lane checkout a new container lacks is recreated
from origin. Independent chains can ship at the same time, one `ship-chain` run
each.

### `plan-to-merged-pr`

One concern from a sentence to a PR, then babysit it:

1. **Plan**: `/plan` (medium effort) writes the plan; the branch is cut afterwards
   (or set up first when you pass one). The plan is saved to the state branch when
   planning ends, so a re-run of the same branch continues from it instead of
   planning again; `replan: true` plans again, for that one run.
2. **Implement**: `/impl` (low effort) builds it with tests.
3. **Review / fix until clean**: `/review-changes` (high effort) judged against the
   plan; a fixer (low effort) applies or declines each finding, and the change is
   re-reviewed until no `bug` or `concern` remains (suggestions and nits never
   block). A defect still standing after `max_review_rounds` stops the run.
4. **Polish**: `/polish` until a round finds nothing and the gates are green, at
   most `max_polish` rounds (default 6); if none is clean the run reports
   `polish_clean: false`, with what the last round left unfixed
   (`polish_unfixed`), and the merge check's full gate run still decides.
5. **PR**: commit (ticking the proposal's steps when `proposal_steps` is given),
   merge `origin/main` (and any stacked bases), re-run the gates, then `/create-pr`.
   The merge check saves the plan to the state branch again, now ending with
   `## Assumptions to review` (what the stages assumed and what you answered), so
   later ship-only and monitor-only runs read it from there (`plan_ref`) instead of
   carrying it. The PR body shows the same section: correct an assumed line with
   a review comment on the PR before you merge, and the monitor's comment step
   applies it.
6. **Monitor**: each round observes CI, the AI review check (if you have one),
   conflicts and unanswered comments on the current head, then runs only the steps
   that are needed: `/merge-main`, `/process-comments`, or a CI fix. Each of the
   three returns a question when the step is your call (a conflict neither side's
   intent decides; a reviewer's request that contradicts the plan or what you
   settled; a red test where the plan does not say whether the test or the code is
   right), and the answer goes to a monitor-only re-run. It stops when the PR
   merges or closes, after two quiet rounds with green CI (on a repo with no CI, on
   the local gates), when CI is red for a reason outside the PR and nothing else is
   actionable, or after `max_monitor_rounds` (default 10). Merging is left to a
   human. A PR handed off still open comes back with `resume_monitor`, the
   monitor-only args to re-run (or [schedule](docs/REFERENCE.md#watching-a-handed-off-pr))
   when it may have moved, your answers among them; given `proposal`, a merged PR's
   result says in `closeout` whether the proposal is now complete on `main`. When
   it is: the close-out edits a person should make, and the milestone to tick with
   the Acceptance to check first. When it is not: each step still pending, by
   title, a human gate with what you have to do.

Every stage from Plan to the merge check, and each monitor step, can stop the run
with `needs_input`; the choices a stage made instead of asking are in the result's
`assumptions` and reach every later stage, the saved plan and the PR body (a
re-run from a new session passes them back as `assumptions`, as the relay says).
Modes
(full, build-only, ship-only, monitor-only) are listed in
[docs/REFERENCE.md](docs/REFERENCE.md#plan-to-merged-pr-modes).

### `bug-fix-backlog`

One lane per issue, or per group of issues that share a code site. Give the lanes
(`{ lanes: [{ key, issues }], root }`), or omit them for the **Intake**: one
read-only agent lists the open issues labelled `bug` (`labels` to change that),
locates the code each points at, groups issues that share a code site into one
lane, and lists the red CI runs on `main`'s latest commits (report only: it never
files, labels, comments on or closes an issue). The run then stops with
`needs_input`, one question whose recommended answer is the proposed lanes. The
question also says what confirming them allows: an issue found already fixed is
closed in public (pass `close: false` to have such issues only reported, with the
prepared close comment). Re-run with the lanes you confirmed or edited, as JSON, in
`answers: [{ id: 'intake.q1', answer }]` to work them
([details](docs/REFERENCE.md#workflow-args)). Each lane runs:

1. **Triage**: `/bug-fix <n> --dry-run` in the lane's own worktree, then one
   combined fix plan for the lane. A question the dry run prints for you is kept
   in that plan as an open choice, never decided there: the lane's implement stage
   returns it.
2. **Verify** every verdict before acting on it. A *plan* verdict gets a
   **reproducer** (the failing regression test) and a read-only **skeptic**; the
   bug survives on a reproduction, or on a skeptic who could not refute it. A
   *close* verdict needs **two refuters** with different lenses (trace the failure
   path; hunt sibling sites) to both fail: a wrong close is public.
3. **Close** the confirmed-fixed issues, re-checking first that each is still
   open and that no open PR claims it. A refuted close is folded back into the
   plan instead.
4. **Ship** the confirmed bugs through `plan-to-merged-pr`, with the verified plan
   and the already-failing tests, and `Fixes #N` in the PR body, which also lists
   what the lane assumed and any fix no failing test reproduced first. A lane
   that stops on a question is answered through `plan-to-merged-pr`, never by
   re-running this workflow: with the lane's `resume_args` plus `answers`, or its
   `resume_monitor` once its PR is open, as the lane's `relay` says.

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

**A brief.** `/start-product ideas/2026-10-15-status-page.md /abs/status-page`
finds the verdict passed and asks its batch. You keep the drafted builder framing,
accept the brief's choices except the price (you lower it), keep the framing local
and your answers on the state branch. It copies the brief to `docs/brief.md`,
writes the framing and prints the call with your answers.
In a session in that repository, `brief-to-proposals` runs with
`{ brief: 'docs/brief.md', dir: '/abs/status-page', pipeline: '/tmp/ccp',
context_file: 'docs/builder-context.md', branch: 'design/20261016', max_milestones: 1,
answers: [{ id: 'intake.d1', ... }, ...] }`.
`/seed` installs the pipeline, and the Intake stops the run with two questions the
brief does not settle: how long subscriber emails are kept, and which provider
receives them. You answer, and the re-run passes `intake.q1` and `intake.q2` with
the
earlier answers, and `from: 'intake'`. The judge builds on the validation-first
sketch. `/roadmap` writes the docs in [PROPOSALS.md](docs/PROPOSALS.md#roadmap): the
Bootstrap `ops` gate, the status page, and two `decision` gates, each decision
tagged with who made it. Review round 1 finds a `concern` (no rollback plan), one
revision fixes it, round 2 is clean. `/propose --milestone=2` writes
`01-status-page.md`, reviewed until clean; the consistency pairs find one coverage
gap, which the roadmap revision plans for; the status is `ready`, with the docs
pushed on `design/20261016`. The result lists one decision tagged `(assumed)` and
one `(proposed)` value. You confirm the decision as it stands, so its tag becomes
`(person, 2026-10-16, edit)`, and you change the value: it goes back as
`architecture.d1` in a re-run with `from: 'architecture'` and `max_milestones: 0`,
without `milestones`, which revises the docs and writes no further proposal. You
then set
`Status: accepted` on each doc and merge the branch into `main` through a PR.
`bootstrap-repo`
with `{ architecture: 'docs/design/architecture.md', dir: '/abs/status-page' }` opens
the `bootstrap/20261016` PR; you merge it, protect `main` and tick the Bootstrap gate.

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
- **The brief stays local.** `docs/brief.md` and `docs/builder-context.md` are kept
  out of every commit: `/start-product` lists them in `.git/info/exclude`, so
  `git add` refuses them unless forced, and no workflow stage stages them. The brief
  never reaches the state branch either. The builder context is saved there
  (`context/builder-context.md`) only with your consent, and then restores from
  there; the run that restores it lists it in the exclude file again. Your answers
  to a design run are saved there (`design/answers.json`) unless you declined
  (`save_answers: false`).
- **No new repositories or remotes.** Nothing creates a repository or adds a remote:
  `/start-product`, `/seed`, `brief-to-proposals` and `/bootstrap` need a clone you
  made, with an `origin` and no uncommitted changes to tracked files (`/seed` lets
  its own through).
- **Asked, never guessed.** A stage that hits a question only you can answer, or a
  choice that is yours, stops (`needs_input`) rather than building on a guess. The
  result's `relay` tells the session that ran it to ask you and re-run with
  `answers` (and `resumeFromRunId`, or for a design run `from` set to its
  `resume_from`, which works from a new session too). In a design run from a brief
  every answer reaches every author and reviewer; elsewhere each reaches the stage
  that asked and every later one
  ([details](docs/REFERENCE.md#answering-questions)).
- **What you settled changes only on your word.** No author, reviser or fixer
  changes an answer, the framing or a decision tagged `(person, …)`: a reason to
  change it is a question for you. A choice you can make now is asked, never left
  in a gate or for acceptance.
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
resuming a stopped run, gate wrappers, the context guard, the state branch and the
state kept in your home directory are in [docs/REFERENCE.md](docs/REFERENCE.md). The
design-doc format (architecture, roadmap, proposals, human gates, lanes, size
budgets) is in [docs/PROPOSALS.md](docs/PROPOSALS.md).

## License

MIT, see [LICENSE](LICENSE).

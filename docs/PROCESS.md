# Process

The whole pipeline as one flow: who does each step (you, a command, a workflow),
what each hand-off carries, and where the flow has gaps. The stages themselves are
described in the [README](../README.md#the-workflows); args and statuses are in
[REFERENCE.md](REFERENCE.md).

## Diagram

Rounded boxes are steps a workflow or command runs; hexagons are steps only a
person does; dashed red boxes are the gaps listed below the diagram.

```mermaid
flowchart TD
  classDef human fill:#fff4d6,stroke:#b8860b,color:#000
  classDef gap fill:#fde8e8,stroke:#c0392b,stroke-dasharray:5 4,color:#000
  classDef stop fill:#eee,stroke:#888,color:#000

  subgraph INSTALL["Install / update (any repo)"]
    clone{{"Clone a repo with origin"}}:::human
    seed("/seed or pipeline-sync.py<br/>.claude files + manifest,<br/>base CLAUDE.md")
    upd("pipeline-sync.py --update<br/>or pipeline-update.yml PR")
    clone --> seed
    seed -. "later" .-> upd
  end

  subgraph DESIGN["Design: brief-to-proposals"]
    intake("Intake: blocking questions?")
    ask{{"Answer questions<br/>re-run with answers"}}:::human
    panel("Architecture panel<br/>3 sketches, judge, synthesis")
    roadmap("/roadmap<br/>architecture.md, roadmap.md")
    rrev("/review-proposal + /propose --revise<br/>until no bug/concern")
    props("/propose --milestone=N<br/>per code milestone, reviewed")
    cons("Consistency pass, lint, lane preview")
    intake -- "needs_input" --> ask --> intake
    intake --> panel --> roadmap --> rrev --> props --> cons
  end

  accept{{"Read, edit, set Status: accepted"}}:::human

  subgraph BOOT["Bootstrap (greenfield only)"]
    bgates{{"Do the gates Bootstrap waits on<br/>(name, licence: tick + Outcome)"}}:::human
    boot("/bootstrap architecture.md<br/>skeleton, CI, gates green,<br/>1 commit on bootstrap/date")
    bship("plan-to-merged-pr ship_only")
    bmerge{{"Merge, protect main,<br/>add secrets, tick Bootstrap gate<br/>via docs PR"}}:::human
    bgates --> boot --> bship --> bmerge
  end

  landdocs{{"Existing repo: land .claude,<br/>CLAUDE.md and docs via PR"}}:::human

  subgraph MILESTONE["Per milestone (lint --roadmap names the next)"]
    hgates{{"Do the human gates it waits on<br/>tick + Outcome; /propose --revise<br/>if the Outcome changes the plan;<br/>re-accept"}}:::human
    chain("proposal-build-chain<br/>derive lanes from origin/main")
    blocked["blocked lanes reported<br/>(gate, doc, milestone, draft)"]:::stop
    shipplan["ship_plan per chain,<br/>in merge order"]:::stop
    hgates --> chain
    chain --> blocked
    chain --> shipplan
  end

  subgraph LANE["Lane engine: plan-to-merged-pr"]
    plan("/plan  grounded plan")
    impl("/impl  tests first")
    review("/review-changes + fixer<br/>until no bug/concern")
    polish("/polish until clean")
    mcheck("merge origin/main, gates,<br/>tick proposal steps, push")
    pr("/create-pr")
    mon("Monitor: CI, AI review,<br/>conflicts, comments")
    plan --> impl --> review --> polish --> mcheck
    mcheck -- "build-only" --> pushed["pushed, no PR"]:::stop
    mcheck -- "full / ship-only" --> pr --> mon
    mon -- "merge-main / process-comments / fix-ci" --> mon
  end

  shiplane{{"After each PR below merges:<br/>run ship_only with predecessor_prs"}}:::human
  merge{{"Review and merge the PR"}}:::human
  closeout{{"Set proposal Status: done,<br/>tick roadmap milestone"}}:::human

  subgraph BUGS["Bugs: bug-fix-backlog"]
    lanes{{"Write lanes by hand<br/>(key, issues)"}}:::human
    triage("/bug-fix --dry-run triage")
    verify("Verify: reproducer + skeptic,<br/>or two refuters")
    close("Close confirmed-fixed issues")
    nh["needs_human"]:::stop
    lanes --> triage --> verify
    verify --> close
    verify --> nh
  end

  seed --> intake
  cons -- "docs, all draft" --> accept
  accept -- "greenfield" --> bgates
  accept -- "existing repo" --> landdocs
  bmerge --> hgates
  landdocs --> hgates
  chain -- "each ready lane, build-only" --> plan
  shipplan --> shiplane --> pr
  mon -- "settled: 2 quiet rounds" --> merge
  merge -- "more lanes" --> shiplane
  merge -- "last lane of the proposal" --> closeout --> hgates
  verify -- "confirmed bug, ship" --> plan
  concern{{"One concern on an existing repo"}}:::human --> plan

  G1["G1 nothing drives the<br/>stacked ship order"]:::gap
  G2["G2 no watch after the<br/>monitor hands off"]:::gap
  G3["G3 close-out is manual<br/>and unprompted"]:::gap
  G4["G4 later proposals go stale<br/>before they build"]:::gap
  G5["G5 design docs not linted<br/>in the product repo's CI"]:::gap
  G6["G6 no AI review is set up<br/>for the monitor"]:::gap
  G7["G7 CLAUDE.md invariants<br/>drift from architecture.md"]:::gap
  G8["G8 no intake from issues<br/>or production to bug lanes"]:::gap
  G9["G9 CLAUDE.md base sections<br/>never update"]:::gap
  G1 -.- shiplane
  G2 -.- merge
  G3 -.- closeout
  G4 -.- props
  G5 -.- hgates
  G6 -.- mon
  G7 -.- boot
  G8 -.- lanes
  G9 -.- upd
```

## Gaps in the flow

Each gap is a hand-off where the flow depends on a person remembering a step that
nothing prompts, or where a check exists in one place but not where the edit
happens. Ordered by how often it bites.

**G1. Nothing drives the stacked ship order.** `proposal-build-chain` builds every
lane and returns a `ship_plan`, but stacked lanes must be shipped one at a time: the
person waits for each PR to merge, then runs `plan-to-merged-pr { ship_only: true }`
with the merged PR numbers filled into the `predecessor_prs` placeholder. With
several chains of three or four lanes, that is a lot of manual sequencing and the
most likely place for a lane to be forgotten.
*Fix:* a `ship-chain` mode (or workflow) that takes one `ship_plan` chain, ships the
first lane, monitors it until it reads `MERGED`, then fills `predecessor_prs` and
ships the next, stopping on anything other than `MERGED`.

**G2. No watch after the monitor hands off.** The monitor stops after two quiet
rounds with green CI, or after `max_monitor_rounds` (default 10), and leaves the PR
to the person. A review comment, a conflict from `main` moving, or CI turning red
after that point is not picked up until someone re-runs monitor-only mode
(`{ pr, branch, dir }`).
*Fix:* document the monitor-only re-run in the hand-off message and in `/create-pr`'s
report; better, a scheduled task that re-runs monitor-only on the pipeline's open
PRs.

**G3. Close-out is manual and unprompted.** When a proposal's last lane merges, a
person must set `Status: done` and tick its roadmap milestone. The lint warns
`milestone_complete_unticked` only when someone runs `proposal-lint.py --roadmap`,
and no workflow knows it just shipped the last lane. Dependants still unblock (a
milestone counts as satisfied once its proposal is complete), so the cost is drift
in the roadmap rather than a stall, but `in-progress` → `done` is never prompted.
*Fix:* have the ship-only result say when every step of the proposal is ticked on
`main`, and print the close-out edits and the next milestone (`--roadmap`'s `next`).

**G4. Later proposals go stale before they build.** `brief-to-proposals` writes a
proposal for every pending code milestone at once. By the time milestone 4 builds,
milestones 2 and 3 have changed the tree, but nothing re-reviews milestone 4's
proposal against today's code; only `/plan` grounds each lane, after the doc is
accepted, so a wrong `Files:` list or a changed interface surfaces as a stalled lane
instead of a review finding.
*Fix:* re-run `/review-proposal <doc>` (it checks the doc against the tree) before
accepting each milestone after the first, or propose only the next milestone
(`max_milestones: 1`) and propose the rest as they come up.

**G5. Design docs are not linted in the product repo's CI.** The pipeline's own CI
lints its examples, but `/bootstrap`'s CI template runs only `QUALITY_GATES`. Every
edit a person makes to the docs (accepting, ticking a gate, writing an `Outcome:`)
lands through a docs PR that nothing checks; a malformed tick shows up later as
`proposal_lint_errors` when a build starts.
*Fix:* add a `docs` job to the CI template that runs `proposal-lint.py` on every doc
in `PROPOSALS_DIR` (and `--roadmap` on the roadmap), and require it on `main`.

**G6. No AI review is set up for the monitor.** The monitor waits for the
`ai_review_check` before counting comments, but neither `/seed` nor `/bootstrap`
installs a reviewer, and the default is none. Without one, the only independent
review is `/review-changes` before the PR; the monitor only reacts to human
comments and CI. This repository runs `answerable-ai-review.yml` on its own PRs but
does not offer it to users.
*Fix:* ship that workflow as an example, have `/bootstrap`'s next steps offer it
(with the secret to add by name), and pass its check name (`Review`) as
`ai_review_check` in the ship plan.

**G7. `CLAUDE.md` invariants drift from `architecture.md`.** `/bootstrap` copies
`## Invariants` and `## Testing` from the architecture into `CLAUDE.md` verbatim.
When the architecture is revised later, `/propose --revise` only reports that
`CLAUDE.md` needs the same change; nothing makes it, and nothing checks the two
agree. Every agent reads `CLAUDE.md`, so a stale copy steers every later lane.
*Fix:* a lint check (in the G5 CI job) that the two bodies match, or keep the rules
only in the architecture and point `CLAUDE.md` at it.

**G8. No intake from issues or production to bug lanes.** `bug-fix-backlog` needs
lanes written by hand (`{ key, issues }`), grouping by shared code site is the
person's job, and nothing routes CI failures on `main`, incidents or user reports
into issues. Releases are deliberately human gates, so there is also no
post-release step at all.
*Fix:* a triage step that lists open bug issues, groups them by the code they touch
and proposes the `lanes` for the person to confirm.

**G9. `CLAUDE.md`'s base sections never update.** Pipeline updates (below) change
the commands, but `## How work happens here`, written once by `/seed`, is never
refreshed, so a repository seeded early keeps the rules of the pipeline it started
with.
*Fix:* mark the section (as the Pipeline config is marked) so a later sync can show
a diff against the current template; until then, compare it by hand after a large
update.

### Fixed: keeping the pipeline current

Before `pipeline-sync.py`, the only update path was `/seed --update` from a fresh
clone. It replaced every differing file, so a local edit to a command was silently
lost; it never deleted a file the pipeline had removed or renamed, so stale commands
stayed callable; and it recorded no version, so a repository could not tell which
pipeline it ran or whether it was behind. `pipeline-sync.py` now records the
installed commit and a hash per file in `.claude/pipeline-manifest.json` and
compares three ways (see [REFERENCE.md](REFERENCE.md#install-and-configuration)), and
[`examples/pipeline-update.yml`](../examples/pipeline-update.yml) opens a weekly PR
with the update. Two parts are still open: the pipeline publishes no release tags,
so `PIPELINE_REF` can only track `main` or pin a commit; and G9 above.

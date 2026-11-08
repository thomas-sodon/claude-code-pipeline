# Design docs

The format of the design docs the pipeline writes, reviews and builds from: the
**architecture** (what to build and how it runs), the **roadmap** (milestones in
validation order) and **proposals** (one per code milestone or large change, with a
build-ordered step list). Back to the [README](../README.md); the lint's command
line is in [REFERENCE.md](REFERENCE.md#proposal-lintpy).

| Doc | Written by | Built by |
|---|---|---|
| `architecture.md` | `/roadmap` | `/bootstrap` (greenfield skeleton) |
| `roadmap.md` | `/roadmap` | nothing directly: each code milestone names a proposal |
| `<NN-slug>.md`, `<slug>.md` | `/propose` | `proposal-build-chain` (lanes), `/impl <doc>` (next step) |

All three live in `PROPOSALS_DIR` (default `docs/design`), are reviewed by
`/review-proposal`, revised by `/propose --revise`, and checked by
`.claude/scripts/proposal-lint.py`. Everything below marked **E** is a lint error
(exit 1); **W** is a warning (exit 0).

## Common rules

**Kind.** The first `# ` heading sets the kind: `# Proposal: <title>`,
`# Roadmap: <title>` or `# Architecture: <title>`. Anything else is linted as a
proposal (W `no_kind`).

**Header lines** sit between the title and the first `## ` heading, one
`Key: value` each. HTML comments in a value are ignored.

- `Status:` — `draft`, `accepted`, `in-progress` or `done` (any other value E
  `bad_status`; missing W `missing_status`).
- `Source:` — what the doc answers: a brief's path, `roadmap.md#N` (a proposal for
  milestone N, path relative to the proposal), or `concern`. A proposal's `Source:`
  that names a roadmap milestone the lint cannot resolve (the file is unreadable or
  not a roadmap, it has no milestone N, or the header says `roadmap.md, milestone 2`
  instead of `roadmap.md#2`) is W `source_unresolved`, and `--lanes` blocks every
  lane until it resolves (`milestone_unresolved`): a typo never skips the roadmap's
  gates.
- `Architecture:` — the architecture doc, relative to this doc (proposals and roadmaps).

Cross-doc refs (`Source:`, `<file>.md#N`, `Proposal:`) resolve from the doc's
directory; lint a draft kept outside the repo with `--as <its real path>`.

**Sections that do not apply** stay, with `none: <why>` or `n/a: <why>` as their
body, so a reader sees the question was asked.

**Code fences** (```` ``` ```` or `~~~`) are skipped, so a doc can quote steps
without the lint counting them.

**Secrets and personal data.** Docs are committed and shared: secrets and env vars
appear by NAME only, never a value; no names, addresses, emails, phone or account
numbers. Examples and fixtures are synthetic or redacted.

### Status lifecycle

| Status | Set by | Builds |
|---|---|---|
| `draft` | `/roadmap` and `/propose`, on every write and every revise | nothing: `--lanes` blocks every lane (`proposal_not_accepted`), `/plan --proposal` and `/impl` stop (`doc_not_accepted`), `/bootstrap` stops (`not_accepted`) |
| `accepted` | a person, after reading and review | lanes build; `/impl` takes the next step; `/bootstrap` runs |
| `in-progress` | a person, once building has started | lanes build; `/propose` keeps every pending step's number ([protected](#ticking)) |
| `done` | a person, when every step is ticked | nothing from `--lanes` (it blocks every lane) or `/plan --proposal` (`doc_not_accepted`); `/impl <doc>` checks only for `draft`, so tick every step before setting `done` |

Only a person sets anything other than `draft`. A revise of an accepted doc resets
it to `draft`, so a person re-accepts what changed. `proposal-build-chain` and
`plan-to-merged-pr` take `allow_draft: true` (`/plan --proposal=<doc> --allow-draft`)
to build a draft anyway; `/impl <doc>` never does. A doc with no `Status:` line is
still planned by `/plan --proposal` and `/impl <doc>`, with a warning; `--lanes`
blocks every lane of it (`proposal_not_accepted`, `Status: missing`) unless
`--allow-draft`. In `plan-to-merged-pr` the check is `/plan --proposal`'s, so a run
given `plan_text`, or a `planner` other than `plan`, builds without it.

## Steps and milestones

A proposal's `## Steps` and a roadmap's `## Milestones` share one grammar:

```md
1. [ ] **Title.** One to three sentences on what changes.
   - Files: `src/a.ts` (new), `src/b.ts`
   - Depends on: none
   - Acceptance: what a test, a command or an observable state shows
```

- **Step line**, at column 0: `N. [ ] **Title.** description` (`[x]` or `[X]` when
  done). A numbered line that does not match is E `malformed_step`.
- **Numbers** run 1, 2, 3 in document order (E `step_numbering`, E `duplicate_step`).
- **Sub-bullets** `- Key: value`, indented three spaces (two to six are accepted, so
  steps 10 and up may use four). Keys are case-insensitive; a key twice in one step
  is E `duplicate_key`, an unknown key W `unknown_key`. An indented line that is not
  a sub-bullet continues the previous value, or the description.
- **Size.** More than 8 files, or more than about 7 sentences of description, is W
  `step_too_big`: one step is one focused PR.

| Key | On | Rule |
|---|---|---|
| `Depends on:` | every step and milestone | **required** (E `missing_depends`): `none`, or comma-separated refs |
| `Acceptance:` | every step and milestone | code: required (E `missing_acceptance`); gate: say what evidence closes it (W) |
| `Files:` | code steps | required (E `missing_files`); backticked repo-relative paths (E `files_format`), ` (new)` on files the step creates |
| `Lane:` | code steps | optional lane key, `^[a-z0-9][a-z0-9-]{0,30}$` (E `bad_lane`) |
| `Human gate:` | person-only steps | `<kind> — <what a person does>` (below) |
| `Outcome:` | ticked gates | what the gate found or decided; written by the person who ticks it |
| `Proposal:` | roadmap code milestones | the proposal file, relative to the roadmap |

### Depends on

`none` makes independence explicit: a step that left it out could be built straight
past a pending gate. Otherwise each ref is:

- `N` — a step of this doc. It must exist (E `unknown_dependency`), be
  lower-numbered (E `forward_dependency`: document order is build order) and not be
  the step itself (E `self_dependency`). A ticked step that depends on an unticked
  one is E `done_before_dependency`.
- `<file>.md#N` — step `N` of another doc, path relative to this doc's directory.
  A doc that exists without step N is E `xref_missing_step`; a doc that cannot be
  read yet is W `xref_unreadable` (a later milestone's proposal may not be written).
  A proposal step may depend on a roadmap gate milestone this way
  (`roadmap.md#3`: the privacy sign-off its release needs); it is satisfied once
  ticked.

A step that needs a gate's result, or uses what another step creates (a module,
table, endpoint or secret), must depend on it. Otherwise the lane builder may build
the two in parallel.

### Code steps

A step with no `Human gate:` is a code step: one independently mergeable PR that
leaves the tree working, with its tests in the same step. A risky change goes behind
a flag that defaults to today's behaviour; a migration expands and contracts across
steps; a new check starts non-enforcing and the last migration step enforces it. A
file the architecture's Repository layout names is cited without `(new)` (Bootstrap
creates it) unless its entry says `(from milestone N)`. With `--repo DIR`, the lint checks `Files:` against the tree: a modified file
that does not exist and no earlier step creates is W `file_not_found` (an earlier
proposal may create it); a `(new)` file that already exists is W `new_file_exists`.

`Lane:` groups code steps that cannot merge apart (each would break the tree alone);
they ship as one PR. Prefer splitting. A lane may not hold a gate (E `gate_in_lane`)
and should not mix ticked and unticked steps (W `lane_mixed`).

## Human gates

A step only a person can do is a gate: `Human gate: <kind> — <text>` instead of
`Files:` (E `gate_with_files`). The separator may be ` — `, ` – `, ` -- `, ` - ` or
`:`; the kind must be one of (E `bad_gate`):

| Kind | For |
|---|---|
| `research` | data a person gathers: interviews, real samples, measurements, a provider's written answer. What public sources can settle is desk research in a Decision instead, with links and the date checked. |
| `decision` | go / no-go, legal or compliance sign-off, a choice the person owns |
| `ops` | accounts, domains, DNS, provider and billing setup, secrets (by NAME, per environment), bootstrapping the repository |
| `release` | production deploys, publishing a package or tagged version, store submissions, flag flips, observation windows |

A gate sits right after the code it follows; its `Acceptance:` names the evidence
that closes it. The pipeline never does a gate: lanes that depend on one stay
blocked until a person ticks it.

**Release ownership.** Each production release, package or tag publish, store
submission or launch is gated exactly once. By default it is a `release` gate in the proposal whose code it
ships, right after that code; it is a roadmap `release` milestone instead only when
one launch ships several milestones' work together, and then the proposals have no
gate for it. Never both. A release gate depends on each roadmap gate milestone it
needs (a legal sign-off, the `ops` milestone that provisions the accounts) as
`<roadmap>.md#N`.

### Outcome and conditional work

When the person ticks a gate they add `- Outcome: <what was found or decided>`.
A ticked `research` or `decision` gate without one is W `gate_without_outcome`; an
`Outcome:` on a code step is W `outcome_on_code_step`.

There is no conditional syntax. When later steps depend on what a gate finds:

1. `## Design` describes each alternative.
2. The steps that differ carry `Depends on: <gate>`, so they stay blocked, and are
   written for the alternative the evidence currently favours, saying so.
3. After the person records the Outcome and ticks the gate, `/propose --revise <doc>`
   rewrites those steps, the Design and the Decision to the chosen alternative.

## Proposals

`# Proposal: <title>`, the header lines, then these sections (a missing one is W
`missing_section`, except `## Steps`, which is E, as is an empty one, E `no_steps`):

| Section | Holds |
|---|---|
| `## Context` | what is wrong or missing, why it matters, the end state |
| `## Goals` / `## Non-goals` | for a milestone: its exit criteria |
| `## Current state` | today's tree, cited by path and symbol; greenfield: `No code yet` |
| `## Design` | components, interfaces, data model, data flow, trust boundaries; each alternative for conditional work |
| `## Decisions` | `### D1: <decision>` with Options (two or more), Choice, Why, Consequences, Revisit if |
| `## Security and privacy` | what the change could let go wrong (data exposure, weakened safety or permission rules, supply-chain or release integrity, untrusted input); data classes, where personal data lives and for how long, encryption, third parties and what they receive, secrets by NAME; or `none: <why>` |
| `## Rollout and operations` | how the change reaches its users (deploy, package or tag publish, store submission, users copying or upgrading files) and compatibility for installed copies; environments, config and secret NAMES, migrations, flags, monitoring, rollback, launch gates; or `none: <why>` when nothing reaches anyone |
| `## Risks and open questions` | each with its mitigation and the step that retires it |
| `## Steps` | the step list |
| `## Out of scope` | later milestones, adjacent work |

A step may not carry `Proposal:` (W `proposal_in_steps`). Example, shown as a person
left it after accepting it and doing the research gate:

````md
# Proposal: Public status page

Status: accepted
Source: roadmap.md#2
Architecture: architecture.md

## Context

Milestone 2: teams post incidents and anyone can read them, so we learn whether teams use the page.

## Goals

- A signed-in member posts an incident; it appears on the public page within a minute.

## Non-goals

- Custom domains and paid plans (later milestones).

## Current state

The bootstrapped skeleton: `apps/api/src/index.ts` exports `health()`; no routes or tables yet.

## Design

An `incident` table and two API routes (post, list). Confirmed subscribers get an email per incident; an RSS feed was the alternative until step 4 settled it.

## Decisions

### D1: Notification channel

- Options: email to confirmed subscribers; an RSS feed.
- Choice: email (step 4's Outcome).
- Why: four of five pilot teams asked for email.
- Consequences: a `MAIL_API_KEY` secret and a subscriber table.
- Revisit if: bounce rates make email unreliable.

## Security and privacy

Subscriber emails: personal, stored in Postgres, sent only to the email provider, deleted on unsubscribe.

## Rollout and operations

Migrations `001` and `002` are additive. Secrets `DATABASE_URL` and `MAIL_API_KEY` in staging and production. Rollback: redeploy the previous build; the tables stay.

## Risks and open questions

- Email deliverability: step 6 alerts on failed sends.

## Steps

1. [ ] **Store incidents.** The incident table and its model.
   - Files: `apps/api/migrations/001_incidents.sql` (new), `apps/api/src/incidents.ts` (new), `apps/api/test/incidents.test.ts` (new)
   - Depends on: none
   - Acceptance: `incidents.test.ts` creates, lists and resolves an incident against a test database
2. [ ] **Post and list incidents.** Routes for signed-in members to post and for anyone to list.
   - Files: `apps/api/src/routes.ts` (new), `apps/api/src/incidents.ts`, `apps/api/test/routes.test.ts` (new)
   - Depends on: 1
   - Acceptance: an anonymous POST returns 401; a member's POST is listed by the next GET
3. [ ] **Render the public page.** Show open incidents, newest first.
   - Files: `apps/web/src/page.ts` (new), `apps/web/test/page.test.ts` (new)
   - Depends on: none
   - Acceptance: `page.test.ts` renders a fixture feed with open incidents first
4. [x] **Ask pilot teams how they want updates.** Email or RSS.
   - Human gate: research — ask five pilot teams; record their answers (redacted) under docs/research/
   - Depends on: none
   - Acceptance: five answers recorded
   - Outcome: four of five chose email; build email
5. [ ] **Provision the email provider.** Account and sending domain.
   - Human gate: ops — create the provider account; add `MAIL_API_KEY` to staging and production by name
   - Depends on: none
   - Acceptance: a staging test send succeeds with the secret
6. [ ] **Email subscribers on a new incident.** Confirmed subscribers get one email per incident.
   - Files: `apps/api/migrations/002_subscribers.sql` (new), `apps/api/src/notify.ts` (new), `apps/api/test/notify.test.ts` (new)
   - Depends on: 2, 4, 5
   - Acceptance: `notify.test.ts` sends one email per confirmed subscriber; a failed send raises the send-failure alert
7. [ ] **Launch.** First production release.
   - Human gate: release — deploy to production and post a test incident
   - Depends on: 3, 6, roadmap.md#3
   - Acceptance: the test incident is visible in production and was emailed to the team's own address

## Out of scope

- Custom domains, paid plans and the go / no-go (roadmap milestones 4 and later).
````

## Roadmap

`# Roadmap: <product>`, the header lines (`Status:`, `Source:`, `Architecture:`),
a short paragraph on the ordering, then `## Milestones` (E `missing_section` /
`no_steps`) in the step grammar:

- A **code milestone** names `Proposal: <file>.md` (E `missing_proposal`), relative to
  the roadmap, and has `Acceptance:` (its exit criteria). A pending one whose file
  does not exist yet is W `proposal_not_written` (`/propose --milestone=N` writes it).
- A **gated milestone** has `Human gate:` and no `Proposal:` (E `gate_with_proposal`).
- No `Files:` (E `files_in_roadmap`) and no `Lane:` (the lint does not reject one on a
  milestone): those belong to proposal steps.
- Order: on a greenfield repo the Bootstrap `ops` gate comes before any code
  milestone. Only the `decision` or `research` gates whose outcome the skeleton bakes
  in (a name, namespace or licence) precede it, and it depends on them; `/bootstrap`
  stops (`bootstrap_gates_pending`) until each is ticked with an `Outcome:`. Then
  the source's cheapest validation, a `decision` gate applying its stop criteria (not
  its success criteria; a threshold the source does not give is labelled proposed),
  and everything that result could cancel after it. Every legal check, account or secret, release
  and store submission is a gate; a release is a roadmap milestone only when one
  launch ships several milestones' work (see *Release ownership*).

A code milestone is **complete** when its proposal exists and every step in it is
ticked. `--roadmap` reports each milestone's progress and the next actionable ones
(pending, every dependency ticked or complete), and warns when a milestone is
ticked but its proposal is not complete (W `milestone_ticked_incomplete`) or the
other way round (W `milestone_complete_unticked`).

````md
# Roadmap: Status page

Status: accepted
Source: docs/brief.md
Architecture: architecture.md

Ship the public page first: it is the cheapest test of whether teams use it.

## Milestones

1. [x] **Bootstrap the repository.** Green skeleton, CLAUDE.md and CI from architecture.md.
   - Human gate: ops — run /bootstrap architecture.md, ship and merge its bootstrap branch, protect main and require the `gates` and `docs` checks
   - Depends on: none
   - Acceptance: CI green on main; main protected
   - Outcome: bootstrap PR merged; CI green at 3f2c1ab; main protected
2. [ ] **Public status page.** Teams post incidents; anyone reads them.
   - Proposal: 01-status-page.md
   - Depends on: 1
   - Acceptance: an incident posted by a signed-in member appears on the public page within a minute
3. [ ] **Approve the privacy notice.** Subscriber emails are personal data.
   - Human gate: decision — a qualified person approves the privacy notice and the consent wording
   - Depends on: none
   - Acceptance: approved text linked from the Outcome
4. [ ] **Go / no-go.** Apply the brief's stop criterion.
   - Human gate: decision — continue only if 20 teams post an incident within 60 days of launch
   - Depends on: 2, 3
   - Acceptance: the Outcome records the count and the decision
````

## Architecture

`# Architecture: <product>`, `Status:` and `Source:`, then twelve required sections
(each missing one is E `missing_section`; one that does not apply says `n/a: <why>`), and no step list (W `unexpected_steps`):

| Section | Holds |
|---|---|
| `## Context` | product, users, constraints; greenfield: `No code yet` |
| `## System overview` | one paragraph and a diagram of components, data flow, trust boundaries |
| `## Components` | per component: responsibility, technology, interfaces, directory |
| `## Data model` | entities, key fields, data class, where each lives, retention |
| `## Decisions` | D-records, each weighing two or more options |
| `## Security and privacy` | data classes, encryption, auth, secrets, third parties, retention, threats, compliance items and the milestone that clears each |
| `## Invariants` | bullets, each an enforceable rule; `/bootstrap` copies them verbatim into `CLAUDE.md`, and `--claude-md` checks the copy |
| `## Repository layout` | the directory tree `/bootstrap` scaffolds; an entry marked `(from milestone N)` is left to that milestone |
| `## Quality gates` | the three lines below, which `/bootstrap` parses |
| `## Environments and deployment` | environments, CI/CD, secrets and env vars by NAME, migrations, monitoring, backups, rollback, release process |
| `## Testing` | layers, frameworks, mocking, coverage, fixture policy; copied verbatim into `CLAUDE.md`, and `--claude-md` checks the copy |
| `## Risks and open questions` | each with impact, mitigation and the milestone that retires it |

`## Quality gates` names the commands in this form (CI job default `gates`):

```md
- QUALITY_GATES: `npm run lint && npm run typecheck && npm test`
- QUALITY_GATES_FAST: `npm run lint && npm test`
- CI job: `gates`
- Required checks: `ios-build`, `android-build`
```

The fourth line is optional: the CI checks beyond the gates job that must also be
green to merge — what the agent's Linux host cannot run (a build or test on another
OS, a device, browser or hardware target). A matrix job reports one check per
entry: name one aggregating job that needs them all. Pass the same names as `required_checks`; each check's job is added
by a proposal step the roadmap plans.

````md
# Architecture: Status page

Status: accepted
Source: docs/brief.md

## Context

Small teams want a public status page they can update in seconds. No code yet; one part-time builder.

## System overview

A web page reads incidents from an API backed by Postgres; only signed-in team members write.

```
browser ──> web (static) ──> api ──> Postgres
team member ──(session)──> api
```

## Components

- `apps/api`: incidents and subscribers; TypeScript, Fastify.
- `apps/web`: the public page; static build served by the host's CDN.

## Data model

- `incident(id, title, state, created_at)`: public; kept forever.
- `subscriber(id, email, confirmed_at)`: personal; deleted on unsubscribe.

## Decisions

### D1: Data store

- Options: managed Postgres (backups included); SQLite on the app host (free, backups are ours).
- Choice: managed Postgres.
- Why: one part-time builder must not run backups (brief: team constraint).
- Consequences: a `DATABASE_URL` secret per environment.
- Revisit if: hosting cost exceeds the brief's margin target.

## Security and privacy

Subscriber emails are the only personal data: stored in Postgres, encrypted at rest by the host, sent only to the email provider.

## Invariants

- No personal data in logs, error messages or analytics (enforced by the logger's redaction test).
- Fixtures are synthetic; a recorded sample needs a provenance note beside it (review).

## Repository layout

```
apps/api/     API package (package.json, src/, test/)
apps/web/     public page (package.json, src/)
docs/design/  design docs
.github/workflows/ci.yml
```

## Quality gates

- QUALITY_GATES: `npm run lint && npm run typecheck && npm test`
- QUALITY_GATES_FAST: `npm run lint && npm test`
- CI job: `gates`

## Environments and deployment

Staging (deployed on every push to main) and production (promoted by a person). Secrets by name: `DATABASE_URL`, `MAIL_API_KEY`, in the host's secret manager; locally in a gitignored `.env`. Migrations run before deploy, expand then contract. Rollback: redeploy the previous build.

## Testing

Unit tests per package with Vitest; the network and the clock are mocked; one smoke test per package. Fixtures are synthetic, never real subscriber data.

## Risks and open questions

- Teams may prefer RSS to email: retired by proposal 01's research gate.
````

## Lanes and chains

`proposal-build-chain` (derive mode) does not guess how to split a proposal: it runs
`proposal-lint.py <doc> --lanes` on the doc as it is on `origin/main` and builds
what that returns. The derivation:

1. **Lanes.** Every pending code step is buildable. Steps sharing a `Lane:` key form
   one lane; every other step is its own lane, keyed `s<N>`. Gates and ticked steps
   are never in a lane.
2. **Order.** Lane L comes after lane K when a step of L depends on a step of K, or
   L shares a file with K and K's first step is earlier. A cycle in this order is E
   `lane_cycle`, checked over every lane, blocked or not, so a draft's
   `--lanes --allow-draft` preview, or a doc whose lanes all wait on a gate, reports
   it before anyone builds.
3. **Blocked.** A lane is blocked, and never built, while any reason below holds;
   blocking spreads to every lane that comes after a blocked one, until nothing
   changes. Ticked steps always satisfy a dependency.
4. **Chains.** The unblocked lanes split into chains: groups connected by the order
   in 2. Each chain is put in dependency order (ties go to the lowest step number);
   its key is its first lane's. Separate chains share no file and no dependency, so
   they build at the same time.
5. **Stacking.** Within a chain each lane is built on every earlier lane: its
   `bases` are their branches, in chain order, so the last base contains the others.
   Each stacked PR waits until every PR below it has merged.
6. **Names.** `slug` = the doc's file name without `.md`, lowercased, with each run of
   other characters turned into `-`. Branch `feat/<slug>-<lane>-<date>` (prefix and date are
   args; date default `undated`); worktree `<root>/<slug>-<lane>`.
7. **Already built.** Given the remote's branch list, a lane whose branch
   `feat/<slug>-<lane>-<suffix>` already exists, where the suffix is this run's date
   or has no `-` or `/` (so lane `api` never matches `api-v2-…`), is `already_built`:
   it is not rebuilt, and later lanes still stack on it. The greatest match wins.
8. **Concern.** Each lane's concern for `/plan --proposal` reads
   `Steps 3, 4 of <doc>: <title>; <title>. Implement exactly these steps — their description, Files and Acceptance criteria — as one increment.`

The example proposal above gives two chains: `s1 → s2` (step 2 depends on step 1 and
shares `incidents.ts`) and `s3` on its own. Lane `s6` is blocked on the ops gate 5;
the release gate 7, the milestone's one release, is listed as pending, waiting on
steps 3 and 6 and the roadmap's privacy sign-off (`roadmap.md#3`).

Lanes are derived afresh on every run: steps whose PRs merged are ticked on main and
drop out, and a gate a person ticked unblocks its lanes.

### Blocking reasons

Each blocked lane lists what it waits on (`waiting_on`), each with a reason:

| Reason | The lane waits on |
|---|---|
| `proposal_not_accepted` | the doc's `Status:` is not `accepted` or `in-progress` (without `--allow-draft`); every lane gets it |
| `human_gate` | a pending gate in this doc |
| `pending_external` | a pending (or missing) step of another doc, via `<file>.md#N` (a roadmap gate milestone included) |
| `blocked_lane` | a lane it comes after, which is blocked |
| `milestone_gate` | a pending gated milestone that its roadmap milestone (`Source: roadmap.md#N`) depends on |
| `milestone_pending` | a code milestone its roadmap milestone depends on, whose proposal is not complete |
| `milestone_unresolved` | nothing it can check: the doc's `Source:` names a roadmap milestone that cannot be resolved (W `source_unresolved`); fails closed, every lane gets it |

The output also lists every pending gate (`human_gates_pending`), each with
`ready` (every dependency is ticked: a person can do it now) and what it still
waits on.

## Ticking

A tick (`[ ]` → `[x]`) records that a step landed. Run
`python3 .claude/scripts/proposal-lint.py <doc> --tick N[,N...]`: it changes only
those checkboxes, byte for byte, and accepts gates and milestones too.

- **Code steps** are ticked in the PR that implements them, so the tick lands on main
  with the code. `proposal-build-chain` passes each lane's steps as
  `proposal_steps`, and `plan-to-merged-pr` ticks them in the lane's own commit. After
  `/impl <doc>`, tick step `M` in the same PR yourself.
- **Gates** are ticked by the person who did them, with an `Outcome:`. On a repo whose
  main is protected, that edit lands through an ordinary docs PR.
- **Milestones.** A person ticks a gated milestone when it is done, and a code
  milestone once its proposal is complete. A milestone counts as satisfied for its
  dependants when it is ticked or its proposal is complete.
- **Ticked steps are frozen.** `/propose --revise` never changes a ticked step: its
  number, title, description and sub-bullets stay byte-identical. A pending step
  whose lane branch is already built is frozen the same way; a change to its work
  goes into a follow-up step after the last step.
- **Protected step numbers** rest on facts, not on a status someone must remember
  to set. Every pending step keeps its number when the doc has any ticked step, has
  ever been accepted (its `Status:` now, or its git history), or is referenced by
  another doc (`Depends on:` or `Source:`), and a step whose lane branch is built
  keeps its number too; new steps then go after the last step.
  To retire a pending step there, keep its number and turn it into
  `Human gate: decision — superseded by step M; tick to retire`, with no `Files:`
  or `Lane:`.

## Lint codes

| Code | | Meaning |
|---|---|---|
| `malformed_step` | E | a numbered line in the list is not `N. [ ] **Title.** …` |
| `duplicate_key` | E | a step repeats a sub-bullet key |
| `step_numbering`, `duplicate_step` | E | numbers are not 1, 2, 3 in document order |
| `missing_depends` | E | no `Depends on:`, or an empty one |
| `bad_dependency` | E | a `Depends on:` ref is not `N` or `<file>.md#N` |
| `unknown_dependency`, `forward_dependency`, `self_dependency` | E | a same-doc ref to a missing, later or the same step |
| `done_before_dependency` | E | a ticked step depends on an unticked one |
| `xref_missing_step` | E | the other doc has no step N |
| `missing_files`, `files_format` | E | a code step without backticked `Files:` |
| `missing_acceptance` | E / W | no `Acceptance:` on a code step (E) or a gate (W) |
| `bad_gate`, `gate_with_files`, `gate_in_lane` | E | a malformed gate, or one with `Files:` or `Lane:` |
| `bad_lane` | E | a lane key outside `[a-z0-9][a-z0-9-]{0,30}` |
| `bad_status` | E | `Status:` is not one of the four values |
| `missing_section`, `no_steps` | E / W | a required section, or the step list, is missing or empty (W for a proposal's other sections) |
| `missing_proposal`, `gate_with_proposal`, `bad_proposal`, `files_in_roadmap` | E | roadmap milestone rules |
| `lane_cycle` | E | `--lanes`: `Lane:` groups, dependencies and shared files form a cycle (over every lane, blocked or not) |
| `not_a_proposal`, `not_a_roadmap`, `not_an_architecture` | E | `--lanes` on a non-proposal, `--roadmap` on a non-roadmap, `--claude-md` on a non-architecture |
| `claude_md_drift` | E | `--claude-md`: `CLAUDE.md`'s `## Invariants` or `## Testing` body differs from the architecture's, or is missing (blank lines at either end, and one pointer line naming `architecture.md` first or last under `## Invariants`, are ignored) |
| `no_kind`, `missing_status`, `unknown_key` | W | see *Common rules* and *Steps* |
| `step_too_big` | W | more than 8 files or about 7 sentences |
| `lane_mixed` | W | a lane mixes ticked and unticked steps |
| `gate_without_outcome`, `outcome_on_code_step` | W | see *Outcome* |
| `xref_unreadable` | W | a `<file>.md#N` doc cannot be read |
| `source_unresolved` | W | a proposal's `Source:` names a roadmap milestone that cannot be resolved; `--lanes` blocks every lane (`milestone_unresolved`) |
| `file_not_found`, `new_file_exists` | W | `--repo`: `Files:` disagree with the tree |
| `proposal_in_steps`, `unexpected_steps` | W | a proposal step names a `Proposal:`; an architecture doc has steps |
| `proposal_not_written`, `milestone_ticked_incomplete`, `milestone_complete_unticked` | W | roadmap progress |

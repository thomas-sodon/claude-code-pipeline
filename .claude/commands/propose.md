Write (or revise) one design doc for work bigger than one PR — a concern, a roadmap milestone, or the findings against an existing doc — grounded in today's tree, in the format `/impl` and the lane builder consume.

This command is the **design entry point for multi-PR work**. It writes one proposal to `$PROPOSALS_DIR/<slug>.md`: context, design, decisions, security and privacy, rollout, and a build-ordered step list in which every step is one focused PR or one thing a person must do. `/review-proposal` reviews it; `proposal-build-chain` builds its lanes once a person sets `Status: accepted`. The doc is the whole deliverable: no code is written, nothing is committed, no branch is created, no issue is filed.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines). With no `CLAUDE.md` (a greenfield directory, or a repo that never adopted the pipeline), use the defaults and fallbacks below and say so. This command uses:

- `PROPOSALS_DIR` — where design docs live (default `docs/design`, relative to the working directory; announce the default when used). This command writes there.
- `MAIN_BRANCH` — integration branch (default `main`).
- `QUALITY_GATES` — what proves a code step's Acceptance. Unset → the architecture's `## Quality gates`, else the checks the repo already runs (CI workflow jobs, Makefile or package-manager scripts, the test runners found while grounding); `## Current state` names which it used.
- `TEST_GUIDELINES` — the project's testing rules (default: the project's `CLAUDE.md`, else `CONTRIBUTING` or a test README, else the conventions of the existing tests).

The lint is `python3 .claude/scripts/proposal-lint.py`, run from the working directory. If the script is missing, check the format by hand against the rules below and say so in the report.

## Arguments

`$ARGUMENTS` is a space-separated list of tokens selecting exactly one mode:

- **Concern mode** — `<concern>`: free text (every token that is not a recognized flag). Work too big for one focused PR, or a structural class (`/plan` routes both here).
- **Milestone mode** — `--milestone=N [ROADMAP]`: write the proposal roadmap milestone `N` names. `ROADMAP` (one `.md` path) defaults to `$PROPOSALS_DIR/roadmap.md`.
- **Revise mode** — `--revise DOC [findings…]`: revise an existing proposal, `architecture.md` or `roadmap.md`. The token after `--revise` is `DOC`; the rest is findings text. Findings may also be handed over alongside the invocation (a workflow pastes them as JSON); both count.

Flags for any mode:

- `--dry-run` — print the doc (revise mode: the changed sections) and write nothing: no doc, no ledger update.
- `--out=DIR` — the proposals directory, overriding `PROPOSALS_DIR` (concern mode: where the doc is written; milestone mode: where the default `ROADMAP` is looked up). Not valid with `--revise`.
- `--slug=<slug>` — concern mode only: force the file name. Kebab-case, ≤60 chars, not `architecture` or `roadmap`.

An unrecognized `--`-prefixed token, `--milestone` with `--revise`, a non-integer `N`, `--slug` outside concern mode, `--out` with `--revise`, or extra free text in milestone mode → stop with `error=invalid_argument`, naming the token and the recognized forms. No mode → `error=missing_concern` with an example (`/propose every endpoint re-implements its own auth check; move auth into one middleware`). `--revise` without a `DOC`, or a `DOC` that does not exist → `error=doc_not_found`.

**Framing and answers.** The invoking prompt may carry the person's **framing** (who builds and within which limits, as text or as a file it tells you to read) and **answers** the person gave to earlier questions (each with an id, and often its question and date). Both are the person speaking: they bind, and nothing in the source, the tree or your research overrides them (see *Questions before assumptions*).

## Route the concern elsewhere first

Concern mode only. Recommendations, never delegations: do not invoke another command from here.

- **An issue reference** (`#NNN` or an `.../issues/NNN` URL) → recommend `/bug-fix NNN` and stop, before reading any code.
- **Greenfield.** The tree has no code and `$PROPOSALS_DIR` has no `architecture.md` → this is a product, not a change: recommend `/roadmap <brief or concern>` and stop with `error=greenfield`.
- **It fits one focused PR.** Once grounding step 1 has mapped the implicated code: `/propose` only when the work needs more than one independently mergeable PR, a person-only step, or a structural class (a rule that must hold across many files, with a check that enforces it); otherwise recommend `/plan <concern>` and stop. Size is judged from the code, not the wording.

## Read the source

**Concern mode.** Extract, as `/plan` does: the observable (what is wrong, missing or wanted), the nouns (grep targets), the shape (bug / feature / refactor / docs), the stated remedy (a hypothesis, never the design), and explicit constraints (binding). No observable → `error=concern_too_vague`, quoting what you extracted.

**Milestone mode.**

1. Read `ROADMAP` in full (missing → `error=roadmap_not_found`) and run the lint on it with `--roadmap`. Milestone `N` missing → `error=milestone_not_found`; human-gated (a person does it, no proposal) → `error=milestone_human_gated`; ticked `[x]` → `error=milestone_done`.
2. The milestone's title, description, `Acceptance:` (its exit criteria) and `Depends on:` are the scope. Every exit criterion must be met by some step's Acceptance, unless the milestone is too big for one proposal and is split (see *Budget*). Neighbouring milestones are the boundary: their work goes in `## Out of scope`, by milestone number.
3. Read the roadmap's `Source:` brief and its `Architecture:` doc (default `architecture.md` beside the roadmap) in full. When the brief is not in this checkout (it is kept out of commits, so a new clone lacks it), say so in the report and work from the roadmap and the architecture, which carry what the brief required; never invent what it said. The architecture's Repository layout, Components, Data model, Decisions, Invariants, Quality gates and Environments bind the proposal; a missing architecture doc is a report addendum, not a stop.
4. Read the proposals of the milestones this one depends on, if they exist: what they create (`(new)` files, tables, endpoints, secrets) is what this proposal builds on.
5. Output path: the milestone's `Proposal:` file, relative to the roadmap's directory. If it exists, update it in place (*Updating an existing doc*).

**Revise mode.** See *Revise mode* below; it reuses grounding and the layout rules.

## Ground in today's tree

The proposal must rest on code you read first-hand. Do not delegate this to subagents. Ground in the checkout as it is: never switch, fetch or branch. If HEAD is not `$MAIN_BRANCH`, say in the report which branch the doc was grounded in.

1. **Map nouns to code.** Grep each noun across source, tests, docs and config. Read the implicated functions in full, plus their direct callers.
2. **Confirm the observable** (concern mode). Not reproducible today → `error=concern_not_reproducible`, citing the current code and the commit that changed it (`git log -S<symbol> --oneline -5`).
3. **Project rules.** Read the invariants covering the area: `CLAUDE.md`, else the architecture's, else the rules the repo already enforces (structural tests, CI checks, lint configs, contributing docs). A design that needs to break an invariant is not written around it: find the compliant route, or report the collision.
4. **Tests and config.** Read the nearest tests (contract, fixtures to reuse) and look for existing settings before adding any.
5. **Greenfield** (milestone mode, no code yet): `## Current state` says `No code yet` plus what the architecture fixes; every path comes from its Repository layout or an earlier milestone's proposal.

Every path and symbol in the doc comes from this step, cited by file path and symbol.

## Research what the tree cannot tell you

- **Explore** subagent for discovery only (usage patterns, prior implementations, other call sites): one call by default, up to 3 in parallel across layers, each with one specific question. It never substitutes for the reading above.
- **Desk research.** Settle every assumption a source can settle — official docs, API limits, pricing pages, store and provider guidelines, regulators' FAQs (WebSearch / WebFetch), or a local source (a repo path and symbol, an installed tool's docs) — and cite it in the Decision that rests on it: a link with the date checked, a path and symbol, or the tool's name and version. Only what needs data or action a person must provide becomes a `Human gate: research` step. Web tools unavailable → list the question, with the source to check, under `## Risks and open questions`; never state it as fact.

## Questions before assumptions

A **blocking question** is one only the person can answer: what they intend, a requirement or constraint the source (the concern, the milestone and its brief, or the findings) leaves out or states two incompatible ways, a trade-off that is theirs to make, a conflict between what the person said (the framing, an answer, a decision a doc tags `(person, …)`) and the source, the tree or your research, or a blocker whose way forward is their call; and whose plausible answers lead to a different design, promise, cost or legal exposure. What the person said outranks the source: in such a conflict pick no side and ask, naming both.

A **confirmation** is a question about a person-owned choice that already has a value nobody confirmed with the person: the source's value when the source was drafted for the person, an item the framing, the roadmap or the architecture lists as open, recommended or not yet decided, or the default you would otherwise take. A brief the `new-software-idea` skill wrote is a source drafted for the person: recognise it by the `**Verdict:**` and `**Assumed builder:**` fields in its header. That skill never interviews the person, so the price, licence, platforms and names in such a brief are its defaults, not the person's choices. Findings are a reviewer's writing, never the person's. Any other source (a concern in free text, a brief without those fields) counts as the person's own writing, unless it or the invoking prompt says someone else drafted it. A confirmation is asked in the same batch as the blocking questions, with the unconfirmed value as its recommended option, and is marked as a confirmation.

The **person-owned choices** are: who the product is for and what its first release leaves out; platforms and distribution, hosted or self-run; price, plans, the revenue model, and anything that costs money or opens an account in the person's name (a host, a paid API, a billing provider, a store); the licence and its variant, and the legal and compliance posture; what personal data is collected, how long it is kept and who receives it; names (product, package, domain, organization or bundle id); the repository's owner and visibility; stop and go criteria, thresholds and dates; and a stack, provider or environment the person must run or pay for themselves. Each one this doc decides is either settled already (by the framing, an answer, a source that is the person's own writing, or a Decision of the architecture) or asked: a blocking question when it has no value or the source states it two ways, a confirmation when it has a value nobody confirmed.

**The architecture binds.** Its Decisions settle what they cover: never ask about one again. One tagged `(person, …)` is never departed from: a reason to depart from it is a blocking question. A departure from any other follows the rule under `## Decisions` in the layout.

**Yours, never asked:** a choice inside a component that an invariant, a recorded decision or an official doc settles (a library, a layout, an internal name, a test tool, a version), and anything the tree, `CLAUDE.md`, the architecture and the other design docs or desk research can settle.

**A choice the person can make now, from what they already know, is a question:** never a gate, never a D-record whose Choice awaits confirmation, never something left for the person to settle when they accept the doc. A `decision` gate holds only what waits on evidence the plan produces, on finished work or on an outside party (a go/no-go after an experiment, a sign-off on finished text). A `research` gate holds only what needs data, an account, a paid search or a legal opinion: never what a public search settles.

**Revise mode.** A finding is a blocking question, never applied on a guess and never declined, when only the person can settle it: the source is silent or ambiguous on it, its fix would choose for the person in a person-owned class, or it would change a choice the person made.

**Name things by title.** A question, its options and the recommendation name milestones, steps and decisions by title. A number may follow the title; a number alone is never enough, because numbers move between revisions.

- **One pass, before writing.** Collect every blocking question and every confirmation at the end of *Research what the tree cannot tell you*, before *Write the proposal* (revise mode: before applying any finding), and ask them in one batch: never some now and the rest after writing. Never guess the answer to one.
- **Someone can answer** (an interactive session with a question tool, such as AskUserQuestion): ask them all at once, in as few prompts as the tool allows and never dropping a question to fit, each with 2–4 concrete options and your recommended one first, and wait. Show the confirmations as one list, each line with its unconfirmed value, that the person can accept whole or correct line by line. The answers bind.
- **No one can answer** (the invoking prompt says the run is unattended, or there is no question tool): make no further change; stop with `error=needs_input` and print each question with an id (`q1`, `q2`, …), why it blocks (what changes with the answer), its options and the one you recommend. A confirmation is printed with the word `confirmation` after its id, and its unconfirmed value is the recommended option.
- **Proceeding on assumptions** (the invoking prompt says to, instead of stopping): take the recommended option of each question and each confirmation, tag every decision so taken `(assumed)` (see `## Decisions` in the layout), and list each question with the option taken under **Assumptions**. One exception: a question about changing what the person settled is never taken on assumption. Keep what the person said and list the question as open.
- **Answers handed in** by the invoking prompt bind, as the framing does: never re-ask one, and never change what one settled. Only a newer answer from the person changes it; a reason to change it is a blocking question.
- **Everything else is an assumption:** a choice the inputs did not settle that is neither a blocking question nor a confirmation. Take the smallest choice consistent with the sources and the surrounding code, tag it in the doc (a decision's heading `(assumed)`, as `## Decisions` in the layout says; a value `(proposed)`, as *Proposed values* under *Steps* says), and list each under **Assumptions** in the report. None stays silent.

## Write the proposal

**File.** Concern mode: title ≤8 words describing the end state; slug from `--slug` or the title (lowercase, non-alphanumeric runs → `-`, collapsed, ≤60 chars at a word boundary); path `<proposals dir>/<slug>.md`. **Supersede check:** read the H1 and `## Context` of every proposal in the directory whose slug shares significant words; one covering the same concern → rebind the path to it and update it in place (*Updating an existing doc*). Milestone mode: the path from *Read the source*.

The doc reads as freshly authored: no quoted request, no mention of this command. Layout, every section present:

1. `# Proposal: <Title>`, then headers: `Status: draft` (always — only a person sets `accepted`); `Source:` = the brief path, `<roadmap file relative to the proposal>#N` in milestone mode (the lint gates lanes on the milestone's roadmap dependencies through it), or `concern`; `Architecture:` = the architecture doc relative to the proposal, when one exists.
2. `## Context` — what is wrong or missing, why it matters, the end state.
3. `## Goals` / `## Non-goals` — milestone mode: the goals are its exit criteria.
4. `## Current state` — grounded, cited by path and symbol.
5. `## Design` — components, interfaces, data model, data flow, trust boundaries; for conditional work, each alternative.
6. `## Decisions` — `### D1: <decision> (<tag>)` with Options (≥2 for a real choice), Choice, Why (links for desk research), Consequences, Revisit if. Never silently contradict an architecture decision: a departure names the decision it supersedes, and the report asks for `/propose --revise <architecture doc>`. An architecture decision tagged `(person, …)` is never departed from: a reason to is a blocking question. Every D-record heading, in a proposal and in an architecture, ends with one tag that says who decided, in exactly one of these three forms, for example `### D2: Export format (assumed)`. Write no other provenance mark in a heading: `(brief)`, `(judge)`, `(confirmed)` and the like are not tags.
   - `(person, <YYYY-MM-DD>)` or `(person, <YYYY-MM-DD>, <ref>)`: the person chose it. The date is the day they said it: the answer's date when it carries one, the date the framing records for a choice the framing makes, else today. `<ref>` says where they said it, as one token with no space, comma or parenthesis: an answer's id as it was handed in (`intake.q2`, `m3.q1`), or `q<N>` for a question this run asked; `framing`; a gate whose `Outcome:` records it (`roadmap.md#4`); or `edit` when the person wrote it into the doc themselves. Such a record is binding: only a newer answer from the person changes its Choice.
   - `(source)`: the source states it, and either the source is the person's own writing or the choice is not person-owned. A person-owned choice taken from a source drafted for the person is never `(source)`: it is a confirmation first, and its record is tagged `(person, …)` once confirmed.
   - `(assumed)`: you chose. For a person-owned choice this tag is allowed only when the run proceeds on assumptions; in every other run that choice was asked before writing, so its record is tagged `(person, …)`.
7. `## Security and privacy` — what this change could let go wrong: data exposure, weakened safety or permission rules, supply-chain or release-integrity risk, untrusted input; invariants to add to `CLAUDE.md`, or to the repo's enforced checks when it has none. Nothing at risk → `none: <why>`.
   - For data it handles: data classes; where sensitive and personal data lives and for how long; encryption in transit and at rest; third-party processors and what they receive; secrets by NAME.
8. `## Rollout and operations` — how the change reaches its users (deploy a service, publish a package or tagged version, submit to a store, users copy or upgrade files) and compatibility for already-installed or downstream copies; as they apply, environments, config and secret NAMES per environment, migrations (forward and backward compatible, apply order), flags and defaults, monitoring and alerts, rollback, launch gates. Nothing reaches anyone → `none: <why>`.
9. `## Risks and open questions` — each with its mitigation and the step that retires it.
10. `## Steps` — below.
11. `## Out of scope` — later milestones, adjacent improvements, constraints ruled out.

**Budget.** The doc stays within 40 KB and 12 steps, every step counted (ticked ones and gates too): the agents that build it read it beside the architecture and the roadmap. The lint warns above those limits (`doc_too_big`, `too_many_steps`) and errors above 80 KB or 20 steps, which leaves the doc with no lanes (the pipeline's `docs/PROPOSALS.md`, *Size budgets*). Keep it lean: one to three sentences per step description, and Design and Decisions that cite what the architecture settles instead of restating it. Work that still does not fit is split, never squeezed: the doc keeps the steps that ship first, meeting a coherent part of the exit criteria, and `## Out of scope` names the rest as the part to split off, with its exit criteria. Milestone mode: the report says that `/propose --revise <roadmap>` must add that part as a new milestone after the last one (no number moves), depending on this one, with every milestone that needs it depending on it too, and then `/propose --milestone=N` writes its proposal. Concern mode: the report names the follow-up `/propose` for the rest, whose steps depend on this doc's as `<file>.md#N`.

### Steps

Grammar (the lint enforces it): `N. [ ] **Title.** One to three sentences.` at column 0, numbered 1, 2, 3 in build order, then sub-bullets indented three spaces (four from step 10 on, so they nest under the wider number):

- `Depends on:` on **every** step — `none`, same-doc numbers (always lower), `<file>.md#N` for a step of another proposal that exists now, or `<roadmap file>.md#N` for a roadmap gate milestone this step must wait for (a legal or privacy sign-off before a release, an `ops` milestone that provisions the accounts it uses); the lint resolves a roadmap milestone like any cross-doc ref and treats it as satisfied once ticked. That is the one exception: other ordering between milestones is the roadmap's job; do not restate it with cross-doc refs.
- `Files:` (code steps) — backticked repo-relative paths; existing files by current path, created ones suffixed ` (new)`; ≤8 per step. A file the architecture's Repository layout names counts as created by the Bootstrap milestone (no `(new)`), unless its entry says `(from milestone N)`: that milestone's proposal creates it.
- `Acceptance:` — testable: a test, a command, an observable state; never "works well". Name new tests. A code step's Acceptance must be provable by the gates (`QUALITY_GATES` or its fallback) or a named CI check (the architecture's `CI job` or `Required checks`, or a job the repo's CI already runs): the agent's Linux host cannot build an iOS or Android app, observe device behaviour or run a macOS-only tool. Verification only a device can give becomes a human gate (`research` or `release`) right after the code step, or a CI job named in the architecture's `Required checks` (the step that adds that job is planned too).
- `Lane: <key>` — only for code steps that cannot merge apart (each would leave the tree broken alone); they ship as one PR. Prefer splitting.
- `Human gate: <kind> — <what a person does>` instead of `Files:` for person-only work.

Each code step is one focused, independently mergeable PR that leaves the tree working: tests in the same step as the behavior, a risky change behind a flag defaulting to today's behavior, a migration expand-then-contract across steps, a new check or rule non-enforcing at first (warn, or only on files already migrated) with the migration steps after it and the last step enforcing it. A content step (a privacy policy, store listing copy, a docs page) has the docs as `Files:`, a named check in the gates (link or spell check) as Acceptance, and a `decision` gate right after it in which a person approves the text. A step that uses what another creates (module, table, endpoint, secret) depends on it — otherwise the lane builder builds them in parallel.

**Proposed values.** A value you propose that neither the source, the framing, an answer nor the architecture states (a threshold, a retention period, a price) is never written as a fact, in a step or anywhere else in the doc. When it is a promise the person owns and they can answer from what they know, it is asked as a confirmation before writing, and once answered it is written as the person's, without the label. Every proposed value still unconfirmed when the doc is written (it waits on evidence the plan produces, or the run proceeds on assumptions) is labelled `(proposed)` where it stands. A value that waits on evidence names, in the same sentence or bullet, the gate whose Acceptance records the person's value; a value whose confirmation was taken on assumption needs no gate, and the report lists it under **Unconfirmed decisions**.

### Human gates

Everything a person must do is its own step with `Acceptance:` stating the evidence that closes it:

- `research` — data a person gathers (real samples, user interviews, measurements), or what needs an account, a paid search or a legal opinion; never what a public search settles. Fixtures they produce are redacted.
- `decision` — go/no-go, legal or compliance sign-off, a choice that waits on evidence this proposal produces. Never a choice the person can make now: that is a question (see *Questions before assumptions*).
- `ops` — accounts, secrets (by NAME), DNS, provider and billing setup.
- `release` — production deploy, publishing a package or tagged version, store submission, flag flip, observation window.

Place each right after the code steps it follows (a release gate right after the step that ships the deployable change); every step that needs a gate's result carries it in `Depends on:` so it stays blocked until a person ticks it.

**Release ownership.** Each production release, package or tagged-version publish, app-store submission or launch is gated exactly **once**. By default it is a `release` gate in the proposal whose code it ships, right after that code. It is a roadmap `release` milestone instead only when one launch ships several milestones' work together — then this proposal has no gate for it, and `## Rollout and operations` names the milestone that releases it. Never both. A release gate depends on every roadmap gate milestone it needs (the legal or privacy sign-off, the `ops` milestone that provisions the host or store accounts) as `<roadmap file>.md#N`.

**Conditional work.** When the next steps depend on a gate's finding, `## Design` describes each alternative and the steps that would differ `Depend on` the gate, written for the alternative the evidence currently favours and saying so. After a person records the gate's `Outcome:` and ticks it, `/propose --revise` rewrites them to the chosen alternative. No conditional syntax.

### Examples

```md
# Proposal: Nightly usage export

Status: draft
Source: roadmap.md#3
Architecture: architecture.md

## Steps

1. [ ] **Add the export job behind a flag.** Writes yesterday's usage rows to CSV; `EXPORT_ENABLED` defaults to off.
   - Files: `src/export/job.ts` (new), `src/export/job.test.ts` (new), `src/config.ts`
   - Depends on: none
   - Acceptance: flag off, nothing runs; flag on, the fixture day exports exactly its rows in id order (`job.test.ts`)
2. [ ] **Confirm the columns finance needs.** Collect the column list from the finance owner.
   - Human gate: research — column list and an example row recorded (redacted) in this step's Outcome
   - Depends on: none
   - Acceptance: every requested column is mapped to a source field or marked unavailable
3. [ ] **Provision the export bucket.** Create the bucket for staging and production.
   - Human gate: ops — bucket created; secret `EXPORT_BUCKET_KEY` added by name in both environments
   - Depends on: none
   - Acceptance: a staging run lists the bucket using the secret
4. [ ] **Upload exports and alert on failure.** Shape the CSV to the step 2 columns and upload it; page on a failed run.
   - Files: `src/export/upload.ts` (new), `src/export/upload.test.ts` (new), `src/export/job.ts`
   - Depends on: 1, 2, 3
   - Acceptance: a failed upload raises the export alert; a successful one writes `usage-<date>.csv`
5. [ ] **Turn the export on in production.** Flip the flag and watch a week of runs.
   - Human gate: release — set `EXPORT_ENABLED=true` in production
   - Depends on: 4
   - Acceptance: seven consecutive successful nightly runs, no alert fired
```

Not every proposal deploys something. A refactor in a repo with no `CLAUDE.md`, proved by the commands its CI already runs, with no human gate:

```md
# Proposal: One config loader for every command

Status: draft
Source: concern

## Current state

Each command in `src/cli/` parses the config file itself. No `CLAUDE.md`; gates: `make lint test`, as the `test` job in `.github/workflows/ci.yml` runs them.

## Security and privacy

none: the same local file is read as today; no new input, data or permission.

## Rollout and operations

none: behaviour is unchanged; it reaches users in the next regular release, which this proposal does not gate.

## Steps

1. [ ] **Add the shared loader and a warn-only check.** `load_config()` plus a script listing commands that still parse the file themselves.
   - Files: `src/config.py` (new), `tests/test_config.py` (new), `tools/check_config_reads.py` (new), `Makefile`
   - Depends on: none
   - Acceptance: `make lint test` passes; `make lint` prints the check's list and still exits 0
2. [ ] **Move every command to the loader and enforce the check.** The check now fails on any direct read.
   - Files: `src/cli/build.py`, `src/cli/serve.py`, `tests/test_cli.py`, `Makefile`
   - Depends on: 1
   - Acceptance: `make lint test` passes with the check enforcing; the list is empty
```

## Updating an existing doc

Applies to a milestone proposal that exists, a superseded concern proposal, and revise mode.

- **Never change an `[x]` step**: its number, checkbox, title, description and sub-bullets (including `Outcome:`) stay byte-identical.
- **Never change what the person settled**: a D-record tagged `(person, …)` keeps its Choice and its tag, and text that states an answer or the framing keeps its meaning, unless a newer answer from the person changes it. A reason to change one is a blocking question (see *Questions before assumptions*).
- **Protected numbers** rest on facts, never on a status a person must remember to set. Every pending step keeps its number when the doc has any ticked step; or has ever been accepted (its `Status:` is `accepted`, `in-progress` or `done` now, or `git log -S'Status: accepted' --oneline -- <doc>` finds a commit); or another doc references it (`grep -rn "<file>.md#" <proposals dir>` — `Depends on:` refs and `Source:` headers). New steps then go after the last step. A change that would shift a protected number is not made: leave that part unapplied and report which docs must change with it.
- **Built lanes are frozen.** A pending step whose lane was already built — a branch matching `*<slug>-s<N>-*` (its default lane key) or `*<slug>-<lane>-*` (its `Lane:` key) exists locally or among remote-tracking refs: `git branch -a --list '*<slug>-s<N>-*'` (`<slug>`: the doc's file name without `.md`, lowercased, non-alphanumeric runs → `-`) — is treated like an `[x]` step: never rewritten. A change to its work goes into a new follow-up step after the last step.
- **Retiring a step.** To retire a pending step in a protected doc, keep its number and turn it into `Human gate: decision — superseded by step M; tick to retire`, with no `Files:` or `Lane:`.
- **Budget.** An update keeps the doc within its budget: a new step that would take it past a limit goes to a new milestone, or a follow-up proposal, as *Budget* says.
- Renumbering unprotected pending steps updates every same-doc `Depends on:` to match.
- Keep existing `Proposal:` file names in a roadmap; renaming one orphans its doc.
- The rewritten doc gets `Status: draft`. If it was `accepted`, `in-progress` or `done`, the report says a person must re-accept it before lanes build.

## Revise mode

1. **Read `DOC` in full**; its kind comes from the H1 (`# Proposal:`, `# Architecture:`, `# Roadmap:`). Read what it rests on: its `Source:`, its `Architecture:`, every doc it references or that references it, and the tree it cites. When the `Source:` brief is not in this checkout (it is kept out of commits, so a new clone lacks it), say so in the report and work from the roadmap and the architecture, which carry what the brief required; never invent what it said.
2. **Recall the ledger** `~/.claude/reviews/proposal-<slug>.json` (`<slug>`: the working directory's base name, `-`, then `DOC`'s path relative to the working directory without `.md`, lowercased, non-alphanumeric runs → `-`, collapsed, trimmed — exactly as `.claude/commands/review-proposal.md` defines it, with the schema). When the file is missing, first restore its saved copy, `reviews/proposal-<doc-slug>.json` on the state branch (`<doc-slug>`: what `python3 .claude/scripts/pipeline-state.py slug <path>` prints for `DOC`'s path relative to the repository root without `.md`, as review-proposal.md's *Review ledger* defines it), exactly as its *Recall* does; under `--dry-run`, read the copy (`pipeline-state.py get` without `--to`) and write no local file. Treat it as absent when missing, malformed (warn) or when its `repo` or `doc` do not match this working directory and `DOC`. Its `new`/`open` findings, unioned with the findings passed in (de-duplicated by meaning), are the work list.
3. **Follow recorded outcomes.** Every ticked research or decision gate with an `Outcome:` whose dependent pending steps or milestones still describe the open alternatives (or are coarse placeholders): rewrite them to the chosen alternative, and in a proposal its Design and Decision too. A Decision the Outcome settles is tagged `(person, <date>, <gate>)`: the date the Outcome states, else today, and the gate as `<its doc>.md#N`.
4. **Apply every finding.** Verify each against the doc, the tree and its sources. Decline one only when you can show it is wrong (it misreads the doc, cites code that says otherwise, or contradicts a binding source other than the person's own choices), with the reason. Preference is not a reason. Never change the Choice of a D-record tagged `(person, …)`, or anything an answer or the framing settled: a finding that would is a blocking question naming the person's choice and the finding's reason (see *Questions before assumptions*), never applied, and never declined because it contradicts the person. A finding whose fix would choose for the person in a person-owned class is a blocking question too. When an answer settles a decision, tag its record `(person, <date>, <answer id>)`. A D-record with no tag, or with a tag the lint reports as `bad_decision_tag`, gets the tag `## Decisions` in the layout prescribes: `(person, …)` only where an answer, the framing or a recorded `Outcome:` shows the person chose it, and never on a guess. A person-owned choice in such a record that nothing shows the person chose is a confirmation, with the record's Choice as its recommended option, collected with the other questions before any finding is applied. Each fix follows the layout rules above and *Updating an existing doc*. A budget finding (the doc is over a size, step or milestone limit, whether the lint warns or errors) is applied until the doc is within the warning limits: move detail out first, then split, as *Budget* and step 5 say. When only removing protected or built steps would get it there, leave that part unapplied, as for any change that would shift a protected number, and record it as declined with the reason (`Declined: protected steps 9–14`), so a later review does not raise it again while they stay protected.
5. **By kind.** Architecture: all twelve sections stay present; a changed Invariant, Testing rule or Quality gate on a bootstrapped repo also needs `CLAUDE.md` changed in a PR — say so, do not edit it. `## Invariants` and `## Testing` are copied verbatim in a bootstrapped repo's `CLAUDE.md` (its `## Pipeline config` carries the `/bootstrap` marker): after writing, run `python3 .claude/scripts/proposal-lint.py <doc> --claude-md CLAUDE.md`; each `claude_md_drift` it reports is a section the same PR must copy into `CLAUDE.md` — the CI `docs` job fails on it — so name each in the report. An architecture over its budget cuts the milestone detail its proposals already carry; where a milestone's proposal is not written yet, that detail shrinks to one line naming what the proposal must settle. Decisions, invariants and whatever else binds every milestone stay. Roadmap: every non-gated milestone keeps `Proposal:` and `Acceptance:`; every person-only milestone stays a human gate. A milestone split for the budget keeps its number and `Proposal:` for the part that ships first; the rest becomes a new milestone after the last one, with a new `Proposal:` file, depending on it, and every milestone that needs the moved work depends on the new one too.
6. Nothing to apply and no outcome to follow → write nothing; report `No revisions needed.`
7. **Write and lint** (below). Then **mark the ledger**: each applied ledger finding → `status: fixed`, `resolved_at: <now>` (`YYYY-MM-DDTHH:MM:SSZ` UTC); each declined one stays as it is, with `Declined: <reason>` appended to its `detail`; each one left open as a question stays unchanged. Set `updated_at`; write `<ledger>.tmp.<pid>`, rename, then save it to the state branch: `python3 .claude/scripts/pipeline-state.py save <ledger> --as reviews/proposal-<doc-slug>.json -m "review ledger: <DOC>"`. Best-effort: on failure of either, warn and continue; never overwrite a malformed or foreign ledger, and never create one here (restoring the saved copy in step 2 is not creating one).

## Write and lint

1. Under `--dry-run`, print the doc and stop. To lint it, write a temporary copy outside the repo, lint that with `--as <its real path>` (so `Source:` and cross-doc refs resolve), and delete it; nothing else is written.
2. **Write atomically:** `<path>.tmp.<pid>` in the same directory, then rename into place. Create the proposals directory if needed.
3. Run `python3 .claude/scripts/proposal-lint.py <path> --repo .` and fix every error; re-run until it exits 0. Fix the warnings that are real (`missing_section`, `step_too_big`, `new_file_exists`, `missing_acceptance` on a gate, a mistyped path behind `file_not_found`, and always `decision_untagged` and `bad_decision_tag`: give the record the tag `## Decisions` in the layout prescribes); a `file_not_found` for a file Bootstrap or an earlier milestone's proposal creates stays, and the report names which.
4. A budget warning (`doc_too_big`, `too_many_steps`, `too_many_milestones`) is always real: move detail out or split, as *Budget* says, and lint again. One left (only protected or built steps keep the doc over) is named in the report, with why.

## Report

Print the resolved path as the final message:

    Wrote proposal: <path>

(revise mode: `Revised: <path>`, then each applied finding in one line, each declined one with its reason, and each one left open because the person must settle it). Add bullet addenda only when they apply:

- Routed or stopped — the recommendation or `error=` and the next action, instead of a path.
- `PROPOSALS_DIR` defaulted, or no `CLAUDE.md` was found — and which gates, test rules and invariants stood in.
- Updated in place or superseded — the path, and that every `[x]` step was kept.
- Status reset to `draft` from `accepted` / `in-progress` / `done` — a person must re-accept it.
- Steps, human gates (by kind) and lanes in the doc; lint warnings left and why.
- Split for the budget — the part split off, its exit criteria, and the next commands (`/propose --revise <roadmap>` to add it as a milestone, then `/propose --milestone=N`; or the follow-up `/propose`).
- The ledger's state-branch copy could not be restored or saved, with the warning.
- A departure from an architecture decision, or a collision with a `CLAUDE.md` rule.
- A finding left unapplied because it would shift a protected step number — the docs that must change with it; a built lane's step left as it is, and the follow-up step added instead.
- Desk-research questions left open because web tools were unavailable.
- **Assumptions** — each choice the source did not settle and the doc rests on, and each question taken on assumption with the option taken (see *Questions before assumptions*).
- **Unconfirmed decisions** — each D-record tagged `(assumed)` and each `(proposed)` value, named by title, for the person to confirm or correct before they accept the doc.
- The `Source:` brief is not in this checkout — the doc was written from the roadmap and the architecture alone.
- Grounded on a branch other than `$MAIN_BRANCH`.

Close with the next step: `/review-proposal <path>`. Under `--dry-run`, print the doc clearly marked as not written.

## What to skip

- Do not write code, tests, or any file other than the one doc and the ledger update; do not run the quality gates.
- Do not commit, stage, push, branch, switch branches, fetch, open a PR, or file issues. The one exception is the ledger's copy on the state branch, which `pipeline-state.py` fetches and pushes in revise mode.
- Do not tick steps or set `Status:` to anything but `draft`; do not write `Outcome:` lines — a person does.
- Do not enter plan mode or invoke other commands.
- One doc per invocation.

## Safety

- Writes go only to the resolved doc path (atomically) and, in revise mode, the existing ledger under `~/.claude/reviews/` and its copy on the state branch.
- Never delete a design doc; never change an `[x]` step, a built lane's step or a protected step number.
- Never choose for the person in silence: a person-owned choice is asked, or, only when the run proceeds on assumptions, tagged `(assumed)` and reported. A D-record tagged `(person, …)`, an answer or the framing is changed only by a newer answer from the person.
- No destructive git and no git-state change of any kind, apart from `pipeline-state.py` saving the ledger's copy: it fetches and pushes only the state branch and never touches the working tree, the index, HEAD or another branch.
- Redact credentials (tokens, `Bearer ` headers, API keys, passwords) and personal data (names, addresses, emails, phone and account numbers) from anything quoted into the doc — secrets are named, never valued; examples are synthetic or redacted. Design docs are committed and shared.

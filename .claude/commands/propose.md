Write (or revise) one design doc for work bigger than one PR — a concern, a roadmap milestone, or the findings against an existing doc — grounded in today's tree, in the format `/impl` and the lane builder consume.

This command is the **design entry point for multi-PR work**. It writes one proposal to `$PROPOSALS_DIR/<slug>.md`: context, design, decisions, security and privacy, rollout, and a build-ordered step list in which every step is one focused PR or one thing a person must do. `/review-proposal` reviews it; `proposal-build-chain` builds its lanes once a person sets `Status: accepted`. The doc is the whole deliverable: no code is written, nothing is committed, no branch is created, no issue is filed.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines). With no `CLAUDE.md` (a greenfield directory), use the defaults and say so. This command uses:

- `PROPOSALS_DIR` — where design docs live (default `docs/design`, relative to the working directory; announce the default when used). This command writes there.
- `MAIN_BRANCH` — integration branch (default `main`).
- `QUALITY_GATES` — named in Acceptance where a step's check is the gate run.
- `TEST_GUIDELINES` — the project's testing rules (default: the project's `CLAUDE.md`).

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

## Route the concern elsewhere first

Concern mode only. Recommendations, never delegations: do not invoke another command from here.

- **An issue reference** (`#NNN` or an `.../issues/NNN` URL) → recommend `/bug-fix NNN` and stop, before reading any code.
- **Greenfield.** The tree has no code and `$PROPOSALS_DIR` has no `architecture.md` → this is a product, not a change: recommend `/roadmap <brief or concern>` and stop with `error=greenfield`.
- **It fits one focused PR.** Once grounding step 1 has mapped the implicated code: if the core is one coherent change of ≤ ~7 implementation steps with no person-only step and no structural class behind it, recommend `/plan <concern>` and stop. Size is judged from the code, not the wording.

## Read the source

**Concern mode.** Extract, as `/plan` does: the observable (what is wrong, missing or wanted), the nouns (grep targets), the shape (bug / feature / refactor / docs), the stated remedy (a hypothesis, never the design), and explicit constraints (binding). No observable → `error=concern_too_vague`, quoting what you extracted.

**Milestone mode.**

1. Read `ROADMAP` in full (missing → `error=roadmap_not_found`) and run the lint on it with `--roadmap`. Milestone `N` missing → `error=milestone_not_found`; human-gated (a person does it, no proposal) → `error=milestone_human_gated`; ticked `[x]` → `error=milestone_done`.
2. The milestone's title, description, `Acceptance:` (its exit criteria) and `Depends on:` are the scope. Every exit criterion must be met by some step's Acceptance. Neighbouring milestones are the boundary: their work goes in `## Out of scope`, by milestone number.
3. Read the roadmap's `Source:` brief and its `Architecture:` doc (default `architecture.md` beside the roadmap) in full. The architecture's Repository layout, Components, Data model, Decisions, Invariants, Quality gates and Environments bind the proposal; a missing architecture doc is a report addendum, not a stop.
4. Read the proposals of the milestones this one depends on, if they exist: what they create (`(new)` files, tables, endpoints, secrets) is what this proposal builds on.
5. Output path: the milestone's `Proposal:` file, relative to the roadmap's directory. If it exists, update it in place (*Updating an existing doc*).

**Revise mode.** See *Revise mode* below; it reuses grounding and the layout rules.

## Ground in today's tree

The proposal must rest on code you read first-hand. Do not delegate this to subagents. Ground in the checkout as it is: never switch, fetch or branch. If HEAD is not `$MAIN_BRANCH`, say in the report which branch the doc was grounded in.

1. **Map nouns to code.** Grep each noun across source, tests, docs and config. Read the implicated functions in full, plus their direct callers.
2. **Confirm the observable** (concern mode). Not reproducible today → `error=concern_not_reproducible`, citing the current code and the commit that changed it (`git log -S<symbol> --oneline -5`).
3. **Project rules.** Read the `CLAUDE.md` sections and structural tests covering the area. A design that needs to break an invariant is not written around it: find the compliant route, or report the collision.
4. **Tests and config.** Read the nearest tests (contract, fixtures to reuse) and look for existing settings before adding any.
5. **Greenfield** (milestone mode, no code yet): `## Current state` says `No code yet` plus what the architecture fixes; every path comes from its Repository layout or an earlier milestone's proposal.

Every path and symbol in the doc comes from this step, cited by file path and symbol.

## Research what the tree cannot tell you

- **Explore** subagent for discovery only (usage patterns, prior implementations, other call sites): one call by default, up to 3 in parallel across layers, each with one specific question. It never substitutes for the reading above.
- **Desk research.** Settle every assumption a public source can settle — official docs, API limits, pricing pages, store and provider guidelines, regulators' FAQs — with WebSearch / WebFetch, and cite the link and the date checked in the Decision that rests on it. Only what needs data or action a person must provide becomes a `Human gate: research` step. Web tools unavailable → list the question, with the source to check, under `## Risks and open questions`; never state it as fact.

## Write the proposal

**File.** Concern mode: title ≤8 words describing the end state; slug from `--slug` or the title (lowercase, non-alphanumeric runs → `-`, collapsed, ≤60 chars at a word boundary); path `<proposals dir>/<slug>.md`. **Supersede check:** read the H1 and `## Context` of every proposal in the directory whose slug shares significant words; one covering the same concern → rebind the path to it and update it in place (*Updating an existing doc*). Milestone mode: the path from *Read the source*.

The doc reads as freshly authored: no quoted request, no mention of this command. Layout, every section present:

1. `# Proposal: <Title>`, then headers: `Status: draft` (always — only a person sets `accepted`); `Source:` = the brief path, `<roadmap file relative to the proposal>#N` in milestone mode (the lint gates lanes on the milestone's roadmap dependencies through it), or `concern`; `Architecture:` = the architecture doc relative to the proposal, when one exists.
2. `## Context` — what is wrong or missing, why it matters, the end state.
3. `## Goals` / `## Non-goals` — milestone mode: the goals are its exit criteria.
4. `## Current state` — grounded, cited by path and symbol.
5. `## Design` — components, interfaces, data model, data flow, trust boundaries; for conditional work, each alternative.
6. `## Decisions` — `### D1: <decision>` with Options (≥2 for a real choice), Choice, Why (links for desk research), Consequences, Revisit if. Never silently contradict an architecture decision: a departure names the decision it supersedes, and the report asks for `/propose --revise <architecture doc>`.
7. `## Security and privacy` — data classes handled; where sensitive and personal data lives and for how long; encryption in transit and at rest; third-party processors and what they receive; secrets by NAME; invariants to add to `CLAUDE.md`. Nothing sensitive → `none: <why>`.
8. `## Rollout and operations` — environments; config and secret NAMES per environment; migrations (forward and backward compatible, apply order); flags and their defaults; deploy mechanism; monitoring and alerts; rollback; launch gates. Nothing deployed → `none: <why>`.
9. `## Risks and open questions` — each with its mitigation and the step that retires it.
10. `## Steps` — below.
11. `## Out of scope` — later milestones, adjacent improvements, constraints ruled out.

### Steps

Grammar (the lint enforces it): `N. [ ] **Title.** One to three sentences.` at column 0, numbered 1, 2, 3 in build order, then sub-bullets indented three spaces (four from step 10 on, so they nest under the wider number):

- `Depends on:` on **every** step — `none`, same-doc numbers (always lower), or `<file>.md#N` for a step of another proposal that exists now. Ordering between milestones is the roadmap's job; do not restate it with cross-doc refs.
- `Files:` (code steps) — backticked repo-relative paths; existing files by current path, created ones suffixed ` (new)`; ≤8 per step.
- `Acceptance:` — testable: a test, a command, an observable state; never "works well". Name new tests.
- `Lane: <key>` — only for code steps that cannot merge apart (each would leave the tree broken alone); they ship as one PR. Prefer splitting.
- `Human gate: <kind> — <what a person does>` instead of `Files:` for person-only work.

Each code step is one focused, independently mergeable PR that leaves the tree working: tests in the same step as the behavior, a risky change behind a flag defaulting to today's behavior, a migration expand-then-contract across steps. A step that uses what another creates (module, table, endpoint, secret) depends on it — otherwise the lane builder builds them in parallel.

### Human gates

Everything a person must do is its own step with `Acceptance:` stating the evidence that closes it:

- `research` — data a person gathers (real samples, user interviews, measurements); fixtures they produce are redacted.
- `decision` — go/no-go, legal or compliance sign-off, a choice the person owns.
- `ops` — accounts, secrets (by NAME), DNS, provider and billing setup.
- `release` — production deploy, store submission, flag flip, observation window.

Place each right after the code steps it follows (a release gate right after the step that ships the deployable change); every step that needs a gate's result carries it in `Depends on:` so it stays blocked until a person ticks it.

**Conditional work.** When the next steps depend on a gate's finding, `## Design` describes each alternative and the steps that would differ `Depend on` the gate, written for the alternative the evidence currently favours and saying so. After a person records the gate's `Outcome:` and ticks it, `/propose --revise` rewrites them to the chosen alternative. No conditional syntax.

### Example

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

## Updating an existing doc

Applies to a milestone proposal that exists, a superseded concern proposal, and revise mode.

- **Never change an `[x]` step**: its number, checkbox, title, description and sub-bullets (including `Outcome:`) stay byte-identical.
- **Protected numbers.** A pending step keeps its number when another doc references it (`grep -rn "<file>.md#" <proposals dir>` — `Depends on:` refs and `Source:` headers), and in an `in-progress` doc every pending step keeps its number (its default lane key `s<N>` names its built branch). A change that would shift a protected number is not made: add new steps after the last protected one when build order allows; otherwise leave that part unapplied and report which docs must change with it.
- Renumbering unprotected pending steps updates every same-doc `Depends on:` to match.
- Keep existing `Proposal:` file names in a roadmap; renaming one orphans its doc.
- The rewritten doc gets `Status: draft`. If it was `accepted`, `in-progress` or `done`, the report says a person must re-accept it before lanes build.

## Revise mode

1. **Read `DOC` in full**; its kind comes from the H1 (`# Proposal:`, `# Architecture:`, `# Roadmap:`). Read what it rests on: its `Source:`, its `Architecture:`, every doc it references or that references it, and the tree it cites.
2. **Recall the ledger** `~/.claude/reviews/proposal-<slug>.json` (`<slug>`: the working directory's base name, `-`, then `DOC`'s path relative to the working directory without `.md`, lowercased, non-alphanumeric runs → `-`, collapsed, trimmed — exactly as `.claude/commands/review-proposal.md` defines it, with the schema). Treat it as absent when missing, malformed (warn) or when its `repo` or `doc` do not match this working directory and `DOC`. Its `new`/`open` findings, unioned with the findings passed in (de-duplicated by meaning), are the work list.
3. **Follow recorded outcomes.** Every ticked research or decision gate with an `Outcome:` whose dependent pending steps or milestones still describe the open alternatives (or are coarse placeholders): rewrite them to the chosen alternative, and in a proposal its Design and Decision too.
4. **Apply every finding.** Verify each against the doc, the tree and its sources. Decline one only when you can show it is wrong (it misreads the doc, cites code that says otherwise, or contradicts a binding source), with the reason. Preference is not a reason. Each fix follows the layout rules above and *Updating an existing doc*.
5. **By kind.** Architecture: all twelve sections stay present; a changed Invariant or Quality gate on a bootstrapped repo also needs `CLAUDE.md` changed in a PR — say so, do not edit it. Roadmap: every non-gated milestone keeps `Proposal:` and `Acceptance:`; every person-only milestone stays a human gate.
6. Nothing to apply and no outcome to follow → write nothing; report `No revisions needed.`
7. **Write and lint** (below). Then **mark the ledger**: each applied ledger finding → `status: fixed`, `resolved_at: <now>` (`YYYY-MM-DDTHH:MM:SSZ` UTC); each declined one stays as it is, with `Declined: <reason>` appended to its `detail`. Set `updated_at`; write `<ledger>.tmp.<pid>`, rename. Best-effort: on failure warn and continue; never overwrite a malformed or foreign ledger, and never create one here.

## Write and lint

1. Under `--dry-run`, print the doc and stop. To lint it, write a temporary copy outside the repo, lint that, and delete it; nothing else is written.
2. **Write atomically:** `<path>.tmp.<pid>` in the same directory, then rename into place. Create the proposals directory if needed.
3. Run `python3 .claude/scripts/proposal-lint.py <path> --repo .` and fix every error; re-run until it exits 0. Fix the warnings that are real (`missing_section`, `step_too_big`, `new_file_exists`, `missing_acceptance` on a gate, a mistyped path behind `file_not_found`); a `file_not_found` for a file an earlier milestone's proposal creates stays, and the report names that proposal.
4. More than ~15 steps → the milestone or concern is too big: say so in the report and propose the split.

## Report

Print the resolved path as the final message:

    Wrote proposal: <path>

(revise mode: `Revised: <path>`, then each applied finding in one line and each declined one with its reason). Add bullet addenda only when they apply:

- Routed or stopped — the recommendation or `error=` and the next action, instead of a path.
- `PROPOSALS_DIR` defaulted, or no `CLAUDE.md` was found.
- Updated in place or superseded — the path, and that every `[x]` step was kept.
- Status reset to `draft` from `accepted` / `in-progress` / `done` — a person must re-accept it.
- Steps, human gates (by kind) and lanes in the doc; lint warnings left and why.
- A departure from an architecture decision, or a collision with a `CLAUDE.md` rule.
- A finding left unapplied because it would shift a protected step number — the docs that must change with it.
- Desk-research questions left open because web tools were unavailable.
- Grounded on a branch other than `$MAIN_BRANCH`.

Close with the next step: `/review-proposal <path>`. Under `--dry-run`, print the doc clearly marked as not written.

## What to skip

- Do not write code, tests, or any file other than the one doc and the ledger update; do not run the quality gates.
- Do not commit, stage, push, branch, switch branches, fetch, open a PR, or file issues.
- Do not tick steps or set `Status:` to anything but `draft`; do not write `Outcome:` lines — a person does.
- Do not enter plan mode or invoke other commands.
- One doc per invocation.

## Safety

- Writes go only to the resolved doc path (atomically) and, in revise mode, the existing ledger under `~/.claude/reviews/`.
- Never delete a design doc; never change an `[x]` step or a protected step number.
- No destructive git and no git-state change of any kind.
- Redact credentials (tokens, `Bearer ` headers, API keys, passwords) and personal data (names, addresses, emails, phone and account numbers) from anything quoted into the doc — secrets are named, never valued; examples are synthetic or redacted. Design docs are committed and shared.

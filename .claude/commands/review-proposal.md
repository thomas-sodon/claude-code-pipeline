Review one design doc — a proposal, `architecture.md` or `roadmap.md` (read-only) — and classify findings as bug / concern / suggestion / nit.

`$ARGUMENTS`:
- `<doc>` — required: path of the doc to review. Its kind comes from the H1: `# Proposal:`, `# Architecture:` or `# Roadmap:` (anything else is reviewed as a proposal, and that is a finding).
- `--roadmap` — also review the doc against the whole roadmap: read the roadmap and every proposal it names, and check milestone coverage, work planned twice or by no doc, and the `--roadmap` progress the lint reports. Read each proposal other than the reviewed doc through its lint JSON (`proposal-lint.py <proposal> --json`: step titles, descriptions, files, dependencies and acceptance), opening one in full only where a finding needs it, so the review stays within the budget an agent reads at once (the architecture, the roadmap and one proposal). Without it, only the docs this one references, or that reference it, are read.

No `<doc>` → stop with `error=missing_doc`; a path that does not exist → `error=doc_not_found`; an unrecognized `--`-prefixed token → `error=invalid_argument`, naming it.

## Project configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines). With no `CLAUDE.md` (a greenfield directory, or a repo that never adopted the pipeline), use the defaults and fallbacks below and say so.

- `PROPOSALS_DIR` — design docs (default `docs/design`, relative to the working directory).
- `MAIN_BRANCH` — integration branch (default `main`).
- `QUALITY_GATES` — what proves a code step's Acceptance. Unset → the architecture's `## Quality gates`, else the checks the repo already runs (CI workflow jobs, Makefile or package-manager scripts, its test runners).
- `TEST_GUIDELINES` — the project's testing rules (default: the project's `CLAUDE.md`, else `CONTRIBUTING` or a test README, else the conventions of the existing tests).

The lint is `python3 .claude/scripts/proposal-lint.py`, run from the working directory.

## Steps

1. **Pull source context.** Recover what the doc is meant to deliver, before judging it:
   - Proposal: its `Source:` — the brief, the roadmap milestone (`<roadmap>#N`: title, description, `Acceptance:` as exit criteria, `Depends on:`), or `concern` (then `## Context` is the statement of intent). Check that milestone `N`'s `Proposal:` names this file.
   - Architecture and roadmap: the `Source:` brief, in full.
   - Every doc: its `Architecture:` doc in full, and the project's invariants: `CLAUDE.md`, else the architecture's, else the rules the repo already enforces (structural tests, CI checks, lint configs, contributing docs).
   - What the person settled: the framing (who builds and within which limits) and the answers the invoking prompt carries, and every D-record tagged `(person, …)` in the doc and in its architecture. They bind the doc and outrank the brief (steps 4 and 11). Note also whether the invoking prompt says the person chose to proceed on assumptions (steps 9 and 12).

   Synthesize a 3–5 line **Source Context**. A source that cannot be read is said so — never invent intent. Then recall this doc's **review ledger** (below), restoring its saved copy when the local file is missing.

2. **Run the lint.** `python3 .claude/scripts/proposal-lint.py <doc> --repo . --json` (a roadmap: again with `--roadmap`, for progress); a draft kept outside the repo gets `--as $PROPOSALS_DIR/<its file name>` so `Source:` and cross-doc refs resolve. Every error is a `bug` at its line, titled by its code. Judge each warning: a missing proposal section, `step_too_big`, `new_file_exists` or `lane_mixed` is usually a `concern`; `decision_untagged` and `bad_decision_tag` (a D-record heading without one of the three tags that say who decided) are `concern`s (step 12); a `file_not_found` is a grounding question (step 3). A size budget (`doc_too_big`, `too_many_steps`, `too_many_milestones`; the pipeline's `docs/PROPOSALS.md`, *Size budgets*) is a `concern` when the lint warns and a `bug` when it errors, and its fix names the split: for a proposal, which steps ship first and stay, and which move to a new milestone after the last one (for a concern, to a follow-up proposal), or which sections' detail goes; for an architecture, which milestone detail its proposals carry instead; for a roadmap, which milestones merge or stay coarse. Script missing → check the format by hand (sizes with `wc -c`) and say so.

3. **Grounding.** Read the doc in full. Every claim about today's tree must hold: cited files and symbols exist (for every non-`(new)` path in `Files:`, read the file), `## Current state` describes what the code does, a `(new)` file does not already exist. Greenfield: `No code yet` is true and every path matches the architecture's Repository layout (Bootstrap creates those files, so no `(new)`, unless the entry says `(from milestone N)`) or an earlier milestone's proposal. A doc that no longer matches the tree — a `Files:` path moved or removed, a `(new)` file that now exists, a function, type, endpoint or schema the doc builds on whose name or shape has changed (typically because an earlier milestone landed after the doc was written) — is a `concern` at each step it affects, naming what the tree has now and the fix. Claims about the source must match its text. An unverified assumption stated as fact, where a public source would settle it, is a `concern`; a desk-researchable question turned into a research gate is a `suggestion`. A `research` gate for something a public search settles (an app store, a package registry, RDAP for a domain, a trademark register's search page) is a `concern` when Bootstrap or a code milestone waits on it: name the public source, and the fix is to run the search and record its result and date.

4. **Coverage of its source.** Proposal: every exit criterion of its milestone (or the whole concern) is met by some step's Acceptance; nothing from a neighbouring milestone is built here unannounced. A proposal split for the budget (its `## Out of scope` names the part split off, with that part's exit criteria) is judged against the part it keeps, which must ship on its own; the criteria it hands off are a `concern` against the roadmap, which must add them as a new milestone, not against this doc. Architecture and roadmap: every requirement, constraint, risk and validation step the brief states is planned for, and the roadmap ships the cheapest validation first. A gap is a `concern`; a requirement contradicted is a `bug`. Where the person's framing, an answer or a D-record tagged `(person, …)` departs from the brief, a doc that follows the person has no gap and no contradiction there: the brief is the yardstick only for what the person has not settled.

5. **Feasibility and step sizing.** Each code step is one focused, independently mergeable PR that leaves the tree working, with its tests in the same step. A step too big for one PR, a step that breaks the tree until a later one lands (and shares no `Lane:` with it), or a `Lane:` that could be split, is a `concern`.

6. **Dependency order and cross-doc refs.** Steps are in build order. `Depends on:` is complete: a step that needs a gate's outcome but does not depend on that gate is a `bug` (it would be built straight past it); so is a step that uses what another step creates (module, table, endpoint, secret) without depending on it, since lanes would build them in parallel. Every `<file>.md#N` ref and the `Source:` header point at the step or milestone the text means. Conditional work: the alternatives are in `## Design`, the dependent steps depend on the gate, and a ticked gate's `Outcome:` has been followed (pending steps still describing open alternatives after it is a `concern`).

7. **Security and privacy.** What the change could let go wrong — data exposure, weakened safety or permission rules, supply-chain or release-integrity risk, untrusted input — and, for data it handles: data classes; where personal and sensitive data lives, its retention and deletion; encryption in transit and at rest; third-party processors and what each receives; secrets by NAME only; personal data in fixtures, logs, error messages, analytics and prompts sent to third-party APIs — judged against the invariants (step 1) and the architecture's Security section. A missing or empty section where any of that applies is a `concern`; a plan that violates an invariant, or a credential or personal data quoted in the doc, is a `bug`.

8. **Rollout and operations.** How the change reaches its users (a deploy, a package or tagged-version publish, a store submission, users copying or upgrading files) and compatibility for already-installed or downstream copies; as they apply, environments, config and secret NAMES, migrations, flags and defaults, monitoring and alerts, rollback. A missing or empty section where the change reaches anyone is a `concern`, as is a migration that is not forward and backward compatible, or a deploy with no rollback or monitoring; a destructive or non-reversible migration with no stated plan is a `bug`. `none: <why>` is fine when the why holds.

9. **Testable acceptance.** Every Acceptance is checkable by a test, a command or an observable state, and every gate's Acceptance names the evidence that closes it. Vague criteria ("works", "is fast") are a `concern`; so is a success criterion used as a go/no-go (that gate applies the source's stop criteria), or a value the author proposes (a threshold, a retention period, a price that neither the source nor the person states) that is not labelled `(proposed)`. A `(proposed)` value that no answer settled and no gate's Acceptance records is a `concern` too, whose fix is the question to ask or the gate that records it, unless the invoking prompt says the person chose to proceed on assumptions. A code step's Acceptance must be provable by the gates (`QUALITY_GATES` or its fallback) or a named CI check (the architecture's `CI job` or `Required checks`, or a job the repo's CI already runs): the agent's Linux host cannot build an iOS or Android app, observe device behaviour or run a macOS-only tool. A code step whose Acceptance needs one of those is a `bug` — the lane building it cannot prove it; the fix is a human gate (`research` or `release`) right after the step for the device-only part, or a CI job named in the architecture's `Required checks` and added by an earlier step.

10. **Missing human gates.** Legal or compliance sign-off, go/no-go decisions, account, secret, DNS and provider setup, production release, package or tagged-version publish, store submission, flag flips, observation windows, and validation of an assumption with real data: each a person must do is its own gated step, placed right after the code it follows. Missing is a `concern`; a code step that cannot work until the missing gate happens (it reads a secret nobody provisions) is a `bug`. A gate with `Files:` or a `Lane:` is a lint bug already.

    **Choices parked in a gate.** A gate, or acceptance of the doc itself, that holds a choice the person can make now, from what they already know (a name, a licence, a policy, a "judge's recommendation" to confirm) is a `concern` whose fix is the question to ask, with its options. A `decision` gate holds only what waits on evidence the plan produces, on finished work or on an outside party; a `research` gate only what needs data, an account, a paid search or a legal opinion. A gate whose text does another kind's work (research or a decision inside an `ops` gate, the Bootstrap gate included) is a `concern`: split that work into a gate of its own kind, or ask it now when the person can answer now.

    **Release ownership.** Each production release, package or tagged-version publish, app-store submission or launch is gated exactly once: by default as a `release` gate in the proposal whose code it ships, right after that code; as a roadmap `release` milestone only when one launch ships several milestones' work together. A release gated twice (a proposal gate and a roadmap milestone for the same launch) is a `bug`; so is a release step that does not depend on the legal or ops gates it needs (a privacy sign-off, the accounts it deploys to) — as `<roadmap file>.md#N` when that gate is a roadmap milestone.

11. **Contradictions with the architecture.** A proposal or roadmap that contradicts an architecture decision, component boundary, data model or invariant without a Decision naming what it supersedes is a `bug`; with one, it is a `concern` that the architecture needs the matching revise.

    **What the person settled.** In any kind of doc, a D-record or text that changes a choice the person made (the framing, an answer, a D-record tagged `(person, …)`) without a newer answer from them is a `bug`, whatever reason the doc gives: the source or the author's research contradicting the person is a reason to ask, not to change. Its fix is the question to ask the person, with options, naming both sides; never a gate, and never a confirmation at acceptance.

12. **By kind.** Architecture and proposal: every D-record heading ends in one of the three tags that say who decided (`(person, <YYYY-MM-DD>)` with an optional `, <ref>`; `(source)`; `(assumed)`); the lint reports the others as `decision_untagged` or `bad_decision_tag` (step 2). A person-owned choice tagged `(assumed)`, or tagged `(source)` when the source was drafted for the person (a brief the `new-software-idea` skill wrote: its header has `**Verdict:**` and `**Assumed builder:**` fields), is a `concern` whose fix is the question to ask, unless the invoking prompt says the person chose to proceed on assumptions. The person-owned choices are: who the product is for and what its first release leaves out; platforms and distribution, hosted or self-run; price, plans, the revenue model, and anything that costs money or opens an account in the person's name (a host, a paid API, a billing provider, a store); the licence and its variant, and the legal and compliance posture; what personal data is collected, how long it is kept and who receives it; names (product, package, domain, organization or bundle id); the repository's owner and visibility; stop and go criteria, thresholds and dates; and a stack, provider or environment the person must run or pay for themselves. Architecture: each major decision weighs ≥2 options; Quality gates give the exact commands in backticks, and an optional `Required checks` line names each CI check beyond the gates job (a check the roadmap plans no step to create is a `concern`); Invariants are bullets fit for `CLAUDE.md`; Repository layout is concrete; Environments and deployment covers how each component reaches its users (for a hosted service CI/CD, secrets, migrations, monitoring, backups; for distributed software build, signing, review or publishing, versioning; for every component how a bad release is withdrawn or superseded), with `n/a: <why>` for what does not apply; Testing states the fixture policy. Roadmap: when greenfield, the Bootstrap ops gate is the first milestone that writes anything, preceded only by gates for what needs an outside party or an account (a trademark opinion, a domain registration), which it depends on; a gate before it that holds a choice the person can make now (a name, a licence, an org or bundle id) is a `concern` (step 10); every non-gated milestone names a `Proposal:` and has testable exit criteria; a code milestone whose exit criteria need more than about 12 PR-sized steps (more than one proposal's budget) is a `concern` naming the split; every person-only milestone is a gate; the order validates the riskiest assumptions before building on them. With `--roadmap`, also the cross-doc checks named under *Arguments*.

13. **Assess the whole.** Would building every step, and doing every gate, deliver the source? Is there a simpler design? `Status:` other than `draft` on a doc with blocking findings is worth saying in the summary.

14. **Persist the ledger** (below) — on every run, clean or not — and save its copy to the state branch. These are the command's only writes.

15. **Hand off — do not revise.** Never invoke `/propose` from here; recommend `/propose --revise <doc>` in a fresh session when there are findings. Each finding must carry enough for the reviser to act on it alone: the doc, the section or step title, what is wrong, and the fix.

## Severities

- **bug** — the doc is wrong or would build something wrong: lint errors, contradictions, a dependency that lets a step build past a gate, an invariant violated, a choice the person made changed without a newer answer from them; blocks acceptance.
- **concern** — a gap, risk or design issue that needs a change or a decision; may block acceptance.
- **suggestion** — a meaningful improvement; not blocking alone.
- **nit** — wording, naming, small cleanup; never blocking.

## Review ledger

A durable per-doc record at `~/.claude/reviews/proposal-<slug>.json` (outside the repo) so `/propose --revise` can apply what was raised and a later review can see what was fixed. `<slug>`: the working directory's base name, `-`, then the doc's path relative to the working directory without `.md`; lowercased, non-alphanumeric runs → `-`, repeats collapsed, leading/trailing `-` trimmed (`docs/design/01-Free_Checker.md` in `~/src/acme` → `acme-docs-design-01-free-checker`). Every repo has an `architecture.md`, so the file name alone would collide.

A copy lives on the pipeline's state branch (default `pipeline/state` on origin), so the ledger outlives the machine: a fresh session, or a new cloud container, restores it. The copy is `reviews/proposal-<doc-slug>.json`, where `<doc-slug>` is what `python3 .claude/scripts/pipeline-state.py slug <path>` prints for the doc's path relative to the repository root without `.md` (`docs/design/01-Free_Checker` → `docs-design-01-Free_Checker-8ac7605a`; run the script, never spell it by hand); a doc outside the repository has no copy. `.claude/scripts/pipeline-state.py` reads and writes it from this checkout without touching the working tree, the index or HEAD. The copy is best effort: when the script is missing or exits 2, warn and go on with the local file alone.

    {
      "repo": "<absolute working directory>",
      "doc": "<doc path relative to the working directory>",
      "updated_at": "2026-01-01T12:00:00Z",
      "findings": [
        {
          "id": "r1",
          "severity": "bug",          // bug | concern | suggestion | nit
          "file": "docs/design/export.md",   // the reviewed doc; cite tree paths in detail
          "line": 42,                  // best-effort; never the match key
          "title": "step 'Upload exports' does not depend on the ops gate",
          "detail": "<one or two lines: why it matters + the fix>",
          "status": "new",             // new | open | fixed
          "first_seen": "2026-01-01T12:00:00Z",
          "resolved_at": null
        }
      ]
    }

Titles name the section or step title, not its number.

**Recall.** When the local file is missing, restore the copy first: `python3 .claude/scripts/pipeline-state.py get reviews/proposal-<doc-slug>.json --to ~/.claude/reviews/proposal-<slug>.json.restore.<pid>`. Exit 3 means none was saved: there is no ledger yet. On exit 0, a file that parses, has a `findings` list and names this doc in `doc` is written to `~/.claude/reviews/proposal-<slug>.json` with `repo` set to this working directory (it may have been saved from another checkout or machine); anything else gets a warning. Delete the `.restore.<pid>` file either way. Then treat the file as absent when missing, malformed (warn; never overwrite blindly), or when its `repo`/`doc` do not match this working directory and doc. A recalled finding whose `detail` carries `Declined: <reason>` (written by `/propose --revise`): re-report it only if the reason does not hold, and say why.

**Persist & reconcile** (after the review is written; timestamps `YYYY-MM-DDTHH:MM:SSZ` UTC):
1. Match recalled findings to this run's by `file` + semantic `title`, never by line.
2. Recalled `new`/`open` still present → `open`, keep `first_seen`, refresh `line`/`detail`. Recalled `new`/`open` absent → `fixed`, `resolved_at` now (report as *fixed since last review*). Recalled `fixed` that reappears → `open`, clear `resolved_at`, call it a **regression**. Unmatched new finding → append with next `r<N>`, `status: new`. Recalled `fixed` still absent → leave as history.
3. Set `repo`, `doc`, `updated_at`; create `~/.claude/reviews/` if needed; write `proposal-<slug>.json.tmp.<pid>` then rename. Then save the copy: `python3 .claude/scripts/pipeline-state.py save ~/.claude/reviews/proposal-<slug>.json --as reviews/proposal-<doc-slug>.json -m "review ledger: <doc>"`. On failure of either, warn and continue — the ledger is an aid, not a correctness requirement. Never overwrite a malformed or foreign file (and then save nothing).

## What to skip

- Formatting the lint already enforces, beyond reporting its errors.
- Prose style, unless it makes a step or criterion ambiguous (at most a nit).
- Other docs' own defects, except where they break this doc (a ref to a missing step, a contradiction); name the doc that should change.
- Implementation detail below what one PR's plan will decide.

## Output format

Plain text in the response:

1. Header: `Doc: <path> (<kind>, Status: <status>)`.
2. **Source Context** (3–5 lines), or one line saying it was unavailable.
3. `Lint: <E> errors, <W> warnings`.
4. A 2–3 sentence summary and overall assessment.
5. Findings grouped **Bugs**, **Concerns**, **Suggestions**, **Nits** — each with `path:line`, the step or section title, the quoted text, what is wrong, why it matters, and a concrete fix or question.
6. **Ledger** line: new, carried over, fixed since last review, regressions; whether it was restored from the state branch, and whether its copy was saved there.

If the doc is good, say so briefly — don't manufacture issues. End with exactly one of:
- `Run /propose --revise <doc> in a fresh session to apply the findings.`
- `No revisions needed.`

## Safety

- Read-only: never modify the doc, any other design doc, or the working tree. The sole writes are the ledger under `~/.claude/reviews/` and its copy on the state branch.
- Never invoke `/propose` or any other command.
- No git-state changes: no fetch, switch, commit, stage or stash, apart from `pipeline-state.py` fetching and pushing the state branch for the ledger's copy, which never touches the working tree, the index, HEAD or another branch.
- Redact credentials and personal data (names, addresses, emails, phone and account numbers) from anything quoted into the review or the ledger, whose copy is as visible as the repository; a doc that contains them gets a `bug` that says where, without repeating them.

Review one design doc — a proposal, `architecture.md` or `roadmap.md` (read-only) — and classify findings as bug / concern / suggestion / nit.

`$ARGUMENTS`:
- `<doc>` — required: path of the doc to review. Its kind comes from the H1: `# Proposal:`, `# Architecture:` or `# Roadmap:` (anything else is reviewed as a proposal, and that is a finding).
- `--roadmap` — also review the doc against the whole roadmap: read the roadmap and every proposal it names, and check milestone coverage, work planned twice or by no doc, and the `--roadmap` progress the lint reports. Without it, only the docs this one references, or that reference it, are read.

No `<doc>` → stop with `error=missing_doc`; a path that does not exist → `error=doc_not_found`; an unrecognized `--`-prefixed token → `error=invalid_argument`, naming it.

## Project configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md` (`KEY: value` lines). With no `CLAUDE.md` (a greenfield directory), use the defaults and say so.

- `PROPOSALS_DIR` — design docs (default `docs/design`, relative to the working directory).
- `MAIN_BRANCH` — integration branch (default `main`).
- `TEST_GUIDELINES` — the project's testing rules (default: the project's `CLAUDE.md`).

The lint is `python3 .claude/scripts/proposal-lint.py`, run from the working directory.

## Steps

1. **Pull source context.** Recover what the doc is meant to deliver, before judging it:
   - Proposal: its `Source:` — the brief, the roadmap milestone (`<roadmap>#N`: title, description, `Acceptance:` as exit criteria, `Depends on:`), or `concern` (then `## Context` is the statement of intent). Check that milestone `N`'s `Proposal:` names this file.
   - Architecture and roadmap: the `Source:` brief, in full.
   - Every doc: its `Architecture:` doc in full, and the project's `CLAUDE.md` invariants.

   Synthesize a 3–5 line **Source Context**. A source that cannot be read is said so — never invent intent. Then recall this doc's **review ledger** (below).

2. **Run the lint.** `python3 .claude/scripts/proposal-lint.py <doc> --repo . --json` (a roadmap: again with `--roadmap`, for progress). Every error is a `bug` at its line, titled by its code. Judge each warning: a missing proposal section, `step_too_big`, `new_file_exists` or `lane_mixed` is usually a `concern`; a `file_not_found` is a grounding question (step 3). Script missing → check the format by hand and say so.

3. **Grounding.** Read the doc in full. Every claim about today's tree must hold: cited files and symbols exist (for every non-`(new)` path in `Files:`, read the file), `## Current state` describes what the code does, a `(new)` file does not already exist. Greenfield: `No code yet` is true and every path matches the architecture's Repository layout or an earlier milestone's proposal. Claims about the source must match its text. An unverified assumption stated as fact, where a public source would settle it, is a `concern`; a desk-researchable question turned into a research gate is a `suggestion`.

4. **Coverage of its source.** Proposal: every exit criterion of its milestone (or the whole concern) is met by some step's Acceptance; nothing from a neighbouring milestone is built here unannounced. Architecture and roadmap: every requirement, constraint, risk and validation step the brief states is planned for, and the roadmap ships the cheapest validation first. A gap is a `concern`; a requirement contradicted is a `bug`.

5. **Feasibility and step sizing.** Each code step is one focused, independently mergeable PR that leaves the tree working, with its tests in the same step. A step too big for one PR, a step that breaks the tree until a later one lands (and shares no `Lane:` with it), or a `Lane:` that could be split, is a `concern`.

6. **Dependency order and cross-doc refs.** Steps are in build order. `Depends on:` is complete: a step that needs a gate's outcome but does not depend on that gate is a `bug` (it would be built straight past it); so is a step that uses what another step creates (module, table, endpoint, secret) without depending on it, since lanes would build them in parallel. Every `<file>.md#N` ref and the `Source:` header point at the step or milestone the text means. Conditional work: the alternatives are in `## Design`, the dependent steps depend on the gate, and a ticked gate's `Outcome:` has been followed (pending steps still describing open alternatives after it is a `concern`).

7. **Security and privacy.** Data classes; where personal and sensitive data lives, its retention and deletion; encryption in transit and at rest; third-party processors and what each receives; secrets by NAME only; personal data in fixtures, logs, error messages, analytics and prompts sent to third-party APIs — judged against the `CLAUDE.md` invariants and the architecture's Security section. A missing or empty section where the work handles user data is a `concern`; a plan that violates an invariant, or a credential or personal data quoted in the doc, is a `bug`.

8. **Rollout and operations.** Environments, config and secret NAMES per environment, migrations, flags and defaults, deploy mechanism, monitoring and alerts, rollback. A missing or empty section where the work deploys anything is a `concern`, as is a migration that is not forward and backward compatible, or a deploy with no rollback or monitoring; a destructive or non-reversible migration with no stated plan is a `bug`. `none: <why>` is fine when the why holds.

9. **Testable acceptance.** Every Acceptance is checkable by a test, a command or an observable state, and every gate's Acceptance names the evidence that closes it. Vague criteria ("works", "is fast") are a `concern`. A code step's Acceptance must be provable by `QUALITY_GATES` or by a CI check the architecture names (its `CI job` or `Required checks`): the agent's Linux host cannot build an iOS or Android app, observe device behaviour or run a macOS-only tool. A code step whose Acceptance needs one of those is a `bug` — the lane building it cannot prove it; the fix is a human gate (`research` or `release`) right after the step for the device-only part, or a CI job named in the architecture's `Required checks` and added by an earlier step.

10. **Missing human gates.** Legal or compliance sign-off, go/no-go decisions, account, secret, DNS and provider setup, production release, store submission, flag flips, observation windows, and validation of an assumption with real data: each a person must do is its own gated step, placed right after the code it follows. Missing is a `concern`; a code step that cannot work until the missing gate happens (it reads a secret nobody provisions) is a `bug`. A gate with `Files:` or a `Lane:` is a lint bug already.

    **Release ownership.** Each production release, app-store submission or launch is gated exactly once: by default as a `release` gate in the proposal whose code it ships, right after that code; as a roadmap `release` milestone only when one launch ships several milestones' work together. A release gated twice (a proposal gate and a roadmap milestone for the same launch) is a `bug`; so is a release step that does not depend on the legal or ops gates it needs (a privacy sign-off, the accounts it deploys to) — as `<roadmap file>.md#N` when that gate is a roadmap milestone.

11. **Contradictions with the architecture.** A proposal or roadmap that contradicts an architecture decision, component boundary, data model or invariant without a Decision naming what it supersedes is a `bug`; with one, it is a `concern` that the architecture needs the matching revise.

12. **By kind.** Architecture: each major decision weighs ≥2 options; Quality gates give the exact commands in backticks, and an optional `Required checks` line names each CI check beyond the gates job (a check the roadmap plans no step to create is a `concern`); Invariants are bullets fit for `CLAUDE.md`; Repository layout is concrete; Environments and deployment covers CI/CD, secrets, migrations, monitoring and rollback; Testing states the fixture policy. Roadmap: the Bootstrap ops gate comes first when greenfield; every non-gated milestone names a `Proposal:` and has testable exit criteria; every person-only milestone is a gate; the order validates the riskiest assumptions before building on them. With `--roadmap`, also the cross-doc checks named under *Arguments*.

13. **Assess the whole.** Would building every step, and doing every gate, deliver the source? Is there a simpler design? `Status:` other than `draft` on a doc with blocking findings is worth saying in the summary.

14. **Persist the ledger** (below) — on every run, clean or not. This is the command's only write.

15. **Hand off — do not revise.** Never invoke `/propose` from here; recommend `/propose --revise <doc>` in a fresh session when there are findings. Each finding must carry enough for the reviser to act on it alone: the doc, the section or step title, what is wrong, and the fix.

## Severities

- **bug** — the doc is wrong or would build something wrong: lint errors, contradictions, a dependency that lets a step build past a gate, an invariant violated; blocks acceptance.
- **concern** — a gap, risk or design issue that needs a change or a decision; may block acceptance.
- **suggestion** — a meaningful improvement; not blocking alone.
- **nit** — wording, naming, small cleanup; never blocking.

## Review ledger

A durable per-doc record at `~/.claude/reviews/proposal-<slug>.json` (outside the repo) so `/propose --revise` can apply what was raised and a later review can see what was fixed. `<slug>`: the working directory's base name, `-`, then the doc's path relative to the working directory without `.md`; lowercased, non-alphanumeric runs → `-`, repeats collapsed, leading/trailing `-` trimmed (`docs/design/01-Free_Checker.md` in `~/src/acme` → `acme-docs-design-01-free-checker`). Every repo has an `architecture.md`, so the file name alone would collide.

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

**Recall.** Treat the file as absent when missing, malformed (warn; never overwrite blindly), or when its `repo`/`doc` do not match this working directory and doc. A recalled finding whose `detail` carries `Declined: <reason>` (written by `/propose --revise`): re-report it only if the reason does not hold, and say why.

**Persist & reconcile** (after the review is written; timestamps `YYYY-MM-DDTHH:MM:SSZ` UTC):
1. Match recalled findings to this run's by `file` + semantic `title`, never by line.
2. Recalled `new`/`open` still present → `open`, keep `first_seen`, refresh `line`/`detail`. Recalled `new`/`open` absent → `fixed`, `resolved_at` now (report as *fixed since last review*). Recalled `fixed` that reappears → `open`, clear `resolved_at`, call it a **regression**. Unmatched new finding → append with next `r<N>`, `status: new`. Recalled `fixed` still absent → leave as history.
3. Set `repo`, `doc`, `updated_at`; create `~/.claude/reviews/` if needed; write `proposal-<slug>.json.tmp.<pid>` then rename. On failure, warn and continue — the ledger is an aid, not a correctness requirement. Never overwrite a malformed or foreign file.

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
6. **Ledger** line: new, carried over, fixed since last review, regressions.

If the doc is good, say so briefly — don't manufacture issues. End with exactly one of:
- `Run /propose --revise <doc> in a fresh session to apply the findings.`
- `No revisions needed.`

## Safety

- Read-only: never modify the doc, any other design doc, or the working tree. The sole write is the ledger under `~/.claude/reviews/`.
- Never invoke `/propose` or any other command.
- No git-state changes: no fetch, switch, commit, stage or stash.
- Redact credentials and personal data (names, addresses, emails, phone and account numbers) from anything quoted into the review or the ledger; a doc that contains them gets a `bug` that says where, without repeating them.

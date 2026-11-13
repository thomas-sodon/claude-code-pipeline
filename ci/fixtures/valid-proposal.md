# Proposal: Import bank statements

Status: draft            <!-- draft | accepted | in-progress | done -->
Source: valid-roadmap.md#2
Architecture: valid-architecture.md

## Context

Users reconcile statements by hand. This proposal adds a parser and an import screen.

## Goals

- Parse a statement file into line items that sum to its stated total.

## Non-goals

- Categorising transactions.

## Current state

No code yet; valid-architecture.md fixes the layout and the quality gates.

## Design

A pure parser package feeds an import endpoint. Example input:

```md
1. [ ] **This line is inside a code fence and is not a step.**
```

## Decisions

### D1: Parse in-process (person, 2026-11-05, intake.q2)

- Options: in-process parser, hosted extraction service.
- Choice: in-process parser.
- Why: no statement leaves the machine.
- Consequences: one parser per supported layout.
- Revisit if: more than ten layouts are needed.

## Security and privacy

Statements hold account numbers; they stay on the server and are deleted after import.

## Rollout and operations

None: the feature ships behind no flag and needs no migration.

## Risks and open questions

- Unknown layouts: the parser returns `unparsed`, retired by step 1.

## Steps

1. [ ] **Parse statement files into line items.** Add the parser package and its fixtures.
   - Files: `packages/parser/src/index.ts` (new), `packages/parser/test/parse.test.ts` (new)
   - Depends on: none
   - Acceptance: every fixture statement reconciles to its total; unknown layouts return `unparsed`
   - Lane: parser
2. [ ] **Collect real statements.** Gather redacted samples from four banks.
   - Human gate: research — four redacted statements saved under docs/research/
   - Depends on: none
   - Acceptance: one statement per bank, total recorded
3. [ ] **Add the import endpoint.** Accept an upload and return the parsed items.
   - Files: `apps/api/src/import.ts` (new),
     `apps/api/test/import.test.ts` (new)
   - Depends on: 1, 2
   - Acceptance: uploading a fixture returns its line items;
     an oversized upload is rejected with 413

## Out of scope

- Exporting statements.

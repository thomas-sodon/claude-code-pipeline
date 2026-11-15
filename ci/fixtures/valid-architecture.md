# Architecture: Statement importer

Status: draft
Source: docs/brief.md

## Context

People reconcile bank statements by hand.

## System overview

A web app calls an API that parses uploaded statements in-process.

## Components

- `packages/parser`: pure statement parser.
- `apps/api`: HTTP API.

## Data model

- `import(id, user_id, created_at, total)`; line items reference their import.

## Decisions

### D1: One repository (assumed)

- Options: one repository, one per package.
- Choice: one repository.
- Why: one CI, atomic changes.
- Consequences: workspace tooling.
- Revisit if: teams split.

## Security and privacy

Statements are deleted after import; account numbers are never logged.

## Invariants

- Never log a statement's contents.
- Every parser change ships with a fixture.

## Repository layout

- `packages/parser/`, `apps/api/`, `docs/design/`.

## Quality gates

- QUALITY_GATES: `npm run lint && npm run typecheck && npm test`
- QUALITY_GATES_FAST: `npm run lint && npm test`

## Environments and deployment

Staging and production; CI deploys main to staging; a person promotes to production.

## Testing

Unit tests per package; fixtures are synthetic or redacted, never real account data.

## Risks and open questions

- Layout drift: retired by the research gate in the first proposal.

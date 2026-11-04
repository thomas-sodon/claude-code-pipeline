# Roadmap: Statement importer

Status: draft
Source: docs/brief.md
Architecture: valid-architecture.md

## Milestones

1. [ ] **Bootstrap the repository.** Create the skeleton and CI.
   - Human gate: ops — run /bootstrap valid-architecture.md, review, push the root commit, protect main
   - Depends on: none
   - Acceptance: CI green on main
2. [ ] **Import bank statements.** Parse and import statement files.
   - Proposal: valid-proposal.md
   - Depends on: 1
   - Acceptance: a user imports a real statement and the total matches
3. [ ] **Go / no-go on paid tiers.** Decide from the first month of usage.
   - Human gate: decision — stop criteria from the brief
   - Depends on: 2
   - Acceptance: decision and reasons recorded under Outcome

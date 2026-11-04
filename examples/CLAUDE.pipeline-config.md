<!-- Paste this section into your project's root CLAUDE.md and edit the values.
     PROPOSALS_DIR is where /roadmap and /propose write the design docs, and where /plan and /impl read them.
     /seed writes a base section (MAIN_BRANCH, PROPOSALS_DIR) with no QUALITY_GATES: on an existing project, add the
     gates yourself; on a greenfield one, /bootstrap completes it from the accepted architecture (QUALITY_GATES,
     QUALITY_GATES_FAST, TEST_GUIDELINES). Neither writes PLANS_DIR, GH_WRAPPER or GATE_WRAPPER: add GATE_WRAPPER
     yourself when several agents share a host. -->

## Pipeline config

QUALITY_GATES: npm run lint && npm run typecheck && npm test -- --coverage
QUALITY_GATES_FAST: npm run lint && npm test -- --onlyChanged
MAIN_BRANCH: main
PLANS_DIR: ~/.claude/plans
PROPOSALS_DIR: docs/design
GATE_WRAPPER: ./.claude/scripts/gate-slot.sh
TEST_GUIDELINES: CLAUDE.md#testing

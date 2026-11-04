<!-- Paste this section into your project's root CLAUDE.md and edit the values.
     PROPOSALS_DIR is where /roadmap and /propose write the design docs, and where /plan and /impl read them.
     On a greenfield project, /bootstrap writes this section for you. -->

## Pipeline config

QUALITY_GATES: npm run lint && npm run typecheck && npm test -- --coverage
QUALITY_GATES_FAST: npm run lint && npm test -- --onlyChanged
MAIN_BRANCH: main
PLANS_DIR: ~/.claude/plans
PROPOSALS_DIR: docs/design
GATE_WRAPPER: ./.claude/scripts/gate-slot.sh
TEST_GUIDELINES: CLAUDE.md#testing

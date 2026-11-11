<!-- Paste this section into your project's root CLAUDE.md and edit the values.
     PROPOSALS_DIR is where /roadmap and /propose write the design docs, and where /plan and /impl read them.
     /seed writes a base section (MAIN_BRANCH, PROPOSALS_DIR) with no QUALITY_GATES: on an existing project, add the
     gates yourself; on a greenfield one, /bootstrap completes it from the accepted architecture (QUALITY_GATES,
     QUALITY_GATES_FAST, TEST_GUIDELINES). Neither writes PLANS_DIR, GH_WRAPPER, GATE_WRAPPER or GITHUB_ACCESS: add
     GATE_WRAPPER yourself when several agents share a host, and GITHUB_ACCESS: connector where gh is not logged in,
     as in Claude Code cloud sessions, so the PR and issue stages use the GitHub MCP connector (gh or connector;
     unset = gh when it is authenticated, else the connector; /bootstrap keeps the line when it completes the
     section). -->

## Pipeline config

QUALITY_GATES: npm run lint && npm run typecheck && npm test -- --coverage
QUALITY_GATES_FAST: npm run lint && npm test -- --onlyChanged
MAIN_BRANCH: main
PLANS_DIR: ~/.claude/plans
PROPOSALS_DIR: docs/design
GATE_WRAPPER: ./.claude/scripts/gate-slot.sh
TEST_GUIDELINES: CLAUDE.md#testing

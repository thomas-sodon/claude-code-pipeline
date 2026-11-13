## How work happens here

<!-- How work happens here written by /seed: pipeline-sync.py reports when this section differs from the pipeline's template -->

- A product brief or large change goes through `/roadmap`, `/propose` and `/review-proposal` (the `brief-to-proposals` workflow runs them) before any code.
- Design docs are drafts until a person sets `Status: accepted`; nothing is built from a draft.
- Every human-gated step (research, decisions, accounts and secrets, releases) is done and ticked by a person, with its `Outcome:` recorded.
- Code is built lane by lane with `proposal-build-chain` and `plan-to-merged-pr`; never push to `main`, never force-push; a person merges.
- Secrets are named, never written down: values live in the CI secret store, the host's secret manager, or a gitignored `.env`.
- A choice that is the person's (who the product is for and what is left out, platforms, money and accounts, the licence and legal posture, personal data, names, the repository, go and stop criteria, a provider they must run) is asked, never assumed: every such question in one batch, each with options and a recommendation, through the session's question tool. A workflow stops with `needs_input` instead; whoever ran it asks the person, never answers for them, re-runs it with `answers`, and passes `on_question: 'assume'` only when the person said to proceed on assumptions. What the person said is never changed without asking them again; design docs tag each decision `(person, <date>)`, `(source)` or `(assumed)`, the assumed ones are shown to the person before they accept the doc, and every other assumption is listed in the report.
- The session that runs the workflows hands off with `/handoff` before its context passes half the window, and never compacts; a new session starts from `STATE.md` on the state branch (`python3 .claude/scripts/pipeline-state.py get STATE.md`).

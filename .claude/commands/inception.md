Take an original software idea to inception with the `idea-to-inception` workflow: clarifying questions, competing architectural proposals, the user's decision, the inception documents and — if the user chooses — the walking skeleton and the later steps. The workflow stops at every decision and asks; this command relays each question to the user and never answers one itself.

## Arguments

`$ARGUMENTS` is the idea, in the user's words. If it is empty, ask the user to describe the idea (what it is, who it is for) and stop until they reply. Use the user's words as given; do not rephrase or enrich them.

## Run the loop

1. **Start.** Call the Workflow tool with `name: "idea-to-inception"` and `args: { idea: "<the idea>" }` — an object, not a JSON string. If the user named a repository other than the current one, or a directory for the worktrees, add `repo` or `root` (absolute paths).
2. **At each gate** the workflow returns `status: "needs_input"` with `gate`, `summary`, `artifacts`, `questions`, `next_args` and `how_to_continue`. Then:
   - Tell the user in two to four lines where the run stands (`summary`) and which files to read before answering (`artifacts`: the brief, the proposals, the comparison, the design doc — give the paths).
   - Ask **every** question with AskUserQuestion, at most four per call, in the order given, using each question's `header`, `question`, `options` (label and description) and `multiSelect` as given; you may append its `why` to the question text. Do not answer, skip, merge, reword or pre-select any question — not even one with a "(Recommended)" option. The user may answer in their own words.
   - Copy `next_args` and set `next_args.answers[<question id>]` for each question: the chosen option's label (for a multiSelect question, an array of labels — `[]` when the user picks none), or the user's own words when they answered under Other. Leave `next_args.state` exactly as returned.
   - Call the Workflow tool again with `name: "idea-to-inception"` and those args. Do not pass `resumeFromRunId` for a gate: the state travels in the args.
3. **Repeat** until the status is anything other than `needs_input`. If a run was interrupted mid-stage (no result, or the session restarted), call it again with the same args — and, when the interrupted run belongs to this session, `resumeFromRunId` set to its run id, so agents that finished replay instead of running again.

## Report

When the workflow finishes, report its status and the artifacts, then:

- `built`: the inception PR and its last state; each lane's step, branch and status; `open_questions` the build could not answer; and `ship_plan` — the `plan-to-merged-pr` args that ship each lane once every PR below it has merged (the second lane onward needs `predecessor_prs` filled in).
- `docs_pr`: the PR. `docs_committed`: the branch and worktree, and `resume_args` to build later.
- `blocked` or `failed_at_<stage>`: the reason, and the `retry_args` (or `resume_args`) to run the workflow with once it is fixed.

A build that stopped part-way (`failed_at_skeleton`, `failed_at_inception_pr`, `lanes_stopped`) keeps everything that pushed; `how_to_continue` says what it needs. If a step stopped with a question (`stop_reason`), ask the user that question — never answer it yourself — and run `retry_args` with their answer as `build_context`. If a human-gated step blocks the lanes, ask the user whether they have done it, and once they have, run `retry_args` with `human_done: [<step>]`.

## Rules

- The user owns every decision. A recommendation is shown, never taken; an unanswered question is asked again, never filled in.
- Do not edit files in the inception worktree between gates: the workflow's agents own them until it finishes.
- Never change `next_args.state`. To start over, run the workflow again without `state` and `answers`.
- Merging is the user's: never merge the inception PR or any lane PR.

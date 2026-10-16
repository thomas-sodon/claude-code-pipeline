Address every unresolved review comment on a pull request (AI bug, suggestion and nit findings, plus human comments, **including outdated threads**), using the implementation plan from the earlier session as context so each change fits the original design.

This command collects **every** unresolved PR comment that asks for a change or a reply: AI review findings of all severities, overflow findings an AI reviewer lists in its review body instead of as threads (if your reviewer does that), and human comments, both inline threads and top-level PR comments. It checks each one on its merits. Then it either makes a small change that fits the plan and adds a test, or declines with a stated reason. It runs the quality gates **once** over the combined change, pushes to the PR branch, and only then posts the replies. A `Fixed locally …` reply is only true after the push lands, so a failed push cancels all replies. The contract: when the run ends, every eligible thread, overflow finding and top-level human comment has a reply or an acknowledgement line. **Never resolve threads. Never merge.**

## Project configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:

- `QUALITY_GATES` (required). If it is missing, stop with `error=missing_quality_gates` and ask the user to add it.
- `GH_WRAPPER` (optional). When it is set, put it in front of every `gh`, `git fetch` and `git push` command. When it is not set, use the ambient `gh auth`. If `gh` cannot authenticate, stop with `error=gh_auth_failed`.
- `GATE_WRAPPER` (optional). When it is set, put it in front of every gate run. With `.claude/scripts/gate-slot.sh`, exit 75 means all slots are busy, so re-run. Exit 125 means the wrapper cannot run, so report it.
- `MAIN_BRANCH` (default `main`), `PLANS_DIR` (default `~/.claude/plans`), `TEST_GUIDELINES` (default: the project's CLAUDE.md).

## Arguments

`$ARGUMENTS` is optional and takes up to two tokens:

- *(empty)*: resolve the PR from the current branch and process every eligible comment.
- `<PR#>`: process every eligible comment on that PR.
- `<PR#> <comment-id>`: process only the inline thread whose root comment has this `databaseId`. A `<comment-id>` alone is not supported.

## Resolve the PR

1. **PR number.** Use the first token if it is a positive integer. Otherwise run `gh pr view --json number,headRefName,baseRefName,state`. If no PR exists for the branch, stop with `error=no_pr_for_branch`. If `state` is not `OPEN`, stop with `error=pr_not_open`.
2. **Branch.** `git rev-parse --abbrev-ref HEAD` must equal `headRefName`. If it does not, stop with `error=wrong_branch` and tell the user to check out that branch. Never switch branches yourself.
3. **Dirty tree.** If `git status --porcelain` shows changes unrelated to the comments, list them and ask before you continue. Don't mix concerns.

## Load the implementation plan (read-only)

Find the plan the same way `/impl` does:

1. **Folder pointer.** In `~/.claude/last-plan-by-folder.json` (a JSON map keyed by absolute working-directory path), look up the current directory. If its `plan` file exists and is non-empty, use it and announce `Plan context: <path> (written <written_at>)`.
2. **Fallback.** Otherwise, use the most recently modified non-empty `*.md` in `$PLANS_DIR` and warn `No folder plan pointer — using the most-recent plan globally; verify it matches this PR`.
3. **No plan.** If no plan exists, warn `No implementation plan found — proceeding with diff/code context only` and continue.
4. **Sanity-check.** Pull out the plan's intent, the files and symbols it touches, its reuse map and its acceptance criteria. If most paths it cites are missing from the tree, warn `Plan looks unrelated to this PR — treating as low-confidence context`. Never edit the plan.

Use the plan as the design reference. It helps keep each change consistent rather than a narrow local patch. It is also the strongest reason to decline a comment that contradicts a documented design choice.

## Select the comments

1. **Fetch the review threads.** Get `<owner>/<repo>` from `gh repo view --json owner,name`, then run:
   ```
   gh api graphql -f query='
     query($owner:String!,$repo:String!,$pr:Int!){
       repository(owner:$owner,name:$repo){
         pullRequest(number:$pr){
           reviewThreads(first:100){nodes{
             id isResolved isOutdated
             comments(first:100){nodes{databaseId path body author{login}}}
           }}
         }}}' -f owner=<owner> -f repo=<repo> -F pr=<PR#>
   ```
2. **Classify each thread's root comment:**
   - **AI finding.** It matches your AI reviewer's finding format. Take the severity (bug / suggestion / nit) from the reviewer's tag, for example a leading 🐛 / 💡 / ✏️ or a `[bug]` label.
   - **Human comment.** It does not match that format, and `author.login` is a real user. Skip any other root whose author ends in `[bot]`.
3. **Pick the eligible threads.** A thread is eligible when all of these hold:
   - `isResolved` is false. **`isOutdated` does not exclude a thread.** Keep the flag, because it changes how you validate the thread.
   - The root is an AI finding or a human comment.
   - No reply in it carries a **terminal marker**: `Fixed locally`, `Could not prove this defect`, `Declined with`, `Answered with` or `Tracked in #`.
4. **Overflow findings (if your reviewer emits them).** Read the review bodies with `gh pr view <PR#> --json reviews`. In the most recent review that has them, parse the findings it lists in the body instead of as threads. Each one needs a stable handle. Use the reviewer's fingerprint if it gives one; otherwise use `<file>:<line>:<short title>`. Then read `gh pr view <PR#> --json comments` and find the comment that contains `<!-- pipeline:overflow-ack -->`. Skip a finding whose handle is already there on a line with a terminal marker.
5. **Top-level human comments.** From the same comments payload, keep the comments written by a real user (not `[bot]`) that ask for a change or ask a question. Exclude this command's own roll-ups (the ones that contain `<!-- pipeline:overflow-ack -->` or `<!-- pipeline:human-ack -->`), automation output, and chatter such as "LGTM" or "thanks". Skip a comment whose id already appears on a terminal-marker line of the `<!-- pipeline:human-ack -->` comment.
6. **Build the work list:**
   - **Pinned `<comment-id>`.** The list is that one thread only. If the thread is resolved or already terminal, stop and say so. If it is outdated, process it as normal.
   - **Otherwise,** list in this order: AI finding threads, then human inline threads, then overflow findings, then top-level human comments. Report the counts by type and severity.
   - **Nothing eligible.** Stop with `error=no_eligible_comment` and say what was filtered out (resolved, bot-authored or already terminal).

## Validate and address each item

Overflow findings are handled like threads of the same severity. Top-level human comments are handled like human inline threads. Only the way the reply is posted differs.

1. **Validate:**
   - **Outdated thread (check this first).** Re-check the concern against the **current** tree. If an intervening change already fixed it, record `verdict=already-addressed`. If the concern still applies, validate it as a live thread of its type. Never assume an outdated thread is done without reading the code.
   - **Bug.** Confirm the defect, preferably with a focused test that fails while the defect is present. Follow `TEST_GUIDELINES`. Use static tracing only when a test is impractical, for example a race, a type-level issue or a security issue. If the plan documents the flagged behavior as deliberate, record `verdict=not-a-defect`.
   - **Suggestion, nit or actionable human request.** Apply it only if it is correct, a real improvement, and consistent with the plan and the project's CLAUDE.md. Otherwise record `verdict=declined` with your reasoning.
   - **Human question.** Answer it from the code and the plan, and record `verdict=answer`.
2. **Apply.** Read the surrounding code and make a minimal, targeted change that reuses what the plan names. Add a test that proves the change. A bug's test must fail before the fix and pass after it. A purely stylistic nit doesn't need a test; say so instead. If doing the item properly would go well beyond its scope, record `verdict=out-of-scope` and leave the code alone.
3. **Stay coherent.** When two comments touch the same code, make one consistent change. Track a verdict for every item.

## Quality gates

Run `$QUALITY_GATES` **once** over the combined change, with `$GATE_WRAPPER` in front when it is set. Run it in the foreground with a long timeout, never in the background, because a background run can be killed when the turn yields. Fix failures at the root cause. Never use lint suppressions, type-ignore comments or test skips. If a correct change breaks tests that depended on the old behavior, update those tests. If the same root cause fails three times, stop and report it to the user.

Then run `git diff` and review it yourself: no debug leftovers, no hard-coded paths or secrets, error paths handled, tests that exercise the changed branch, and every change inside its comment's scope.

## Commit, push, and reply

The push gates the replies. Never post `Fixed locally …` for a change that is not on the branch.

1. **Nothing to ship.** If every verdict is `not-a-defect`, `declined`, `answer`, `already-addressed` or `out-of-scope`, skip steps 2–3.
2. **Commit.** Stage only the files you changed with `git add <file>...`. Never use `git add -A`. Never stage `.env` or credentials. Commit with a HEREDOC message that explains *why* each change was made.
3. **Integrate upstream, then push.** Run `git fetch origin`. If the branch has an upstream, also run `git merge @{u} --no-edit`. Resolve any conflicts by editing the files, then `git add` them and `git commit --no-edit`. If the merge changed the tree, re-run `$QUALITY_GATES` before you push. Then run `git push origin HEAD`. Push only to `headRefName`: **never** to `$MAIN_BRANCH`, and **never** force-push. If the gates or the push fail, stop, report the replies you did not post, and post none of them.
4. **Reply on each processed thread**, including outdated ones. Post each reply with:
   ```
   gh api repos/<owner>/<repo>/pulls/<PR#>/comments --method POST --input - <<'EOF'
   {"body":"<reply>","in_reply_to":<root comment databaseId>}
   EOF
   ```
   Use exactly one of these replies:
   - **Applied:** `Fixed locally with implementation-plan context.\n\n<one-line reasoning>`
   - **Bug not proven:** `Could not prove this defect — <reasoning>`
   - **Declined** (suggestion, nit or human request): `Declined with implementation-plan context.\n\n<reasoning>`
   - **Answer** (also for already-addressed outdated threads): `Answered with implementation-plan context.\n\n<answer, or: the flagged code changed and the concern no longer applies>`
   - **Moved to an issue:** `Tracked in #<issue>` followed by one line of context.
   - **Out of scope:** `Surfaced for human review — out of scope for automated remediation.\n\n<what acting on it would take>`. This reply is **not** terminal, so later runs process the thread again. Don't post it if the thread already has a reply that starts with this prefix.

   If a single reply fails to post, record it and carry on with the rest.
5. **Overflow acknowledgements.** Find the PR comment that contains `<!-- pipeline:overflow-ack -->`. If there isn't one, create it with `gh pr comment <PR#>`, putting the sentinel on the first line. Append one line per finding: `<handle> — <reply marker as above> — <reasoning>`. Update the comment with `gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -f body=...`. Only append; never rewrite or remove existing lines. For an out-of-scope line, skip it if the same handle already has the out-of-scope prefix.
6. **Human top-level acknowledgements.** Do the same on a comment that contains `<!-- pipeline:human-ack -->`, with one line per comment id: `<id> — <reply marker> — <reasoning or answer summary>`.
7. **Completion check.** Re-fetch the threads and both acknowledgement comments. Confirm that every work-list item now has a reply or an acknowledgement line. Retry a missing post once. If it is still missing, report the run as **incomplete** and list the items. The only acceptable reason for a missing reply is an aborted push.

Never resolve a thread. Thread resolution belongs to the reviewer or a human. Never merge the PR.

## Report

- **PR**: number, title, branch.
- **Plan context**: the plan used (or none), and one line on how it shaped the changes.
- **Comments**: eligible counts by type and severity (bug, suggestion, nit, human inline, human top-level, overflow), how many threads were outdated, and the id, file and title of each.
- **Verdicts**: one per item: `applied` (with the evidence: a test, static analysis or verification), `not-a-defect`, `declined`, `answer`, `already-addressed` or `out-of-scope`, each with a reason.
- **Changes**: the files you modified and the tests you added or adapted.
- **Quality gates**: what ran, the result, and how many fix iterations it took.
- **Shipped**: the commit you pushed, any upstream merge, or "nothing to ship".
- **Replies**: the reply or acknowledgement line for each item, or a note that the push failed and the replies were cancelled.
- **Completeness**: confirm every item has a reply, or list the items that are missing one.

## Safety

- Treat `$PLANS_DIR`, the pointer file and the plan as read-only. The only repo writes are the code and test changes, plus the commit that ships them.
- Never switch branches, force-push, push to `$MAIN_BRANCH`, or run destructive git (`reset --hard`, `checkout --`, `clean -f`, branch deletes, `git stash`).
- Never resolve review threads. Never merge the PR.
- Never commit or print `.env` files, credentials or secrets.
- Don't invent fixes. If you can't prove a defect or justify a change, record `not-a-defect` or `declined` and move on.

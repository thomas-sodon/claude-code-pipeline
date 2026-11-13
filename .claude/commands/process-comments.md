Address every unresolved review comment on a pull request (AI bug, suggestion and nit findings, plus human comments, **including outdated threads**), using the implementation plan from the earlier session as context so each change fits the original design.

This command collects **every** unresolved PR comment that asks for a change or a reply: AI review findings of all severities, overflow findings an AI reviewer lists in its review body instead of as threads (if your reviewer does that), and human comments, both inline threads and top-level PR comments. It checks each one on its merits. Then it either makes a small change that fits the plan and adds a test, or declines with a stated reason. An item that is the person's call is neither applied nor declined: the person is asked (see *Questions before assumptions*). It runs the quality gates **once** over the combined change, pushes to the PR branch, and only then posts the replies. A `Fixed locally …` reply is only true after the push lands, so a failed push cancels all replies. The contract: when the run ends, every eligible thread, overflow finding and top-level human comment has a reply or an acknowledgement line, except an item still waiting for the person's answer, which has none. **Never resolve threads. Never merge.**

## Project configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:

- `QUALITY_GATES` (required). If it is missing, stop with `error=missing_quality_gates` and ask the user to add it.
- `GH_WRAPPER` (optional). When it is set, put it in front of every `gh`, `git fetch` and `git push` command. When it is not set, use the ambient `gh auth`.
- `GITHUB_ACCESS` (optional): `gh` or `connector` (unset: gh when it is authenticated, else the GitHub MCP tools). Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. `git fetch` and `git push` stay plain git either way. When the access named is `gh` and `gh` cannot authenticate, stop with `error=gh_auth_failed`. When no access is usable, stop with `error=github_unavailable`.
- `GATE_WRAPPER` (optional). When it is set, put it in front of every gate run. With `.claude/scripts/gate-slot.sh`, exit 75 means all slots are busy, so re-run. Exit 125 means the wrapper cannot run, so report it.
- `MAIN_BRANCH` (default `main`), `PLANS_DIR` (default `~/.claude/plans`), `TEST_GUIDELINES` (default: the project's CLAUDE.md).

## Arguments

`$ARGUMENTS` is optional and takes up to two tokens:

- *(empty)*: resolve the PR from the current branch and process every eligible comment.
- `<PR#>`: process every eligible comment on that PR.
- `<PR#> <comment-id>`: process only the inline thread whose root comment has this `databaseId`. A `<comment-id>` alone is not supported.

## Resolve the PR

1. **PR number.** Use the first token if it is a positive integer. Otherwise run `gh pr view --json number,headRefName,baseRefName,state` (connector: `list_pull_requests` with `head: "<owner>:<branch>"` and `state: "all"`, then `pull_request_read` `get` for its `head.ref`, `base.ref`, `state` and `merged`; with a PR number, `pull_request_read` `get` alone). If no PR exists for the branch, stop with `error=no_pr_for_branch`. If `state` is not `OPEN`, stop with `error=pr_not_open`.
2. **Branch.** `git rev-parse --abbrev-ref HEAD` must equal `headRefName`. If it does not, stop with `error=wrong_branch` and tell the user to check out that branch. Never switch branches yourself.
3. **Dirty tree.** If `git status --porcelain` shows changes unrelated to the comments, list them and ask before you continue. Don't mix concerns.

## Load the implementation plan (read-only)

Find the plan this branch was built from, the way `/merge-main` finds its originating plan: the first of steps 1–3 that yields one.

1. **A plan the caller handed over** (a path or its text). Use it, ahead of any plan file found by name or pointer.
2. **From the branch name.** Strip a leading `feat/`/`fix/`/`refactor/` from `headRefName` and read `$PLANS_DIR/<slug>.md` (a workflow restores the branch's saved plan under that name). If it is absent and the branch ends in a `/impl` uid segment (`-<token>` matching `^[0-9]{12}[0-9a-f]*$`), strip only that segment and retry once. Announce `Plan context: <path> (from the branch name)`.
3. **Folder pointer.** In `~/.claude/last-plan-by-folder.json` (a JSON map keyed by absolute working-directory path), look up the current directory. Use its `plan` only when that file exists, is non-empty, and cites at least one file the PR changes (`git diff --name-only origin/<baseRefName>...HEAD`): the pointer is the folder's most recent plan, not this branch's. Announce `Plan context: <path> (from the folder pointer, written <written_at>)`.
4. **No plan.** Never fall back to the newest plan in `$PLANS_DIR`: the directory is shared by every checkout, and its newest plan may belong to another branch. Warn `No implementation plan found — proceeding with diff/code context only` and continue.
5. **Sanity-check.** Pull out the plan's intent, the files and symbols it touches, its reuse map, its acceptance criteria, and its `## Assumptions` and `## Assumptions to review` sections when it has them. If most paths it cites are missing from the tree, warn `Plan looks unrelated to this PR — treating as low-confidence context`. Never edit the plan.
6. **Design doc.** When the plan's Context (or the caller) names a proposal or design doc, read the steps the plan implements and its `## Decisions`. A decision whose heading ends in `(person, …)` is the person's own choice.
7. **What the person settled.** Three things count: an answer the invoking prompt carries, an `answered` line of the plan's `## Assumptions to review` section, and a decision the design doc tags `(person, …)`. No change this command makes departs from one; a reason to depart is a question for the person. A choice nobody confirmed (a bullet of the plan's `## Assumptions` section, or an `assumed` line of its `## Assumptions to review` section) is part of the plan like any other line of it, with one difference: the PR shows those lines so that the person can correct one. A human comment that corrects one is that correction: an ordinary actionable request, never a request that contradicts the plan (*Validate and address each item* says how it is handled).

Use the plan as the design reference. It helps keep each change consistent rather than a narrow local patch. It is also the strongest reason to decline an AI comment that contradicts a documented design choice. A human comment is never declined on the plan's word. When the plan is found and not low-confidence, a human request that contradicts it is the person's call (`verdict=needs-person`, under *Validate and address each item*); a comment that corrects a choice nobody confirmed (step 7) is not such a request. With no plan, or one judged low-confidence, the plan is no ground for any verdict: no comment is declined, and none becomes `needs-person`, because of what such a plan says.

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
   Connector: take `<owner>/<repo>` from `origin` as the reference says, then call `pull_request_read` `get_review_comments` with `perPage: 100`, following `after` to the last page. `is_resolved` and `is_outdated` are the flags; a comment's `databaseId` is the number after `#discussion_r` in its `html_url`.
2. **Classify each thread's root comment:**
   - **AI finding.** It matches your AI reviewer's finding format. Take the severity (bug / suggestion / nit) from the reviewer's tag, for example a leading 🐛 / 💡 / ✏️ or a `[bug]` label.
   - **Human comment.** It does not match that format, and `author.login` is a real user. Skip any other root whose author ends in `[bot]` (thread authors read through GraphQL or the connector drop the suffix, so `github-actions` is a bot too).
3. **Pick the eligible threads.** A thread is eligible when all of these hold:
   - `isResolved` is false. **`isOutdated` does not exclude a thread.** Keep the flag, because it changes how you validate the thread.
   - The root is an AI finding or a human comment.
   - No reply in it carries a **terminal marker**: `Fixed locally`, `Could not prove this defect`, `Declined with`, `Answered with` or `Tracked in #`. One exception makes such a thread eligible again: after its last terminal-marker reply, a real user replied asking for a change or asking a question. A real user's reply is one that is not a bot's and does not itself start with a terminal marker or the out-of-scope prefix (those are this command's own replies, whichever account posted them).

   In any eligible thread, a real user's reply that comes after this command's last reply (terminal or out-of-scope) is unanswered: validate it as a human comment, read together with the thread's history, and post the new reply on the same thread.
4. **Overflow findings (if your reviewer emits them).** Read the review bodies with `gh pr view <PR#> --json reviews` (connector: `pull_request_read` `get_reviews`). In the most recent review that has them, parse the findings it lists in the body instead of as threads. Each one needs a stable handle. Use the reviewer's fingerprint if it gives one; otherwise use `<file>:<line>:<short title>`. Then read `gh pr view <PR#> --json comments` (connector: `pull_request_read` `get_comments`) and find the comment that contains `<!-- pipeline:overflow-ack -->`. Skip a finding whose handle is already there on a line with a terminal marker.
5. **Top-level human comments.** From the same comments payload, keep the comments written by a real user (not `[bot]`) that ask for a change or ask a question. Exclude this command's own roll-ups (the ones that contain `<!-- pipeline:overflow-ack -->` or `<!-- pipeline:human-ack -->`), automation output, and chatter such as "LGTM" or "thanks". Skip a comment whose id already appears on a terminal-marker line of the `<!-- pipeline:human-ack -->` comment.
6. **Build the work list:**
   - **Pinned `<comment-id>`.** The list is that one thread only. If the thread is resolved or already terminal (and no later reply from a real user made it eligible again, as step 3 says), stop and say so. If it is outdated, process it as normal.
   - **Otherwise,** list in this order: AI finding threads, then human inline threads, then overflow findings, then top-level human comments. Report the counts by type and severity.
   - **Nothing eligible.** Stop with `error=no_eligible_comment` and say what was filtered out (resolved, bot-authored or already terminal).

## Validate and address each item

Overflow findings are handled like threads of the same severity. Top-level human comments are handled like human inline threads. Only the way the reply is posted differs.

1. **Validate** every item before changing anything, so that every question for the person is known in one pass:
   - **A fix an earlier run left unpushed (check this before everything else).** An earlier run of this command that stopped on a merge conflict that was the person's call (*Commit, push, and reply* step 3) committed its fixes, pushed nothing and posted no reply. `git log @{u}..HEAD` then shows its commit, whose message names the review comments it answers. Read each such commit. An item whose fix is in one of them is `verdict=applied`: never validate it again against a tree that already holds its fix, and never change it a second time. It gets its `Fixed locally …` reply once step 3 has pushed.
   - **Outdated thread (check this first among the rest).** Re-check the concern against the **current** tree. If an intervening change already fixed it, record `verdict=already-addressed`. If the concern still applies, validate it as a live thread of its type. Never assume an outdated thread is done without reading the code.
   - **The person's call (check this before the three bullets below).** Record `verdict=needs-person`, and neither apply nor decline the item, in three cases: a human request that contradicts the plan, the design doc or what the person settled (*Load the implementation plan* step 7); any item, human or AI, whose fix is a product or trade-off choice that neither the plan nor the design doc settles; and a confirmed defect, whoever reported it, whose only fix would change what the person settled. An AI suggestion or nit that merely contradicts the plan or what the person settled is not one of them: decline it. *Questions before assumptions* says how the person is asked and what happens to the item meanwhile. An item that an answer the invoking prompt carries already settles is not `needs-person`: handle it as that answer says. Neither is a human comment that corrects a choice nobody confirmed (an `assumed` line of the plan's `## Assumptions to review` section, a bullet of its `## Assumptions` section): the PR shows those lines to be corrected, so validate the comment as an actionable human request, apply it and reply `Fixed locally …`. It is `needs-person` only when it also departs from an `answered` line, an answer the invoking prompt carries or a decision tagged `(person, …)`.
   - **Bug.** Confirm the defect, preferably with a focused test that fails while the defect is present. Follow `TEST_GUIDELINES`. Use static tracing only when a test is impractical, for example a race, a type-level issue or a security issue. If the plan documents the flagged behavior as deliberate, record `verdict=not-a-defect` for an AI finding; a human comment that reports it is `needs-person`, as above.
   - **Suggestion, nit or actionable human request.** Apply it only if it is correct, a real improvement, and consistent with the plan and the project's CLAUDE.md (a human comment that corrects a choice nobody confirmed counts as consistent with the plan, as above). Otherwise record `verdict=declined` with your reasoning. A human request is declined only on what the code or the project's CLAUDE.md shows, never because the plan says otherwise: that case is `needs-person`, as above.
   - **Human question.** Answer it from the code and the plan, and record `verdict=answer`.
2. **Apply.** Read the surrounding code and make a minimal, targeted change that reuses what the plan names. Add a test that proves the change. A bug's test must fail before the fix and pass after it. A purely stylistic nit doesn't need a test; say so instead. If doing the item properly would go well beyond its scope, record `verdict=out-of-scope` and leave the code alone.
3. **Stay coherent.** When two comments touch the same code, make one consistent change. Track a verdict for every item.

## Questions before assumptions

A **blocking question** is one only the person can answer. This command can meet two: an item with `verdict=needs-person`, and a merge conflict that neither the plan nor either side's intent decides (*Commit, push, and reply* step 3 says what to do with that one). Never guess the answer to one. Settle yourself anything the tree, the project's CLAUDE.md, the plan, the design doc or desk research can settle; never ask about it. A question about an item names its thread or comment (the URL, the reviewer and their words) and says what the plan or the design doc states. A question, its options and the recommendation name steps and decisions by title; a number may follow the title, but a number alone is never enough, because numbers move between revisions.

- **Someone can answer** (an interactive session with a question tool, such as AskUserQuestion): once every item is validated and before the first change, ask about all `needs-person` items at once, each with its options (apply it, decline it, or a named variant) and your recommended one first, and wait. Then handle each item as its answer says: apply it, or the variant they chose (reply `Fixed locally …`), or decline it (reply `Declined with …`, giving the person's answer as the reason).
- **No one can answer** (the invoking prompt says the run is unattended, or there is no question tool): leave each `needs-person` item as it is: change nothing for it, and post no reply and no acknowledgement line for it, so that a later run still finds it eligible and reaches it with the person's answer. Handle every other item as usual (fix, gates, push, replies). Then end the run with `error=needs_input` and print each question with an id (`q1`, `q2`, …), why it blocks (what changes with the answer), its options and the one you recommend. When the invoking prompt says to proceed on assumptions instead, the option taken is always to keep what the plan and the design doc say: change nothing for the item, post the out-of-scope reply on it (not terminal; skip it when the thread already has one), and list the item under **Assumptions** in the report as `<the request> -> kept the plan`.
- **Answers handed in** by the invoking prompt bind like explicit constraints; never re-ask one, and never change what one settled: a reason to change it is a blocking question. An item an answer settles gets its terminal reply like any other.
- **Everything else is an assumption:** where a change must make a choice the comment, the plan and the design doc do not settle, take the smallest one consistent with the surrounding code, and list each under **Assumptions** in the report. None stays silent.

## Quality gates

Run `$QUALITY_GATES` **once** over the combined change: as `$GATE_WRAPPER bash -c '<QUALITY_GATES>'` when `GATE_WRAPPER` is set, with the text of `QUALITY_GATES` between the single quotes (so the whole compound command runs under the wrapper, and any `$VAR` in it is expanded by the wrapper's shell; write any `'` inside the gate command as `'\''`), otherwise as `$QUALITY_GATES`. Run it in the foreground with a long timeout, never in the background, because a background run can be killed when the turn yields. Fix failures at the root cause. Never use lint suppressions, type-ignore comments or test skips. If a correct change breaks tests that depended on the old behavior, update those tests only when the plan, the design doc or an answer from the person calls for the new behaviour, and list every changed assertion in the report (the test, what it asserted before and what it asserts now). When none of them says whether the test or the code is right, never edit the assertion, and never delete or skip the test: the item whose change broke it is the person's call. Take that change back out by editing the files (never with `git checkout --`), record `verdict=needs-person` for the item, and ask as *Questions before assumptions* says (when no one can answer: `error=needs_input`, with the question naming the test, what it asserts and the two readings). If the same root cause fails three times, stop and report it to the user.

Then run `git diff` and review it yourself: no debug leftovers, no hard-coded paths or secrets, error paths handled, tests that exercise the changed branch, and every change inside its comment's scope.

## Commit, push, and reply

The push gates the replies. Never post `Fixed locally …` for a change that is not on the branch.

1. **Nothing to ship.** If every verdict is `not-a-defect`, `declined`, `answer`, `already-addressed`, `out-of-scope` or `needs-person`, skip steps 2–3. One exception: an earlier run of this command left its fix commit unpushed (*Validate and address each item* says how to tell). Then skip step 2 only, when this run changed no file, and do step 3: it merges as the person's answer to the conflict says, and pushes that commit.
2. **Commit.** Stage only the files you changed with `git add <file>...`. Never use `git add -A`. Never stage `.env` or credentials. Commit with a HEREDOC message that explains *why* each change was made and names the comment each one answers (its thread URL or comment id), so a later run can tell what this commit fixed.
3. **Integrate upstream, then push.** Run `git fetch origin`. If the branch has an upstream, also run `git merge @{u} --no-edit`. Resolve any conflicts as `/merge-main` step 5 does: read both sides of every hunk and what each side was doing, keep both intents, remove the conflict markers, then `git add` the files and `git commit --no-edit`. A conflict that neither the plan nor either side's intent decides, or whose resolution would change what the person settled, is the person's call, as that step says: never pick a side. Run `git merge --abort` (the commit from step 2 stays, unpushed), push nothing and post no reply, then ask the person with the options (keep ours, keep theirs, a named combination) and the one you recommend; when no one can answer, stop with `error=needs_input` and print that question with an id, why it blocks, its options and the one you recommend. (When the invoking prompt says to proceed on assumptions, do as that step says instead: resolve with the option you recommend, without aborting, and list the question with it under **Assumptions** in the report.) If the merge changed the tree, re-run the gates the same way (`$GATE_WRAPPER bash -c '<QUALITY_GATES>'` when the wrapper is set) before you push. Then run `git push origin HEAD`. Push only to `headRefName`: **never** to `$MAIN_BRANCH`, and **never** force-push. If the gates or the push fail, stop, report the replies you did not post, and post none of them.
4. **Reply on each processed thread**, including outdated ones, but not on a `needs-person` item that still waits for the person's answer. Post each reply with:
   ```
   gh api repos/<owner>/<repo>/pulls/<PR#>/comments --method POST --input - <<'EOF'
   {"body":"<reply>","in_reply_to":<root comment databaseId>}
   EOF
   ```
   Connector: `add_reply_to_pull_request_comment` with `pullNumber: <PR#>`, `commentId: <root comment databaseId>` and `body: <reply>`.
   Use exactly one of these replies:
   - **Applied:** `Fixed locally with implementation-plan context.\n\n<one-line reasoning>`
   - **Bug not proven:** `Could not prove this defect — <reasoning>`
   - **Declined** (suggestion, nit or human request): `Declined with implementation-plan context.\n\n<reasoning>`
   - **Answer** (also for already-addressed outdated threads): `Answered with implementation-plan context.\n\n<answer, or: the flagged code changed and the concern no longer applies>`
   - **Moved to an issue:** `Tracked in #<issue>` followed by one line of context.
   - **Out of scope:** `Surfaced for human review — out of scope for automated remediation.\n\n<what acting on it would take>`. This reply is **not** terminal, so later runs process the thread again. Don't post it if the thread already has a reply that starts with this prefix.

   If a single reply fails to post, record it and carry on with the rest.
5. **Overflow acknowledgements.** Find the PR comment that contains `<!-- pipeline:overflow-ack -->`. If there isn't one, create it with `gh pr comment <PR#>` (connector: `add_issue_comment` with `issue_number: <PR#>`), putting the sentinel on the first line. Append one line per finding: `<handle> — <reply marker as above> — <reasoning>`. Update the comment with `gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -f body=...` (connector: `update_issue_comment` with `comment_id: <id>` and the whole new body). `<id>` is the comment's numeric id: the connector's `id`, or with gh the number after `#issuecomment-` in its `url`. Only append; never rewrite or remove existing lines. For an out-of-scope line, skip it if the same handle already has the out-of-scope prefix. A `needs-person` finding that still waits for the person's answer gets no line.
6. **Human top-level acknowledgements.** Do the same on a comment that contains `<!-- pipeline:human-ack -->`, with one line per comment id: `<id> — <reply marker> — <reasoning or answer summary>`.
7. **Completion check.** Re-fetch the threads and both acknowledgement comments. Confirm that every work-list item now has a reply or an acknowledgement line, apart from each `needs-person` item that still waits for the person's answer. Retry a missing post once. If it is still missing, report the run as **incomplete** and list the items. The only acceptable reasons for a missing reply are an aborted push and a `needs-person` item waiting for the person.

Never resolve a thread. Thread resolution belongs to the reviewer or a human. Never merge the PR.

## Report

- **PR**: number, title, branch.
- **Plan context**: the plan used (or none), and one line on how it shaped the changes.
- **Comments**: eligible counts by type and severity (bug, suggestion, nit, human inline, human top-level, overflow), how many threads were outdated, and the id, file and title of each.
- **Verdicts**: one per item: `applied` (with the evidence: a test, static analysis or verification), `not-a-defect`, `declined`, `answer`, `already-addressed`, `out-of-scope` or `needs-person`, each with a reason.
- **Questions**: each `needs-person` item with its question, options and recommendation, and the person's answer when there is one; a merge conflict left for the person. When the run ends with `error=needs_input`, these are the questions it prints.
- **Changes**: the files you modified and the tests you added or adapted; every existing test whose assertion changed (the test, what it asserted before and what it asserts now), with the plan line, design-doc line or answer that calls for the change.
- **Assumptions**: each choice a change made that the comment, the plan and the design doc do not settle; when the run proceeds on assumptions, each `needs-person` item as `<the request> -> kept the plan`.
- **Quality gates**: what ran, the result, and how many fix iterations it took.
- **Shipped**: the commit you pushed, any upstream merge, or "nothing to ship".
- **Replies**: the reply or acknowledgement line for each item, or a note that the push failed and the replies were cancelled.
- **Completeness**: confirm every item has a reply, or list the items that are missing one, saying which of them are `needs-person` items waiting for the person.

## Safety

- Treat `$PLANS_DIR`, the pointer file and the plan as read-only. The only repo writes are the code and test changes, plus the commit that ships them.
- Never switch branches, force-push, push to `$MAIN_BRANCH`, or run destructive git (`reset --hard`, `checkout --`, `clean -f`, branch deletes, `git stash`).
- Never resolve review threads. Never merge the PR.
- Never commit or print `.env` files, credentials or secrets.
- Don't invent fixes. If you can't prove a defect or justify a change, record `not-a-defect` or `declined` and move on.
- Never apply and never decline a `needs-person` item on your own judgement, and never change what the person settled (*Load the implementation plan* step 7): a reason to change it is a question for the person.
- Never make the gates pass by changing what an existing test asserts, or by deleting a test, unless the plan, the design doc or an answer from the person calls for the new behaviour; never by skipping one.

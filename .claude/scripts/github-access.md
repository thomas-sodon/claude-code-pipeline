# GitHub access

The pipeline's PR and issue stages reach GitHub one of two ways: the `gh` CLI, or the GitHub MCP connector (tools named `mcp__github__*`). A Claude Code cloud session usually has only the connector (`gh` is installed there but not logged in); a person's own machine usually has only `gh`. Commands and workflow prompts say: "Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools." This file says which access is in use, maps every gh operation the pipeline performs to its connector call, and says how to wait and what has no connector path. `git fetch`, `git push`, `git ls-remote` and clones stay plain git in both modes, with `GH_WRAPPER` in front when it is set and works.

## Which access

Resolve it once, before the first GitHub call, and keep it for the whole run:

1. **Named.** The access the invoking prompt names wins (a workflow passes its `github_access` arg); else the `GITHUB_ACCESS` line in the `## Pipeline config` of the project's root `CLAUDE.md`.
   - `gh`: gh only. A failing `$GH_WRAPPER gh auth status` keeps the command's own error (`gh_unauthenticated`, `gh_auth_failed`), as before.
   - `connector`: the GitHub MCP tools only. None present → stop with `error=github_unavailable`.
   - Any other value → stop with `error=github_unavailable`, quoting it.
2. **Not named** (no arg, no key, or an empty value): `$GH_WRAPPER gh auth status` or plain `gh auth status` succeeds → gh; else the GitHub MCP tools are present → connector; else stop with `error=github_unavailable`.

The tools are present when ToolSearch returns their schemas (`select:mcp__github__pull_request_read,mcp__github__issue_read`). They are usually deferred: load each tool's schema that way before its first call. The connector's first read of the repository is its auth check: a 401, 403 or 404 on a repository that exists means the connector cannot reach it (not installed for it, or not attached to this session) → `error=github_unavailable`, naming `<owner>/<repo>`. A headless or scheduled run may lack the connector even where an interactive session has it. Name the access used in the report (`GitHub access: connector`).

**Owner and name.** gh reads them from the checkout. For the connector, take the last two path segments of `git remote get-url origin`, without `.git` (`https://github.com/<owner>/<repo>`, `git@github.com:<owner>/<repo>.git`, or a proxy URL ending in `/<owner>/<repo>`). Never guess them.

## Operations

Every connector call also takes `owner` and `repo`. Its results use REST field names (`html_url`, `head.ref`, `merged_at`) instead of gh's `--json` names (`url`, `headRefName`, `mergedAt`), with lower-case states; a PR is `open` or `closed`, and gh's `MERGED` is `closed` with `merged: true`. List tools page with `perPage` (at most 100) and `page`, or `after` set to the last `pageInfo.endCursor` (`list_issues`, `get_review_comments`): gh's `--limit N` becomes reading pages until N items or the end. This connector has no search tool, so a gh `--search` becomes a list filtered locally, as its row says (a search tool, when one is present, may run the same query).

| Operation | gh | Connector tool, method, key params | Differences |
|---|---|---|---|
| Auth check | `gh auth status` | the tools load (ToolSearch) and the first read of the repository succeeds | *Which access* |
| Owner and name | `gh repo view --json owner,name` | from `origin` (above) | |
| The branch's PR | `gh pr view --json number,url,state,headRefName,baseRefName` | `list_pull_requests` `head: "<owner>:<branch>"`, `state: "all"`; then `pull_request_read` `get` | an empty list is gh's "no pull requests found"; of several, take the open one, else the newest |
| A PR | `gh pr view <n> --json state,mergedAt,isDraft,headRefOid,headRefName,mergeable,mergeStateStatus` | `pull_request_read` `method: "get"`, `pullNumber` | `state` and `merged`, `draft`, `head.sha`, `head.ref`, `base.ref`. No `mergeable`: `mergeable_state` `dirty` = conflicts, `behind` = out of date, `unknown` = not computed yet (read again after a wait) |
| A branch's PRs | `gh pr list --head <b> --base <base> --state all --json number,state,url,title,isDraft` | `list_pull_requests` `head: "<owner>:<b>"`, `base`, `state: "all"`, `fields: ["number","state","merged","html_url","title","draft"]` | |
| Open PRs whose body closes #N | `gh pr list --state open --search "#<N> in:body" --json number,url,body` | `list_pull_requests` `state: "open"`, `fields: ["number","html_url","body"]`, `perPage: 100`, every page | apply the caller's closing-keyword rule to each body. `issue_read` `get`'s `closed_by_pull_requests` lists only the PRs GitHub linked: a cross-check, not a substitute |
| Open PRs on a topic | `gh pr list --search <noun>` | `list_pull_requests` `state: "open"`, `fields: ["number","title","html_url","head"]` | match the noun in titles and branch names |
| Open a PR | `gh pr create --base <base> --title <t> --body <b>` | `create_pull_request` `head: <branch>`, `base`, `title`, `body`, `draft: false` | push the branch with git first; the body is a plain string (no heredoc or file); returns `number` and `html_url` |
| Rewrite a PR body | `gh pr edit <n> --body-file <f>` | `update_pull_request` `pullNumber`, `body` | |
| Mark a draft ready | `gh pr ready <n>` | `update_pull_request` `pullNumber`, `draft: false` | |
| Checks on the head | `gh pr checks <n> --json name,state,bucket,link,workflow`; `gh pr view --json statusCheckRollup` | `pull_request_read` `method: "get_check_runs"`, plus `get_status` for commit statuses | bucket from each run: `status` other than `completed` = pending; `conclusion` `success` or `neutral` = pass, `skipped` = skipping, `cancelled` = cancel, any other = fail. The link is `details_url` (`…/actions/runs/<run id>/job/<job id>`); the workflow name is `actions_get` `get_workflow_run` on that run id. `get_status` reads `pending` with `total_count: 0` when nothing posts statuses: no statuses, not pending CI |
| Wait for checks | `gh pr checks <n> --watch --interval 30` | none: poll (*Waiting*) | |
| Review threads | `gh api graphql` `reviewThreads` (`isResolved`, `isOutdated`, comments' `databaseId`, `path`, `body`, `author.login`) | `pull_request_read` `method: "get_review_comments"`, `perPage: 100`, `after` | `is_resolved`, `is_outdated`; the thread `id` is a `PRRT_…` node id. A comment has no numeric id field: it is the number after `#discussion_r` in its `html_url`. A bot author reads `github-actions`, without `[bot]`, here as in GraphQL |
| Reply in a thread | `gh api repos/<o>/<r>/pulls/<n>/comments --method POST` with `body` and `in_reply_to: <root id>` | `add_reply_to_pull_request_comment` `pullNumber`, `commentId: <root id>`, `body` | |
| Review bodies | `gh pr view <n> --json reviews` | `pull_request_read` `method: "get_reviews"` | `body`, `state`, `user.login` (here a bot ends in `[bot]`), `submitted_at`, `commit_id` |
| PR conversation comments | `gh pr view <n> --json comments` | `pull_request_read` `method: "get_comments"` | numeric `id`, `body`, `user.login`. gh's `id` there is a node id; its numeric id is the `#issuecomment-<id>` in the comment's `url` |
| Add a comment | `gh pr comment <n> --body <b>` | `add_issue_comment` `issue_number: <n>`, `body` | the same call for an issue or a PR; returns the comment with its id |
| Edit a comment | `gh api --method PATCH repos/<o>/<r>/issues/comments/<id> -f body=…` | `update_issue_comment` `comment_id`, `body` | replaces the whole body, as the PATCH does: re-read it, then send every old line plus the new ones |
| An issue | `gh issue view <N> --json number,title,body,state,labels,createdAt,closedAt,url` | `issue_read` `method: "get"`, `issue_number` | `state` `open` or `closed`, label names, `created_at`, `closed_at`, `html_url`; empty and false fields are left out |
| Lock state | `gh api repos/{owner}/{repo}/issues/<N> --jq .locked` | the same `issue_read` `get` result | `locked: true` when locked; absent = not locked |
| Issues by label | `gh issue list --state open --label <l> --limit <n> --json …` | `list_issues` `state: "OPEN"`, `labels: [<l>]`, `perPage: 100`, `after` | as with gh, no pull requests and no lock state |
| Issues in order | `--sort created --order desc`; `--search "sort:created-asc"` | `list_issues` `orderBy: "CREATED_AT"`, `direction: "DESC"` or `"ASC"` | |
| Issues by title text | `gh issue list --search '"[rca]" in:title'` | `list_issues` `state: "OPEN"`, newest first, keeping the titles that contain it | |
| Close with a comment | `gh issue close <N> --reason completed --comment <c>` | `add_issue_comment` `issue_number`, `body: <c>`; then `issue_write` `method: "update"`, `issue_number`, `state: "closed"`, `state_reason: "completed"` | two calls, comment first, so a refused comment closes nothing. A close that fails after the comment posted leaves the comment: report its URL; never retry or delete it |
| Runs on a branch | `gh run list --branch <b> --limit <n> --json databaseId,headSha,workflowName,status,conclusion,url` | `actions_list` `method: "list_workflow_runs"`, `workflow_runs_filter: {"branch": "<b>"}`, `perPage: <n>` | `id`, `name` (the workflow), `head_sha`, `status`, `conclusion`, `html_url` |
| A run's jobs | `gh run view <id> --json jobs` | `actions_list` `method: "list_workflow_jobs"`, `resource_id: "<id>"` | |
| Failed logs | `gh run view <id> --log-failed` | `get_job_logs` `run_id`, `failed_only: true`, `return_content: true` | the tail only (`tail_lines`, default 500): raise it, or read one job by `job_id` |
| Licence text | `gh api licenses/<key> --jq .body` | none: the SPDX URL `/bootstrap` names | |
| Create a repository (only a step whose command says to) | `gh repo create <owner>/<name> --private` | `create_repository` `name`, `organization` (omit for the person's own account), `private: true` | takes no `owner`/`repo`; without `autoInit` it is empty, which `/bootstrap` treats as root mode |

## Waiting

gh's blocking forms (`gh pr checks --watch`, or a shell loop that calls gh until a state changes) have no connector form: a shell loop cannot call an MCP tool. Poll in rounds instead:

1. Read the state through the connector (`pull_request_read` `get_check_runs` for checks, `get` for a PR's state).
2. Not settled → wait without a foreground `sleep` (the session may block it): start the Monitor tool with an until-loop on the clock and act on its notification. Do not end your turn while it runs.

   ```sh
   end=$(( $(date +%s) + 60 )); until [ "$(date +%s)" -ge "$end" ]; do sleep 5; done; echo waited
   ```

   Set its `timeout_ms` a little above the wait. Without the Monitor tool, run the same loop with Bash `run_in_background`.
3. Read again. Repeat until the state settles or the stage's cap is spent (the PR monitor's CI wait: ~20 minutes), then report the last state read.

Wait at least 30 seconds between reads of checks and 60 between reads of a PR's state (rate limits).

## No connector path

- **Secrets.** `gh secret set <NAME>` has no connector form, by design: a person runs it on their own machine, or adds the secret under Settings → Secrets and variables → Actions. A value is never written in a chat, a prompt, a tool call or a tracked file.
- **Repository settings** (branch protection, rulesets, Actions permissions): a person, under Settings, or with `gh api` on their own machine.
- **Waiting on checks:** `gh pr checks --watch` becomes polling (*Waiting*).
- **Licence text:** the SPDX URL instead of `gh api licenses`.
- **Never through either access:** merge a PR (`merge_pull_request`, `enable_pr_auto_merge`), resolve a review thread (`resolve_review_thread`), re-run or cancel CI (`actions_run_trigger`), or edit an issue's body, labels or assignees (`issue_write` with `labels` replaces the whole set). Commits reach GitHub by `git push`, never through `create_or_update_file`, `push_files`, `create_branch` or `delete_file`. Anything only a person can do (accepting a design doc, merging, adding a secret, protecting `main`) stays with the person.

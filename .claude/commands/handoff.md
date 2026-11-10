Write the pipeline handoff, `STATE.md`, to the state branch so a fresh session can continue this one's work, record that the handoff was written, and tell the person how to continue.

Run it when the context guard says the handoff is due (the status line shows `handoff due`, or a hook says the context is at or over `PIPELINE_HANDOFF_PCT`, default 40%), before ending a long orchestration session, or whenever the person asks. The handoff carries what this session knows that the repository does not: the workflow runs and their exact args, the person's answers, open questions and assumptions, and the next action. It links to files instead of copying them.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:
- `MAIN_BRANCH` — integration branch (default `main`).
- `PROPOSALS_DIR` — the design docs (default `docs/design`); the roadmap is `$PROPOSALS_DIR/roadmap.md`.
- `GITHUB_ACCESS` — `gh` (default) or `connector`. Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. With neither available, write `open PRs: not listed (github_unavailable)` and go on: a handoff never stops for GitHub.
- `GH_WRAPPER` — optional prefix for `gh` and `git fetch`.

The state branch is `pipeline/state` on origin unless env `PIPELINE_STATE_BRANCH` names another; `.claude/scripts/pipeline-state.py` reads and writes it.

## Arguments

`$ARGUMENTS` is optional:
- `--note=<text>` — the person's note for the next session; it becomes the first line of `## Next`. Free text without `--note=` is taken as the note too.

An empty `--note=` or any other `--`-prefixed token → stop with `error=invalid_argument`, naming it and the accepted form (`/handoff`, `/handoff --note="wait for the vendor before milestone 3"`).

## Steps

1. **Check prerequisites.** `git rev-parse --show-toplevel` must succeed → else `error=not_a_repo`; work at that root. `.claude/scripts/pipeline-state.py` must exist → else `error=no_state_script` (an older pipeline: `/seed --update` installs it).

2. **Read the previous handoff.** `python3 .claude/scripts/pipeline-state.py get STATE.md`: exit 0 → read it in full and carry forward what is still true, above all `## Answers given` (an answer the person gave is never dropped); exit 3 → there is none; exit 2 → note that the state branch is unreachable and go on (step 5 reports the outcome).

3. **Gather the facts.** Summarize each source; never paste a whole output, a whole doc or the brief.
   - **Roadmap progress.** `python3 .claude/scripts/proposal-lint.py $PROPOSALS_DIR/roadmap.md --roadmap` (JSON): the `next` milestones, and for each milestone its title, whether its proposal exists, steps done of total and pending gates. No roadmap yet → say which design stage the work is at instead.
   - **Branches.** `$GH_WRAPPER git fetch origin --prune` (a failure is noted, not fatal), then the current branch, `git status --porcelain` (uncommitted work exists only in this container: list it as a risk, never commit it for the handoff) and the branches of origin not merged into `origin/$MAIN_BRANCH`, the state branch left out.
   - **Open pull requests,** through the access in use: number, title, head branch, URL, checks (passing, failing, pending), review decision.
   - **Workflow runs.** Every workflow this session ran: name, the exact args, and its status (finished, still running in this session, stopped on `needs_input`, failed), with the result's questions, assumptions and next steps. A run that is still running here may be awaited before you end the session; record it as in flight either way. Args over about 1 KB go in their own state-branch file, `runs/<YYYYMMDDTHHMMSSZ>-<workflow>.json` (`pipeline-state.py save <file> --as runs/...`), linked from the handoff. Also list `python3 .claude/scripts/pipeline-state.py list runs/` and note any run record the session does not account for.
   - **Questions** not yet answered (a `needs_input` result's questions, or a question asked in chat with no reply): each with its id, the options and your recommendation with its reason.
   - **Answers** the person gave, in this session or carried from the previous handoff, by question id, in their own words.
   - **Assumptions** a workflow or command recorded that no person has reviewed, each with where it was made.
   - **Environment.** A cloud or local session; the repository (owner/name) and this checkout's path; `GITHUB_ACCESS`, and whether `gh` is authenticated; the state branch; the secrets the work needs, by name only, and whether each is set where it is needed; where the brief came from (below).
   - **The brief.** `docs/brief.md` and `docs/builder-context.md` are kept off every branch, the state branch included, so a new container will not have them. Record where the brief came from — the idea repository's path or URL, the brief's path in it and that repository's last commit (`git -C <idea repo> log -1 --format=%H -- <brief path>` when it is reachable from here) — and how to restore both files: re-run `/start-product <brief> <repo>`, or copy them back from the idea repository.

4. **Write `STATE.md`** from the *Template* below to a temporary file outside the working tree (the session's scratchpad directory when it has one, else a `mktemp` path). Every section is present; an empty one says `none`. Keep it under 12 KB (`wc -c`): a longer list goes in a linked state-branch file, and a doc or plan is linked by path, never copied. `## Next` is the single exact next action: a workflow name with its args as a JSON block, or a command; when a question in `## Waiting on the person` blocks it, `## Next` is to ask it.

5. **Save it.** `python3 .claude/scripts/pipeline-state.py save <file> --as STATE.md -m "handoff: <product>: <one-line status>"`. It prints `{"saved": true, "commit": ...}`. On exit 2 the handoff is not saved: say so plainly with the error, print the whole `STATE.md` in your reply so it is not lost, and give the temporary file's path.

6. **Record the handoff.** `python3 .claude/scripts/context-guard.py mark-handoff`, after step 5 whatever its outcome (a failed save is then reported, and the handoff is in your reply). It tells the context guard the handoff is written, so the session can end. A failure here (exit 2) is reported and changes nothing else.

7. **Report.** Where the handoff was saved (branch and commit) and its size, the other state-branch files written, and what `## Next` says, in one line each. End with exactly this line: `To continue: start a new session in this repository and say "Continue from the pipeline handoff".` When the save failed, end instead with: `To continue: start a new session in this repository, paste the handoff above and say "Continue from the pipeline handoff".`

## Template

````md
# Pipeline handoff: <product: the roadmap's title, else the repository name>

<!-- Written by /handoff at <YYYY-MM-DDTHH:MM:SSZ> from <branch> in <owner/name>. A new session: read this file and what it links, settle "Waiting on the person" first, then do "Next". -->

## Goal

<One paragraph in your own words: what is being built and for whom. Never the brief's text; where the brief is is under Environment.>

## Where things stand

- Roadmap: `<PROPOSALS_DIR>/roadmap.md`; next milestone <N>: <title>.
- Milestone <N> <title>: <done | proposal draft | accepted, steps <d>/<t> done, <g> gates pending> (`<proposal path>`).
- Branches: `<branch>` (<pushed, PR #<n>, checks passing>).
- Open PRs: #<n> <title> (`<branch>`, <checks>, <review decision>), or `none`.
- Uncommitted work: `none`, or the files and the checkout they are in (they exist only in this container).

## In flight

- `<workflow>` (<still running in this session | stopped: needs_input <ids> | failed: <error>>). Re-run with these args:

  ```json
  {"<arg>": "<value>"}
  ```
- `<workflow>`: args in the state branch's `runs/<YYYYMMDDTHHMMSSZ>-<workflow>.json` (`python3 .claude/scripts/pipeline-state.py get runs/<file>`).

## Waiting on the person

- `<question id>` (from <workflow or command>): <the question>. Options: <A>; <B>. Recommended: <A>, because <reason>.

## Answers given

- `<question id>`: <the answer, as the person gave it> (<date>).

## Assumptions to review

- <assumption> (made by <workflow or command>, in <doc, step or PR>).

## Next

<Note from the person, when /handoff got one.>

Run the workflow `<name>` with these args:

```json
{"<arg>": "<value>"}
```

## Environment

- Session: <Claude Code cloud | local>; repository <owner/name>, checked out at `<path>` (a new session's checkout may be elsewhere: point `dir` args at it); `MAIN_BRANCH`: <main>; state branch `<pipeline/state>`.
- GitHub: `GITHUB_ACCESS: <gh | connector>`; gh <authenticated | not logged in>.
- Secrets the work needs, by name: `<NAME>` (<set in CI | missing>).
- Brief: from <idea repository path or URL>, `<brief path>` at commit `<sha>`. `docs/brief.md` and `docs/builder-context.md` are kept off every branch: before resuming a design run, restore both (re-run `/start-product <brief> <repo>`, or copy them back from the idea repository).

## Rules

- Never merge a pull request; a person merges.
- Never push to `main` and never force-push.
- Ask instead of assuming: a decision the person has not made goes under Waiting on the person.
- Secrets are named, never written down.
````

## Continuing from a handoff

A session asked to "Continue from the pipeline handoff" reads `STATE.md` (`python3 .claude/scripts/pipeline-state.py get STATE.md`; the SessionStart hook says when one exists and quotes its `## Next`) and the files it links. It re-checks what may have moved since (PR states, checks, branches), restores the brief and builder context before a design run, asks the questions under `## Waiting on the person` (passing the answers to the workflow as its `answers`), then does `## Next`. It runs `/handoff` again before it ends.

## Safety

- The only writes are to the state branch (`STATE.md` and the linked `runs/` files, through `pipeline-state.py`, never a checkout) and the context guard's handoff mark. Never commit, stage or push anything else, and never stash or discard uncommitted work: list it.
- Never write a secret, a token or an `.env` value into the handoff: name the secret. Never copy the brief or the builder context into it: the state branch is as visible as the repository.
- Never merge a pull request, never push to `$MAIN_BRANCH`, never force-push.
- Record only what the session knows or the commands show; an unknown is written as unknown, never guessed.

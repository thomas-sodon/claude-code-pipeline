Write the pipeline handoff, `STATE.md`, to the state branch so a fresh session can continue this one's work, record that the handoff was written, and tell the person how to continue.

Run it when the context guard says the handoff is due (the status line shows `handoff due`, or a hook says the context is at or over `PIPELINE_HANDOFF_PCT`, default 40%; it says so only in a session that orchestrates, one that has run a workflow or has `PIPELINE_ORCHESTRATOR=1`, and under CI only with `PIPELINE_ORCHESTRATOR=1`), before ending a long orchestration session, or whenever the person asks. The handoff carries what this session knows that the repository does not: the workflow runs and their exact args, the person's answers and standing rules, open questions and assumptions, and the next action. It links to files instead of copying them.

## Configuration

Read the `## Pipeline config` section of the project's root `CLAUDE.md`:
- `MAIN_BRANCH` — integration branch (default `main`).
- `PROPOSALS_DIR` — the design docs (default `docs/design`); the roadmap is `$PROPOSALS_DIR/roadmap.md`.
- `GITHUB_ACCESS` — `gh` or `connector` (unset: gh when it is authenticated, else the GitHub MCP tools). Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. With neither available, write `open PRs: not listed (github_unavailable)` and go on: a handoff never stops for GitHub.
- `GH_WRAPPER` — optional prefix for `gh` and `git fetch`.

The state branch is `pipeline/state` on origin unless env `PIPELINE_STATE_BRANCH` names another; `.claude/scripts/pipeline-state.py` reads and writes it.

## Arguments

`$ARGUMENTS` is optional:
- `--note=<text>` — the person's note for the next session; it becomes the first line of `## Next`. Free text without `--note=` is taken as the note too.

An empty `--note=` or any other `--`-prefixed token → stop with `error=invalid_argument`, naming it and the accepted form (`/handoff`, `/handoff --note="wait for the vendor before milestone 3"`).

## Steps

1. **Check prerequisites.** `git rev-parse --show-toplevel` must succeed → else `error=not_a_repo`; work at that root. `.claude/scripts/pipeline-state.py` must exist → else `error=no_state_script` (an older pipeline: `/seed --update` installs it).

2. **Read the previous handoff.** `python3 .claude/scripts/pipeline-state.py get STATE.md`: exit 0 → read it in full and carry forward what is still true, above all `## Answers given` and `## Standing rules from the person` (an answer the person gave or a rule they set is never dropped and never reworded); exit 3 → there is none; exit 2 → note that the state branch is unreachable and go on (step 5 reports the outcome).

3. **Gather the facts.** Summarize each source; never paste a whole output, a whole doc or the brief.
   - **Roadmap progress.** `python3 .claude/scripts/proposal-lint.py $PROPOSALS_DIR/roadmap.md --roadmap` (JSON): the `next` milestones, and for each milestone its title, whether its proposal exists, steps done of total and pending gates. No roadmap yet → say which design stage the work is at instead.
   - **Branches.** `$GH_WRAPPER git fetch origin --prune` (a failure is noted, not fatal), then the current branch, `git status --porcelain` (uncommitted work exists only in this container: list it as a risk, never commit it for the handoff) and the branches of origin not merged into `origin/$MAIN_BRANCH`, the state branch left out. A lane a workflow stopped on a question is listed with its branch, its checkout and its result's `plan_ref`: its plan is saved on the state branch, and whatever it had not committed and pushed is in that checkout alone.
   - **Open pull requests,** through the access in use: number, title, head branch, URL, checks (passing, failing, pending), review decision.
   - **Workflow runs.** Every workflow this session ran: name, the exact args, and its status (finished, still running in this session, stopped on `needs_input`, failed), with the result's questions, assumptions and next steps. A run that is still running here may be awaited before you end the session; record it as in flight either way. Args over about 1 KB go in their own state-branch file, `runs/<YYYYMMDDTHHMMSSZ>-<workflow>.json` (`pipeline-state.py save <file> --as runs/...`), linked from the handoff. Also list `python3 .claude/scripts/pipeline-state.py list runs/` and note any run record the session does not account for.
   - **Questions** not yet answered (a `needs_input` result's questions, or a question asked in chat with no reply): each with its id, the options and your recommendation with its reason.
   - **Answers** the person gave, in this session or carried from the previous handoff: each with its id, what asked it (the workflow or command, and for a question of one lane, one branch or one doc the lane's key, the branch or the doc's path), the question's text, the answer in the person's own words and the date they gave it. The ids of lane and doc questions repeat (every lane has a `plan.q1`, every refreshed doc a `revise.q1`), so an entry without its lane, branch or doc cannot be passed back. A decision the person made outside a workflow question (in chat, in a note, by correcting an assumption) is an answer too. Give it the id the workflow it goes to accepts, so it can be passed as an answer. `<N>` is the next number not yet in use for that form among the entries it stands beside under `## Answers given` (for a lane, a branch or a doc: among that lane's, branch's or doc's entries; for a design id, `architecture.d<N>`, `m<N>.d<K>` or `proposal.d<N>`: among all entries, and an id already in a `(person, <date>, <id>)` tag of the design docs is in use too), because an id is never reused for another question. A decision about the whole product: `intake.d<N>`, which every design stage reads. A decision about one design stage only: `<scope>.d<N>` (`architecture`, `m<N>` for a milestone's proposal, `consistency`). A correction to what one run assumed takes the id that run's relay names, recorded with what the run was about: `<its stage>.d<N>` (`plan`, `impl`, `fix`, `polish` or `merge_check`) with the lane's key or the branch, for a lane whose re-run builds again; `bootstrap.d<N>` for a bootstrap whose re-run builds again. A correction to a design doc takes the id its design run uses (`architecture.d<N>`, `m<N>.d<K>`, or `proposal.d<N>` for a concern's proposal), also when the `refresh-proposal` workflow applies it, recorded with the doc's path; `revise.d<N>` with the doc's path only for a doc no design run wrote. A correction to what a branch assumed when its re-run builds nothing (its PR is open, or the run only ships or monitors it: the result's relay says so) gets no id, because it is no answer: the person leaves it as a review comment on the PR (*Continuing from a handoff* step 4). Its question is what the decision settles. An answer carried from an older handoff without its question or date keeps its line, with `question not recorded` or `date not recorded` where the session cannot tell. When a design run's args carry `save_answers: false`, the person chose to keep that run's answers off the state branch, and `STATE.md` is on that branch: write each answer that run was given (in its args, or to one of its questions) with its id, what asked it and its date only, with `kept off the state branch by the person` in place of the question and the answer, and write the `answers` arg of that run's args as the list of those ids, in `STATE.md` and in a `runs/` file alike. A question of that run that is still open is written in full under `## Waiting on the person`, like any other.
   - **Standing rules** the person set for the work as a whole (how to ask them, what never to do, what to check first): each in their own words, with the date. They are carried forward like answers, and removed only when the person withdraws one.
   - **Assumptions**: only choices a workflow, a command or this session made that no person has reviewed, each with where it was made. An unknown that the tree, CI or GitHub can settle (a check's name, a branch's state, whether a secret is set) is never listed here and never put to the person: settle it now when one read-only command does, else write it as a check to run under `## Next`.
   - **Environment.** A cloud or local session; the repository (owner/name) and this checkout's path; `GITHUB_ACCESS`, and whether `gh` is authenticated; the state branch; the secrets the work needs, by name only, and whether each is set where it is needed; where the brief came from and how the builder context restores (below).
   - **The brief.** `docs/brief.md` is kept off every branch, the state branch included, so a new container will not have it. Record where it came from — the idea repository's path or URL, the brief's path in it and that repository's last commit (`git -C <idea repo> log -1 --format=%H -- <brief path>` when it is reachable from here) — and how to restore it: copy it back from the idea repository.
   - **The builder context.** `docs/builder-context.md` is kept off every branch too, unless the person consented to keep it on the state branch. That consent is on record when the state branch holds `context/builder-context.md` (`python3 .claude/scripts/pipeline-state.py list context/` prints it; on exit 2 the branch is unreachable, and the header alone decides) or the local file's header comment says `with the person's consent of`. With the consent on record and the local file present, save the file again: `python3 .claude/scripts/pipeline-state.py save docs/builder-context.md --as context/builder-context.md -m "builder context, stored with the person's consent"` (identical content makes no commit; on exit 2, report it and go on). Record that the file restores from the state branch. With no consent on record, never save it, and never ask for the consent here: record that the person rewrites the file or copies it back from a checkout that has it. Either way, re-running `/start-product <brief> <repo>` restores both files only while the repository holds no code.

4. **Write `STATE.md`** from the *Template* below to a temporary file outside the working tree (the session's scratchpad directory when it has one, else a `mktemp` path). Every save is a full rewrite: build the whole file from the template and this session's facts, copying in what step 2 carries forward. Never fetch a saved `STATE.md` and patch lines of it in place, also when this session saved one earlier. The header's time is the time of this write. Every section is present; an empty one says `none`. Keep it under 12 KB (`wc -c`): a longer list goes in a linked state-branch file, and a doc or plan is linked by path, never copied. `## Next` is the single exact next action: a workflow name with its args as a JSON block, or a command; when a question in `## Waiting on the person` blocks it, `## Next` is to ask it. When this session ran a workflow, `## Next` and `## In flight` follow from its latest run (its result, its `needs_input` relay or its next steps), never from an earlier run a saved handoff names. A check to run first (step 3's unknowns) goes above the action, one line each: the command and what it settles.

5. **Save it.** `python3 .claude/scripts/pipeline-state.py save <file> --as STATE.md -m "handoff: <product>: <one-line status>"`. It prints `{"saved": true, "commit": ...}`. On exit 2 the handoff is not saved: say so plainly with the error, print the whole `STATE.md` in your reply so it is not lost, and give the temporary file's path.

6. **Record the handoff.** `python3 .claude/scripts/context-guard.py mark-handoff`, after step 5 whatever its outcome (a failed save is then reported, and the handoff is in your reply). It tells the context guard the handoff is written, so the session can end. A failure here (exit 2) is reported and changes nothing else.

7. **Report.** Where the handoff was saved (branch and commit) and its size, the other state-branch files written, and what `## Next` says, in one line each. End with exactly this line: `To continue: start a new session in this repository and say "Continue from the pipeline handoff".` When the save failed, end instead with: `To continue: start a new session in this repository, paste the handoff above and say "Continue from the pipeline handoff".`

## Template

````md
# Pipeline handoff: <product: the roadmap's title, else the repository name>

<!-- Written by /handoff at <YYYY-MM-DDTHH:MM:SSZ> from <branch> in <owner/name>. A new session: read this file and what it links, follow "Standing rules from the person", settle "Waiting on the person" and "Assumptions to review" with the person first, then do "Next". -->

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

- `<id>` (from <workflow or command>[, lane `<key>` | branch `<name>` | doc `<path>`]): <the question> → <the answer, as the person gave it> (<YYYY-MM-DD>).

## Standing rules from the person

- <the rule, in the person's words> (<YYYY-MM-DD>).

## Assumptions to review

- <a choice made for the person> (made by <workflow, command or this session>, in <doc, step or PR>).

## Next

<Note from the person, when /handoff got one.>

<Checks to run first, when there are any: `<command>`: <what it settles>.>

Run the workflow `<name>` with these args:

```json
{"<arg>": "<value>"}
```

## Environment

- Session: <Claude Code cloud | local>; repository <owner/name>, checked out at `<path>` (a new session's checkout may be elsewhere: point `dir` args at it and, for a design run, `pipeline` at the pipeline's checkout there; leave `pipeline` out once the checkout holds the seeded `.claude` files, as a clone of the design branch does after its first checkpoint); `MAIN_BRANCH`: <main>; state branch `<pipeline/state>`.
- GitHub: `GITHUB_ACCESS: <gh | connector>`; gh <authenticated | not logged in>.
- Secrets the work needs, by name: `<NAME>` (<set in CI | missing>).
- Brief: from <idea repository path or URL>, `<brief path>` at commit `<sha>`. `docs/brief.md` is kept off every branch: before resuming a design run, copy it back from there, and add `/docs/brief.md` to the checkout's local exclude file when it is not there.
- Builder context: <on the state branch, stored with the person's consent: restore it with `python3 .claude/scripts/pipeline-state.py get context/builder-context.md --to docs/builder-context.md`, and add `/docs/builder-context.md` to the checkout's local exclude file when it is not there (a design run also restores it itself, and adds that line) | local only, kept off every branch: before resuming a design run, the person rewrites `docs/builder-context.md` or copies it back>.

## Rules

- Never merge a pull request; a person merges.
- Never push to `main` and never force-push.
- Ask instead of assuming: a decision the person has not made goes under Waiting on the person.
- What the person said (an answer, a standing rule, the builder context) is changed only by the person.
- Secrets are named, never written down.
````

## Continuing from a handoff

A session asked to "Continue from the pipeline handoff" reads `STATE.md` (`python3 .claude/scripts/pipeline-state.py get STATE.md`; the SessionStart hook says when one exists and quotes its `## Next`) and the files it links. Then, in this order:

1. It follows every rule under `## Standing rules from the person`, from its first action to its last.
2. It re-checks what may have moved since (PR states, checks, branches) and runs the checks `## Next` lists.
3. Before a design run, it restores the brief and the builder context as the Environment section says: the builder context from the state branch when it is there (`python3 .claude/scripts/pipeline-state.py get context/builder-context.md --to docs/builder-context.md`), else by asking the person to rewrite it or copy it back. It never writes that file from memory or from the handoff: its text comes from the person. Once a file is back, it adds `/docs/brief.md` and `/docs/builder-context.md`, each only when absent, to the checkout's local exclude file (`git rev-parse --git-path info/exclude`; created when missing): a new clone starts without those lines, and with them `git add` refuses both files unless forced, so no later stage commits one by accident.
4. It shows the person `## Assumptions to review` together with the questions under `## Waiting on the person`, in one batch, and asks them to answer each question and to confirm or correct each assumption. It never confirms an assumption for the person. What they say about an assumption goes where that assumption lives:
   - **A decision a design doc tags `(assumed)` or leaves untagged, confirmed as it stands**, needs no re-run: its heading tag becomes `(person, <today's date>, edit)`. The person changes it while accepting the doc, or the session makes that one-line edit when the person says so (the tag only, never the Choice or any other text). A `(proposed)` value they confirm as it stands has no tag to edit: it goes back as an answer like a change (the revise writes it as the person's and drops the label).
   - **A decision, an assumption or a proposed value of a design doc that the person changes** becomes an answer, with an id as step 3 of *Steps* gives one, its question naming the decision by title, and the date. It goes to the `refresh-proposal` workflow on the one doc, or to a `brief-to-proposals` re-run with `from` set to that stage: `from: 'architecture'` with `max_milestones: 0` and without `milestones` for the architecture or the roadmap, so the re-run writes no further proposal (a `milestones` list left in the args is proposed again); `from: 'proposals'` with `milestones: [N]` for milestone N's proposal. A confirmation may be passed as an answer the same way when such a re-run happens anyway.
   - **An assumption shown on a pull request, or made by a run whose re-run builds nothing** (a ship-only or monitor-only run, a `ship-chain` lane, the bootstrap once its commit exists): a correction is never an answer to such a re-run, because no stage would apply it. The person leaves it as a review comment on the PR, once it is open, and the monitor's comment step (`/process-comments`) applies it. A line they confirm needs nothing.
   - **Any other assumption** (an Intake's, a lane's whose re-run builds again): what the person says, corrected or confirmed, becomes an answer, with an id as step 3 of *Steps* gives one, the assumption as its question, and the date. It is passed with the next run of the workflow that made the assumption; a confirmation alone is no reason for a re-run.
5. It passes answers to the workflow `## Next` names as its `answers`, each with its id, question, answer and date (an entry whose question or date is not recorded is passed without that field, never with a guess), beside the args `## Next` gives. Which ones, from `## Answers given` and the new ones:
   - every decision the person made for the whole product (`intake.d<N>`, or another id no workflow issued) and, for a design run (`brief-to-proposals`), every answer an earlier design run asked;
   - every answer that same workflow asked, on the same doc for `refresh-proposal` (`revise.q<N>`, and every correction recorded with that doc's path, whatever its id);
   - an answer whose id starts `plan`, `impl`, `fix`, `polish`, `merge_check` or `monitor` was asked by one branch's `plan-to-merged-pr` run, and goes only to a run of that same branch: as it is to that run itself, or to `bootstrap-repo` for its bootstrap branch; with the `lane` key its entry records to `proposal-build-chain` or `ship-chain`. The answer to a `bug-fix-backlog` lane's question never goes back through `bug-fix-backlog`: it goes to `plan-to-merged-pr` with that lane's `resume_args` (its PR is not open yet) or `resume_monitor` (its PR is open), without the lane key, as that result's relay says.

   An answer is never passed to another lane, branch, doc or workflow than the one its entry names. `bug-fix-backlog` reads an `intake` id as its own lanes question, so it gets no design answer. An entry that reads `kept off the state branch by the person` is never passed from the handoff: ask the person for the call `/start-product` printed and the answers they gave since, and pass those.
6. Only then does it do `## Next`.

It runs `/handoff` again before it ends.

## Safety

- The only writes are to the state branch (`STATE.md`, the linked `runs/` files and, with the person's consent on record, `context/builder-context.md`, through `pipeline-state.py`, never a checkout) and the context guard's handoff mark. Never commit, stage or push anything else, and never stash or discard uncommitted work: list it.
- Never write a secret, a token or an `.env` value into the handoff: name the secret. Never copy the brief into it or anywhere else on the state branch: the state branch is as visible as the repository. For a design run whose args carry `save_answers: false`, never write an answer that run was given, or the question it answers, into it or into a `runs/` file either. The builder context goes to the state branch only with the person's consent, as `context/builder-context.md`, and never into `STATE.md`.
- Never merge a pull request, never push to `$MAIN_BRANCH`, never force-push.
- Record only what the session knows or the commands show; an unknown is written as unknown, never guessed.
- Never drop, reword or change an answer or a standing rule the person gave, and never record a choice the session made as the person's answer.

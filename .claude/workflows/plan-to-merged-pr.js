export const meta = {
  name: 'plan-to-merged-pr',
  whenToUse: 'Take one concern — or one proposal lane — from plan to an open, review-clean PR, then babysit it. Also: build-only (stacked lanes, no PR), ship-only (open/ready a built branch — a stacked lane once its predecessors merged, or the bootstrap/<date> branch from /bootstrap) and monitor-only modes. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with answers, as its relay says.',
  description: 'Plan → impl → review/fix until clean → polish-until-clean → PR → monitor CI, comments and conflicts, for one concern or proposal lane',
  phases: [
    { title: 'Plan', detail: '/plan (or a project planning skill) at medium effort' },
    { title: 'Implement', detail: '/impl at low effort' },
    { title: 'Review', detail: '/review-changes at high effort, fixes at low, re-reviewed until clean' },
    { title: 'Polish', detail: '/polish at low effort until a clean round' },
    { title: 'PR', detail: 'commit + merge check, then /create-pr (or push only, in build-only mode)' },
    { title: 'Monitor', detail: 'merge main, process comments, fix CI this PR broke, until settled' },
  ],
}

// args (a plain string is taken as `concern`):
//   concern: string            the plan / concern text; for a custom planner that plans a proposal's steps, the steps in scope for this lane
//   planner?: string           skill that writes the plan (default 'plan'); a custom planner gets `planner_args`
//   planner_args?: string      args for a custom planner (default: the concern)
//   proposal?: string          proposal / design doc path; handed to the planner (as /plan --proposal=<path>) and frames the review alongside the plan
//   proposal_steps?: number[]  the proposal's steps this run implements; ticked ([ ] -> [x]) in the proposal in the same commit (needs proposal)
//   allow_draft?: boolean      let /plan --proposal plan from a proposal whose Status is draft (default false: a person accepts it first)
//   context?: string           scouting hints for the planner
//   plan_text?: string         an already-written plan (e.g. from bug-fix-backlog's triage); skips the planning skill, needs `branch`.
//                              In ship-only and monitor-only modes: the branch's own plan, used when there is no plan_ref (or its get fails)
//   plan_ref?: string          ship-only and monitor-only: the branch's plan on the pipeline state branch ('plans/<branch-slug>.md', as a
//                              build's result gives it). Agents read it with pipeline-state.py get and restore it into PLANS_DIR, where
//                              /create-pr's and the monitor commands' own plan lookup finds it
//   dir?: string               checkout / worktree to work in (created from the last base when `branch` is given and it is absent; in
//                              ship-only and monitor-only modes, recreated on `branch` from origin by the first agent that finds it absent)
//   repo?: string              the repository's GitHub owner/name, e.g. 'acme/app': what a missing dir is cloned from when the checkout an
//                              agent starts in is not this repository's, and the owner/name of connector calls
//   github_access?: string     'gh' | 'connector' | '' (default ''): how the agents reach GitHub; '' = the GITHUB_ACCESS line of the
//                              Pipeline config, else gh when it is authenticated, else the connector (.claude/scripts/github-access.md).
//                              git fetch and push stay plain git either way
//   branch?: string            use this branch instead of letting the planner create one
//   replan?: boolean           true = plan again even when an earlier run of this branch saved its plan (the new plan is saved
//                              over it). Default false: the planner of a given branch continues from the saved plan. Pass it when
//                              the person's answer is to plan the work again, or when a run failed on the saved plan itself.
//                              It is for one run: that run's planner gets every answer, whichever stage asked, and a re-run after
//                              a later stage's question leaves it out (the relay says so), or it would plan a further time
//   bases?: string[]           branches this work is stacked on (merged before planning and at the merge check)
//   ship?: boolean             default true; false = build only: commit, merge check, push the branch, open no PR
//   ship_only?: boolean        skip planning/building: open (or ready `existing_pr`) a PR for `branch`, then monitor
//   existing_pr?: number       ship-only: update + ready this PR instead of creating one
//   predecessor_prs?: number[] PRs that must read MERGED before a PR is opened or readied (a merge bot / auto-merge may merge any ready PR)
//   title?: string, pr_note?: string     PR title / extra body text when opening; closing keywords in pr_note are the PR's only ones
//   gate?: string              gate wrapper, e.g. ./.claude/scripts/gate-slot.sh (default '': the agents use GATE_WRAPPER from the Pipeline config when set)
//   main_branch?: string       integration branch (default 'main')
//   ai_review_check?: string   name of a CI check that posts AI review comments (default none)
//   required_checks?: string[] CI checks outside the quality gates that must also be green to settle, e.g. a mobile build or a migration check;
//                              one this PR turns red gets the CI-fix step (reproduced locally when possible, else fixed from its log)
//   commit_trailers?: string[] lines the workflow's own commits end with (default ['Co-Authored-By: Claude <noreply@anthropic.com>'])
//   max_review_rounds?: 5, max_polish?: 6, max_monitor_rounds?: 10 (max_rounds is accepted as an alias)
//   efforts?: { plan, impl, review, fix, polish, merge_check, pr, monitor, closeout }  (pr unset = the session's effort, as /create-pr always ran)
//   on_question?: 'stop'|'assume'  default 'stop': a stage that hits a blocking question (one only the person can answer) stops the
//                              run with status needs_input and the questions; 'assume' takes each recommended option instead (in a
//                              conflict with what the person said, what the person said) and lists it in the result's assumptions
//   answers?: [{ id, answer, question?, date? }]  the questions a needs_input result returned, each with the person's answer, its
//                              question text and the date they gave it (or { <id>: answer }); each answer reaches the stage that
//                              asked and every later stage, so a resume (resumeFromRunId) replays the stages before it from the
//                              record. A result's assumption the person corrects is passed the same way, as <its stage>.d<N>
//                              (N the next number not yet in use), to a run that builds. A ship-only or monitor-only run builds
//                              nothing, so no stage would apply it: there the person corrects it with a review comment on the PR,
//                              which the monitor's comment step applies. An answer passed without its question text still binds,
//                              but a stage that cannot tell from the answer alone what it settles treats it as settling nothing,
//                              so pass the question with it
//   assumptions?: [{ stage, assumption }]  an earlier run's result.assumptions, for a re-run from a session with no run record
//                              (without resumeFromRunId): the stages that made them find their work in place and report nothing
//                              the second time, so without this they would reach neither the result, the saved plan nor the PR
//                              body. They are listed with this run's own; a line this run reports again is kept once
// Monitor-only mode: { pr: number, branch: string, dir?: string } skips straight to the Monitor phase.
// A run that hands the PR off while it is still open returns resume_monitor (these args, ready to re-run) and a one-line handoff.
// resume_monitor carries the answers this run was given, so the monitor-only run keeps what the person settled during the build,
// and, as assumptions, what the run lists as assumed, so that run's steps keep each choice too.
// A run given `proposal` whose PR reads MERGED checks the proposal on origin/<main_branch> and returns closeout (read-only:
// only a person sets Status: done or ticks the roadmap milestone): { proposal_complete: true, edits, next_milestone, roadmap,
// milestone: { n, title, acceptance } | null } (the milestone they tick, with the Acceptance they check first) or
// { proposal_complete: false, pending_steps, pending: [{ n, title, human_gate }] } (each unticked step by title).
// The plan is saved to the pipeline state branch (pipeline-state.py save, best effort) twice: by the planner when planning ends,
// so a later run of the same branch continues from that plan instead of planning again (a re-run after an impl, fix, polish or
// merge-check question, from a session with no run record), and by the merge check, which adds the plan's
// "## Assumptions to review" section: what the stages assumed and what the person answered. A later ship-only or monitor-only
// run reads it from there. Every result carries plan_ref: 'plans/<branch-slug>.md' (or the plan_ref given), else '' when it was
// not saved; resume_monitor carries plan_ref instead of plan_text when there is one. A failed_at_impl result whose plan stays
// saved carries hint: a re-run continues from that plan unless it passes replan.
// Every result carries assumptions: [{ stage, assumption }]. They reach every later stage of the run, the monitor's steps
// included, the saved plan and the PR body ("## Assumptions to review"), so the person can correct one before merging (with a
// review comment on the PR); the result's plan text ends with that section too (the fallback a ship-only run is given as
// plan_text when the save failed). A result also lists, when there are any,
// declined (review findings the fixer judged wrong: [{ round, finding, reason }]) and polish_unfixed (bugs and concerns the last
// polish round left unfixed: [{ file, severity, description }]; polish_clean is then false).
// Every stage that commits stages by explicit path and never commits docs/brief.md, docs/builder-context.md or a file the plan
// or /bootstrap's report lists as left out; a result lists any it left uncommitted in left_uncommitted.
const A = typeof args === 'string' ? { concern: args } : (args || {})
const CONCERN = A.concern
const MONITOR_ONLY = !!A.pr
const SHIP_ONLY = !!A.ship_only
const CLOSES_IN_NOTE = /\b(fix(es|ed)?|close[sd]?|resolve[sd]?):?\s+#\d+\b/i.test(A.pr_note || '')
const BUILD_ONLY = A.ship === false
if (!CONCERN && !MONITOR_ONLY && !SHIP_ONLY) throw new Error('pass args.concern (the plan / concern text), args.ship_only + args.branch, or args.pr + args.branch to only monitor')
if ((MONITOR_ONLY || SHIP_ONLY) && !A.branch) throw new Error('monitor-only and ship-only modes need args.branch')
if (SHIP_ONLY && BUILD_ONLY) throw new Error('ship_only and ship: false are mutually exclusive')
if (MONITOR_ONLY && (SHIP_ONLY || BUILD_ONLY)) throw new Error('args.pr (monitor-only) cannot be combined with ship_only or ship: false')
if (SHIP_ONLY && !A.existing_pr && !A.title) throw new Error('ship-only mode needs args.title (or args.existing_pr)')
if (A.plan_text && !A.branch) throw new Error('args.plan_text needs args.branch (the branch the plan is built on)')
const STEPS = (A.proposal_steps || []).map(Number).filter(n => Number.isInteger(n) && n > 0)
if (STEPS.length && !A.proposal) throw new Error('args.proposal_steps needs args.proposal (the design doc the steps belong to)')
if (STEPS.length && SHIP_ONLY) throw new Error('args.proposal_steps is ticked when the work is built; ship-only mode builds nothing')
if (A.plan_ref && !SHIP_ONLY && !MONITOR_ONLY) throw new Error('args.plan_ref is read in ship-only and monitor-only modes; to build from a saved plan, pass its text as plan_text')
if (A.plan_ref && !/^[A-Za-z0-9._/-]+$/.test(String(A.plan_ref))) throw new Error('args.plan_ref must be a path on the pipeline state branch, e.g. plans/feat-x.md')
const REPO = A.repo ? String(A.repo).trim() : ''
if (REPO && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPO)) throw new Error('args.repo must be the repository\'s GitHub owner/name, e.g. acme/app')
const GH_ACCESS = String(A.github_access ?? '').trim().toLowerCase()
if (!['', 'gh', 'connector'].includes(GH_ACCESS)) throw new Error(`github_access must be 'gh', 'connector' or '' (got ${JSON.stringify(A.github_access)})`)
// The plan this branch was built from: this run's, or args.plan_text (ship-only / monitor-only), ending with its
// "## Assumptions to review" section as it stands when called (withNotes). Called once planning is done.
const planForPr = () => withNotes((plan && plan.plan && plan.plan !== 'given') ? plan.plan : (A.plan_text || ''))
// A plan text without its "## Assumptions to review" section, and that section's lines.
const splitNotes = text => {
  const m = /^## Assumptions to review[ \t]*$/m.exec(text)
  if (!m) return { body: text, lines: [] }
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/^## /m)
  const lines = (next < 0 ? rest : rest.slice(0, next)).split('\n').filter(l => l.startsWith('- '))
  return { body: (text.slice(0, m.index) + (next < 0 ? '' : rest.slice(next))).trimEnd(), lines }
}
// A long plan is cut for the prompts that only read it. The cut never takes its "## Assumptions to review" lines: they sit at
// the end of the text, and they are how a later run learns what was assumed and what the person answered.
const clip = t => {
  const { body, lines } = splitNotes(t)
  if (body.length <= 8000) return t
  return body.slice(0, 8000) + '\n[plan truncated]' + (lines.length ? `\n\n## Assumptions to review\n\n${lines.join('\n')}\n` : '')
}
// A name as the pipeline state branch spells it in paths: `pipeline-state.py slug`, copied here and in proposal-build-chain.js
// (ci/test-workflow-shipping.mjs checks both copies against the script). Every character outside [A-Za-z0-9._-] becomes '-';
// when any did, '-' and 8 hex digits of FNV-1a 32 over the name's UTF-8 bytes follow, so feat/x and feat-x never share a file.
const stateSlug = name => {
  const s = String(name)
  const out = s.replace(/[^A-Za-z0-9._-]/gu, '-')
  if (out === s) return out
  let h = 0x811c9dc5
  const add = b => { h = Math.imul(h ^ b, 0x01000193) >>> 0 }
  for (const ch of s) {
    let c = ch.codePointAt(0)
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd   // a lone surrogate, written as U+FFFD as a UTF-8 encoder does
    if (c < 0x80) add(c)
    else if (c < 0x800) { add(0xc0 | (c >> 6)); add(0x80 | (c & 63)) }
    else if (c < 0x10000) { add(0xe0 | (c >> 12)); add(0x80 | ((c >> 6) & 63)); add(0x80 | (c & 63)) }
    else { add(0xf0 | (c >> 18)); add(0x80 | ((c >> 12) & 63)); add(0x80 | ((c >> 6) & 63)); add(0x80 | (c & 63)) }
  }
  return `${out}-${h.toString(16).padStart(8, '0')}`
}
// A lane's plan on the pipeline state branch (.claude/scripts/pipeline-state.py): plans/<branch-slug>.md.
const planRefFor = b => `plans/${stateSlug(b)}.md`
// Every stage after planning keeps its changes consistent with the design doc, not only the review.
const PROPOSAL_CTX = A.proposal
  ? `This work implements ${A.proposal}${STEPS.length ? ` steps ${STEPS.join(', ')}` : ''}: keep every change consistent with that design doc's Decisions, Security and privacy, and Rollout sections. `
  : ''
const CONTEXT = A.context || ''
const DIR = A.dir || ''
const PLANNER = A.planner || 'plan'
const MAIN = A.main_branch || 'main'
const AI_CHECK = A.ai_review_check || ''
const REQUIRED = (A.required_checks || []).filter(Boolean)
const REQ_NOTE = REQUIRED.length ? ` plus the required checks ${REQUIRED.map(c => `"${c}"`).join(', ')}` : ''
const BASES = (A.bases || []).filter(b => b && b !== MAIN)
const PREDS = (A.predecessor_prs || []).map(Number)
// A stacked branch carries unmerged base commits; a ready PR to main would let a merge bot merge them early.
if (BASES.length && !A.branch) throw new Error('args.bases needs args.branch (the stacked branch to build)')
if (BASES.length && !BUILD_ONLY && !PREDS.length) throw new Error('a stacked run that opens or readies a PR needs args.predecessor_prs (or ship: false to build only)')
const GATE = A.gate !== undefined ? A.gate : ''
const TRAILERS = (A.commit_trailers || ['Co-Authored-By: Claude <noreply@anthropic.com>']).join('\n')
const MAX_REVIEW = A.max_review_rounds ?? 5
const EFF = { plan: 'medium', impl: 'low', review: 'high', fix: 'low', polish: 'low', merge_check: 'low', monitor: 'low', closeout: 'low', ...(A.efforts || {}) }
// Agent options; an unset effort inherits the session's.
const opts = (label, ph, effortKey, schema) => {
  const o = { label, phase: ph }
  if (EFF[effortKey]) o.effort = EFF[effortKey]
  if (schema) o.schema = schema
  return o
}
// Worktrees share one refs/stash: parallel lanes that stash can pop each other's entries.
const NO_STASH = `Never run git stash (push, pop, apply or drop): every worktree of this repo shares one stash list, ` +
  `so another lane can pop your entry or you can pop theirs. For a before/after check, save the diff to a file in ` +
  `your scratch area (git add -N any new fix files first, then git diff --binary HEAD -- <fix paths> > <file>), ` +
  `git checkout HEAD -- <fix paths> and remove any new fix files, leaving the tests in place, run the test, ` +
  `then git apply <file>; or make a WIP commit on your own branch. `
// Ship-only and monitor-only work on a branch built earlier, perhaps in another container: the first agent that finds the
// checkout missing recreates it on the branch from origin, before anything else.
const RECREATE = (SHIP_ONLY || MONITOR_ONLY) && DIR
  ? `If ${DIR} does not exist (a new container, or a removed worktree), recreate it before anything else, on branch ${A.branch} as it is on origin; this is allowed even in a read-only step. ` +
    `If the checkout you started in (your working directory before any cd) is a checkout of this repository, its origin${REPO ? ` being ${REPO} and` : ''} having the branch (git ls-remote --heads origin ${A.branch} lists it), add a worktree from it: ` +
    `git fetch origin +refs/heads/${A.branch}:refs/remotes/origin/${A.branch} (a single-branch clone's plain fetch skips other branches), git worktree prune, then git worktree add -b ${A.branch} ${DIR} origin/${A.branch} (no --track: a single-branch clone refuses to track a branch its fetch refspec does not cover, so push with an explicit git push origin ${A.branch}), ` +
    `or, when a local ${A.branch} already exists, git worktree add ${DIR} ${A.branch} and git -C ${DIR} merge --ff-only origin/${A.branch}. ` +
    (REPO
      ? `Otherwise make a fresh clone: git clone https://github.com/${REPO} ${DIR}, then git -C ${DIR} switch ${A.branch}. `
      : `Otherwise, with no checkout of this repository to add it from and no repo arg to clone it from, change nothing and report error=checkout_missing (a re-run with repo: '<owner>/<name>' recreates it by a fresh clone). `) +
    `Never recreate it on any other branch. `
  : ''
const WHERE = (DIR
  ? `Work ONLY in the git checkout ${DIR} (cd there / use absolute paths); other workflows may be using other checkouts. ` + RECREATE
  : '') + NO_STASH
// A denied action must stay denied: an agent that is refused an edit must not redo it through another tool.
const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path). Record it as blocked — for a review comment, post the ` +
  `"Surfaced for human review — out of scope for automated remediation." reply once — and report it; a human decides. `
// GitHub access: gh, or the GitHub MCP connector (.claude/scripts/github-access.md maps each gh operation to its tool). Every
// prompt that touches GitHub names it; '' leaves it to the GITHUB_ACCESS line of the Pipeline config. cx (cxIn, inside a gh
// command's own parentheses) names its connector tool and byAccess picks mode-specific text, each only when the run may be in that mode.
const cx = tool => GH_ACCESS === 'gh' ? '' : ` (connector: ${tool})`
const cxIn = tool => GH_ACCESS === 'gh' ? '' : `; connector: ${tool}`
const byAccess = (gh, connector) => GH_ACCESS === 'gh' ? gh : GH_ACCESS === 'connector' ? connector : `In gh mode: ${gh} In connector mode: ${connector}`
const ACCESS = (GH_ACCESS
  ? `The access for this run is ${GH_ACCESS} (the github_access arg, which overrides the GITHUB_ACCESS line in the "Pipeline config" section of CLAUDE.md). `
  : `The access for this run is the GITHUB_ACCESS line in the "Pipeline config" section of CLAUDE.md; when it is absent, gh when gh auth status succeeds, else the GitHub MCP tools ("Which access" in .claude/scripts/github-access.md). `) +
  `Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. ` +
  (GH_ACCESS === 'gh' ? '' : `In connector mode, load the mcp__github__ tool schemas with ToolSearch, do each gh command named here with the tool named after it (that file maps the rest), and take the owner and name ${REPO ? `from ${REPO}` : 'from git remote get-url origin'}, never guessed. `) +
  `If the access in use is unavailable, stop with error=github_unavailable${GH_ACCESS === 'connector' ? '' : ' (gh mode keeps its existing error names, gh_unauthenticated and gh_auth_failed)'}. ` +
  `git fetch and git push stay plain git in both modes. `
// Projects may route gh/git network calls through a wrapper (GH_WRAPPER in the Pipeline config); ambient gh auth is the fallback.
const NET = GH_ACCESS === 'connector' ? 'git' : 'gh/git'
const AUTH = ACCESS + `For ${NET} network commands use the GH_WRAPPER prefix from the "Pipeline config" section of CLAUDE.md when it is set and works in this checkout; otherwise run ${NET} directly (ambient auth works). ` +
  (GH_ACCESS === 'connector' ? '' : (GH_ACCESS ? '' : 'In gh mode: ') +
    `A skill's auth check (e.g. /create-pr's gh auth status, which stops with error=gh_unauthenticated) passes when plain gh is authenticated, even if the GH_WRAPPER prefix does not work here; stop only when plain gh is unauthenticated too. ` +
    `For GraphQL owner/name, read them from \`gh repo view --json owner,name\` — never guess the repository name. `)
// Ship-only and monitor-only read the branch's plan from the state branch (plan_ref), restored into the plans directory under
// the name /create-pr's and /merge-main's branch-name lookup reads: <PLANS_DIR>/<branch without a leading feat/, fix/ or refactor/>.md.
const RESTORE = A.plan_ref
  ? `This branch's plan is saved on the pipeline state branch as ${A.plan_ref}. First restore it into the plans directory (PLANS_DIR from the "Pipeline config" section of CLAUDE.md, default ~/.claude/plans), under the name the commands' own plan lookup reads for this branch: ` +
    `python3 .claude/scripts/pipeline-state.py get ${A.plan_ref} --to <PLANS_DIR>/${String(A.branch || '').replace(/^(feat|fix|refactor)\//, '')}.md, with <PLANS_DIR> that directory, ~ expanded. `
  : ''
// The plan a ship-only or monitor-only stage reads may end with "## Assumptions to review": what the build's stages assumed and
// what the person answered then. Those answers reach this run through the plan alone, unless they were passed again.
// An answer given to this run under the id of an answered line is the person's newer word on it. A comment on the PR that corrects
// an assumed line is the correction the section asks for: the comment step applies it.
const PLAN_NOTES = `When that plan has a "## Assumptions to review" section, its lines starting "- answered" are what the person settled while the branch was built: each binds like an answer from the person given to this run and is never asked again, ` +
  `and a change that would depart from one (a reviewer's request, a conflict resolution, a CI fix) is a blocking question, per QUESTIONS. Where an answer given to this run has the id and the question of such a line, it is the person's newer answer to that question and holds; a line of the same id for another question still binds. When you return a question, also return in answered_ids the id of each such "- answered (<id>" line, so the new question gets an id none of them uses. ` +
  `Its lines starting "- assumed" are choices nobody confirmed: keep each, and a reason of your own to change one is a blocking question too. A person's comment on the PR that corrects one is no such reason: it is the correction that section asks for, ` +
  `a request to validate and apply (a blocking question only when it also departs from an "- answered" line or a decision tagged (person, ...)). `
const RESTORE_ELSE = A.plan_text
  ? `If that get fails, use this copy of the plan instead:\n${clip(A.plan_text)}\n`
  : `If that get fails (exit 3: the plan was never saved; exit 2: git failed), go on without a plan: plans are saved and restored best effort. `
// Every stage that may run a quality gate — directly or through a skill such as /impl, /polish, /merge-main or /process-comments.
// The project's gate commands: QUALITY_GATES (and optionally QUALITY_GATES_FAST) in the "Pipeline config" section of CLAUDE.md.
const GATE_CMDS = `the project's quality gates (QUALITY_GATES, or QUALITY_GATES_FAST for quick iterations, from the "Pipeline config" section of CLAUDE.md)`
const GATES = `GATE RULES (these override any skill instruction to run gates in the foreground with a fixed timeout): ` +
  (GATE
    ? `run ${GATE_CMDS} and every other lint / typecheck / test invocation through the gate semaphore, \`${GATE} <command>\` (a compound command as \`${GATE} bash -c '<command>'\`, writing any ' inside it as '\\''), from the checkout root. ` +
      `Use it instead of any GATE_WRAPPER from the Pipeline config, including where a skill says to use GATE_WRAPPER, and never nest the two. ` +
      `It takes a CPU-disjoint slot sized to this machine and pins the run to it; let the test runner size its parallelism from the slot (GATE_SLOT_WORKERS), never a literal worker count. ` +
      `Exit 75 = every slot busy: re-run the same command. Exit 125 (with a "gate-slot:" line on stderr), or 127 / a missing wrapper script = the wrapper cannot run: report it, never bypass the wrapper. Any other exit code is the gated command's own result. `
    : `run ${GATE_CMDS} from the checkout root, prefixed with GATE_WRAPPER from the same Pipeline config when it is set (\`$GATE_WRAPPER bash -c '<command>'\`, writing any ' inside it as '\\'', so a compound command runs whole under it). `) +
  `Run long gates with run_in_background and output to a log, monitor the log, and do not end your turn until the run exits — no hard timeouts. ` +
  `Write any commit message or PR body that names those tools to a file and pass it with -F / --body-file. `
// A single-branch clone's plain git fetch never updates refs/remotes/origin/<base>, nor prunes it once the base is deleted:
// each base is fetched by explicit refspec, and git ls-remote says whether origin still has it.
const STACK = BASES.length
  ? `This work is stacked on ${BASES.join(', ')}, which may not be merged yet. For each base: when git ls-remote --heads origin <base> lists nothing, it was deleted: skip it. ` +
    `Otherwise fetch it by explicit refspec, git fetch origin +refs/heads/<base>:refs/remotes/origin/<base> (a single-branch clone's plain fetch skips other branches, so origin/<base> would stay stale); ` +
    `skip it too when it is already merged into ${MAIN} (git merge-base --is-ancestor origin/<base> origin/${MAIN} succeeds, after git fetch origin +refs/heads/${MAIN}:refs/remotes/origin/${MAIN}); ` +
    `else merge the latest origin/<base>. Never rebase, never force-push. Work present on those bases counts as landed, not as a missing dependency. `
  : ''
const PREDS_CHECK = PREDS.length
  ? `First confirm each of ${PREDS.map(n => '#' + n).join(', ')} reads MERGED (gh pr view <n> --json state${cxIn('pull_request_read method get, merged true')}). If any does not, change nothing and report blocked=true naming it. `
  : ''
const WORK = GUARD + WHERE + GATES
// A merge conflict that is the person's call, as /merge-main handles it: returned with the merge aborted, or, when the person
// chose to proceed on assumptions, resolved with the recommended option and reported.
const conflictCall = aborted => A.on_question === 'assume'
  ? `the person chose to proceed on assumptions, so do not abort: resolve it with the option you recommend (where the person settled one side, always that side) and report it in assumptions as "<the conflict> -> <option taken>".`
  : `git merge --abort${aborted}, push nothing, and return it: never pick a side.`
// Every stage that commits keeps out what must not reach the repo: the brief and builder context a new product starts from
// (often private), and whatever the plan or /bootstrap's report lists as left out. Those stay uncommitted and are reported.
const KEEP_OUT = `Stage files by explicit path only (never git add -A, git add . or git commit -a), and never stage or commit docs/brief.md or docs/builder-context.md, ` +
  `nor any file outside the change you are shipping that the plan or /bootstrap's report lists as left out of the commit: leave each such file uncommitted ` +
  `(an expected leftover, not a dirty tree to stop on) and list it in left_uncommitted. `
// Questions before assumptions. No one can answer an agent mid-run, so a stage that needs the person's answer returns its
// questions and the run stops with needs_input; the caller asks the person and re-runs with args.answers.
// Stage kinds in run order: an answer reaches the kind that asked and every later kind, never an earlier one, so a resume
// replays the earlier stages from the record.
const KINDS = ['plan', 'impl', 'fix', 'polish', 'merge_check', 'monitor']
const ON_Q = A.on_question === 'assume' ? 'assume' : 'stop'
const kindOrder = id => { const i = KINDS.indexOf(String(id || '').split('.')[0]); return i < 0 ? 0 : i }
// Each answer: { id, answer, question?, date? }. The question text and the date travel with it into the prompts, the saved
// plan and the PR body.
const ANSWERS = (Array.isArray(A.answers) ? A.answers : Object.entries(A.answers || {}).map(([id, answer]) => ({ id, answer })))
  .filter(a => a && a.answer !== undefined && a.answer !== null && String(a.answer).trim() !== '')
// An answer that came back without its question text (an id-only map, an older handoff) is shown with its id as the question:
// it still binds, and no stage may guess what it settled.
const NO_TEXT = `An entry above whose question equals its id was passed without its question text. When its answer alone does not say what it settles, it settles nothing: never guess what it meant. `
if (ANSWERS.some(a => !a.question)) log(`Answer(s) passed without their question text: ${ANSWERS.filter(a => !a.question).map(a => a.id).join(', ')} (pass each answer with its question, so every stage can tell what it settles)`)
const ASK_RULE = `QUESTIONS: this stage runs unattended inside a workflow. No one can answer a question mid-run, so never wait for one and never use a question tool. ` +
  `A blocking question is one only the person can answer (what they intend, a requirement or constraint the concern, plan or design doc leaves out or states two incompatible ways, a trade-off that is theirs to make, ` +
  `a conflict between what the person said (an answer given to this run, the framing, a decision a design doc tags (person, ...)) and the concern, the plan, the tree or your research, or a blocker whose way forward is their call) ` +
  `and whose plausible answers lead to materially different work: a different design, promise, cost or legal exposure. ` +
  `What the person said outranks the concern and the plan. On the point it addresses, it replaces what they say: follow it, and never ask it again. That difference is not a conflict. ` +
  `The conflict that is a blocking question is the other one: another part of the concern, the plan or the design doc, the tree or your research makes what the person said impossible to follow. Then pick no side and ask, naming both. ` +
  `Settle yourself anything the tree, CLAUDE.md, the plan, the design docs or desk research can settle; never ask about it. ` +
  `A person-owned choice that no doc, plan or answer settles is ${ON_Q === 'assume' ? 'a blocking question' : 'asked as a blocking question, never assumed'}: money or an account in the person's name; a new third-party service or dependency that receives data; ` +
  `a change to what the product promises its users or to its public interface; a licence; a name (product, package, domain, organization or bundle id). ` +
  `Never change what the person settled: an answer, the framing or a decision tagged (person, ...) is changed only by a newer answer from the person, and a reason to change it is a blocking question. ` +
  `A question, its options and the recommendation name steps, decisions and milestones by title; a number may follow the title, but a number alone is never enough, because numbers move between revisions. ` +
  (ON_Q === 'assume'
    ? `The person chose to proceed on assumptions: for each blocking question, take the option you recommend (in a conflict with what the person said, always what the person said) and report it in assumptions as "<question> -> <option taken>". `
    : `Never guess the answer to a blocking question: stop there, change nothing further, and return every such question (all of them, in one pass) in questions, each with why it blocks, 2-4 concrete options and the one you recommend. `) +
  `Report in assumptions every other choice you made that the inputs did not settle (empty when none). `
const answersFor = kind => {
  const mine = ANSWERS.filter(a => kindOrder(a.id) <= KINDS.indexOf(kind))
  return mine.length
    ? `Answers from the person to questions an earlier run raised (binding, like an explicit constraint; never re-ask them, and never change what one settled: a reason to change it is a blocking question): ` +
      `${JSON.stringify(mine.map(a => ({ id: a.id, question: a.question || a.id, answer: a.answer, ...(a.date ? { date: a.date } : {}) })))}\n` +
      (mine.some(a => !a.question) ? NO_TEXT + '\n' : '')
    : ''
}
// The assumptions the stages so far reported reach every later stage of the run, so none replaces one with a pick of its own,
// asks it again or reports it as a defect. A reviewer cannot ask: its reason to change one is a finding that names the question.
const assumedSoFar = (canAsk = true) => ASSUMED.length
  ? `Choices earlier stages of this run made that the person has not confirmed: keep each, never ask it again, and it is no defect; a reason to change one is ` +
    `${canAsk ? 'a blocking question' : 'a concern that names the question to ask the person'}: ${JSON.stringify(ASSUMED.map(a => a.assumption))}\n`
  : ''
const ASK = kind => ASK_RULE + answersFor(kind) + assumedSoFar()
const QUESTION = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    why: { type: 'string', description: 'what changes with the answer: the work each option leads to' },
    options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete options' },
    recommended: { type: 'string', description: 'the option you recommend, and why in one clause' },
  },
  required: ['question', 'why', 'options', 'recommended'],
}
const QA = {
  questions: { type: 'array', items: QUESTION, description: 'blocking questions only the person can answer; non-empty means you stopped there and changed nothing further' },
  assumptions: { type: 'array', items: { type: 'string' }, description: 'every choice you made that the inputs did not settle' },
  answered_ids: { type: 'array', items: { type: 'string' }, description: 'only when you return questions and read the branch\'s plan from the state branch: the id of each "- answered (<id>" line of its "## Assumptions to review" section' },
}
const oneLine = t => String(typeof t === 'string' ? t : (JSON.stringify(t) ?? '')).replace(/\s*\n\s*/g, ' ').trim()
// What nobody confirmed: this run's stages add to it, after what an earlier run of the branch assumed (args.assumptions). A re-run
// from a session with no run record finds that run's work in place, so its stages report nothing the second time; a line a stage
// does report again (the same stage, the same text) is kept once.
const ASSUMED = []
const addAssumed = (stage, a) => { if (a && !ASSUMED.some(x => x.stage === stage && oneLine(x.assumption) === oneLine(a))) ASSUMED.push({ stage, assumption: a }) }
for (const a of Array.isArray(A.assumptions) ? A.assumptions : []) if (a && a.assumption) addAssumed(String(a.stage || 'earlier run'), a.assumption)
const noteAssumptions = (kind, r) => { if (r && Array.isArray(r.assumptions)) for (const a of r.assumptions) addAssumed(kind, a); return r }
// What the person has not confirmed, and what they answered, as the lines of a plan's last section, "## Assumptions to review":
// the merge check saves the plan with it, /create-pr copies it into the PR body, and a later run that restores the plan reads it
// there. A plan that already ends with the section (restored from an earlier run of the branch) keeps its lines; new ones follow.
const NOTES_HEAD = '## Assumptions to review'
const NOTES_INTRO = 'Choices the stages of this branch made that the person has not confirmed (assumed), and what the person answered (answered). ' +
  'Show them to the person before the PR is merged; they correct an assumed line with a review comment on the PR, which the monitor\'s comment step applies.'
const noteLines = () => [
  ...ASSUMED.map(a => `- assumed (${a.stage}): ${oneLine(a.assumption)}`),
  ...ANSWERS.map(a => `- answered (${a.id || 'no id'}${a.date ? `, ${oneLine(a.date)}` : ''}): ${oneLine(a.question || a.id || '')} -> ${oneLine(a.answer)}`),
]
// An answered line the plan kept from an earlier run gives way to this run's answer to the same question under the same id: the
// person's newer word on it. A line whose id an unrelated question of this run happens to share stays: an earlier run of the
// branch (the build, before a ship-only run) numbers its questions on its own, and its answer is never dropped for another's.
const ANSWERED_LINE = /^- answered \(([^,)]+)(?:,[^)]*)?\): (.*)$/
const qKey = t => oneLine(t).toLowerCase().replace(/[^a-z0-9]+/g, '')
const superseded = line => {
  const m = ANSWERED_LINE.exec(line)
  return !!m && ANSWERS.some(a => String(a.id || '') === m[1] && qKey(m[2].split(' -> ')[0]) === qKey(a.question || a.id || ''))
}
// The ids a plan text's answered lines use: a new question is numbered after them too.
const answeredIds = text => splitNotes(text || '').lines.map(l => (ANSWERED_LINE.exec(l) || [])[1]).filter(Boolean)
const withNotes = text => {
  if (!text) return ''
  const { body, lines } = splitNotes(text)
  const all = [...new Set([...lines.filter(l => !superseded(l)), ...noteLines()])]
  return all.length ? `${body}\n\n${NOTES_HEAD}\n\n${NOTES_INTRO}\n\n${all.join('\n')}\n` : text
}
// Files committing stages kept out on purpose (KEEP_OUT), reported in the result so a person decides what becomes of them.
const LEFT_OUT = new Set()
const noteLeftOut = r => { if (r && Array.isArray(r.left_uncommitted)) for (const f of r.left_uncommitted) if (f) LEFT_OUT.add(String(f)); return r }
const asked = r => !!(r && Array.isArray(r.questions) && r.questions.length)
// The relay of a needs_input result: how the caller asks, and what it passes back. needsInput adds what becomes of a corrected
// assumption and how to re-run.
const RELAY = `Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit (a numbered list when it has none), ` +
  `each with its why, its options and the recommended one first; never answer them on their behalf, and never re-run with on_question: 'assume' unless the person says to proceed on assumptions. `
// A run that builds applies a corrected assumption like any answer: the stage that made the choice gets it, and every later one.
const SHOW_ASSUMED = `Also show the person this result's assumptions: a line they correct is passed as an answer too (id <its stage>.d<N>, N the next number not yet in use, with the assumption as its question). `
// A ship-only or monitor-only re-run builds nothing, so no stage would apply a correction passed as an answer: it is a change to the
// branch, which the person asks for on the PR, where the monitor's comment step applies it.
const showAssumedOnPr = open => `Also show the person this result's assumptions. A line they correct is no answer: this re-run builds nothing, so no stage would apply it. ` +
  `The person leaves the correction as a review comment on the PR${open ? '' : ', once it is open'}, and a monitor run's comment step applies it. Only the answers to these questions go into answers. `
const RELAY_ANSWERS = `answers (each question's id and question text with the person's answer and the date they gave it, added to any answers given before)`
// Review scope: a stacked branch's HEAD carries its bases' commits, so review only this branch's own change.
// `bases` are ordered so the last one contains the others. Once that base is deleted or merged, the review is scoped
// against main. git ls-remote and git merge-base tell which, never origin/<base> resolving: a single-branch clone's
// fetch never prunes that tracking ref.
const LAST_BASE = BASES[BASES.length - 1]
const REVIEW_SCOPE = BASES.length ? `all:origin/${LAST_BASE}` : `all:origin/${MAIN}`
const SCOPE_NOTE = BASES.length
  ? ` First check that base, fetching by explicit refspec (a single-branch clone's plain fetch skips other branches): git fetch origin +refs/heads/${MAIN}:refs/remotes/origin/${MAIN}, then git ls-remote --heads origin ${LAST_BASE}. ` +
    `If that lists nothing (the base was deleted, usually once merged), use args "all:origin/${MAIN}" instead. ` +
    `Otherwise git fetch origin +refs/heads/${LAST_BASE}:refs/remotes/origin/${LAST_BASE}, and if ${LAST_BASE} is already merged into ${MAIN} (git merge-base --is-ancestor origin/${LAST_BASE} origin/${MAIN} succeeds), use args "all:origin/${MAIN}" too. ` +
    `Never take origin/${LAST_BASE} resolving as the base existing: a single-branch clone's fetch never prunes a deleted branch's tracking ref. `
  : ` Run git fetch origin ${MAIN} first so origin/${MAIN} is current. `

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string', description: 'feature branch created and checked out for this work' },
    plan: { type: 'string', description: 'full plan text: files, changes, tests, verification' },
    stopped: { type: 'boolean', description: 'true if the planning skill stopped without writing a plan (a routing recommendation or an error= stop)' },
    stop_reason: { type: 'string', description: 'when stopped: the skill\'s error code or recommendation, verbatim' },
    ...QA,
  },
  required: ['branch', 'plan', 'stopped', 'questions', 'assumptions'],
}
// The planner also restores the branch's saved plan, or saves the one it wrote, on the pipeline state branch.
const PLANNER_SCHEMA = {
  ...PLAN_SCHEMA,
  properties: {
    ...PLAN_SCHEMA.properties,
    plan_restored: { type: 'boolean', description: 'true only if the plan returned is the one pipeline-state.py get read from the state branch (no planning skill ran)' },
    plan_saved: { type: 'boolean', description: 'true only if the plan is on the pipeline state branch: pipeline-state.py save printed "saved": true for it, or it was restored from there' },
  },
  required: [...PLAN_SCHEMA.required, 'plan_saved'],
}
const STEP_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    gates_green: { type: 'boolean', description: 'the project quality gates all pass' },
    stopped: { type: 'boolean', description: 'true if the skill stopped before implementing (a plan-review blocker, an error= stop, or blocking questions, which go in questions)' },
    stop_reason: { type: 'string', description: 'when stopped: the blocker or error, verbatim' },
    already_implemented: { type: 'boolean', description: 'true if the plan\'s end state is already in this checkout (e.g. a re-run on a kept worktree whose earlier run built it), so there was nothing to change' },
    ...QA,
  },
  required: ['summary', 'files_changed', 'gates_green', 'stopped', 'already_implemented', 'questions', 'assumptions'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          severity: { type: 'string', enum: ['bug', 'concern', 'suggestion', 'nit'] },
          description: { type: 'string' },
        },
        required: ['file', 'severity', 'description'],
      },
    },
    completed: { type: 'boolean', description: 'false if the review skill stopped without reviewing' },
  },
  required: ['findings', 'completed'],
}
const POLISH_SCHEMA = {
  type: 'object',
  properties: {
    issues_found_and_fixed: { type: 'integer', description: 'count of bugs/issues fixed this round (0 = clean)' },
    unfixed: {
      type: 'array',
      description: 'every bug or concern this round found and left unfixed (never a suggestion or a nit), each with the reason in its description; empty when none',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, severity: { type: 'string', enum: ['bug', 'concern'] }, description: { type: 'string' } },
        required: ['file', 'severity', 'description'],
      },
    },
    summary: { type: 'string' },
    gates_green: { type: 'boolean' },
    ...QA,
  },
  required: ['issues_found_and_fixed', 'unfixed', 'summary', 'gates_green', 'questions', 'assumptions'],
}
const OBSERVE_SCHEMA = {
  type: 'object',
  properties: {
    pr_state: { type: 'string', enum: ['OPEN', 'MERGED', 'CLOSED'] },
    head_sha: { type: 'string' },
    has_conflicts: { type: 'boolean', description: 'true if the PR has merge conflicts with its base (mergeable CONFLICTING / mergeStateStatus DIRTY)' },
    behind_main: { type: 'boolean', description: 'true if the PR is conflict-free but out of date with its base (mergeStateStatus BEHIND)' },
    ai_review_done_on_head: { type: 'boolean', description: AI_CHECK ? `true once the "${AI_CHECK}" check run for head_sha has completed (any conclusion); a missing check means not registered yet, not done` : 'no AI review check is configured: true once CI on head_sha has completed' },
    ci_state: { type: 'string', enum: ['green', 'red', 'pending', 'none'], description: (AI_CHECK ? `Quality-gate CI on head_sha${REQ_NOTE}, ignoring the "${AI_CHECK}" check (it may fail just by posting findings)` : `Quality-gate CI on head_sha${REQ_NOTE}`) + (REQUIRED.length ? '; a required check that has not registered yet counts as pending' : '') },
    ci_red_caused_by_pr: { type: 'boolean', description: 'true only if ci_state is red and the failure is attributable to this PR\'s diff' },
    ci_configured: { type: 'boolean', description: 'true if the repository runs CI on pull requests (a .github/workflows file with a pull_request or push trigger, or check runs registered on this or a recent PR); false only when it has none' },
    actionable_comments: { type: 'integer', description: 'unresolved review threads (incl. outdated) with NO terminal reply (Fixed locally / Could not prove this defect / Declined with / Answered with / Tracked in #) and NO out-of-scope reply (Surfaced for human review — out of scope for automated remediation.; those wait on a human), plus threads with such a reply that a person answered afterwards (a later reply from a real user, not a bot and not this pipeline\'s own, that asks for a change or asks a question), plus unacknowledged overflow findings and unanswered top-level human comments' },
    notes: { type: 'string' },
    error: { type: 'string', description: 'only when the PR could not be read at all: the error, e.g. error=github_unavailable, error=gh_unauthenticated or error=checkout_missing (the other fields are then ignored); omit it otherwise' },
  },
  required: ['pr_state', 'head_sha', 'has_conflicts', 'behind_main', 'ai_review_done_on_head', 'ci_state', 'ci_red_caused_by_pr', 'ci_configured', 'actionable_comments', 'notes'],
}
// What a committing stage deliberately kept out of its commit (see KEEP_OUT).
const LEFT_UNCOMMITTED = { type: 'array', items: { type: 'string' }, description: 'files you deliberately left unstaged and uncommitted: docs/brief.md, docs/builder-context.md, or a file the plan or /bootstrap\'s report lists as left out (empty when none)' }
const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    pushed: { type: 'boolean', description: 'true if a commit was pushed to the PR branch this step' },
    handled: { type: 'integer', description: 'items handled (comments replied to / conflicts resolved / CI failures fixed)' },
    remaining: { type: 'integer', description: 'items still needing action after this step' },
    summary: { type: 'string' },
    left_uncommitted: LEFT_UNCOMMITTED,
    ...QA,
  },
  required: ['pushed', 'handled', 'remaining', 'summary'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    declined: {
      type: 'array',
      description: 'findings judged wrong and left unfixed, each with the reason',
      items: { type: 'object', properties: { finding: { type: 'string' }, reason: { type: 'string' } }, required: ['finding', 'reason'] },
    },
    gates_green: { type: 'boolean' },
    ...QA,
  },
  required: ['summary', 'declined', 'gates_green', 'questions', 'assumptions'],
}
const MERGE_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    blocked: { type: 'boolean', description: 'true if a predecessor is not merged (nothing was changed)' },
    blocked_reason: { type: 'string' },
    merge_check: { type: 'string', description: 'what was committed, what the merge brought in, conflicts resolved, merge-tree result vs the base branch' },
    conflicts_resolved: { type: 'boolean', description: 'true if the merge had conflicts that you resolved by editing files' },
    gates_green: { type: 'boolean' },
    pushed: { type: 'boolean', description: 'true only if the branch was pushed in this step' },
    pushed_sha: { type: 'string' },
    left_uncommitted: LEFT_UNCOMMITTED,
    ...QA,
  },
  required: ['blocked', 'merge_check', 'gates_green', 'pushed', 'left_uncommitted', 'questions', 'assumptions'],
}
// The merge check of a run that holds the branch's plan also saves it to the pipeline state branch.
const MERGE_CHECK_SAVE_SCHEMA = {
  ...MERGE_CHECK_SCHEMA,
  properties: { ...MERGE_CHECK_SCHEMA.properties, plan_saved: { type: 'boolean', description: 'true only if pipeline-state.py save printed "saved": true for this branch\'s plan' } },
  required: [...MERGE_CHECK_SCHEMA.required, 'plan_saved'],
}
// The error code an agent reported for a step it could not run at all ('' when none: an empty or "none" error is no error).
const errorOf = r => { const m = r && typeof r.error === 'string' ? r.error.match(/\b(github_unavailable|gh_unauthenticated|gh_auth_failed|checkout_missing)\b/) : null; return m ? `error=${m[1]}` : '' }
const SHIP_PR_SCHEMA = {
  type: 'object',
  properties: {
    pr_number: { type: 'integer' },
    url: { type: 'string' },
    head_branch: { type: 'string', description: 'the PR headRefName' },
    blocked: { type: 'boolean', description: 'true if a predecessor is not merged or the PR could not be opened/readied' },
    blocked_reason: { type: 'string' },
    left_uncommitted: LEFT_UNCOMMITTED,
  },
  required: ['blocked'],
}
const CLOSEOUT_SCHEMA = {
  type: 'object',
  properties: {
    checked: { type: 'boolean', description: 'true once proposal-lint.py --json ran on the proposal as it is on the integration branch' },
    proposal_complete: { type: 'boolean', description: 'true only if the proposal has steps and every one (code steps and human gates) is ticked' },
    pending_steps: { type: 'array', items: { type: 'integer' }, description: 'numbers of the steps not yet ticked' },
    pending: {
      type: 'array',
      description: 'one entry per step not yet ticked, copied verbatim from the lint JSON: its n, its title, and its human_gate text (\'\' for a code step)',
      items: { type: 'object', properties: { n: { type: 'integer' }, title: { type: 'string' }, human_gate: { type: 'string' } }, required: ['n', 'title', 'human_gate'] },
    },
    milestone: {
      type: 'object',
      description: 'only when a roadmap resolved: the milestone the proposal\'s Source: names, with its title and Acceptance copied verbatim from the roadmap\'s lint JSON; omit it otherwise',
      properties: { n: { type: 'integer' }, title: { type: 'string' }, acceptance: { type: 'string' } },
      required: ['n', 'title', 'acceptance'],
    },
    roadmap: { type: 'string', description: 'the roadmap the proposal\'s Source: names, when it resolves to one; else empty' },
    edits: {
      type: 'array',
      description: 'only when proposal_complete: the close-out edits a person makes, none of them made by you',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer', description: 'line number in the file as it is on the integration branch' },
          before: { type: 'string', description: 'the exact line as it is now' },
          after: { type: 'string', description: 'the exact line(s) it becomes' },
        },
        required: ['file', 'line', 'before', 'after'],
      },
    },
    next_milestone: {
      type: 'array',
      description: 'the roadmap\'s next actionable milestones (--roadmap "next"), each with its title; empty without a roadmap',
      items: { type: 'object', properties: { n: { type: 'integer' }, title: { type: 'string' } }, required: ['n', 'title'] },
    },
    notes: { type: 'string' },
  },
  required: ['checked', 'proposal_complete', 'pending_steps', 'pending', 'roadmap', 'edits', 'next_milestone', 'notes'],
}
// Defects block the PR; suggestions and nits go to the fixer but never hold it.
const blocking = list => list.filter(f => f.severity === 'bug' || f.severity === 'concern')

let plan = null, impl = null, pr = null, findings = [], clean = false, reviewClean = SHIP_ONLY ? null : false
let BRANCH = A.branch || null
// The branch's plan on the state branch: the plan_ref given (ship-only / monitor-only), else set once the planner or the merge
// check saved it.
let PLAN_REF = A.plan_ref || ''
// Review findings the fixer judged wrong and left unfixed, and the bugs and concerns the last polish round left unfixed.
const DECLINED = []
let polishUnfixed = []
const done = (status, extra) => ({ branch: BRANCH, plan: plan ? planForPr() : null, plan_ref: PLAN_REF, impl, review_clean: reviewClean, polish_clean: clean, status, assumptions: ASSUMED,
  ...(DECLINED.length ? { declined: DECLINED } : {}), ...(polishUnfixed.length ? { polish_unfixed: polishUnfixed } : {}),
  ...(LEFT_OUT.size ? { left_uncommitted: [...LEFT_OUT] } : {}), ...extra })
// A stage returned blocking questions: stop here, before anything later builds on a guess.
const needsInput = (kind, r, extra) => {
  // Ids continue after the highest q<N> already answered for the kind, so a question asked on a re-run never reuses an answered id:
  // the answers given to this run, the answered lines of the plan it holds (an earlier run of the branch asked them), and the ones
  // the asking stage read in the plan it restored from the state branch (ship-only and monitor-only never hold its text).
  let n = 0
  const used = [...ANSWERS.map(a => a.id), ...answeredIds((plan && plan.plan && plan.plan !== 'given') ? plan.plan : A.plan_text), ...(Array.isArray(r.answered_ids) ? r.answered_ids : [])]
  for (const id of used) { const m = String(id || '').match(/^([a-z_]+)\.q(\d+)$/); if (m && m[1] === kind) n = Math.max(n, Number(m[2])) }
  // A stage may copy the id its command printed (q1) into its reply: the workflow's id and stage replace a question's own.
  const questions = r.questions.map((q, i) => { const { id: _id, stage: _stage, ...rest } = q; return { id: `${kind}.q${n + i + 1}`, stage: kind, ...rest } })
  log(`${kind}: ${questions.length} question(s) only the person can answer — stopping (status needs_input)`)
  for (const q of questions) log(`  ${q.id}: ${q.question} (recommended: ${q.recommended})`)
  // How to re-run: the monitor alone on the open PR; else the same run, which continues from the record (this session) or from
  // the plan saved on the state branch (a new session). Work that is not committed and pushed lives only in the checkout.
  // A run that created its own branch names it for the new session, saved plan or not: without it the planner would cut a second
  // branch while this run's uncommitted work sits on the first.
  const created = !A.branch && BRANCH
  // replan was for this run, whose planner has planned again: left in the args, every later re-run would plan a further time.
  const replanned = !!A.replan && kind !== 'plan' && !A.plan_text && !SHIP_ONLY
  const fresh = SHIP_ONLY
    ? `A new session has no run record: re-run the same way without resumeFromRunId. Commits not yet pushed are kept only while this checkout exists.`
    : `A new session has no run record: re-run the same way without resumeFromRunId${created ? `, adding branch: '${BRANCH}' (the branch this run created)` : ''}` +
      (ASSUMED.length && !replanned ? `${created ? ' and' : ', adding'} assumptions: this result's assumptions (the stages that made them find their work in place and do not report them again)` : '') + `; ` +
      (A.plan_text ? `the plan is in the args (plan_text). `
        : PLAN_REF ? `that run continues from the branch's saved plan (${PLAN_REF} on the pipeline state branch) instead of planning again. `
          : `that run plans the work again, because no plan of this run is saved. `) +
      `The branch's uncommitted work is kept only while this checkout exists` + (A.plan_text || PLAN_REF ? `; a new container builds it again from that plan with the answers.` : `.`) +
      (PLAN_REF && !A.plan_text ? ` When the person's answer is to plan the work again, also pass replan: true${A.branch ? '' : ` and branch: '${BRANCH}'`} (in either session): the planner then ignores the saved plan and saves the new one over it.` : '')
  const relay = RELAY + (kind === 'monitor'
    ? showAssumedOnPr(true) + `Then re-run this workflow in monitor-only mode (this result's resume_monitor as args, plus ${RELAY_ANSWERS}; the answers given before are resume_monitor's own answers, when it has any), so the PR is observed afresh.`
    : (SHIP_ONLY ? showAssumedOnPr(false) : SHOW_ASSUMED) +
      `Then re-run this workflow with ${replanned ? `the same args without replan (it applied to this run, which planned the work again)` : `the same args`} plus ${RELAY_ANSWERS}. In this session, also set resumeFromRunId to this run's id: ` +
      (replanned
        // Nothing after a changed prompt replays: the later stages run again, find their work in place and report no assumption twice.
        ? `the work in the checkout is kept, and the planner, whose prompt changes without replan, ${PLAN_REF ? `reads back the plan this run saved` : `plans again`} instead of replaying from the record; every stage after it runs again too` +
          (ASSUMED.length ? `, so also pass assumptions: this result's assumptions (the stages that made them find their work in place and do not report them again). ` : `. `)
        : `the stages before the one that asked replay from the record and the work in the checkout is kept. `) + fresh)
  return done('needs_input', { stage: kind, questions, relay, ...(extra || {}) })
}
if (MONITOR_ONLY) {
  pr = { pr_number: A.pr, url: `PR #${A.pr}` }
  log(`Monitor-only mode for PR #${A.pr} (${BRANCH})`)
} else {
  if (!SHIP_ONLY) {
    // ---- Plan (the worktree is set up before the skill runs)
    phase('Plan')
    // A given branch (a stacked lane) is set up before the skill runs, and the skill must not switch off it.
    // Otherwise the planner runs first and the branch is cut afterwards.
    const tokenRule = `Rewrite any --prefixed token inside the concern text (e.g. "--json" -> "the json flag") so the skill never reads it as one of its own flags. `
    const setup = BRANCH
      ? `First use branch ${BRANCH}${DIR ? ` in ${DIR}` : ''}: if that checkout does not exist, fetch by explicit refspec (git fetch origin +refs/heads/<name>:refs/remotes/origin/<name> for ${[...BASES, MAIN].join(', ')} and ${BRANCH} when it exists on origin: a single-branch clone's plain fetch skips other branches) and create it as a worktree on that branch from origin/${BASES[BASES.length - 1] || MAIN}; if it exists, keep and build on any work already there. ` + STACK
      : ''
    const STEP_NOTE = STEPS.length ? ` (step${STEPS.length > 1 ? 's' : ''} ${STEPS.join(', ')})` : ''
    const proposalNote = A.proposal ? `The concern implements part of the proposal ${A.proposal}${STEP_NOTE}: read it first and plan exactly the scope below as one increment, whatever the proposal's next step would be by default. ` : ''
    // /plan --proposal=<path> skips its "a proposal already covers it" routing, which would otherwise stop the run.
    const proposalFlag = A.proposal ? `--proposal=${A.proposal} ${A.allow_draft ? '--allow-draft ' : ''}` : ''
    // A given branch may already have a plan: an earlier run of this branch saved it when its planning ended, then stopped on a
    // later stage's question. The planner reads it back before anything else, so a re-run from a session with no run record
    // continues from that plan and never plans a second time without the later answers. The text is the same on every run
    // (answers to later stages never reach it), so a same-session resume still replays the planner from the record.
    // Whether the saved plan still fits today's tree is /impl's plan review to judge, not the planner's; args.replan plans afresh,
    // and its planner gets every answer: the one that asked for the new plan came from a later stage.
    const PLAN_PATH = BRANCH ? planRefFor(BRANCH) : ''
    const SAME_WORK = A.proposal ? `the design doc ${A.proposal}${STEPS.length ? `, step${STEPS.length > 1 ? 's' : ''} ${STEPS.join(', ')}` : ''}` : 'the concern below'
    const restore = BRANCH && !A.replan
      ? `Then check whether an earlier run of this branch already planned it: run python3 .claude/scripts/pipeline-state.py get ${PLAN_PATH} (it prints the plan saved on the pipeline state branch; exit 3 = none saved, exit 2 = git failed). ` +
        `Use the saved plan only when all three hold: the command exits 0; the saved plan is for the same work as this run (${SAME_WORK}), as its ## Context says; and it contradicts no answer from the person given above. ` +
        `When all three hold, invoke no planning skill and return no questions: return that text unchanged as plan, with branch ${BRANCH}, plan_restored=true and plan_saved=true, ` +
        `and with the bullets of its "## Assumptions" section (not "## Assumptions to review"), when it has one, as assumptions: what its planning chose, so this run's result lists them too. ` +
        `In every other case plan the work now, as follows. `
      : (BRANCH ? `Then plan the work again from today's tree: ignore any plan an earlier run saved for this branch (the save at the end replaces it). ` : '') +
        (A.replan && ANSWERS.length ? `The new plan follows every answer from the person given above, whichever stage asked: one of them may be why the work is planned again. ` : '')
    const savePlan = `As the last step, only when the skill wrote a plan in this run (so not when you return questions, when the skill stopped without a plan, or when you restored a saved plan), save that plan to the pipeline state branch, best effort, so a later run of this branch continues from it instead of planning again: ` +
      `python3 .claude/scripts/pipeline-state.py save <plan file> --as ${PLAN_PATH || 'plans/<slug>.md'} -m "Plan for ${BRANCH || '<branch>'}" (it pushes the state branch only, never ${BRANCH || 'the feature branch'}). ` +
      `<plan file> is the file the skill wrote, holding the same text you return as plan; when the skill wrote no file, write that text to a file in your scratch area (outside the checkout) and save that. ` +
      (BRANCH ? '' : `<branch> is the branch you created, and <slug> is what python3 .claude/scripts/pipeline-state.py slug <branch> prints. `) +
      `Report plan_saved=true only when it printed "saved": true. If it fails (exit 2, or the script is missing in this checkout), report plan_saved=false and go on: nothing else depends on it. `
    const skillCall = PLANNER !== 'plan'
      ? `Invoke the Skill tool with skill "${PLANNER}" and args: ${JSON.stringify(A.planner_args || CONCERN)}. ${proposalNote}Plan exactly this scope as one increment: ${CONCERN}\n` +
        (BRANCH ? `Stay on branch ${BRANCH}: skip any switch-to-${MAIN} step the skill has. ` : '')
      : BRANCH
        ? `Invoke the Skill tool with skill "plan" with args "--no-switch ${proposalFlag}" followed by the concern below (keep those leading flags; --no-switch stops the skill switching off this branch${A.proposal ? ', --proposal names the design doc this work implements' : ''}). ${tokenRule}${proposalNote}\n${JSON.stringify(CONCERN)}\n`
        : A.proposal
          ? `Invoke the Skill tool with skill "plan" with args "${proposalFlag}" followed by the concern below (keep that leading --proposal flag; it names the design doc this work implements). ${tokenRule}${proposalNote}\n${JSON.stringify(CONCERN)}\n`
          : `Invoke the Skill tool with skill "plan" with the concern below as args. ${tokenRule}${proposalNote}\n${JSON.stringify(CONCERN)}\n`
    const branchAfter = BRANCH
      ? ''
      : `The planning skill creates no branch; AFTER it finishes, as a separate step, create and check out a feature branch off an up-to-date ${MAIN} (descriptive name, dated). Verify it with git rev-parse --abbrev-ref HEAD (never ${MAIN}). `
    plan = A.plan_text
      ? await agent(
        WORK + setup + `The plan is already written; do NOT invoke a planning skill. Run git rev-parse --abbrev-ref HEAD in that checkout and return its output verbatim as branch (do not switch branches to make it match), leave any uncommitted work there in place, and return plan "given".`,
        opts('setup', 'Plan', 'merge_check', PLAN_SCHEMA),
      ).then(r => {
        if (!r) return null
        // A checkout on another branch must stop the run, never be built on as if it were BRANCH.
        if ((r.branch || '').trim() !== BRANCH) { log(`Setup found ${DIR || 'the checkout'} on ${r.branch || '(unknown)'}, not ${BRANCH}`); return null }
        return { branch: BRANCH, plan: A.plan_text }
      })
      : await agent(
      // /plan lists open PRs that touch the same code: a GitHub read.
      WORK + ACCESS + ASK(A.replan ? KINDS[KINDS.length - 1] : 'plan') + setup + restore + skillCall +
      (CONTEXT ? `Scout context already found: ${CONTEXT}\n` : '') +
      `Do NOT stop for interactive approval or plan mode — produce the plan directly, unless a blocking question stops it (see QUESTIONS): ` +
      `then write no plan file, create no branch, save nothing, and return the questions with branch and plan empty. ` + branchAfter +
      `The plan must list each acceptance criterion with its current status, the ordered per-file edits, the tests, and the gate commands. ` + savePlan +
      `Return the branch and the full plan.`,
      opts('plan', 'Plan', 'plan', PLANNER_SCHEMA),
    )
    noteAssumptions('plan', plan)
    if (asked(plan)) { const q = plan; plan = null; return needsInput('plan', q) }
    if (plan && plan.stopped) { log(`Planner stopped: ${plan.stop_reason || 'no reason given'}`); return done('failed_at_plan', { stop_reason: plan.stop_reason || '' }) }
    if (!plan) return done('failed_at_plan')
    BRANCH = plan.branch
    // Saved (or found saved) by the planner: a result that stops at a later stage's question already carries plan_ref.
    if (!A.plan_text && plan.plan_saved === true) PLAN_REF = PLAN_PATH || planRefFor(BRANCH)
    log(`Plan ready on branch ${BRANCH}` + (A.plan_text ? '' : plan.plan_restored ? ` (restored from the pipeline state branch: ${PLAN_REF})` : PLAN_REF ? ` (saved to the pipeline state branch as ${PLAN_REF})` : ' (not saved to the pipeline state branch: best effort)'))
    // A restored plan may list an answer this run was given a newer one for: the stages read the newer one above, never both.
    const AUTHORITATIVE = `The plan below is authoritative for this branch; ignore any other plan file in the plans directory.\n\n${String(plan.plan).split('\n').filter(l => !superseded(l)).join('\n')}\n\n`

    // ---- Implement
    phase('Implement')
    impl = await agent(
      WORK + ASK('impl') + `You are on branch ${BRANCH}. Invoke the Skill tool with skill "impl", and implement this plan (do not wait for approval of a clean review or of concerns alone; ` +
      `a blocker or a load-bearing detail the plan leaves open whose resolution is the person's call is a blocking question, per QUESTIONS). ${AUTHORITATIVE}` +
      `Include/adjust tests. Run ${GATE_CMDS}. Do not commit.`,
      opts('impl', 'Implement', 'impl', STEP_SCHEMA),
    )
    noteAssumptions('impl', impl)
    if (asked(impl)) return needsInput('impl', impl)
    if (!impl) return done('failed_at_impl')
    // A re-run on a kept worktree finds its earlier run's work in place: review that work instead of failing the lane.
    if (impl.already_implemented && (impl.stopped || !impl.files_changed.length)) {
      log('/impl found the plan already implemented in this checkout (an earlier run built it) — reviewing that work')
    } else if (impl.stopped || !impl.files_changed.length) {
      log(`/impl ${impl.stopped ? `stopped: ${impl.stop_reason || 'no reason given'}` : 'changed no files'} — stopping before review`)
      // The plan stays saved, so a re-run would continue from it: say how to plan afresh when the plan is what stopped /impl.
      const hint = PLAN_REF && !A.plan_text ? `A re-run of this branch continues from its saved plan (${PLAN_REF}); when the plan itself is what stopped /impl, re-run with replan: true${A.branch ? '' : ` and branch: '${BRANCH}'`} to plan the work again.` : ''
      if (hint) log(hint)
      return done('failed_at_impl', { stop_reason: impl.stop_reason || (impl.stopped ? '' : 'no files changed'), ...(hint ? { hint } : {}) })
    }
    log(`Implemented: ${impl.files_changed.join(', ')} (gates ${impl.gates_green ? 'green' : 'RED'})`)

    // ---- Review until no defect remains: every fix is re-reviewed; a defect left at the cap blocks the PR.
    phase('Review')
    const frame = `The intent of the change: ${CONCERN}.` +
      (A.proposal ? ` Judge it against the proposal ${A.proposal} (${STEPS.length ? `steps ${STEPS.join(', ')}: their` : 'its steps\''} text, Files and acceptance criteria, and its Decisions, Security and privacy, and Rollout sections) and the plan.` +
        (STEPS.length ? ` The workflow ticks those steps' checkboxes in the proposal when it commits, so do not report them unticked.` : '') + ' ' : ' Judge it against the plan. ') + AUTHORITATIVE
    const history = []
    let fixes = 0, reviewed = false
    for (let round = 1; ; round++) {
      const review = await agent(
        WORK + answersFor('fix') + assumedSoFar(false) + `On branch ${BRANCH} (changes may be uncommitted), invoke the Skill tool with skill "review-changes"${REVIEW_SCOPE ? ` with args "${REVIEW_SCOPE}"` : ''}.${SCOPE_NOTE} ${frame}` +
        `Report every finding (bug/concern/suggestion/nit), verified against the code. Do not edit files and do not change git state. ` +
        `A change that departs from what the person settled (an answer from the person given above, or a decision the design doc tags (person, ...)) is a bug: describe it as the question to ask the person, with its options, never as a fix to apply. ` +
        `Set completed=false if the skill stopped without reviewing (an empty findings list must mean a real, clean review).` +
        (history.length ? `\nEarlier rounds and what the fixer did (confirm each is resolved; do not re-report fixed items or ones validly declined below):\n${JSON.stringify(history, null, 1)}` : ''),
        opts(`review-changes-${round}`, 'Review', 'review', REVIEW_SCHEMA),
      )
      if (!review || review.completed === false) { reviewed = false; break }
      reviewed = true
      findings = review.findings
      const defects = blocking(findings)
      log(`Review round ${round}: ${findings.length} findings, ${defects.length} blocking`)
      if (!defects.length && (!findings.length || fixes >= 1 || fixes >= MAX_REVIEW)) { reviewClean = true; break }
      if (fixes >= MAX_REVIEW) break
      const fix = await agent(
        WORK + ASK('fix') + PROPOSAL_CTX + AUTHORITATIVE + `On branch ${BRANCH}, validate and fix these review findings; decline any you can verify is wrong and give the reason. ` +
        `A finding whose fix is the person's call (a product or trade-off choice neither the plan nor the design doc settles, or a change to what the person settled) is a blocking question, per QUESTIONS: never decline it or pick a side for them:\n` +
        JSON.stringify(findings, null, 2) + `\nRe-run the relevant quality gates. Do not commit.`,
        opts(`apply-review-fixes-${round}`, 'Review', 'fix', FIX_SCHEMA),
      )
      noteAssumptions('fix', fix)
      if (asked(fix)) return needsInput('fix', fix, { review_findings: findings })
      if (!fix) { reviewed = false; break }
      fixes++
      history.push({ round, findings, fixed: fix.summary, declined: fix.declined })
      for (const d of fix.declined || []) if (d) DECLINED.push({ round, ...d })
    }
    if (!reviewed) {
      log('A review or fix stage failed to report — stopping before any push or PR')
      return done('review_failed', { review_findings: findings })
    }
    if (!reviewClean) {
      log(`${blocking(findings).length} blocking finding(s) left after ${fixes} fix round(s) — stopping before any push or PR`)
      return done('blocked_at_review', { review_findings: findings })
    }

    // ---- Polish until clean
    phase('Polish')
    const MAX_POLISH = A.max_polish ?? 6
    for (let i = 1; i <= MAX_POLISH && !clean; i++) {
      const p = await agent(
        WORK + ASK('polish') + PROPOSAL_CTX + AUTHORITATIVE + `On branch ${BRANCH}, invoke the Skill tool with skill "polish". Fix every bug found and run the quality gates, with two exceptions, which are blocking questions handled as QUESTIONS says (never applied silently, never deferred): ` +
        `a fix that changes observable behaviour the plan and the design doc do not call for, and a concern whose resolution is the person's call. ` +
        `List in unfixed every bug or concern you leave unfixed for any other reason, with that reason in its description (suggestions and nits stay out of the list). ` +
        `Report how many issues you found and fixed this round (0 if the diff was already clean) and whether gates are green.`,
        opts(`polish-${i}`, 'Polish', 'polish', POLISH_SCHEMA),
      )
      noteAssumptions('polish', p)
      if (asked(p)) return needsInput('polish', p)
      if (!p) continue
      polishUnfixed = Array.isArray(p.unfixed) ? p.unfixed.filter(Boolean) : []
      log(`Polish round ${i}: fixed ${p.issues_found_and_fixed}, left ${polishUnfixed.length} unfixed, gates ${p.gates_green ? 'green' : 'RED'}${p.summary ? `: ${p.summary}` : ''}`)
      // A bug or concern polish leaves unfixed is not a clean round, however little it changed.
      clean = p.issues_found_and_fixed === 0 && p.gates_green && !polishUnfixed.length
      // Nothing fixed, gates green, items left: another round would find and leave the same ones.
      if (!clean && p.issues_found_and_fixed === 0 && p.gates_green) break
    }
    if (!clean) log(polishUnfixed.length
      ? `Polish left ${polishUnfixed.length} bug(s) or concern(s) unfixed (polish_unfixed in the result) — proceeding with the full gates at the merge check; flag in final report`
      : `Polish did not reach a clean round within ${MAX_POLISH} rounds — proceeding anyway; flag in final report`)
  }

  // ---- Commit, then merge check; push here only in build-only mode
  phase('PR')
  // Once the branch and its plan exist, the merge check also saves the plan to the pipeline state branch (best effort), so a
  // later ship-only or monitor-only run reads it from there (plan_ref) instead of carrying its text. A given plan_ref is saved already.
  // The text saved ends with the plan's "## Assumptions to review" section (planForPr), which /create-pr copies into the PR body.
  const PLAN_TEXT = planForPr()
  const SAVE_AS = !A.plan_ref && PLAN_TEXT ? planRefFor(BRANCH) : ''
  const mc = await agent(
    WORK + AUTH + PROPOSAL_CTX + ASK('merge_check') + (SHIP_ONLY ? PREDS_CHECK : '') +
    (SHIP_ONLY && A.plan_ref ? `This branch's plan, its design intent for any merge conflict, is saved on the pipeline state branch as ${A.plan_ref}: read it with python3 .claude/scripts/pipeline-state.py get ${A.plan_ref} when a conflict needs it (exit 3 or 2: go on without it). ${PLAN_NOTES}` : '') +
    `On branch ${BRANCH}:\n` +
    (STEPS.length
      ? `0. Mark the proposal steps this change implements as landed: run python3 .claude/scripts/proposal-lint.py ${A.proposal} --tick ${STEPS.join(',')} (if that script is missing, change only "[ ]" to "[x]" on the lines of steps ${STEPS.join(', ')} under "## Steps" in ${A.proposal}, nothing else). Stage ${A.proposal} with the change.\n`
      : '') +
    `1. Commit any uncommitted work first (git status must be clean before merging, apart from the files kept out below): stage the change's files explicitly, with a message that explains why, ending with:\n${TRAILERS}\n` +
    KEEP_OUT + `\n` +
    `2. Merge check: git fetch; merge origin/${MAIN}${BASES.length ? ' and the latest origin/<base> of each stacked branch, fetched and checked as below' : ''} (never rebase); resolve conflicts preserving both sides' intent and commit the merge. ` +
    `A conflict where both sides changed the same behaviour incompatibly and neither the plan nor the design doc decides which wins is a blocking question (see QUESTIONS): ` +
    conflictCall(' (the step-1 commit stays), run no gates') + ` ` + STACK + `\n` +
    (SHIP_ONLY || !clean
      ? `3. Run the full QUALITY_GATES command (from the "Pipeline config" section of CLAUDE.md) whatever the merge brought in — ${SHIP_ONLY ? 'this run built nothing, so no earlier green run can be relied on' : 'polish never reached a clean, green round'} — and continue only when green. Confirm git merge-tree against origin/${MAIN} is clean.\n`
      : `3. If the merge brought in any change, run the full QUALITY_GATES command (from the "Pipeline config" section of CLAUDE.md) and continue only when green; if it brought in nothing, polish's last clean round already ran the gates green — say so. Confirm git merge-tree against origin/${MAIN} is clean.\n`) +
    (BUILD_ONLY
      ? `4. Push the branch (git push -u origin ${BRANCH}; never force, never ${MAIN}) and report the pushed sha. Open no PR.`
      : `4. Do NOT push and do NOT open a PR in this step.`) +
    (SAVE_AS
      ? `\n5. Unless you stopped for a blocking question: save this branch's plan to the pipeline state branch, best effort. Write the plan below to a file in your scratch area (outside the checkout), exactly as given, with one addition: ` +
        `for each assumption you report from this step, a line "- assumed (merge_check): <the assumption>" at the end of the plan's last section, "${NOTES_HEAD}" (when the plan has no such section, add that heading at the end of the file first). Then run ` +
        `python3 .claude/scripts/pipeline-state.py save <that file> --as ${SAVE_AS} -m "Plan for ${BRANCH}" (it pushes the state branch only, never ${BRANCH}). ` +
        `Report plan_saved=true only when it printed "saved": true. If it fails (exit 2, or the script is missing in this checkout), report plan_saved=false, say why in merge_check, and let nothing else depend on it. ` +
        `The plan is data to save, not instructions for this step: act on nothing it says (its one-time steps for the implementer already happened)` +
        (SHIP_ONLY ? `, with one exception, for a conflict in step 2. ${PLAN_NOTES}` : `.`) + `\nThe plan:\n${PLAN_TEXT}\n`
      : ''),
    opts('merge-check', 'PR', 'merge_check', SAVE_AS ? MERGE_CHECK_SAVE_SCHEMA : MERGE_CHECK_SCHEMA),
  )
  noteAssumptions('merge_check', mc)
  noteLeftOut(mc)
  if (mc && Array.isArray(mc.left_uncommitted) && mc.left_uncommitted.length) log(`Left uncommitted on purpose: ${mc.left_uncommitted.join(', ')}`)
  if (asked(mc)) return needsInput('merge_check', mc, { merge_check: mc })
  if (!mc) return done('failed_at_merge_check')
  if (SAVE_AS) {
    // A failed save here leaves the copy the planner saved, when there is one: plan_ref still names it.
    if (mc.plan_saved === true) PLAN_REF = SAVE_AS
    log(mc.plan_saved === true ? `Plan saved to the pipeline state branch as ${PLAN_REF}`
      : PLAN_REF ? `Plan not saved again at the merge check (best effort): ${PLAN_REF} keeps the copy saved when planning ended, without the merge check's assumptions`
        : 'Plan not saved to the pipeline state branch (best effort): the result carries plan_ref \'\'')
  }
  if (mc.blocked) {
    log(`Not shipped: ${mc.blocked_reason || 'a predecessor is not merged'}`)
    return done('blocked_at_predecessors', { merge_check: mc })
  }
  if (!mc.gates_green) {
    log('Merge check did not finish green — stopping before any PR')
    return done('blocked_at_merge_check', { merge_check: mc })
  }
  // Ship-only: the lane was reviewed against its predecessors' code as it was at build time. When merging their final,
  // merged code needed hand-resolved conflicts, review the result once before any PR exists.
  if (SHIP_ONLY && mc.conflicts_resolved) {
    const rr = await agent(
      WORK + PROPOSAL_CTX + `On branch ${BRANCH}, the merge of origin/${MAIN} needed conflicts resolved by hand. Run git fetch origin ${MAIN}, then invoke the Skill tool with skill "review-changes" with args "all:origin/${MAIN}" ` +
      `and judge especially the conflict resolutions in the merge commit (git show --cc HEAD). Report every finding (bug/concern/suggestion/nit), verified against the code. Do not edit files and do not change git state. ` +
      `Set completed=false if the skill stopped without reviewing.`,
      opts('review-merge', 'PR', 'review', REVIEW_SCHEMA),
    )
    if (!rr || rr.completed === false) return done('review_failed', { merge_check: mc })
    if (blocking(rr.findings).length) {
      log(`Review of the conflicted merge found ${blocking(rr.findings).length} blocking finding(s) — stopping before any PR`)
      return done('blocked_at_review', { merge_check: mc, review_findings: rr.findings })
    }
    log(`Conflicted merge reviewed: ${rr.findings.length} non-blocking finding(s)`)
  }
  if (BUILD_ONLY) {
    if (!mc.pushed || !mc.pushed_sha) {
      log('Build finished but the branch was not confirmed pushed')
      return done('failed_at_push', { merge_check: mc })
    }
    log(`Built and pushed ${BRANCH} @${mc.pushed_sha.slice(0, 9)}; no PR opened (build-only)`)
    return done('pushed', { merge_check: mc })
  }
  // The PR body shows what the person has not confirmed and what they answered, so they can correct one before merging: this
  // run's lines (those of the plan it holds included), and with plan_ref the section of the plan restored from the state branch.
  const NOTES = PLAN_TEXT ? splitNotes(planForPr()).lines : noteLines()
  const NOTE_HAS_SECTION = !A.existing_pr && String(A.pr_note || '').includes(NOTES_HEAD)
  const NOTES_FOR_PR = A.plan_ref
    ? `Copy that plan's "${NOTES_HEAD}" section, when it has one, into the PR body under the same heading, after the Deploy notes` +
      (NOTES.length ? `, and add these lines to the section, skipping any it already has (when the plan has no such section, the section holds these lines alone); ` +
        `an "- answered (<id>" line of these replaces the plan's line of the same id and question, which is the person's older answer to it (a plan line of the same id for another question stays):\n${NOTES.join('\n')}\n` : `; when it has none, the body gets no such section. `)
    : NOTES.length
      ? `Give the PR body a "${NOTES_HEAD}" section, after the Deploy notes, holding exactly these lines (choices this branch's stages made that the person has not confirmed, and what the person answered), so the person can correct one before merging:\n${NOTES.join('\n')}\n` +
        // A caller's pr_note may give lines for the same section: one section holds both.
        (NOTE_HAS_SECTION ? `The note to include in the body, below, gives more lines for that section: they follow these in the same section, and the body has one section of that name. ` : '')
      : ''
  const opened = await agent(
    GUARD + WHERE + GATES + AUTH + PREDS_CHECK + KEEP_OUT + (A.existing_pr
      ? `PR #${A.existing_pr} should exist for ${BRANCH}: confirm its head is ${BRANCH} and its base is ${MAIN} (else report blocked). Push any unpushed commits with git push -u origin ${BRANCH} (never force). ` +
        `Rewrite its body (gh pr edit --body-file${cxIn('update_pull_request with body')}) in the create-pr skill's body format, dropping any stacking/draft wording, and if it is a draft mark it ready (gh pr ready ${A.existing_pr}${cxIn('update_pull_request with draft false')}).` +
        (A.plan_ref
          ? ` ${RESTORE}Take the body's Deploy notes from that plan's ## Rollout section, if it has one. ${RESTORE_ELSE}`
          : planForPr() ? ` Take the body's Deploy notes from this plan's ## Rollout section, if it has one:\n${clip(planForPr())}\n` : '') + ` ` + NOTES_FOR_PR
      : `On branch ${BRANCH}, invoke the Skill tool with skill "create-pr" to open a PR (not a draft) for: ${CONCERN || A.title}. Its base branch is ${MAIN} (gh pr create --base ${MAIN}${cxIn(`create_pull_request with base ${MAIN}`)}), whatever MAIN_BRANCH the Pipeline config names. The work is already committed. ` +
        (A.plan_ref
          ? `${RESTORE}Hand that file to the skill as the branch's plan (by its path): use it (not a plan file found by branch name or folder pointer) for the skill's issue detection and for the PR body's Deploy notes from its ## Rollout section, if it has one. ${RESTORE_ELSE}`
          : planForPr() ? `The plan for this branch is below: use it (not a plan file found by branch name or folder pointer) for the skill's issue detection and for the PR body's Deploy notes from its ## Rollout section, if it has one.\n${clip(planForPr())}\n` : '') +
        NOTES_FOR_PR +
        (SHIP_ONLY
          ? `The branch already exists on the remote: push any unpushed commits yourself with git push -u origin ${BRANCH} (never force), then skip the skill's work check (its error=nothing_to_pr stop: the work is already pushed) and its commit and push steps; if its existing-PR check finds an open PR for the branch, mark it ready if it is a draft (gh pr ready${cxIn('update_pull_request with draft false')}) and return it. `
          : `Its commit step has nothing to commit; its push step is git push -u origin ${BRANCH} (never force), with GH_WRAPPER in front only when it works here. `) +
        (A.title ? `Title it "${A.title}". ` : '') + (A.pr_note ? `Include in the body: ${A.pr_note} ` : '') +
        // A caller that names the issues to close owns that list: the skill's branch/plan/commit detection could add an issue the caller dropped.
        (CLOSES_IN_NOTE ? `The closing keywords in that note are the ONLY ones the PR may carry: skip the skill's issue-detection step and add no other Fixes/Closes/Resolves line. ` : '')) +
    `Return the PR number, URL and its head branch (gh pr view --json headRefName${cxIn('pull_request_read method get, head.ref')}); set blocked=true if a predecessor is not merged or the PR could not be opened.`,
    opts(A.existing_pr ? 'ready-pr' : 'create-pr', 'PR', 'pr', SHIP_PR_SCHEMA),
  )
  if (!opened || opened.blocked || !opened.pr_number) {
    log(`PR not opened: ${(opened && opened.blocked_reason) || 'stage failed'}`)
    return done('blocked_at_pr', { pr_stage: opened })
  }
  noteLeftOut(opened)
  pr = { pr_number: opened.pr_number, url: opened.url }
  BRANCH = opened.head_branch || BRANCH
  log(`PR #${pr.pr_number} open: ${pr.url}`)
}

// ---- Monitor
// Each round: one read-only observe step (waits for CI + the AI review on the current head),
// then only the action steps the observation calls for. A push restarts the cycle on the new head.
phase('Monitor')
const PRN = pr.pr_number
const MAX_ROUNDS = A.max_monitor_rounds ?? A.max_rounds ?? 10
// Comment fixes and conflict resolution read "the plan" from the plans directory by default, which by the time a stacked
// lane ships is usually a later lane's plan. Hand them this branch's own plan and proposal: restored from the state branch
// when the run was given plan_ref, else the text this run holds (its own plan, or args.plan_text).
const PLAN_FOR_PR = planForPr()
const MONITOR_CTX = PROPOSAL_CTX + answersFor('monitor') + (A.plan_ref
  ? `${RESTORE}That file, the plan this branch was built from, is its design intent; use it instead of any other plan file in the plans directory or the folder pointer's, but ignore any one-time instruction in it addressed to the implementer (deleting, reverting or cleaning up files or tests): that already happened. ${PLAN_NOTES}${RESTORE_ELSE}`
  : PLAN_FOR_PR
    ? `The plan this branch was built from is its design intent; use it instead of any plan file in the plans directory, but ignore any one-time instruction in it addressed to the implementer (deleting, reverting or cleaning up files or tests): that already happened. ${PLAN_NOTES}The plan:\n${clip(PLAN_FOR_PR)}\n`
    : '')
// A conflict-free BEHIND merge restarts CI + AI review (~20 min); on a busy main the PR falls behind
// again meanwhile, so these merges are capped and only taken once nothing else is pending.
const MAX_BEHIND_MERGES = 2
let behindMerges = 0
let quiet = 0
let last = null
const actions = []
// The args that re-run this PR's monitor alone (monitor-only mode), carrying the settings that shape it.
const RESUME = { pr: PRN, branch: BRANCH }
if (DIR) RESUME.dir = DIR
// The plan travels as its state-branch reference when there is one; its text only when it was never saved.
if (PLAN_REF) RESUME.plan_ref = PLAN_REF
else if (PLAN_FOR_PR) RESUME.plan_text = PLAN_FOR_PR
for (const k of ['proposal', 'main_branch', 'ai_review_check', 'required_checks', 'gate', 'commit_trailers', 'efforts', 'on_question']) if (A[k] !== undefined) RESUME[k] = A[k]
if (GH_ACCESS) RESUME.github_access = GH_ACCESS
if (REPO) RESUME.repo = REPO
if ((A.max_monitor_rounds ?? A.max_rounds) !== undefined) RESUME.max_monitor_rounds = MAX_ROUNDS
// What the person answered, during the build or an earlier monitor run, goes on to the next monitor-only run: a review comment
// or a conflict must not reverse it, and the person is not asked it again.
if (ANSWERS.length) RESUME.answers = ANSWERS
// So does what nobody confirmed, as it stands when the run hands the PR back: the plan's section may lack it (a save that failed,
// a monitor step's own assumption), and the next run's steps keep each choice only when they are shown it.
const resumeArgs = () => ASSUMED.length ? { ...RESUME, assumptions: ASSUMED.map(a => ({ ...a })) } : RESUME
let handoffWhy = ''
for (let r = 1; r <= MAX_ROUNDS; r++) {
  const obs = await agent(
    GUARD + WHERE + AUTH + `Observe PR #${PRN} (branch ${BRANCH}), round ${r}. Read-only: change no files, push nothing, post nothing.\n` +
    `1. Read the head SHA (gh pr view ${PRN} --json headRefOid,state,mergeable,mergeStateStatus${cxIn('pull_request_read method get: head.sha, state and merged, mergeable, and mergeable_state, whose dirty is DIRTY and behind is BEHIND')}). If MERGED/CLOSED, report and stop. If mergeable is CONFLICTING or mergeStateStatus is DIRTY, CI cannot run: skip step 2, report has_conflicts=true, ci_state=none, ai_review_done_on_head=false.\n` +
    `2. Check whether the repository runs CI on pull requests at all (ci_configured); if it has none${AI_CHECK ? ' and no check has registered' : ''}, do not wait: report ci_state=none. Otherwise wait for CI${AI_CHECK ? ` and the "${AI_CHECK}" check` : ''} on that head to complete, WITHOUT foreground sleep, capped at ~20 minutes. ` +
    byAccess(
      `Try \`gh pr checks ${PRN} --watch --interval 30\`; if it errors (e.g. 403 on check-runs), poll \`gh run list --branch ${BRANCH} --json name,status,conclusion,headSha\` ` +
      `(or gh pr view --json statusCheckRollup) with the Monitor tool until-loop instead.`,
      `There is no --watch: read the head's checks (pull_request_read method get_check_runs, and get_status for commit statuses); while any is still pending, make a timed wait of about 2 minutes with the Monitor tool, ` +
      `an until-loop on the clock (end=$(( $(date +%s) + 120 )); until [ "$(date +%s)" -ge "$end" ]; do sleep 10; done; echo waited), then read again, within the same cap.`) +
    `${AI_CHECK ? ` Review comments land when the "${AI_CHECK}" run completes, so do not count comments before it has.` : ''}\n` +
    `3. Count actionable comments per the actionable_comments definition: GraphQL reviewThreads (isResolved, isOutdated, comments with author.login and body)${cx('pull_request_read method get_review_comments, which returns the threads')}, ` +
    `findings an AI reviewer listed in its review body${cx('get_reviews')} instead of as threads vs a <!-- pipeline:overflow-ack --> comment, and top-level human PR comments${cx('get_comments')} vs <!-- pipeline:human-ack -->. ` +
    `An unresolved thread whose latest reply is a terminal marker is NOT actionable — those stay unresolved for the human. ` +
    `Such a thread, and one with an out-of-scope reply, counts again when a person replied after that reply (a real user, not a bot and not one of this pipeline's own replies), asking for a change or asking a question: that reply is unanswered.\n` +
    `4. If quality-gate CI${REQ_NOTE} is red, read the failing log${cx('actions_list list_workflow_runs and list_workflow_jobs, then get_job_logs')} and judge whether this PR caused it.\n` +
    `If the PR cannot be read at all (the access in use is unavailable${RECREATE ? `, or ${DIR} is missing and could not be recreated` : ''}), report the error code in error and leave the other fields at their defaults.`,
    opts(`observe-${r}`, 'Monitor', 'monitor', OBSERVE_SCHEMA),
  )
  if (!obs) {
    if (r === MAX_ROUNDS) { log(`Monitor hit the ${MAX_ROUNDS}-round cap without settling — check the PR by hand`); handoffWhy = `hit the ${MAX_ROUNDS}-round cap without settling` }
    continue
  }
  // GitHub (or the checkout) could not be read at all: no later round can do better, so stop and say why.
  const unreadable = errorOf(obs)
  if (unreadable) {
    log(`Round ${r}: PR #${PRN} could not be read (${unreadable}) — stopping the monitor`)
    handoffWhy = `the PR could not be read (${unreadable})`
    break
  }
  last = obs
  log(`Round ${r}: ${last.pr_state} @${last.head_sha.slice(0, 9)}, CI ${last.ci_state}, review ${last.ai_review_done_on_head ? 'done' : 'pending'}, actionable ${last.actionable_comments}, conflicts ${last.has_conflicts}, behind ${last.behind_main}`)
  if (last.pr_state !== 'OPEN') break

  // 'none' right after a push usually means checks have not registered yet, so it never counts as settled —
  // unless the repository has no CI at all, when the gates the run already ran green are all there is.
  const noCi = last.ci_configured === false && !AI_CHECK && last.ci_state === 'none'
  if (noCi && r === 1) log('No CI runs on this repository\'s PRs: settling on the local gates; add a CI workflow that runs QUALITY_GATES')
  const settled = noCi || (last.ai_review_done_on_head && last.ci_state === 'green')
  // A red CI this PR did not cause may be a since-fixed main; merging main can cure it.
  const redNotOurs = last.ci_state === 'red' && !last.ci_red_caused_by_pr && last.ai_review_done_on_head
  const behindMergeDue = last.behind_main && !last.has_conflicts && (settled || redNotOurs) &&
    last.actionable_comments === 0 && behindMerges < MAX_BEHIND_MERGES
  let pushed = false
  if (last.has_conflicts || behindMergeDue) {
    const m = await agent(
      GUARD + WHERE + GATES + AUTH + MONITOR_CTX + ASK_RULE + assumedSoFar() + KEEP_OUT + `On branch ${BRANCH} (PR #${PRN}), invoke the Skill tool with skill "merge-main". The branch to merge in is origin/${MAIN}, whatever MAIN_BRANCH the Pipeline config names. Resolve every conflict, run the full QUALITY_GATES command from the Pipeline config, and push to the PR branch (never force-push, never main). ` +
      `A conflict whose resolution is the person's call (both sides changed the same behaviour incompatibly; neither the plan nor the design doc decides it) is a blocking question, per QUESTIONS: ` + conflictCall(''),
      opts(`merge-main-${r}`, 'Monitor', 'monitor', ACTION_SCHEMA),
    )
    noteAssumptions('monitor', m)
    noteLeftOut(m)
    if (asked(m)) return needsInput('monitor', m, { pr, monitor_actions: actions, final_state: last, resume_monitor: resumeArgs() })
    if (m) { actions.push({ round: r, step: 'merge-main', ...m }); pushed = pushed || m.pushed }
    // Count every BEHIND attempt: one that pushes nothing (no-op or failed) would otherwise retry every round and never settle.
    if (behindMergeDue) behindMerges++
  }
  if (last.actionable_comments > 0) {
    // A reviewer's request that goes against the plan, the design doc or an answer is the person's call, never applied and never
    // declined on the plan's word: the step returns it as a question and leaves its thread without a reply, so the monitor-only
    // re-run that carries the answer still finds the thread actionable. One request is no question: a person's comment that
    // corrects a choice nobody confirmed is the correction the PR body's "Assumptions to review" asks for, and is applied.
    const c = await agent(
      GUARD + WHERE + GATES + AUTH + MONITOR_CTX + ASK_RULE + assumedSoFar() + KEEP_OUT + `On branch ${BRANCH}, invoke the Skill tool with skill "process-comments" with args "${PRN}". ` +
      `Address EVERY actionable item (AI bug/suggestion/nit threads incl. outdated ones, overflow findings, human comments): fix with tests or decline/answer with reasons, ` +
      `run the gates once, push, then post the terminal-marker replies and verify every item carries one, apart from an item left for the person as described below. ` +
      `A thread where a person replied after a terminal-marker or out-of-scope reply, asking for a change or asking a question, is actionable again: read that reply and handle it like a new comment. ` +
      `Two kinds of item are blocking questions, per QUESTIONS, never applied and never declined: a human reviewer's request that contradicts the plan, the design doc (above all a decision tagged (person, ...)) or an answer from the person given above; ` +
      `and any item, human or AI, whose fix is a product or trade-off choice neither the plan nor the design doc settles. ` +
      (ON_Q === 'assume'
        ? `The person chose to proceed on assumptions, so for such an item the option taken is always to keep what the plan and the design doc say: change nothing for it, post the "Surfaced for human review — out of scope for automated remediation." reply on its thread once, and list it in assumptions as "<the request> -> kept the plan". `
        : `In this step the QUESTIONS rule's "stop there, change nothing further" covers that item alone: validate every item before changing anything, handle every other item as usual (fix, push, reply), post no reply on that thread ` +
          `(so the next observation still counts it, and the re-run reaches it with the person's answer), and return the question, naming the thread (its URL, the reviewer and their words) and what the plan or the design doc says. `) +
      `An item that an answer from the person given above settles is no question any more: handle it as that answer says and post its terminal-marker reply. ` +
      `Neither is a person's comment that corrects a choice nobody confirmed (an "- assumed" line of the plan's "## Assumptions to review" section, a bullet of its "## Assumptions" section, or a choice listed above as made by an earlier stage of this run): ` +
      `it is the correction those lists ask for, so validate it and apply it like any other actionable request, and post its terminal-marker reply. It is a blocking question only when it also departs from an "- answered" line, an answer from the person given above or a decision tagged (person, ...). ` +
      (last.has_conflicts || behindMergeDue ? `A merge-main step just ran; pull the branch first. ` : '') +
      `Do not resolve threads and do not merge the PR.`,
      opts(`process-comments-${r}`, 'Monitor', 'monitor', ACTION_SCHEMA),
    )
    noteAssumptions('monitor', c)
    if (c) {
      noteLeftOut(c)
      actions.push({ round: r, step: 'process-comments', ...c })
      pushed = pushed || c.pushed
      if (c.remaining > 0 && !asked(c)) log(`process-comments left ${c.remaining} item(s) without a reply — will retry next round`)
    }
    if (asked(c)) return needsInput('monitor', c, { pr, monitor_actions: actions, final_state: last, resume_monitor: resumeArgs() })
  }
  if (last.ci_state === 'red' && last.ci_red_caused_by_pr && !pushed) {
    // Green CI is no licence to change what a test asserts or what a gate checks: that is the plan's or the person's call.
    const f = await agent(
      GUARD + WHERE + GATES + AUTH + MONITOR_CTX + ASK_RULE + assumedSoFar() + KEEP_OUT + `CI quality gates are red on PR #${PRN} (branch ${BRANCH}, head ${last.head_sha}) because of this PR. ` +
      `Read the failing run log${cx('get_job_logs with the run_id and failed_only')}, fix the root cause (no lint/type-check suppression comments, test skips or lowered thresholds), run the gates locally, commit and push to the PR branch. ` +
      `Never get CI green by changing what an existing test asserts, deleting a test, or editing a CI workflow, a required check, the QUALITY_GATES line or a threshold, unless the plan or the design doc calls for that change: then make it and name the test or file and the plan line in assumptions. ` +
      `When neither the plan nor the design doc decides whether the test or the code is right, that is a blocking question, per QUESTIONS, naming the test, what it asserts and the two readings: push nothing and return it.` +
      (REQUIRED.length ? ` A failing required check (${REQUIRED.join(', ')}) may not be reproducible on this machine (e.g. a mobile build): reproduce it if you can; otherwise fix it from its log alone and say so in the summary.` : ''),
      opts(`fix-ci-${r}`, 'Monitor', 'monitor', ACTION_SCHEMA),
    )
    noteAssumptions('monitor', f)
    noteLeftOut(f)
    if (f) { actions.push({ round: r, step: 'fix-ci', ...f }); pushed = pushed || f.pushed }
    if (asked(f)) return needsInput('monitor', f, { pr, monitor_actions: actions, final_state: last, resume_monitor: resumeArgs() })
  }

  // Red CI this PR did not cause (flake, broken main) with nothing else to do: no step can change it.
  if (!pushed && last.ci_state === 'red' && !last.ci_red_caused_by_pr && last.ai_review_done_on_head &&
      last.actionable_comments === 0 && !last.has_conflicts && !behindMergeDue) {
    log('CI is red for a reason outside this PR and nothing else is actionable — handing to human (re-run or fix main)')
    handoffWhy = 'CI is red for a reason outside this PR (re-run it or fix main)'
    break
  }
  // BEHIND alone does not block settling once its capped merges are spent; "Update branch" at merge time covers it.
  const idle = !pushed && !last.has_conflicts && !behindMergeDue && last.actionable_comments === 0 && settled
  quiet = idle ? quiet + 1 : 0
  if (quiet >= 2) {
    log('PR settled with nothing actionable for 2 consecutive rounds — handing to human for merge' +
      (last.behind_main ? ' (still behind main: use "Update branch" when merging)' : ''))
    handoffWhy = 'settled: nothing actionable for 2 rounds, ready for a person to merge' + (last.behind_main ? ' (behind main: use "Update branch")' : '')
    break
  }
  if (r === MAX_ROUNDS) { log(`Monitor hit the ${MAX_ROUNDS}-round cap without settling — check the PR by hand`); handoffWhy = `hit the ${MAX_ROUNDS}-round cap without settling` }
}

const STATUS = last ? last.pr_state : 'monitor_failed'
// Handed off while still open: nothing watches the PR from here, so say how to pick it up again.
if (STATUS === 'OPEN' || STATUS === 'monitor_failed') {
  const handoff = `PR #${PRN} handed off — ${handoffWhy || 'no round could observe it'}. Later comments, conflicts or red CI are not watched: ` +
    `re-run plan-to-merged-pr with this result's resume_monitor as args (monitor-only), or schedule that re-run (the pipeline REFERENCE, "Watching a handed-off PR").`
  log(handoff)
  return done(STATUS, { pr, monitor_actions: actions, final_state: last, resume_monitor: resumeArgs(), handoff })
}

// ---- Close-out: the proposal's last lane may just have merged. Report the edits a person makes; never make them.
let closeout
if (STATUS === 'MERGED' && A.proposal) {
  const c = await agent(
    GUARD + WHERE + AUTH + `PR #${PRN} (branch ${BRANCH}) has merged. Check whether the design doc ${A.proposal} is now complete on ${MAIN}. ` +
    `Read-only: change no file in this checkout, commit nothing, push nothing, post nothing, tick nothing.\n` +
    `1. git fetch origin ${MAIN}. Add a throwaway detached worktree of origin/${MAIN} in your scratch area (git worktree add --detach <scratch>/closeout origin/${MAIN}) and run every command below from it; remove it (git worktree remove --force <path>) before you finish. ` +
    `If ${A.proposal} does not exist there, report checked=false and why in notes.\n` +
    `2. Run python3 .claude/scripts/proposal-lint.py ${A.proposal} --json (if the script is missing there, run this checkout's copy, still from the worktree). ` +
    `proposal_complete = it lists at least one step and every step (code steps and human gates alike) has done true; pending_steps = the n of every other step; ` +
    `pending = one entry per step in pending_steps, copied verbatim from that JSON: its n, its title, and human_gate = its human_gate.text ('' when its human_gate is null: a code step).\n` +
    `3. If its header.source has the form <file>.md#N and that file (relative to the proposal's directory) exists on origin/${MAIN}, run proposal-lint.py <that file> --roadmap. ` +
    `If it reports kind roadmap and a milestone N, roadmap = its path and next_milestone = its "next" list, each with that milestone's title; then run proposal-lint.py <that file> --json and report milestone = { n: N, title, acceptance }, ` +
    `the title and acceptance copied verbatim from its steps entry N (the milestone's Acceptance: what a person checks before ticking it). Otherwise roadmap is empty, next_milestone is [], milestone is omitted, and notes says why.\n` +
    `4. Only when proposal_complete, list in edits — WITHOUT making any of them; a person sets Status: done and ticks milestones, through a docs PR — each edit's file, line number on origin/${MAIN}, exact current line and exact replacement: ` +
    `(a) the proposal's Status: line becoming "Status: done" (keep any trailing comment), unless it already reads done; ` +
    `(b) when a roadmap resolved, milestone N's "N. [ ]" line becoming "N. [x]" (what proposal-lint.py <roadmap> --tick N writes), unless it is already ticked; ` +
    `and, only when milestone N is a human gate, an "- Outcome: <what it delivered: the proposal and its merged PRs>" sub-bullet appended after its last sub-bullet (on a code milestone an Outcome line is W outcome_on_code_step, so add none). ` +
    `Otherwise edits is [].`,
    opts('closeout', 'Monitor', 'closeout', CLOSEOUT_SCHEMA),
  )
  if (!c || !c.checked) log(`Close-out check of ${A.proposal} did not run${c && c.notes ? `: ${c.notes}` : ''} — check it by hand (proposal-lint.py --roadmap)`)
  else if (c.proposal_complete) {
    // The milestone the person ticks, with the Acceptance they check first (null when no roadmap resolved).
    const milestone = c.milestone && c.milestone.n ? c.milestone : null
    closeout = { proposal_complete: true, edits: c.edits, next_milestone: c.next_milestone, roadmap: c.roadmap, milestone }
    log(`${A.proposal} is complete on ${MAIN}: ${c.edits.length} close-out edit(s) for a person to make in a docs PR` +
      (milestone ? `; before ticking milestone ${milestone.n} "${milestone.title}", check its Acceptance: ${milestone.acceptance || '(none stated)'}` : '') +
      (c.next_milestone.length ? `; next milestone(s): ${c.next_milestone.map(m => `${m.n} ${m.title}`).join(', ')}` : ''))
  } else {
    // Each unticked step by title, a human gate with what the person does (numbers alone move between revisions).
    const pending = Array.isArray(c.pending) ? c.pending : []
    closeout = { proposal_complete: false, pending_steps: c.pending_steps, pending }
    log(`${A.proposal} still has unticked on ${MAIN}: ` + (pending.length
      ? pending.map(s => `step ${s.n} "${s.title}"${s.human_gate ? ` (human gate: ${s.human_gate})` : ''}`).join('; ')
      : `step(s) ${c.pending_steps.join(', ')}`))
  }
}

return done(STATUS, { pr, monitor_actions: actions, final_state: last, ...(closeout ? { closeout } : {}) })

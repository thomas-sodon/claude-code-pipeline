export const meta = {
  name: 'bootstrap-repo',
  description: 'Bootstrap a greenfield repository from its accepted architecture.md and ship it: /bootstrap writes the skeleton, CLAUDE.md and CI, runs the gates until green and makes one commit on a bootstrap/<date> branch, then plan-to-merged-pr ship-only opens the PR and babysits its CI. The work runs in subagents; the result is compact',
  whenToUse: 'On a new repository once architecture.md is accepted and the gates Bootstrap waits on are ticked, instead of running /bootstrap in the orchestrating session. An empty remote gets the root commit on local main instead, which the person pushes; nothing is shipped then. A person merges the PR. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with answers, as its relay says.',
  phases: [
    { title: 'Bootstrap', detail: '/bootstrap <architecture>: checks, skeleton, CLAUDE.md, CI, gates green, one commit; never pushes' },
    { title: 'Ship', detail: 'plan-to-merged-pr ship-only on the bootstrap branch: merge check, PR, monitor until it settles' },
  ],
}

// args:
//   architecture: string      the accepted architecture doc, relative to dir (e.g. 'docs/design/architecture.md')
//   dir: string               absolute path of the repository: a clean clone with origin, seeded, its design docs accepted
//   ship?: boolean            default true; false = bootstrap only: the commit stays on its branch and next_steps carry the
//                             plan-to-merged-pr ship-only args to ship it later
//   title?: string            the bootstrap PR's title (default 'Bootstrap repository')
//   main_branch?, ai_review_check?, github_access?, gate?, commit_trailers?, on_question?
//                             passed to plan-to-merged-pr for the ship (see its args). github_access ('gh' | 'connector';
//                             unset or '' = GITHUB_ACCESS from the Pipeline config, else gh when it is authenticated, else the
//                             connector: .claude/scripts/github-access.md), gate and commit_trailers reach the bootstrap
//                             stage too. Leave ai_review_check unset on a new repository unless a review
//                             app already posts that check: the AI review workflow is offered in the next steps, after the merge.
//   efforts?: { bootstrap, ...plan-to-merged-pr's keys }  bootstrap (default 'medium') is the /bootstrap stage's effort; the
//                             other keys go to the ship run
//   on_question?: 'stop'|'assume'  default 'stop': a blocking question (one only the person can answer) stops the run with
//                             status needs_input, before /bootstrap's first write; 'assume' takes each recommended option
//                             instead and lists it in assumptions
//   answers?: [{ id, answer, question?, date? }]  the questions a needs_input result returned, each with its question text,
//                             the person's answer and the date they gave it (or { <id>: answer }). Every answer reaches the
//                             bootstrap stage and the ship run: bootstrap.q<N>, bootstrap.d<N> (an assumption the person
//                             corrected before the bootstrap commit existed, or a decision they made outside the questions;
//                             N the next number not yet in use) and any other id, such as a design run's intake.d<N> passed
//                             on. The one exception is the ship run's own ids (plan, impl, fix, polish, merge_check and
//                             monitor, .q<N> or .d<N>): they reach the ship run only, so a resume (resumeFromRunId) replays
//                             the bootstrap stage from the record. The ship-only args in the next steps carry the answers too
// The bootstrap stage also reads the answers the design run saved on the pipeline state branch (design/answers.json), when there
// are any: a choice one of them settles (the licence, a name) is not asked again.
// Every result carries assumptions: [{ stage, assumption }], the choices no person confirmed. The bootstrap stage's also go to
// the ship run (its assumptions arg), so the PR body shows them, and the first next step says to show them to the person before
// the merge.
// Once the bootstrap commit exists, a line the person corrects is no answer (no stage would apply it): they leave it as a review
// comment on the bootstrap PR, and the monitor's comment step applies it.
// Root mode: when the remote has no commits, /bootstrap makes the root commit on local main; nothing is shipped, and the next
// steps say to push main (the one push to main a person makes). A re-run once the commit exists changes nothing in the
// repository: /bootstrap reports it already bootstrapped and the branch is shipped again (an open PR is picked up, not opened
// twice), or the result says the bootstrap has merged. A run that stopped after its first write and before its commit
// (error=gates_red, a question a gate raised) leaves an unfinished bootstrap/<date> branch: the re-run resumes on it. A branch
// with no bootstrap commit is never shipped.
const A = args || {}
if (!A.architecture) throw new Error('bootstrap-repo: args.architecture (the accepted architecture doc, relative to dir) is required')
if (!A.dir) throw new Error('bootstrap-repo: args.dir (absolute path of the repository to bootstrap) is required')
const DIR = String(A.dir).replace(/\/+$/, '')
const inDir = p => { const s = String(p || '').trim(); return (s.startsWith(DIR + '/') ? s.slice(DIR.length + 1) : s).replace(/^\.\//, '') }
const ARCH = inDir(A.architecture)
if (!ARCH || /\s/.test(ARCH) || ARCH.startsWith('-')) throw new Error(`bootstrap-repo: args.architecture must be one doc path with no spaces or flags (got ${JSON.stringify(A.architecture)})`)
if (A.github_access && !['gh', 'connector'].includes(A.github_access)) throw new Error(`bootstrap-repo: args.github_access must be 'gh', 'connector' or unset (got ${JSON.stringify(A.github_access)})`)
const SHIP = A.ship !== false
const TITLE = A.title || 'Bootstrap repository'
const { bootstrap: _bootEffort, ...SHIP_EFFORTS } = A.efforts || {}
const EFF = { bootstrap: 'medium', ...(A.efforts || {}) }
const opts = (label, ph, effortKey, schema) => {
  const o = { label, phase: ph }
  if (EFF[effortKey]) o.effort = EFF[effortKey]
  if (schema) o.schema = schema
  return o
}
// The ship-only args plan-to-merged-pr gets: the bootstrap branch, plus the settings this run was given for it, the answers
// (so a ship run started later by hand still knows what the person settled), and the bootstrap stage's assumptions. The ship run
// lists them in the PR body under "## Assumptions to review", so the person sees what nobody confirmed before they merge, and
// its monitor knows each as a choice nobody confirmed: a review comment that corrects one is applied, not asked back.
const shipArgsFor = branch => {
  const s = { ship_only: true, branch, title: TITLE, dir: DIR }
  for (const k of ['main_branch', 'ai_review_check', 'github_access', 'gate', 'commit_trailers', 'on_question']) if (A[k] !== undefined) s[k] = A[k]
  if (Object.keys(SHIP_EFFORTS).length) s.efforts = SHIP_EFFORTS
  if (ANSWERS.length) s.answers = ANSWERS
  const taken = ASSUMED.filter(a => a.stage === 'bootstrap').map(a => ({ stage: 'bootstrap', assumption: oneLine(a.assumption, 300) }))
  if (taken.length) s.assumptions = taken
  return s
}

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path); record it as blocked and report it. `
const WHERE = `Work ONLY in the git checkout ${DIR} (cd there / use absolute paths): the repository being bootstrapped. `
const GH_ACCESS = `Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. ` +
  `The access in use is ${A.github_access ? `${A.github_access}, as this run was given` : 'GITHUB_ACCESS from the "Pipeline config" section of CLAUDE.md when it is set, else as that file\'s "Which access" resolves it (gh when it is authenticated, else the connector)'}; git fetch and push stay plain git. `
const GATE = A.gate || ''
const GATE_NOTE = GATE
  ? `Run every gate command (QUALITY_GATES, QUALITY_GATES_FAST and the docs job's script) through the gate wrapper, \`${GATE} <command>\` (a compound command as \`${GATE} bash -c '<command>'\`), from the repo root. ` +
    `Exit 75 = every slot busy: re-run the same command. Exit 125 or 127 = the wrapper cannot run: report that as the stop, never bypass the wrapper. `
  : ''
const TRAILERS = (A.commit_trailers || []).filter(Boolean)
const TRAILER_NOTE = TRAILERS.length
  ? `End the bootstrap commit's message with its Bootstrapped-by: /bootstrap trailer, then these lines in place of the session's Co-Authored-By trailer:\n${TRAILERS.join('\n')}\n`
  : ''

// ---- Questions before assumptions. No one can answer an agent mid-run: a stage that needs the person's answer returns its
// questions and the run stops with needs_input; the caller asks the person and re-runs with args.answers.
// Scopes in run order: bootstrap, then the ship run (plan-to-merged-pr, which routes its own ids: merge_check, monitor, ...).
// An answer reaches the scope that asked and every later one, never an earlier one, so a resume replays the bootstrap stage.
// An id in neither scope (a design answer, a decision the person made for the whole product) reaches both: the bootstrap stage
// is the one that writes the licence, the names and the skeleton.
const ON_Q = A.on_question === 'assume' ? 'assume' : 'stop'
const ANSWERS = (Array.isArray(A.answers) ? A.answers : Object.entries(A.answers || {}).map(([id, answer]) => ({ id, answer })))
  .filter(a => a && a.answer !== undefined && a.answer !== null && String(a.answer).trim() !== '')
const scopeOf = id => String(id || '').split('.')[0]
const SHIP_SCOPES = ['plan', 'impl', 'fix', 'polish', 'merge_check', 'monitor']
const BOOT_ANSWERS = ANSWERS.filter(a => !SHIP_SCOPES.includes(scopeOf(a.id)))
// An answer that came back without its question text (an id-only map, an older handoff) is shown with its id as the question:
// it still binds, and no stage may guess what it settled.
const NO_TEXT = `An entry above whose question equals its id was passed without its question text. When its answer alone does not say what it settles, it settles nothing: never guess what it meant. `
if (ANSWERS.some(a => !a.question)) log(`Answer(s) passed without their question text: ${ANSWERS.filter(a => !a.question).map(a => a.id).join(', ')} (pass each answer with its question, so every stage can tell what it settles)`)
const answersText = list => list.length
  ? `Answers from the person to questions an earlier run raised (binding, like an explicit constraint; never re-ask them, and never change what one settled: a reason to change it is a blocking question): ` +
    `${JSON.stringify(list.map(a => ({ id: a.id, question: a.question || a.id, answer: a.answer, ...(a.date ? { date: a.date } : {}) })))}\n` +
    (list.some(a => !a.question) ? NO_TEXT + '\n' : '')
  : ''
// The answers the design run was given, where brief-to-proposals saved them: the stage reads them itself, so a choice the person
// already made there (between the brief's licence and an existing LICENSE file, a name) is not asked a second time.
const SAVED_ANSWERS = `The answers the person gave the design run may be saved on the pipeline state branch: read them with python3 .claude/scripts/pipeline-state.py get design/answers.json ` +
  `(this read of the state branch is allowed and changes nothing in ${DIR}; exit 3 or 2: none are saved, go on without them). Each of its answers is the person's: binding, and never re-asked. ` +
  `A choice the skeleton bakes in that one of them settles (the licence, also between the architecture's and an existing LICENSE file's; the copyright holder; a name) is settled: follow the answer, and ask nothing about it. ` +
  (BOOT_ANSWERS.length ? `Where an answer listed above and a saved one settle the same point differently, the one listed above is the newer and holds. ` : '')
const ASK_RULE = `QUESTIONS: this stage runs unattended inside a workflow. No one can answer a question mid-run, so never wait for one and never use a question tool. ` +
  `A blocking question is one only the person can answer (what they intend, a requirement or choice the architecture leaves out or states two ways and the skeleton would bake in, a trade-off that is theirs to make, ` +
  `a conflict between what the person said (an answer, the framing, a decision the architecture tags (person, ...)) and what you find in the architecture, the tree or your research, or a blocker whose way forward is their call) ` +
  `and whose plausible answers lead to materially different work: a different skeleton, promise, cost or legal exposure. ` +
  `What the person said in an answer outranks the architecture. On the point it addresses, it replaces what the architecture says: follow it, and never ask it again. That difference is not a conflict. ` +
  `The conflict that is a blocking question is the other one: another part of the architecture, the tree or your research makes what the person said impossible to follow. Then pick no side and ask, naming both. ` +
  `In two cases a person-owned choice the skeleton bakes in is ${ON_Q === 'assume' ? 'a blocking question' : 'asked as a blocking question, never assumed'}: when no decision of the architecture and no answer settles it, ` +
  `and when the architecture records it as unconfirmed (a baked-in decision tagged (assumed) or untagged, which no answer confirms: a confirmation, with its Choice as the recommended option). The command's "Questions before assumptions" section names the ones a skeleton meets ` +
  `(the copyright holder, an existing LICENSE of another licence, no licence decision, a published name, a baked-in decision nobody confirmed). ` +
  `Never change what the person settled: an answer or a decision tagged (person, ...) is changed only by a newer answer from the person; a reason to change it is a blocking question. ` +
  `A question, its options and the recommendation name decisions and milestones by title; a number alone is never enough (numbers move between revisions). ` +
  `Settle yourself anything the architecture, the roadmap, CLAUDE.md, the tree or research can settle; never ask about it. An error= stop the command defines is a stop to report, not a question. ` +
  (ON_Q === 'assume'
    ? `The person chose to proceed on assumptions: for each blocking question, take the option you recommend (for a conflict with what the person said, what the person said; for a baked-in decision nobody confirmed, its Choice as the architecture states it; an existing LICENSE is never replaced) and report it in assumptions as "<question> -> <option taken>". `
    : `Never guess the answer to a blocking question: stop before the first write (create no branch, write no file) and return every such question (all of them, in one pass) in questions, each with why it blocks, 2-4 concrete options and the one you recommend. ` +
      `A confirmation (a baked-in decision the architecture records as unconfirmed) has confirm: true and its Choice as the recommended option. ` +
      `A question that surfaces only after the first write stops the run where it is: commit nothing, keep the files, return it the same way and name the unfinished branch in branch (a re-run resumes on it). `) +
  `Report in assumptions every other choice you made that the inputs did not settle, with every line the command's report lists under Assumptions (empty when none). `
const QUESTION = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    why: { type: 'string', description: 'what changes with the answer: the work each option leads to' },
    options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete options' },
    recommended: { type: 'string', description: 'the option you recommend, and why in one clause; for a confirmation, the decision\'s Choice as the architecture states it' },
    confirm: { type: 'boolean', description: 'true for a confirmation: a decision the skeleton bakes in that the architecture tags (assumed) or leaves untagged, and no answer confirms' },
  },
  required: ['question', 'why', 'options', 'recommended'],
}
const QA = {
  questions: { type: 'array', items: QUESTION, description: 'blocking questions and confirmations only the person can answer; non-empty means you stopped before the first write (or where a later one surfaced) and committed nothing' },
  assumptions: { type: 'array', items: { type: 'string' }, description: 'every choice you made that the inputs did not settle, with every line of the report\'s Assumptions; already_bootstrapped: the lines the bootstrap commit\'s body lists under Assumptions:' },
}
const ASSUMED = []
const noteAssumptions = (stage, r) => { if (r && Array.isArray(r.assumptions)) for (const a of r.assumptions) if (a) ASSUMED.push({ stage, assumption: a }); return r }
const asked = r => !!(r && Array.isArray(r.questions) && r.questions.length)
// Ids continue after the highest one already answered in the scope, so a question asked on a re-run never reuses an answered id.
// Every other field of a question, confirm included, is kept.
const tagQuestions = (scope, qs) => {
  let n = 0
  for (const a of ANSWERS) { const m = String(a.id || '').match(/^([a-z_]+)\.q(\d+)$/); if (m && m[1] === scope) n = Math.max(n, Number(m[2])) }
  return qs.map((q, i) => { const { id: _id, stage: _stage, ...rest } = q; return { id: `${scope}.q${n + i + 1}`, stage: scope, ...rest } })
}
// The relays of a needs_input result. One opening: who asks and how, the assumptions to show with the questions, and what goes
// back with each answer. How the re-run goes on depends on who asked: the bootstrap stage, the ship run, or its monitor.
// Before the bootstrap commit exists, a corrected assumption is an answer the bootstrap stage applies. Once it exists, the stage
// changes nothing and the ship run builds nothing, so the correction is a change to the branch: a review comment on the PR.
const CONFIRMATIONS = `Show the confirmations (the questions with confirm: true) as one list the person can accept whole or correct line by line. `
const SHOW_ASSUMED = `Also show the person this result's assumptions: a line they correct, or any decision they make outside these questions, is passed as an answer too (id bootstrap.d<N>, N the next number not yet in use, with the assumption or the decision as its question). `
const showAssumedOnPr = open => `Also show the person this result's assumptions. A line they correct is no answer: the bootstrap commit exists, so no stage of the re-run would apply it. ` +
  `The person leaves the correction as a review comment on the bootstrap PR${open ? '' : ', once it is open'}, and a monitor run's comment step applies it. Only the answers to these questions go into answers. `
const WITH_ANSWERS = `answers (each question's id and question text with the person's answer and the date they gave it, added to any answers given before)`
const relayHead = show => `Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit (a numbered list when it has none), ` +
  `each with its why, its options and the recommended one first; never answer them on their behalf, and never re-run with on_question: 'assume' unless the person says to proceed on assumptions. ` +
  show + `Then re-run this workflow with the same args plus ${WITH_ANSWERS} and resumeFromRunId set to this run's id: `
// A session that continues from a handoff has no run record: the same re-run without the id finds what the earlier run left.
const NEW_SESSION = found => ` A new session has no run record: re-run the same way without resumeFromRunId${found ? ` (${found})` : ''}.`
// The bootstrap stage asked: before its first write (no branch named), or later, with its files left on the unfinished branch.
const bootRelay = branch => relayHead(CONFIRMATIONS + SHOW_ASSUMED) + `the bootstrap stage runs again with the answers. ` + (branch
  ? `Its question surfaced after its first write: nothing is committed, the files it wrote stay on ${branch}, and the re-run resumes there.` + NEW_SESSION(`/bootstrap resumes on ${branch} while that checkout exists`)
  : `It asked before its first write, so nothing was written: no branch, no file.` + NEW_SESSION(''))
// The ship run asked (its merge check or its PR stage): the bootstrap commit exists.
const SHIP_RELAY = relayHead(showAssumedOnPr(false)) + `the commit /bootstrap made is kept (a stage whose prompt is unchanged replays from the record), and the ship run starts again with the answers.` +
  NEW_SESSION('/bootstrap finds its commit and changes nothing')
const MONITOR_RELAY = `Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit (a numbered list when it has none), ` +
  `each with its why, its options and the recommended one first; never answer them on their behalf, and never re-run with on_question: 'assume' unless the person says to proceed on assumptions. ` +
  showAssumedOnPr(true) + `The bootstrap PR is already open: re-run plan-to-merged-pr with this result's ship.resume_monitor as args plus ${WITH_ANSWERS} ` +
  `(the answers given before are ship.resume_monitor's own answers, when it has any), in monitor-only mode, so the PR is observed afresh. The next_steps still apply once it merges.`
const logQuestions = questions => {
  log(`${questions.length} question(s) only the person can answer — status needs_input`)
  for (const q of questions) log(`  ${q.id}${q.confirm ? ' (confirmation)' : ''}: ${q.question} (recommended: ${q.recommended})`)
}

const BOOTSTRAP_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['committed', 'already_bootstrapped', 'stopped'], description: 'committed: /bootstrap made its one commit in this run; already_bootstrapped: it found a bootstrap commit (trailer Bootstrapped-by: /bootstrap) on origin/main, on a bootstrap/* branch or, with an empty remote, on local main, and changed nothing; stopped: an error= stop, or blocking questions (in questions). A bootstrap/* branch with no bootstrap commit is an unfinished run that /bootstrap resumes, never already_bootstrapped' },
    root_mode: { type: 'boolean', description: 'true when the remote had no commits, so the commit is the root commit on local main, which a person pushes' },
    branch: { type: 'string', description: 'branch mode: the bootstrap/<date> branch that holds the commit; root mode: main; empty when the bootstrap has already merged; when stopped: the unfinished bootstrap/<date> branch that holds uncommitted work, else empty (nothing was written)' },
    merged: { type: 'boolean', description: 'already_bootstrapped only: true when the bootstrap commit (trailer Bootstrapped-by: /bootstrap) is already on origin/main' },
    commit: { type: 'string', description: 'the bootstrap commit\'s short sha; empty when there is none (stopped)' },
    stop_reason: { type: 'string', description: 'when stopped on an error=: its code and the next action /bootstrap names, verbatim; else empty' },
    summary: { type: 'string', description: 'one line: what the skeleton holds (packages, the gates and fix rounds, the CI checks, the licence), or where the earlier bootstrap is' },
    left_out: { type: 'array', items: { type: 'string' }, description: 'pre-existing files the commit left out on purpose (e.g. the brief), as its report lists them' },
    next_steps: { type: 'array', items: { type: 'string' }, description: 'every next step the report prints except reviewing the commit and shipping it, each verbatim with the values it filled in; on an error= stop, the next action it names' },
    ...QA,
  },
  required: ['outcome', 'root_mode', 'branch', 'merged', 'commit', 'stop_reason', 'summary', 'left_out', 'next_steps', 'questions', 'assumptions'],
}

// One line per item: the result goes back into the orchestrating session's context.
const oneLine = (t, n = 400) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const blocking = list => list.filter(f => f && (f.severity === 'bug' || f.severity === 'concern'))
const slimBoot = b => b ? {
  outcome: b.outcome || '',
  root_mode: !!b.root_mode,
  branch: b.branch || '',
  commit: b.commit || '',
  ...(b.outcome === 'already_bootstrapped' ? { merged: !!b.merged } : {}),
  summary: oneLine(b.summary),
  left_out: (b.left_out || []).filter(Boolean),
  ...(b.stop_reason ? { stop_reason: oneLine(b.stop_reason) } : {}),
} : null
// The ship run's result, slimmed to what the person and the next session act on: no plan, no per-round monitor log.
function slimShip(r, threw) {
  if (!r) return { status: 'failed', reason: oneLine(threw || 'plan-to-merged-pr returned nothing') }
  const s = { status: r.status || 'failed' }
  if (r.stage) s.stage = r.stage
  if (r.pr && r.pr.pr_number) s.pr = { pr_number: r.pr.pr_number, url: r.pr.url || '' }
  const f = r.final_state
  if (f && f.pr_state) {
    s.final_state = `${f.pr_state} @${String(f.head_sha || '').slice(0, 9)}, CI ${f.ci_state}, ${f.actionable_comments || 0} actionable comment(s)` +
      `${f.has_conflicts ? ', conflicts' : ''}${f.behind_main ? ', behind main' : ''}`
  }
  if (r.handoff) s.handoff = oneLine(r.handoff)
  if (r.resume_monitor) s.resume_monitor = r.resume_monitor
  const why = (r.merge_check && r.merge_check.blocked_reason) || (r.pr_stage && r.pr_stage.blocked_reason) || r.stop_reason ||
    (r.status === 'blocked_at_merge_check' && r.merge_check && r.merge_check.merge_check)
  if (why) s.reason = oneLine(why)
  const defects = blocking(r.review_findings || [])
  if (defects.length) s.review_findings = defects.map(d => oneLine(`${d.severity}: ${d.file ? `${d.file}: ` : ''}${d.description}`))
  return s
}

// ---- Bootstrap: /bootstrap runs in a subagent, so the skeleton, the installs and the gate runs never reach the caller's context.
phase('Bootstrap')
const boot = await agent(
  GUARD + WHERE + ASK_RULE + answersText(BOOT_ANSWERS) + SAVED_ANSWERS + GH_ACCESS + GATE_NOTE + TRAILER_NOTE +
  `Invoke the Skill tool with skill "bootstrap" with args ${JSON.stringify(ARCH)} and follow it to the end: its checks, the skeleton, the install, the gates until green, and its one commit. ` +
  `It never pushes and never opens a PR, and neither do you: this workflow ships the commit afterwards. ` +
  `Then return its outcome from its report: committed, already_bootstrapped (it found a bootstrap commit and changed nothing; never for a bootstrap/* branch that holds no bootstrap commit, which is an unfinished run the command resumes) or stopped (an error= stop, or blocking questions); ` +
  `root_mode, the branch, the commit's short sha, a one-line summary and the files it left out of the commit on purpose. ` +
  `For already_bootstrapped, the short sha is that commit's, and assumptions holds the lines its body lists under Assumptions:. ` +
  `In next_steps, put every next step its report prints, each verbatim with the values it filled in, except reviewing the commit and shipping it (the PR, or in root mode pushing main): this workflow gives those itself. ` +
  `On an error= stop, next_steps is the next action it names.`,
  opts('bootstrap', 'Bootstrap', 'bootstrap', BOOTSTRAP_SCHEMA),
)
noteAssumptions('bootstrap', boot)
const bootstrap = slimBoot(boot)
if (asked(boot)) {
  const questions = tagQuestions('bootstrap', boot.questions)
  logQuestions(questions)
  return {
    status: 'needs_input', questions, relay: bootRelay(bootstrap.branch), assumptions: ASSUMED, bootstrap,
    next_steps: [`First answer the ${questions.length} question(s) in questions (see relay): nothing is committed, and ` +
      (bootstrap.branch
        ? `the uncommitted files /bootstrap wrote stay on ${bootstrap.branch}, where the re-run resumes.`
        : `nothing was written: /bootstrap asked before its first write, so it created no branch and no file.`)],
  }
}
const AFTER = ((boot && boot.next_steps) || []).filter(Boolean)
const failed = (reason, steps) => {
  log(`Not bootstrapped: ${reason}`)
  return { status: 'failed_at_bootstrap', stop_reason: reason, assumptions: ASSUMED, bootstrap, next_steps: steps || AFTER }
}
if (!boot || !['committed', 'already_bootstrapped'].includes(boot.outcome)) {
  const reason = oneLine((boot && boot.stop_reason) || 'the bootstrap stage failed to report')
  return failed(reason, AFTER.length ? AFTER.concat('Then re-run this workflow with the same args.') : ['Fix what stopped it, then re-run this workflow with the same args.'])
}
log(boot.outcome === 'committed'
  ? `Bootstrapped ${DIR}: ${boot.commit || 'one commit'} on ${boot.root_mode ? 'local main (root commit)' : boot.branch}${boot.summary ? ` — ${oneLine(boot.summary, 200)}` : ''}`
  : `Already bootstrapped${boot.merged ? ' (merged on main)' : ` (${boot.branch || 'branch unknown'} waits for its PR)`}`)
if (boot.outcome === 'already_bootstrapped' && boot.merged) {
  return { status: 'already_bootstrapped', assumptions: ASSUMED, bootstrap, next_steps: AFTER }
}
// Never ship a branch with no bootstrap commit: that is an unfinished run, which /bootstrap resumes on a re-run.
if (boot.outcome === 'already_bootstrapped' && !String(boot.commit || '').trim()) {
  return failed(`the bootstrap stage reported an earlier bootstrap${boot.branch ? ` on ${boot.branch}` : ''} but no bootstrap commit; nothing was shipped`,
    [`Look for the bootstrap commit (git -C ${DIR} log --all --oneline --grep='^Bootstrapped-by: /bootstrap'). None: the branch is an unfinished run, so re-run this workflow with the same args and /bootstrap resumes on it. ` +
      `One exists: ship its branch with plan-to-merged-pr ${JSON.stringify(shipArgsFor('bootstrap/<date>'))}.`].concat(AFTER))
}
const LEFT_OUT = bootstrap.left_out
// What nobody confirmed with the person is shown to them before the skeleton reaches main. The commit exists, so a line they
// correct is a change to the branch: asked for on the PR, or, with no PR (root mode), made on main before the push.
const showAssumed = (before, how) => ASSUMED.length
  ? ` Before ${before}, show the person this result's assumptions (${ASSUMED.length}): a line they correct is ${how}.`
  : ''
const ON_PR = open => `no answer to a re-run (nothing would apply it): they leave it as a review comment on the PR${open ? '' : ', once it is open'}, and a monitor run's comment step applies it`
const leftOutStep = LEFT_OUT.length ? [`/bootstrap left ${LEFT_OUT.join(', ')} out of its commit on purpose: check that the PR's files hold none of them before you merge.`] : []
// ---- Root mode: an empty remote has no base for a PR. The root commit on local main is pushed by a person, never by a workflow.
if (boot.root_mode) {
  log('Root mode: nothing to ship — a person pushes main')
  return {
    status: 'root_commit', assumptions: ASSUMED, bootstrap,
    next_steps: [`Review the root commit (git -C ${DIR} show --stat HEAD), then push it yourself: git push -u origin main — the one push to main a person makes by hand, since an empty repository has no base for a PR. Nothing was shipped.${showAssumed('the push', 'a change to commit on main first')}`].concat(AFTER),
  }
}
// Never ship anything but the bootstrap branch: a wrong report must not open a PR from main or another branch.
const BRANCH = String(boot.branch || '').trim()
if (!/^bootstrap\/[A-Za-z0-9._-]+$/.test(BRANCH)) {
  return failed(`the bootstrap stage reported branch ${JSON.stringify(BRANCH)}, not a bootstrap/<date> branch; nothing was shipped`,
    [`Check the branch /bootstrap committed on (git -C ${DIR} branch --list 'bootstrap/*'), then ship it with plan-to-merged-pr ${JSON.stringify(shipArgsFor('bootstrap/<date>'))}.`].concat(AFTER))
}
const SHIP_ARGS = shipArgsFor(BRANCH)
if (!SHIP) {
  return {
    status: 'committed', assumptions: ASSUMED, bootstrap,
    next_steps: [`Review the commit (git -C ${DIR} show --stat ${BRANCH}), then ship it: run the plan-to-merged-pr workflow with ${JSON.stringify(SHIP_ARGS)}. It re-runs the gates, opens the PR and babysits its CI; a person merges it.${showAssumed('the merge', ON_PR(false))}`]
      .concat(leftOutStep, AFTER),
  }
}

// ---- Ship: the bootstrap branch through plan-to-merged-pr ship-only (merge check, PR, monitor). Every answer goes along, in
// SHIP_ARGS: the ship run's own route to its stages, and every other one (the bootstrap stage's, a design answer) reaches every
// stage of it.
phase('Ship')
log(`Shipping ${BRANCH} as "${TITLE}"`)
let r = null, threw = ''
try {
  r = await workflow('plan-to-merged-pr', SHIP_ARGS)
} catch (err) {
  threw = (err && err.message) || String(err)
  log(`Ship: ${threw}`)
}
const ship = slimShip(r, threw)
// The ship run lists the bootstrap stage's assumptions it was given beside its own: only its own are new here.
for (const a of (r && r.assumptions) || []) if (a && a.assumption && a.stage !== 'bootstrap') ASSUMED.push({ stage: `ship.${a.stage || 'ship'}`, assumption: a.assumption })
log(`Ship: ${ship.status}${ship.pr ? ` (PR #${ship.pr.pr_number})` : ''}`)
const prRef = ship.pr ? `PR #${ship.pr.pr_number}${ship.pr.url ? ` (${ship.pr.url})` : ''}` : 'the bootstrap PR'
const RERUN = 're-run this workflow with the same args (/bootstrap finds its branch and changes nothing)'

if (ship.status === 'needs_input' && asked(r)) {
  const questions = r.questions
  logQuestions(questions)
  const monitorAsked = r.stage === 'monitor' && !!ship.resume_monitor
  return {
    status: 'needs_input', questions, relay: monitorAsked ? MONITOR_RELAY : SHIP_RELAY, assumptions: ASSUMED, bootstrap, ship,
    next_steps: [`First answer the ${questions.length} question(s) in questions (see relay): the commit is on ${BRANCH}${monitorAsked ? ` and ${prRef} is open` : ''}, and its ship run waits on them.`]
      .concat(leftOutStep, AFTER),
  }
}
const status = ship.status === 'OPEN' || ship.status === 'monitor_failed' ? 'pr_open'
  : ship.status === 'MERGED' ? 'merged'
  : ship.status === 'CLOSED' ? 'closed'
  : 'ship_failed'
const first = status === 'pr_open'
  ? [`Review and merge ${prRef} yourself${ship.final_state ? ` (${ship.final_state})` : ''}. Nothing watches it after this run: to pick up later comments, conflicts or red CI, re-run plan-to-merged-pr with ship.resume_monitor as args (monitor-only).${showAssumed('the merge', ON_PR(true))}${SHIP_ARGS.assumptions ? ' The PR body was given /bootstrap\'s under "Assumptions to review".' : ''}`].concat(leftOutStep)
  : status === 'merged' ? [`${prRef} has merged.`]
  : status === 'closed' ? [`${prRef} was closed without merging. To ship it again, reopen it, or ${RERUN}: a new PR is opened from ${BRANCH}.`]
  : [`Shipping stopped (${ship.status}${ship.reason ? `: ${ship.reason}` : ''}); the commit is on ${BRANCH}. Fix what stopped it, then ${RERUN} and it ships again, or run plan-to-merged-pr with ${JSON.stringify(SHIP_ARGS)}.`]
log(`Status: ${status}`)
return { status, assumptions: ASSUMED, bootstrap, ship, next_steps: first.concat(AFTER) }

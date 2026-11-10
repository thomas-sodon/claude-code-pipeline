export const meta = {
  name: 'brief-to-proposals',
  description: 'Turn a product brief (or one change too big for a PR) into reviewed design docs: seed the repo with the pipeline and a base CLAUDE.md, architecture panel, /roadmap, /propose per code milestone, /review-proposal and revise until clean, cross-doc consistency, then lint and lanes. Writes only the seeded pipeline files, CLAUDE.md and design docs: no code, no commits',
  whenToUse: 'Before building a new product or a change too big for one PR. It writes the architecture, roadmap and proposals that /bootstrap and proposal-build-chain consume. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with answers, as its relay says.',
  phases: [
    { title: 'Seed', detail: '/seed installs the pipeline\'s skills, workflows and scripts and a base CLAUDE.md into the repo' },
    { title: 'Intake', detail: 'read the source for blocking questions only the person can answer, before any design is written' },
    { title: 'Architecture', detail: 'independent sketches and a judge, then /roadmap writes architecture.md and roadmap.md, reviewed until clean' },
    { title: 'Proposals', detail: '/propose per roadmap code milestone, then /review-proposal and /propose --revise until clean' },
    { title: 'Consistency', detail: 'one pass over every doc for cross-doc conflicts and coverage of the source' },
    { title: 'Lint', detail: 'proposal-lint.py on every doc, lanes per proposal, roadmap progress' },
  ],
}

// args:
//   brief?: string            path of a product brief (relative to dir, or absolute): brief mode
//   concern?: string          one change too big for one PR, or a structural class: concern mode (one proposal, no roadmap)
//   dir: string               absolute path of the project's repository: a clean clone (the pipeline never creates one)
//   pipeline?: string         absolute path of the pipeline source (a checkout of the pipeline): /seed copies its skills, workflows and
//                             scripts into dir and writes a base CLAUDE.md first. Omit only when dir already holds the pipeline.
//   out?: string              proposals directory relative to dir (default: PROPOSALS_DIR from the Pipeline config, else docs/design)
//   context?: string          extra framing for every author (builder, budget, constraints the source does not state)
//   panel?: number            independent architecture sketches before /roadmap (default 3; 0 = skip the panel)
//   milestones?: number[]     propose only these roadmap milestones (default: every pending milestone that names a proposal)
//   max_milestones?: number   propose at most the first N of those, in roadmap order (e.g. 1 to try the flow on one milestone; 1 is
//                             recommended for a long roadmap, since later proposals go stale as earlier milestones change the tree)
//   force?: boolean           let /roadmap overwrite an existing architecture.md / roadmap.md (default false)
//   max_review_rounds?: number  revise rounds per doc (default 3)
//   efforts?: { intake, sketch, judge, roadmap, propose, review, revise, consistency, lint }
//   on_question?: 'stop'|'assume'  default 'stop': blocking questions (ones only the person can answer) stop the run with status
//                             needs_input before anything is built on a guess; 'assume' takes each recommended option instead
//                             (the Intake's become shared answers for every later stage) and lists them in assumptions
//   answers?: [{ id, answer }] the questions a needs_input result returned, each with the person's answer (or { <id>: answer });
//                             each reaches the stage that asked and every later one (a milestone's only that milestone's
//                             stages), so a resume (resumeFromRunId) replays the earlier stages from the record
const A = args || {}
if (!A.dir) throw new Error('brief-to-proposals: args.dir (absolute project directory) is required')
if (!A.brief === !A.concern) throw new Error('brief-to-proposals: pass exactly one of args.brief (a product brief path) or args.concern (one large change)')
const DIR = String(A.dir).replace(/\/+$/, '')
const BRIEF_MODE = !!A.brief
const OUT_FLAG = A.out ? ` --out=${A.out}` : ''
const PANEL = Math.max(0, A.panel ?? 3)
const MAX_REVIEW = A.max_review_rounds ?? 3
const ONLY = Array.isArray(A.milestones) && A.milestones.length ? A.milestones.map(Number) : null
const MAX_M = A.max_milestones ? Math.max(1, Number(A.max_milestones)) : null
const EFF = { intake: 'medium', sketch: 'medium', judge: 'high', roadmap: 'high', propose: 'medium', review: 'high', revise: 'medium', consistency: 'high', lint: 'low', ...(A.efforts || {}) }
const opts = (label, ph, effortKey, schema) => {
  const o = { label, phase: ph }
  if (EFF[effortKey]) o.effort = EFF[effortKey]
  if (schema) o.schema = schema
  return o
}

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path); record it as blocked and report it. `
const WHERE = `Work ONLY in ${DIR} (cd there / use absolute paths). `
const DOCS_ONLY = `This is design work: write only design docs in the proposals directory. Never write code, never commit, stage, push, ` +
  `create a branch or open a PR, and change no git state. `
const CTX = A.context ? `Framing from the person (binding unless a source fact contradicts it): ${A.context}\n` : ''
const REVIEW_CTX = A.context ? `The authors were told to follow this framing from the person as binding (unless a source fact contradicts it); a choice that follows it is not a defect: ${A.context}\n` : ''
const WORK = GUARD + WHERE + DOCS_ONLY
const SOURCE = BRIEF_MODE ? `the product brief ${A.brief}` : `the concern ${JSON.stringify(A.concern)}`
const LINT = `python3 .claude/scripts/proposal-lint.py`
const PIPELINE = A.pipeline ? String(A.pipeline).replace(/\/+$/, '') : ''

// ---- Questions before assumptions. No one can answer an agent mid-run: a stage that needs the person's answer returns its
// questions and the run stops with needs_input; the caller asks the person and re-runs with args.answers.
// Scopes in run order: intake, architecture, a proposal (m<N>, or 'proposal' in concern mode), consistency. An answer reaches
// the scope that asked and every later one, never an earlier one; a milestone's answer reaches only that milestone (and
// consistency), so a resume replays everything before it from the record.
const ON_Q = A.on_question === 'assume' ? 'assume' : 'stop'
const scopeOf = id => String(id || '').split('.')[0]
const scopeOrder = sc => sc === 'intake' ? 0 : sc === 'architecture' ? 1 : sc === 'consistency' ? 3 : 2
const ANSWERS = (Array.isArray(A.answers) ? A.answers : Object.entries(A.answers || {}).map(([id, answer]) => ({ id, answer })))
  .filter(a => a && a.answer !== undefined && a.answer !== null && String(a.answer).trim() !== '')
  .map(a => ({ ...a, stage: a.stage || scopeOf(a.id) }))
const answersFor = scope => {
  const mine = ANSWERS.filter(a => {
    const o = scopeOrder(a.stage)
    if (o > scopeOrder(scope)) return false
    return !(o === 2 && scopeOrder(scope) === 2 && a.stage !== scope)
  })
  return mine.length
    ? `Answers from the person to blocking questions (binding, like the person's framing; never re-ask them, and a choice that follows one is not a defect): ${JSON.stringify(mine.map(a => ({ question: a.question || a.id, answer: a.answer })))}\n`
    : ''
}
const BLOCKING_DEF = `A blocking question is one only the person can answer now, from what they know or intend: a requirement or constraint the source leaves out or states two incompatible ways, who builds and runs it and with what budget, target users, platforms or distribution, hosted or self-run, licence or revenue model, a trade-off that is theirs to make; and the plausible answers send the design materially different ways. ` +
  `It is not something the source, the framing, the answers, the tree or desk research (official docs, pricing, terms, prior art) can settle: settle those. Not data a person must go and gather (interviews, samples, live numbers): that is a research gate. Not a choice that waits on evidence the plan produces (a go/no-go after an experiment, a sign-off on finished work): that is a decision gate. `
const ASK_RULE = `QUESTIONS: this stage runs unattended inside a workflow. No one can answer a question mid-run, so never wait for one and never use a question tool. ` + BLOCKING_DEF +
  (ON_Q === 'assume'
    ? `The person chose to proceed on assumptions: for each blocking question, take the option you recommend, write the docs on it, and report it in assumptions as "<question> -> <option taken>". `
    : `Never guess the answer to a blocking question: write and change nothing, and return every such question (all of them, in one pass) in questions, each with why it blocks, 2-4 concrete options and the one you recommend. `) +
  `Report in assumptions every other choice the source did not settle (empty when none). `
const ASK = scope => ASK_RULE + answersFor(scope)
const QUESTION = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    why: { type: 'string', description: 'what changes with the answer: where each option sends the design' },
    options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete options' },
    recommended: { type: 'string', description: 'the option you recommend, and why in one clause' },
  },
  required: ['question', 'why', 'options', 'recommended'],
}
const QA = {
  questions: { type: 'array', items: QUESTION, description: 'blocking questions only the person can answer; non-empty means you wrote nothing' },
  assumptions: { type: 'array', items: { type: 'string' }, description: 'every choice you made that the source did not settle' },
}
const ASSUMED = []
const noteAssumptions = (scope, r) => { if (r && Array.isArray(r.assumptions)) for (const a of r.assumptions) if (a) ASSUMED.push({ stage: scope, assumption: a }); return r }
const asked = r => !!(r && Array.isArray(r.questions) && r.questions.length)
const tagQuestions = (scope, qs) => qs.map((q, i) => ({ id: `${scope}.q${i + 1}`, stage: scope, ...q }))
const RELAY = `Ask the person these questions yourself, all at once, each with its options and the recommended one first; never answer them on their behalf. ` +
  `Then re-run this workflow with the same args plus answers (each question's id with the person's answer) and resumeFromRunId set to this run's id: ` +
  `the stages before the ones that asked replay from the record, and docs already written are kept.`
const logQuestions = questions => {
  log(`${questions.length} question(s) only the person can answer — status needs_input`)
  for (const q of questions) log(`  ${q.id}: ${q.question} (recommended: ${q.recommended})`)
}
const needsInput = (questions, extra) => {
  logQuestions(questions)
  return { status: 'needs_input', questions, relay: RELAY, assumptions: ASSUMED, ...(extra || {}) }
}

const FINDING = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: 'path of the doc the finding is about' },
    severity: { type: 'string', enum: ['bug', 'concern', 'suggestion', 'nit'] },
    description: { type: 'string' },
  },
  required: ['doc', 'severity', 'description'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING },
    completed: { type: 'boolean', description: 'false if the review skill stopped without reviewing every doc' },
  },
  required: ['findings', 'completed'],
}
const REVISE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    declined: {
      type: 'array',
      description: 'findings judged wrong and left unapplied, each with the reason',
      items: { type: 'object', properties: { finding: { type: 'string' }, reason: { type: 'string' } }, required: ['finding', 'reason'] },
    },
    lint_clean: { type: 'boolean', description: 'proposal-lint.py reports no errors on every revised doc' },
    ...QA,
  },
  required: ['summary', 'declined', 'lint_clean', 'questions', 'assumptions'],
}
const SKETCH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'the architecture in one paragraph' },
    components: { type: 'array', items: { type: 'string' }, description: 'each: name — responsibility — technology' },
    data_flow: { type: 'string' },
    decisions: {
      type: 'array',
      items: { type: 'object', properties: { decision: { type: 'string' }, options: { type: 'string' }, choice: { type: 'string' }, why: { type: 'string' } }, required: ['decision', 'options', 'choice', 'why'] },
    },
    security_privacy: { type: 'string' },
    deploy_and_operate: { type: 'string', description: 'environments, CI/CD, secrets, migrations, monitoring, rollback, release gates' },
    milestones: { type: 'array', items: { type: 'string' }, description: 'ordered; each: title — scope — exit criteria; mark the ones a person must do' },
    assumptions_to_validate: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'string', description: 'where this sketch is weakest, honestly' },
  },
  required: ['summary', 'components', 'data_flow', 'decisions', 'security_privacy', 'deploy_and_operate', 'milestones', 'assumptions_to_validate', 'weaknesses'],
}
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: { type: 'object', properties: { sketch: { type: 'string' }, total: { type: 'number' }, notes: { type: 'string' } }, required: ['sketch', 'total', 'notes'] },
    },
    winner: { type: 'string' },
    synthesis: { type: 'string', description: 'the architecture to build on: the winner, with the named ideas grafted from the others and why; every decision with its options and choice' },
  },
  required: ['scores', 'winner', 'synthesis'],
}
const MILESTONE = {
  type: 'object',
  properties: {
    n: { type: 'integer' },
    title: { type: 'string' },
    done: { type: 'boolean' },
    human_gate: { type: 'string', description: 'gate kind (research/decision/ops/release), or empty for a milestone built from a proposal' },
    proposal: { type: 'string', description: 'proposal path relative to the project directory, or empty' },
  },
  required: ['n', 'title', 'done', 'human_gate', 'proposal'],
}
const ROADMAP_SCHEMA = {
  type: 'object',
  properties: {
    out_dir: { type: 'string', description: 'the proposals directory used, relative to the project directory' },
    architecture: { type: 'string', description: 'path of architecture.md, relative to the project directory' },
    roadmap: { type: 'string', description: 'path of roadmap.md, relative to the project directory' },
    milestones: { type: 'array', items: MILESTONE },
    lint_clean: { type: 'boolean' },
    stopped: { type: 'boolean', description: 'true if the skill stopped without writing the docs (an error= stop such as exists, lint_missing or source_too_vague); then the other fields are empty' },
    stop_reason: { type: 'string', description: 'when stopped: the skill\'s error code and recommendation, verbatim' },
    notes: { type: 'string' },
    ...QA,
  },
  required: ['out_dir', 'architecture', 'roadmap', 'milestones', 'lint_clean', 'stopped', 'questions', 'assumptions'],
}
const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: 'path of the proposal written, relative to the project directory' },
    steps: { type: 'integer', description: 'number of steps' },
    human_gates: { type: 'integer', description: 'number of human-gated steps' },
    lint_clean: { type: 'boolean' },
    stopped: { type: 'boolean', description: 'true if the skill wrote no proposal (it routed the work elsewhere, e.g. to /plan or /bug-fix, or stopped with an error=); then doc is empty' },
    stop_reason: { type: 'string', description: 'when stopped: the recommendation or error code, verbatim' },
    notes: { type: 'string' },
    ...QA,
  },
  required: ['doc', 'steps', 'human_gates', 'lint_clean', 'stopped', 'questions', 'assumptions'],
}
const CONSISTENCY_SCHEMA = {
  type: 'object',
  properties: { findings: { type: 'array', items: FINDING }, coverage_gaps: { type: 'array', items: { type: 'string' }, description: 'parts of the source no doc plans for' } },
  required: ['findings', 'coverage_gaps'],
}
const LINT_SCHEMA = {
  type: 'object',
  properties: {
    docs: {
      type: 'array',
      items: { type: 'object', properties: { doc: { type: 'string' }, errors: { type: 'integer' }, warnings: { type: 'integer' }, messages: { type: 'array', items: { type: 'string' } } }, required: ['doc', 'errors', 'warnings', 'messages'] },
    },
    lanes: {
      type: 'array',
      description: 'from --lanes --allow-draft: how each proposal will split once a person accepts it',
      items: { type: 'object', properties: { doc: { type: 'string' }, errors: { type: 'integer', description: 'errors in the --lanes output (e.g. lane_cycle)' }, chains: { type: 'integer' }, lanes: { type: 'integer' }, blocked: { type: 'integer' }, human_gates_pending: { type: 'integer' } }, required: ['doc', 'errors', 'chains', 'lanes', 'blocked', 'human_gates_pending'] },
    },
    next_milestones: { type: 'array', items: { type: 'string' }, description: 'from --roadmap: the next actionable milestones' },
  },
  required: ['docs', 'lanes', 'next_milestones'],
}
const blocking = list => list.filter(f => f.severity === 'bug' || f.severity === 'concern')
// Agents may name a doc absolutely, relative to DIR, or with a leading ./ — compare them as DIR-relative paths.
const norm = d => String(d || '').trim().replace(new RegExp('^' + DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), '').replace(/^\.\//, '')


// Review docs with /review-proposal and revise with /propose --revise until no bug or concern remains.
// Same shape as plan-to-merged-pr's review loop: suggestions and nits get one revise round, defects block.
// A reviser edits only the docs under review; findings about any other doc are deferred to the Consistency phase,
// so two concurrent loops never rewrite the same roadmap or architecture.
// `scope` routes answers (see answersFor); a reviser that needs the person's call returns questions and ends the loop.
async function reviewLoop(docs, frame, label, ph, scope) {
  const own = new Set(docs.map(norm))
  const history = [], deferred = []
  let fixes = 0, findings = [], clean = false, reviewed = true, questions = []
  for (let round = 1; ; round++) {
    const review = await agent(
      WORK + REVIEW_CTX + answersFor(scope) + `Invoke the Skill tool with skill "review-proposal" once for each of these docs: ${docs.join(', ')}. ${frame}` +
      `Report every finding (bug/concern/suggestion/nit) with the doc it is about, verified against the docs, ${SOURCE} and the tree. Do not edit files. ` +
      `Set completed=false if the skill stopped without reviewing every doc (an empty findings list must mean a real, clean review).` +
      (history.length ? `\nEarlier rounds and what the reviser did (confirm each is resolved; do not re-report revised items or ones validly declined):\n${JSON.stringify(history, null, 1)}` : ''),
      opts(`review:${label}-${round}`, ph, 'review', REVIEW_SCHEMA),
    )
    if (!review || review.completed === false) { reviewed = false; break }
    for (const f of review.findings) if (!own.has(norm(f.doc)) && !deferred.some(d => d.description === f.description)) deferred.push(f)
    findings = review.findings.filter(f => own.has(norm(f.doc)))
    const defects = blocking(findings)
    log(`${label} review ${round}: ${findings.length} findings, ${defects.length} blocking${deferred.length ? `, ${deferred.length} about other docs (deferred)` : ''}`)
    if (!defects.length && (!findings.length || fixes >= 1 || fixes >= MAX_REVIEW)) { clean = true; break }
    if (fixes >= MAX_REVIEW) break
    const fix = await agent(
      WORK + CTX + ASK(scope) + `For each doc with findings below, invoke the Skill tool with skill "propose" with args "--revise <doc>", applying these findings; ` +
      `decline any you can verify is wrong and give the reason. A finding only the person can settle (the source is silent or ambiguous on it, and the fix would choose for them) is a blocking question, per QUESTIONS: never decline it or pick a side. ` +
      `Edit only ${docs.join(', ')}; never any other doc. Re-run ${LINT} on each revised doc until it reports no errors.\n` +
      JSON.stringify(findings, null, 2),
      opts(`revise:${label}-${round}`, ph, 'revise', REVISE_SCHEMA),
    )
    noteAssumptions(scope, fix)
    if (asked(fix)) { questions = tagQuestions(scope, fix.questions); break }
    if (!fix) { reviewed = false; break }
    fixes++
    history.push({ round, findings, revised: fix.summary, declined: fix.declined })
  }
  return { docs, clean, reviewed, revise_rounds: fixes, findings_remaining: clean ? findings.filter(f => !blocking([f]).length) : findings, deferred, questions }
}

let arch = null, judged = null, archReview = null
const proposals = []

// ---- Seed: the repo gets the pipeline's base files before any design work, so every author, reviewer and later session
// runs from files installed there (they ship in the bootstrap PR on a new repo, or an ordinary PR on an existing one).
phase('Seed')
const SEED_SCHEMA = {
  type: 'object',
  properties: {
    copied: { type: 'integer', description: 'pipeline files copied into the repo' },
    differing_kept: { type: 'array', items: { type: 'string' }, description: 'repo files that differ from the source and were kept' },
    claude_md: { type: 'string', enum: ['written', 'appended', 'unchanged'] },
    stopped: { type: 'boolean', description: 'true if the command stopped with an error= (no_source, not_a_repo, no_remote, dirty_tree, ...)' },
    stop_reason: { type: 'string' },
  },
  required: ['copied', 'differing_kept', 'claude_md', 'stopped'],
}
const seedCmd = `${PIPELINE || DIR}/.claude/commands/seed.md`
const seeded = await agent(
  GUARD + `Read the command file ${seedCmd} in full and follow it exactly, as an agent invoking that skill would, with the args ` +
  `${JSON.stringify(`${DIR}${PIPELINE ? ` --from=${PIPELINE}` : ''}`)}. ` +
  (PIPELINE ? '' : `No pipeline source was given: the repo must already hold the pipeline (the source is the repo itself); if ${seedCmd} does not exist, report stopped with error=no_source and say to pass args.pipeline. `) +
  `Write only what that command writes. Return what it copied, kept and wrote.`,
  opts('seed', 'Seed', 'lint', SEED_SCHEMA),
)
if (!seeded || seeded.stopped) {
  log(`Seeding stopped: ${(seeded && seeded.stop_reason) || 'the stage failed to report'}`)
  return { status: 'failed_at_seed', stop_reason: (seeded && seeded.stop_reason) || '' }
}
log(`Seeded ${DIR}: ${seeded.copied} pipeline file(s) copied, CLAUDE.md ${seeded.claude_md}${seeded.differing_kept.length ? `, ${seeded.differing_kept.length} differing file(s) kept` : ''}`)

// ---- Intake: ask before assuming. One read of the source for what only the person can answer, before any sketch or doc
// is written on a guess. With on_question 'assume', the recommended options become shared answers for every later stage,
// so every author builds on the same assumption instead of each picking its own.
phase('Intake')
const INTAKE_SCHEMA = {
  type: 'object',
  properties: { ...QA, notes: { type: 'string' } },
  required: ['questions', 'assumptions'],
}
const intake = await agent(
  GUARD + WHERE + CTX + answersFor('intake') + `Read ${SOURCE} in full (a long brief in chunks, to the last line), and enough of the tree in ${DIR} to know what exists if it has code. ` +
  `You are the intake for a design run: before anyone sketches an architecture or writes a doc, find every blocking question. ` + BLOCKING_DEF +
  `Ask only where a wrong guess would send the architecture, the roadmap's order or the first milestone the wrong way; prefer a few high-value questions, and never one the framing or the answers above already settle. ` +
  `Each question: why it blocks (where each option sends the design), 2-4 concrete options, and the one you recommend. ` +
  `Return no questions when nothing blocks. In assumptions, list what you would otherwise take as given that the source does not state. Read-only: write no files.`,
  opts('intake', 'Intake', 'intake', INTAKE_SCHEMA),
)
noteAssumptions('intake', intake)
if (asked(intake)) {
  const qs = tagQuestions('intake', intake.questions)
  if (ON_Q !== 'assume') return needsInput(qs, { seeded })
  for (const q of qs) {
    ANSWERS.push({ id: q.id, stage: 'intake', question: q.question, answer: `${q.recommended} (assumed: the person chose to proceed on recommendations)` })
    ASSUMED.push({ stage: 'intake', assumption: `${q.question} -> ${q.recommended}` })
  }
  log(`Intake: proceeding on ${qs.length} recommended answer(s) (on_question: assume)`)
} else {
  log('Intake: no blocking questions')
}

if (BRIEF_MODE) {
  // ---- Architecture: independent sketches, a judge, then /roadmap writes the docs
  phase('Architecture')
  const ANGLES = [
    { key: 'validate-first', text: 'Validation first: the smallest architecture that ships the source\'s cheapest experiment within weeks and grows into the full product without a rewrite. Defer everything the experiment does not need, but say where each deferred piece will go.' },
    { key: 'trust-first', text: 'Security, privacy and correctness first: minimise where sensitive data lives and for how long, process locally where that helps, draw explicit trust boundaries, and design failure modes that never give a wrong answer silently.' },
    { key: 'operate-first', text: 'Operations and cost first: the cheapest reliable hosting a small team can run, managed services over self-run ones, zero-touch deploys, observability, rollback, and the cost per user at the target scale.' },
  ]
  if (PANEL > 0) {
    const sketches = (await parallel(Array.from({ length: PANEL }, (_, i) => () => {
      const angle = ANGLES[i % ANGLES.length]
      return agent(
        GUARD + WHERE + CTX + answersFor('architecture') + `Read ${SOURCE} in full, and the existing tree in ${DIR} if it has code. Sketch an architecture for it from this angle — ${angle.text} ` +
        `Cover components and technologies, data flow, the major decisions with the options you weighed, security and privacy, how it is deployed and operated ` +
        `(environments, CI/CD, secrets, migrations, monitoring, rollback, release gates such as legal review or store submission), ordered milestones with exit criteria ` +
        `(mark the ones a person must do), the assumptions the design rests on that nobody has verified, and your sketch's weaknesses. ` +
        `Read-only: write no files. Ground every claim about the source in its text.`,
        opts(`sketch:${angle.key}${i >= ANGLES.length ? `-${i}` : ''}`, 'Architecture', 'sketch', SKETCH_SCHEMA),
      ).then(s => s && { angle: angle.key + (i >= ANGLES.length ? `-${i}` : ''), ...s })
    }))).filter(Boolean)
    if (sketches.length) {
      judged = await agent(
        GUARD + WHERE + CTX + answersFor('architecture') + `Judge these independent architecture sketches for ${SOURCE} (read it in full first). Score each 1-5 on: fit to the source's constraints ` +
        `(builder, budget, timeline, licence, revenue model), time to the first validation, security and privacy, operability and cost, simplicity, and room to grow; ` +
        `total the scores. Then write the synthesis to build on: the winner, with any clearly better idea from the others grafted in, naming what came from where and why. ` +
        `Keep every decision with its options and choice. Read-only: write no files.\n\nSKETCHES:\n${JSON.stringify(sketches, null, 1)}`,
        opts('judge', 'Architecture', 'judge', JUDGE_SCHEMA),
      )
      if (judged) log(`Architecture panel: ${judged.scores.map(s => `${s.sketch} ${s.total}`).join(', ')}; building on ${judged.winner}`)
    }
  }
  arch = await agent(
    WORK + CTX + ASK('architecture') + `Invoke the Skill tool with skill "roadmap" with args ${JSON.stringify(`${A.brief}${OUT_FLAG}${A.force ? ' --force' : ''}`)}. ` +
    (judged ? `Build on this architecture synthesis from an independent panel (a strong input, not a substitute for reading the source; where it contradicts the source, the source wins and you say so):\n${judged.synthesis}\n` : '') +
    `Then run ${LINT} <roadmap> --roadmap --json and return the milestones from it, with the paths of architecture.md and roadmap.md relative to ${DIR}.`,
    opts('roadmap', 'Architecture', 'roadmap', ROADMAP_SCHEMA),
  )
  noteAssumptions('architecture', arch)
  if (asked(arch)) return needsInput(tagQuestions('architecture', arch.questions), { seeded, panel: judged })
  if (!arch || arch.stopped) {
    log(`/roadmap stopped: ${(arch && arch.stop_reason) || 'the stage failed to report'}`)
    return { status: 'failed_at_roadmap', stop_reason: (arch && arch.stop_reason) || '', seeded, panel: judged }
  }
  log(`Wrote ${arch.architecture} and ${arch.roadmap}: ${arch.milestones.length} milestones`)
  archReview = await reviewLoop(
    [arch.architecture, arch.roadmap],
    `These are the architecture and roadmap for ${SOURCE}: judge them against the source (every requirement, constraint, risk and validation step it states), ` +
    `for sound decisions, a deploy and operations plan, and milestones in an order that validates the riskiest assumptions first with every person-only step as a human gate. `,
    'architecture', 'Architecture', 'architecture',
  )
  if (archReview.questions.length) return needsInput(archReview.questions, { seeded, architecture: arch, panel: judged, architecture_review: archReview })
  if (!archReview.reviewed) return { status: 'review_failed', architecture: arch, panel: judged, architecture_review: archReview }
  if (!archReview.clean) {
    log('Architecture or roadmap still has blocking findings — stopping before any proposal is written')
    return { status: 'blocked_at_architecture_review', architecture: arch, panel: judged, architecture_review: archReview }
  }
  // Re-read the milestones: a revise round may have renumbered or renamed them.
  const fresh = await agent(
    GUARD + WHERE + `Run ${LINT} ${arch.roadmap} --roadmap --json in ${DIR} and return its milestones, out_dir ${JSON.stringify(arch.out_dir)}, ` +
    `architecture ${JSON.stringify(arch.architecture)} and roadmap ${JSON.stringify(arch.roadmap)}. Change nothing.`,
    opts('milestones', 'Architecture', 'lint', ROADMAP_SCHEMA),
  )
  if (fresh && !fresh.stopped) arch = fresh

  // ---- Proposals: one per pending milestone that names a proposal, each reviewed until clean (no barrier between milestones)
  phase('Proposals')
  const wanted = arch.milestones.filter(m => !m.done && !m.human_gate && m.proposal && (!ONLY || ONLY.includes(m.n)))
  const todo = MAX_M ? wanted.slice(0, MAX_M) : wanted
  const skipped = arch.milestones.filter(m => !m.done && !m.human_gate && m.proposal && !todo.includes(m))
  if (skipped.length) log(`Not proposing milestones ${skipped.map(m => m.n).join(', ')} (${ONLY ? 'args.milestones' : ''}${ONLY && MAX_M ? ', ' : ''}${MAX_M ? 'args.max_milestones' : ''}); propose them later with /propose --milestone=N`)
  log(`Proposing ${todo.length} milestone(s): ${todo.map(m => `${m.n} ${m.title}`).join('; ')}`)
  const results = await pipeline(
    todo,
    m => agent(
      WORK + CTX + ASK(`m${m.n}`) + `Invoke the Skill tool with skill "propose" with args ${JSON.stringify(`--milestone=${m.n} ${arch.roadmap}${OUT_FLAG}`)}. ` +
      `Other milestones' proposals may be written at the same time: reference another proposal's step in Depends on only if that file exists now; ` +
      `ordering between milestones is the roadmap's job. Return the proposal path relative to ${DIR}.`,
      opts(`propose:m${m.n}`, 'Proposals', 'propose', PROPOSE_SCHEMA),
    ),
    (p, m) => noteAssumptions(`m${m.n}`, p) && asked(p)
      // This milestone waits on the person; the other milestones carry on.
      ? { milestone: m.n, title: m.title, doc: m.proposal, needs_input: true, questions: tagQuestions(`m${m.n}`, p.questions) }
      : (p && !p.stopped)
      ? reviewLoop(
        [p.doc],
        `This proposal implements milestone ${m.n} ("${m.title}") of ${arch.roadmap}; judge it against that milestone's scope and exit criteria, ${arch.architecture}, and ${SOURCE}. `,
        `m${m.n}`, 'Proposals', `m${m.n}`,
      ).then(r => ({ milestone: m.n, title: m.title, ...p, review: r, questions: r.questions }))
      : { milestone: m.n, title: m.title, doc: m.proposal, failed: true, stop_reason: (p && p.stop_reason) || 'the stage failed to report' },
  )
  proposals.push(...results.filter(Boolean))
} else {
  // ---- Concern mode: one proposal, reviewed until clean
  phase('Proposals')
  const p = await agent(
    WORK + CTX + ASK('proposal') + `Invoke the Skill tool with skill "propose" with the concern below as args${A.out ? ` (prefix them with --out=${A.out})` : ''}. ` +
    `Rewrite any --prefixed token inside the concern text (e.g. "--json" -> "the json flag") so the skill never reads it as one of its own flags. ` +
    `Return the proposal path relative to ${DIR}.\n${JSON.stringify(A.concern)}`,
    opts('propose', 'Proposals', 'propose', PROPOSE_SCHEMA),
  )
  noteAssumptions('proposal', p)
  if (asked(p)) return needsInput(tagQuestions('proposal', p.questions), { seeded })
  if (!p || p.stopped) {
    log(`/propose wrote no proposal: ${(p && p.stop_reason) || 'the stage failed to report'}`)
    return { status: 'failed_at_propose', stop_reason: (p && p.stop_reason) || '' }
  }
  const r = await reviewLoop([p.doc], `This proposal is for ${SOURCE}; judge it against that concern and today's tree. `, 'proposal', 'Proposals', 'proposal')
  if (r.questions.length) return needsInput(r.questions, { seeded, proposals: [{ doc: p.doc, review: r }] })
  proposals.push({ ...p, review: r })
}

const written = proposals.filter(p => !p.failed && !p.needs_input)
// Questions a milestone's author or reviser raised: the docs cannot be checked against each other until they are answered.
const pendingQs = proposals.flatMap(p => p.questions || [])
const allDocs = (arch ? [arch.architecture, arch.roadmap] : []).concat(written.map(p => p.doc))

// ---- Consistency: needs every doc at once (barrier). Blocking findings and coverage gaps are revised, one reviser per doc,
// then every revised doc is reviewed again, so nothing changed after its review counts as clean unchecked.
let consistency = null, consistencyOk = true
const deferredAll = [archReview].concat(proposals.map(p => p.review)).filter(Boolean).flatMap(r => r.deferred || [])
if (BRIEF_MODE && written.length && pendingQs.length) {
  consistencyOk = false
  log(`Consistency skipped: ${pendingQs.length} question(s) from the Proposals phase must be answered first`)
} else if (BRIEF_MODE && written.length) {
  phase('Consistency')
  consistency = await agent(
    WORK + REVIEW_CTX + answersFor('consistency') + `Read ${SOURCE}, then every one of these docs in full: ${allDocs.join(', ')}. Report cross-doc problems: interfaces, data models or names that disagree; ` +
    `work planned twice or by no doc; a proposal that contradicts a decision in ${arch.architecture}; Depends on references that point at the wrong step; ` +
    `milestone order that builds on something not yet built or validated; a production release gated both in the roadmap and in a proposal; parts of the source no doc plans for (coverage_gaps). ` +
    `Each finding names the ONE doc that should change, by its path relative to ${DIR}. Read-only: write no files.` +
    (deferredAll.length ? `\nThe per-doc reviews raised these findings about docs other than the one they reviewed; check each and report the ones that hold:\n${JSON.stringify(deferredAll, null, 1)}` : ''),
    opts('consistency', 'Consistency', 'consistency', CONSISTENCY_SCHEMA),
  )
  if (!consistency) {
    consistencyOk = false
    log('The consistency pass failed to report — the docs were not checked against each other')
  } else {
    const bad = blocking(consistency.findings)
    const gaps = consistency.coverage_gaps.map(g => ({ doc: arch.roadmap, severity: 'concern', description: `Coverage gap: ${g}. Plan it in a milestone (or the proposal that should hold it), or state in Out of scope why it is not planned.` }))
    log(`Consistency: ${consistency.findings.length} findings (${bad.length} blocking), ${gaps.length} coverage gaps`)
    const known = new Set(allDocs.map(norm))
    const byDoc = {}
    for (const f of bad.concat(gaps)) { const d = norm(f.doc); (byDoc[d] = byDoc[d] || []).push(f) }
    const targets = Object.keys(byDoc).filter(d => known.has(d))
    consistency.unrouted = Object.keys(byDoc).filter(d => !known.has(d)).map(d => ({ doc: d, findings: byDoc[d] }))
    if (consistency.unrouted.length) { consistencyOk = false; log(`Findings name docs this run did not write: ${consistency.unrouted.map(u => u.doc).join(', ')}`) }
    const fixes = await parallel(targets.map((doc, i) => () => agent(
      WORK + CTX + ASK('consistency') + `Invoke the Skill tool with skill "propose" with args "--revise ${doc}", applying these cross-doc findings; decline any you can verify is wrong and give the reason. ` +
      `A finding only the person can settle is a blocking question, per QUESTIONS: never decline it or pick a side. ` +
      `Edit only ${doc}. Re-run ${LINT} ${doc} until it reports no errors.\n${JSON.stringify(byDoc[doc], null, 2)}`,
      opts(`revise:consistency-${i + 1}`, 'Consistency', 'revise', REVISE_SCHEMA),
    ).then(r => ({ doc, ...(r || { failed: true }) }))))
    consistency.revisions = fixes.map((f, i) => f || { doc: targets[i], failed: true })
    for (const f of consistency.revisions) noteAssumptions('consistency', f)
    consistency.questions = tagQuestions('consistency', consistency.revisions.flatMap(f => f.questions || []))
    if (consistency.revisions.some(f => f.failed)) { consistencyOk = false; log('A consistency revision failed to report') }
    const revised = consistency.revisions.filter(f => !f.failed && !asked(f)).map(f => f.doc)
    const rechecks = await parallel(revised.map((doc, i) => () => reviewLoop(
      [doc], `This doc was just revised for cross-doc consistency; judge it against ${SOURCE}, ${arch.architecture} and the docs it references. `, `recheck-${i + 1}`, 'Consistency', 'consistency')))
    consistency.rechecks = rechecks.map((r, i) => r || { docs: [revised[i]], clean: false, reviewed: false, questions: [] })
    // Renumber so every consistency question keeps a distinct id across the revisions and the re-reviews.
    consistency.questions = consistency.questions.concat(consistency.rechecks.flatMap(r => r.questions || []))
      .map(({ id, stage, ...q }, i) => ({ id: `consistency.q${i + 1}`, stage: 'consistency', ...q }))
    if (consistency.questions.length) consistencyOk = false
    if (consistency.rechecks.some(r => !r.clean)) { consistencyOk = false; log('A doc revised for consistency did not come back clean from its re-review') }
  }
}

// ---- Lint: the deterministic gate on every doc, plus a preview of each proposal's lanes and the roadmap's progress
phase('Lint')
const lint = await agent(
  GUARD + WHERE + `In ${DIR}, run ${LINT} <doc> --json on each of: ${allDocs.join(', ')}; run ${LINT} <doc> --lanes --allow-draft on each proposal ` +
  `(a preview of how it splits once a person accepts it: the docs are drafts, and without --allow-draft every lane would show as blocked)` +
  (arch ? `; and ${LINT} ${arch.roadmap} --roadmap --json` : '') + `. Report per doc the error and warning counts and their messages, ` +
  `per proposal the --lanes errors (e.g. lane_cycle) and the number of chains, lanes, blocked lanes and pending human gates, and the next actionable milestones. Change nothing.`,
  opts('lint', 'Lint', 'lint', LINT_SCHEMA),
)
const lintErrors = lint ? lint.docs.reduce((n, d) => n + d.errors, 0) + lint.lanes.reduce((n, l) => n + (l.errors || 0), 0) : null
const unclean = written.filter(p => !p.review || !p.review.clean)
const laterDocs = BRIEF_MODE ? written.slice().sort((a, b) => a.milestone - b.milestone).slice(1).map(p => p.doc) : []

const questions = pendingQs.concat((consistency && consistency.questions) || [])
if (questions.length) logQuestions(questions)
const status = questions.length ? 'needs_input'
  : !lint ? 'lint_failed'
  : lintErrors ? 'lint_errors'
  : (unclean.length || proposals.some(p => p.failed) || !consistencyOk) ? 'proposals_need_attention'
  : 'ready'
log(`Status: ${status}`)
return {
  status,
  ...(questions.length ? { questions, relay: RELAY } : {}),
  assumptions: ASSUMED,
  seeded,
  out_dir: arch ? arch.out_dir : null,
  architecture: arch ? arch.architecture : null,
  roadmap: arch ? arch.roadmap : null,
  panel: judged ? { winner: judged.winner, scores: judged.scores } : null,
  architecture_review: archReview,
  proposals: proposals.map(p => ({ milestone: p.milestone, title: p.title, doc: p.doc, failed: !!p.failed, needs_input: !!(p.questions && p.questions.length), stop_reason: p.stop_reason || null, clean: !!(p.review && p.review.clean), findings_remaining: p.review ? p.review.findings_remaining : null })),
  deferred_findings: BRIEF_MODE ? undefined : deferredAll,
  consistency,
  lint,
  next_steps: [
    questions.length ? `First answer the ${questions.length} question(s) in questions (see relay): the docs that raised them are unwritten or unrevised, and the Consistency phase waits on them.` : null,
    'Read and edit the docs. They are drafts (Status: draft): set Status: accepted on each one you approve; nothing is built or bootstrapped from a draft.',
    // Every proposal was written against today's tree, which the earlier milestones will change before the later ones build.
    laterDocs.length ? `Accept the proposals one milestone at a time, in roadmap order. Before accepting each one after the first (${laterDocs.join(', ')}), once the milestones before it have merged, ` +
      `re-run /review-proposal <doc> against the tree as it is then, and /propose --revise <doc> on its findings: a Files: list or interface the earlier milestones changed is a review concern then, not a stalled lane later.` +
      (MAX_M ? '' : ` For a long roadmap, run with max_milestones: 1 instead and propose each later milestone with /propose --milestone=N when it comes up.`) : null,
    'Do every research or decision gate the docs list that blocks design choices, record its Outcome, and run /propose --revise <doc> on the docs whose steps depend on it.',
    arch ? `Greenfield: run /bootstrap ${arch.architecture} in the clean repository (one commit, holding the docs too, on a bootstrap/<date> branch), ship it with plan-to-merged-pr { ship_only: true, branch, title } and merge it (an empty remote gets the root commit on local main instead, which you push), protect main and require the CI check; once that PR has merged and CI is green on main, add the bootstrap milestone's Outcome (CI green at <sha>; main protected), tick it (${LINT} ${arch.roadmap} --tick <n>) and land that through a docs PR.` : null,
    'Existing repo: land the seeded pipeline files, the CLAUDE.md changes and the accepted docs through an ordinary PR (commit them on a branch, /create-pr, merge) — lanes are cut from origin and read the proposal and the commands there.',
    `Build each proposal when its roadmap dependencies are done: proposal-build-chain { proposal: '<doc>', dir: '<checkout>', root: '<worktrees dir>', date: '<YYYYMMDD>' }.`,
    'Do every human-gated step yourself and tick it; lanes that depend on one stay blocked until it is ticked.',
  ].filter(Boolean),
}

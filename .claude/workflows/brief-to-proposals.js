export const meta = {
  name: 'brief-to-proposals',
  description: 'Turn a product brief (or one change too big for a PR) into reviewed design docs: seed the repo with the pipeline and a base CLAUDE.md, architecture panel, /roadmap, /propose per code milestone, /review-proposal and revise until clean, cross-doc consistency two docs at a time, then lint and lanes. A re-run starts at the stage that needs it (args.from, else inferred from the answers and the docs on disk) and keeps the docs already written. Writes only the seeded pipeline files, CLAUDE.md and design docs, never code; it commits only with args.branch, as checkpoints on that design branch (never main)',
  whenToUse: 'Before building a new product or a change too big for one PR. It writes the architecture, roadmap and proposals that /bootstrap and proposal-build-chain consume. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with answers and from, as its relay says. Pass branch to checkpoint the docs on a design branch, so they outlive the session and a re-run from any clone picks them up.',
  phases: [
    { title: 'Seed', detail: 'with branch, check out the design branch first; /seed installs the pipeline\'s skills, workflows and scripts and a base CLAUDE.md into the repo; then find the design docs that already exist' },
    { title: 'Intake', detail: 'read the source for blocking questions only the person can answer, before any design is written' },
    { title: 'Architecture', detail: 'independent sketches and a judge (the synthesis is saved to the state branch), then /roadmap writes architecture.md and roadmap.md (existing ones are resumed instead), reviewed until clean' },
    { title: 'Proposals', detail: '/propose per roadmap code milestone (when the docs already existed, only the answered or unwritten ones), then /review-proposal and /propose --revise until clean' },
    { title: 'Consistency', detail: 'the docs compared two at a time (the architecture and each proposal, the proposals of dependent milestones, the brief and the roadmap); findings revised in the doc they name, then re-reviewed' },
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
//   context_file?: string     a file (relative to dir) whose text every author reads and treats as binding framing, like context; it is
//                             never committed and never saved to the state branch
//   from?: string             brief mode: the stage to start at, 'intake' | 'architecture' | 'proposals' | 'consistency' | 'lint'.
//                             Default, inferred: the earliest stage among the answers' ids when architecture.md and roadmap.md exist,
//                             else 'proposals' when they exist, else 'intake'. 'architecture' with the docs resumes their review (no
//                             /roadmap); without them, /roadmap runs on the panel synthesis saved on the state branch
//                             (design/panel-synthesis.md), or on a new panel when none is saved. 'proposals' or later skips the
//                             Intake, the panel and /roadmap and uses the existing docs: it re-proposes only the milestones whose
//                             question was answered or whose proposal does not exist yet (or exactly args.milestones), keeps the
//                             rest, then checks consistency over all docs and lints. 'consistency' keeps every proposal; 'lint' only
//                             lints. A needs_input result names the stage to pass (resume_from).
//   branch?: string           a design branch for checkpoints, e.g. 'design/20261110', never main. Before seeding, the checkout switches
//                             to it: origin's branch when it exists (so a re-run from a fresh clone continues it), else a new branch
//                             from origin/<MAIN_BRANCH>. After Architecture, Proposals and Consistency an agent commits the docs written
//                             so far, the seeded .claude files and CLAUDE.md (never the brief or the context file) and pushes the
//                             branch. Without branch the run commits nothing.
//   commit_trailers?: string[] lines each checkpoint commit ends with (default ['Co-Authored-By: Claude <noreply@anthropic.com>'])
//   github_access?: string    'gh' | 'connector' (default '': GITHUB_ACCESS from the Pipeline config, else gh); passed into the prompts
//                             that reach the remote. git fetch and push stay plain git in either mode.
//   panel?: number            independent architecture sketches before /roadmap (default 3; 0 = skip the panel)
//   milestones?: number[]     propose only these roadmap milestones, written or not (default: every pending milestone that names a
//                             proposal; when the docs already existed, the ones answered or not yet written)
//   max_milestones?: number   propose at most the first N of those, in roadmap order (e.g. 1 to try the flow on one milestone; 1 is
//                             recommended for a long roadmap, since later proposals go stale as earlier milestones change the tree)
//   force?: boolean           regenerate from scratch: let /roadmap overwrite an existing architecture.md / roadmap.md (default false).
//                             It starts at the Intake, or with from: 'architecture' at /roadmap on the saved panel synthesis
//   max_review_rounds?: number  revise rounds per doc (default 3)
//   efforts?: { intake, sketch, judge, roadmap, propose, review, revise, consistency, lint }  (lint also sets the mechanical agents:
//                             branch, seed, existing-docs, save-panel, milestones and checkpoints)
//   on_question?: 'stop'|'assume'  default 'stop': blocking questions (ones only the person can answer) stop the run with status
//                             needs_input before anything is built on a guess; 'assume' takes each recommended option instead
//                             (the Intake's become shared answers for every later stage) and lists them in assumptions
//   answers?: [{ id, answer }] the questions a needs_input result returned, each with the person's answer (or { <id>: answer });
//                             each reaches the stage that asked and every later one (a milestone's only that milestone's
//                             stages); a re-run with from (resume_from) starts at the stage that asked and keeps the docs written
const A = args || {}
if (!A.dir) throw new Error('brief-to-proposals: args.dir (absolute project directory) is required')
if (!A.brief === !A.concern) throw new Error('brief-to-proposals: pass exactly one of args.brief (a product brief path) or args.concern (one large change)')
const DIR = String(A.dir).replace(/\/+$/, '')
const BRIEF_MODE = !!A.brief
// Agents may name a doc absolutely, relative to DIR, or with a leading ./ — compare them as DIR-relative paths.
const norm = d => String(d || '').trim().replace(new RegExp('^' + DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), '').replace(/^\.\//, '')
const STAGES = ['intake', 'architecture', 'proposals', 'consistency', 'lint']
const at = s => STAGES.indexOf(s)
const FROM_ARG = A.from === undefined || A.from === null ? '' : String(A.from)
if (FROM_ARG && !STAGES.includes(FROM_ARG)) throw new Error(`brief-to-proposals: args.from must be one of ${STAGES.join(', ')}`)
if (FROM_ARG && !BRIEF_MODE && FROM_ARG !== 'intake') throw new Error('brief-to-proposals: args.from is for brief mode; concern mode always starts at the Intake')
if (A.force && at(FROM_ARG) > at('architecture')) throw new Error(`brief-to-proposals: force regenerates architecture.md and roadmap.md, so it cannot start at from: '${FROM_ARG}'`)
const BRANCH = A.branch === undefined || A.branch === null ? '' : String(A.branch).trim()
if ((A.branch !== undefined && A.branch !== null && !BRANCH) || /\s/.test(BRANCH) || BRANCH.startsWith('-') ||
  ['main', 'master', 'HEAD'].includes(BRANCH.replace(/^(refs\/heads\/|origin\/)/, ''))) throw new Error('brief-to-proposals: args.branch must name a design branch such as design/20261110, never main')
const GH_ACCESS = A.github_access || ''
if (!['', 'gh', 'connector'].includes(GH_ACCESS)) throw new Error("brief-to-proposals: args.github_access must be 'gh' or 'connector' ('' reads GITHUB_ACCESS from the Pipeline config)")
const CTX_FILE = A.context_file ? String(A.context_file).trim() : ''
// The checkpoints stage these seeded paths besides the docs; the brief and the context file must never be among them.
const SEEDED_DIRS = ['.claude/commands', '.claude/skills', '.claude/workflows', '.claude/scripts']
const inSeeded = p => SEEDED_DIRS.some(d => p.startsWith(d + '/')) || ['.claude/pipeline-manifest.json', '.claude/settings.json', 'CLAUDE.md'].includes(p)
if (BRANCH) for (const [k, v] of [['brief', A.brief], ['context_file', CTX_FILE]]) {
  if (v && inSeeded(norm(v))) throw new Error(`brief-to-proposals: args.${k} (${v}) lies in a path the branch checkpoints commit; move it out of .claude/ and CLAUDE.md`)
}
const PRIVATE = new Set([A.brief, CTX_FILE].filter(Boolean).map(norm))
const BRIEF_REL = BRIEF_MODE ? norm(A.brief) : ''
const OUT_FLAG = A.out ? ` --out=${A.out}` : ''
const OUT_TEXT = A.out ? A.out : 'PROPOSALS_DIR from the "## Pipeline config" section of CLAUDE.md, else docs/design'
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
const TRAILERS = (Array.isArray(A.commit_trailers) && A.commit_trailers.length ? A.commit_trailers : ['Co-Authored-By: Claude <noreply@anthropic.com>']).join('\n')

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path); record it as blocked and report it. `
const WHERE = `Work ONLY in ${DIR} (cd there / use absolute paths). `
const DOCS_ONLY = `This is design work: write only design docs in the proposals directory. Never write code, never commit, stage, push, ` +
  `create a branch or open a PR, and change no git state. `
const CTX_FILE_NOTE = CTX_FILE
  ? `Before anything else, read ${CTX_FILE} (relative to ${DIR}) in full: its text is framing from the person, binding unless a source fact contradicts it. Docs may state the constraints it sets; never copy personal data or credentials from it. `
  : ''
const CTX = (A.context ? `Framing from the person (binding unless a source fact contradicts it): ${A.context}\n` : '') + (CTX_FILE ? CTX_FILE_NOTE + '\n' : '')
const REVIEW_CTX = (A.context ? `The authors were told to follow this framing from the person as binding (unless a source fact contradicts it); a choice that follows it is not a defect: ${A.context}\n` : '') +
  (CTX_FILE ? `The authors were also told to treat the text of ${CTX_FILE} (relative to ${DIR}; read it) as binding framing from the person, unless a source fact contradicts it: a choice that follows it is not a defect.\n` : '')
const WORK = GUARD + WHERE + DOCS_ONLY
const SOURCE = BRIEF_MODE ? `the product brief ${A.brief}` : `the concern ${JSON.stringify(A.concern)}`
const LINT = `python3 .claude/scripts/proposal-lint.py`
const STATE = `python3 .claude/scripts/pipeline-state.py`
const PIPELINE = A.pipeline ? String(A.pipeline).replace(/\/+$/, '') : ''
const GITHUB = `Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. ` +
  (GH_ACCESS ? `The access in use is ${GH_ACCESS} (this run's github_access). ` : `The access in use is GITHUB_ACCESS from the "## Pipeline config" section of CLAUDE.md, default gh. `) +
  `git fetch and git push stay plain git in either mode. `

// ---- Questions before assumptions. No one can answer an agent mid-run: a stage that needs the person's answer returns its
// questions and the run stops with needs_input; the caller asks the person and re-runs with args.answers (and args.from).
// Scopes in run order: intake, architecture, a proposal (m<N>, or 'proposal' in concern mode), consistency. An answer reaches
// the scope that asked and every later one, never an earlier one; a milestone's answer reaches only that milestone (and
// consistency).
const ON_Q = A.on_question === 'assume' ? 'assume' : 'stop'
const scopeOf = id => String(id || '').split('.')[0]
const scopeOrder = sc => sc === 'intake' ? 0 : sc === 'architecture' ? 1 : sc === 'consistency' ? 3 : 2
// The stage (an args.from value) a question scope belongs to: m<N> and 'proposal' are the Proposals stage.
const stageOfScope = sc => sc === 'intake' || sc === 'architecture' || sc === 'consistency' ? sc : 'proposals'
const earliestStage = scopes => STAGES.find(s => scopes.some(sc => stageOfScope(sc) === s))
const ANSWERS = (Array.isArray(A.answers) ? A.answers : Object.entries(A.answers || {}).map(([id, answer]) => ({ id, answer })))
  .filter(a => a && a.answer !== undefined && a.answer !== null && String(a.answer).trim() !== '')
  .map(a => ({ ...a, stage: a.stage || scopeOf(a.id) }))
const ANSWERED_MILESTONES = new Set(ANSWERS.map(a => /^m(\d+)$/.exec(a.stage)).filter(Boolean).map(x => Number(x[1])))
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
const relay = from => `Ask the person these questions yourself, all at once, each with its options and the recommended one first; never answer them on their behalf. ` +
  (from
    ? `Then re-run this workflow with the same args plus answers (each question's id with the person's answer, added to any answers given before) and from: '${from}' (this result's resume_from), ` +
      `from this session or a new one: it keeps the docs already written and starts again at the stage that asked. In this session, resumeFromRunId set to this run's id also replays the unchanged stages before it from the record.`
    : `Then re-run this workflow with the same args plus answers (each question's id with the person's answer) and resumeFromRunId set to this run's id: ` +
      `the stages before the ones that asked replay from the record, and docs already written are kept.`)
const logQuestions = questions => {
  log(`${questions.length} question(s) only the person can answer — status needs_input`)
  for (const q of questions) log(`  ${q.id}: ${q.question} (recommended: ${q.recommended})`)
}

// What every result past the start carries: the stage this run started at (brief mode) and, with branch, its checkpoints.
let FROM = null, branchInfo = null
const checkpoints = []
const branchOut = () => ({ name: BRANCH, action: (branchInfo && branchInfo.action) || '', recovered: (branchInfo && branchInfo.recovered) || [], checkpoints })
const runInfo = () => ({ ...(BRIEF_MODE && FROM ? { from: FROM } : {}), ...(BRANCH ? { branch: branchOut() } : {}) })
const needsInput = (questions, extra) => {
  logQuestions(questions)
  const from = BRIEF_MODE ? earliestStage(questions.map(q => q.stage)) : ''
  return { status: 'needs_input', questions, relay: relay(from), ...(from ? { resume_from: from } : {}), assumptions: ASSUMED, ...runInfo(), ...(extra || {}) }
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
    proposal_exists: { type: 'boolean', description: 'the lint\'s proposal_exists: the proposal file exists' },
    depends: { type: 'array', items: { type: 'integer' }, description: 'the milestones this one depends on (the lint\'s depends)' },
  },
  required: ['n', 'title', 'done', 'human_gate', 'proposal', 'proposal_exists', 'depends'],
}
const MILESTONES_FROM_LINT = `return every milestone it reports: n, title, done, human_gate, proposal (the path relative to ${DIR}; the lint reports it relative to the roadmap's directory), proposal_exists and depends`
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
  properties: { findings: { type: 'array', items: FINDING }, coverage_gaps: { type: 'array', items: { type: 'string' }, description: 'parts of the source no doc plans for (the brief and roadmap pair only)' } },
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
const CHECKPOINT_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean' },
    commit: { type: 'string', description: 'the checkpoint commit, or empty' },
    pushed: { type: 'boolean', description: 'origin\'s branch now holds every commit of the local branch' },
    files: { type: 'array', items: { type: 'string' }, description: 'paths in the commit' },
    reason: { type: 'string', description: 'when nothing was committed or pushed: why (nothing_to_commit, wrong_branch, git_identity_missing, push_rejected: <git\'s message>, ...)' },
  },
  required: ['committed', 'commit', 'pushed', 'files'],
}
const blocking = list => list.filter(f => f.severity === 'bug' || f.severity === 'concern')


// Review docs with /review-proposal and revise with /propose --revise until no bug or concern remains.
// Same shape as plan-to-merged-pr's review loop: suggestions and nits get one revise round, defects block.
// A reviser edits only the docs under review; findings about any other doc are deferred to the Consistency phase
// (with the docs they were raised against), so two concurrent loops never rewrite the same roadmap or architecture.
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
    for (const f of review.findings) if (!own.has(norm(f.doc)) && !deferred.some(d => d.description === f.description)) deferred.push({ ...f, raised_by: [...own] })
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

// With branch: commit the docs written so far, the seeded pipeline files and CLAUDE.md on the design branch, and push it.
// The paths are an explicit list, so the brief and the context file (PRIVATE) are never staged. Best effort: a checkpoint that
// fails is recorded in the result and the run goes on.
async function checkpoint(ph, docs, subject) {
  if (!BRANCH) return null
  const paths = [...new Set(docs.filter(Boolean).map(norm))].filter(p => p && !PRIVATE.has(p))
  const r = await agent(
    GUARD + WHERE + GITHUB + `Checkpoint the design work on the branch ${BRANCH}; never commit on or push to any other branch, main above all. ` +
    `1. git rev-parse --abbrev-ref HEAD must print ${BRANCH}; anything else: commit nothing, push nothing, and report reason wrong_branch. ` +
    `2. git reset -q (it unstages anything staged before and leaves the working tree as it is). ` +
    `3. Stage these paths, each one that exists, and nothing else: the design docs ${paths.join(', ')}; the pipeline files /seed installed, ` +
    `${SEEDED_DIRS.join(', ')} and .claude/pipeline-manifest.json; .claude/settings.json only when git does not track it yet (/seed created it); and CLAUDE.md. ` +
    `Stage each with git add -- <path>: never git add -A, git add ., git add -f or any other path. ` +
    `4. git diff --cached --name-only: unstage (git reset -q -- <path>) anything outside those paths. ` +
    `5. Nothing staged: no commit (reason nothing_to_commit). Otherwise commit with this message, verbatim:\n${subject}\n\nWritten by the brief-to-proposals workflow; every doc is a draft until a person accepts it.\n\n${TRAILERS}\n` +
    `A commit refused for a missing git identity: report reason git_identity_missing; never set one. ` +
    `6. When the branch has commits origin lacks: git push -u origin ${BRANCH}. Never force, never push another branch, and on a rejection never pull, merge or rebase: report pushed=false with git's message. ` +
    `Report the commit, the files in it and whether origin has the branch now.`,
    opts(`checkpoint:${ph.toLowerCase()}`, ph, 'lint', CHECKPOINT_SCHEMA),
  )
  const c = r ? { after: ph, ...r } : { after: ph, committed: false, commit: '', pushed: false, files: [], reason: 'the checkpoint stage failed to report' }
  checkpoints.push(c)
  log(`Checkpoint after ${ph}: ${c.committed ? `committed ${String(c.commit).slice(0, 10)}` : `nothing committed${c.reason ? ` (${c.reason})` : ''}`}, ${c.pushed ? `pushed to origin/${BRANCH}` : 'not pushed'}`)
  return c
}

let arch = null, judged = null, archReview = null, panelSaved = null, reusedPanel = false
const proposals = []
let kept = []

// ---- Branch: with args.branch, the checkout moves to the design branch before anything is written, so every later file lands
// there and the checkpoints commit on it. Origin's branch is continued when it exists (a fresh clone resumes the docs on it).
phase('Seed')
if (BRANCH) {
  const BRANCH_SCHEMA = {
    type: 'object',
    properties: {
      branch: { type: 'string' },
      action: { type: 'string', enum: ['created', 'continued', 'current'], description: 'created from origin/<main>; switched to the existing branch; or already on it' },
      head: { type: 'string', description: 'HEAD after the switch' },
      recovered: { type: 'array', items: { type: 'string' }, description: 'design docs with uncommitted changes found on the branch, committed before seeding' },
      stopped: { type: 'boolean', description: 'true if the branch is not checked out (error= not_a_repo, no_remote, invalid_branch, branch_is_main, no_main, diverged, switch_blocked)' },
      stop_reason: { type: 'string', description: 'when stopped: the error code and what to do, with the files involved' },
    },
    required: ['branch', 'action', 'head', 'recovered', 'stopped'],
  }
  branchInfo = await agent(
    GUARD + WHERE + GITHUB + `Check out the design branch ${BRANCH} in ${DIR}, before anything in it is written. Never switch to, commit on or push main. ` +
    `1. git rev-parse --show-toplevel must succeed (else stop: error=not_a_repo), git remote get-url origin too (else error=no_remote), and git check-ref-format --branch ${BRANCH} (else error=invalid_branch). ` +
    `2. MAIN is MAIN_BRANCH from the "## Pipeline config" section of CLAUDE.md when there is one, else main. ${BRANCH} equal to MAIN, or to origin's default branch (git ls-remote --symref origin HEAD), stops with error=branch_is_main. ` +
    `3. git fetch origin. ` +
    `4. Already on ${BRANCH} (action current), or else origin/${BRANCH} or a local ${BRANCH} exists (action continued: git switch ${BRANCH}, which tracks origin's): when origin/${BRANCH} has commits HEAD lacks, git merge --ff-only origin/${BRANCH}; ` +
    `HEAD and origin/${BRANCH} diverged → stop: error=diverged (never rebase, reset or force). ` +
    `Neither exists (action created): origin/MAIN must exist, else stop: error=no_main (a remote without a main has nothing to branch from: push a first commit to main, or run without branch); then git switch --no-track -c ${BRANCH} origin/MAIN. ` +
    `A switch or fast-forward git refuses because local changes or untracked files would be overwritten → stop: error=switch_blocked, listing them. Never stash, discard, delete, clean or force anything. ` +
    `5. On ${BRANCH}, tracked files in the proposals directory (${OUT_TEXT}) with uncommitted changes whose first heading is "# Proposal:", "# Architecture:" or "# Roadmap:" are design docs an earlier run changed and did not checkpoint (never the file a design doc's Source: header names): ` +
    `stage exactly those (git add -- <each>) and commit them with this message, verbatim:\nCommit design doc changes found on the branch before the run\n\n${TRAILERS}\nList them in recovered. Leave every other change alone, and push nothing. ` +
    `Return the branch, the action, HEAD and recovered.`,
    opts('branch', 'Seed', 'lint', BRANCH_SCHEMA),
  )
  if (!branchInfo || branchInfo.stopped) {
    log(`Design branch ${BRANCH} not checked out: ${(branchInfo && branchInfo.stop_reason) || 'the stage failed to report'}`)
    return { status: 'failed_at_branch', stop_reason: (branchInfo && branchInfo.stop_reason) || 'the branch stage failed to report', branch: branchOut() }
  }
  log(`Design branch ${BRANCH}: ${branchInfo.action || 'checked out'} at ${String(branchInfo.head || '').slice(0, 10)}${(branchInfo.recovered || []).length ? `; committed ${branchInfo.recovered.length} changed doc(s) found on it` : ''}`)
}

// ---- Seed: the repo gets the pipeline's base files before any design work, so every author, reviewer and later session
// runs from files installed there (they ship in the bootstrap PR on a new repo, or an ordinary PR on an existing one).
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
  return { status: 'failed_at_seed', stop_reason: (seeded && seeded.stop_reason) || '', ...runInfo() }
}
log(`Seeded ${DIR}: ${seeded.copied} pipeline file(s) copied, CLAUDE.md ${seeded.claude_md}${seeded.differing_kept.length ? `, ${seeded.differing_kept.length} differing file(s) kept` : ''}`)

// ---- Existing docs (brief mode): what a re-run can keep, and the stage it starts at. Its prompt names the args that steer the
// start, so a resumed run (resumeFromRunId) with new answers or a new from looks at the disk again instead of replaying.
let survey = null, DOCS_EXIST = false
const surveyArch = () => ({ out_dir: survey.out_dir, architecture: survey.architecture, roadmap: survey.roadmap, milestones: survey.milestones || [], lint_clean: true, stopped: false, questions: [], assumptions: [] })
if (BRIEF_MODE) {
  const SURVEY_SCHEMA = {
    type: 'object',
    properties: {
      brief_exists: { type: 'boolean' },
      out_dir: { type: 'string', description: 'the proposals directory, relative to the project directory' },
      architecture: { type: 'string', description: '<out_dir>/architecture.md, whether or not it exists' },
      roadmap: { type: 'string', description: '<out_dir>/roadmap.md, whether or not it exists' },
      architecture_exists: { type: 'boolean' },
      roadmap_exists: { type: 'boolean' },
      milestones: { type: 'array', items: MILESTONE, description: 'from the lint\'s --roadmap, when roadmap.md exists' },
      panel_synthesis: { type: 'boolean', description: 'only when asked: the state branch holds design/panel-synthesis.md for this brief' },
      notes: { type: 'string' },
    },
    required: ['brief_exists', 'out_dir', 'architecture', 'roadmap', 'architecture_exists', 'roadmap_exists', 'milestones', 'panel_synthesis'],
  }
  survey = await agent(
    GUARD + WHERE + `Find the design docs that already exist, before this run writes any. Read-only: change no file and no git state. ` +
    `1. brief_exists: whether ${A.brief} exists (relative to ${DIR}, or absolute). ` +
    `2. The proposals directory is ${OUT_TEXT}, relative to ${DIR}: return it as out_dir, with the paths of its architecture.md and roadmap.md and whether each exists. ` +
    `3. When roadmap.md exists, run ${LINT} <roadmap> --roadmap and ${MILESTONES_FROM_LINT}. ` +
    (FROM_ARG === 'architecture'
      ? `4. Run ${STATE} get design/panel-synthesis.md (this read of the repository's state branch is allowed; a missing script counts as none saved): panel_synthesis is true when it exits 0 and the file's Source: line names ${BRIEF_REL}, else false (exit 3: none saved; exit 2: say why in notes). `
      : `4. Leave panel_synthesis false. `) +
    `This run was asked to start at ${FROM_ARG || 'the stage the docs and answers imply'}${A.force ? ', regenerating the docs (force)' : ''}${ANSWERS.length ? `, with answers to ${ANSWERS.map(a => a.id).join(', ')}` : ''}.`,
    opts('existing-docs', 'Seed', 'lint', SURVEY_SCHEMA),
  )
  const startFailed = reason => {
    log(`Cannot start: ${reason}`)
    return { status: 'failed_at_start', stop_reason: reason, seeded, ...runInfo() }
  }
  if (!survey) return startFailed('the existing-docs stage failed to report')
  if (!survey.brief_exists) return startFailed(`brief_not_found: ${A.brief} does not exist in ${DIR} (the checkpoints never commit it: copy it into this checkout, then re-run)`)
  if (!!survey.architecture_exists !== !!survey.roadmap_exists && !A.force) {
    return startFailed(`partial_docs: only ${survey.architecture_exists ? survey.architecture : survey.roadmap} exists. Restore the other one, or pass force to regenerate both from scratch`)
  }
  DOCS_EXIST = !!(survey.architecture_exists && survey.roadmap_exists)
  FROM = FROM_ARG || (A.force ? 'intake' : DOCS_EXIST ? (ANSWERS.length ? earliestStage(ANSWERS.map(a => a.stage)) : 'proposals') : 'intake')
  if (at(FROM) >= at('proposals') && !DOCS_EXIST) {
    FROM = null
    return startFailed(`no_docs: from '${FROM_ARG}' keeps the existing ${survey.architecture || 'architecture.md'} and ${survey.roadmap || 'roadmap.md'}, and they do not exist. Run without from (or with from: 'intake') to write them`)
  }
  log(`Starting at ${FROM}${FROM_ARG ? '' : ' (inferred)'}: ${DOCS_EXIST ? `${survey.architecture} and ${survey.roadmap} exist${A.force ? ' and are regenerated (force)' : ''}` : 'no design docs yet'}`)
} else {
  FROM = 'intake'
}
// The docs are written (or rewritten) by /roadmap in this run; otherwise the existing ones are kept and resumed.
const REGEN = BRIEF_MODE && (!!A.force || !DOCS_EXIST)

// ---- Intake: ask before assuming. One read of the source for what only the person can answer, before any sketch or doc
// is written on a guess. With on_question 'assume', the recommended options become shared answers for every later stage,
// so every author builds on the same assumption instead of each picking its own.
if (at(FROM) <= at('intake')) {
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
} else {
  log(`Intake: skipped (starting at ${FROM})`)
}

if (BRIEF_MODE) {
  if (at(FROM) <= at('architecture')) {
    phase('Architecture')
    if (REGEN) {
      // ---- Architecture: independent sketches, a judge, then /roadmap writes the docs. Starting at 'architecture' builds on the
      // synthesis an earlier run saved on the state branch instead of running a new panel.
      reusedPanel = FROM === 'architecture' && !!survey.panel_synthesis
      const ANGLES = [
        { key: 'validate-first', text: 'Validation first: the smallest architecture that ships the source\'s cheapest experiment within weeks and grows into the full product without a rewrite. Defer everything the experiment does not need, but say where each deferred piece will go.' },
        { key: 'trust-first', text: 'Security, privacy and correctness first: minimise where sensitive data lives and for how long, process locally where that helps, draw explicit trust boundaries, and design failure modes that never give a wrong answer silently.' },
        { key: 'operate-first', text: 'Operations and cost first: the cheapest reliable hosting a small team can run, managed services over self-run ones, zero-touch deploys, observability, rollback, and the cost per user at the target scale.' },
      ]
      if (reusedPanel) {
        log('Architecture panel: building on design/panel-synthesis.md from the state branch (no new panel)')
      } else if (PANEL > 0) {
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
            `Keep every decision with its options and choice. The synthesis is saved to the repository's state branch: state the framing's constraints in your own words, and never copy personal data, credentials or the framing text itself into it. Read-only: write no files.\n\nSKETCHES:\n${JSON.stringify(sketches, null, 1)}`,
            opts('judge', 'Architecture', 'judge', JUDGE_SCHEMA),
          )
          if (judged) {
            log(`Architecture panel: ${judged.scores.map(s => `${s.sketch} ${s.total}`).join(', ')}; building on ${judged.winner}`)
            // Saved so a later run that starts at 'architecture' (a /roadmap question answered, from another session) needs no new panel.
            panelSaved = await agent(
              GUARD + WHERE + `Save this architecture panel synthesis to the repository's state branch. Write the text between the -----BEGIN PANEL SYNTHESIS----- and -----END PANEL SYNTHESIS----- lines below (not those lines), verbatim, to a file in a new temporary directory outside ${DIR} (mktemp -d), ` +
              `then run, in ${DIR}: ${STATE} save <that file> --as design/panel-synthesis.md -m "brief-to-proposals: architecture panel synthesis". Remove the temporary directory afterwards. ` +
              `Change nothing in ${DIR}'s working tree, index or branches. Saving is best effort: when the script is missing or exits 2, report saved=false with its message, and never retry another way.\n` +
              `-----BEGIN PANEL SYNTHESIS-----\n# Panel synthesis\n\nSource: ${BRIEF_REL}\nWinner: ${judged.winner}\nScores: ${judged.scores.map(s => `${s.sketch} ${s.total}`).join(', ')}\n\n${judged.synthesis}\n-----END PANEL SYNTHESIS-----`,
              opts('save-panel', 'Architecture', 'lint', { type: 'object', properties: { saved: { type: 'boolean' }, commit: { type: 'string' }, error: { type: 'string' } }, required: ['saved'] }),
            )
            log(panelSaved && panelSaved.saved ? 'Panel synthesis saved to the state branch (design/panel-synthesis.md)' : `Panel synthesis not saved (best effort): ${(panelSaved && panelSaved.error) || 'the stage failed to report'}`)
          }
        }
      }
      const SYNTHESIS = judged
        ? `Build on this architecture synthesis from an independent panel (a strong input, not a substitute for reading the source; where it contradicts the source, the source wins and you say so):\n${judged.synthesis}\n`
        : reusedPanel
        ? `Build on the architecture synthesis an independent panel wrote for this brief in an earlier run (a strong input, not a substitute for reading the source; where it contradicts the source or an answer above, they win and you say so). ` +
          `Read it before invoking the skill: ${STATE} get design/panel-synthesis.md --to <a file in a new temporary directory outside ${DIR}> (this read of the state branch is allowed; it changes nothing in ${DIR}); if that exits 3 or 2, build without it and say so in notes.\n`
        : ''
      arch = await agent(
        WORK + CTX + ASK('architecture') + `Invoke the Skill tool with skill "roadmap" with args ${JSON.stringify(`${A.brief}${OUT_FLAG}${A.force ? ' --force' : ''}`)}. ` +
        SYNTHESIS +
        `Then run ${LINT} <roadmap> --roadmap --json and ${MILESTONES_FROM_LINT}, with the paths of architecture.md and roadmap.md relative to ${DIR}.`,
        opts('roadmap', 'Architecture', 'roadmap', ROADMAP_SCHEMA),
      )
      noteAssumptions('architecture', arch)
      if (asked(arch)) return needsInput(tagQuestions('architecture', arch.questions), { seeded, panel: judged })
      if (!arch || arch.stopped) {
        log(`/roadmap stopped: ${(arch && arch.stop_reason) || 'the stage failed to report'}`)
        return { status: 'failed_at_roadmap', stop_reason: (arch && arch.stop_reason) || '', seeded, panel: judged, ...runInfo() }
      }
      log(`Wrote ${arch.architecture} and ${arch.roadmap}: ${arch.milestones.length} milestones`)
    } else {
      arch = surveyArch()
      log(`Resuming the review of the existing ${arch.architecture} and ${arch.roadmap}: /roadmap is not re-run`)
    }
    archReview = await reviewLoop(
      [arch.architecture, arch.roadmap],
      `These are the architecture and roadmap for ${SOURCE}: judge them against the source (every requirement, constraint, risk and validation step it states), ` +
      `for sound decisions, a deploy and operations plan, and milestones in an order that validates the riskiest assumptions first with every person-only step as a human gate. `,
      'architecture', 'Architecture', 'architecture',
    )
    await checkpoint('Architecture', [arch.architecture, arch.roadmap], 'Checkpoint the draft architecture and roadmap')
    if (archReview.questions.length) return needsInput(archReview.questions, { seeded, architecture: arch, panel: judged, architecture_review: archReview })
    if (!archReview.reviewed) return { status: 'review_failed', resume_from: 'architecture', architecture: arch, panel: judged, architecture_review: archReview, ...runInfo() }
    if (!archReview.clean) {
      log('Architecture or roadmap still has blocking findings — stopping before any proposal is written')
      return { status: 'blocked_at_architecture_review', resume_from: 'architecture', architecture: arch, panel: judged, architecture_review: archReview, ...runInfo() }
    }
    // Re-read the milestones: a revise round may have renumbered or renamed them.
    const fresh = await agent(
      GUARD + WHERE + `Run ${LINT} ${arch.roadmap} --roadmap --json in ${DIR} and ${MILESTONES_FROM_LINT}, with out_dir ${JSON.stringify(arch.out_dir)}, ` +
      `architecture ${JSON.stringify(arch.architecture)} and roadmap ${JSON.stringify(arch.roadmap)}. Change nothing.`,
      opts('milestones', 'Architecture', 'lint', ROADMAP_SCHEMA),
    )
    if (fresh && !fresh.stopped) arch = fresh
  } else {
    arch = surveyArch()
    log(`Architecture: keeping ${arch.architecture} and ${arch.roadmap} (starting at ${FROM})`)
  }

  const pendingCode = arch.milestones.filter(m => !m.done && !m.human_gate && m.proposal)
  if (at(FROM) <= at('proposals')) {
    // ---- Proposals: one per pending milestone that names a proposal, each reviewed until clean (no barrier between milestones).
    // Docs written by /roadmap in this run get every proposal; docs that already existed keep the proposals already written,
    // except the milestones whose question was answered (or exactly args.milestones).
    phase('Proposals')
    const wanted = ONLY ? pendingCode.filter(m => ONLY.includes(m.n))
      : REGEN ? pendingCode
      : pendingCode.filter(m => !m.proposal_exists || ANSWERED_MILESTONES.has(m.n))
    const todo = MAX_M ? wanted.slice(0, MAX_M) : wanted
    kept = pendingCode.filter(m => m.proposal_exists && !todo.includes(m))
    const skipped = pendingCode.filter(m => !m.proposal_exists && !todo.includes(m))
    if (skipped.length) log(`Not proposing milestones ${skipped.map(m => m.n).join(', ')} (${ONLY ? 'args.milestones' : ''}${ONLY && MAX_M ? ', ' : ''}${MAX_M ? 'args.max_milestones' : ''}); propose them later with /propose --milestone=N`)
    if (kept.length) log(`Keeping the existing proposals of milestones ${kept.map(m => m.n).join(', ')}`)
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
    // Every pending milestone's proposal path (the agent stages the ones that exist), so a file kept from an earlier run is
    // committed even when its milestone asked again.
    await checkpoint('Proposals', [arch.architecture, arch.roadmap]
      .concat(proposals.filter(p => !p.failed && !p.needs_input).map(p => p.doc), pendingCode.map(m => m.proposal)), 'Checkpoint the draft proposals')
  } else {
    kept = pendingCode.filter(m => m.proposal_exists)
    log(`Proposals: keeping the ${kept.length} existing proposal(s) (starting at ${FROM})`)
  }
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
    return { status: 'failed_at_propose', stop_reason: (p && p.stop_reason) || '', ...runInfo() }
  }
  const r = await reviewLoop([p.doc], `This proposal is for ${SOURCE}; judge it against that concern and today's tree. `, 'proposal', 'Proposals', 'proposal')
  await checkpoint('Proposals', [p.doc], 'Checkpoint the draft proposal')
  if (r.questions.length) return needsInput(r.questions, { seeded, proposals: [{ doc: p.doc, review: r }] })
  proposals.push({ ...p, review: r })
}

const written = proposals.filter(p => !p.failed && !p.needs_input)
const keptDocs = kept.map(m => ({ milestone: m.n, title: m.title, doc: m.proposal, kept: true }))
// Every proposal the design now holds: written (or rewritten) in this run, or kept from an earlier one.
const propDocs = written.concat(keptDocs).sort((a, b) => (a.milestone || 0) - (b.milestone || 0))
// Questions a milestone's author or reviser raised: the docs cannot be checked against each other until they are answered.
const pendingQs = proposals.flatMap(p => p.questions || [])
const allDocs = (arch ? [arch.architecture, arch.roadmap] : []).concat(propDocs.map(p => p.doc))

// The Consistency phase compares the docs two at a time, so each agent holds two docs, never the whole design:
// (architecture, P) for each proposal P; (P, Q) for each roadmap dependency between their milestones, through gate milestones
// (a code milestone after a go/no-go builds on the code before it); (brief, roadmap) for coverage; and, for a finding a per-doc
// review raised about another doc, (that doc, the one it was raised against) unless a pair above already holds both.
function consistencyPairs(deferred) {
  const byN = new Map(arch.milestones.map(m => [m.n, m]))
  const docOfN = new Map(propDocs.map(p => [p.milestone, p]))
  const keyOf = d => d === norm(arch.architecture) ? 'arch' : d === norm(arch.roadmap) ? 'roadmap' : d === norm(A.brief) ? 'brief'
    : (propDocs.find(p => norm(p.doc) === d) ? `m${propDocs.find(p => norm(p.doc) === d).milestone}` : d.replace(/[^A-Za-z0-9]+/g, '-'))
  const pairs = []
  const add = (a, b, kind, extra) => {
    const [x, y] = [norm(a), norm(b)]
    let p = pairs.find(q => (q.a === x && q.b === y) || (q.a === y && q.b === x))
    if (!p) { p = { key: `${keyOf(x)}-${keyOf(y)}`, a: x, b: y, kind, deferred: [], ...(extra || {}) }; pairs.push(p) }
    return p
  }
  // The proposals a milestone builds on: its dependencies that hold one, looking through the milestones that name none (gates).
  const builtOn = n => {
    const out = [], seen = new Set([n]), queue = [...((byN.get(n) || {}).depends || [])]
    while (queue.length) {
      const d = queue.shift()
      if (seen.has(d)) continue
      seen.add(d)
      if (docOfN.has(d)) out.push(d)
      else if (byN.has(d) && !byN.get(d).proposal) queue.push(...(byN.get(d).depends || []))
    }
    return out.sort((x, y) => x - y)
  }
  for (const p of propDocs) add(arch.architecture, p.doc, 'architecture', { milestone: p.milestone, title: p.title })
  for (const q of propDocs) for (const n of builtOn(q.milestone)) add(docOfN.get(n).doc, q.doc, 'dependency', { earlier: docOfN.get(n), later: q })
  add(A.brief, arch.roadmap, 'coverage')
  for (const f of deferred) {
    const t = norm(f.doc)
    const against = (f.raised_by || []).map(norm).filter(d => d && d !== t)
    const p = pairs.find(q => (q.a === t || q.b === t) && against.some(d => q.a === d || q.b === d)) ||
      add(against[0] || norm(arch.architecture), t, 'deferred')
    p.deferred.push({ doc: f.doc, severity: f.severity, description: f.description })
  }
  const seenKeys = new Map()
  for (const p of pairs) { const k = seenKeys.get(p.key) || 0; seenKeys.set(p.key, k + 1); if (k) p.key = `${p.key}-${k + 1}` }
  return pairs
}
const releases = () => (arch.milestones || []).filter(m => m.human_gate === 'release').map(m => `${m.n} ("${m.title}")`)
function pairPrompt(p) {
  const rel = releases()
  const focus = p.kind === 'architecture'
    ? `${p.b} is the proposal for roadmap milestone ${p.milestone} ("${p.title}"), and ${p.a} the architecture it must follow. Report where the proposal contradicts a decision, an invariant, a component's responsibility or interface, the data model, a name, an environment or a secret in the architecture; ` +
      `plans work the architecture gives another component; or rests on a choice the architecture should record and does not. ` +
      (rel.length ? `The roadmap gates these launches as release milestones: ${rel.join('; ')}. A release gate in the proposal for one of them gates it twice: a finding on the proposal. ` : '')
    : p.kind === 'dependency'
    ? `In the roadmap, milestone ${p.later.milestone} (${p.b}) builds on milestone ${p.earlier.milestone} (${p.a}). Report the interfaces, data models, names, files, endpoints, tables, events or secrets the later proposal uses that the earlier one does not create, or creates differently; ` +
      `work both plan, or that falls between them; and Depends on references between them that point at the wrong step. `
    : p.kind === 'coverage'
    ? `${p.a} is the product brief (the source: it never changes) and ${p.b} the roadmap planned from it. Report each part of the brief that no milestone plans for or rules out (coverage_gaps), and milestones whose order builds on something not yet built or validated. A finding never names the brief: one about the brief's coverage names the roadmap. `
    : `The per-doc review of one of these docs raised findings about the other (below): check each against the two docs. `
  return WORK + REVIEW_CTX + answersFor('consistency') +
    `Cross-doc consistency check of two design docs: read ${p.a} and ${p.b} in full, and no other doc. Each was already reviewed on its own against the tree and its sources, so judge only how the two fit together. ${focus}` +
    (p.kind === 'coverage' ? '' : `Leave coverage_gaps empty. `) +
    `Each finding names the ONE of these two docs that should change, by its path relative to ${DIR}. Read-only: write no files.` +
    (p.deferred.length ? `\nThe per-doc reviews raised these findings about ${p.a} or ${p.b}; check each and report the ones that hold:\n${JSON.stringify(p.deferred, null, 1)}` : '')
}

// ---- Consistency: the pairs run in parallel (a barrier: one reviser per doc needs every pair's findings about it). Blocking
// findings and coverage gaps are revised, one reviser per doc, then every revised doc is reviewed again, so nothing changed
// after its review counts as clean unchecked.
let consistency = null, consistencyOk = true
const deferredAll = [archReview].concat(proposals.map(p => p.review)).filter(Boolean).flatMap(r => r.deferred || [])
if (BRIEF_MODE && at(FROM) > at('consistency')) {
  log(`Consistency: skipped (starting at ${FROM})`)
} else if (BRIEF_MODE && propDocs.length && pendingQs.length) {
  consistencyOk = false
  log(`Consistency skipped: ${pendingQs.length} question(s) from the Proposals phase must be answered first`)
} else if (BRIEF_MODE && propDocs.length) {
  phase('Consistency')
  const pairs = consistencyPairs(deferredAll)
  log(`Consistency: ${pairs.length} pair(s) of docs — ${pairs.map(p => p.key).join(', ')}`)
  const reports = await parallel(pairs.map(p => () => agent(pairPrompt(p), opts(`consistency:${p.key}`, 'Consistency', 'consistency', CONSISTENCY_SCHEMA))))
  consistency = {
    pairs: pairs.map((p, i) => ({ key: p.key, docs: [p.a, p.b], findings: reports[i] ? reports[i].findings.length : null, failed: !reports[i] })),
    findings: [],
    coverage_gaps: [],
  }
  pairs.forEach((p, i) => {
    if (!reports[i]) return
    consistency.findings.push(...reports[i].findings.map(f => ({ ...f, pair: p.key })))
    consistency.coverage_gaps.push(...(reports[i].coverage_gaps || []))
  })
  const failedPairs = consistency.pairs.filter(p => p.failed)
  if (failedPairs.length) {
    consistencyOk = false
    log(failedPairs.length === pairs.length ? 'The consistency pass failed to report — the docs were not checked against each other'
      : `${failedPairs.length} consistency pair(s) failed to report: ${failedPairs.map(p => p.key).join(', ')}`)
  }
  if (failedPairs.length < pairs.length) {
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
  await checkpoint('Consistency', allDocs, 'Checkpoint the cross-doc consistency revisions')
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
const laterDocs = BRIEF_MODE ? propDocs.slice(1).map(p => p.doc) : []

const questions = pendingQs.concat((consistency && consistency.questions) || [])
if (questions.length) logQuestions(questions)
const resumeFrom = questions.length && BRIEF_MODE ? earliestStage(questions.map(q => q.stage)) : ''
const status = questions.length ? 'needs_input'
  : !lint ? 'lint_failed'
  : lintErrors ? 'lint_errors'
  : (unclean.length || proposals.some(p => p.failed) || !consistencyOk) ? 'proposals_need_attention'
  : 'ready'
log(`Status: ${status}`)
const unpushed = checkpoints.some(c => !c.pushed)
return {
  status,
  ...(questions.length ? { questions, relay: relay(resumeFrom), ...(resumeFrom ? { resume_from: resumeFrom } : {}) } : {}),
  assumptions: ASSUMED,
  ...runInfo(),
  seeded,
  out_dir: arch ? arch.out_dir : null,
  architecture: arch ? arch.architecture : null,
  roadmap: arch ? arch.roadmap : null,
  panel: judged ? { winner: judged.winner, scores: judged.scores, saved: !!(panelSaved && panelSaved.saved) } : reusedPanel ? { reused: true } : null,
  architecture_review: archReview,
  proposals: proposals.map(p => ({ milestone: p.milestone, title: p.title, doc: p.doc, failed: !!p.failed, needs_input: !!(p.questions && p.questions.length), stop_reason: p.stop_reason || null, clean: !!(p.review && p.review.clean), findings_remaining: p.review ? p.review.findings_remaining : null })),
  kept: keptDocs.map(({ milestone, title, doc }) => ({ milestone, title, doc })),
  deferred_findings: BRIEF_MODE ? undefined : deferredAll,
  consistency,
  lint,
  next_steps: [
    questions.length ? `First answer the ${questions.length} question(s) in questions (see relay): the docs that raised them are unwritten or unrevised, and the Consistency phase waits on them.` : null,
    BRANCH ? `The docs, the seeded .claude files and CLAUDE.md are committed on ${BRANCH}${unpushed ? `; a checkpoint did not reach origin (branch.checkpoints says why): push ${BRANCH} once that is fixed` : ', pushed to origin'}. ` +
      `Edit and accept the docs on that branch; a re-run with the same args, from this clone or a fresh one, checks the branch out and picks up the docs where they stand.` : null,
    'Read and edit the docs. They are drafts (Status: draft): set Status: accepted on each one you approve; nothing is built or bootstrapped from a draft.',
    // Every proposal was written against today's tree, which the earlier milestones will change before the later ones build.
    laterDocs.length ? `Accept the proposals one milestone at a time, in roadmap order. Before accepting each one after the first (${laterDocs.join(', ')}), once the milestones before it have merged, ` +
      `re-run /review-proposal <doc> against the tree as it is then, and /propose --revise <doc> on its findings: a Files: list or interface the earlier milestones changed is a review concern then, not a stalled lane later.` +
      (MAX_M ? '' : ` For a long roadmap, run with max_milestones: 1 instead and propose each later milestone with /propose --milestone=N when it comes up.`) : null,
    'Do every research or decision gate the docs list that blocks design choices, record its Outcome, and run /propose --revise <doc> on the docs whose steps depend on it.',
    arch ? (BRANCH
      ? `Greenfield: once the docs are accepted, land ${BRANCH} on main through a PR (it holds only design docs, the pipeline's .claude files and CLAUDE.md, so main stays greenfield): /bootstrap cuts its branch from origin/main and would leave docs committed only on ${BRANCH} behind. ` +
        `Then run /bootstrap ${arch.architecture} in a checkout of main (one commit, on a bootstrap/<date> branch), ship it with plan-to-merged-pr { ship_only: true, branch, title } and merge it, protect main and require the CI check; once that PR has merged and CI is green on main, add the bootstrap milestone's Outcome (CI green at <sha>; main protected), tick it (${LINT} ${arch.roadmap} --tick <n>) and land that through a docs PR.`
      : `Greenfield: run /bootstrap ${arch.architecture} in the clean repository (one commit, holding the docs too, on a bootstrap/<date> branch), ship it with plan-to-merged-pr { ship_only: true, branch, title } and merge it (an empty remote gets the root commit on local main instead, which you push), protect main and require the CI check; once that PR has merged and CI is green on main, add the bootstrap milestone's Outcome (CI green at <sha>; main protected), tick it (${LINT} ${arch.roadmap} --tick <n>) and land that through a docs PR.`) : null,
    BRANCH
      ? `Existing repo: land the accepted docs, the seeded pipeline files and the CLAUDE.md changes through a PR from ${BRANCH} (/create-pr; they are committed there already), and merge it — lanes are cut from origin and read the proposal and the commands there.`
      : 'Existing repo: land the seeded pipeline files, the CLAUDE.md changes and the accepted docs through an ordinary PR (commit them on a branch, /create-pr, merge) — lanes are cut from origin and read the proposal and the commands there.',
    `Build each proposal when its roadmap dependencies are done: proposal-build-chain { proposal: '<doc>', dir: '<checkout>', root: '<worktrees dir>', date: '<YYYYMMDD>' }.`,
    'Do every human-gated step yourself and tick it; lanes that depend on one stay blocked until it is ticked.',
  ].filter(Boolean),
}

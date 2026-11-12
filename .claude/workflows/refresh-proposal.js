export const meta = {
  name: 'refresh-proposal',
  description: 'Re-review one design doc against today\'s tree and revise it until clean: /review-proposal, then /propose --revise on its findings, until no bug or concern remains or the revise cap is reached; then proposal-lint.py on the doc, with a preview of a proposal\'s lanes. Edits only that doc; the work runs in subagents and the result is compact',
  whenToUse: 'Before accepting each proposal after the first, once the milestones before it have merged; after a gate\'s Outcome changes what a doc plans; or whenever a doc may have gone stale: instead of running /review-proposal and /propose --revise in the orchestrating session. A revise resets Status: to draft, so a person re-accepts the doc. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with answers, as its relay says.',
  phases: [
    { title: 'Review', detail: '/review-proposal, then /propose --revise on its findings, until no bug or concern remains (at most max_review_rounds revisions)' },
    { title: 'Lint', detail: 'proposal-lint.py on the doc: --lanes --allow-draft for a proposal, --roadmap for a roadmap, --claude-md for a bootstrapped architecture, --decisions for what no person confirmed' },
  ],
}

// args:
//   doc: string               the design doc to refresh (a proposal, architecture.md or roadmap.md), relative to dir
//   dir: string               absolute path of the checkout the doc is judged against: usually an up-to-date main, after the
//                             milestones before this one merged
//   roadmap?: boolean         also review the doc against the whole roadmap (/review-proposal --roadmap reads the roadmap and
//                             every proposal it names, so it costs more); default false
//   max_review_rounds?: number  revise rounds (default 3; 0 = review only, no revise)
//   efforts?: { review, revise, lint }   default { review: 'high', revise: 'medium', lint: 'low' }
//   on_question?: 'stop'|'assume'  default 'stop': a reviser that hits a blocking question (a finding only the person can settle)
//                             or a confirmation (a person-owned choice whose value nobody confirmed with them) stops the run
//                             with needs_input; 'assume' takes each recommended option, tags it (assumed) in the doc and lists
//                             it in assumptions
//   answers?: [{ id, answer, question?, date? }]  the questions a needs_input result returned, each with its question text, the
//                             person's answer and the date they gave it (or { <id>: answer }); also revise.d<N> for an
//                             assumption the person corrected or a decision they made outside the questions. Every review and
//                             revise gets them, so a re-run starts from the doc as it is now: an answer the doc does not yet
//                             reflect is reported by the review and applied by the revise, which tags the decision it settles
//                             (person, <date>, <id>)
// Suggestions and nits get one revise round; a bug or concern still standing after max_review_rounds revisions ends the run with
// findings_remain. Findings about any other doc are reported in other_docs, never applied here. A revise resets the doc's Status:
// to draft, so the next steps say to re-accept it. The lint stage also lists what no person confirmed (lint.unconfirmed: decisions
// tagged (assumed) or untagged; lint.proposed: values an author proposed): the next steps say to show them, with the
// assumptions, before the doc is accepted.
const A = args || {}
if (!A.doc) throw new Error('refresh-proposal: args.doc (the design doc to refresh, relative to dir) is required')
if (!A.dir) throw new Error('refresh-proposal: args.dir (absolute path of the checkout the doc is judged against) is required')
const DIR = String(A.dir).replace(/\/+$/, '')
// Agents may name a doc absolutely, relative to DIR, or with a leading ./ — compare them as DIR-relative paths.
const norm = d => { const s = String(d || '').trim(); return (s.startsWith(DIR + '/') ? s.slice(DIR.length + 1) : s).replace(/^\.\//, '') }
const DOC = norm(A.doc)
if (!DOC || /\s/.test(DOC) || DOC.startsWith('-')) throw new Error(`refresh-proposal: args.doc must be one doc path with no spaces or flags (got ${JSON.stringify(A.doc)})`)
const ROADMAP_FLAG = A.roadmap ? ' --roadmap' : ''
const MAX_REVIEW = (n => Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 3)(Number(A.max_review_rounds ?? 3))
const EFF = { review: 'high', revise: 'medium', lint: 'low', ...(A.efforts || {}) }
const opts = (label, ph, effortKey, schema) => {
  const o = { label, phase: ph }
  if (EFF[effortKey]) o.effort = EFF[effortKey]
  if (schema) o.schema = schema
  return o
}

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path); record it as blocked and report it. `
const WHERE = `Work ONLY in ${DIR} (cd there / use absolute paths). `
const DOCS_ONLY = `This is design work on one doc: change nothing but ${DOC}. Never write code; never commit, stage, push, switch or create a branch, or open a PR. ` +
  `The review ledger the commands keep (under ~/.claude, with its copy on the pipeline state branch through .claude/scripts/pipeline-state.py) is theirs to write. `
const WORK = GUARD + WHERE + DOCS_ONLY
const LINT = `python3 .claude/scripts/proposal-lint.py`
const FRAME = `The doc is re-reviewed against the tree as it is now: milestones that merged since it was written may have moved or changed the files, symbols and interfaces it builds on. `

// ---- Questions before assumptions. No one can answer an agent mid-run: a reviser that needs the person's call returns its
// questions and the run stops with needs_input; the caller asks the person and re-runs with args.answers. One doc, one scope:
// every answer reaches every review (so the person's choice is not reported as a defect) and every revise.
const ON_Q = A.on_question === 'assume' ? 'assume' : 'stop'
const ANSWERS = (Array.isArray(A.answers) ? A.answers : Object.entries(A.answers || {}).map(([id, answer]) => ({ id, answer })))
  .filter(a => a && a.answer !== undefined && a.answer !== null && String(a.answer).trim() !== '')
// Each answer: { id, answer, question?, date? }. The question text and the date travel with it into every prompt.
const ANSWERS_TEXT = ANSWERS.length
  ? `Answers from the person to blocking questions (binding, like the person's framing; never re-ask them, and a choice that follows one is not a defect; ` +
    `a decision one settles carries the tag (person, <its date, or today's when it has none>, <its id>) in the doc, or (assumed) when the answer says it was assumed): ` +
    `${JSON.stringify(ANSWERS.map(a => ({ id: a.id, question: a.question || a.id, answer: a.answer, ...(a.date ? { date: a.date } : {}) })))}\n`
  : ''
// What a reviewer is told about the person's choices: a doc that departs from one is a defect whose fix is a question, and an
// answer the doc does not yet reflect is a defect the reviser applies.
const REVIEW_CTX = `A doc that departs from the person's framing, an answer from the person, or a decision tagged (person, ...), with no newer answer from the person, is a bug whose fix is the question to ask (with its options), never a gate or a confirmation at acceptance. ` +
  (ANSWERS.length ? `An answer above that the doc does not yet reflect (its text still says otherwise, or the decision it settles is not tagged (person, ...)) is a bug too: report it, naming the answer's id, so the reviser applies it. ` : '')
// The person-owned choices, in the one order every stage and doc lists them.
const OWNED = `who the product is for and what its first release leaves out; platforms and distribution, hosted or self-run; price, plans, the revenue model, and anything that costs money or opens an account in the person's name (a host, a paid API, a billing provider, a store); ` +
  `the licence and its variant, and the legal and compliance posture; what personal data is collected, how long it is kept and who receives it; names (product, package, domain, organization or bundle id); the repository's owner and visibility; ` +
  `stop and go criteria, thresholds and dates; and a stack, provider or environment the person must run or pay for themselves`
const DRAFTED = `a new-software-idea brief is: its header has **Verdict:** and **Assumed builder:** fields, and that skill never interviews the person`
const BLOCKING_DEF = `A blocking question is one only the person can answer: what they intend, a requirement or constraint the doc's sources leave out or state two incompatible ways, a trade-off that is theirs to make, ` +
  `a conflict between what the person said (the framing, an answer, a decision a doc records as theirs) and the doc's sources, the tree or your research, or a blocker whose way forward is their call; and whose plausible answers lead to a different design, promise, cost or legal exposure. ` +
  `A confirmation is a question about a person-owned choice that already has a value nobody confirmed with the person: a source's value when that source was drafted for the person (${DRAFTED}), ` +
  `an item the framing or a doc lists as open, recommended or not yet decided, or the default you would otherwise take. ` +
  `The person-owned choices: ${OWNED}. ` +
  `Yours, never asked: a choice inside a component that an invariant, a recorded decision or an official doc settles (a library, a layout, an internal name, a test tool, a version), and anything the tree, CLAUDE.md, the docs or desk research (official docs, pricing, terms, prior art) can settle: settle those. ` +
  `A choice the person can make now is a question: never a gate, never a D-record whose Choice awaits confirmation, never something left for acceptance. A decision gate holds only what waits on evidence the plan produces, on finished work or on an outside party; ` +
  `a research gate only what needs data, an account, a paid search or a legal opinion (a store, registry or register with a public search is desk research, recorded with its result and date). ` +
  `Never change what the person settled: an answer, the framing, or a D-record tagged (person, ...) is changed only by a newer answer from the person; a reason to change it is a blocking question. ` +
  `A question, its options and the recommendation name milestones, steps and decisions by title; a number alone is never enough (numbers move between revisions). `
const ASK_RULE = `QUESTIONS: this stage runs unattended inside a workflow. No one can answer a question mid-run, so never wait for one and never use a question tool. ` + BLOCKING_DEF +
  (ON_Q === 'assume'
    ? `The person chose to proceed on assumptions: for each blocking question and each confirmation, take the option you recommend (for a confirmation the unconfirmed value; for a conflict with what the person said, what the person said), revise the doc on it, ` +
      `tag a decision so taken (assumed) in the doc, and report it in assumptions as "<question> -> <option taken>". `
    : `Never guess the answer to a blocking question and never build on an unconfirmed value: write and change nothing, and return every such question and every confirmation (all of them, in one pass) in questions, ` +
      `each with why it blocks, 2-4 concrete options and the one you recommend; a confirmation has confirm: true and the unconfirmed value as its recommended option. `) +
  `Report in assumptions every other choice the doc's sources did not settle (empty when none). `
const QUESTION = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    why: { type: 'string', description: 'what changes with the answer: where each option sends the doc' },
    options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete options' },
    recommended: { type: 'string', description: 'the option you recommend, and why in one clause; for a confirmation, the unconfirmed value' },
    confirm: { type: 'boolean', description: 'true for a confirmation: a person-owned choice that already has a value nobody confirmed with the person' },
  },
  required: ['question', 'why', 'options', 'recommended'],
}
const QA = {
  questions: { type: 'array', items: QUESTION, description: 'blocking questions and confirmations only the person can answer; non-empty means you wrote nothing' },
  assumptions: { type: 'array', items: { type: 'string' }, description: 'every choice you made that the doc\'s sources did not settle' },
}
const ASSUMED = []
const noteAssumptions = r => { if (r && Array.isArray(r.assumptions)) for (const a of r.assumptions) if (a) ASSUMED.push({ stage: 'revise', assumption: a }); return r }
const asked = r => !!(r && Array.isArray(r.questions) && r.questions.length)
// Ids continue after the highest revise.q<N> already answered, so a question asked on a re-run never reuses an answered id; a
// decision's id (revise.d<N>) takes no part in the numbering. Every other field of a question, confirm included, is kept.
const tagQuestions = qs => {
  let n = 0
  for (const a of ANSWERS) { const m = String(a.id || '').match(/^revise\.q(\d+)$/); if (m) n = Math.max(n, Number(m[1])) }
  return qs.map((q, i) => { const { id: _id, stage: _stage, ...rest } = q; return { id: `revise.q${n + i + 1}`, stage: 'revise', ...rest } })
}
const RELAY = `Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit (a numbered list when it has none), ` +
  `each with its why, its options and the recommended one first; never answer them on their behalf, and never re-run with on_question: 'assume' unless the person says to proceed on assumptions. ` +
  `Show the confirmations (the questions with confirm: true) as one list the person can accept whole or correct line by line. ` +
  `Also show the person this result's assumptions: a line they correct, or any decision they make outside these questions, is passed as an answer too (id revise.d<N>, with its question). ` +
  `Then re-run this workflow with the same args plus answers (each question's id and question text with the person's answer and the date they gave it, added to any answers given before). ` +
  `Every review and revise gets them, so the run starts again from the doc as it is now: the revisions already applied are kept, and resumeFromRunId has nothing to replay.`

const FINDING = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: 'path of the doc the finding is about, relative to the project directory' },
    severity: { type: 'string', enum: ['bug', 'concern', 'suggestion', 'nit'] },
    description: { type: 'string' },
  },
  required: ['doc', 'severity', 'description'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING },
    completed: { type: 'boolean', description: 'false if the review skill stopped without reviewing the doc' },
    doc_status: { type: 'string', description: 'the doc\'s Status: as the review\'s header gives it (e.g. draft, accepted)' },
    stop_reason: { type: 'string', description: 'when completed is false: the skill\'s error= code or why it stopped, verbatim' },
  },
  required: ['findings', 'completed', 'doc_status'],
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
    lint_clean: { type: 'boolean', description: 'proposal-lint.py reports no errors on the revised doc' },
    ...QA,
  },
  required: ['summary', 'declined', 'lint_clean', 'questions', 'assumptions'],
}
const LINT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', description: 'the lint\'s kind for the doc: proposal, architecture or roadmap' },
    status: { type: 'string', description: 'the doc\'s Status: header now (header.status)' },
    errors: { type: 'integer', description: 'the doc\'s lint errors (a roadmap: from --roadmap), never claude_md_drift' },
    warnings: { type: 'integer' },
    messages: { type: 'array', items: { type: 'string' }, description: 'each error counted in errors or lane_errors, as one line: <line>: <code>: <message>' },
    lane_errors: { type: 'integer', description: 'a proposal: the errors --lanes --allow-draft adds beyond the --json run\'s (e.g. lane_cycle); else 0' },
    chains: { type: 'integer' },
    lanes: { type: 'integer' },
    blocked: { type: 'integer', description: 'blocked lanes in the preview' },
    human_gates_pending: { type: 'integer' },
    claude_md_drift: { type: 'array', items: { type: 'string' }, description: 'an architecture on a bootstrapped repo: each CLAUDE.md section --claude-md reports as drifted; else empty' },
    unconfirmed: {
      type: 'array',
      description: 'from --decisions: every decision record no person confirmed (tagged assumed, or untagged)',
      items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, by: { type: 'string', description: 'assumed, or empty when untagged' } }, required: ['id', 'title', 'by'] },
    },
    proposed: {
      type: 'array',
      description: 'from --decisions: every line that holds a value an author proposed, marked (proposed)',
      items: { type: 'object', properties: { line: { type: 'integer' }, text: { type: 'string' } }, required: ['line', 'text'] },
    },
    branch: { type: 'string', description: 'the branch this checkout is on' },
    behind_main: { type: 'integer', description: 'commits this checkout is behind origin\'s main branch as last fetched; -1 when that ref does not exist' },
  },
  required: ['kind', 'status', 'errors', 'warnings', 'messages', 'lane_errors', 'chains', 'lanes', 'blocked', 'human_gates_pending', 'claude_md_drift', 'unconfirmed', 'proposed', 'branch', 'behind_main'],
}
const SEV = ['bug', 'concern', 'suggestion', 'nit']
const blocking = list => list.filter(f => f.severity === 'bug' || f.severity === 'concern')
// A finding with no doc, or one naming this doc by another path form, is about this doc.
const isOwn = d => { const n = norm(d); return !n || n === DOC || DOC.endsWith('/' + n) || n.endsWith('/' + DOC) }
// One line per item, at most MAX_LINES: the result goes back into the orchestrating session's context.
const oneLine = (t, n = 400) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const MAX_LINES = 20
const lines = (list, fmt) => {
  const out = list.slice().sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity)).map(fmt)
  if (out.length <= MAX_LINES) return out
  log(`${out.length - MAX_LINES} finding line(s) left out of the result; /review-proposal's ledger for the doc holds them all`)
  return out.slice(0, MAX_LINES).concat(`… ${out.length - MAX_LINES} more: /review-proposal's ledger for this doc holds them all`)
}

// ---- Review until no defect remains: every revision is re-reviewed. Same rule as brief-to-proposals' review loop: suggestions
// and nits get one revise round, defects block. The reviser edits only this doc; findings about other docs are reported.
phase('Review')
const history = [], other = []
let fixes = 0, findings = [], clean = false, failed = '', questions = [], rounds = 0, before = ''
for (let round = 1; ; round++) {
  const review = await agent(
    WORK + ANSWERS_TEXT + REVIEW_CTX + `Invoke the Skill tool with skill "review-proposal" with args ${JSON.stringify(`${DOC}${ROADMAP_FLAG}`)}. ${FRAME}` +
    `Report every finding (bug/concern/suggestion/nit) with the doc it is about, by its path relative to ${DIR} (this one is ${DOC}), verified against the doc, its sources and the tree. Do not edit files. ` +
    `Report the doc's Status: as the review's header gives it. Set completed=false, with the reason in stop_reason, if the skill stopped without reviewing the doc (an empty findings list must mean a real, clean review).` +
    (history.length ? `\nEarlier rounds and what the reviser did (confirm each is resolved; do not re-report revised items or ones validly declined):\n${JSON.stringify(history, null, 1)}` : ''),
    opts(`review-${round}`, 'Review', 'review', REVIEW_SCHEMA),
  )
  if (!review || review.completed === false) { failed = oneLine((review && review.stop_reason) || 'the review stage failed to report'); break }
  rounds = round
  if (round === 1) before = String(review.doc_status || '').trim()
  for (const f of review.findings) if (!isOwn(f.doc) && !other.some(d => d.description === f.description)) other.push(f)
  findings = review.findings.filter(f => isOwn(f.doc))
  const defects = blocking(findings)
  log(`Review ${round}: ${findings.length} finding(s), ${defects.length} blocking${other.length ? `, ${other.length} about other docs (reported, not applied)` : ''}`)
  if (!defects.length && (!findings.length || fixes >= 1 || fixes >= MAX_REVIEW)) { clean = true; break }
  if (fixes >= MAX_REVIEW) break
  const fix = await agent(
    WORK + ASK_RULE + ANSWERS_TEXT + `Invoke the Skill tool with skill "propose" with args ${JSON.stringify(`--revise ${DOC}`)}, applying these findings; decline any you can verify is wrong and give the reason. ` +
    `A finding only the person can settle (the doc's sources are silent or ambiguous on it, and the fix would choose for them) is a blocking question, per QUESTIONS: never decline it or pick a side. ` +
    `So is a finding whose fix would change what the person settled (an answer, the framing, a decision tagged (person, ...)): never apply it and never decline it; return the question, naming both sides. ` +
    (ANSWERS.length ? `Apply every answer above that the doc does not yet reflect, and tag each decision an answer settles (person, <the answer's date, or today's when it has none>, <the answer's id>). ` : '') +
    `Edit only ${DOC}; never any other doc. Re-run ${LINT} ${DOC} until it reports no errors.\n` +
    JSON.stringify(findings, null, 2),
    opts(`revise-${round}`, 'Review', 'revise', REVISE_SCHEMA),
  )
  noteAssumptions(fix)
  if (asked(fix)) { questions = tagQuestions(fix.questions); break }
  if (!fix) { failed = 'the revise stage failed to report'; break }
  fixes++
  history.push({ round, findings, revised: fix.summary, declined: fix.declined })
}
if (questions.length) {
  log(`${questions.length} question(s) only the person can answer — status needs_input`)
  for (const q of questions) log(`  ${q.id}${q.confirm ? ' (confirmation)' : ''}: ${q.question} (recommended: ${q.recommended})`)
}

// ---- Lint: the deterministic check on the doc as it is now, plus what only its kind has (lanes, progress, CLAUDE.md drift)
let lint = null
if (!questions.length && !failed) {
  phase('Lint')
  lint = await agent(
    GUARD + WHERE + `In ${DIR}, run ${LINT} ${DOC} --json and report its kind and the doc's Status: header (header.status). ` +
    `The error and warning counts come from that run, except for a roadmap, where they come from ${LINT} ${DOC} --roadmap --json (the same errors, plus progress warnings such as milestone_complete_unticked). Then, by kind: ` +
    `a proposal: ${LINT} ${DOC} --lanes --allow-draft (a preview of how it splits once a person accepts it; without --allow-draft a draft shows every lane blocked): lane_errors counts the errors it adds beyond the --json run's (it repeats those when the doc has any), e.g. lane_cycle; report its number of chains, lanes, blocked lanes and pending human gates; ` +
    `an architecture, when CLAUDE.md's Pipeline config carries the marker <!-- Pipeline config written by /bootstrap -->: ${LINT} ${DOC} --claude-md CLAUDE.md --json, listing the section each claude_md_drift error names in claude_md_drift (its other errors repeat the --json run's). ` +
    `In messages, give each error counted in errors or lane_errors as one line: <line>: <code>: <message>. ` +
    `Then run ${LINT} ${DOC} --decisions (any kind): return in unconfirmed every record of its unconfirmed list (its id, title and by) and in proposed every entry of its proposed list (its line and text); a lint that does not know --decisions: return both empty. ` +
    `Also report the branch this checkout is on (git rev-parse --abbrev-ref HEAD) and how many commits it is behind origin/<MAIN_BRANCH from the Pipeline config in CLAUDE.md, default main> as last fetched ` +
    `(git rev-list --count HEAD..origin/<that branch>; do not fetch; -1 when that ref does not exist). Change nothing.`,
    opts('lint', 'Lint', 'lint', LINT_SCHEMA),
  )
}

const lintErrors = lint ? (lint.errors || 0) + (lint.lane_errors || 0) : 0
const lintLines = lintErrors ? ((lint.messages || []).length ? lint.messages : [`${lintErrors} error(s)`]).map(m => oneLine(`bug: lint: ${m}`)) : []
const drift = lint ? (lint.claude_md_drift || []).filter(Boolean) : []
const stopReason = failed || (!questions.length && !lint ? 'the lint stage failed to report' : '')
const status = questions.length ? 'needs_input' : stopReason ? 'failed' : (!clean || lintErrors) ? 'findings_remain' : 'clean'
// A clean review keeps only the suggestions and nits it left; any other end keeps every finding the last review reported.
const left = clean ? findings.filter(f => !blocking([f]).length) : findings
const now = lint && lint.status ? String(lint.status).trim() : before
// What no person confirmed, shown to the person before they accept the doc: the run's assumptions, the decisions tagged (assumed)
// or untagged, and the values an author proposed. Capped like the findings: --decisions on the doc lists them all.
const capped = list => list.length <= MAX_LINES ? list : list.slice(0, MAX_LINES).concat(`… ${list.length - MAX_LINES} more: ${LINT} ${DOC} --decisions lists them all`)
const unconfirmed = ((lint && lint.unconfirmed) || []).filter(u => u && u.id).map(u => oneLine(`${u.id} "${u.title || ''}" (${u.by || 'untagged'})`, 200))
const proposedValues = ((lint && lint.proposed) || []).filter(v => v && v.text).map(v => oneLine(`${v.line}: ${v.text}`, 200))
const isProposal = !!lint && /^proposal$/i.test(String(lint.kind || ''))

const steps = []
if (questions.length) steps.push(`First answer the ${questions.length} question(s) in questions (see relay): the revise that raised them changed nothing${fixes ? `, and the ${fixes} revision(s) before it are kept` : ''}.`)
if (!questions.length && (ASSUMED.length || unconfirmed.length || proposedValues.length)) {
  steps.push(`Before ${DOC} is accepted${fixes && before && !/^draft/i.test(before) ? ' again' : ''}, show the person this result's assumptions (${ASSUMED.length}), ` +
    `lint.unconfirmed (${lint ? unconfirmed.length : 'not read: the lint failed'} decision(s) no person confirmed${unconfirmed.length ? `: ${unconfirmed.slice(0, 12).join('; ')}${unconfirmed.length > 12 ? `; and ${unconfirmed.length - 12} more` : ''}` : ''}) ` +
    `and lint.proposed (${lint ? proposedValues.length : 'not read'} value(s) an author proposed), and ask them to confirm or correct each. A confirmation or a correction goes back as an answer ` +
    `(id revise.d<N>, its question naming the decision by title, with the date) to a re-run of this workflow: the review reports what the doc does not yet reflect and the revise tags the decision (person, <date>, <id>).`)
}
if (fixes) {
  steps.push(`Read the changes (git -C ${DIR} diff -- ${DOC}). A revise resets Status: to draft${before && !/^draft/i.test(before) ? ` (it was ${before})` : ''}: ` +
    `re-accept the doc (set Status: accepted) once you approve it, since nothing is built from a draft, and land it through a docs PR (commit it on a branch, /create-pr; a person merges): lanes read it from origin/main.`)
} else if (status === 'clean') {
  steps.push(/^draft/i.test(now)
    ? `No revision was needed. ${DOC} is a draft: set Status: accepted once you approve it, and land that through a docs PR.`
    : `No revision was needed; ${DOC} keeps Status: ${now || '(unread)'}.`)
}
if (status === 'findings_remain') {
  steps.push(`${blocking(left).length + lintLines.length} blocking finding(s) remain (findings_remaining)${fixes ? ` after ${fixes} revise round(s)` : ''}: settle them (edit the doc, or decide what it should say), ` +
    `then re-run this workflow with the same args. Do not accept the doc until they are settled.`)
}
if (status === 'failed') steps.push(`Fix what stopped it (${stopReason}), then re-run this workflow with the same args.`)
if (other.length) steps.push(`${other.length} finding(s) name other docs (other_docs): refresh each of those docs with refresh-proposal { doc: '<that doc>', dir: '${DIR}' }.`)
if (drift.length) steps.push(`CLAUDE.md's ${drift.join(', ')} no longer match ${DOC}: copy each into CLAUDE.md in the same PR (CI's docs job fails on claude_md_drift).`)
if (lint && lint.behind_main > 0) steps.push(`The review grounded in ${lint.branch || 'this checkout'}, ${lint.behind_main} commit(s) behind origin's main branch as last fetched: update the checkout and re-run if those commits change what the doc builds on.`)
if (status === 'clean' && isProposal) {
  steps.push(`Once it is accepted and on main, build it: proposal-build-chain { proposal: '${DOC}', dir: '<checkout>', root: '<worktrees dir>', date: '<YYYYMMDD>' } ` +
    `(preview: ${lint.chains} chain(s), ${lint.lanes} lane(s), ${lint.blocked} blocked, ${lint.human_gates_pending} human gate(s) pending).`)
}
log(`Status: ${status}`)
return {
  status,
  ...(questions.length ? { questions, relay: RELAY } : {}),
  ...(stopReason ? { stop_reason: stopReason } : {}),
  doc: DOC,
  doc_status: now,
  rounds,
  revisions: fixes,
  findings_remaining: lintLines.concat(lines(left, f => oneLine(`${f.severity}: ${f.description}`))),
  ...(other.length ? { other_docs: lines(other, f => oneLine(`${f.severity}: ${norm(f.doc)}: ${f.description}`)) } : {}),
  lint: lint ? {
    errors: lintErrors,
    warnings: lint.warnings || 0,
    ...(isProposal ? { lanes: { chains: lint.chains || 0, lanes: lint.lanes || 0, blocked: lint.blocked || 0, human_gates_pending: lint.human_gates_pending || 0, errors: lint.lane_errors || 0 } } : {}),
    ...(drift.length ? { claude_md_drift: drift } : {}),
    ...(unconfirmed.length ? { unconfirmed: capped(unconfirmed) } : {}),
    ...(proposedValues.length ? { proposed: capped(proposedValues) } : {}),
  } : null,
  assumptions: ASSUMED,
  next_steps: steps,
}

export const meta = {
  name: 'idea-to-inception',
  description: 'Original software idea → your answers → competing architectural proposals (critiqued, revised, judged) → your decision → ADR, design doc and CLAUDE.md → walking-skeleton PR and the remaining steps as stacked build-only lanes. Stops to ask you at every decision.',
  whenToUse: 'Starting new software from an idea. Each run stops at a decision gate with status needs_input: ask the user its questions, then run it again with next_args plus their answers (the /inception command drives this loop). See the pipeline README.',
  phases: [
    { title: 'Intake', detail: 'restate the idea and ask what would change the architecture' },
    { title: 'Brief', detail: 'the brief, from your answers (follow-up questions when an answer opened one)' },
    { title: 'Directions', detail: 'candidate architectural directions for you to choose from' },
    { title: 'Proposals', detail: 'one independent proposal per direction you chose' },
    { title: 'Critique', detail: 'three critics per proposal, then each proposal is revised' },
    { title: 'Judge', detail: 'a judge panel scores every proposal against your priorities' },
    { title: 'Design', detail: 'what your choice still leaves open, asked before anything is written' },
    { title: 'Docs', detail: 'ADR, design doc with checkbox steps, CLAUDE.md with the quality gates' },
    { title: 'Build', detail: 'walking skeleton through plan-to-merged-pr, then the later steps as stacked lanes' },
  ],
}

// The pipeline asks instead of assuming. Each run advances to the next decision and returns there with
// status needs_input: the questions (shaped for AskUserQuestion: a header of at most 12 characters, 2–4 options)
// and next_args. The caller asks the user, sets next_args.answers[<question id>] and runs the workflow again.
// next_args.state carries everything decided so far, so no stage re-runs and every answer stays bound to the
// exact proposals and documents it answered — in this session or a later one. A run never proceeds past an
// unanswered question, and no stage may invent what the user has not said.
//
// Gates: intake (one or two rounds of questions) → directions (which compete) → decision (the winner, and grafts
// from the runners-up) → design (what the winner leaves open, gate commands included) → build (how far to go).
//
// args (a plain string is taken as `idea`):
//   idea: string             the software idea, in the user's words (required, on every run)
//   context?: string         anything else every stage should know
//   repo?: string            a checkout of the repository to start it in (default: the current checkout's)
//   root?: string            directory for the inception worktree and the lane worktrees (default: <repo>-worktrees)
//   slug?: string            kebab-case name for this inception (default: derived from the idea)
//   answers?: object         the user's answers to the pending questions, by question id (answers recorded at an
//                            earlier gate live in state and cannot be changed afterwards)
//   state?: object           from the previous run's next_args; pass it back unchanged
//   build_context?: string   the user's answers to questions a build step stopped on, handed to every build step
//   human_done?: number[]    human-gated design-doc steps the user has completed, so the steps after them can build
//   main_branch?: 'main', record_dir?: 'docs/inception'
//   max_questions?: 8 (per gate), intake_rounds?: 2 (1–3), directions?: 4 (3–4), critics?: 3 (1–3), judges?: 3 (1–5)
//   efforts?: { intake, brief, directions, propose, critique, revise, judge, synthesize, design, docs, publish }
//   commit_trailers?: string[]   lines the docs commit ends with
//   Passed through to plan-to-merged-pr for the build: planner, gate, ai_review_check, commit_trailers,
//   max_review_rounds, max_polish, max_monitor_rounds, and build_efforts (as its efforts).
const A = typeof args === 'string' ? { idea: args } : (args || {})
const IDEA = String(A.idea || '').trim()
if (!IDEA) throw new Error('idea-to-inception: pass args.idea (the software idea, in your own words), or the next_args a previous run returned')
if (A.state && A.state.v !== 1) throw new Error('idea-to-inception: args.state is not from this version of the workflow; start over without state and answers')
if (A.state && A.state.idea !== IDEA) throw new Error('idea-to-inception: args.idea differs from the idea args.state was built for; start over without state and answers')
const S = JSON.parse(JSON.stringify(A.state || {}))
S.v = 1
S.idea = IDEA
S.questions = S.questions || {}
S.answers = S.answers || {}
// Answers recorded when their gate passed live in state and win: a caller that drops or changes one cannot
// change what the stages after it were built on.
const ANS = { ...(A.answers || {}), ...S.answers }
const MAIN = A.main_branch || 'main'
const RECORD_DIR = String(A.record_dir || 'docs/inception').replace(/\/+$/, '')
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isInteger(v) ? v : d))
const MAX_QUESTIONS = clamp(A.max_questions, 1, 12, 8)
const INTAKE_ROUNDS = clamp(A.intake_rounds, 1, 3, 2)
const MAX_DIRECTIONS = clamp(A.directions, 3, 4, 4)
// AskUserQuestion shows at most four options, and the decision gate offers one per proposal.
const MAX_PROPOSALS = 4
const CRITICS = clamp(A.critics, 1, 3, 3)
const JUDGES = clamp(A.judges, 1, 5, 3)
// Leaders closer than this (weighted, 1–5 scale) are a judgement call: no option is marked recommended.
const CLOSE_CALL = 0.25
const MAX_CRITERIA = 8
const EFF = { intake: 'high', brief: 'medium', directions: 'high', propose: 'high', critique: 'medium', revise: 'medium', judge: 'high', synthesize: 'medium', design: 'high', docs: 'high', publish: 'low', ...(A.efforts || {}) }
const TRAILERS = (A.commit_trailers || ['Co-Authored-By: Claude <noreply@anthropic.com>']).join('\n')
const BUILD_SHARED = {}
for (const k of ['planner', 'gate', 'main_branch', 'ai_review_check', 'commit_trailers', 'max_review_rounds', 'max_polish', 'max_monitor_rounds']) if (A[k] !== undefined) BUILD_SHARED[k] = A[k]
if (A.build_efforts) BUILD_SHARED.efforts = A.build_efforts

// ---- Text helpers
const squash = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = squash(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t }
const words = (s, n) => squash(s).split(' ').slice(0, n).join(' ')
const slugify = (s, n) => squash(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n).replace(/-+$/, '')
const norm = s => squash(s).replace(/\s*\(recommended\)$/i, '').toLowerCase()
// A chip label of at most 12 characters: an agent's longer one is cut at a word boundary, never mid-word.
const chip = s => {
  const t = squash(s)
  if (t.length <= 12) return t
  const cut = t.slice(0, 13).lastIndexOf(' ')
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, 12)).trim()
}
// An option label: at most five words, without a "(Recommended)" an agent wrote into it (the workflow adds its own).
const label5 = s => words(squash(s).replace(/\s*\(recommended\)$/i, ''), 5)
const asList = v => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(squash).filter(Boolean)
// Only an answer that is wholly "none" means none; "Neither as written: …" is the user's own answer.
const NONE = /^(none|nothing|neither)( of (them|these|those|the above))?[\s.!]*$/i

// ---- Prompt fragments
const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route (Bash, python, sed, heredocs, a different file path); report it as blocked. `
const AUTH = `For gh/git network commands use the GH_WRAPPER prefix from the "Pipeline config" section of CLAUDE.md when it is set and works here; otherwise run gh/git directly (ambient auth works). `
const READ_ONLY = `Read-only: change no file and no git state (a git fetch is fine). `
const ASK = `Ask, never assume. Design choices are yours to make and to justify; facts about the users, their scale, data, constraints and preferences are not — take them only from the brief and the user's answers, and never invent a requirement. ` +
  `Anything you need that they do not state is an open question, or in a proposal an assumption marked "needs confirmation" — never a silent decision. `
const where = () => `Work ONLY in the git checkout ${S.dir} (branch ${S.branch}), with absolute paths; read CLAUDE.md from that checkout's root when it has one. Never run git stash: every worktree of the repository shares one stash list. `
const at = rel => `${S.dir}/${rel}`
const BRIEF = () => `${S.record}/brief.md`
const COMPARISON = () => `${S.record}/comparison.md`
const propPath = key => `${S.record}/proposals/${key}.md`
const QUESTION_FORMAT = `the same format as the intake questions: header of at most 12 characters (such as "Gates" or "CI"), question, why, multi_select, 2–4 options with label (1–5 words) and description, and recommended only with a reason`

// ---- Schemas
const OPTION = { type: 'object', properties: { label: { type: 'string', description: '1–5 words' }, description: { type: 'string', description: 'one line: what choosing it implies' } }, required: ['label', 'description'] }
const QUESTION = {
  type: 'object',
  properties: {
    header: { type: 'string', description: 'chip label, at most 12 characters' },
    question: { type: 'string', description: 'one sentence ending with "?"' },
    why: { type: 'string', description: 'the decision its answer drives' },
    multi_select: { type: 'boolean' },
    options: { type: 'array', items: OPTION, description: '2 to 4 concrete, distinct answers; no "Other" option' },
    recommended: { type: 'string', description: 'label of the option the idea, the brief or the proposal itself argues for; "" when none does' },
    recommended_reason: { type: 'string' },
  },
  required: ['header', 'question', 'why', 'multi_select', 'options'],
}
const INTAKE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'the product, at most 6 words' },
    slug: { type: 'string', description: 'kebab-case, at most 40 characters, not already in use' },
    restated: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' }, description: 'only what the user said or the repository shows' },
    repo: {
      type: 'object',
      properties: {
        toplevel: { type: 'string' },
        main_ok: { type: 'boolean', description: 'origin/<main branch> resolves to a commit' },
        greenfield: { type: 'boolean' },
        existing: { type: 'string', description: 'the software the repository already holds; "" when greenfield' },
        has_ci: { type: 'boolean' },
        has_license: { type: 'boolean' },
        conventions: { type: 'string', description: 'what later steps must follow: a CLAUDE.md Pipeline config (quoted), ADR or design-doc directories and formats' },
      },
      required: ['toplevel', 'main_ok', 'greenfield', 'existing', 'has_ci', 'has_license', 'conventions'],
    },
    questions: { type: 'array', items: QUESTION },
  },
  required: ['title', 'slug', 'restated', 'facts', 'repo', 'questions'],
}
const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    blocked: { type: 'boolean', description: 'true if the inception checkout could not be set up (then nothing else was done)' },
    blocked_reason: { type: 'string' },
    summary: { type: 'string', description: 'three to five lines' },
    quality_attributes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, top: { type: 'boolean', description: 'the user ranked it among the most important' } },
        required: ['key', 'name', 'description', 'top'],
      },
    },
    hard_constraints: { type: 'array', items: { type: 'string' } },
    follow_up_questions: { type: 'array', items: QUESTION },
  },
  required: ['blocked', 'summary', 'quality_attributes', 'hard_constraints', 'follow_up_questions'],
}
const DIRECTIONS_SCHEMA = {
  type: 'object',
  properties: {
    directions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, label: { type: 'string', description: '1–5 words' }, sketch: { type: 'string' }, optimizes: { type: 'string' }, sacrifices: { type: 'string' }, serves: { type: 'string' } },
        required: ['key', 'label', 'sketch', 'optimizes', 'sacrifices', 'serves'],
      },
    },
    recommended: { type: 'array', items: { type: 'string' }, description: 'keys of the directions that should compete' },
    recommended_reason: { type: 'string' },
  },
  required: ['directions', 'recommended', 'recommended_reason'],
}
const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'two or three sentences' },
    stack: { type: 'array', items: { type: 'string' } },
    top_risk: { type: 'string', description: 'one line' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'each assumption marked needs confirmation, one line each' },
  },
  required: ['summary', 'stack', 'top_risk', 'assumptions'],
}
const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, section: { type: 'string' }, finding: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } },
        required: ['severity', 'section', 'finding', 'evidence', 'fix'],
      },
    },
    hidden_assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'hidden_assumptions'],
}
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: { proposal: { type: 'string', description: 'proposal key' }, criterion: { type: 'string', description: 'criterion key' }, score: { type: 'integer', minimum: 1, maximum: 5 }, why: { type: 'string' } },
        required: ['proposal', 'criterion', 'score', 'why'],
      },
    },
    dealbreakers: {
      type: 'array',
      items: { type: 'object', properties: { proposal: { type: 'string' }, constraint: { type: 'string' }, evidence: { type: 'string' } }, required: ['proposal', 'constraint', 'evidence'] },
    },
    grafts: {
      type: 'array',
      items: { type: 'object', properties: { from: { type: 'string', description: 'source proposal key' }, idea: { type: 'string' }, benefit: { type: 'string' } }, required: ['from', 'idea', 'benefit'] },
    },
  },
  required: ['scores', 'dealbreakers', 'grafts'],
}
const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'three to five lines for the user' },
    recommendation_reason: { type: 'string' },
    grafts: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string', description: '1–5 words' }, from: { type: 'string', description: 'source proposal key' }, idea: { type: 'string' }, benefit: { type: 'string' } }, required: ['label', 'from', 'idea', 'benefit'] },
    },
  },
  required: ['summary', 'recommendation_reason', 'grafts'],
}
const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    base_proposal: { type: 'string', description: 'key of the proposal the design builds on; "" when that is itself one of the questions' },
    summary: { type: 'string', description: 'what the design will be, in three lines' },
    questions: { type: 'array', items: QUESTION },
  },
  required: ['base_proposal', 'summary', 'questions'],
}
const DOCS_SCHEMA = {
  type: 'object',
  properties: {
    adr: { type: 'string', description: 'path relative to the checkout root' },
    design_doc: { type: 'string', description: 'path relative to the checkout root' },
    claude_md: { type: 'string', description: 'created, updated or unchanged, naming any value replaced' },
    gates: { type: 'object', properties: { full: { type: 'string' }, fast: { type: 'string' } }, required: ['full', 'fast'] },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' }, title: { type: 'string' }, description: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'integer' } }, acceptance: { type: 'array', items: { type: 'string' } },
          human_gated: { type: 'string', description: 'what a person must do; "" for a code step' },
        },
        required: ['number', 'title', 'description', 'depends_on', 'acceptance', 'human_gated'],
      },
    },
    commit_sha: { type: 'string', description: 'git rev-parse HEAD after the commit' },
    summary: { type: 'string' },
  },
  required: ['adr', 'design_doc', 'claude_md', 'gates', 'steps', 'commit_sha', 'summary'],
}
const PUBLISH_SCHEMA = {
  type: 'object',
  properties: { blocked: { type: 'boolean' }, blocked_reason: { type: 'string' }, pr_number: { type: 'integer' }, url: { type: 'string' } },
  required: ['blocked'],
}

// ---- Questions and answers
// Stored as { id, gate, header, question, why, multi_select, options: [{ label, description }], recommended: [label], recommended_reason }.
// The placeholder option that keeps a free-text question askable; picking it means "let me write it", not an answer.
const OWN_WORDS = { label: 'In my own words', description: 'Choose Other and write your answer; this option alone is not an answer.' }
const ownWords = q => asList(ANS[q.id]).some(p => norm(p) === norm(OWN_WORDS.label))
const answered = q => Object.prototype.hasOwnProperty.call(ANS, q.id) && !ownWords(q) &&
  (asList(ANS[q.id]).length > 0 || (q.multi_select && Array.isArray(ANS[q.id])))
// The user's answer: each part matched to an option where it names one, otherwise kept as their own words.
const picks = q => {
  const parts = asList(ANS[q.id])
  if (q.multi_select && parts.length === 1 && NONE.test(parts[0])) return []
  return parts.map(p => {
    const o = q.options.find(x => norm(x.label) === norm(p))
    return o ? { option: o.label, text: o.label } : { option: null, text: p }
  })
}
const answerText = q => {
  if (!answered(q)) return '(no answer)'
  const ps = picks(q)
  if (!ps.length) return q.multi_select ? 'none' : '(no answer)'
  return ps.map(p => {
    const o = p.option && q.options.find(x => x.label === p.option)
    return o ? `${o.label} — ${o.description}` : `"${p.text}" (in the user's own words)`
  }).join('; ')
}
const qa = gate => Object.values(S.questions).filter(q => q.gate === gate).map(q => `- [${q.id}] ${q.question}\n  Answer: ${answerText(q)}`).join('\n')
// A question an agent wrote, made askable: unique option labels of 1–5 words, 2–4 options, a short header.
const PAD = [{ label: 'No preference', description: 'Leave it to the proposals, which must decide it with reasons.' }, OWN_WORDS]
const addQuestions = (gate, prefix, list) => {
  const taken = Object.keys(S.questions).filter(id => new RegExp(`^${prefix}\\d+$`).test(id)).length
  const raw = (list || []).filter(q => q && squash(q.question))
  if (raw.length > MAX_QUESTIONS) log(`${gate}: the agent asked ${raw.length} questions (max_questions is ${MAX_QUESTIONS}); all are asked, none is assumed`)
  return raw.map((q, i) => {
    const seen = new Set()
    const options = []
    for (const o of q.options || []) {
      // A label over five words keeps its full text at the head of the description rather than losing it.
      const full = squash(o && o.label).replace(/\s*\(recommended\)$/i, '')
      const label = label5(full)
      if (!label || seen.has(norm(label)) || options.length === 4) continue
      seen.add(norm(label))
      options.push({ label, description: clip(label === full ? o.description : `${full} — ${squash(o.description)}`, 240) })
    }
    for (const pad of PAD) if (options.length < 2 && !seen.has(norm(pad.label))) options.push(pad)
    const recommended = asList(q.recommended).map(r => options.find(o => norm(o.label) === norm(r))).filter(Boolean).map(o => o.label)
    const n = taken + i + 1
    const item = {
      id: `${prefix}${n}`, gate, header: chip(q.header) || `Question ${n}`,
      question: squash(q.question), why: squash(q.why), multi_select: !!q.multi_select, options,
      recommended, recommended_reason: recommended.length ? squash(q.recommended_reason) : '',
    }
    S.questions[item.id] = item
    return item
  })
}
// As AskUserQuestion wants it: a recommended option first, with "(Recommended)" on its label.
const shown = q => {
  const rec = q.recommended || []
  const ordered = [...q.options.filter(o => rec.includes(o.label)), ...q.options.filter(o => !rec.includes(o.label))]
  return {
    id: q.id, header: q.header, question: q.question, multiSelect: q.multi_select,
    options: ordered.map(o => ({ label: rec.includes(o.label) ? `${o.label} (Recommended)` : o.label, description: o.description })),
    why: q.why + (q.recommended_reason ? ` Recommended: ${q.recommended_reason}` : ''),
  }
}

// ---- Results
const HOW = `Ask the user every question below, in order, with AskUserQuestion (at most 4 per call), using each question's header, question, options and multiSelect as given; you may add its "why" to the question text. ` +
  `Do not answer for the user, pre-select, skip or merge questions: a "(Recommended)" option is advice, not a default. The user may answer in their own words. ` +
  `Then run this workflow again with next_args, after setting next_args.answers[<question id>] to the chosen option's label (an array of labels for a multiSelect question; [] for none) or the user's own words. Pass next_args.state back unchanged.`
const artifacts = () => {
  const f = {}
  if (S.dir) f.worktree = S.dir
  if (S.brief) f.brief = at(BRIEF())
  if (S.proposals) f.proposals = S.proposals.map(p => at(p.path))
  if (S.comparison) f.comparison = at(COMPARISON())
  if (S.docs) { f.adr = at(S.docs.adr); f.design_doc = at(S.docs.design_doc) }
  return f
}
// `clear` drops answers that are to be asked again, from the args and from state.
const without = (o, ids) => { const c = { ...o }; for (const id of ids) delete c[id]; return c }
const ask = (gate, qs, summary, extra = {}) => {
  const { clear = [], ...rest } = extra
  return {
    status: 'needs_input', gate, summary, ...rest, artifacts: artifacts(),
    questions: qs.map(shown),
    next_args: { ...A, answers: without(ANS, clear), state: { ...S, answers: without(S.answers, clear), pending: { gate, ids: qs.map(q => q.id) } } },
    how_to_continue: HOW,
  }
}
const done = (status, extra = {}) => ({ status, slug: S.slug || '', title: S.title || '', branch: S.branch || '', ...extra, artifacts: artifacts() })
// A stage that failed to report: retry_args re-runs it, keeping everything decided before it.
const failed = (stage, extra = {}) => done(`failed_at_${stage}`, { ...extra, retry_args: { ...A, answers: ANS, state: { ...S, pending: null } } })

// ---- Prompts
const REPO_AT = A.repo ? `the repository checked out at ${A.repo}: run every command there` : 'the repository of the current working directory'
const intakePrompt = () => GUARD + AUTH + READ_ONLY +
  `You are the intake step of a pipeline that takes an original software idea to an architecture decision and a walking skeleton. The pipeline asks the user instead of assuming: your job is to find what is still open, not to decide it.\n\n` +
  `The idea, in the user's words: ${JSON.stringify(IDEA)}\n` +
  (A.context ? `What else the user said: ${JSON.stringify(A.context)}\n` : '') +
  `\n1. The repository (${REPO_AT}). repo.toplevel: git rev-parse --show-toplevel. Run git fetch origin ${MAIN}; repo.main_ok: whether origin/${MAIN} then resolves to a commit (false for an empty repository or a missing remote). ` +
  `repo.greenfield: true when it holds no software yet (only files such as README, LICENSE, .gitignore, CLAUDE.md, .claude/ or docs/); otherwise false, with repo.existing describing what is there (languages, frameworks, layout, size). ` +
  `repo.has_ci: whether any CI configuration exists (.github/workflows, .gitlab-ci.yml, …). repo.has_license: whether a LICENSE file exists. ` +
  `repo.conventions: what later steps must follow — an existing CLAUDE.md "Pipeline config" section (quote it), ADR or design-doc directories and their format.\n` +
  `2. restated: the idea in two or three sentences. facts: only what the user actually said or the repository shows, one per entry — never an inference.\n` +
  `3. questions: what the idea and the repository leave open that would change the architecture. Consider each of these, and ask only where the idea is silent or ambiguous:\n` +
  `   - who uses it, and how they reach it (people in a browser, a phone app, a desktop app or a terminal; or other software through an API);\n` +
  `   - the scale to design for at launch and in a year (users, data, request rate), as an order of magnitude;\n` +
  `   - the data it keeps: what kind, how sensitive (personal, financial, health), for how long, and any compliance it must meet;\n` +
  `   - the systems it must integrate with;\n` +
  `   - where it must run and what it may cost to run (a cloud, self-hosted, on the user's device; a budget);\n` +
  `   - languages, frameworks or services the team prefers, knows or must avoid;\n` +
  `   - what the first usable version must do, and what is explicitly out of scope;\n` +
  `   - which quality attributes matter most: ask this unless the idea ranks them, as a multi-select of the four most relevant to this idea (for example time to market, running cost, scalability, reliability, security and privacy, offline use, latency, ease of operation).\n` +
  `   Do not ask what the idea or the repository already answers, what would not change the architecture, or what a later design step settles once the architecture is chosen (libraries, naming, screens). At most ${MAX_QUESTIONS} questions, the most architecture-shaping first; fewer is better.\n` +
  `   Each question: header (a chip label of at most 12 characters, such as "Platform", "Scale", "Data" or "MVP scope"), question (one sentence ending with "?"), why (the architectural decision its answer drives), multi_select (true when several answers can hold at once), and 2–4 options — concrete, distinct answers, each with a label of 1–5 words and a one-line description of what choosing it implies for the architecture. Add no "Other" or "Not sure" option: the user can always answer in their own words. ` +
  `Set recommended to an option's label only when the idea itself argues for it, with recommended_reason saying how; otherwise leave both empty. Never recommend just to fill a gap.\n` +
  `4. title: the product, in at most 6 words. slug: kebab-case, at most 40 characters, not already used by a branch inception/<slug> (git branch -a) or a directory ${RECORD_DIR}/<slug> on origin/${MAIN}.`

const setupPrompt = () =>
  `Set up the inception checkout first. In ${S.repo.toplevel}: git fetch origin ${MAIN}. If ${S.dir} does not exist: when branch ${S.branch} exists (locally, or as origin/${S.branch}), git worktree add ${S.dir} ${S.branch}; otherwise git worktree add -b ${S.branch} ${S.dir} origin/${MAIN}. ` +
  `If ${S.dir} exists, it must be a checkout of ${S.branch} (git -C ${S.dir} rev-parse --abbrev-ref HEAD): if it is not, do nothing else and return blocked=true with the reason. `
const briefPrompt = last => GUARD + AUTH + setupPrompt() + where() + ASK +
  `Then write the brief for ${S.title} to ${at(BRIEF())} (create its directories). It is the single source of truth every later step reads, so it holds what the user said and nothing more.\n` +
  `The idea, in the user's words: ${JSON.stringify(IDEA)}\n` + (A.context ? `What else the user said: ${JSON.stringify(A.context)}\n` : '') +
  `What intake found: ${JSON.stringify({ restated: S.restated, facts: S.facts, repo: S.repo })}\n` +
  `Every question asked so far, with the user's answer:\n${qa('intake') || '(none were needed)'}\n\n` +
  `The answers are decisions: each one binds the brief. An answer such as "No preference" or "you decide" delegates that choice: record it under Delegated decisions, for the proposals to decide with reasons. A gap the user did not fill goes under Open questions — never fill it yourself.\n` +
  `Sections: # Brief: ${S.title}; ## Idea; ## Users and how they reach it; ## First version (what it must do); ## Out of scope; ## Functional requirements (numbered, each testable); ## Quality attributes (each with the user's priority and, where the answers give one, a measurable target); ## Constraints (hard: what must hold — technology, hosting, budget, compliance, dates; soft: preferences); ## Integrations; ## Delegated decisions; ## Open questions; ## Q&A (every question and answer above, verbatim).\n` +
  `Return: summary (three to five lines); quality_attributes — those the brief relies on, each with key (one lowercase word), name, description, and top=true when the user ranked it among the most important; hard_constraints (one line each); ` +
  (last
    ? `follow_up_questions=[] — there are no more question rounds, so what is still open goes under Open questions. `
    : `follow_up_questions — only for something an answer opened that would change the architecture and that no answer settles (for example "a phone app" without saying which platforms); none is the normal case. At most ${MAX_QUESTIONS}, in ${QUESTION_FORMAT}. `) +
  `Do not commit.`

const directionsPrompt = () => GUARD + READ_ONLY + ASK +
  `Read the brief ${at(BRIEF())} in full. Propose up to ${MAX_DIRECTIONS} (at least three) candidate architectural directions for ${S.title}: genuinely different bets, not variations of one — any two must differ in at least two of deployment topology, data and storage model, runtime or interaction model, and build versus buy. One must be the simplest thing that satisfies the brief. ` +
  `Every direction respects the brief's hard constraints; one that relaxes a soft constraint says which and why. Settle each delegated decision per direction, with the reason. ` +
  (S.repo.greenfield ? '' : `The repository already holds software (${S.repo.existing}): each direction says how it relates to it (extends it, sits beside it, or replaces it). `) +
  `For each: key (one lowercase word, unique), label (1–5 words naming the bet), sketch (one paragraph: the main components, where they run, how data flows), optimizes (what it is best at), sacrifices (what it gives up), serves (which of the brief's quality attributes it serves). ` +
  `Then recommend which of them (two to ${MAX_PROPOSALS}) should compete as full proposals, by key, and why — the user decides.`

const proposePrompt = (d, others) => GUARD + where() + ASK +
  `Write ONE of ${S.chosen.length} competing architectural proposals for ${S.title}. Read the brief ${at(BRIEF())} in full first.\n` +
  `Your direction: ${d.label} — ${d.sketch}${d.custom ? ' (the user described this direction in their own words: honour it, and fill in the rest)' : ''}\n` +
  `It competes with: ${others.map(o => o.label).join('; ')}. Do not read the other proposals. Make the strongest honest case for your direction, its costs included.\n` +
  `Write ${at(propPath(d.key))} with these sections: # Proposal: ${d.label}; ## Summary (three sentences); ## Architecture (the components and their responsibilities, where each runs, a mermaid diagram, and the data flow of the two or three key use cases); ` +
  `## Technology choices (each with its reason, tied to the brief, and the alternative it beat); ## Data model and storage; ## Interfaces and integrations; ## Quality attributes (how the design meets each one in the brief, at the user's priority; a measurable target where the brief gives one); ## Security and privacy; ` +
  `## Operations (deployment, environments, observability, backups, and the running cost at the brief's scale as an order of magnitude); ## Risks (each with its mitigation, and what would make this proposal fail); ` +
  `## Assumptions (everything the design depends on that the brief does not establish, each marked "needs confirmation" — never bury one in the text); ## Walking skeleton (the thinnest end-to-end slice that exercises every major component, its quality-gate commands for lint, type checking and tests, and how CI would run them); ` +
  `## Roadmap (the increments after the skeleton, in order, each one pull request with acceptance criteria).\n` +
  `Return summary (two or three sentences), stack (the main technologies), top_risk (one line) and assumptions (one line each). Do not commit, and edit no other file.`

const LENSES = [
  { key: 'fit', name: 'Requirements fit and hidden assumptions', ask: "Does it meet every functional requirement, quality attribute (at the user's priority) and hard constraint in the brief? What does it add that nobody asked for? What does it silently assume?" },
  { key: 'delivery', name: 'Feasibility and delivery risk', ask: "Can the walking skeleton and the roadmap be built as described, one pull request at a time? What is underestimated, immature, mismatched with the team's stated skills, or risky to integrate?" },
  { key: 'operations', name: 'Operations, security and cost', ask: "What does it cost to run at the brief's scale, and to operate? How does it fail and recover, and can it lose data? Where are the security, privacy and compliance gaps?" },
]
const critiquePrompt = (p, lens) => GUARD + READ_ONLY +
  `Critique the architectural proposal ${at(p.path)} (direction: ${p.label}) for the brief ${at(BRIEF())} through one lens only — ${lens.name}: ${lens.ask}\n` +
  `Report findings, each with its severity (blocker: it cannot meet a stated requirement or hard constraint as written; major: a serious risk or gap that needs a design change; minor), the proposal section it concerns, the evidence (quote the proposal and the brief), and what would fix it. Be specific: no generic advice, and a strength is not a finding. ` +
  `In hidden_assumptions, list everything the proposal relies on that the brief does not establish and its Assumptions section does not already list.`
const revisePrompt = (p, crits) => GUARD + where() + ASK +
  `Revise the proposal ${at(p.path)} (direction: ${p.label}) in response to its critiques below. Keep the direction: do not drift toward another proposal. ` +
  `Fix every blocker and major finding you can within the direction; for one you cannot, say so plainly in a "## Known weaknesses" section. Add each hidden assumption to the Assumptions section, marked "needs confirmation". ` +
  `Append "## Critique and response": each finding with its resolution (changed, conceded, or disputed — with the reason).\n` +
  `Critiques:\n${JSON.stringify(crits, null, 1)}\n` +
  `Return the revised summary, stack, top_risk and assumptions. Do not commit, and edit no other file.`

const judgePrompt = (j, props) => {
  // Each judge reads the proposals in a different order, so no proposal always benefits from coming first or last.
  const order = props.map((_, i) => props[(i + j) % props.length])
  return GUARD + READ_ONLY +
    `You are judge ${j + 1} of ${JUDGES}, comparing ${props.length} competing architectural proposals for ${S.title}. Read the brief ${at(BRIEF())}, then the proposals in this order, including their critique responses and known weaknesses: ${order.map(p => `${p.key} (${at(p.path)})`).join(', ')}.\n` +
    `Score every proposal on every criterion from 1 (poor) to 5 (excellent), each with a one-line reason that cites the proposal. Judge what each would actually deliver for this brief, not how well it is written, and use the whole scale. Criteria, by key:\n` +
    S.brief.criteria.map(c => `- ${c.key}: ${c.name} — ${c.description}`).join('\n') + '\n' +
    `Flag a dealbreaker only when a proposal violates a hard constraint of the brief (${S.brief.hard_constraints.length ? S.brief.hard_constraints.join('; ') : 'it lists none'}), quoting both. ` +
    `Then name the strongest ideas any proposal has that another could adopt without changing its core (grafts), each with its source proposal key.`
}
const synthPrompt = (props, t) => GUARD + where() +
  `Write ${at(COMPARISON())}: how the proposals for ${S.title} compare. Read the brief and the proposals (${props.map(p => at(p.path)).join(', ')}). ` +
  `Use these computed results exactly as given — weighted totals on a 1–5 scale, weighted by the user's priorities (do not recompute or round them differently):\n${JSON.stringify(t.table, null, 1)}\n` +
  `The judges' reasons, dealbreakers and graft ideas:\n${JSON.stringify(t.notes, null, 1)}\n` +
  `Sections: # Comparison: ${S.title}; ## Recommendation (${t.recommendation ? `${t.recommendation}${t.close ? ' — but the top two are within judging noise: say what would tip the decision' : ', and why'}` : 'none of the proposals clears the panel: say why'}); ` +
  `## Scores (a table of the criteria and their weights by proposal, with the weighted totals; mark each score whose judges differ by 2 or more); ## Where the judges disagreed; ## Dealbreakers; ## Each proposal (its strongest case, its biggest risk, and what would have to be true to choose it); ## Candidate grafts; ## What the decision still depends on.\n` +
  `Return summary (three to five lines for the user), recommendation_reason (one or two sentences), and grafts — at most 3, merged from the judges' lists, each with label (1–5 words), from (the source proposal key), idea and benefit. Do not commit.`

const designPrompt = () => {
  const base = S.proposals.find(p => p.key === S.decision.base)
  return GUARD + READ_ONLY + ASK +
    `The user chose the architecture for ${S.title}. Their answer: ${JSON.stringify(S.decision.answer)}` +
    (base ? ` — the proposal ${at(base.path)}.` : ` — in their own words, so read it against every proposal (${S.proposals.map(p => `${p.key}: ${at(p.path)}`).join(', ')}).`) +
    ` Grafts adopted from other proposals: ${S.decision.grafts.length ? JSON.stringify(S.decision.grafts) : 'none'}.\n` +
    `Read the brief ${at(BRIEF())}, the comparison ${at(COMPARISON())} and the chosen proposal. Before the design doc is written, list as questions what must still be confirmed:\n` +
    (base ? '' : `- first, which proposal the design builds on, when the user's answer does not identify exactly one;\n`) +
    `- each assumption the chosen proposal marks "needs confirmation" that the brief and the user's answers do not already settle;\n` +
    `- each conflict an adopted graft introduces;\n` +
    `- each decision the proposal defers that the walking skeleton or the first roadmap steps depend on;\n` +
    `- always: the quality-gate commands the skeleton will establish for the chosen stack (lint, type checking, tests, and a faster subset) — each option labelled in a few words (for example "Lint, types, tests") with the exact QUALITY_GATES and QUALITY_GATES_FAST commands in its description;\n` +
    (S.repo.has_ci ? '' : `- always, since the repository has no CI: whether the skeleton should add CI that runs the gates on every pull request, and on which service;\n`) +
    (S.repo.has_license ? '' : `- the license, unless the brief settles it (the repository has none);\n`) +
    `Skip anything already decided. At most ${MAX_QUESTIONS}, in ${QUESTION_FORMAT}. ` +
    `Return base_proposal (the key of the proposal the design builds on, or "" when that is one of the questions) and summary (what the design will be, in three lines).`
}
const docsPrompt = () => {
  const base = S.proposals.find(p => p.key === S.design.base)
  // A rejected proposal whose file a later proposal reused is not named: that file now holds the later one.
  const rejected = (S.rejected || []).filter((r, i, all) => !S.proposals.some(p => p.path === r.path) && all.findIndex(x => x.path === r.path) === i)
  return GUARD + where() + ASK +
    `Write the inception package for ${S.title} and commit it on ${S.branch}. Read first: the brief ${at(BRIEF())}, the comparison ${at(COMPARISON())}, the proposals (${S.proposals.map(p => at(p.path)).join(', ')}) and the decisions below.\n` +
    `The architecture the user chose: ${JSON.stringify(S.decision.answer)}${base ? ` (proposal ${base.key}, ${at(base.path)})` : ''}. Adopted grafts: ${S.decision.grafts.length ? JSON.stringify(S.decision.grafts) : 'none'}.\n` +
    (rejected.length ? `Proposals the user rejected in an earlier round, together with the rest of that round (their files stay in the record; list them in the ADR's Alternatives considered): ${rejected.map(r => `${r.label} (${r.path})`).join('; ')}.\n` : '') +
    `Design questions and the user's answers — decisions, to follow exactly:\n${qa('design') || '(none were needed)'}\n\n` +
    `1. ADR. Follow the repository's ADR convention if it has one (directory, numbering, template); otherwise write docs/adr/0001-${S.slug}-architecture.md: title; Status: Accepted; Context (from the brief); Decision (the chosen architecture and the adopted grafts); Alternatives considered (every other proposal, why it lost, a link to its file); Consequences (good, bad, risks); References (the brief, the comparison, the design doc).\n` +
    `2. Design doc: docs/design/${S.slug}.md (or the same name in the PROPOSALS_DIR the repository's CLAUDE.md sets): the buildable design. Sections: Overview; Architecture (components, responsibilities, data flow, a mermaid diagram); Technology decisions (each with its reason, tied to the brief or an answer); Data model; Interfaces; Quality attributes and how each is met; Security; Operations; Risks; Open questions (only what the user left open); and "## Steps", an ordered checkbox list in exactly this form, which /impl and the workflows parse:\n` +
    `   1. [ ] **Walking skeleton.** <the thinnest end-to-end slice through every major component: the project scaffolding and the quality gates passing${S.repo.has_ci ? '' : ', plus CI if the user chose it'}>\n      - Depends on: none\n      - Acceptance: <checkable criteria>\n   2. [ ] **<Title>.** <what it adds>\n      - Depends on: 1\n      - Acceptance: <checkable criteria>\n` +
    `   Each step after the skeleton is one pull request: one coherent change that /plan can cover in at most about seven implementation steps, ordered so that a step depends only on earlier ones. A step that needs a person rather than code (a production rollout, account or billing setup, a sign-off) gets a "- Human-gated: <what the person does>" sub-bullet. Every acceptance criterion is checkable by a test or a command.\n` +
    `3. CLAUDE.md at the checkout root. If it is missing, create it with a one-paragraph overview; ## Architecture invariants (the rules the design depends on, which later changes must not break); ## Testing (the testing rules for this stack: what to mock, where tests live); and ## Pipeline config with QUALITY_GATES and QUALITY_GATES_FAST set to the confirmed gate commands, MAIN_BRANCH: ${MAIN}, PROPOSALS_DIR set to the design doc's directory, and TEST_GUIDELINES: CLAUDE.md#testing. ` +
    `If it exists, keep everything in it and add or update only those sections: set QUALITY_GATES and QUALITY_GATES_FAST to the confirmed commands, keep every other existing key, and report each value you replaced.\n` +
    `4. Commit on ${S.branch}: stage by explicit path ${S.record}/, the ADR, the design doc and CLAUDE.md, with the message "docs(inception): ${S.title} — brief, proposals, decision and design" followed by a blank line and:\n${TRAILERS}\nDo not push.\n` +
    `Return adr and design_doc (paths relative to the checkout root), claude_md (created, updated or unchanged, naming any value replaced), gates ({ full, fast }), steps (number, title, description, depends_on as step numbers, acceptance as a list, human_gated as the person's action or ""), commit_sha (git rev-parse HEAD after the commit) and summary (three lines).`
}
const publishPrompt = () => GUARD + AUTH + where() +
  `Push ${S.branch} (git push -u origin ${S.branch}; never force, never ${MAIN}). If an open pull request for ${S.branch} already exists (gh pr view ${S.branch} --json number,url,state), return it; otherwise open a non-draft pull request into ${MAIN} titled ${JSON.stringify(clip(`Inception: ${S.title} — design docs`, 70))}. ` +
  `Its body: a summary of the decision (from ${S.docs.adr}), the design doc's steps as a list (${S.docs.design_doc}), and a line saying it holds documents only; end it with the attribution line this session uses for pull requests. Write the body to a file and pass it with --body-file. ` +
  `Return pr_number and url; set blocked=true, with the reason, if it could not be opened.`

// ---- Scoring, in code: judges score, the script does the arithmetic.
const criteriaFrom = qas => {
  const out = [
    { key: 'fit', name: 'Requirements fit', weight: 3, description: 'meets every functional requirement and hard constraint in the brief, adding nothing it did not ask for' },
    { key: 'delivery', name: 'Delivery risk', weight: 2, description: 'how surely the walking skeleton and the roadmap land as described, one pull request at a time (5 = least risk)' },
  ]
  // Top priorities first, so a cap never drops one of them.
  for (const q of [...(qas || [])].sort((a, b) => (b.top ? 1 : 0) - (a.top ? 1 : 0))) {
    const key = slugify(q.key || q.name, 24)
    if (!key || out.some(c => c.key === key)) continue
    out.push({ key, name: clip(q.name, 60), weight: q.top ? 3 : 1, description: clip(q.description, 200) })
  }
  if (out.length > MAX_CRITERIA) log(`Judging on ${MAX_CRITERIA} criteria; left out: ${out.slice(MAX_CRITERIA).map(c => c.name).join(', ')}`)
  return out.slice(0, MAX_CRITERIA)
}
const tally = (props, runs) => {
  const keys = props.map(p => p.key)
  const criteria = S.brief.criteria
  const cells = {}, breakers = {}, notes = []
  runs.forEach((r, j) => {
    if (!r) return
    // One score per judge per proposal and criterion: a judge that repeats a pair cannot weigh it twice.
    const seen = new Set()
    for (const s of r.scores || []) {
      const cell = `${s.proposal}|${s.criterion}`
      const v = Math.round(Number(s.score))
      if (!keys.includes(s.proposal) || !criteria.some(c => c.key === s.criterion) || seen.has(cell) || !(v >= 1 && v <= 5)) continue
      seen.add(cell)
      ;(cells[cell] = cells[cell] || []).push(v)
    }
    for (const p of new Set((r.dealbreakers || []).map(d => d.proposal).filter(p => keys.includes(p)))) breakers[p] = (breakers[p] || 0) + 1
    notes.push({ judge: j + 1, scores: r.scores, dealbreakers: r.dealbreakers, grafts: r.grafts })
  })
  const judged = notes.length
  const round2 = x => Math.round(x * 100) / 100
  const totals = {}, rows = []
  for (const p of keys) {
    let acc = 0, weights = 0
    const scores = {}
    for (const c of criteria) {
      const a = cells[`${p}|${c.key}`]
      if (!a || !a.length) continue
      const mean = a.reduce((x, y) => x + y, 0) / a.length
      acc += c.weight * mean
      weights += c.weight
      scores[c.key] = { mean: round2(mean), spread: Math.max(...a) - Math.min(...a), judges: a.length }
    }
    totals[p] = weights ? round2(acc / weights) : null
    rows.push({ proposal: p, total: totals[p], dealbreaker_flags: breakers[p] || 0, scores })
  }
  const ranking = [...keys].sort((a, b) => (totals[b] == null ? -1 : totals[b]) - (totals[a] == null ? -1 : totals[a]))
  // A dealbreaker flagged by most judges takes a proposal out of the recommendation, never out of the user's choice.
  const viable = ranking.filter(p => totals[p] != null && (breakers[p] || 0) * 2 <= judged)
  const recommendation = viable[0] || null
  const close = viable.length > 1 && totals[viable[0]] - totals[viable[1]] < CLOSE_CALL
  return { judged, totals, breakers, ranking, recommendation, close, notes, table: { criteria, proposals: rows } }
}
const proposalFields = r => ({ summary: squash(r.summary), stack: (r.stack || []).map(squash), top_risk: squash(r.top_risk), assumptions: (r.assumptions || []).map(squash) })
const ADOPT_NONE = { label: 'Adopt none', description: 'Keep the chosen proposal as it is.' }

// ---- Never past an unanswered question
if (S.pending) {
  const waiting = S.pending.ids.map(id => S.questions[id]).filter(Boolean)
  // Each answer is recorded in state as it arrives, so a later caller cannot lose it.
  for (const q of waiting) if (answered(q)) S.answers[q.id] = ANS[q.id]
  const missing = waiting.filter(q => !answered(q))
  if (missing.length) {
    return ask(S.pending.gate, missing, `${missing.length} question(s) are still unanswered; the pipeline does not continue on assumptions.` +
      (missing.some(ownWords) ? ` "${OWN_WORDS.label}" is not an answer by itself: choose Other and write it.` : ''))
  }
  S.pending = null
}

// ---- Intake: read-only, so nothing exists until the user has answered
if (!S.intake) {
  phase('Intake')
  const r = await agent(intakePrompt(), { label: 'intake', phase: 'Intake', effort: EFF.intake, schema: INTAKE_SCHEMA })
  if (!r) return failed('intake')
  if (!r.repo.main_ok) {
    return done('blocked', {
      blocked_reason: `origin/${MAIN} does not resolve in ${r.repo.toplevel || A.repo || 'the repository'}. The pipeline never pushes to ${MAIN}: create its first commit there yourself (a README is enough), push it, and run this again.`,
      retry_args: { ...A },
    })
  }
  S.slug = slugify(A.slug || r.slug, 40) || 'app'
  S.title = clip(r.title, 60) || S.slug
  S.repo = { ...r.repo, toplevel: squash(r.repo.toplevel).replace(/\/+$/, '') }
  S.restated = squash(r.restated)
  S.facts = (r.facts || []).map(squash).filter(Boolean)
  S.root = squash(A.root || `${S.repo.toplevel}-worktrees`).replace(/\/+$/, '')
  S.dir = `${S.root}/inception-${S.slug}`
  S.branch = `inception/${S.slug}`
  S.record = `${RECORD_DIR}/${S.slug}`
  S.intake = { rounds: 1 }
  const qs = addQuestions('intake', 'i', r.questions)
  log(`Intake: ${S.title} (${S.slug}), ${qs.length} question(s)`)
  if (qs.length) {
    return ask('intake', qs,
      `${S.restated} Before anything is designed: ${qs.length} question(s) whose answers shape the architecture. Nothing has been written yet; the work will happen in ${S.dir} on branch ${S.branch} (pass root to put it elsewhere).`,
      { facts: S.facts, repo: S.repo })
  }
}

// ---- Brief: the first write. An answer that opens a new question loops back to the intake gate.
if (!S.brief) {
  phase('Brief')
  const last = S.intake.rounds >= INTAKE_ROUNDS
  const r = await agent(briefPrompt(last), { label: `brief-${S.intake.rounds}`, phase: 'Brief', effort: EFF.brief, schema: BRIEF_SCHEMA })
  if (!r) return failed('brief')
  if (r.blocked) return done('blocked', { blocked_reason: r.blocked_reason || `${S.dir} could not be set up`, retry_args: { ...A, answers: ANS, state: { ...S, pending: null } } })
  if (last && (r.follow_up_questions || []).length) log(`Brief: ${r.follow_up_questions.length} more question(s) after the last intake round were not asked — check the brief's Open questions`)
  const qs = last ? [] : addQuestions('intake', 'i', r.follow_up_questions)
  if (qs.length) {
    S.intake.rounds++
    return ask('intake', qs, `Your answers opened ${qs.length} follow-up question(s). The draft brief is at ${at(BRIEF())}.`)
  }
  S.brief = { summary: squash(r.summary), criteria: criteriaFrom(r.quality_attributes), hard_constraints: (r.hard_constraints || []).map(squash).filter(Boolean) }
  log(`Brief written: ${at(BRIEF())}`)
}

// ---- Directions: the user picks which bets compete
if (!S.directions) {
  phase('Directions')
  const r = await agent(directionsPrompt(), { label: 'directions', phase: 'Directions', effort: EFF.directions, schema: DIRECTIONS_SCHEMA })
  if (!r || (r.directions || []).length < 2) return failed('directions', { reason: 'fewer than two directions came back' })
  if (r.directions.length > MAX_DIRECTIONS) log(`Directions: kept ${MAX_DIRECTIONS} of ${r.directions.length}; left out: ${r.directions.slice(MAX_DIRECTIONS).map(d => squash(d.label)).join(', ')}`)
  const keys = new Set(), labels = new Set()
  S.directions = r.directions.slice(0, MAX_DIRECTIONS).map((d, i) => {
    let key = slugify(d.key || d.label, 16) || `d${i + 1}`
    while (keys.has(key)) key = `${key}${i + 1}`
    keys.add(key)
    let label = label5(d.label) || key
    while (labels.has(norm(label))) label = `${label} ${i + 1}`
    labels.add(norm(label))
    return { key, label, sketch: squash(d.sketch), optimizes: squash(d.optimizes), sacrifices: squash(d.sacrifices), serves: squash(d.serves) }
  })
  const recommended = asList(r.recommended).map(k => S.directions.find(d => d.key === slugify(k, 16) || norm(d.label) === norm(k))).filter(Boolean).map(d => d.label)
  const q = {
    id: 'directions', gate: 'directions', header: 'Directions', multi_select: true,
    question: `Which architectural directions should compete as full proposals for ${S.title}? Pick two to ${MAX_PROPOSALS}, or describe your own.`,
    why: 'Each becomes an independent proposal that three critics attack and a judge panel scores against your priorities; you then choose the winner.',
    options: S.directions.map(d => ({ label: d.label, description: clip(`${d.sketch} Best at: ${d.optimizes}. Gives up: ${d.sacrifices}.`, 300) })),
    recommended, recommended_reason: recommended.length ? squash(r.recommended_reason) : '',
  }
  S.questions.directions = q
  return ask('directions', [q], `The brief is written (${at(BRIEF())}). ${S.directions.length} candidate directions for ${S.title}; their full sketches are under directions.`, { directions: S.directions })
}
if (!S.chosen) {
  const q = S.questions.directions
  const chosen = []
  for (const p of picks(q)) {
    if (p.option) {
      const d = S.directions.find(x => x.label === p.option)
      if (!chosen.includes(d)) chosen.push(d)
      continue
    }
    const n = chosen.filter(c => c.custom).length + 1
    let label = label5(p.text)
    while (chosen.some(c => norm(c.label) === norm(label)) || S.directions.some(d => norm(d.label) === norm(label))) label = `${label} ${n}`
    chosen.push({ key: `own${n}`, label, sketch: p.text, optimizes: '', sacrifices: '', serves: '', custom: true })
  }
  if (chosen.length < 2 || chosen.length > MAX_PROPOSALS) {
    return ask('directions', [q], `${chosen.length < 2 ? 'Pick at least two' : `Pick at most ${MAX_PROPOSALS}`} directions so the proposals compete; that answer named ${chosen.length}.`, { clear: ['directions'], directions: S.directions })
  }
  S.chosen = chosen
}

// ---- Proposals → critique → revision → judging. No user decision inside, so it runs through to the decision gate.
// Each stage is a parallel() barrier with one agent per thunk: agent calls are issued in a fixed order, so an
// interrupted run resumed with resumeFromRunId replays them from its record.
if (!S.proposals) {
  phase('Proposals')
  const drafts = await parallel(S.chosen.map(d => () => agent(proposePrompt(d, S.chosen.filter(c => c !== d)), { label: `propose:${d.key}`, phase: 'Proposals', effort: EFF.propose, schema: PROPOSAL_SCHEMA })))
  let props = S.chosen.map((d, i) => drafts[i] && { ...d, path: propPath(d.key), ...proposalFields(drafts[i]) }).filter(Boolean)
  const lost = S.chosen.filter((d, i) => !drafts[i]).map(d => d.label)
  if (lost.length) log(`Proposals: none came back for ${lost.join(', ')}`)
  if (props.length < 2) return failed('proposals', { reason: `only ${props.length} proposal(s) came back` })

  phase('Critique')
  const pairs = props.flatMap(p => LENSES.slice(0, CRITICS).map(lens => ({ p, lens })))
  const crits = await parallel(pairs.map(({ p, lens }) => () => agent(critiquePrompt(p, lens), { label: `critique:${p.key}:${lens.key}`, phase: 'Critique', effort: EFF.critique, schema: CRITIQUE_SCHEMA })))
  const critiquesOf = p => pairs.map((x, i) => x.p === p && crits[i] && { lens: x.lens.name, ...crits[i] }).filter(Boolean)
  const revised = await parallel(props.map(p => () => agent(revisePrompt(p, critiquesOf(p)), { label: `revise:${p.key}`, phase: 'Critique', effort: EFF.revise, schema: PROPOSAL_SCHEMA })))
  const unrevised = props.filter((p, i) => !revised[i]).map(p => p.label)
  if (unrevised.length) log(`Critique: ${unrevised.join(', ')} kept the first draft (the revision did not come back)`)
  props = props.map((p, i) => revised[i] ? { ...p, ...proposalFields(revised[i]) } : p)

  phase('Judge')
  const runs = await parallel(Array.from({ length: JUDGES }, (_, j) => () => agent(judgePrompt(j, props), { label: `judge-${j + 1}`, phase: 'Judge', effort: EFF.judge, schema: JUDGE_SCHEMA })))
  const t = tally(props, runs)
  if (!t.judged) return failed('judging', { reason: 'no judge reported' })
  const syn = await agent(synthPrompt(props, t), { label: 'synthesize', phase: 'Judge', effort: EFF.synthesize, schema: SYNTH_SCHEMA })
  if (!syn) return failed('judging', { reason: 'the comparison was not written' })

  S.proposals = props.map(p => ({ key: p.key, label: p.label, path: p.path, summary: p.summary, top_risk: p.top_risk, custom: !!p.custom }))
  const P = Object.fromEntries(S.proposals.map(p => [p.key, p]))
  const seen = new Set()
  const grafts = []
  // At most three, so "Adopt none" fits as the fourth option: the question always offers two to four.
  seen.add(norm(ADOPT_NONE.label))
  for (const g of syn.grafts || []) {
    const label = label5(g.label)
    if (!label || seen.has(norm(label)) || grafts.length === 3) continue
    seen.add(norm(label))
    grafts.push({ label, from: P[g.from] ? g.from : '', idea: squash(g.idea), benefit: squash(g.benefit) })
  }
  S.comparison = { totals: t.totals, ranking: t.ranking, recommendation: t.recommendation, close_call: t.close, judges: t.judged, dealbreakers: t.breakers, grafts, summary: squash(syn.summary) }
  const score = k => (t.totals[k] == null ? 'unscored' : `${t.totals[k].toFixed(2)}/5`)
  const recommend = !t.close && t.recommendation
  const winner = {
    id: 'winner', gate: 'decision', header: 'Architecture', multi_select: false,
    question: `Which proposal should become the architecture of ${S.title}?`,
    why: `Everything after this follows from it: the ADR, the design doc and the build. Scores are weighted by your priorities, means of ${t.judged} judge(s); the comparison is at ${at(COMPARISON())}. Answer "none" to send other directions into the competition instead.`,
    options: t.ranking.map(k => ({ label: P[k].label, description: clip(`${score(k)}${t.breakers[k] ? `, a dealbreaker flagged by ${t.breakers[k]} judge(s)` : ''}. ${P[k].summary} Biggest risk: ${P[k].top_risk}`, 300) })),
    recommended: recommend ? [P[t.recommendation].label] : [],
    recommended_reason: recommend ? squash(syn.recommendation_reason) : '',
  }
  const graftQ = grafts.length && {
    id: 'grafts', gate: 'decision', header: 'Grafts', multi_select: true,
    question: 'Which ideas from the other proposals should the chosen architecture adopt? Choose none to adopt nothing.',
    why: 'A graft improves the chosen design without changing its core; one that comes from the proposal you choose is already part of it.',
    options: [...grafts.map(g => ({ label: g.label, description: clip(`From ${P[g.from] ? P[g.from].label : 'the judges'}: ${g.idea} — ${g.benefit}`, 300) })), ADOPT_NONE],
    recommended: [], recommended_reason: '',
  }
  const qs = [winner, graftQ].filter(Boolean)
  for (const q of qs) S.questions[q.id] = q
  return ask('decision', qs, [
    `${props.length} proposals were written, attacked by ${CRITICS} critic(s) each, revised, and scored by ${t.judged} judge(s).`,
    S.comparison.summary,
    t.close ? 'The top two are within judging noise, so this is your call: no option is marked recommended.' : '',
    lost.length ? `No proposal came back for: ${lost.join(', ')}.` : '',
  ].filter(Boolean).join(' '), { scores: t.table })
}

// ---- Decision
if (!S.decision) {
  const [pick] = picks(S.questions.winner)
  if (!pick) return ask('decision', [S.questions.winner], 'Choose the proposal to build on.', { clear: ['winner'] })
  // None of them: back to the directions gate, keeping the brief.
  if (!pick.option && NONE.test(pick.text)) {
    log('The user chose none of the proposals: back to the directions gate')
    // Their files stay in the record; the docs name them as rejected unless a new proposal reuses the file.
    S.rejected = [...(S.rejected || []), ...S.proposals.map(p => ({ key: p.key, label: p.label, path: p.path }))]
    for (const k of ['chosen', 'proposals', 'comparison']) delete S[k]
    for (const id of ['winner', 'grafts']) delete S.questions[id]
    return ask('directions', [S.questions.directions], 'You chose none of the proposals. Pick other directions, or describe your own under Other, and the competition runs again.', { clear: ['directions', 'winner', 'grafts'], directions: S.directions })
  }
  const base = pick.option ? S.proposals.find(p => p.label === pick.option) : null
  const grafts = S.questions.grafts
    ? picks(S.questions.grafts).filter(p => p.option !== ADOPT_NONE.label).map(p => S.comparison.grafts.find(g => g.label === p.option) || { label: p.text, from: '', idea: p.text, benefit: '' })
    : []
  S.decision = { answer: pick.text, base: base ? base.key : '', grafts }
}

// ---- Design: what the choice leaves open is asked before anything is written
if (!S.design) {
  phase('Design')
  const r = await agent(designPrompt(), { label: 'design', phase: 'Design', effort: EFF.design, schema: DESIGN_SCHEMA })
  if (!r) return failed('design')
  const named = S.proposals.some(p => p.key === squash(r.base_proposal)) ? squash(r.base_proposal) : ''
  S.design = { base: S.decision.base || named, summary: squash(r.summary) }
  const qs = addQuestions('design', 'd', r.questions)
  if (qs.length) return ask('design', qs, `${S.design.summary} Before the documents are written: ${qs.length} decision(s) the chosen design leaves open.`)
}

// ---- Docs: ADR, design doc and CLAUDE.md, committed on the inception branch (not pushed)
if (!S.docs) {
  phase('Docs')
  const r = await agent(docsPrompt(), { label: 'docs', phase: 'Docs', effort: EFF.docs, schema: DOCS_SCHEMA })
  if (!r) return failed('docs')
  const steps = (r.steps || []).map(s => ({
    number: s.number, title: squash(s.title), description: squash(s.description),
    depends_on: (s.depends_on || []).filter(Number.isInteger), acceptance: (s.acceptance || []).map(squash).filter(Boolean), human_gated: squash(s.human_gated),
  })).sort((a, b) => a.number - b.number)
  const sha = squash(r.commit_sha)
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return failed('docs', { reason: `the docs commit was not confirmed (commit_sha ${JSON.stringify(r.commit_sha)})` })
  if (!steps.length || steps[0].number !== 1 || steps[0].human_gated) return failed('docs', { reason: 'the design doc needs a buildable step 1, the walking skeleton' })
  S.docs = { adr: squash(r.adr), design_doc: squash(r.design_doc), claude_md: squash(r.claude_md), gates: { full: squash(r.gates.full), fast: squash(r.gates.fast) }, steps, sha, summary: squash(r.summary) }
  log(`Docs committed on ${S.branch} @${sha.slice(0, 9)}: ${S.docs.adr}, ${S.docs.design_doc}`)
  const code = steps.filter(s => !s.human_gated)
  const later = code.filter(s => s.number > 1)
  const q = {
    id: 'build', gate: 'build', header: 'Build', multi_select: false,
    question: `The inception documents are committed on ${S.branch} (${sha.slice(0, 9)}). How far should the pipeline go now?`,
    why: `The quality gates will be ${S.docs.gates.full}. The design doc has ${steps.length} step(s), ${code.length} of them code; step 1, the walking skeleton, ships together with the documents as the inception PR.`,
    options: [
      later.length && { label: 'Skeleton + all lanes', description: `Build step 1 and open the inception PR (documents and skeleton, then monitored); meanwhile build steps ${later.map(s => s.number).join(', ')} as stacked build-only branches, each shipped later once the PRs below it merge.` },
      { label: 'Skeleton PR only', description: 'Build step 1 and open the inception PR (documents and skeleton, then monitored); leave the later steps for later.' },
      { label: 'Docs PR only', description: 'Push the branch and open a pull request with the documents only; build nothing.' },
      { label: 'Stop here', description: `Keep the documents committed on ${S.branch} in ${S.dir}; push nothing.` },
    ].filter(Boolean),
    recommended: [], recommended_reason: '',
  }
  S.questions.build = q
  return ask('build', [q], `${S.docs.summary} CLAUDE.md: ${S.docs.claude_md}.`, { steps })
}

// ---- Build
const [buildPick] = picks(S.questions.build)
const choice = buildPick && buildPick.option
if (!choice) return ask('build', [S.questions.build], 'Pick one of the build options.', { clear: ['build'] })
if (choice === 'Stop here') {
  return done('docs_committed', {
    how_to_continue: `The documents are committed on ${S.branch} in ${S.dir}; nothing was pushed. To build later, run this workflow with resume_args and answer the build question again.`,
    resume_args: { ...A, answers: without(ANS, ['build']), state: { ...S, answers: without(S.answers, ['build']), pending: { gate: 'build', ids: ['build'] } } },
  })
}
phase('Build')
if (choice === 'Docs PR only') {
  const r = await agent(publishPrompt(), { label: 'docs-pr', phase: 'Build', effort: EFF.publish, schema: PUBLISH_SCHEMA })
  if (!r || r.blocked || !r.pr_number) return failed('docs_pr', { reason: (r && r.blocked_reason) || 'the docs PR stage failed to report' })
  return done('docs_pr', { pr: { pr_number: r.pr_number, url: r.url } })
}
const child = async (lane, extra) => {
  try {
    return await workflow('plan-to-merged-pr', {
      ...BUILD_SHARED, lane, repo: S.repo.toplevel, proposal: S.docs.design_doc,
      ...(A.build_context ? { context: `The user's answers to questions an earlier attempt stopped on: ${A.build_context}` } : {}),
      ...extra,
    })
  } catch (err) {
    log(`${lane}: ${err && err.message ? err.message : err}`)
    return null
  }
}
const runSummary = r => ({ status: r.status, review_clean: r.review_clean, polish_clean: r.polish_clean, stop_reason: r.stop_reason || '', open_questions: r.open_questions || [] })
const concernOf = s => `Step ${s.number} of the design doc ${S.docs.design_doc}: ${s.title}. ${s.description}` + (s.acceptance.length ? ` Acceptance: ${s.acceptance.join('; ')}.` : '')
const ANSWER_HINT = 'Put your answer to its question in build_context and run retry_args'
// Build progress lives in state, so running again skips what already pushed: the skeleton, the inception PR, each lane.
S.build = S.build || { skeleton: null, pr: null, lanes: [] }
const B = S.build
const again = () => ({ ...A, answers: ANS, state: { ...S, pending: null } })

// The skeleton is built on the docs commit and reviewed from it, so its review sees the skeleton alone while
// the one inception PR carries both.
if (!B.skeleton) {
  const r = await child('skeleton', { concern: concernOf(S.docs.steps[0]), dir: S.dir, branch: S.branch, review_base: S.docs.sha, ship: false })
  if (!r || r.status !== 'pushed') {
    return failed('skeleton', {
      skeleton: r ? runSummary(r) : { status: 'failed' },
      how_to_continue: r && r.stop_reason ? `The skeleton stopped: ${r.stop_reason} ${ANSWER_HINT}.` : 'Run retry_args to build the skeleton again; work already on its branch is kept.',
    })
  }
  B.skeleton = { ...runSummary(r), plan: r.plan || '' }
}

const shipInceptionPR = async () => {
  if (B.pr) return { status: 'opened earlier', pr: B.pr }
  const r = await child('inception-pr', {
    ship_only: true, dir: S.dir, branch: S.branch, title: clip(`Inception: ${S.title}`, 70), plan_text: B.skeleton.plan,
    pr_note: `This pull request starts ${S.title}: the inception record under ${S.record}/ (the brief, ${S.proposals.length} competing proposals and how they compared), the architecture decision ${S.docs.adr}, the design doc ${S.docs.design_doc} and CLAUDE.md with the pipeline config, plus step 1 of the design doc, the walking skeleton. The later steps follow as stacked pull requests.`,
  })
  if (r && r.pr && r.pr.pr_number) B.pr = { pr_number: r.pr.pr_number, url: r.pr.url }
  return r
}
// Every later code step, stacked in order on everything below it; a lane that does not push ends the chain.
// A human-gated step is skipped unless a later step depends on it; then the chain waits until human_done names it.
const SETTLED = ['pushed', 'skipped_human_step', 'done_by_human']
const buildLanes = async () => {
  const humanDone = (A.human_done || []).map(Number)
  const rest = S.docs.steps.slice(1)
  for (const s of rest) {
    const prior = B.lanes.find(l => l.step === s.number)
    if (prior && SETTLED.includes(prior.status)) continue
    B.lanes = B.lanes.filter(l => l.step !== s.number)
    if (s.human_gated) {
      const needed = rest.some(x => x.number > s.number && x.depends_on.includes(s.number))
      const status = humanDone.includes(s.number) ? 'done_by_human' : needed ? 'waits_on_human' : 'skipped_human_step'
      B.lanes.push({ step: s.number, title: s.title, status, human_gated: s.human_gated })
      if (status === 'waits_on_human') { log(`Step ${s.number} needs a person (${s.human_gated}) and later steps depend on it — the lanes stop here`); break }
      continue
    }
    const lane = { key: `step${s.number}`, step: s.number, title: s.title, branch: `feat/${S.slug}-step${s.number}-${slugify(s.title, 30) || 'step'}`, dir: `${S.root}/${S.slug}-step${s.number}` }
    const bases = [S.branch, ...B.lanes.filter(l => l.status === 'pushed' && l.step < s.number).sort((a, b) => a.step - b.step).map(l => l.branch)]
    const r = await child(lane.key, { concern: concernOf(s), dir: lane.dir, branch: lane.branch, bases, ship: false })
    const status = (r && r.status) || 'failed'
    B.lanes.push({ ...lane, ...(r ? runSummary(r) : {}), status, plan: (r && r.plan) || '' })
    if (status !== 'pushed') { log(`Lane ${lane.key}: ${status} — the later steps stack on it, so the chain stops here`); break }
  }
  B.lanes.sort((a, b) => a.step - b.step)
  const reached = new Set(B.lanes.map(l => l.step))
  const unbuilt = rest.filter(s => !reached.has(s.number)).map(s => s.number)
  if (unbuilt.length) log(`Not built: step(s) ${unbuilt.join(', ')}`)
}
const all = choice === 'Skeleton + all lanes'
// The inception PR is opened and babysat while the lanes build on its branch.
const [shipped] = all ? await parallel([shipInceptionPR, buildLanes]) : [await shipInceptionPR()]
const prn = B.pr && B.pr.pr_number
const stopped = all ? B.lanes.find(l => !SETTLED.includes(l.status)) : null
const pushed = B.lanes.filter(l => l.status === 'pushed')
// Ready-to-run ship-only args per lane, with the run's build settings. Each carries its bases, so
// plan-to-merged-pr refuses to open its PR until predecessor_prs names every PR below it and each reads MERGED;
// only the first lane's predecessor is known now.
const shipPlan = pushed.map((l, i) => ({
  lane: l.key, branch: l.branch,
  when: i ? `after the PR for ${pushed[i - 1].key} merges` : `after the inception PR${prn ? ` #${prn}` : ''} merges`,
  args: {
    ...BUILD_SHARED, lane: l.key, ship_only: true, branch: l.branch, dir: l.dir, title: clip(`Step ${l.step}: ${l.title}`, 70),
    proposal: S.docs.design_doc, plan_text: l.plan, bases: [S.branch, ...pushed.slice(0, i).map(x => x.branch)],
    ...(i === 0 && prn ? { predecessor_prs: [prn] } : {}),
  },
  note: i === 0 && prn ? '' : 'set predecessor_prs to the PR numbers of the inception PR and of every lane below this one before running it',
}))
const laneHint = l => (l.status === 'waits_on_human'
  ? `Step ${l.step} needs a person: ${l.human_gated}. Once it is done, run retry_args with human_done: [${l.step}].`
  : `Lane ${l.key} stopped at ${l.status}${l.stop_reason ? `: ${l.stop_reason}` : ''}. ${l.stop_reason ? ANSWER_HINT : 'Fix the cause and run retry_args'}; the lanes below it are kept.`)
const result = {
  build: choice,
  pr: B.pr, pr_status: shipped ? shipped.status : 'failed',
  skeleton: runSummary(B.skeleton),
  lanes: B.lanes.map(({ plan, ...l }) => l),
  ship_plan: shipPlan,
  open_questions: [...(B.skeleton.open_questions || []), ...B.lanes.flatMap(l => l.open_questions || [])],
}
if (!prn) {
  return done('failed_at_inception_pr', {
    ...result, retry_args: again(),
    how_to_continue: `The inception PR did not open (${shipped ? shipped.status : 'the step failed'}${shipped && shipped.stop_reason ? `: ${shipped.stop_reason}` : ''}). Fix that, then run retry_args; the skeleton and the lanes that pushed are kept.` + (stopped ? ` ${laneHint(stopped)}` : ''),
  })
}
if (stopped) return done('lanes_stopped', { ...result, retry_args: again(), how_to_continue: laneHint(stopped) })
return done('built', {
  ...result, resume_args: again(),
  how_to_continue: `Review and merge the inception PR #${prn} yourself. Then ship each built lane in order with plan-to-merged-pr and its ship_plan args, once every PR below it has merged.`,
})

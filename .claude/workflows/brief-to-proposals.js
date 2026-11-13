export const meta = {
  name: 'brief-to-proposals',
  description: 'Turn a product brief (or one change too big for a PR) into reviewed design docs: seed the repo with the pipeline and a base CLAUDE.md, architecture panel, /roadmap, /propose per code milestone, /review-proposal and revise until clean, cross-doc consistency two docs at a time, then lint and lanes. A re-run starts at the stage that needs it (args.from, else inferred from the answers and the docs on disk) and keeps the docs already written. Writes only the seeded pipeline files, CLAUDE.md and design docs, never code; it commits only with args.branch, as checkpoints on that design branch (never main)',
  whenToUse: 'Before building a new product or a change too big for one PR. It writes the architecture, roadmap and proposals that /bootstrap and proposal-build-chain consume. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with every answer so far, from set to its resume_from and, after a milestone\'s question, the milestones it names, as its relay says. Pass branch to checkpoint the docs on a design branch, so they outlive the session and a re-run from any clone picks them up.',
  phases: [
    { title: 'Seed', detail: 'with branch, check out the design branch first; /seed installs the pipeline\'s skills, workflows and scripts and a base CLAUDE.md into the repo; then find the design docs that already exist and restore the answers saved on the state branch; a run that starts past the Intake also restores what the Intake took as given, and saves the answers it was given' },
    { title: 'Intake', detail: 'read the source, one class of person-owned choice at a time, for the blocking questions and confirmations only the person can answer, before any design is written; then the answers the run was given and what the Intake took as given are saved to the state branch' },
    { title: 'Architecture', detail: 'independent sketches and a judge, which may ask too (the synthesis is saved to the state branch), then /roadmap writes architecture.md and roadmap.md (existing ones are resumed instead), reviewed until clean' },
    { title: 'Proposals', detail: '/propose per roadmap code milestone (when the docs already existed, only the unwritten ones, or exactly args.milestones), then /review-proposal and /propose --revise until clean' },
    { title: 'Consistency', detail: 'the docs compared two at a time (the architecture and each proposal, the proposals of dependent milestones, the brief and the roadmap); findings revised in the doc they name, then re-reviewed' },
    { title: 'Lint', detail: 'proposal-lint.py on every doc, the decisions no person confirmed and the values an author proposed, lanes per proposal, roadmap progress' },
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
//                             never committed, and this workflow never saves it. It must exist: a missing one is restored from the
//                             state branch (context/builder-context.md, kept there only when the person consented), else the run
//                             ends failed_at_start (context_not_found) before any design agent runs. A framing /start-product
//                             assumed (the file has a line starting "- Not confirmed by me yet") is not the person's word yet: the
//                             Intake returns it as one confirmation
//   from?: string             brief mode: the stage to start at, 'intake' | 'architecture' | 'proposals' | 'consistency' | 'lint'.
//                             Default, inferred: when architecture.md and roadmap.md exist, the earliest stage among the answers'
//                             ids, the Intake's left out (the docs were written after them), else 'proposals'; without the docs,
//                             'intake'. Inference counts every non-intake answer passed, earlier runs' included, so answers added
//                             to earlier ones can start it before the stage that asked. 'architecture' with the docs resumes their
//                             review (no /roadmap); without them, /roadmap runs on the panel synthesis saved on the state branch
//                             (design/panel-synthesis.md), or on a new panel when none is saved. 'proposals' or later skips the
//                             Intake, the panel and /roadmap and uses the existing docs: it proposes only the milestones whose
//                             proposal does not exist yet (or exactly args.milestones; answers alone re-propose none), keeps the
//                             rest, then checks consistency over all docs and lints. 'consistency' keeps every proposal; 'lint' only
//                             lints. A needs_input result names the stage to pass (resume_from): pass it with the answers, and
//                             after a milestone's question the milestones that asked, as its relay says.
//   branch?: string           a design branch for checkpoints, e.g. 'design/20261110', never main. Before seeding, the checkout switches
//                             to it: origin's branch when it exists (so a re-run from a fresh clone continues it), else a new branch
//                             from origin/<MAIN_BRANCH>. After Architecture, Proposals and Consistency an agent commits the docs written
//                             so far, the seeded .claude files and CLAUDE.md (never the brief or the context file) and pushes the
//                             branch. Without branch the run commits nothing.
//   commit_trailers?: string[] lines each checkpoint commit ends with (default ['Co-Authored-By: Claude <noreply@anthropic.com>'])
//   github_access?: string    'gh' | 'connector' (default '': GITHUB_ACCESS from the Pipeline config, gh or connector; unset, gh when it
//                             is authenticated, else the GitHub MCP tools); passed into the prompts that reach the remote. git fetch
//                             and push stay plain git in either mode.
//   panel?: number            independent architecture sketches before /roadmap (default 3; 0 = skip the panel)
//   milestones?: number[]     propose only these roadmap milestones, written or not (default: every pending milestone that names a
//                             proposal; when the docs already existed, the ones not yet written). Answers select none, since
//                             /propose rewrites a written proposal as a draft: a needs_input relay lists the milestones that asked
//   max_milestones?: number   without milestones: propose at most the first N of the default set, in roadmap order (e.g. 1 to try the
//                             flow on one milestone; 1 is recommended for a long roadmap, since later proposals go stale as earlier
//                             milestones change the tree). 0 proposes none: the run stops after the reviewed architecture and roadmap
//                             (and lints them), and a re-run with from: 'proposals' writes the proposals. A milestones list is never
//                             cut by it: the listed milestones are proposed, whatever N is. The result names the pending milestones
//                             left without a proposal (not_proposed), and a next step says how to write them
//   force?: boolean           regenerate from scratch: let /roadmap overwrite an existing architecture.md / roadmap.md (default false).
//                             It starts at the Intake, or with from: 'architecture' at /roadmap on the saved panel synthesis. A
//                             re-run keeps force only while the docs are not regenerated yet (a stop at the Intake, the judge or
//                             /roadmap); once this run's /roadmap wrote them, the re-run leaves force out, or it would write them
//                             again (the relay and the next steps say which)
//   max_review_rounds?: number  revise rounds per doc (default 3)
//   efforts?: { intake, sketch, judge, roadmap, propose, review, revise, consistency, lint }  (lint also sets the mechanical agents:
//                             branch, seed, existing-docs, context-check, save-answers, save-panel, milestones and checkpoints)
//   on_question?: 'stop'|'assume'  default 'stop': blocking questions (ones only the person can answer) and confirmations (a
//                             person-owned choice whose value nobody confirmed with the person; confirm: true) stop the run with
//                             status needs_input before anything is built on a guess; 'assume' takes each recommended option instead
//                             (the Intake's and the judge's become shared answers for every later stage), lists them in assumptions
//                             and has the authors tag the decisions so taken (assumed)
//   answers?: [{ id, answer, question?, date?, stage? }]  the questions a needs_input result returned, each with its question text,
//                             the person's answer and the date they gave it (or { <id>: answer }). In brief mode every answer
//                             reaches every author, reviewer and pair, whichever stage asked it (the same choice can arise in
//                             another doc); in concern mode each reaches the stage that asked and every later one. A re-run with
//                             from (resume_from) starts at the stage that asked and keeps the docs written. The scope is the id's
//                             first part: intake, architecture, m<N>, proposal (concern mode) or consistency; an id with any other
//                             first part counts as an Intake answer, which never moves the inferred start. A decision the person
//                             makes outside a workflow question is passed the same way, with its question text: intake.d<N>, or
//                             for a correction to written docs architecture.d<N> or m<N>.d<K>. In brief mode the answers are saved
//                             to the state branch (design/answers.json) and the saved ones this run was not passed are restored
//                             (answers_restored), so they outlive the session; restored ones never move the inferred start, and an
//                             answer passed again without its question takes it from the saved copy. What the Intake took as given
//                             is saved beside them (the file's assumptions) once the run goes on past the Intake, and a run that
//                             starts past the Intake restores it, so every later author still gets it and the result lists it.
//                             Concern mode saves its answers as design/answers-concern.json, which no run restores. A state branch
//                             that cannot be read is never written: the run saves nothing (answers_saved false) and logs why.
//                             Every run passes the earlier answers again, so they pick no milestone to propose: milestones does.
//                             An id is never reused: an id passed for another question than the one its saved answer holds, or
//                             twice in answers with different answers or questions, ends the run failed_at_start
//                             (answer_id_reused) before anything is saved, naming the ids in use and the next free number
//   save_answers?: boolean    default true. false keeps the person's answers off the state branch (they quote the choices of the
//                             brief, and the state branch is as visible as the repository): the run neither saves nor restores
//                             answers or the Intake's assumptions, its result says so (save_answers: false), and every re-run must
//                             be passed every answer so far
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
// null: no cap (the arg is absent); 0 proposes none, so the run stops after the reviewed architecture and roadmap.
const MAX_M = A.max_milestones === undefined || A.max_milestones === null || A.max_milestones === '' || !Number.isFinite(Number(A.max_milestones))
  ? null : Math.max(0, Math.floor(Number(A.max_milestones)))
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
// The person outranks the source: what they said is binding and replaces the source's value on the same point (never asked
// again); any other contradiction is theirs to resolve, never the author's.
const BINDING = `binding. On the point it addresses it replaces what the source says (the brief's Assumed builder, a field the person corrected): follow it, say so in what you write, and never ask it again. ` +
  `Where another part of the source, the tree or research makes it impossible to follow, pick no side: return a blocking question naming both.`
// A framing /start-product took without the person ends with this line: it is not the person's word until an answer confirms it.
const UNCONFIRMED_MARK = `- Not confirmed by me yet`
const UNCONFIRMED_FRAMING = `When that file has a line starting "${UNCONFIRMED_MARK}", /start-product assumed the framing: until an answer from the person confirms it, it is an assumption, not the person's word, and no decision that rests on it is tagged (person, ...). `
const CTX_FILE_NOTE = CTX_FILE
  ? `Before anything else, read ${CTX_FILE} (relative to ${DIR}) in full: its text is framing from the person, ${BINDING} ${UNCONFIRMED_FRAMING}Keep such a framing, or return a question to change it. Docs may state the constraints it sets; never copy personal data or credentials from it. `
  : ''
const CTX = (A.context ? `Framing from the person, ${BINDING} The framing: ${A.context}\n` : '') + (CTX_FILE ? CTX_FILE_NOTE + '\n' : '')
const REVIEW_CTX = (A.context ? `The authors were told to follow this framing from the person as binding; a choice that follows it or an answer from the person is not a defect: ${A.context}\n` : '') +
  (CTX_FILE ? `The authors were also told to treat the text of ${CTX_FILE} (relative to ${DIR}; read it) as binding framing from the person: a choice that follows it or an answer from the person is not a defect. ${UNCONFIRMED_FRAMING}\n` : '') +
  `A doc that departs from the person's framing, an answer from the person, or a decision tagged (person, ...), with no newer answer from the person, is a bug whose fix is the question to ask (with its options), never a gate or a confirmation at acceptance. `
const WORK = GUARD + WHERE + DOCS_ONLY
const SOURCE = BRIEF_MODE ? `the product brief ${A.brief}` : `the concern ${JSON.stringify(A.concern)}`
const LINT = `python3 .claude/scripts/proposal-lint.py`
const STATE = `python3 .claude/scripts/pipeline-state.py`
const PIPELINE = A.pipeline ? String(A.pipeline).replace(/\/+$/, '') : ''
const GITHUB = `Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. ` +
  (GH_ACCESS ? `The access in use is ${GH_ACCESS} (this run's github_access). ` : `The access in use is GITHUB_ACCESS from the "## Pipeline config" section of CLAUDE.md: gh or connector (unset: gh when it is authenticated, else the GitHub MCP tools). `) +
  `git fetch and git push stay plain git in either mode. `

// ---- Questions before assumptions. No one can answer an agent mid-run: a stage that needs the person's answer returns its
// questions and the run stops with needs_input; the caller asks the person and re-runs with args.answers (and args.from).
// Scopes in run order: intake, architecture, a proposal (m<N>, or 'proposal' in concern mode), consistency. In brief mode
// every answer reaches every author, reviewer and pair: the choice one milestone's author asked can arise in a sibling's doc or
// in the architecture, and the prompt says how to read an answer another stage asked. In concern mode an answer reaches the
// scope that asked and every later one, never an earlier one (its resume replays the Intake only while the Intake's prompt is
// unchanged). An id in no known scope (a decision the person made outside a workflow question, passed under a name of its own)
// counts as an Intake answer: it stays out of the start inference.
const ON_Q = A.on_question === 'assume' ? 'assume' : 'stop'
const scopeOf = id => String(id || '').split('.')[0]
const isScope = sc => ['intake', 'architecture', 'consistency', 'proposal'].includes(sc) || /^m\d+$/.test(sc)
const scopeOrder = sc => sc === 'intake' ? 0 : sc === 'architecture' ? 1 : sc === 'consistency' ? 3 : 2
// The stage (an args.from value) a question scope belongs to: m<N> and 'proposal' are the Proposals stage.
const stageOfScope = sc => sc === 'intake' || sc === 'architecture' || sc === 'consistency' ? sc : 'proposals'
const earliestStage = scopes => STAGES.find(s => scopes.some(sc => stageOfScope(sc) === s))
const answered = a => a && a.answer !== undefined && a.answer !== null && String(a.answer).trim() !== ''
const withStage = a => {
  const stage = [a.stage, scopeOf(a.id)].find(isScope)
  if (!stage) log(`Answer ${a.id}: its id names no stage, so it counts as an Intake answer and reaches every stage`)
  return { ...a, stage: stage || 'intake' }
}
// Each answer: { id, answer, question?, date?, stage? }. The question text and the date travel with it, into the prompts and
// the copy saved on the state branch.
// An id is never reused: the same id for another question, or twice with different answers, would let one answer replace
// another in the prompts and in the saved copy. Two questions differ when their letters and digits do (case, spacing and
// punctuation aside); an entry without its question text cannot be told apart, and counts as the same question.
const qKey = q => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const otherQuestion = (a, b) => !!qKey(a) && !!qKey(b) && qKey(a) !== qKey(b)
const ANSWERS = [], ARG_CLASH = []
for (const a of (Array.isArray(A.answers) ? A.answers : Object.entries(A.answers || {}).map(([id, answer]) => ({ id, answer }))).filter(answered)) {
  const first = a.id ? ANSWERS.find(x => x.id === a.id) : null
  if (!first) { ANSWERS.push(withStage(a)); continue }
  // The same id again: the same answer to the same question is one entry; anything else is refused once the run can say which ids are in use.
  if (String(first.answer).trim() !== String(a.answer).trim() || otherQuestion(first.question, a.question)) { if (!ARG_CLASH.includes(a.id)) ARG_CLASH.push(a.id); continue }
  if (!first.question && a.question) first.question = a.question
  if (!first.date && a.date) first.date = a.date
}
// The answers this run was passed; the ones restored from the state branch are added after the survey.
const GIVEN = ANSWERS.length
// save_answers: false keeps the answers and the Intake's assumptions off the state branch: nothing is saved, nothing restored.
const SAVE = A.save_answers !== false
const NO_SAVE_NOTE = SAVE ? '' : `This run saves nothing to the state branch and restores nothing from it (save_answers: false): pass every answer given so far with each re-run, each with its question and date. ` +
  `A re-run that starts past the Intake does not get the Intake's assumptions either: pass each one the person confirmed or corrected as an answer (intake.d<N>). `
// The next id not yet in use for a decision (<scope>.d<N>) or a question (<scope>.q<N>), over the ids given.
const nextId = (scope, kind, ids) => {
  let n = 0
  for (const id of ids) { const m = /^(.+)\.([dq])(\d+)$/.exec(String(id || '')); if (m && m[1] === scope && m[2] === kind) n = Math.max(n, Number(m[3])) }
  return `${scope}.${kind}${n + 1}`
}
const freeD = scope => nextId(scope, 'd', ANSWERS.map(a => a.id))
const ID_RULE = `an id is never reused for another question`
// What a run that cannot start says when an id is used twice: the ids in use and, for each id refused, the next free one.
const idsReused = (clashes, saved) => {
  const inUse = [...new Set(ANSWERS.map(a => a.id).concat(saved.map(a => a.id)).filter(Boolean))]
  const free = [...new Set(clashes.map(c => /^(.+)\.([dq])\d+$/.exec(String(c.id))).filter(Boolean).map(m => nextId(m[1], m[2], inUse)))]
  return `answer_id_reused: ${clashes.map(c => `${c.id} (${c.why})`).join('; ')}. An id is never reused, so nothing was saved or changed. ` +
    `Pass a different question's answer under the next number not yet in use${free.length ? ` (${free.join(', ')})` : ''}, with its question; ` +
    `a newer answer to the same question keeps its id, is passed once, and carries the question text the earlier one had. Ids in use: ${inUse.join(', ')}`
}
// An answer that came back without its question text (an id-only map, an older handoff) is shown with its id as the question:
// it still binds, and no stage may guess what it settled. Logged once the saved copy had its chance to supply the question.
const NO_TEXT = `An entry above whose question equals its id was passed without its question text. When its answer alone does not say what it settles, it settles nothing: never guess what it meant. `
const logNoText = () => { if (ANSWERS.some(a => !a.question)) log(`Answer(s) without their question text: ${ANSWERS.filter(a => !a.question).map(a => a.id).join(', ')} (pass each answer with its question, so every stage can tell what it settles)`) }
const answersFor = scope => {
  const mine = BRIEF_MODE ? ANSWERS : ANSWERS.filter(a => {
    const o = scopeOrder(a.stage)
    if (o > scopeOrder(scope)) return false
    return !(o === 2 && scopeOrder(scope) === 2 && a.stage !== scope)
  })
  return mine.length
    ? `Answers from the person to blocking questions (binding, like the person's framing: each replaces what the source says on the point it addresses; never re-ask them, and a choice that follows one is not a defect; ` +
      `a decision one settles carries the tag (person, <its date, or today's when it has none>, <its id>) in the doc, or (assumed) when the answer says it was assumed` +
      (BRIEF_MODE ? `; the first part of each id names the stage that asked (intake, architecture, m<N> for milestone N's proposal, consistency): an answer asked elsewhere binds here wherever the same choice arises, and one plainly about another doc's detail does not` : '') +
      `): ${JSON.stringify(mine.map(a => ({ id: a.id, question: a.question || a.id, answer: a.answer, ...(a.date ? { date: a.date } : {}) })))}\n` +
      (mine.some(a => !a.question) ? NO_TEXT + '\n' : '')
    : ''
}
// The person-owned choices, in the one order every stage and doc lists them.
const OWNED = `who the product is for and what its first release leaves out; platforms and distribution, hosted or self-run; price, plans, the revenue model, and anything that costs money or opens an account in the person's name (a host, a paid API, a billing provider, a store); ` +
  `the licence and its variant, and the legal and compliance posture; what personal data is collected, how long it is kept and who receives it; names (product, package, domain, organization or bundle id); the repository's owner and visibility; ` +
  `stop and go criteria, thresholds and dates; and a stack, provider or environment the person must run or pay for themselves`
const DRAFTED = `a new-software-idea brief is: its header has **Verdict:** and **Assumed builder:** fields, and that skill never interviews the person`
const BLOCKING_DEF = `A blocking question is one only the person can answer: what they intend, a requirement or constraint the source leaves out or states two incompatible ways, a trade-off that is theirs to make, ` +
  `a conflict between what the person said (the framing, an answer, a decision a doc records as theirs) and the source, the tree or your research, or a blocker whose way forward is their call; and whose plausible answers lead to a different design, promise, cost or legal exposure. ` +
  `What the person said outranks the source. On the point it addresses, it replaces what the source says: follow it, say so in what you write, and never ask it again. That difference is not a conflict. ` +
  `The conflict that is a blocking question is the other one: another part of the source, the tree or your research makes what the person said impossible to follow. Then pick no side and ask, naming both. ` +
  `A confirmation is a question about a person-owned choice that already has a value nobody confirmed with the person: the source's value when the source was drafted for the person (${DRAFTED}), ` +
  `an item the framing or a panel synthesis lists as open, recommended or not yet decided, or the default you would otherwise take. ` +
  `The person-owned choices: ${OWNED}. ` +
  `Yours, never asked: a choice inside a component that an invariant, a recorded decision or an official doc settles (a library, a layout, an internal name, a test tool, a version), and anything the tree, CLAUDE.md, the docs or desk research (official docs, pricing, terms, prior art) can settle: settle those. ` +
  `A choice the person can make now is a question: never a gate, never a D-record whose Choice awaits confirmation, never something left for acceptance. A decision gate holds only what waits on evidence the plan produces, on finished work or on an outside party; ` +
  `a research gate only what needs data, an account, a paid search or a legal opinion (a store, registry or register with a public search is desk research, recorded with its result and date). ` +
  `Never change what the person settled: an answer, the framing, or a D-record tagged (person, ...) is changed only by a newer answer from the person; a reason to change it is a blocking question. ` +
  `A question, its options and the recommendation name milestones, steps and decisions by title; a number alone is never enough (numbers move between revisions). `
const ASK_RULE = `QUESTIONS: this stage runs unattended inside a workflow. No one can answer a question mid-run, so never wait for one and never use a question tool. ` + BLOCKING_DEF +
  (ON_Q === 'assume'
    ? `The person chose to proceed on assumptions: for each blocking question and each confirmation, take the option you recommend (for a confirmation the unconfirmed value; for a conflict with what the person said, what the person said), write the docs on it, ` +
      `tag a decision so taken (assumed) in the doc, and report it in assumptions as "<question> -> <option taken>". `
    : `Never guess the answer to a blocking question and never build on an unconfirmed value: write and change nothing, and return every blocking question and every confirmation (all of them, in one pass) in questions, ` +
      `each with why it blocks, 2-4 concrete options and the one you recommend; a confirmation has confirm: true and the unconfirmed value as its recommended option. `) +
  `Report in assumptions every other choice the source did not settle (empty when none). `
const QUESTION = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    why: { type: 'string', description: 'what changes with the answer: where each option sends the design' },
    options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete options' },
    recommended: { type: 'string', description: 'the option you recommend, and why in one clause; for a confirmation, the unconfirmed value' },
    confirm: { type: 'boolean', description: 'true for a confirmation: a person-owned choice that already has a value nobody confirmed with the person' },
  },
  required: ['question', 'why', 'options', 'recommended'],
}
const QA = {
  questions: { type: 'array', items: QUESTION, description: 'blocking questions and confirmations only the person can answer; non-empty means you wrote nothing' },
  assumptions: { type: 'array', items: { type: 'string' }, description: 'every choice you made that the source did not settle' },
}
const ASSUMED = []
const noteAssumptions = (scope, r) => { if (r && Array.isArray(r.assumptions)) for (const a of r.assumptions) if (a) ASSUMED.push({ stage: scope, assumption: a }); return r }
// The Intake's assumptions reach every later stage, so no author replaces one with a pick of its own: the stages of the same
// run, and those of a re-run that starts past the Intake, which restores them from the state branch (saved beside the answers).
const intakeTaken = () => ASSUMED.filter(a => a.stage === 'intake').map(a => a.assumption)
const intakeAssumed = () => {
  const taken = intakeTaken()
  return taken.length ? `Assumptions the Intake took that the person has not confirmed: keep each, or return a question to change it; never pick another value silently: ${JSON.stringify(taken)}. ` +
    `Two limits on keeping one. An answer above outranks it: where an answer settles the same point, follow the answer. And one that is a person-owned choice is a value nobody confirmed: ` +
    `a stage that returns questions returns it as a confirmation with that value recommended, and only a run the person told to proceed on assumptions takes it as it stands.\n` : ''
}
const ASK = scope => ASK_RULE + answersFor(scope) + intakeAssumed()
const asked = r => !!(r && Array.isArray(r.questions) && r.questions.length)
// on_question 'assume': each recommended option becomes a shared answer for its scope and every later one, and an assumption.
const assume = qs => {
  for (const q of qs) {
    ANSWERS.push({ id: q.id, stage: q.stage, question: q.question, answer: `${q.recommended} (assumed: the person chose to proceed on recommendations)`, assumed: true })
    ASSUMED.push({ stage: q.stage, assumption: `${q.question} -> ${q.recommended}` })
  }
}
// Ids continue after the highest q<N> already answered in the scope (m<N> included), so a question asked on a re-run never
// reuses an answered id; a decision's id (intake.d<N>) takes no part in the numbering. Every other field of a question,
// confirm included, is kept.
const tagQuestions = (scope, qs) => {
  let n = 0
  for (const a of ANSWERS) { const m = String(a.id || '').match(/^([a-z0-9_]+)\.q(\d+)$/); if (m && m[1] === scope) n = Math.max(n, Number(m[2])) }
  return qs.map((q, i) => { const { id: _id, stage: _stage, ...rest } = q; return { id: `${scope}.q${n + i + 1}`, stage: scope, ...rest } })
}
// The milestones whose author or reviser asked: answers pick no milestone to propose, so the relay names these for args.milestones.
const askedMilestones = qs => [...new Set(qs.map(q => /^m(\d+)$/.exec(q.stage)).filter(Boolean).map(x => Number(x[1])))].sort((a, b) => a - b)
// force on a re-run: this run's /roadmap wrote the docs (regenerated), so force would write them again; or it has not yet, and
// without force the re-run would resume the review of the docs force was to replace.
let regenerated = false
const forceNote = () => !(BRIEF_MODE && A.force) ? ''
  : regenerated ? `Leave force out of the re-run: this run already regenerated architecture.md and roadmap.md, and force would write them again (from: 'proposals' or later refuses it). `
  : `Keep force in the re-run: this run has not regenerated architecture.md and roadmap.md yet. `
// The Seed stage installed the pipeline after the calling session started, so that session loaded none of it.
const seedNote = () => seeded && (seeded.copied > 0 || (seeded.claude_md && seeded.claude_md !== 'unchanged'))
  ? `This run installed the pipeline's CLAUDE.md, commands and context guard in ${DIR} after this session started, so this session loaded none of them: read the "How work happens here" section of ${DIR}/CLAUDE.md now and follow it. ` +
    `A re-run of this workflow can stay in this session; start every other workflow from a new session in ${DIR}, which loads them and runs the workflows by name. ` +
    `Before you leave this session, read ${DIR}/.claude/commands/handoff.md and follow it (this session cannot invoke it by name), so the new session starts from STATE.md with the person's answers, the assumptions still to show them and the next action. `
  : ''
// What a result that ends the run before the Lint phase tells the session besides its own way forward.
const stopNotes = () => [forceNote(), NO_SAVE_NOTE, seedNote()].map(n => n.trim()).filter(Boolean)
// ms: the milestones that asked; failedMs: the ones whose /propose wrote nothing, which only a listed re-run writes.
const relay = (from, ms = [], failedMs = []) => {
  const all = [...new Set(ms.concat(failedMs))].sort((a, b) => a - b)
  const who = !failedMs.length ? 'the milestones that asked'
    : `${ms.length ? 'the milestones that asked and ' : ''}the ones whose /propose failed (${failedMs.join(', ')}: no proposal exists, so nothing is overwritten)`
  return (`Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit (a numbered list when it has none), ` +
    `each with its why, its options and the recommended one first; never answer them on their behalf, and never re-run with on_question: 'assume' unless the person says to proceed on assumptions. ` +
    `Show the confirmations (the questions with confirm: true) as one list the person can accept whole or correct line by line. ` +
    // Sibling authors run at the same time and none sees another's question: the same choice can come back once per milestone.
    (ms.length > 1 ? `Questions from different milestones that ask the same choice are one question to the person: ask it once, and pass the one answer back under each of their ids. ` : '') +
    `Also show the person this result's assumptions: a line they correct, or any decision they make outside these questions, is passed as an answer too (id intake.d<N>, with its question), ` +
    `where N is the next number not yet in use (${freeD('intake')} now): ${ID_RULE}. ` +
    // From the Proposals stage on, no stage applies an answer to the architecture or the roadmap: such a correction names them.
    (from === 'proposals' || from === 'consistency'
      ? `One exception, since the architecture and roadmap are written and a run from '${from}' applies no answer to them: a correction to what either of them says is passed as architecture.d<N>, and the re-run then uses from: 'architecture' in place of the from below ` +
        `(it applies the answer to both docs before their review) and max_milestones: 0 (so it writes no proposal but the milestones this relay names: a milestones list is never cut by it); ` +
        `a correction to one written proposal is passed as m<N>.d<K>, with N in milestones (added to the ones named below, when there are any). N in architecture.d<N> and K in m<N>.d<K> are the next numbers not yet in use (${freeD('architecture')} now for the architecture). `
      : '') +
    (from
      ? `Then re-run this workflow with the same args plus answers (each question's id and question text with the person's answer and the date they gave it, added to any answers given before) and from: '${from}' (this result's resume_from)` +
        (all.length ? `, with milestones: [${all.join(', ')}] (${who}, in place of any milestones given before)` : '') + `, ` +
        `from this session or a new one: it keeps the docs already written and starts again at the stage that asked. ` +
        // The printed call holds absolute paths, and files seeded before the first checkpoint exist only in the checkout that ran.
        `In a new checkout or container, point dir at the new checkout, and pipeline at the pipeline's checkout there (leave pipeline out once the checkout already holds the seeded .claude files, as a clone of the design branch does after its first checkpoint). ` +
        (ms.length ? `Pass exactly those milestones (and the milestone of a proposal the person corrected): answers alone re-propose no written proposal, so a reviser's answer would go unused, and any other milestone listed is proposed again, its doc rewritten as a draft. ` : '') +
        `Always pass that from with the answers: left out, the run infers its start from all the answers passed (the Intake's aside), so an answer an earlier run already used can restart an earlier stage, whose revisions may reset an accepted doc to draft. ` +
        `In this session, resumeFromRunId set to this run's id also replays the unchanged stages before it from the record. `
      : `Then re-run this workflow with the same args plus answers (each question's id and question text with the person's answer and the date they gave it, added to any answers given before) and resumeFromRunId set to this run's id: ` +
        `the stages before the ones that asked replay from the record, and docs already written are kept. `) +
    forceNote() + NO_SAVE_NOTE + seedNote()).trim()
}
const logQuestions = questions => {
  log(`${questions.length} question(s) only the person can answer — status needs_input`)
  for (const q of questions) log(`  ${q.id}${q.confirm ? ' (confirmation)' : ''}: ${q.question} (recommended: ${q.recommended})`)
}

// What every result past the start carries: the stage this run started at (brief mode), with branch its checkpoints, whether
// the answers it was given and the Intake's assumptions reached the state branch (answers_saved, when it had either to save),
// the ids of the answers restored from there (answers_restored, when there are some), and save_answers: false when the run was
// told to keep both off the state branch.
let FROM = null, branchInfo = null, answersSaved = null
const checkpoints = [], restored = []
const branchOut = () => ({ name: BRANCH, action: (branchInfo && branchInfo.action) || '', recovered: (branchInfo && branchInfo.recovered) || [], checkpoints })
const runInfo = () => ({
  ...(BRIEF_MODE && FROM ? { from: FROM } : {}), ...(BRANCH ? { branch: branchOut() } : {}),
  ...(answersSaved === null ? {} : { answers_saved: answersSaved }), ...(restored.length ? { answers_restored: restored } : {}),
  ...(SAVE ? {} : { save_answers: false }),
})
const needsInput = (questions, extra) => {
  logQuestions(questions)
  const from = BRIEF_MODE ? earliestStage(questions.map(q => q.stage)) : ''
  return { status: 'needs_input', questions, relay: relay(from, askedMilestones(questions)), ...(from ? { resume_from: from } : {}), assumptions: ASSUMED, ...runInfo(), ...(extra || {}) }
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
    synthesis: { type: 'string', description: 'the architecture to build on: the winner, with the named ideas grafted from the others and why; every decision with its options and choice, or marked OPEN when it is in questions' },
    questions: { type: 'array', items: QUESTION, description: 'blocking questions and confirmations only the person can answer: what the source, the framing and the answers do not settle and is not yours to settle (empty when none)' },
  },
  required: ['scores', 'winner', 'synthesis', 'questions'],
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
    unconfirmed: {
      type: 'array',
      description: 'from --decisions: every decision record no person confirmed (tagged assumed, or untagged)',
      items: { type: 'object', properties: { doc: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, by: { type: 'string', description: 'assumed, or empty when untagged' } }, required: ['doc', 'id', 'title', 'by'] },
    },
    proposed: {
      type: 'array',
      description: 'from --decisions: every line that holds a value an author proposed, marked (proposed)',
      items: { type: 'object', properties: { doc: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } }, required: ['doc', 'line', 'text'] },
    },
  },
  required: ['docs', 'lanes', 'next_milestones', 'unconfirmed', 'proposed'],
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
// What a per-doc reviewer makes of a decision's provenance tag, and what every reviser does with a finding that is the person's.
const TAG_REVIEW = ON_Q === 'assume'
  ? `The person chose to proceed on assumptions, so a decision tagged (assumed) is not a defect. `
  : `A person-owned decision tagged (assumed), or (source) when the source was drafted for the person (${DRAFTED}), is a concern whose fix is the question to ask. The person-owned choices: ${OWNED}. `
const PERSON_FINDING = `A finding only the person can settle (the source is silent or ambiguous on it, the fix would choose for them, or it would change a choice the person made) is a blocking question, per QUESTIONS: never decline it or pick a side. `

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
      WORK + REVIEW_CTX + TAG_REVIEW + answersFor(scope) + `Invoke the Skill tool with skill "review-proposal" once for each of these docs: ${docs.join(', ')}. ${frame}` +
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
      `decline any you can verify is wrong and give the reason. ` + PERSON_FINDING +
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
// The judge's questions when they could be neither asked nor assumed (the synthesis was not saved): /roadmap carries them.
let judgeOpen = []
const proposals = []
// kept: the pending code milestones whose existing proposal this run leaves as it is; notProposed: the ones left without one.
let kept = [], notProposed = []

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
    `3. git fetch origin, and when git ls-remote --heads origin ${BRANCH} lists it, git fetch origin +refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH} (a single-branch clone's plain fetch skips other branches, so origin/${BRANCH} would be missing or stale). ` +
    `4. Already on ${BRANCH} (action current), or else origin/${BRANCH} or a local ${BRANCH} exists (action continued: git switch ${BRANCH}, or with no local ${BRANCH} git switch -c ${BRANCH} origin/${BRANCH}, since a single-branch clone's git switch cannot guess it from origin's): when origin/${BRANCH} has commits HEAD lacks, git merge --ff-only origin/${BRANCH}; ` +
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
let survey = null, DOCS_EXIST = false, stateUnreadable = false, savedAssumed = []
const startFailed = reason => {
  log(`Cannot start: ${reason}`)
  return { status: 'failed_at_start', stop_reason: reason, seeded, ...runInfo() }
}
// The context file is checked (and restored from the state branch) before any design agent is told to read it.
const CTX_CHECK = `context_exists: whether ${CTX_FILE} exists (relative to ${DIR}, or absolute). Never read it, and never copy any of its text. When it does not exist, run, in ${DIR}: ${STATE} get context/builder-context.md --to ${CTX_FILE} ` +
  `(this restore is the one change this stage may make: the file, and its line in the local exclude file; exit 0 means the person chose to keep their framing on the state branch): on exit 0 return context_exists true and context_restored true; otherwise both false (exit 3: none saved; exit 2: say why in notes). ` +
  `After a restore, when the file lies inside ${DIR}, append its path from the root of ${DIR}, with a leading /, to the checkout's local exclude file unless a line there already names it ` +
  `(the file git rev-parse --git-path info/exclude prints, created when missing; it is never committed or pushed), so no later stage commits the restored framing by accident. `
const CTX_NOT_FOUND = `context_not_found: ${CTX_FILE} does not exist in ${DIR}, and the state branch holds no context/builder-context.md to restore it from. Copy it back into this checkout or rewrite it with the person, then re-run: a design run without the person's framing would choose for them`
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
      saved_answers: {
        type: 'array',
        description: 'the answers in the state branch\'s design/answers.json, when its source names this brief; else empty',
        items: { type: 'object', properties: { id: { type: 'string' }, stage: { type: 'string' }, question: { type: 'string' }, answer: { type: 'string' }, date: { type: 'string' } }, required: ['id', 'answer'] },
      },
      saved_assumptions: { type: 'array', items: { type: 'string' }, description: 'the assumptions array of that design/answers.json (what the Intake took as given), verbatim; empty when the file has none or its source names another brief' },
      answers_unreadable: { type: 'boolean', description: 'true only when the read of design/answers.json exited 2: the state branch could not be read, so nothing is known about what it holds' },
      context_exists: { type: 'boolean', description: 'the context file exists (after the restore, when one was tried); true when the run names none' },
      context_restored: { type: 'boolean', description: 'the context file was missing and was restored from the state branch' },
      notes: { type: 'string' },
    },
    required: ['brief_exists', 'out_dir', 'architecture', 'roadmap', 'architecture_exists', 'roadmap_exists', 'milestones', 'panel_synthesis', 'saved_answers', 'saved_assumptions', 'answers_unreadable', 'context_exists', 'context_restored'],
  }
  survey = await agent(
    GUARD + WHERE + `Find the design docs that already exist, before this run writes any. Read-only${CTX_FILE ? ' but for the one restore step 6 allows' : ''}: change no ${CTX_FILE ? 'other ' : ''}file and no git state. ` +
    `1. brief_exists: whether ${A.brief} exists (relative to ${DIR}, or absolute). ` +
    `2. The proposals directory is ${OUT_TEXT}, relative to ${DIR}: return it as out_dir, with the paths of its architecture.md and roadmap.md and whether each exists. ` +
    `3. When roadmap.md exists, run ${LINT} <roadmap> --roadmap and ${MILESTONES_FROM_LINT}. ` +
    (FROM_ARG === 'architecture'
      ? `4. Run ${STATE} get design/panel-synthesis.md (this read of the repository's state branch is allowed; a missing script counts as none saved): panel_synthesis is true when it exits 0 and the file's Source: line names ${BRIEF_REL}, else false (exit 3: none saved; exit 2: say why in notes). `
      : `4. Leave panel_synthesis false. `) +
    (SAVE
      ? `5. Run ${STATE} get design/answers.json (this read of the repository's state branch is allowed; a missing script counts as none saved): when it exits 0 and the file's source names ${BRIEF_REL}, ` +
        `return its answers as saved_answers (the id, stage, question, answer and date of each, verbatim) and its assumptions array, when it has one, as saved_assumptions (verbatim); else return both empty (exit 3: none saved). ` +
        `Set answers_unreadable true only when the read exits 2 (the state branch could not be read: say why in notes), and false otherwise. `
      : `5. Return saved_answers and saved_assumptions empty and answers_unreadable false: this run reads no saved answers (save_answers: false). `) +
    (CTX_FILE ? `6. ${CTX_CHECK}` : `6. Return context_exists true and context_restored false. `) +
    `This run was asked to start at ${FROM_ARG || 'the stage the docs and answers imply'}${A.force ? ', regenerating the docs (force)' : ''}${ANSWERS.length ? `, with answers to ${ANSWERS.map(a => a.id).join(', ')}` : ''}.`,
    opts('existing-docs', 'Seed', 'lint', SURVEY_SCHEMA),
  )
  if (!survey) return startFailed('the existing-docs stage failed to report')
  if (!survey.brief_exists) return startFailed(`brief_not_found: ${A.brief} does not exist in ${DIR} (the checkpoints never commit it: copy it into this checkout, then re-run)`)
  if (CTX_FILE && !survey.context_exists) return startFailed(CTX_NOT_FOUND)
  if (CTX_FILE && survey.context_restored) log(`Restored ${CTX_FILE} from the state branch (context/builder-context.md)`)
  if (!!survey.architecture_exists !== !!survey.roadmap_exists && !A.force) {
    return startFailed(`partial_docs: only ${survey.architecture_exists ? survey.architecture : survey.roadmap} exists. Restore the other one, or pass force to regenerate both from scratch`)
  }
  DOCS_EXIST = !!(survey.architecture_exists && survey.roadmap_exists)
  // Inferred with the docs on disk: every answer passed in args counts but the Intake's, which the docs were written after.
  // An architecture answer still counts, since an architecture reviser's question can be pending on docs that exist. The
  // answers restored below never count: an earlier run already used them.
  const counted = ANSWERS.filter(a => a.stage !== 'intake')
  const have = new Map(ANSWERS.map(a => [a.id, a]))
  const savedAnswers = SAVE ? (survey.saved_answers || []).filter(a => answered(a) && a.id) : []
  // An id passed for another question than the saved answer under it, or twice in args: the run stops before the save below
  // could replace one answer with the other.
  const clashes = ARG_CLASH.map(id => ({ id, why: 'args.answers holds it more than once, with different answers or questions' }))
    .concat(savedAnswers.filter(a => have.has(a.id) && otherQuestion(have.get(a.id).question, a.question))
      .map(a => ({ id: a.id, why: `passed for ${JSON.stringify(have.get(a.id).question)}, while design/answers.json holds it for ${JSON.stringify(a.question)}` })))
  if (clashes.length) return startFailed(idsReused(clashes, savedAnswers))
  stateUnreadable = SAVE && !!survey.answers_unreadable
  if (stateUnreadable) log(`The saved answers could not be read (design/answers.json on the state branch${survey.notes ? `: ${survey.notes}` : ''}): none is restored, and this run saves none, so it cannot overwrite what is there`)
  for (const a of savedAnswers) {
    const passed = have.get(a.id)
    if (passed) {
      // Passed again without its question or date: they come from the saved copy, so the save below never blanks the record.
      // The date only with the same answer: a new answer to the question was not given on the old one's day.
      if (!passed.question && a.question) passed.question = a.question
      if (!passed.date && a.date && String(passed.answer).trim() === String(a.answer).trim()) passed.date = a.date
      continue
    }
    const kept = withStage(a)
    have.set(a.id, kept)
    ANSWERS.push(kept)
    restored.push(a.id)
  }
  if (restored.length) log(`Restored ${restored.length} answer(s) saved on the state branch (design/answers.json): ${restored.join(', ')}`)
  logNoText()
  FROM = FROM_ARG || (A.force ? 'intake' : DOCS_EXIST ? (counted.length ? earliestStage(counted.map(a => a.stage)) : 'proposals') : 'intake')
  if (at(FROM) >= at('proposals') && !DOCS_EXIST) {
    FROM = null
    return startFailed(`no_docs: from '${FROM_ARG}' keeps the existing ${survey.architecture || 'architecture.md'} and ${survey.roadmap || 'roadmap.md'}, and they do not exist. Run without from (or with from: 'intake') to write them`)
  }
  log(`Starting at ${FROM}${FROM_ARG ? '' : ' (inferred)'}: ${DOCS_EXIST ? `${survey.architecture} and ${survey.roadmap} exist${A.force ? ' and are regenerated (force)' : ''}` : 'no design docs yet'}`)
  // What the Intake of an earlier run took as given: a run that starts past the Intake has no Intake to find it again.
  savedAssumed = SAVE ? (survey.saved_assumptions || []).map(x => String(x || '').trim()).filter(Boolean) : []
  if (at(FROM) > at('intake') && savedAssumed.length) {
    for (const x of savedAssumed) ASSUMED.push({ stage: 'intake', assumption: x })
    log(`Restored ${savedAssumed.length} assumption(s) the Intake took, saved on the state branch (design/answers.json): every author gets them, and this result lists them`)
  }
} else {
  FROM = 'intake'
  if (ARG_CLASH.length) return startFailed(idsReused(ARG_CLASH.map(id => ({ id, why: 'args.answers holds it more than once, with different answers or questions' })), []))
  logNoText()
  // Concern mode runs no survey: the context file gets the same check, alone.
  if (CTX_FILE) {
    const ctx = await agent(
      GUARD + WHERE + `Check that the file holding the person's framing is in place, before any design agent is told to read it. Change no other file and no git state. ${CTX_CHECK}`,
      opts('context-check', 'Seed', 'lint', { type: 'object', properties: { context_exists: { type: 'boolean' }, context_restored: { type: 'boolean' }, notes: { type: 'string' } }, required: ['context_exists', 'context_restored'] }),
    )
    if (!ctx || !ctx.context_exists) return startFailed(ctx ? CTX_NOT_FOUND : 'the context-check stage failed to report')
    if (ctx.context_restored) log(`Restored ${CTX_FILE} from the state branch (context/builder-context.md)`)
  }
}
// The docs are written (or rewritten) by /roadmap in this run; otherwise the existing ones are kept and resumed.
const REGEN = BRIEF_MODE && (!!A.force || !DOCS_EXIST)

// ---- Answers: the ones this run was given, with the ones restored, are kept on the state branch, so the person's decisions
// outlive the session and a re-run from any clone picks them up. Best effort: the result says whether it worked. In brief mode
// the file also holds what the Intake took as given (assumptions), for the runs that start past the Intake. One save per run:
// a run that skips the Intake saves right after the survey that read the saved copy; a run with an Intake saves after it,
// the Intake's assumptions with the answers. Only what the person said is saved as an answer, never an option the run assumed.
// Concern mode reads no saved copy, so it writes a file of its own (never the brief's design/answers.json, which a later
// brief-mode run restores), and after the Intake: a stage added before the Intake would end the replay of a resumed run
// (resumeFromRunId) there. Nothing is saved with save_answers: false, or over a saved copy the survey could not read.
// assumptionsToo: the run goes on past the Intake, so the assumptions are saved even when no answer was given; they replace
// the saved ones, and a save is due when either list is non-empty.
const saveAnswers = async (ph, assumptionsToo = false) => {
  const taken = BRIEF_MODE ? intakeTaken() : []
  if (!SAVE || !(GIVEN || (assumptionsToo && (taken.length || savedAssumed.length)))) return
  if (stateUnreadable) { answersSaved = false; return }
  const path = BRIEF_MODE ? 'design/answers.json' : 'design/answers-concern.json'
  const store = { source: BRIEF_MODE ? BRIEF_REL : 'concern', answers: ANSWERS.filter(a => !a.assumed).map(a => ({ id: a.id, stage: a.stage, question: a.question || '', answer: a.answer, date: a.date || '' })),
    ...(BRIEF_MODE ? { assumptions: taken } : {}) }
  const saved = await agent(
    GUARD + WHERE + `Save the person's answers${BRIEF_MODE ? ' and what the Intake took as given' : ''} to the repository's state branch. Write the text between the -----BEGIN ANSWERS----- and -----END ANSWERS----- lines below (not those lines), verbatim, to a file in a new temporary directory outside ${DIR} (mktemp -d), ` +
    `then run, in ${DIR}: ${STATE} save <that file> --as ${path} -m "brief-to-proposals: the person's answers". Remove the temporary directory afterwards. ` +
    `Change nothing in ${DIR}'s working tree, index or branches. Saving is best effort: when the script is missing or exits 2, report saved=false with its message, and never retry another way.\n` +
    `-----BEGIN ANSWERS-----\n${JSON.stringify(store, null, 1)}\n-----END ANSWERS-----`,
    opts('save-answers', ph, 'lint', { type: 'object', properties: { saved: { type: 'boolean' }, commit: { type: 'string' }, error: { type: 'string' } }, required: ['saved'] }),
  )
  answersSaved = !!(saved && saved.saved)
  log(answersSaved ? `${store.answers.length} answer(s)${taken.length ? ` and ${taken.length} assumption(s) of the Intake` : ''} saved to the state branch (${path})` : `Answers not saved (best effort): ${(saved && saved.error) || 'the stage failed to report'}`)
}
if (BRIEF_MODE && at(FROM) > at('intake')) await saveAnswers('Seed')

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
    `You are the intake for a design run: before anyone sketches an architecture or writes a doc, find every blocking question and every confirmation. ` + BLOCKING_DEF +
    `Go through the person-owned choices class by class. For each class the source touches, either quote in notes where the person settled it (the framing, an answer above, or a source the person wrote themselves) or return it: ` +
    `a blocking question when the source is silent on it or states it two ways, a confirmation (confirm: true, the source's value as the recommended option) when the source was drafted for the person or the framing lists it as open, recommended or not yet decided. ` +
    `A class the source never mentions is not skipped: when the design must settle it and neither the framing nor an answer above does, return it as a blocking question. ` +
    `One item per choice; values of one kind (several retention periods, several thresholds) form one confirmation. Never one the framing or the answers above already settle, and never an implementation choice. ` +
    (CTX_FILE
      ? `When ${CTX_FILE} has a line starting "${UNCONFIRMED_MARK}" and no answer above confirms the framing, return the framing as ONE confirmation in the same batch (confirm: true): the question "Should the design follow this builder framing?", ` +
        `the recommended option to follow it as ${CTX_FILE} states it, and in why its limits in your own words; never copy personal data, credentials or the file's text itself. `
      : '') +
    `Each question: why it blocks (where each option sends the design), 2-4 concrete options, and the one you recommend. ` +
    `Return no questions when nothing blocks. In assumptions, list what you would otherwise take as given that the source does not state and that is yours to settle; ` +
    `never a person-owned choice: the value you would take for one is the recommended option of the question you return for it. Read-only: write no files.`,
    opts('intake', 'Intake', 'intake', INTAKE_SCHEMA),
  )
  noteAssumptions('intake', intake)
  const qs = asked(intake) ? tagQuestions('intake', intake.questions) : []
  const stops = !intake || (qs.length > 0 && ON_Q !== 'assume')
  if (qs.length && !stops) assume(qs)
  // The one save of a run with an Intake. A run that stops here saves the answers it was given; one that goes on also saves
  // what the Intake took as given, for the re-runs that start past the Intake.
  await saveAnswers('Intake', !stops)
  if (!intake) {
    // Every later stage would ask on its own, one stage at a time, after the panel has run: stop where the batch belongs.
    log('The Intake failed to report: stopping before any design is written without its questions')
    return { status: 'failed_at_intake', stop_reason: 'the intake stage failed to report', ...(BRIEF_MODE ? { resume_from: 'intake' } : {}), assumptions: ASSUMED, seeded, ...runInfo(),
      next_steps: [`Re-run with the same args${BRIEF_MODE ? ` and from: 'intake' (this result's resume_from)` : ''}: nothing was designed, and the docs on disk are as they were.`].concat(stopNotes()) }
  }
  if (stops) return needsInput(qs, { seeded })
  const taken = intakeTaken()
  if (qs.length) {
    log(`Intake: proceeding on ${qs.length} recommended answer(s) (on_question: assume)`)
  } else {
    log(`Intake: no blocking questions${taken.length ? `; ${taken.length} assumption(s) the person has not confirmed (this result's assumptions):` : ''}`)
    for (const a of taken) log(`  ${a}`)
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
            GUARD + WHERE + CTX + answersFor('architecture') + intakeAssumed() + `Read ${SOURCE} in full, and the existing tree in ${DIR} if it has code. Sketch an architecture for it from this angle — ${angle.text} ` +
            `Cover components and technologies, data flow, the major decisions with the options you weighed, security and privacy, how it is deployed and operated ` +
            `(environments, CI/CD, secrets, migrations, monitoring, rollback, release gates such as legal review or store submission), ordered milestones with exit criteria ` +
            `(mark the ones a person must do), the assumptions the design rests on that nobody has verified, and your sketch's weaknesses. ` +
            `A sketch returns no questions: where another part of the source, the tree or your research makes the person's framing or an answer impossible to follow, or a person-owned choice (${OWNED}) is settled by none of them, settle nothing silently: name it in assumptions_to_validate, for the judge to ask. ` +
            `Read-only: write no files. Ground every claim about the source in its text.`,
            opts(`sketch:${angle.key}${i >= ANGLES.length ? `-${i}` : ''}`, 'Architecture', 'sketch', SKETCH_SCHEMA),
          ).then(s => s && { angle: angle.key + (i >= ANGLES.length ? `-${i}` : ''), ...s })
        }))).filter(Boolean)
        if (sketches.length) {
          judged = await agent(
            GUARD + WHERE + CTX + answersFor('architecture') + intakeAssumed() + `Judge these independent architecture sketches for ${SOURCE} (read it in full first). Score each 1-5 on: fit to the constraints, ` +
            `which are the framing's and the answers' where they speak (what the person settled) and the source's (builder, budget, timeline) where they are silent; time to the first validation; security and privacy; operability and cost; simplicity; and room to grow. ` +
            `Total the scores. Then write the synthesis to build on: the winner, with any clearly better idea from the others grafted in, naming what came from where and why. ` +
            `Keep every decision with its options and choice. ` + BLOCKING_DEF +
            `A decision the sketches chose differently, or a person-owned choice, that the source, the framing and the answers do not settle is not yours to settle: return it in questions (a confirmation, confirm: true, when one value is the source's or the framing's), ` +
            `with the sketches' options, why it matters and the one you recommend, and mark it OPEN in the synthesis. Return no questions when nothing is open. The synthesis is saved to the repository's state branch: state the framing's constraints in your own words, and never copy personal data, credentials or the framing text itself into it. Read-only: write no files.\n\nSKETCHES:\n${JSON.stringify(sketches, null, 1)}`,
            opts('judge', 'Architecture', 'judge', JUDGE_SCHEMA),
          )
          if (judged) {
            log(`Architecture panel: ${judged.scores.map(s => `${s.sketch} ${s.total}`).join(', ')}; building on ${judged.winner}`)
            // Saved so a later run that starts at 'architecture' (a /roadmap question answered, from another session) needs no new panel.
            // The judge's open questions are saved with it: that later run has no judge to name the option it recommended.
            const oneLine = t => String(t || '').replace(/\s+/g, ' ').trim()
            const openQs = asked(judged)
              ? `\n\n## Open questions for the person\n\n${judged.questions.map(q => `- ${oneLine(q.question)} Options: ${(q.options || []).map(oneLine).join(' | ')}. Recommended by the judge: ${oneLine(q.recommended)}`).join('\n')}`
              : ''
            panelSaved = await agent(
              GUARD + WHERE + `Save this architecture panel synthesis to the repository's state branch. Write the text between the -----BEGIN PANEL SYNTHESIS----- and -----END PANEL SYNTHESIS----- lines below (not those lines), verbatim, to a file in a new temporary directory outside ${DIR} (mktemp -d), ` +
              `then run, in ${DIR}: ${STATE} save <that file> --as design/panel-synthesis.md -m "brief-to-proposals: architecture panel synthesis". Remove the temporary directory afterwards. ` +
              `Change nothing in ${DIR}'s working tree, index or branches. Saving is best effort: when the script is missing or exits 2, report saved=false with its message, and never retry another way.\n` +
              `-----BEGIN PANEL SYNTHESIS-----\n# Panel synthesis\n\nSource: ${BRIEF_REL}\nWinner: ${judged.winner}\nScores: ${judged.scores.map(s => `${s.sketch} ${s.total}`).join(', ')}\n\n${judged.synthesis}${openQs}\n-----END PANEL SYNTHESIS-----`,
              opts('save-panel', 'Architecture', 'lint', { type: 'object', properties: { saved: { type: 'boolean' }, commit: { type: 'string' }, error: { type: 'string' } }, required: ['saved'] }),
            )
            log(panelSaved && panelSaved.saved ? 'Panel synthesis saved to the state branch (design/panel-synthesis.md)' : `Panel synthesis not saved (best effort): ${(panelSaved && panelSaved.error) || 'the stage failed to report'}`)
            // The judge asked: assumed like the Intake's, or asked now when a re-run from 'architecture' can build on the saved
            // synthesis. With no saved synthesis a stop would cost the panel, so /roadmap carries the questions instead.
            if (asked(judged)) {
              const qs = tagQuestions('architecture', judged.questions)
              if (ON_Q === 'assume') {
                assume(qs)
                log(`Architecture panel: proceeding on ${qs.length} recommended answer(s) to the judge's question(s) (on_question: assume)`)
              } else if (panelSaved && panelSaved.saved) {
                return needsInput(qs, { seeded, panel: judged })
              } else {
                judgeOpen = judged.questions
                log(`Architecture panel: the judge left ${qs.length} question(s) open and the synthesis was not saved, so /roadmap carries them`)
              }
            }
          }
        }
      }
      // The source wins over a synthesis the person has not confirmed, but never over what the person said: where the synthesis
      // follows the framing or an answer against the source, the person's word stands. What it leaves open for the person is asked.
      const SYNTH_SOURCE = `where it contradicts the source, the source wins and you say so, except where the synthesis follows the framing or an answer from the person, which outrank the source`
      const SYNTH_RULE = `An open question the synthesis leaves for the person is a blocking question, never a D-record to confirm later. Every departure from the synthesis is listed, with its reason, in assumptions; ` +
        `where the framing or an answer confirms the synthesis or one of its choices, a departure from it is a blocking question. `
      const SYNTHESIS = judged
        ? `Build on the architecture synthesis below, from an independent panel (a strong input, not a substitute for reading the source; ${SYNTH_SOURCE}). ${SYNTH_RULE}` +
          (judgeOpen.length ? `The panel's judge left these questions for the person, and they could not be asked before this stage: return each one still open in your questions, with your own: ${JSON.stringify(judgeOpen)}\n` : '') +
          `The synthesis:\n${judged.synthesis}\n`
        : reusedPanel
        ? `Build on the architecture synthesis an independent panel wrote for this brief in an earlier run (a strong input, not a substitute for reading the source; where it contradicts the framing or an answer above, they win and you say so; ${SYNTH_SOURCE}). ${SYNTH_RULE}` +
          `Its "Open questions for the person" section, when it has one, lists what the panel's judge left open, each with the option the judge recommended, as the person was shown them: one that an answer above settles is settled by that answer; ` +
          (ON_Q === 'assume' ? `for each other one, take the option the judge recommended, tag the decision (assumed) and report it in assumptions. ` : `each other one is still a blocking question. `) +
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
        return { status: 'failed_at_roadmap', stop_reason: (arch && arch.stop_reason) || '', assumptions: ASSUMED, seeded, panel: judged, ...runInfo(), next_steps: stopNotes() }
      }
      regenerated = true
      log(`Wrote ${arch.architecture} and ${arch.roadmap}: ${arch.milestones.length} milestones`)
    } else {
      arch = surveyArch()
      log(`Resuming the review of the existing ${arch.architecture} and ${arch.roadmap}: /roadmap is not re-run`)
      // The docs were written before some of the person's answers: those are applied before the review, so the reviewer reads
      // docs that already say what the person decided. Not a review round; its questions stop the run like any reviser's.
      const settled = ANSWERS.filter(a => !a.assumed && (a.stage === 'intake' || a.stage === 'architecture'))
      if (settled.length) {
        const applied = await agent(
          WORK + CTX + ASK('architecture') + `${arch.architecture} and ${arch.roadmap} may have been written before some of the person's answers. Read both, and find the answers listed at the end of this prompt (the Intake's and the architecture's) that they do not yet reflect. ` +
          `For each of the two docs that needs a change, invoke the Skill tool with skill "propose" with args "--revise <doc>", applying those answers as its findings, ` +
          `and tag each decision an answer settles (person, <the answer's date, or today's when it has none>, <the answer's id>). When the docs already reflect every answer, write nothing and say so in summary. ` +
          `A change an answer calls for that only the person can settle (it is ambiguous, or it contradicts another answer or the framing) is a blocking question, per QUESTIONS: never pick a side. ` +
          `Edit only ${arch.architecture} and ${arch.roadmap}; never any other doc. Re-run ${LINT} on each revised doc until it reports no errors.\n` +
          JSON.stringify(settled.map(a => ({ id: a.id, question: a.question || a.id, answer: a.answer, date: a.date || '' })), null, 2),
          opts('revise:architecture-answers', 'Architecture', 'revise', REVISE_SCHEMA),
        )
        noteAssumptions('architecture', applied)
        if (asked(applied)) {
          const qs = tagQuestions('architecture', applied.questions)
          await checkpoint('Architecture', [arch.architecture, arch.roadmap], 'Checkpoint the draft architecture and roadmap')
          return needsInput(qs, { seeded, architecture: arch, panel: judged })
        }
        log(applied ? `Answers applied to the existing docs: ${applied.summary || 'no summary'}` : 'The stage that applies the answers to the existing docs failed to report; the review checks the docs against them')
      }
    }
    archReview = await reviewLoop(
      [arch.architecture, arch.roadmap],
      `These are the architecture and roadmap for ${SOURCE}: judge them against the source (every requirement, constraint, risk and validation step it states), ` +
      `for sound decisions, a deploy and operations plan, and milestones in an order that validates the riskiest assumptions first with every person-only step as a human gate. `,
      'architecture', 'Architecture', 'architecture',
    )
    await checkpoint('Architecture', [arch.architecture, arch.roadmap], 'Checkpoint the draft architecture and roadmap')
    if (archReview.questions.length) return needsInput(archReview.questions, { seeded, architecture: arch, panel: judged, architecture_review: archReview })
    if (!archReview.reviewed) {
      const forced = !!forceNote()
      return {
        status: 'review_failed', resume_from: 'architecture', assumptions: ASSUMED, seeded, architecture: arch, panel: judged, architecture_review: archReview, ...runInfo(),
        next_steps: [`A review or revise stage of the architecture failed to report, so the docs are not reviewed: re-run with the same args${forced ? ', without force,' : ''} and from: 'architecture' (this result's resume_from); left out, the run would infer its start and could skip the review.`].concat(stopNotes()),
      }
    }
    if (!archReview.clean) {
      log('Architecture or roadmap still has blocking findings — stopping before any proposal is written')
      // The person decides what happens to findings the revise rounds did not clear: the run never picks for them.
      const forceLine = forceNote().trim()
      const ways = [
        `(A) Another pass: re-run with the same args${forceLine ? ', without force,' : ''} and from: 'architecture', with max_review_rounds above ${MAX_REVIEW}.`,
        `(B) Answer the findings that are theirs (scope, money, legal posture, data handling, a departure from what they said): pass each back as an answer (id architecture.d<N>, with the finding as its question; N is the next number not yet in use, ${freeD('architecture')} now, and ${ID_RULE}), then re-run with from: 'architecture'.`,
        `(C) Go on with from: 'proposals', accepting the findings that remain.`,
      ]
      // The session that reads this may have loaded none of the pipeline: the notes every other stop carries go with the ways.
      const notes = stopNotes()
      return {
        status: 'blocked_at_architecture_review', resume_from: 'architecture',
        relay: `Show the person architecture_review.findings_remaining, each finding in full, and this result's assumptions, with these ways forward: ${ways.join(' ')} They choose; never choose for them.${notes.map(n => ` ${n}`).join('')}`,
        next_steps: ways.concat(notes), assumptions: ASSUMED, seeded, architecture: arch, panel: judged, architecture_review: archReview, ...runInfo(),
      }
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
    // Docs written by /roadmap in this run get every proposal; docs that already existed get only the missing ones (an author
    // that asked wrote none), or exactly args.milestones, and keep every other proposal. Answers pick no milestone: each run
    // passes every earlier one, and /propose rewrites a written proposal as a draft, so the relay names the milestones that asked.
    phase('Proposals')
    const wanted = ONLY ? pendingCode.filter(m => ONLY.includes(m.n))
      : REGEN ? pendingCode
      : pendingCode.filter(m => !m.proposal_exists)
    // The cap cuts the default set only: a milestones list names exactly the milestones to propose (the ones that asked, the
    // one the person corrected), and cutting it would leave an answered question unused.
    const todo = MAX_M !== null && !ONLY ? wanted.slice(0, MAX_M) : wanted
    kept = pendingCode.filter(m => m.proposal_exists && !todo.includes(m))
    notProposed = pendingCode.filter(m => !m.proposal_exists && !todo.includes(m))
    if (notProposed.length) log(`Not proposing milestones ${notProposed.map(m => m.n).join(', ')} (${ONLY ? 'args.milestones' : 'args.max_milestones'}); ` +
      `write them later with a re-run of this workflow (from: 'proposals', milestones: [${notProposed.map(m => m.n).join(', ')}])${SAVE ? `: it restores the person's saved answers, which a bare /propose --milestone=N does not get` : ''}`)
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
    notProposed = pendingCode.filter(m => !m.proposal_exists)
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
    return { status: 'failed_at_propose', stop_reason: (p && p.stop_reason) || '', assumptions: ASSUMED, ...runInfo() }
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
    ? `${p.a} is the product brief (the source: it never changes) and ${p.b} the roadmap planned from it. Report each part of the brief that no milestone plans for or rules out (coverage_gaps), and milestones whose order builds on something not yet built or validated. A part of the brief that the person's framing or an answer replaces, rules out or defers is not a gap once the roadmap says so; where the roadmap is silent on it, report it as a gap and name the framing or the answer's id that settles it, so the roadmap records the person's choice. A finding never names the brief: one about the brief's coverage names the roadmap. `
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
    // Leaving out something the brief promises is a person-owned choice (what the first release leaves out): planned, or asked.
    const gaps = consistency.coverage_gaps.map(g => ({ doc: arch.roadmap, severity: 'concern', description: `Coverage gap: ${g}. Plan it in a milestone (or the proposal that should hold it). ` +
      `Leaving it out is the person's call, never yours: where the brief, the framing or an answer already rules it out or defers it, say so in the roadmap's paragraph on the ordering (with the answer's id, when an answer does); otherwise, when you would not plan it, ` +
      `return it as a blocking question (options: the milestone to plan it in, by title; defer it past the first release; drop it), every such gap in one batch.` }))
    log(`Consistency: ${consistency.findings.length} findings (${bad.length} blocking), ${gaps.length} coverage gaps`)
    const known = new Set(allDocs.map(norm))
    const byDoc = {}
    for (const f of bad.concat(gaps)) { const d = norm(f.doc); (byDoc[d] = byDoc[d] || []).push(f) }
    const targets = Object.keys(byDoc).filter(d => known.has(d))
    consistency.unrouted = Object.keys(byDoc).filter(d => !known.has(d)).map(d => ({ doc: d, findings: byDoc[d] }))
    if (consistency.unrouted.length) { consistencyOk = false; log(`Findings name docs this run did not write: ${consistency.unrouted.map(u => u.doc).join(', ')}`) }
    const fixes = await parallel(targets.map((doc, i) => () => agent(
      WORK + CTX + ASK('consistency') + `Invoke the Skill tool with skill "propose" with args "--revise ${doc}", applying these cross-doc findings; decline any you can verify is wrong and give the reason. ` +
      PERSON_FINDING +
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
    // Renumber so every consistency question keeps a distinct id across the revisions and the re-reviews, after the answered ones.
    consistency.questions = tagQuestions('consistency', consistency.questions.concat(consistency.rechecks.flatMap(r => r.questions || [])))
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
  (arch ? `; ${LINT} ${arch.roadmap} --roadmap --json` : '') + `; and ${LINT} <doc> --decisions on ${arch ? `${arch.architecture}, ${arch.roadmap} (it holds no decision records: its proposed values are listed) and ` : ''}each proposal. Report per doc the error and warning counts and their messages, ` +
  `per proposal the --lanes errors (e.g. lane_cycle) and the number of chains, lanes, blocked lanes and pending human gates, and the next actionable milestones. ` +
  `From each --decisions output, return in unconfirmed every record of its unconfirmed list (the doc, its id, title and by) and in proposed every entry of its proposed list (the doc, its line and text); ` +
  `a lint that does not know --decisions: return both empty. Change nothing.`,
  opts('lint', 'Lint', 'lint', LINT_SCHEMA),
)
const lintErrors = lint ? lint.docs.reduce((n, d) => n + d.errors, 0) + lint.lanes.reduce((n, l) => n + (l.errors || 0), 0) : null
const unclean = written.filter(p => !p.review || !p.review.clean)
const laterDocs = BRIEF_MODE ? propDocs.slice(1).map(p => p.doc) : []
// The refresh-proposal call the next steps name: with the framing file, when this run had one.
const REFRESH_ARGS = `{ doc, dir${CTX_FILE ? `, context_file: '${CTX_FILE}'` : ''} }`

// What no person confirmed, shown to the person before they accept a doc: the run's assumptions, the decisions tagged (assumed)
// or untagged, and the values an author proposed.
const unconfirmed = (lint && lint.unconfirmed) || [], proposedValues = (lint && lint.proposed) || []
const named = unconfirmed.slice(0, 12).map(u => `${u.id} "${u.title}" in ${u.doc}`).join('; ') + (unconfirmed.length > 12 ? `; and ${unconfirmed.length - 12} more` : '')
const questions = pendingQs.concat((consistency && consistency.questions) || [])
if (questions.length) logQuestions(questions)
// With questions pending the status is needs_input, which would hide a proposal that failed or did not come back clean: the
// re-run the relay names writes the failed ones (it lists them, and starts no later than the Proposals stage) and keeps every
// other proposal as it is, so the unclean ones are named apart, with what to do about them.
const failedProps = proposals.filter(p => p.failed)
const failedMs = questions.length && BRIEF_MODE ? failedProps.map(p => p.milestone) : []
const attention = !questions.length ? [] : failedProps.map(p => ({ milestone: p.milestone, doc: p.doc, reason: `/propose wrote no proposal: ${p.stop_reason}` }))
  .concat(unclean.filter(p => !(p.questions && p.questions.length)).map(p => ({
    milestone: p.milestone, doc: p.doc,
    reason: !p.review || !p.review.reviewed ? 'its review did not complete' : `${blocking(p.review.findings_remaining).length} blocking finding(s) remain after ${p.review.revise_rounds} revise round(s)`,
  })))
const resumeFrom = questions.length && BRIEF_MODE ? earliestStage(questions.map(q => q.stage).concat(failedMs.length ? ['proposal'] : [])) : ''
const status = questions.length ? 'needs_input'
  : !lint ? 'lint_failed'
  : lintErrors ? 'lint_errors'
  : (unclean.length || proposals.some(p => p.failed) || !consistencyOk) ? 'proposals_need_attention'
  : 'ready'
log(`Status: ${status}`)
const unpushed = checkpoints.some(c => !c.pushed)
return {
  status,
  ...(questions.length ? { questions, relay: relay(resumeFrom, askedMilestones(questions), failedMs), ...(resumeFrom ? { resume_from: resumeFrom } : {}) } : {}),
  ...(attention.length ? { also_needs_attention: attention } : {}),
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
  not_proposed: notProposed.map(m => ({ milestone: m.n, title: m.title, doc: m.proposal })),
  deferred_findings: BRIEF_MODE ? undefined : deferredAll,
  consistency,
  lint,
  next_steps: [
    questions.length ? `First answer the ${questions.length} question(s) in questions (see relay): the docs that raised them are unwritten or unrevised, and the Consistency phase waits on them.` : null,
    attention.length ? `Answering the questions fixes none of also_needs_attention (${attention.map(a => `milestone ${a.milestone}: ${a.reason}`).join('; ')}). The re-run the relay names writes the proposals that failed and keeps the others as they are: ` +
      `after it, run the refresh-proposal workflow with ${REFRESH_ARGS} on each proposal that still has findings, before accepting it.` : null,
    // The relay of a needs_input result carries the same note.
    !questions.length && seedNote() ? seedNote().trim() : null,
    BRANCH ? `The docs, the seeded .claude files and CLAUDE.md are committed on ${BRANCH}${unpushed ? `; a checkpoint did not reach origin (branch.checkpoints says why): push ${BRANCH} once that is fixed` : ', pushed to origin'}. ` +
      `Edit and accept the docs on that branch; a re-run with the same args, from this clone or a fresh one, checks the branch out and picks up the docs where they stand.` : null,
    // On its own line, branch or not: a finished force run regenerated the docs, and every re-run a later step names would do it again.
    forceNote() ? forceNote().trim() : null,
    NO_SAVE_NOTE ? NO_SAVE_NOTE.trim() : null,
    !lint || ASSUMED.length || unconfirmed.length || proposedValues.length
      ? `Before a doc is accepted, show the person this result's assumptions (${ASSUMED.length}), lint.unconfirmed (${lint ? unconfirmed.length : 'not read: the lint failed'} decision(s) no person confirmed${named ? `: ${named}` : ''}) ` +
        `and lint.proposed (${lint ? proposedValues.length : 'not read'} value(s) an author proposed), and ask them to confirm or correct each. ` +
        // Confirmed as it stands: one edit of the tag, no re-run (a revise would reset the doc to draft for nothing).
        `A decision they confirm as it stands needs no re-run: its heading tag becomes (person, <today's date>, edit); the person changes it while accepting the doc, or you make that one-line edit when they say so (the tag only, never the Choice or any other text). ` +
        `A decision, an assumption or a proposed value they change goes back as an answer, its question naming the decision by title and its number the next one not yet in use (${ID_RULE}): ` +
        (BRIEF_MODE
          ? `architecture.d<N> (${freeD('architecture')} now) for what the architecture or the roadmap says, m<N>.d<K> for milestone N's proposal. Pass it to the refresh-proposal workflow on the one doc, or to a re-run of this workflow with the same args${forceNote() ? ', without force,' : ''} and from set to that stage: ` +
            `from: 'architecture' with max_milestones: 0 for the architecture or the roadmap, so the re-run writes no further proposal; from: 'proposals' with milestones: [N] for a proposal, which is written again as a draft`
          : `proposal.d<N> (${freeD('proposal')} now). Pass it to the refresh-proposal workflow on the doc, or to a re-run of this workflow, which writes the proposal again`) +
        `; the revise tags the decision (person, <date>, <id>). A confirmation may be passed as an answer the same way when such a re-run happens anyway.`
      : null,
    'Read and edit the docs. They are drafts (Status: draft): set Status: accepted on each one you approve; nothing is built or bootstrapped from a draft.',
    // Every proposal was written against today's tree, which the earlier milestones will change before the later ones build.
    laterDocs.length ? `Accept the proposals one milestone at a time, in roadmap order. Before accepting each one after the first (${laterDocs.join(', ')}), once the milestones before it have merged, ` +
      `run the refresh-proposal workflow with ${REFRESH_ARGS} on it (/review-proposal against the tree as it is then, and /propose --revise on its findings, until clean): a Files: list or interface the earlier milestones changed is a review concern then, not a stalled lane later.` +
      (MAX_M !== null ? '' : ` For a long roadmap, run with max_milestones: 1 instead and write each later proposal when its milestone comes up: a re-run with from: 'proposals' writes the ones not written yet.`) : null,
    `Do every research or decision gate the docs list that blocks design choices, record its Outcome, and run the refresh-proposal workflow with ${REFRESH_ARGS} on the docs whose steps depend on it.`,
    arch ? (BRANCH
      ? `Greenfield: once the docs are accepted, land ${BRANCH} on main through a PR (it holds only design docs, the pipeline's .claude files and CLAUDE.md, so main stays greenfield): /bootstrap cuts its branch from origin/main and would leave docs committed only on ${BRANCH} behind. ` +
        `Then run the bootstrap-repo workflow with { architecture: '${arch.architecture}', dir: '${DIR}' } (/bootstrap makes one commit on a bootstrap/<date> branch cut from origin/main, and plan-to-merged-pr ship-only opens its PR) and merge the PR, protect main and require the CI check; once that PR has merged and CI is green on main, add the bootstrap milestone's Outcome (CI green at <sha>; main protected), tick it (${LINT} ${arch.roadmap} --tick <n>) and land that through a docs PR.`
      : `Greenfield: run the bootstrap-repo workflow with { architecture: '${arch.architecture}', dir: '${DIR}' } (/bootstrap makes one commit, holding the docs too, on a bootstrap/<date> branch, and plan-to-merged-pr ship-only opens its PR) and merge the PR (an empty remote gets the root commit on local main instead, which you push), protect main and require the CI check; once that PR has merged and CI is green on main, add the bootstrap milestone's Outcome (CI green at <sha>; main protected), tick it (${LINT} ${arch.roadmap} --tick <n>) and land that through a docs PR.`) : null,
    BRANCH
      ? `Existing repo: land the accepted docs, the seeded pipeline files and the CLAUDE.md changes through a PR from ${BRANCH} (/create-pr; they are committed there already), and merge it — lanes are cut from origin and read the proposal and the commands there.`
      : 'Existing repo: land the seeded pipeline files, the CLAUDE.md changes and the accepted docs through an ordinary PR (commit them on a branch, /create-pr, merge) — lanes are cut from origin and read the proposal and the commands there.',
    // The pending milestones this run left without a proposal: nothing else in the result says how they get one.
    BRIEF_MODE && notProposed.length
      ? `No proposal is written yet for ${notProposed.length === 1 ? 'milestone' : 'milestones'} ${notProposed.map(m => `${m.n} ("${m.title}")`).join(', ')} (not_proposed). ` +
        (propDocs.length ? `Write each one when its milestone comes up, once the milestones before it have merged` : `Write the first once the person has confirmed the architecture and the roadmap, and each later one when its milestone comes up`) +
        `: re-run this workflow with the same args${forceNote() ? ', without force,' : ''} and from: 'proposals', with milestones: [N] (now [${notProposed[0].n}])` +
        (SAVE ? `, which restores the person's saved answers; a bare /propose --milestone=N does not get them.` : `.`)
      : null,
    propDocs.length
      ? `Build each proposal when its roadmap dependencies are done: proposal-build-chain { proposal: '<doc>', dir: '<checkout>', root: '<worktrees dir>', date: '<YYYYMMDD>' }.`
      : null,
    'Do every human-gated step yourself and tick it; lanes that depend on one stay blocked until it is ticked.',
  ].filter(Boolean),
}

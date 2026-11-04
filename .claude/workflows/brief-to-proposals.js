export const meta = {
  name: 'brief-to-proposals',
  description: 'Turn a product brief (or one change too big for a PR) into reviewed design docs: architecture panel, /roadmap, /propose per milestone, /review-proposal and revise until clean, cross-doc consistency, then lint and lanes. Writes docs only: no code, no commits',
  whenToUse: 'Before building a new product or a change too big for one PR. It writes the architecture, roadmap and proposals that /bootstrap and proposal-build-chain consume. See the pipeline README.',
  phases: [
    { title: 'Architecture', detail: 'independent sketches and a judge, then /roadmap writes architecture.md and roadmap.md, reviewed until clean' },
    { title: 'Proposals', detail: '/propose per roadmap milestone, then /review-proposal and /propose --revise until clean' },
    { title: 'Consistency', detail: 'one pass over every doc for cross-doc conflicts and coverage of the source' },
    { title: 'Lint', detail: 'proposal-lint.py on every doc, lanes per proposal, roadmap progress' },
  ],
}

// args:
//   brief?: string            path of a product brief (relative to dir, or absolute): brief mode
//   concern?: string          one change too big for one PR, or a structural class: concern mode (one proposal, no roadmap)
//   dir: string               absolute path of the project directory (may be a fresh, empty repo)
//   out?: string              proposals directory relative to dir (default: PROPOSALS_DIR from the Pipeline config, else docs/design)
//   context?: string          extra framing for every author (builder, budget, constraints the source does not state)
//   panel?: number            independent architecture sketches before /roadmap (default 3; 0 = skip the panel)
//   milestones?: number[]     propose only these roadmap milestones (default: every pending milestone that names a proposal)
//   max_milestones?: number   propose at most the first N of those, in roadmap order (e.g. 1 to try the flow on one milestone)
//   force?: boolean           let /roadmap overwrite an existing architecture.md / roadmap.md (default false)
//   max_review_rounds?: number  revise rounds per doc (default 3)
//   efforts?: { sketch, judge, roadmap, propose, review, revise, consistency, lint }
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
const EFF = { sketch: 'medium', judge: 'high', roadmap: 'high', propose: 'medium', review: 'high', revise: 'medium', consistency: 'high', lint: 'low', ...(A.efforts || {}) }
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
const WORK = GUARD + WHERE + DOCS_ONLY
const SOURCE = BRIEF_MODE ? `the product brief ${A.brief}` : `the concern ${JSON.stringify(A.concern)}`
const LINT = `python3 .claude/scripts/proposal-lint.py`

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
  },
  required: ['summary', 'declined', 'lint_clean'],
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
    notes: { type: 'string' },
  },
  required: ['out_dir', 'architecture', 'roadmap', 'milestones', 'lint_clean'],
}
const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: 'path of the proposal written, relative to the project directory' },
    steps: { type: 'integer', description: 'number of steps' },
    human_gates: { type: 'integer', description: 'number of human-gated steps' },
    lint_clean: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['doc', 'steps', 'human_gates', 'lint_clean'],
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
      items: { type: 'object', properties: { doc: { type: 'string' }, chains: { type: 'integer' }, lanes: { type: 'integer' }, blocked: { type: 'integer' }, human_gates_pending: { type: 'integer' } }, required: ['doc', 'chains', 'lanes', 'blocked', 'human_gates_pending'] },
    },
    next_milestones: { type: 'array', items: { type: 'string' }, description: 'from --roadmap: the next actionable milestones' },
  },
  required: ['docs', 'lanes', 'next_milestones'],
}
const blocking = list => list.filter(f => f.severity === 'bug' || f.severity === 'concern')

// Review docs with /review-proposal and revise with /propose --revise until no bug or concern remains.
// Same shape as plan-to-merged-pr's review loop: suggestions and nits get one revise round, defects block.
async function reviewLoop(docs, frame, label, ph) {
  const history = []
  let fixes = 0, findings = [], clean = false, reviewed = true
  for (let round = 1; ; round++) {
    const review = await agent(
      WORK + `Invoke the Skill tool with skill "review-proposal" once for each of these docs: ${docs.join(', ')}. ${frame}` +
      `Report every finding (bug/concern/suggestion/nit) with the doc it is about, verified against the docs, ${SOURCE} and the tree. Do not edit files. ` +
      `Set completed=false if the skill stopped without reviewing every doc (an empty findings list must mean a real, clean review).` +
      (history.length ? `\nEarlier rounds and what the reviser did (confirm each is resolved; do not re-report revised items or ones validly declined):\n${JSON.stringify(history, null, 1)}` : ''),
      opts(`review:${label}-${round}`, ph, 'review', REVIEW_SCHEMA),
    )
    if (!review || review.completed === false) { reviewed = false; break }
    findings = review.findings
    const defects = blocking(findings)
    log(`${label} review ${round}: ${findings.length} findings, ${defects.length} blocking`)
    if (!defects.length && (!findings.length || fixes >= 1)) { clean = true; break }
    if (fixes >= MAX_REVIEW) break
    const fix = await agent(
      WORK + CTX + `For each doc with findings below, invoke the Skill tool with skill "propose" with args "--revise <doc>", applying these findings; ` +
      `decline any you can verify is wrong and give the reason. Edit only the docs the findings name. Re-run ${LINT} on each revised doc until it reports no errors.\n` +
      JSON.stringify(findings, null, 2),
      opts(`revise:${label}-${round}`, ph, 'revise', REVISE_SCHEMA),
    )
    if (!fix) { reviewed = false; break }
    fixes++
    history.push({ round, findings, revised: fix.summary, declined: fix.declined })
  }
  return { docs, clean, reviewed, revise_rounds: fixes, findings_remaining: clean ? findings.filter(f => !blocking([f]).length) : findings }
}

let arch = null, judged = null, archReview = null
const proposals = []

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
        GUARD + WHERE + CTX + `Read ${SOURCE} in full, and the existing tree in ${DIR} if it has code. Sketch an architecture for it from this angle — ${angle.text} ` +
        `Cover components and technologies, data flow, the major decisions with the options you weighed, security and privacy, how it is deployed and operated ` +
        `(environments, CI/CD, secrets, migrations, monitoring, rollback, release gates such as legal review or store submission), ordered milestones with exit criteria ` +
        `(mark the ones a person must do), the assumptions the design rests on that nobody has verified, and your sketch's weaknesses. ` +
        `Read-only: write no files. Ground every claim about the source in its text.`,
        opts(`sketch:${angle.key}${i >= ANGLES.length ? `-${i}` : ''}`, 'Architecture', 'sketch', SKETCH_SCHEMA),
      ).then(s => s && { angle: angle.key + (i >= ANGLES.length ? `-${i}` : ''), ...s })
    }))).filter(Boolean)
    if (sketches.length) {
      judged = await agent(
        GUARD + WHERE + CTX + `Judge these independent architecture sketches for ${SOURCE} (read it in full first). Score each 1-5 on: fit to the source's constraints ` +
        `(builder, budget, timeline, licence, revenue model), time to the first validation, security and privacy, operability and cost, simplicity, and room to grow; ` +
        `total the scores. Then write the synthesis to build on: the winner, with any clearly better idea from the others grafted in, naming what came from where and why. ` +
        `Keep every decision with its options and choice. Read-only: write no files.\n\nSKETCHES:\n${JSON.stringify(sketches, null, 1)}`,
        opts('judge', 'Architecture', 'judge', JUDGE_SCHEMA),
      )
      if (judged) log(`Architecture panel: ${judged.scores.map(s => `${s.sketch} ${s.total}`).join(', ')}; building on ${judged.winner}`)
    }
  }
  arch = await agent(
    WORK + CTX + `Invoke the Skill tool with skill "roadmap" with args ${JSON.stringify(`${A.brief}${OUT_FLAG}${A.force ? ' --force' : ''}`)}. ` +
    (judged ? `Build on this architecture synthesis from an independent panel (a strong input, not a substitute for reading the source; where it contradicts the source, the source wins and you say so):\n${judged.synthesis}\n` : '') +
    `Then run ${LINT} <roadmap> --roadmap --json and return the milestones from it, with the paths of architecture.md and roadmap.md relative to ${DIR}.`,
    opts('roadmap', 'Architecture', 'roadmap', ROADMAP_SCHEMA),
  )
  if (!arch) return { status: 'failed_at_roadmap', panel: judged }
  log(`Wrote ${arch.architecture} and ${arch.roadmap}: ${arch.milestones.length} milestones`)
  archReview = await reviewLoop(
    [arch.architecture, arch.roadmap],
    `These are the architecture and roadmap for ${SOURCE}: judge them against the source (every requirement, constraint, risk and validation step it states), ` +
    `for sound decisions, a deploy and operations plan, and milestones in an order that validates the riskiest assumptions first with every person-only step as a human gate. `,
    'architecture', 'Architecture',
  )
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
  if (fresh) arch = fresh

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
      WORK + CTX + `Invoke the Skill tool with skill "propose" with args ${JSON.stringify(`--milestone=${m.n} ${arch.roadmap}${OUT_FLAG}`)}. ` +
      `Other milestones' proposals may be written at the same time: reference another proposal's step in Depends on only if that file exists now; ` +
      `ordering between milestones is the roadmap's job. Return the proposal path relative to ${DIR}.`,
      opts(`propose:m${m.n}`, 'Proposals', 'propose', PROPOSE_SCHEMA),
    ),
    (p, m) => p
      ? reviewLoop(
        [p.doc],
        `This proposal implements milestone ${m.n} ("${m.title}") of ${arch.roadmap}; judge it against that milestone's scope and exit criteria, ${arch.architecture}, and ${SOURCE}. `,
        `m${m.n}`, 'Proposals',
      ).then(r => ({ milestone: m.n, title: m.title, ...p, review: r }))
      : { milestone: m.n, title: m.title, doc: m.proposal, failed: true },
  )
  proposals.push(...results.filter(Boolean))
} else {
  // ---- Concern mode: one proposal, reviewed until clean
  phase('Proposals')
  const p = await agent(
    WORK + CTX + `Invoke the Skill tool with skill "propose" with the concern below as args${A.out ? ` (prefix them with --out=${A.out})` : ''}. ` +
    `Rewrite any --prefixed token inside the concern text (e.g. "--json" -> "the json flag") so the skill never reads it as one of its own flags. ` +
    `Return the proposal path relative to ${DIR}.\n${JSON.stringify(A.concern)}`,
    opts('propose', 'Proposals', 'propose', PROPOSE_SCHEMA),
  )
  if (!p) return { status: 'failed_at_propose' }
  const r = await reviewLoop([p.doc], `This proposal is for ${SOURCE}; judge it against that concern and today's tree. `, 'proposal', 'Proposals')
  proposals.push({ ...p, review: r })
}

const written = proposals.filter(p => !p.failed)
const allDocs = (arch ? [arch.architecture, arch.roadmap] : []).concat(written.map(p => p.doc))

// ---- Consistency: needs every doc at once (barrier), then one revise per affected doc
let consistency = null
if (BRIEF_MODE && written.length) {
  phase('Consistency')
  consistency = await agent(
    WORK + `Read ${SOURCE}, then every one of these docs in full: ${allDocs.join(', ')}. Report cross-doc problems: interfaces, data models or names that disagree; ` +
    `work planned twice or by no doc; a proposal that contradicts a decision in ${arch.architecture}; Depends on references that point at the wrong step; ` +
    `milestone order that builds on something not yet built or validated; parts of the source no doc plans for (coverage_gaps). ` +
    `Each finding names the ONE doc that should change. Read-only: write no files.`,
    opts('consistency', 'Consistency', 'consistency', CONSISTENCY_SCHEMA),
  )
  if (consistency) {
    const bad = blocking(consistency.findings)
    log(`Consistency: ${consistency.findings.length} findings (${bad.length} blocking), ${consistency.coverage_gaps.length} coverage gaps`)
    const byDoc = {}
    for (const f of bad) (byDoc[f.doc] = byDoc[f.doc] || []).push(f)
    const fixes = await parallel(Object.keys(byDoc).map((doc, i) => () => agent(
      WORK + CTX + `Invoke the Skill tool with skill "propose" with args "--revise ${doc}", applying these cross-doc findings; decline any you can verify is wrong and give the reason. ` +
      `Edit only ${doc}. Re-run ${LINT} ${doc} until it reports no errors.\n${JSON.stringify(byDoc[doc], null, 2)}`,
      opts(`revise:consistency-${i + 1}`, 'Consistency', 'revise', REVISE_SCHEMA),
    ).then(r => ({ doc, ...(r || { failed: true }) }))))
    consistency.revisions = fixes.filter(Boolean)
  }
}

// ---- Lint: the deterministic gate on every doc, plus lane derivation and roadmap progress
phase('Lint')
const lint = await agent(
  GUARD + WHERE + `In ${DIR}, run ${LINT} <doc> --json on each of: ${allDocs.join(', ')}; run ${LINT} <doc> --lanes on each proposal` +
  (arch ? `; and ${LINT} ${arch.roadmap} --roadmap --json` : '') + `. Report per doc the error and warning counts and their messages, ` +
  `per proposal the number of chains, lanes, blocked lanes and pending human gates, and the next actionable milestones. Change nothing.`,
  opts('lint', 'Lint', 'lint', LINT_SCHEMA),
)
const lintErrors = lint ? lint.docs.reduce((n, d) => n + d.errors, 0) : null
const unclean = written.filter(p => !p.review || !p.review.clean)

const status = !lint ? 'lint_failed'
  : lintErrors ? 'lint_errors'
  : (unclean.length || proposals.some(p => p.failed)) ? 'proposals_need_attention'
  : 'ready'
log(`Status: ${status}`)
return {
  status,
  out_dir: arch ? arch.out_dir : null,
  architecture: arch ? arch.architecture : null,
  roadmap: arch ? arch.roadmap : null,
  panel: judged ? { winner: judged.winner, scores: judged.scores } : null,
  architecture_review: archReview,
  proposals: proposals.map(p => ({ milestone: p.milestone, title: p.title, doc: p.doc, failed: !!p.failed, clean: !!(p.review && p.review.clean), findings_remaining: p.review ? p.review.findings_remaining : null })),
  consistency,
  lint,
  next_steps: [
    'Read and edit the docs. They are drafts (Status: draft): set Status: accepted on each one you approve; nothing is built or bootstrapped from a draft.',
    'Do every research or decision gate the docs list that blocks design choices, record its Outcome, and run /propose --revise <doc> on the docs whose steps depend on it.',
    arch ? `Greenfield: run /bootstrap ${arch.architecture} (it includes the docs in the root commit), review the commit, push main yourself, protect it and require the CI check; then tick the bootstrap milestone (${LINT} ${arch.roadmap} --tick <n>).` : null,
    'Existing repo: land the docs through an ordinary docs PR (commit them on a branch, /create-pr, merge) — lanes are cut from origin and read the proposal there.',
    `Build each proposal when its roadmap dependencies are done: proposal-build-chain { proposal: '<doc>', dir: '<checkout>', root: '<worktrees dir>', date: '<YYYYMMDD>' }.`,
    'Do every human-gated step yourself and tick it; lanes that depend on one stay blocked until it is ticked.',
  ].filter(Boolean),
}

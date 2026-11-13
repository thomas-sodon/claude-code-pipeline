// Behavioural tests for brief-to-proposals' resumable design: where a run starts (args.from, or inferred from the answers and
// the docs on disk), what it keeps, its checkpoints on a design branch, the panel synthesis and the person's answers kept on
// the state branch, the pairwise Consistency phase, the context file, and how the run asks the person instead of choosing for
// them (the judge's questions, answers applied to existing docs, what nobody confirmed, the Intake's assumptions kept with the
// answers, answer ids that are never reused, the milestones left without a proposal). The workflow body runs against
// scripted mock agents: a responder picks the reply by the agent's label, and every prompt and log line is recorded so the tests
// can check which stages ran and what each was told.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = process.argv[2] || '.claude/workflows'
const AsyncFunction = (async () => {}).constructor

// A schema-shaped default reply: every required field present, empty or false.
function blank(schema) {
  const out = {}
  for (const k of (schema && schema.required) || []) {
    const t = (schema.properties[k] || {}).type
    out[k] = t === 'boolean' ? false : t === 'integer' || t === 'number' ? 0 : t === 'array' ? [] : t === 'object' ? {} : ''
  }
  return out
}

async function run(name, args, respond, { workflow } = {}) {
  const src = readFileSync(join(dir, `${name}.js`), 'utf8').replace(/^export const meta = /m, 'const meta = ')
  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ label: opts.label, prompt })
    const r = respond(opts.label || '', prompt)
    if (r === null) return null
    return opts.schema ? { ...blank(opts.schema), ...(r || {}) } : (r || '')
  }
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (it, i) => {
    let v = it
    try { for (const st of stages) v = await st(v, it, i) } catch { return null }
    return v
  }))
  const logs = []
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'workflow', 'phase', 'log', src)(
    args, agent, parallel, pipeline, workflow || (async () => { throw new Error('no nested workflow in this test') }), () => {}, m => { logs.push(String(m)) })
  const labels = calls.map(c => c.label)
  return { result, calls, labels, logs, prompt: label => (calls.find(c => c.label === label) || {}).prompt || '' }
}

const Q = { question: 'Should alerts go by email or by SMS?', why: 'SMS needs a paid provider', options: ['email', 'SMS'], recommended: 'email' }
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`) }
}

// ---- A design on disk: a Bootstrap gate, two code milestones written (2, 3), a go/no-go gate (4), a third code milestone not
// yet written (5) that builds on 3 through the gate, and a release milestone (6).
const M = (n, title, extra) => ({ n, title, done: false, human_gate: '', proposal: '', proposal_exists: false, depends: [], ...extra })
const MILESTONES = [
  M(1, 'Bootstrap', { human_gate: 'ops' }),
  M(2, 'Import', { proposal: 'docs/design/01-import.md', proposal_exists: true, depends: [1] }),
  M(3, 'Match', { proposal: 'docs/design/02-match.md', proposal_exists: true, depends: [2] }),
  M(4, 'Go / no-go', { human_gate: 'decision', depends: [3] }),
  M(5, 'Alerts', { proposal: 'docs/design/03-alerts.md', depends: [4] }),
  M(6, 'Launch', { human_gate: 'release', depends: [5] }),
]
const PATH = { brief: 'docs/brief.md', arch: 'docs/design/architecture.md', roadmap: 'docs/design/roadmap.md', m2: 'docs/design/01-import.md', m3: 'docs/design/02-match.md', m5: 'docs/design/03-alerts.md' }
const ON_DISK = { brief_exists: true, out_dir: 'docs/design', architecture: PATH.arch, roadmap: PATH.roadmap, architecture_exists: true, roadmap_exists: true, milestones: MILESTONES, panel_synthesis: false, context_exists: true }
const NO_DOCS = { ...ON_DISK, architecture_exists: false, roadmap_exists: false, milestones: [] }
const WRITTEN = { out_dir: 'docs/design', architecture: PATH.arch, roadmap: PATH.roadmap, lint_clean: true, milestones: MILESTONES.map(m => ({ ...m, proposal_exists: false })) }
const SYNTHESIS = 'SYNTHESIS-TEXT: a validation-first architecture'

const design = (over = {}, disk = ON_DISK) => (label, prompt) => {
  if (over[label] !== undefined) return typeof over[label] === 'function' ? over[label](prompt) : over[label]
  if (label === 'branch') return { branch: 'design/20261110', action: 'created', head: 'abc1234567', recovered: [] }
  if (label === 'seed') return { copied: 1, claude_md: 'written' }
  if (label === 'existing-docs') return disk
  if (label === 'context-check') return { context_exists: true, context_restored: false }
  if (label === 'roadmap') return WRITTEN
  if (label === 'milestones') return disk.architecture_exists ? { ...WRITTEN, milestones: disk.milestones } : WRITTEN
  if (label === 'judge') return { scores: [{ sketch: 'validate-first', total: 26, notes: '' }], winner: 'validate-first', synthesis: SYNTHESIS }
  if (label === 'save-panel') return { saved: true, commit: 'feed123456' }
  if (label.startsWith('propose:m')) return { doc: MILESTONES.find(m => m.n === Number(label.slice(9))).proposal, steps: 3, lint_clean: true }
  if (label.startsWith('review:')) return { findings: [], completed: true }
  if (label.startsWith('consistency:')) return { findings: [], coverage_gaps: [] }
  if (label.startsWith('checkpoint:')) return { committed: true, commit: 'c0ffee1234', pushed: true, files: [] }
  if (label === 'lint') return { docs: [], lanes: [], next_milestones: [] }
  return {}
}
const BRIEF = { brief: 'docs/brief.md', dir: '/abs/p', panel: 0 }
const WF = 'brief-to-proposals'
const DESIGN_AGENTS = /^(intake|sketch:|judge|save-panel|roadmap$|review:architecture|revise:architecture|milestones$)/
const proposed = labels => labels.filter(l => l.startsWith('propose:')).sort()

await test('brief-to-proposals: from is inferred from the answers\' ids but the Intake\'s once the docs exist, else it is the Intake', async () => {
  const cases = [
    [[], 'proposals'],
    [[{ id: 'm3.q1', answer: 'A3' }], 'proposals'],
    [[{ id: 'architecture.q1', answer: 'AA' }], 'architecture'],
    [[{ id: 'consistency.q1', answer: 'AC' }], 'consistency'],
    [[{ id: 'consistency.q1', answer: 'AC' }, { id: 'm3.q2', answer: 'A3' }], 'proposals'],
    // The docs were written after every intake answer, so one never sends the run back to the Intake ...
    [[{ id: 'intake.q1', answer: 'AI' }, { id: 'm3.q1', answer: 'A3' }], 'proposals'],
    [[{ id: 'intake.q1', answer: 'AI' }], 'proposals'],
    // ... while an architecture answer still counts: a reviser of the existing docs may have asked it.
    [[{ id: 'intake.q1', answer: 'AI' }, { id: 'architecture.q1', answer: 'AA' }, { id: 'm3.q1', answer: 'A3' }], 'architecture'],
  ]
  for (const [answers, from] of cases) {
    const { result } = await run(WF, { ...BRIEF, answers }, design())
    assert.equal(result.from, from, JSON.stringify(answers))
    assert.equal(result.status, 'ready', JSON.stringify(answers))
  }
  // An architecture answer resumes the review of the docs on disk with the answer; /roadmap is not re-run.
  const archA = await run(WF, { ...BRIEF, answers: [{ id: 'architecture.q1', answer: 'ANSWER-ARCH' }] }, design())
  assert.ok(!archA.labels.some(l => /^(intake|roadmap)$/.test(l)), archA.labels.join(' '))
  assert.match(archA.prompt('revise:architecture-1') || archA.prompt('review:architecture-1'), /ANSWER-ARCH/)
  assert.deepEqual(proposed(archA.labels), ['propose:m5'], 'only the proposal not written yet')
  // A consistency answer re-runs only the Consistency phase, and every pair gets it.
  const conA = await run(WF, { ...BRIEF, answers: [{ id: 'consistency.q1', answer: 'ANSWER-CON' }] }, design())
  assert.ok(!conA.labels.some(l => DESIGN_AGENTS.test(l) || l.startsWith('propose:') || l.startsWith('review:m')), conA.labels.join(' '))
  for (const l of conA.labels.filter(x => x.startsWith('consistency:'))) assert.match(conA.prompt(l), /ANSWER-CON/, l)
  // An intake answer among them starts no Intake and no architecture review, and every stage that runs still gets it.
  const intakeA = await run(WF, { ...BRIEF, answers: [{ id: 'intake.q1', answer: 'ANSWER-INTAKE' }, { id: 'm3.q1', answer: 'A3' }] }, design())
  assert.ok(!intakeA.labels.some(l => DESIGN_AGENTS.test(l)), intakeA.labels.join(' '))
  assert.deepEqual(proposed(intakeA.labels), ['propose:m5'])
  for (const l of ['propose:m5', 'review:m5-1', 'consistency:arch-m2']) assert.match(intakeA.prompt(l), /ANSWER-INTAKE/, l)
  // An explicit from: 'intake' still runs the Intake, which never rewrites the docs on disk.
  const intakeFrom = await run(WF, { ...BRIEF, from: 'intake', answers: [{ id: 'intake.q1', answer: 'AI' }, { id: 'm3.q1', answer: 'A3' }] }, design())
  assert.equal(intakeFrom.result.from, 'intake')
  assert.ok(intakeFrom.labels.includes('intake') && intakeFrom.labels.includes('review:architecture-1'))
  assert.ok(!intakeFrom.labels.includes('roadmap'))
  assert.deepEqual(proposed(intakeFrom.labels), ['propose:m5'])
  // No docs on disk: the Intake, whatever the answers say, and /roadmap writes them.
  const fresh = await run(WF, { ...BRIEF, answers: [{ id: 'architecture.q1', answer: 'AA' }] }, design({}, NO_DOCS))
  assert.equal(fresh.result.from, 'intake')
  assert.ok(fresh.labels.includes('intake') && fresh.labels.includes('roadmap'))
  assert.deepEqual(proposed(fresh.labels), ['propose:m2', 'propose:m3', 'propose:m5'], 'docs written by this run get every proposal')
  // The existing-docs prompt names the answers and from, so a resumed run with new ones looks at the disk again.
  const before = (await run(WF, BRIEF, design())).prompt('existing-docs')
  assert.notEqual(archA.prompt('existing-docs'), before)
  assert.match(archA.prompt('existing-docs'), /architecture\.q1/)
  assert.notEqual((await run(WF, { ...BRIEF, from: 'lint' }, design())).prompt('existing-docs'), before)
})

await test('brief-to-proposals: from proposals runs no intake, panel or roadmap agent and proposes only the missing or listed milestones', async () => {
  const { result, labels, prompt } = await run(WF, { ...BRIEF, panel: 3, from: 'proposals', answers: [{ id: 'm3.q1', answer: 'ANSWER-M3' }] }, design())
  for (const l of labels) assert.doesNotMatch(l, DESIGN_AGENTS)
  assert.deepEqual(proposed(labels), ['propose:m5'], 'an answer alone re-proposes no written proposal')
  assert.match(prompt('consistency:arch-m3'), /ANSWER-M3/)
  // In brief mode a milestone's answer reaches its siblings too, with how to read an answer another stage asked.
  for (const l of ['propose:m5', 'review:m5-1']) {
    assert.match(prompt(l), /ANSWER-M3/, l)
    assert.match(prompt(l), /the first part of each id names the stage that asked \(intake, architecture, m<N> for milestone N's proposal, consistency\): an answer asked elsewhere binds here wherever the same choice arises, and one plainly about another doc's detail does not/, l)
  }
  assert.equal(result.status, 'ready')
  assert.equal(result.from, 'proposals')
  assert.deepEqual(result.kept, [{ milestone: 2, title: 'Import', doc: PATH.m2 }, { milestone: 3, title: 'Match', doc: PATH.m3 }])
  assert.deepEqual(result.proposals.map(p => p.milestone).sort(), [5])
  // The kept proposals still take part in Consistency and Lint.
  assert.ok(labels.includes('consistency:arch-m2'))
  assert.ok(prompt('lint').includes(PATH.m2))
  // args.milestones names exactly the milestones to propose, written or not.
  const only = await run(WF, { ...BRIEF, from: 'proposals', milestones: [2] }, design())
  assert.deepEqual(proposed(only.labels), ['propose:m2'])
  assert.deepEqual(only.result.kept.map(k => k.milestone), [3])
  // Nothing answered and everything written: nothing is proposed, and the docs are still checked and linted.
  const done = await run(WF, { ...BRIEF, from: 'proposals' }, design({}, { ...ON_DISK, milestones: MILESTONES.map(m => ({ ...m, proposal_exists: !!m.proposal })) }))
  assert.deepEqual(proposed(done.labels), [])
  assert.ok(done.labels.includes('consistency:m3-m5') && done.labels.includes('lint'))
  // Without the docs, from proposals stops before any design agent runs.
  const none = await run(WF, { ...BRIEF, from: 'proposals' }, design({}, NO_DOCS))
  assert.equal(none.result.status, 'failed_at_start')
  assert.match(none.result.stop_reason, /^no_docs/)
  assert.deepEqual(none.labels, ['seed', 'existing-docs'])
  // from lint only lints the docs on disk.
  const lintOnly = await run(WF, { ...BRIEF, from: 'lint' }, design())
  assert.deepEqual(lintOnly.labels, ['seed', 'existing-docs', 'lint'])
  assert.ok([PATH.arch, PATH.roadmap, PATH.m2, PATH.m3].every(p => lintOnly.prompt('lint').includes(p)))
})

await test('brief-to-proposals: from architecture resumes the review of existing docs and skips /roadmap; without docs it reuses the saved panel', async () => {
  const { result, labels, prompt } = await run(WF, { ...BRIEF, panel: 3, from: 'architecture' }, design())
  assert.ok(!labels.some(l => l === 'intake' || l === 'roadmap' || l === 'judge' || l === 'save-panel' || l.startsWith('sketch:')), labels.join(' '))
  assert.ok(prompt('review:architecture-1').includes(`${PATH.arch}, ${PATH.roadmap}`))
  assert.ok(labels.indexOf('milestones') > labels.indexOf('review:architecture-1'), 'the milestones are re-read after the review')
  assert.deepEqual(proposed(labels), ['propose:m5'])
  assert.equal(result.status, 'ready')
  // A blocked review says where to resume, since an inferred re-run would go straight to the proposals.
  const blockedReview = await run(WF, { ...BRIEF, from: 'architecture', max_review_rounds: 1 }, design({
    'review:architecture-1': { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'no rollback plan' }], completed: true },
    'review:architecture-2': { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'no rollback plan' }], completed: true },
    'revise:architecture-1': { summary: 'tried' } }))
  assert.equal(blockedReview.result.status, 'blocked_at_architecture_review')
  assert.equal(blockedReview.result.resume_from, 'architecture')
  // No docs, a synthesis saved on the state branch: /roadmap builds on it, no new panel.
  const saved = await run(WF, { ...BRIEF, panel: 3, from: 'architecture' }, design({}, { ...NO_DOCS, panel_synthesis: true }))
  assert.ok(!saved.labels.some(l => l === 'intake' || l === 'judge' || l.startsWith('sketch:')), saved.labels.join(' '))
  assert.match(saved.prompt('existing-docs'), /pipeline-state\.py get design\/panel-synthesis\.md/)
  assert.match(saved.prompt('roadmap'), /pipeline-state\.py get design\/panel-synthesis\.md/)
  assert.doesNotMatch(saved.prompt('roadmap'), /--force/)
  assert.deepEqual(saved.result.panel, { reused: true })
  // No docs and none saved: a new panel, whose synthesis is saved before /roadmap builds on it.
  const unsaved = await run(WF, { ...BRIEF, panel: 3, from: 'architecture' }, design({}, NO_DOCS))
  assert.equal(unsaved.labels.filter(l => l.startsWith('sketch:')).length, 3)
  assert.ok(unsaved.labels.indexOf('save-panel') > unsaved.labels.indexOf('judge') && unsaved.labels.indexOf('save-panel') < unsaved.labels.indexOf('roadmap'))
  assert.match(unsaved.prompt('save-panel'), /pipeline-state\.py save <that file> --as design\/panel-synthesis\.md/)
  assert.match(unsaved.prompt('save-panel'), /Source: docs\/brief\.md/)
  assert.ok(unsaved.prompt('save-panel').includes(SYNTHESIS) && unsaved.prompt('roadmap').includes(SYNTHESIS))
  assert.deepEqual(unsaved.result.panel, { winner: 'validate-first', scores: [{ sketch: 'validate-first', total: 26, notes: '' }], saved: true })
  // The default fresh run saves its panel too, and asks for no saved one.
  const fresh = await run(WF, { ...BRIEF, panel: 3 }, design({}, NO_DOCS))
  assert.ok(fresh.labels.includes('save-panel'))
  assert.doesNotMatch(fresh.prompt('existing-docs'), /panel-synthesis/)
  // force regenerates from scratch even with docs on disk: the Intake, a new panel, /roadmap --force, every proposal.
  const forced = await run(WF, { ...BRIEF, panel: 3, force: true }, design())
  assert.equal(forced.result.from, 'intake')
  assert.ok(forced.labels.includes('intake') && forced.labels.includes('judge'))
  assert.match(forced.prompt('roadmap'), /--force/)
  assert.deepEqual(proposed(forced.labels), ['propose:m2', 'propose:m3', 'propose:m5'])
})

await test('brief-to-proposals: checkpoint agents appear only with branch, and their prompts never name the brief or the context file', async () => {
  const plain = await run(WF, { ...BRIEF, context_file: 'notes/builder.md' }, design({}, NO_DOCS))
  assert.ok(!plain.labels.some(l => l === 'branch' || l.startsWith('checkpoint:')), plain.labels.join(' '))
  assert.equal(plain.result.branch, undefined)
  const args = { ...BRIEF, branch: 'design/20261110', context: 'CTX-TEXT', context_file: 'notes/builder.md', github_access: 'connector', commit_trailers: ['Co-Authored-By: Someone <someone@example.com>'] }
  const { result, labels, prompt } = await run(WF, args, design({}, NO_DOCS))
  assert.deepEqual(labels.slice(0, 2), ['branch', 'seed'], 'the branch is checked out before seeding')
  const cps = labels.filter(l => l.startsWith('checkpoint:'))
  assert.deepEqual(cps, ['checkpoint:architecture', 'checkpoint:proposals', 'checkpoint:consistency'])
  const last = re => Math.max(...labels.map((l, i) => re.test(l) ? i : -1))
  assert.ok(labels.indexOf('checkpoint:architecture') > last(/^review:architecture/) && labels.indexOf('checkpoint:architecture') < labels.indexOf('milestones'))
  assert.ok(labels.indexOf('checkpoint:proposals') > last(/^(propose|review):m/))
  assert.ok(labels.indexOf('checkpoint:consistency') > last(/^consistency:/) && labels.indexOf('checkpoint:consistency') < labels.indexOf('lint'))
  for (const l of ['branch', ...cps]) {
    const p = prompt(l)
    for (const secret of ['docs/brief.md', 'notes/builder.md', 'CTX-TEXT']) assert.ok(!p.includes(secret), `${l} names ${secret}`)
    assert.ok(p.includes('design/20261110'), l)
    assert.match(p, l === 'branch' ? /never rebase, reset or force\).*Never stash, discard, delete, clean or force anything/ : /Never force/, l)
    assert.match(p, /never commit on or push to any other branch, main above all|Never switch to, commit on or push main/, l)
    assert.match(p, /github-access\.md/, l)
    assert.match(p, /The access in use is connector/, l)
    assert.ok(p.includes('Co-Authored-By: Someone <someone@example.com>'), l)
  }
  assert.ok([PATH.arch, PATH.roadmap].every(d => prompt('checkpoint:architecture').includes(d)))
  assert.ok([PATH.m2, PATH.m3, PATH.m5].every(d => prompt('checkpoint:proposals').includes(d)))
  for (const s of ['.claude/workflows', '.claude/pipeline-manifest.json', 'CLAUDE.md', 'never git add -A']) assert.ok(prompt('checkpoint:proposals').includes(s), s)
  assert.deepEqual(result.branch.checkpoints.map(c => c.after), ['Architecture', 'Proposals', 'Consistency'])
  assert.equal(result.branch.name, 'design/20261110')
  assert.ok(result.next_steps.some(s => s.includes('committed on design/20261110')))
  // Kept out even when the brief sits in the proposals directory, or a doc path is the context file.
  const inside = await run(WF, { ...args, brief: 'docs/design/brief.md', context_file: PATH.m2 }, design({}, NO_DOCS))
  for (const l of cps) {
    assert.ok(!inside.prompt(l).includes('docs/design/brief.md'), l)
    assert.ok(!inside.prompt(l).includes(PATH.m2), l)
  }
  // The docs written so far are checkpointed before a needs_input stop in the architecture review.
  const asking = await run(WF, args, design({
    'review:architecture-1': { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'the brief is silent on X' }], completed: true },
    'revise:architecture-1': { questions: [Q] } }, NO_DOCS))
  assert.equal(asking.result.status, 'needs_input')
  assert.equal(asking.result.resume_from, 'architecture')
  assert.equal(asking.labels.at(-1), 'checkpoint:architecture')
  assert.match(asking.result.relay, /from: 'architecture'/)
  // Concern mode checkpoints its one proposal after the Proposals phase; it has no existing-docs stage.
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p', branch: 'design/20261110' }, design({ propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true } }))
  assert.deepEqual(concern.labels, ['branch', 'seed', 'intake', 'propose', 'review:proposal-1', 'checkpoint:proposals', 'lint'])
  assert.ok(concern.prompt('checkpoint:proposals').includes('docs/design/big-change.md'))
  assert.equal(concern.result.status, 'ready')
  // With no github_access arg, the access is the Pipeline config's, unset meaning what github-access.md says.
  for (const l of ['branch', 'checkpoint:proposals']) {
    assert.ok(concern.prompt(l).includes('GITHUB_ACCESS from the "## Pipeline config" section of CLAUDE.md: gh or connector (unset: gh when it is authenticated, else the GitHub MCP tools)'), l)
    assert.doesNotMatch(concern.prompt(l), /default gh/, l)
  }
  // A branch that cannot be checked out stops the run before anything is seeded.
  const blocked = await run(WF, args, design({ branch: { stopped: true, stop_reason: 'error=no_main' } }, NO_DOCS))
  assert.equal(blocked.result.status, 'failed_at_branch')
  assert.deepEqual(blocked.labels, ['branch'])
  // Never main, and never a brief or context file the checkpoints would stage.
  for (const b of ['main', 'master', 'origin/main', ' ']) await assert.rejects(run(WF, { ...BRIEF, branch: b }, design()), /never main/, b)
  await assert.rejects(run(WF, { ...args, context_file: '.claude/scripts/notes.md' }, design()), /checkpoints commit/)
})

await test('brief-to-proposals: the branch stage fetches origin\'s design branch by explicit refspec, so a single-branch clone continues it', async () => {
  const { prompt } = await run(WF, { ...BRIEF, branch: 'design/20261110' }, design({}, NO_DOCS))
  const p = prompt('branch')
  assert.ok(p.includes('3. git fetch origin, and when git ls-remote --heads origin design/20261110 lists it, ' +
    'git fetch origin +refs/heads/design/20261110:refs/remotes/origin/design/20261110 (a single-branch clone\'s plain fetch skips other branches'), p)
  assert.doesNotMatch(p, /3\. git fetch origin\. /, 'a plain fetch alone would leave origin/<branch> missing or stale')
  // A single-branch clone's git switch cannot guess the branch from that ref, so the switch names it.
  assert.ok(p.includes('git switch design/20261110, or with no local design/20261110 git switch -c design/20261110 origin/design/20261110'), p)
})

await test('brief-to-proposals: Consistency runs one agent per pair of docs, each naming only its two', async () => {
  const all = { ...ON_DISK, milestones: MILESTONES.map(m => ({ ...m, proposal_exists: !!m.proposal })) }
  const over = {
    'consistency:arch-m3': { findings: [{ doc: PATH.m3, severity: 'concern', description: 'uses a queue the architecture rules out' }] },
    'consistency:m3-m5': { findings: [{ doc: `/abs/p/${PATH.m5}`, severity: 'bug', description: 'reads a table 02 never creates' }, { doc: PATH.m3, severity: 'nit', description: 'wording' }] },
    'consistency:brief-roadmap': { findings: [], coverage_gaps: ['the CSV export the brief asks for'] },
  }
  const { result, labels, prompt, calls } = await run(WF, { ...BRIEF, from: 'consistency', answers: [{ id: 'consistency.q1', answer: 'ANSWER-C' }] }, design(over, all))
  const pairs = labels.filter(l => l.startsWith('consistency:'))
  assert.deepEqual(pairs.slice().sort(), ['consistency:arch-m2', 'consistency:arch-m3', 'consistency:arch-m5', 'consistency:brief-roadmap', 'consistency:m2-m3', 'consistency:m3-m5'])
  for (const l of pairs) {
    const named = l.slice('consistency:'.length).split('-')
    for (const [k, path] of Object.entries(PATH)) assert.equal(prompt(l).includes(path), named.includes(k), `${l} ${named.includes(k) ? 'names' : 'does not name'} ${path}`)
  }
  assert.match(prompt('consistency:arch-m5'), /release milestones: 6 \("Launch"\)/)
  assert.match(prompt('consistency:m3-m5'), /milestone 5 .* builds on milestone 3/)
  assert.match(prompt('consistency:brief-roadmap'), /coverage_gaps/)
  assert.doesNotMatch(prompt('consistency:arch-m2'), /coverage_gaps\)/)
  // Blocking findings and the coverage gap go to the doc each names, one reviser per doc; every revised doc is re-reviewed.
  const revisers = calls.filter(c => c.label.startsWith('revise:consistency-'))
  assert.deepEqual(revisers.map(c => c.prompt.match(/--revise (\S+)"/)[1]).sort(), [PATH.m3, PATH.m5, PATH.roadmap].sort())
  const gapReviser = revisers.find(c => c.prompt.includes(`--revise ${PATH.roadmap}`)).prompt
  assert.match(gapReviser, /Coverage gap: the CSV export the brief asks for\. Plan it in a milestone \(or the proposal that should hold it\)\. Leaving it out is the person's call, never yours/)
  assert.match(gapReviser, /otherwise, when you would not plan it, return it as a blocking question \(options: the milestone to plan it in, by title; defer it past the first release; drop it\), every such gap in one batch/)
  assert.doesNotMatch(gapReviser, /Out of scope/, 'a scope cut is never offered as a fix')
  // A part the person ruled out or deferred is no gap only once the roadmap says so: silent, it is reported, so the reviser records it.
  assert.match(prompt('consistency:brief-roadmap'), /A part of the brief that the person's framing or an answer replaces, rules out or defers is not a gap once the roadmap says so; where the roadmap is silent on it, report it as a gap and name the framing or the answer's id that settles it, so the roadmap records the person's choice\./)
  assert.match(gapReviser, /where the brief, the framing or an answer already rules it out or defers it, say so in the roadmap's paragraph on the ordering \(with the answer's id, when an answer does\)/)
  assert.doesNotMatch(revisers.find(c => c.prompt.includes(`--revise ${PATH.m3}`)).prompt, /wording/, 'a nit is not revised')
  assert.equal(labels.filter(l => /^review:recheck-\d+-1$/.test(l)).length, 3)
  assert.equal(result.consistency.pairs.length, 6)
  assert.ok(result.consistency.findings.every(f => f.pair))
  assert.equal(result.status, 'ready')
  // A finding a per-doc review raised about another doc goes to the pair of those two docs (made for it when none holds both).
  const deferred = await run(WF, { ...BRIEF, from: 'proposals' }, design({
    'review:m5-1': { findings: [
      { doc: PATH.m3, severity: 'concern', description: 'DEFERRED-M3: 02 must export the match table' },
      { doc: PATH.roadmap, severity: 'concern', description: 'DEFERRED-RM: milestone 5 should depend on 2' }], completed: true } }))
  assert.match(deferred.prompt('consistency:m3-m5'), /DEFERRED-M3/)
  assert.doesNotMatch(deferred.prompt('consistency:m3-m5'), /DEFERRED-RM/)
  assert.ok(deferred.labels.includes('consistency:m5-roadmap'))
  assert.match(deferred.prompt('consistency:m5-roadmap'), /DEFERRED-RM/)
  assert.ok([PATH.m5, PATH.roadmap].every(p => deferred.prompt('consistency:m5-roadmap').includes(p)))
  // A pair that fails to report leaves the run needing attention, and the other pairs' findings are still revised.
  const lost = await run(WF, { ...BRIEF, from: 'consistency' }, design({ ...over, 'consistency:arch-m2': null }, all))
  assert.equal(lost.result.status, 'proposals_need_attention')
  assert.ok(lost.labels.some(l => l.startsWith('revise:consistency-')))
  // The roadmap's reviser returns the gap as a question: the run stops for the person, and resumes at Consistency.
  const GAP_Q = { question: 'The brief asks for a CSV export and no milestone plans it: where does it go?', why: 'leaving it out changes what the first release promises', options: ['plan it in "Alerts"', 'defer it past the first release', 'drop it'], recommended: 'plan it in "Alerts"' }
  const gapAsked = await run(WF, { ...BRIEF, from: 'consistency' }, design({ 'consistency:brief-roadmap': over['consistency:brief-roadmap'], 'revise:consistency-1': { questions: [GAP_Q] } }, all))
  assert.equal(gapAsked.result.status, 'needs_input')
  assert.deepEqual(gapAsked.result.questions.map(q => [q.id, q.question]), [['consistency.q1', GAP_Q.question]])
  assert.equal(gapAsked.result.resume_from, 'consistency')
  assert.ok(!gapAsked.labels.some(l => l.startsWith('review:recheck-')), 'a doc whose reviser asked is not re-reviewed')
})

await test('brief-to-proposals: context_file reaches every author and reviewer, and no mechanical stage', async () => {
  const over = {
    'review:architecture-1': { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'x' }], completed: true },
    'consistency:arch-m2': { findings: [{ doc: PATH.m2, severity: 'bug', description: 'y' }] },
  }
  const { labels, prompt } = await run(WF, { ...BRIEF, panel: 3, context_file: 'notes/builder.md' }, design(over, NO_DOCS))
  const authors = labels.filter(l => /^(intake|sketch:|judge|roadmap|propose:|revise:)/.test(l))
  for (const l of ['intake', 'sketch:validate-first', 'sketch:trust-first', 'sketch:operate-first', 'judge', 'roadmap', 'propose:m2', 'propose:m3', 'propose:m5', 'revise:architecture-1', 'revise:consistency-1']) {
    assert.ok(authors.includes(l), `${l} ran`)
  }
  for (const l of authors) assert.match(prompt(l), /read notes\/builder\.md \(relative to \/abs\/p\) in full: its text is framing from the person, binding/, l)
  for (const l of labels.filter(x => /^(review:|consistency:)/.test(x))) assert.match(prompt(l), /notes\/builder\.md/, l)
  // A framing /start-product assumed is not the person's word: every author and reviewer is told how to tell, and the Intake asks it.
  const NOT_CONFIRMED = /When that file has a line starting "- Not confirmed by me yet", \/start-product assumed the framing: until an answer from the person confirms it, it is an assumption, not the person's word, and no decision that rests on it is tagged \(person, \.\.\.\)/
  for (const l of authors.concat(labels.filter(x => /^(review:|consistency:)/.test(x)))) assert.match(prompt(l), NOT_CONFIRMED, l)
  for (const l of authors) assert.match(prompt(l), /Keep such a framing, or return a question to change it/, l)
  assert.match(prompt('intake'), /When notes\/builder\.md has a line starting "- Not confirmed by me yet" and no answer above confirms the framing, return the framing as ONE confirmation in the same batch \(confirm: true\): the question "Should the design follow this builder framing\?"/)
  assert.match(prompt('intake'), /the recommended option to follow it as notes\/builder\.md states it, and in why its limits in your own words; never copy personal data, credentials or the file's text itself/)
  assert.doesNotMatch((await run(WF, BRIEF, design({}, NO_DOCS))).prompt('intake'), /Not confirmed by me yet/, 'with no context file there is no framing to confirm')
  const FQ = { question: 'Should the design follow this builder framing?', why: 'one builder, evenings only, no paid services', options: ['yes, as notes/builder.md states it', 'no: the person says what changes'], recommended: 'yes, as notes/builder.md states it', confirm: true }
  const framingAsked = await run(WF, { ...BRIEF, context_file: 'notes/builder.md' }, design({ intake: { questions: [FQ] } }, NO_DOCS))
  assert.equal(framingAsked.result.status, 'needs_input')
  assert.deepEqual(framingAsked.result.questions.map(q => [q.id, q.confirm]), [['intake.q1', true]])
  const framingAssumed = await run(WF, { ...BRIEF, context_file: 'notes/builder.md', on_question: 'assume' }, design({ intake: { questions: [FQ] } }, NO_DOCS))
  assert.equal(framingAssumed.result.status, 'ready')
  assert.ok(framingAssumed.result.assumptions.some(a => a.stage === 'intake' && a.assumption === 'Should the design follow this builder framing? -> yes, as notes/builder.md states it'))
  for (const l of ['seed', 'save-panel', 'milestones', 'lint']) assert.doesNotMatch(prompt(l), /notes\/builder\.md/, l)
  // The survey names it only to check that it exists (and to restore it): it is told never to read it.
  assert.match(prompt('existing-docs'), /context_exists: whether notes\/builder\.md exists .* Never read it, and never copy any of its text/)
  // Concern mode too, after its own check that the file is there.
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p', context_file: 'notes/builder.md' }, design())
  assert.deepEqual(concern.labels.slice(0, 3), ['seed', 'context-check', 'intake'])
  for (const l of ['intake', 'propose']) assert.match(concern.prompt(l), /notes\/builder\.md/, l)
})

await test('brief-to-proposals: needs_input results name the stage to resume from', async () => {
  const roadmapQ = await run(WF, BRIEF, design({ roadmap: { questions: [Q] } }, NO_DOCS))
  assert.equal(roadmapQ.result.resume_from, 'architecture')
  assert.match(roadmapQ.result.relay, /from: 'architecture'/)
  assert.match(roadmapQ.result.relay, /never answer them on their behalf/)
  const milestoneQ = await run(WF, { ...BRIEF, from: 'proposals' }, design({ 'propose:m5': { questions: [Q] } }))
  assert.equal(milestoneQ.result.status, 'needs_input')
  assert.equal(milestoneQ.result.resume_from, 'proposals')
  assert.deepEqual(milestoneQ.result.questions.map(q => q.id), ['m5.q1'])
  const consistencyQ = await run(WF, { ...BRIEF, from: 'consistency' }, design({
    'consistency:arch-m2': { findings: [{ doc: PATH.m2, severity: 'bug', description: 'y' }] }, 'revise:consistency-1': { questions: [Q] } }))
  assert.equal(consistencyQ.result.resume_from, 'consistency')
  assert.deepEqual(consistencyQ.result.questions.map(q => q.id), ['consistency.q1'])
  // Concern mode has no from: its relay keeps resumeFromRunId.
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p' }, design({ propose: { questions: [Q] } }))
  assert.equal(concern.result.resume_from, undefined)
  assert.match(concern.result.relay, /resumeFromRunId/)
})

await test('brief-to-proposals: a question asked on a re-run continues the ids after the ones answered in its scope', async () => {
  // The answers pile up from run to run, so a new question reusing an answered id would overwrite that answer, or pass for it.
  const concern = (doc, description) => ({ findings: [{ doc, severity: 'concern', description }], completed: true })
  const arch = await run(WF, { ...BRIEF, answers: [{ id: 'architecture.q1', answer: 'AA' }] }, design({
    'review:architecture-1': concern(PATH.roadmap, 'the brief is silent on X'), 'revise:architecture-1': { questions: [Q] } }))
  assert.equal(arch.result.from, 'architecture')
  assert.deepEqual(arch.result.questions.map(q => [q.id, q.stage]), [['architecture.q2', 'architecture']])
  const roadmap = await run(WF, { ...BRIEF, answers: { 'intake.q1': 'AI', 'architecture.q1': 'AA' } }, design({ roadmap: { questions: [Q] } }, NO_DOCS))
  assert.deepEqual(roadmap.result.questions.map(q => q.id), ['architecture.q2'])
  // A milestone counts only its own ids: m3's, m50's and the architecture's leave m5's numbering alone.
  const answers = [{ id: 'm5.q1', answer: 'A5' }, { id: 'm3.q4', answer: 'A3' }, { id: 'm50.q7', answer: 'A50' }, { id: 'architecture.q3', answer: 'AA' }]
  const author = await run(WF, { ...BRIEF, from: 'proposals', answers }, design({ 'propose:m5': { questions: [Q, Q] } }))
  assert.deepEqual(author.result.questions.map(q => [q.id, q.stage]), [['m5.q2', 'm5'], ['m5.q3', 'm5']])
  const reviser = await run(WF, { ...BRIEF, from: 'proposals', milestones: [3], answers }, design({
    'review:m3-1': concern(PATH.m3, 'the brief is silent on retries'), 'revise:m3-1': { questions: [Q] } }))
  assert.deepEqual(reviser.result.questions.map(q => q.id), ['m3.q5'])
  // Consistency: a reviser's question and a re-review's both come after the answered consistency.q1, each with its own id.
  const consistency = await run(WF, { ...BRIEF, from: 'consistency', answers: { 'consistency.q1': 'AC' } }, design({
    'consistency:arch-m2': { findings: [{ doc: PATH.m2, severity: 'bug', description: 'x' }] },
    'consistency:arch-m3': { findings: [{ doc: PATH.m3, severity: 'bug', description: 'y' }] },
    'revise:consistency-1': { questions: [{ ...Q, question: 'Q-REVISE' }] },
    'review:recheck-1-1': concern(PATH.m3, 'still inconsistent'),
    'revise:recheck-1-1': { questions: [{ ...Q, question: 'Q-RECHECK' }] } }))
  assert.equal(consistency.result.status, 'needs_input')
  assert.deepEqual(consistency.result.questions.map(q => [q.id, q.question]), [['consistency.q2', 'Q-REVISE'], ['consistency.q3', 'Q-RECHECK']])
})

await test('brief-to-proposals: every needs_input relay says to pass from, set to the result\'s resume_from, with the answers so far', async () => {
  const consistencyAsks = { 'consistency:arch-m2': { findings: [{ doc: PATH.m2, severity: 'bug', description: 'y' }] }, 'revise:consistency-1': { questions: [Q] } }
  const stops = [
    await run(WF, BRIEF, design({ intake: { questions: [Q] } }, NO_DOCS)),
    await run(WF, BRIEF, design({ roadmap: { questions: [Q] } }, NO_DOCS)),
    await run(WF, { ...BRIEF, from: 'proposals' }, design({ 'propose:m5': { questions: [Q] } })),
    await run(WF, { ...BRIEF, from: 'consistency' }, design(consistencyAsks)),
  ]
  assert.deepEqual(stops.map(s => s.result.resume_from), ['intake', 'architecture', 'proposals', 'consistency'])
  for (const { result } of stops) {
    assert.equal(result.status, 'needs_input')
    assert.ok(result.relay.includes(`from: '${result.resume_from}' (this result's resume_from)`), result.relay)
    assert.match(result.relay, /added to any answers given before/)
    assert.match(result.relay, /Always pass that from with the answers/)
    // A decision's id is the session's to number: the relay names the next free one, and the rule.
    assert.match(result.relay, /is passed as an answer too \(id intake\.d<N>, with its question\), where N is the next number not yet in use \(intake\.d1 now\): an id is never reused for another question\. /)
    // The printed call holds absolute paths, and the seeded files exist only in the checkout that ran until a checkpoint.
    assert.match(result.relay, /from this session or a new one: it keeps the docs already written and starts again at the stage that asked\. In a new checkout or container, point dir at the new checkout, and pipeline at the pipeline's checkout there \(leave pipeline out once the checkout already holds the seeded \.claude files, as a clone of the design branch does after its first checkpoint\)\. /)
  }
  const numbered = await run(WF, { ...BRIEF, answers: [{ id: 'intake.d1', answer: 'D1' }, { id: 'intake.d4', answer: 'D4' }, { id: 'architecture.d2', answer: 'A2' }, { id: 'intake.q9', answer: 'Q9' }] },
    design({ 'propose:m5': { questions: [Q] } }))
  assert.match(numbered.result.relay, /\(intake\.d5 now\)/)
  assert.match(numbered.result.relay, /\(architecture\.d3 now for the architecture\)/)
  // Once the architecture and roadmap are written, a run from the proposals on applies no answer to them: a correction to
  // them is passed under the architecture's name and resumes there; one to a written proposal names its milestone.
  // That re-run also passes max_milestones: 0, or it would write the next milestone's proposal as a side effect.
  const CORRECTION = /a correction to what either of them says is passed as architecture\.d<N>, and the re-run then uses from: 'architecture' in place of the from below \(it applies the answer to both docs before their review\) and max_milestones: 0 \(so it writes no proposal but the milestones this relay names: a milestones list is never cut by it\); a correction to one written proposal is passed as m<N>\.d<K>, with N in milestones \(added to the ones named below, when there are any\)\. N in architecture\.d<N> and K in m<N>\.d<K> are the next numbers not yet in use \(architecture\.d1 now for the architecture\)\. /
  for (const { result } of stops.slice(0, 2)) assert.doesNotMatch(result.relay, /architecture\.d<N>/, result.resume_from)
  for (const { result } of stops.slice(2)) {
    assert.match(result.relay, CORRECTION, result.resume_from)
    assert.ok(result.relay.includes(`a run from '${result.resume_from}' applies no answer to them`), result.relay)
  }
  // Why: the answers pile up from run to run. With an architecture answer an earlier run applied, a milestone's question
  // resumes at the proposals, as the relay says; inferred, the re-run would go back to the architecture review.
  const carried = [{ id: 'intake.q1', answer: 'AI' }, { id: 'architecture.q1', answer: 'AA' }]
  const asking = await run(WF, { ...BRIEF, from: 'proposals', answers: carried }, design({ 'propose:m5': { questions: [Q] } }))
  assert.equal(asking.result.resume_from, 'proposals')
  const answers = carried.concat({ id: 'm5.q1', answer: 'A5' })
  const followed = await run(WF, { ...BRIEF, answers, from: asking.result.resume_from }, design())
  assert.ok(!followed.labels.some(l => DESIGN_AGENTS.test(l)), followed.labels.join(' '))
  assert.deepEqual(proposed(followed.labels), ['propose:m5'])
  const inferred = await run(WF, { ...BRIEF, answers }, design())
  assert.equal(inferred.result.from, 'architecture')
  assert.ok(inferred.labels.includes('review:architecture-1'))
})

await test('brief-to-proposals: answers alone re-propose no written proposal; a listed milestone is, a missing one is written, and the relay lists the ones that asked', async () => {
  // m2's question was answered two runs ago and its proposal written and reviewed clean since: passed again with the answers
  // so far, that answer leaves the proposal alone (/propose would rewrite it as a draft), whether from is given or inferred.
  const old = [{ id: 'm2.q1', answer: 'OLD-M2' }]
  for (const from of ['proposals', undefined]) {
    const { result, labels } = await run(WF, { ...BRIEF, from, answers: old }, design())
    assert.equal(result.from, 'proposals')
    assert.deepEqual(proposed(labels), ['propose:m5'], `from ${from}: only the milestone with no proposal is written`)
    assert.deepEqual(result.kept.map(k => k.milestone), [2, 3])
    assert.equal(result.status, 'ready')
  }
  // Listed in milestones, a written proposal is proposed again, with its answer.
  const listed = await run(WF, { ...BRIEF, from: 'proposals', milestones: [2], answers: old }, design())
  assert.deepEqual(proposed(listed.labels), ['propose:m2'])
  assert.match(listed.prompt('propose:m2'), /OLD-M2/)
  assert.deepEqual(listed.result.kept.map(k => k.milestone), [3])
  // m3's author asks (writing nothing) and m5's reviser asks (its proposal written): the relay names both, with from.
  const disk = exists => ({ ...ON_DISK, milestones: MILESTONES.map(m => m.n in exists ? { ...m, proposal_exists: exists[m.n] } : m) })
  const asking = await run(WF, { ...BRIEF, from: 'proposals', answers: old }, design({
    'propose:m3': { questions: [Q] },
    'review:m5-1': { findings: [{ doc: PATH.m5, severity: 'concern', description: 'the brief is silent on retries' }], completed: true },
    'revise:m5-1': { questions: [Q] } }, disk({ 3: false })))
  assert.equal(asking.result.status, 'needs_input')
  assert.deepEqual(asking.result.questions.map(q => q.id), ['m3.q1', 'm5.q1'])
  assert.ok(asking.result.relay.includes(`from: 'proposals' (this result's resume_from), with milestones: [3, 5] (the milestones that asked`), asking.result.relay)
  // Following it on the disk that run left re-proposes those two only, each with its answer ...
  const answers = old.concat({ id: 'm3.q1', answer: 'ANSWER-M3' }, { id: 'm5.q1', answer: 'ANSWER-M5' })
  const followed = await run(WF, { ...BRIEF, answers, from: 'proposals', milestones: [3, 5] }, design({}, disk({ 3: false, 5: true })))
  assert.deepEqual(proposed(followed.labels), ['propose:m3', 'propose:m5'])
  assert.match(followed.prompt('propose:m3'), /ANSWER-M3/)
  assert.match(followed.prompt('propose:m5'), /ANSWER-M5/)
  assert.deepEqual(followed.result.kept.map(k => k.milestone), [2])
  // ... where without milestones only m3, which has no proposal, would be written, and m5's answer would go unused.
  const unlisted = await run(WF, { ...BRIEF, answers, from: 'proposals' }, design({}, disk({ 3: false, 5: true })))
  assert.deepEqual(proposed(unlisted.labels), ['propose:m3'])
  // A question no milestone asked names no milestones.
  const roadmapQ = await run(WF, BRIEF, design({ roadmap: { questions: [Q] } }, NO_DOCS))
  assert.doesNotMatch(roadmapQ.result.relay, /milestones:/)
})

await test('brief-to-proposals: a question never hides a proposal that failed or stayed unclean: the relay lists the failed one, and the result names both', async () => {
  const none = { ...ON_DISK, milestones: MILESTONES.map(m => ({ ...m, proposal_exists: false })) }
  const bug = { findings: [{ doc: PATH.m5, severity: 'bug', description: 'reads a table nothing creates' }], completed: true }
  const { result, labels } = await run(WF, { ...BRIEF, from: 'proposals', max_review_rounds: 1 }, design({
    'propose:m2': { stopped: true, stop_reason: 'error=milestone_not_found' },
    'propose:m3': { questions: [Q] },
    'review:m5-1': bug, 'review:m5-2': bug, 'revise:m5-1': { summary: 'tried' } }, none))
  assert.equal(result.status, 'needs_input')
  assert.deepEqual(result.questions.map(q => q.id), ['m3.q1'])
  assert.equal(result.resume_from, 'proposals')
  assert.ok(result.relay.includes(`with milestones: [2, 3] (the milestones that asked and the ones whose /propose failed (2: no proposal exists, so nothing is overwritten), in place of any milestones given before)`), result.relay)
  assert.deepEqual(result.also_needs_attention, [
    { milestone: 2, doc: PATH.m2, reason: '/propose wrote no proposal: error=milestone_not_found' },
    { milestone: 5, doc: PATH.m5, reason: '1 blocking finding(s) remain after 1 revise round(s)' }])
  assert.match(result.next_steps[0], /answer the 1 question/)
  assert.match(result.next_steps[1], /^Answering the questions fixes none of also_needs_attention \(milestone 2: .*; milestone 5: .*\)\. The re-run the relay names writes the proposals that failed and keeps the others as they are: after it, run the refresh-proposal workflow with \{ doc, dir \} on each proposal that still has findings, before accepting it\.$/)
  assert.ok(!labels.some(l => l.startsWith('consistency:')), 'Consistency waits on the answer')
  // The re-run the relay names writes both, and keeps milestone 5's proposal as it is: no review of it runs again.
  const disk = { ...ON_DISK, milestones: MILESTONES.map(m => ({ ...m, proposal_exists: m.n === 5 })) }
  const followed = await run(WF, { ...BRIEF, from: 'proposals', milestones: [2, 3], answers: [{ id: 'm3.q1', answer: 'A3' }] }, design({}, disk))
  assert.deepEqual(proposed(followed.labels), ['propose:m2', 'propose:m3'])
  assert.deepEqual(followed.result.kept.map(k => k.milestone), [5])
  assert.ok(!followed.labels.some(l => l.startsWith('review:m5')))
  assert.equal(followed.result.also_needs_attention, undefined)
  // A proposal whose reviser asked is behind its own question, not in the list; with no question the status says it all.
  const reviserAsked = await run(WF, { ...BRIEF, from: 'proposals' }, design({ 'review:m5-1': bug, 'revise:m5-1': { questions: [Q] } }))
  assert.equal(reviserAsked.result.status, 'needs_input')
  assert.equal(reviserAsked.result.also_needs_attention, undefined)
  const noQuestion = await run(WF, { ...BRIEF, from: 'proposals' }, design({ 'propose:m5': { stopped: true, stop_reason: 'error=milestone_not_found' } }))
  assert.equal(noQuestion.result.status, 'proposals_need_attention')
  assert.equal(noQuestion.result.also_needs_attention, undefined)
  // A Consistency question beside a proposal that failed resumes at the Proposals stage: from 'consistency' would never write it.
  const late = await run(WF, { ...BRIEF, from: 'proposals' }, design({
    'propose:m5': { stopped: true, stop_reason: 'error=milestone_not_found' },
    'consistency:arch-m2': { findings: [{ doc: PATH.m2, severity: 'bug', description: 'y' }] }, 'revise:consistency-1': { questions: [Q] } }))
  assert.deepEqual(late.result.questions.map(q => q.id), ['consistency.q1'])
  assert.equal(late.result.resume_from, 'proposals')
  assert.ok(late.result.relay.includes(`from: 'proposals' (this result's resume_from), with milestones: [5] (the ones whose /propose failed (5: no proposal exists, so nothing is overwritten), in place of any milestones given before)`), late.result.relay)
  assert.deepEqual(late.result.also_needs_attention.map(a => a.milestone), [5])
})

await test('brief-to-proposals: args that cannot be honoured throw, and a run that cannot start says why', async () => {
  await assert.rejects(run(WF, { ...BRIEF, from: 'review' }, design()), /args\.from must be one of/)
  await assert.rejects(run(WF, { concern: 'c', dir: '/abs/p', from: 'proposals' }, design()), /brief mode/)
  await assert.rejects(run(WF, { ...BRIEF, force: true, from: 'consistency' }, design()), /force regenerates/)
  await assert.rejects(run(WF, { ...BRIEF, github_access: 'api' }, design()), /github_access/)
  const missing = await run(WF, BRIEF, design({}, { ...NO_DOCS, brief_exists: false }))
  assert.equal(missing.result.status, 'failed_at_start')
  assert.match(missing.result.stop_reason, /^brief_not_found/)
  const partial = await run(WF, BRIEF, design({}, { ...NO_DOCS, architecture_exists: true }))
  assert.match(partial.result.stop_reason, /^partial_docs/)
  assert.deepEqual(partial.labels, ['seed', 'existing-docs'])
  const lost = await run(WF, BRIEF, design({ 'existing-docs': null }))
  assert.equal(lost.result.status, 'failed_at_start')
})

await test('brief-to-proposals: the framing is binding with no source exception, and reviewers report a departure from what the person settled as a bug', async () => {
  const over = {
    'review:architecture-1': { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'x' }], completed: true },
    'consistency:arch-m2': { findings: [{ doc: PATH.m2, severity: 'bug', description: 'y' }] },
  }
  const { labels, prompt } = await run(WF, { ...BRIEF, panel: 3, context: 'CTX-TEXT', context_file: 'notes/builder.md' }, design(over, NO_DOCS))
  for (const l of labels) assert.doesNotMatch(prompt(l), /unless a source fact contradicts it/, l)
  for (const l of labels.filter(x => /^(intake|sketch:|judge|roadmap|propose:|revise:)/.test(x))) {
    // On the same point the person's word replaces the source's and is never asked again; only a contradiction that makes it
    // impossible to follow is a question.
    assert.match(prompt(l), /Framing from the person, binding\. On the point it addresses it replaces what the source says \(the brief's Assumed builder, a field the person corrected\): follow it, say so in what you write, and never ask it again\. Where another part of the source, the tree or research makes it impossible to follow, pick no side: return a blocking question naming both\. The framing: CTX-TEXT/, l)
    assert.match(prompt(l), /framing from the person, binding\. On the point it addresses it replaces what the source says .* never ask it again\. Where another part of the source, the tree or research makes it impossible to follow, pick no side/, l)
    assert.doesNotMatch(prompt(l), /Where the source, the tree or research contradicts it, pick no side/, l)
  }
  assert.match(prompt('sketch:validate-first'), /A sketch returns no questions: where another part of the source, the tree or your research makes the person's framing or an answer impossible to follow, or a person-owned choice/)
  // The judge scores fit to what the person settled; the source's constraints count where the person is silent.
  assert.match(prompt('judge'), /fit to the constraints, which are the framing's and the answers' where they speak \(what the person settled\) and the source's \(builder, budget, timeline\) where they are silent; time to the first validation/)
  assert.doesNotMatch(prompt('judge'), /fit to the source's constraints|licence, revenue model/)
  assert.match(prompt('consistency:brief-roadmap'), /A part of the brief that the person's framing or an answer replaces, rules out or defers is not a gap once the roadmap says so/)
  const answered = await run(WF, { ...BRIEF, answers: [{ id: 'intake.q1', answer: 'AI' }] }, design({}, NO_DOCS))
  for (const l of ['intake', 'roadmap', 'review:architecture-1', 'propose:m2', 'consistency:arch-m2']) assert.match(answered.prompt(l), /binding, like the person's framing: each replaces what the source says on the point it addresses; never re-ask them/, l)
  const R4 = /A doc that departs from the person's framing, an answer from the person, or a decision tagged \(person, \.\.\.\), with no newer answer from the person, is a bug whose fix is the question to ask \(with its options\), never a gate or a confirmation at acceptance/
  const reviewers = labels.filter(x => /^(review:|consistency:)/.test(x))
  assert.ok(reviewers.includes('review:architecture-1') && reviewers.includes('consistency:arch-m2') && reviewers.includes('review:recheck-1-1'))
  for (const l of reviewers) {
    assert.match(prompt(l), R4, l)
    assert.match(prompt(l), /a choice that follows it or an answer from the person is not a defect: CTX-TEXT/, l)
  }
  // The per-doc reviewer also reads the decisions' provenance tags; the pair reviewers do not.
  assert.match(prompt('review:architecture-1'), /A person-owned decision tagged \(assumed\), or \(source\) when the source was drafted for the person .*is a concern whose fix is the question to ask/)
  assert.doesNotMatch(prompt('consistency:arch-m2'), /is a concern whose fix is the question to ask/)
  // Both revisers: a finding that is the person's is a question, a change to what they chose included.
  for (const l of ['revise:architecture-1', 'revise:consistency-1']) {
    assert.match(prompt(l), /A finding only the person can settle \(the source is silent or ambiguous on it, the fix would choose for them, or it would change a choice the person made\) is a blocking question, per QUESTIONS/, l)
    assert.match(prompt(l), /Never change what the person settled/, l)
    assert.match(prompt(l), /name milestones, steps and decisions by title/, l)
    assert.match(prompt(l), /never a gate, never a D-record whose Choice awaits confirmation/, l)
  }
  // The source still wins over a synthesis nobody confirmed, but never over what the person said: the judge built the
  // synthesis on the framing first, so where it follows the framing against the source, the framing stands.
  assert.match(prompt('roadmap'), /where it contradicts the source, the source wins and you say so, except where the synthesis follows the framing or an answer from the person, which outrank the source\)\. An open question the synthesis leaves/)
  assert.match(prompt('roadmap'), /An open question the synthesis leaves for the person is a blocking question, never a D-record to confirm later/)
  assert.match(prompt('roadmap'), /Every departure from the synthesis is listed, with its reason, in assumptions; where the framing or an answer confirms the synthesis or one of its choices, a departure from it is a blocking question/)
  const reused = await run(WF, { ...BRIEF, panel: 3, from: 'architecture' }, design({}, { ...NO_DOCS, panel_synthesis: true }))
  assert.match(reused.prompt('roadmap'), /where it contradicts the framing or an answer above, they win and you say so; where it contradicts the source, the source wins and you say so, except where the synthesis follows the framing or an answer from the person, which outrank the source\)\. An open question the synthesis leaves for the person is a blocking question/)
  // With no framing at all the reviewers still get the rule; in assume mode a decision tagged (assumed) is no defect.
  const bare = await run(WF, BRIEF, design({}, NO_DOCS))
  for (const l of ['review:architecture-1', 'review:m2-1', 'consistency:arch-m2']) assert.match(bare.prompt(l), R4, l)
  const assumeRun = await run(WF, { ...BRIEF, on_question: 'assume' }, design(over, NO_DOCS))
  assert.match(assumeRun.prompt('review:architecture-1'), /The person chose to proceed on assumptions, so a decision tagged \(assumed\) is not a defect/)
  assert.doesNotMatch(assumeRun.prompt('review:architecture-1'), /is a concern whose fix is the question to ask/)
  assert.match(assumeRun.prompt('revise:architecture-1'), /tag a decision so taken \(assumed\) in the doc, and report it in assumptions/)
  assert.doesNotMatch(assumeRun.prompt('revise:architecture-1'), /write and change nothing/)
})

await test('brief-to-proposals: the judge\'s questions stop the run once the synthesis is saved, are assumed, or ride on /roadmap when it was not saved', async () => {
  const JQ = { question: 'Hosted for everyone, or self-run?', why: 'hosting opens an account in your name', options: ['hosted', 'self-run'], recommended: 'self-run', confirm: true }
  const judge = { scores: [{ sketch: 'validate-first', total: 26, notes: '' }], winner: 'validate-first', synthesis: SYNTHESIS, questions: [Q, JQ] }
  const asking = await run(WF, { ...BRIEF, panel: 3, answers: [{ id: 'architecture.q1', answer: 'AA' }] }, design({ judge }, NO_DOCS))
  assert.equal(asking.result.status, 'needs_input')
  assert.equal(asking.labels.at(-1), 'save-panel', 'the synthesis is saved before the run stops, and nothing is written after')
  assert.deepEqual(asking.result.questions.map(q => [q.id, q.stage, q.confirm]), [['architecture.q2', 'architecture', undefined], ['architecture.q3', 'architecture', true]])
  assert.equal(asking.result.resume_from, 'architecture')
  assert.match(asking.result.relay, /from: 'architecture'/)
  assert.match(asking.prompt('judge'), /that the source, the framing and the answers do not settle is not yours to settle: return it in questions/)
  assert.match(asking.prompt('judge'), /mark it OPEN in the synthesis/)
  assert.match(asking.prompt('judge'), /The person-owned choices: who the product is for/)
  // The re-run the relay names builds on that saved synthesis, with the answers.
  const answers = [{ id: 'architecture.q1', answer: 'AA' }, { id: 'architecture.q2', answer: 'ANSWER-JUDGE-1' }, { id: 'architecture.q3', answer: 'ANSWER-JUDGE-2' }]
  const followed = await run(WF, { ...BRIEF, panel: 3, from: 'architecture', answers }, design({}, { ...NO_DOCS, panel_synthesis: true }))
  assert.ok(!followed.labels.includes('judge'))
  assert.match(followed.prompt('roadmap'), /ANSWER-JUDGE-2/)
  assert.equal(followed.result.status, 'ready')
  // on_question assume: each becomes a shared architecture answer and an assumption, as the Intake's do.
  const assumed = await run(WF, { ...BRIEF, panel: 3, on_question: 'assume' }, design({ judge }, NO_DOCS))
  assert.equal(assumed.result.status, 'ready')
  for (const l of ['roadmap', 'review:architecture-1', 'propose:m2', 'review:m2-1', 'consistency:arch-m2']) assert.match(assumed.prompt(l), /Hosted for everyone, or self-run\?","answer":"self-run \(assumed/, l)
  assert.doesNotMatch(assumed.prompt('intake'), /Hosted for everyone/, 'an architecture answer never reaches the Intake')
  assert.ok(assumed.result.assumptions.some(a => a.stage === 'architecture' && a.assumption === 'Hosted for everyone, or self-run? -> self-run'))
  // The save failed, so a re-run could not reuse the panel: no stop; /roadmap carries the questions and returns the open ones.
  const lost = { judge, 'save-panel': { saved: false, error: 'no state script' } }
  const unsaved = await run(WF, { ...BRIEF, panel: 3 }, design(lost, NO_DOCS))
  assert.ok(unsaved.labels.includes('roadmap'))
  assert.match(unsaved.prompt('roadmap'), /return each one still open in your questions, with your own: .*Hosted for everyone, or self-run\?/)
  assert.equal(unsaved.result.status, 'ready')
  const carried = await run(WF, { ...BRIEF, panel: 3 }, design({ ...lost, roadmap: { questions: [JQ] } }, NO_DOCS))
  assert.equal(carried.result.status, 'needs_input')
  assert.deepEqual(carried.result.questions.map(q => [q.id, q.confirm]), [['architecture.q1', true]])
  // A judge that asks nothing changes nothing.
  const quiet = await run(WF, { ...BRIEF, panel: 3 }, design({}, NO_DOCS))
  assert.doesNotMatch(quiet.prompt('roadmap'), /return each one still open/)
  assert.equal(quiet.result.status, 'ready')
})

await test('brief-to-proposals: an answer whose id names no stage counts as an Intake answer: it reaches every stage and never moves the start', async () => {
  const odd = [{ id: 'licence', question: 'Which licence variant?', answer: 'ANSWER-LIC' }]
  const fresh = await run(WF, { ...BRIEF, answers: odd }, design({}, NO_DOCS))
  for (const l of ['intake', 'roadmap', 'review:architecture-1', 'propose:m2', 'propose:m5', 'consistency:arch-m2']) assert.match(fresh.prompt(l), /ANSWER-LIC/, l)
  // With the docs on disk it starts nothing earlier than the proposals, as an intake answer would not.
  const onDisk = await run(WF, { ...BRIEF, answers: odd.concat({ id: 'pricing.q3', answer: 'ANSWER-PRICE' }, { id: 'intake.d2', answer: 'ANSWER-D2' }) }, design())
  assert.equal(onDisk.result.from, 'proposals')
  assert.ok(!onDisk.labels.some(l => DESIGN_AGENTS.test(l)), onDisk.labels.join(' '))
  for (const a of ['ANSWER-LIC', 'ANSWER-PRICE', 'ANSWER-D2']) assert.ok(onDisk.prompt('propose:m5').includes(a), a)
  // A decision's id (d<N>) and another name's q<N> take no part in a scope's question numbering.
  const asking = await run(WF, { ...BRIEF, answers: [{ id: 'intake.d4', answer: 'D' }, { id: 'pricing.q3', answer: 'P' }] }, design({ intake: { questions: [Q] } }, NO_DOCS))
  assert.deepEqual(asking.result.questions.map(q => q.id), ['intake.q1'])
  // A stage given with the answer is kept when it is a known scope.
  const staged = await run(WF, { ...BRIEF, answers: [{ id: 'gate-4', stage: 'architecture', answer: 'ANSWER-STAGED' }] }, design())
  assert.equal(staged.result.from, 'architecture')
})

await test('brief-to-proposals: the answers a run is given are saved to the state branch with their questions and dates', async () => {
  const answers = [{ id: 'intake.q1', question: 'Which licence variant?', answer: 'AGPL-3.0-only', date: '2026-11-05' }, { id: 'm3.q1', question: 'Retry how often?', answer: 'A3' }]
  const { result, labels, prompt } = await run(WF, { ...BRIEF, answers }, design({ 'save-answers': { saved: true, commit: 'abc' } }))
  assert.deepEqual(labels.slice(0, 3), ['seed', 'existing-docs', 'save-answers'], 'right after the survey, before any design agent')
  const p = prompt('save-answers')
  assert.match(p, /pipeline-state\.py save <that file> --as design\/answers\.json/)
  assert.match(p, /never retry another way/)
  const saved = JSON.parse(p.match(/-----BEGIN ANSWERS-----\n([\s\S]*)\n-----END ANSWERS-----/)[1])
  assert.deepEqual(saved, { source: 'docs/brief.md', answers: [
    { id: 'intake.q1', stage: 'intake', question: 'Which licence variant?', answer: 'AGPL-3.0-only', date: '2026-11-05' },
    { id: 'm3.q1', stage: 'm3', question: 'Retry how often?', answer: 'A3', date: '' }], assumptions: [] })
  assert.equal(result.answers_saved, true)
  assert.equal(result.status, 'ready')
  // The date travels into the prompts with the answer and its id.
  assert.ok(prompt('propose:m5').includes('{"id":"intake.q1","question":"Which licence variant?","answer":"AGPL-3.0-only","date":"2026-11-05"}'), prompt('propose:m5'))
  // Best effort: a save that fails is reported and the run goes on.
  const failedSave = await run(WF, { ...BRIEF, answers }, design({ 'save-answers': { saved: false, error: 'no state script' } }))
  assert.equal(failedSave.result.answers_saved, false)
  assert.equal(failedSave.result.status, 'ready')
  // No answers, nothing to save.
  const none = await run(WF, BRIEF, design())
  assert.ok(!none.labels.includes('save-answers'))
  assert.equal(none.result.answers_saved, undefined)
  // Concern mode reads no saved copy, so it never writes the brief's file: its answers go to a file of their own, after the
  // Intake (a stage before it would end the replay of a resumed run there). The Intake still gets no later scope's answer.
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p', answers: { 'proposal.q1': 'ANSWER-PROPOSAL' } }, design({ propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true } }))
  assert.deepEqual(concern.labels.slice(0, 4), ['seed', 'intake', 'save-answers', 'propose'])
  assert.match(concern.prompt('save-answers'), /pipeline-state\.py save <that file> --as design\/answers-concern\.json/)
  assert.doesNotMatch(concern.prompt('save-answers'), /design\/answers\.json/)
  assert.match(concern.prompt('save-answers'), /"source": "concern"/)
  assert.equal(concern.result.answers_saved, false)
  assert.doesNotMatch(concern.prompt('intake'), /ANSWER-PROPOSAL/)
  assert.match(concern.prompt('propose'), /ANSWER-PROPOSAL/)
  assert.doesNotMatch(concern.prompt('propose'), /the first part of each id names the stage that asked/)
  // An Intake that asks again still saves what the run was given.
  const concernAsks = await run(WF, { concern: 'big change', dir: '/abs/p', answers: { 'intake.q1': 'AI' } }, design({ intake: { questions: [Q] } }))
  assert.deepEqual(concernAsks.labels, ['seed', 'intake', 'save-answers'])
  assert.deepEqual(concernAsks.result.questions.map(q => q.id), ['intake.q2'])
  // A run that cannot start saves nothing: it has not read what is saved, and would overwrite it.
  const lost = await run(WF, { ...BRIEF, answers }, design({ 'existing-docs': null }))
  assert.deepEqual(lost.labels, ['seed', 'existing-docs'])
})

await test('brief-to-proposals: answers saved on the state branch are restored, args win, and a restored one never moves the start', async () => {
  const disk = { ...ON_DISK, saved_answers: [
    { id: 'architecture.q1', question: 'Hosted or self-run?', answer: 'SAVED-ARCH', date: '2026-11-05' },
    { id: 'm3.q1', question: 'Retry how often?', answer: 'SAVED-M3', date: '2026-11-06' }] }
  const { result, labels, prompt } = await run(WF, { ...BRIEF, answers: [{ id: 'm3.q1', answer: 'ARGS-M3' }] }, design({ 'save-answers': { saved: true } }, disk))
  assert.match(prompt('existing-docs'), /pipeline-state\.py get design\/answers\.json .*when it exits 0 and the file's source names docs\/brief\.md/)
  assert.equal(result.from, 'proposals', 'the restored architecture answer does not send the run back to the architecture')
  assert.ok(!labels.some(l => DESIGN_AGENTS.test(l)), labels.join(' '))
  assert.deepEqual(result.answers_restored, ['architecture.q1'])
  assert.match(prompt('propose:m5'), /SAVED-ARCH/)
  assert.match(prompt('consistency:arch-m3'), /ARGS-M3/)
  for (const l of labels) assert.doesNotMatch(prompt(l), /SAVED-M3/, l)
  // What is saved back holds both, so the file never loses an answer.
  assert.match(prompt('save-answers'), /SAVED-ARCH/)
  assert.match(prompt('save-answers'), /ARGS-M3/)
  // The answer passed by id alone takes its question from the saved copy, so saving never blanks it; the date stays with the
  // answer it was given for, so a changed answer does not take the old one's.
  const savedBack = text => JSON.parse(text.match(/-----BEGIN ANSWERS-----\n([\s\S]*)\n-----END ANSWERS-----/)[1]).answers.find(a => a.id === 'm3.q1')
  assert.deepEqual(savedBack(prompt('save-answers')), { id: 'm3.q1', stage: 'm3', question: 'Retry how often?', answer: 'ARGS-M3', date: '' })
  const same = await run(WF, { ...BRIEF, answers: [{ id: 'm3.q1', answer: 'SAVED-M3' }] }, design({ 'save-answers': { saved: true } }, disk))
  assert.deepEqual(savedBack(same.prompt('save-answers')), { id: 'm3.q1', stage: 'm3', question: 'Retry how often?', answer: 'SAVED-M3', date: '2026-11-06' })
  assert.deepEqual(same.result.answers_restored, ['architecture.q1'])
  // Nothing passed: every saved answer is restored, the start stays where the docs put it, and nothing is saved again.
  const only = await run(WF, BRIEF, design({}, disk))
  assert.equal(only.result.from, 'proposals')
  assert.deepEqual(only.result.answers_restored, ['architecture.q1', 'm3.q1'])
  assert.ok(!only.labels.includes('save-answers'))
  assert.match(only.prompt('consistency:arch-m3'), /SAVED-M3/)
  // A restored answer keeps its id out of reach of a new question.
  const asking = await run(WF, { ...BRIEF, from: 'proposals', milestones: [3] }, design({ 'propose:m3': { questions: [Q] } }, disk))
  assert.deepEqual(asking.result.questions.map(q => q.id), ['m3.q2'])
  // None saved, none restored.
  assert.equal((await run(WF, BRIEF, design())).result.answers_restored, undefined)
})

await test('brief-to-proposals: a context file that is missing is restored from the state branch, or the run does not start', async () => {
  const args = { ...BRIEF, context_file: 'notes/builder.md' }
  const missing = await run(WF, args, design({}, { ...NO_DOCS, context_exists: false }))
  assert.equal(missing.result.status, 'failed_at_start')
  assert.match(missing.result.stop_reason, /^context_not_found: notes\/builder\.md does not exist/)
  assert.match(missing.result.stop_reason, /Copy it back into this checkout or rewrite it with the person, then re-run: a design run without the person's framing would choose for them/)
  assert.deepEqual(missing.labels, ['seed', 'existing-docs'])
  assert.match(missing.prompt('existing-docs'), /pipeline-state\.py get context\/builder-context\.md --to notes\/builder\.md \(this restore is the one change this stage may make: the file, and its line in the local exclude file;/)
  assert.match(missing.prompt('existing-docs'), /Read-only but for the one restore step 6 allows/)
  // A restored framing is kept out of commits the way /start-product keeps the file it writes: by the local exclude file.
  assert.match(missing.prompt('existing-docs'), /After a restore, when the file lies inside \/abs\/p, append its path from the root of \/abs\/p, with a leading \/, to the checkout's local exclude file unless a line there already names it \(the file git rev-parse --git-path info\/exclude prints/)
  // Restored: the run goes on.
  const back = await run(WF, args, design({}, { ...NO_DOCS, context_exists: true, context_restored: true }))
  assert.equal(back.result.status, 'ready')
  assert.ok(back.labels.includes('intake'))
  // With no context_file nothing is restored or required.
  const none = await run(WF, BRIEF, design({}, { ...NO_DOCS, context_exists: false }))
  assert.equal(none.result.status, 'ready')
  assert.doesNotMatch(none.prompt('existing-docs'), /builder-context/)
  assert.match(none.prompt('existing-docs'), /Read-only: change no file and no git state/)
  // Concern mode runs no survey: the same check runs alone, before the Intake is told to read the file.
  const concernArgs = { concern: 'big change', dir: '/abs/p', context_file: 'notes/builder.md' }
  const concernMissing = await run(WF, concernArgs, design({ 'context-check': { context_exists: false, context_restored: false } }))
  assert.equal(concernMissing.result.status, 'failed_at_start')
  assert.match(concernMissing.result.stop_reason, /^context_not_found: notes\/builder\.md does not exist/)
  assert.deepEqual(concernMissing.labels, ['seed', 'context-check'])
  assert.match(concernMissing.prompt('context-check'), /context_exists: whether notes\/builder\.md exists .* Never read it, and never copy any of its text\. .*pipeline-state\.py get context\/builder-context\.md --to notes\/builder\.md/)
  const concernBack = await run(WF, concernArgs, design({ 'context-check': { context_exists: true, context_restored: true }, propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true } }))
  assert.equal(concernBack.result.status, 'ready')
  assert.ok(!(await run(WF, { concern: 'big change', dir: '/abs/p' }, design())).labels.includes('context-check'))
})

// What a run that seeded the repository tells the session, wherever it ends: read the working rules, hand off before leaving.
const SEED_NOTE = /^This run installed the pipeline's CLAUDE\.md, commands and context guard in \/abs\/p after this session started, so this session loaded none of them: read the "How work happens here" section of \/abs\/p\/CLAUDE\.md now and follow it\. A re-run of this workflow can stay in this session; start every other workflow from a new session in \/abs\/p, which loads them and runs the workflows by name\. Before you leave this session, read \/abs\/p\/\.claude\/commands\/handoff\.md and follow it \(this session cannot invoke it by name\), so the new session starts from STATE\.md with the person's answers, the assumptions still to show them and the next action\.$/

await test('brief-to-proposals: results that stop early carry the assumptions, and a blocked architecture review hands the person the ways forward', async () => {
  const finding = { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'no rollback plan' }], completed: true }
  const blocked = await run(WF, { ...BRIEF, from: 'architecture', max_review_rounds: 1 }, design({
    'review:architecture-1': finding, 'review:architecture-2': finding, 'revise:architecture-1': { summary: 'tried', assumptions: ['took weekly backups'] } }))
  const r = blocked.result
  assert.equal(r.status, 'blocked_at_architecture_review')
  assert.deepEqual(r.assumptions, [{ stage: 'architecture', assumption: 'took weekly backups' }])
  assert.match(r.relay, /Show the person architecture_review\.findings_remaining, each finding in full, and this result's assumptions, with these ways forward/)
  assert.match(r.relay, /never choose for them/)
  // The three ways, then the note of a run that seeded the repository: the session may have loaded none of the pipeline.
  assert.equal(r.next_steps.length, 4)
  assert.match(r.next_steps[0], /from: 'architecture', with max_review_rounds above 1/)
  assert.match(r.next_steps[1], /scope, money, legal posture, data handling, a departure from what they said.*architecture\.d<N>, with the finding as its question; N is the next number not yet in use, architecture\.d1 now, and an id is never reused for another question\), then re-run with from: 'architecture'/)
  assert.match(r.next_steps[2], /from: 'proposals', accepting the findings that remain/)
  assert.match(r.next_steps[3], SEED_NOTE)
  for (const s of r.next_steps) assert.ok(r.relay.includes(s), s)
  assert.ok(r.seeded && r.seeded.copied === 1)
  assert.equal(r.architecture_review.findings_remaining.length, 1)
  const quiet = await run(WF, { ...BRIEF, from: 'architecture', max_review_rounds: 1 }, design({
    seed: { copied: 0, claude_md: 'unchanged' }, 'review:architecture-1': finding, 'review:architecture-2': finding, 'revise:architecture-1': { summary: 'tried' } }))
  assert.equal(quiet.result.next_steps.length, 3, 'a repository that already held the pipeline gets no note')
  assert.ok(quiet.result.relay.endsWith('They choose; never choose for them.'))
  const noRoadmap = await run(WF, BRIEF, design({ intake: { assumptions: ['EU only'] }, roadmap: { stopped: true, stop_reason: 'error=source_too_vague' } }, NO_DOCS))
  assert.equal(noRoadmap.result.status, 'failed_at_roadmap')
  assert.deepEqual(noRoadmap.result.assumptions, [{ stage: 'intake', assumption: 'EU only' }])
  assert.equal(noRoadmap.result.next_steps.length, 1)
  assert.match(noRoadmap.result.next_steps[0], SEED_NOTE)
  const noReview = await run(WF, BRIEF, design({ intake: { assumptions: ['EU only'] }, 'review:architecture-1': { findings: [], completed: false } }, NO_DOCS))
  assert.equal(noReview.result.status, 'review_failed')
  assert.deepEqual(noReview.result.assumptions, [{ stage: 'intake', assumption: 'EU only' }])
  assert.equal(noReview.result.resume_from, 'architecture')
  assert.ok(noReview.result.seeded)
  assert.equal(noReview.result.next_steps.length, 2)
  assert.match(noReview.result.next_steps[0], /^A review or revise stage of the architecture failed to report, so the docs are not reviewed: re-run with the same args and from: 'architecture' \(this result's resume_from\)/)
  assert.match(noReview.result.next_steps[1], SEED_NOTE)
  const noProposal = await run(WF, { concern: 'big change', dir: '/abs/p' }, design({ intake: { assumptions: ['EU only'] }, propose: { stopped: true, stop_reason: 'error=concern_too_vague' } }))
  assert.equal(noProposal.result.status, 'failed_at_propose')
  assert.deepEqual(noProposal.result.assumptions, [{ stage: 'intake', assumption: 'EU only' }])
  // An Intake that asks nothing still shows what it took as given, in the log too.
  assert.ok(noProposal.logs.includes("Intake: no blocking questions; 1 assumption(s) the person has not confirmed (this result's assumptions):"), noProposal.logs.join('\n'))
  assert.ok(noProposal.logs.includes('  EU only'))
  assert.ok((await run(WF, BRIEF, design({}, NO_DOCS))).logs.includes('Intake: no blocking questions'))
})

await test('brief-to-proposals: resuming at the architecture applies the person\'s answers to the existing docs before the review', async () => {
  const answers = [{ id: 'intake.d1', question: 'Which licence variant?', answer: 'AGPL-3.0-only', date: '2026-11-05' }, { id: 'architecture.q1', answer: 'ANSWER-ARCH' },
    { id: 'architecture.d1', question: 'Data store: hosted Postgres, not SQLite', answer: 'ANSWER-CORRECTION' }, { id: 'm3.q1', answer: 'ANSWER-M3' }]
  const { result, labels, prompt } = await run(WF, { ...BRIEF, from: 'architecture', answers }, design())
  assert.ok(labels.includes('revise:architecture-answers'))
  assert.ok(labels.indexOf('revise:architecture-answers') < labels.indexOf('review:architecture-1'))
  assert.ok(!labels.includes('roadmap'))
  const p = prompt('revise:architecture-answers')
  assert.match(p, /skill "propose" with args "--revise <doc>"/)
  assert.match(p, /tag each decision an answer settles \(person, <the answer's date, or today's when it has none>, <the answer's id>\)/)
  assert.match(p, /When the docs already reflect every answer, write nothing/)
  assert.match(p, /Edit only docs\/design\/architecture\.md and docs\/design\/roadmap\.md/)
  assert.match(p, /find the answers listed at the end of this prompt \(the Intake's and the architecture's\) that they do not yet reflect/)
  for (const s of ['"id": "intake.d1"', 'Which licence variant?', '"date": "2026-11-05"', 'ANSWER-ARCH', 'QUESTIONS: this stage runs unattended']) assert.ok(p.includes(s), s)
  // The list to apply ends the prompt: a correction passed as architecture.d<N> is on it, a milestone's answer is not (it
  // reaches the stage only among the answers every stage gets).
  const toApply = p.slice(p.lastIndexOf('no errors.'))
  assert.match(toApply, /"id": "architecture\.d1"[\s\S]*ANSWER-CORRECTION/)
  assert.doesNotMatch(toApply, /ANSWER-M3/, 'a milestone\'s answer is not the architecture\'s to apply')
  assert.match(p.slice(0, p.lastIndexOf('no errors.')), /ANSWER-M3/)
  assert.equal(result.status, 'ready')
  assert.equal(result.architecture_review.revise_rounds, 0, 'applying the answers is not a review round')
  // Its question stops the run like any reviser's: after the Architecture checkpoint, before the review.
  const asking = await run(WF, { ...BRIEF, branch: 'design/20261110', from: 'architecture', answers }, design({ 'revise:architecture-answers': { questions: [Q], assumptions: ['kept the old name'] } }))
  assert.equal(asking.result.status, 'needs_input')
  assert.deepEqual(asking.result.questions.map(q => q.id), ['architecture.q2'], 'a decision id (d<N>) takes no part in the numbering')
  assert.equal(asking.result.resume_from, 'architecture')
  assert.equal(asking.labels.at(-1), 'checkpoint:architecture')
  assert.ok(!asking.labels.includes('review:architecture-1'))
  assert.deepEqual(asking.result.assumptions, [{ stage: 'architecture', assumption: 'kept the old name' }])
  // It runs only for the docs that existed, and only with an answer in the Intake's or the architecture's scope.
  const milestoneOnly = await run(WF, { ...BRIEF, from: 'architecture', answers: [{ id: 'm3.q1', answer: 'A3' }] }, design())
  assert.ok(!milestoneOnly.labels.includes('revise:architecture-answers'))
  const fresh = await run(WF, { ...BRIEF, answers: [{ id: 'intake.q1', answer: 'AI' }] }, design({}, NO_DOCS))
  assert.ok(!fresh.labels.includes('revise:architecture-answers'), '/roadmap wrote the docs on the answers')
  const laterStage = await run(WF, { ...BRIEF, answers: [{ id: 'intake.q1', answer: 'AI' }] }, design())
  assert.ok(!laterStage.labels.includes('revise:architecture-answers'), 'a run that starts at the proposals leaves the architecture alone')
  // A restored answer counts; a recommendation the run assumed is not the person's and is never applied as theirs.
  const restoredRun = await run(WF, { ...BRIEF, from: 'architecture' }, design({}, { ...ON_DISK, saved_answers: [{ id: 'intake.q1', answer: 'SAVED-INTAKE' }] }))
  assert.match(restoredRun.prompt('revise:architecture-answers'), /SAVED-INTAKE/)
  const assumed = await run(WF, { ...BRIEF, from: 'intake', on_question: 'assume' }, design({ intake: { questions: [Q] } }))
  assert.ok(assumed.labels.includes('review:architecture-1') && !assumed.labels.includes('revise:architecture-answers'))
  // A stage that fails to report does not stop the run: the review checks the docs against the answers.
  const lost = await run(WF, { ...BRIEF, from: 'architecture', answers }, design({ 'revise:architecture-answers': null }))
  assert.ok(lost.labels.includes('review:architecture-1'))
  assert.match(lost.prompt('review:architecture-1'), /ANSWER-ARCH/)
})

await test('brief-to-proposals: the Lint stage lists what no person confirmed, and the next steps say to show it before a doc is accepted', async () => {
  const lint = { docs: [], lanes: [], next_milestones: [],
    unconfirmed: [{ doc: PATH.arch, id: 'D3', title: 'Data store', by: 'assumed' }, { doc: PATH.m2, id: 'D1', title: 'File format', by: '' }],
    proposed: [{ doc: PATH.m2, line: 40, text: 'Retention: 30 days (proposed)' }] }
  const { result, prompt } = await run(WF, { ...BRIEF, from: 'lint' }, design({ lint }))
  assert.match(prompt('lint'), /proposal-lint\.py <doc> --decisions on docs\/design\/architecture\.md, docs\/design\/roadmap\.md \(it holds no decision records: its proposed values are listed\) and each proposal/)
  assert.match(prompt('lint'), /return in unconfirmed every record of its unconfirmed list .* and in proposed every entry of its proposed list/)
  assert.deepEqual(result.lint.unconfirmed.map(u => u.id), ['D3', 'D1'])
  const i = result.next_steps.findIndex(s => s.startsWith('Before a doc is accepted'))
  assert.ok(i >= 0 && i < result.next_steps.findIndex(s => s.startsWith('Read and edit the docs')), result.next_steps.join('\n'))
  const step = result.next_steps[i]
  assert.match(step, /lint\.unconfirmed \(2 decision\(s\) no person confirmed: D3 "Data store" in docs\/design\/architecture\.md; D1 "File format" in docs\/design\/01-import\.md\)/)
  assert.match(step, /lint\.proposed \(1 value\(s\) an author proposed\), and ask them to confirm or correct each/)
  // A threshold the roadmap proposes counts, and alone it calls for the step.
  const roadmapOnly = await run(WF, { ...BRIEF, from: 'lint' }, design({ lint: { ...lint, unconfirmed: [], proposed: [{ doc: PATH.roadmap, line: 22, text: 'continue only with 200 sign-ups (proposed)' }] } }))
  assert.match(roadmapOnly.result.next_steps.find(s => s.startsWith('Before a doc is accepted')), /lint\.unconfirmed \(0 decision\(s\) no person confirmed\) and lint\.proposed \(1 value\(s\) an author proposed\)/)
  // What the person decides there: a decision confirmed as it stands is one edit of its tag, with no re-run; a changed one
  // goes back as an answer, and the re-run that applies it to the architecture writes no further proposal.
  assert.match(step, /ask them to confirm or correct each\. A decision they confirm as it stands needs no re-run: its heading tag becomes \(person, <today's date>, edit\); the person changes it while accepting the doc, or you make that one-line edit when they say so \(the tag only, never the Choice or any other text\)\. /)
  assert.match(step, /A decision, an assumption or a proposed value they change goes back as an answer, its question naming the decision by title and its number the next one not yet in use \(an id is never reused for another question\): architecture\.d<N> \(architecture\.d1 now\) for what the architecture or the roadmap says, m<N>\.d<K> for milestone N's proposal\. /)
  assert.match(step, /Pass it to the refresh-proposal workflow on the one doc, or to a re-run of this workflow with the same args and from set to that stage: from: 'architecture' with max_milestones: 0 for the architecture or the roadmap, so the re-run writes no further proposal; from: 'proposals' with milestones: \[N\] for a proposal, which is written again as a draft; the revise tags the decision \(person, <date>, <id>\)\. A confirmation may be passed as an answer the same way when such a re-run happens anyway\.$/)
  // The correction that step names, on the docs and the two proposals already written: the answer is applied and reviewed, and
  // no proposal is written; without max_milestones: 0 the same run would also write the next milestone's.
  const correction = [{ id: 'architecture.d1', question: 'Data store: hosted Postgres, not SQLite', answer: 'hosted Postgres', date: '2026-11-13' }]
  const corrected = await run(WF, { ...BRIEF, max_milestones: 0, from: 'architecture', answers: correction }, design())
  assert.ok(corrected.labels.includes('revise:architecture-answers') && corrected.labels.includes('review:architecture-1'), corrected.labels.join(' '))
  assert.deepEqual(proposed(corrected.labels), [])
  assert.deepEqual(corrected.result.kept.map(k => k.milestone), [2, 3])
  assert.ok(corrected.labels.includes('consistency:arch-m2'), 'the written proposals are still checked against the corrected architecture')
  assert.equal(corrected.result.status, 'ready')
  assert.deepEqual(proposed((await run(WF, { ...BRIEF, max_milestones: 1, from: 'architecture', answers: correction }, design())).labels), ['propose:m5'])
  // The list of unconfirmed decisions the step names is capped at twelve; the count and lint.unconfirmed hold them all.
  const many = Array.from({ length: 14 }, (_, k) => ({ doc: PATH.arch, id: `D${k + 1}`, title: `Decision ${k + 1}`, by: 'assumed' }))
  const capped = (await run(WF, { ...BRIEF, from: 'lint' }, design({ lint: { ...lint, unconfirmed: many, proposed: [] } }))).result.next_steps.find(s => s.startsWith('Before a doc is accepted'))
  assert.match(capped, /lint\.unconfirmed \(14 decision\(s\) no person confirmed: D1 "Decision 1" .*; D12 "Decision 12" in docs\/design\/architecture\.md; and 2 more\)/)
  assert.doesNotMatch(capped, /D13 "Decision 13"/)
  // The run's assumptions alone call for the step; with nothing unconfirmed there is none.
  const assumedOnly = await run(WF, BRIEF, design({ intake: { assumptions: ['EU only'] } }, NO_DOCS))
  assert.match(assumedOnly.result.next_steps.find(s => s.startsWith('Before a doc is accepted')), /this result's assumptions \(1\)/)
  const clean = await run(WF, { ...BRIEF, from: 'lint' }, design())
  assert.ok(!clean.result.next_steps.some(s => s.startsWith('Before a doc is accepted')))
  // Concern mode has no architecture: the decisions are read from the proposal alone.
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p' }, design({ propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true }, lint: { ...lint, unconfirmed: [], proposed: lint.proposed } }))
  assert.match(concern.prompt('lint'), /--decisions on each proposal/)
  assert.match(concern.result.next_steps.find(s => s.startsWith('Before a doc is accepted')), /: proposal\.d<N> \(proposal\.d1 now\)\. Pass it to the refresh-proposal workflow on the doc, or to a re-run of this workflow, which writes the proposal again; the revise tags the decision \(person, <date>, <id>\)/)
})

await test('brief-to-proposals: after a force run the relay says whether the re-run keeps force: not once /roadmap regenerated the docs', async () => {
  const LEAVE = "Leave force out of the re-run: this run already regenerated architecture.md and roadmap.md, and force would write them again (from: 'proposals' or later refuses it)."
  const KEEP = 'Keep force in the re-run: this run has not regenerated architecture.md and roadmap.md yet.'
  const concern = { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'the brief is silent on X' }], completed: true }
  // The architecture reviser asks after /roadmap --force rewrote the docs: with force again, the re-run would rewrite them.
  const asking = await run(WF, { ...BRIEF, force: true }, design({ 'review:architecture-1': concern, 'revise:architecture-1': { questions: [Q] } }))
  assert.match(asking.prompt('roadmap'), /--force/)
  assert.equal(asking.result.resume_from, 'architecture')
  assert.ok(asking.result.relay.includes(LEAVE), asking.result.relay)
  assert.ok(!asking.result.relay.includes(KEEP))
  // The re-run it names, without force: no /roadmap, the answers applied to the regenerated docs, only the missing proposal written.
  const followed = await run(WF, { ...BRIEF, from: 'architecture', answers: [{ id: 'architecture.q1', answer: 'AA' }] }, design())
  assert.ok(!followed.labels.includes('roadmap') && followed.labels.includes('revise:architecture-answers'), followed.labels.join(' '))
  assert.deepEqual(proposed(followed.labels), ['propose:m5'])
  // Stopped before /roadmap wrote anything (the Intake, the judge, /roadmap itself): without force the re-run would resume
  // the review of the docs force was to replace.
  const early = [
    await run(WF, { ...BRIEF, force: true }, design({ intake: { questions: [Q] } })),
    await run(WF, { ...BRIEF, panel: 3, force: true }, design({ judge: { scores: [{ sketch: 'validate-first', total: 26, notes: '' }], winner: 'validate-first', synthesis: SYNTHESIS, questions: [Q] } })),
    await run(WF, { ...BRIEF, force: true }, design({ roadmap: { questions: [Q] } })),
  ]
  assert.deepEqual(early.map(e => e.result.resume_from), ['intake', 'architecture', 'architecture'])
  for (const { result } of early) {
    assert.equal(result.status, 'needs_input')
    assert.ok(result.relay.includes(KEEP) && !result.relay.includes(LEAVE), result.relay)
  }
  // A milestone's question in a force run: the relay's from: 'proposals' refuses force, and says to leave it out.
  const milestoneQ = await run(WF, { ...BRIEF, force: true }, design({ 'propose:m5': { questions: [Q] } }))
  assert.equal(milestoneQ.result.resume_from, 'proposals')
  assert.ok(milestoneQ.result.relay.includes(LEAVE), milestoneQ.result.relay)
  await assert.rejects(run(WF, { ...BRIEF, force: true, from: 'proposals', milestones: [5], answers: [{ id: 'm5.q1', answer: 'A5' }] }, design()), /force regenerates/)
  // A blocked architecture review under force: way (A) drops force, and the next steps say why.
  const blocked = await run(WF, { ...BRIEF, force: true, max_review_rounds: 1 }, design({ 'review:architecture-1': concern, 'review:architecture-2': concern, 'revise:architecture-1': { summary: 'tried' } }))
  assert.equal(blocked.result.status, 'blocked_at_architecture_review')
  assert.match(blocked.result.next_steps[0], /re-run with the same args, without force, and from: 'architecture', with max_review_rounds above 1/)
  assert.equal(blocked.result.next_steps[3], LEAVE)
  assert.ok(blocked.result.relay.includes(LEAVE))
  // A finished force run says the same on a line of its own, with a branch or without: every re-run its next steps name (a
  // correction, a later proposal) would otherwise regenerate the docs. A run without force never mentions it.
  for (const branch of ['design/20261110', undefined]) {
    const done = await run(WF, { ...BRIEF, force: true, branch, max_milestones: 1 }, design({ lint: { docs: [], lanes: [], next_milestones: [], unconfirmed: [{ doc: PATH.arch, id: 'D3', title: 'Data store', by: 'assumed' }], proposed: [] } }))
    assert.equal(done.result.status, 'ready')
    assert.equal(done.result.next_steps.filter(s => s === LEAVE).length, 1, String(branch))
    assert.match(done.result.next_steps.find(s => s.startsWith('Before a doc is accepted')), /to a re-run of this workflow with the same args, without force, and from set to that stage/)
    assert.match(done.result.next_steps.find(s => s.startsWith('No proposal is written yet')), /re-run this workflow with the same args, without force, and from: 'proposals', with milestones: \[N\] \(now \[5\]\)/)
    if (branch) assert.ok(done.result.next_steps.find(s => s.includes('committed on design/20261110')).endsWith('picks up the docs where they stand.'))
  }
  // A review that failed to report after /roadmap --force regenerated the docs: its re-run drops force too.
  const noReview = await run(WF, { ...BRIEF, force: true }, design({ 'review:architecture-1': { findings: [], completed: false } }))
  assert.equal(noReview.result.status, 'review_failed')
  assert.match(noReview.result.next_steps[0], /re-run with the same args, without force, and from: 'architecture' \(this result's resume_from\)/)
  assert.equal(noReview.result.next_steps[1], LEAVE)
  // /roadmap --force stopped before it wrote anything: the re-run keeps force.
  const noRoadmap = await run(WF, { ...BRIEF, force: true }, design({ roadmap: { stopped: true, stop_reason: 'error=source_too_vague' } }))
  assert.equal(noRoadmap.result.status, 'failed_at_roadmap')
  assert.equal(noRoadmap.result.next_steps[0], KEEP)
  const plain = await run(WF, { ...BRIEF, branch: 'design/20261110' }, design({ 'review:architecture-1': concern, 'revise:architecture-1': { questions: [Q] } }, NO_DOCS))
  assert.doesNotMatch(plain.result.relay, /force/)
  assert.ok(!(await run(WF, { ...BRIEF, branch: 'design/20261110' }, design())).result.next_steps.some(s => /force/.test(s)))
  // Concern mode has no docs to regenerate: force is not its arg, and its relay is silent on it.
  assert.doesNotMatch((await run(WF, { concern: 'big change', dir: '/abs/p', force: true }, design({ propose: { questions: [Q] } }))).result.relay, /force/)
})

await test('brief-to-proposals: a run that seeded the repository tells the session to read CLAUDE.md and start the next workflow in a new session', async () => {
  const NOTE = SEED_NOTE
  const note = NOTE.source.slice(1, -1)
  // The default seed reply copied a file and wrote CLAUDE.md: a needs_input relay ends with the note, a finished run lists it.
  const asking = await run(WF, BRIEF, design({ intake: { questions: [Q] } }, NO_DOCS))
  assert.match(asking.result.relay, new RegExp(` ${note}$`))
  const ready = await run(WF, BRIEF, design({}, NO_DOCS))
  assert.equal(ready.result.status, 'ready')
  assert.equal(ready.result.next_steps.filter(s => NOTE.test(s)).length, 1, ready.result.next_steps.join('\n'))
  // A final needs_input result carries it once, in the relay, after the step that says to answer first.
  const late = await run(WF, { ...BRIEF, from: 'proposals' }, design({ 'propose:m5': { questions: [Q] } }))
  assert.match(late.result.relay, new RegExp(` ${note}$`))
  assert.match(late.result.next_steps[0], /^First answer the 1 question/)
  assert.ok(!late.result.next_steps.some(s => NOTE.test(s)))
  // An appended CLAUDE.md alone counts; a repository that already held everything gets no note.
  const appended = await run(WF, BRIEF, design({ seed: { copied: 0, claude_md: 'appended' } }, NO_DOCS))
  assert.ok(appended.result.next_steps.some(s => NOTE.test(s)))
  const unchanged = { seed: { copied: 0, claude_md: 'unchanged' } }
  assert.doesNotMatch((await run(WF, BRIEF, design({ ...unchanged, intake: { questions: [Q] } }, NO_DOCS))).result.relay, /after this session started/)
  assert.ok(!(await run(WF, BRIEF, design(unchanged, NO_DOCS))).result.next_steps.some(s => /after this session started/.test(s)))
})

await test('brief-to-proposals: max_milestones 0 stops after the reviewed architecture and roadmap; a re-run from proposals writes the proposals', async () => {
  const lint = { docs: [], lanes: [], next_milestones: [], unconfirmed: [{ doc: PATH.arch, id: 'D3', title: 'Data store', by: 'assumed' }], proposed: [] }
  const { result, labels, logs } = await run(WF, { ...BRIEF, max_milestones: 0 }, design({ lint }, NO_DOCS))
  assert.ok(labels.includes('roadmap') && labels.includes('review:architecture-1') && labels.includes('lint'), labels.join(' '))
  assert.ok(!labels.some(l => l.startsWith('propose:') || l.startsWith('consistency:')), labels.join(' '))
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.proposals, [])
  assert.ok(result.next_steps.some(s => s.startsWith('Before a doc is accepted') && s.includes('D3 "Data store"')))
  assert.ok(logs.some(l => l.startsWith("Not proposing milestones 2, 3, 5 (args.max_milestones); write them later with a re-run of this workflow (from: 'proposals', milestones: [2, 3, 5])")), logs.join('\n'))
  // That re-run, on the docs the first one left: every proposal not written yet.
  const later = await run(WF, { ...BRIEF, from: 'proposals' }, design({}, { ...ON_DISK, milestones: WRITTEN.milestones }))
  assert.deepEqual(proposed(later.labels), ['propose:m2', 'propose:m3', 'propose:m5'])
  // 1 still proposes exactly the first; left out (or not a number) there is no cap.
  assert.deepEqual(proposed((await run(WF, { ...BRIEF, max_milestones: 1 }, design({}, NO_DOCS))).labels), ['propose:m2'])
  for (const none of [undefined, null, '', 'all']) assert.equal(proposed((await run(WF, { ...BRIEF, max_milestones: none }, design({}, NO_DOCS))).labels).length, 3, String(none))
})

await test('brief-to-proposals: in brief mode an answer reaches the stages before the one that asked', async () => {
  // A regenerating run (force, from the Intake) with the answer an architecture question got on the docs it replaces: the
  // Intake, the sketches, the judge and /roadmap all see it, so none asks it again or decides against it.
  const answers = [{ id: 'architecture.q1', question: 'Hosted or self-run?', answer: 'ANSWER-ARCH', date: '2026-11-05' }, { id: 'consistency.q1', answer: 'ANSWER-CON' }]
  const { labels, prompt } = await run(WF, { ...BRIEF, panel: 1, from: 'intake', force: true, answers }, design())
  for (const l of ['intake', 'sketch:validate-first', 'judge', 'roadmap', 'review:architecture-1', 'propose:m2', 'review:m2-1', 'consistency:arch-m2']) {
    assert.ok(labels.includes(l), `${l} ran`)
    assert.match(prompt(l), /ANSWER-ARCH/, l)
    assert.match(prompt(l), /ANSWER-CON/, l)
  }
  // The start inference is unchanged: with the docs on disk, the same answers start at the architecture review.
  assert.equal((await run(WF, { ...BRIEF, answers }, design())).result.from, 'architecture')
})

await test('brief-to-proposals: a person\'s Intake answer on a fresh run reaches the sketches, the judge and the architecture reviser', async () => {
  const answers = [{ id: 'intake.q1', question: Q.question, answer: 'ANSWER-INTAKE: email', date: '2026-11-12' }]
  const concern = { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'no rollback plan' }], completed: true }
  const { result, prompt, labels } = await run(WF, { ...BRIEF, panel: 3, answers }, design({ 'review:architecture-1': concern }, NO_DOCS))
  assert.equal(result.status, 'ready')
  const LIST = JSON.stringify([{ id: 'intake.q1', question: Q.question, answer: 'ANSWER-INTAKE: email', date: '2026-11-12' }])
  for (const l of ['sketch:validate-first', 'sketch:trust-first', 'sketch:operate-first', 'judge', 'revise:architecture-1']) {
    assert.ok(labels.includes(l), `${l} ran`)
    assert.ok(prompt(l).includes(LIST), `${l}: the answer with its id, question text and date`)
    assert.match(prompt(l), /never re-ask them/, l)
  }
  // An answer passed without its question says so to every stage it reaches; the log names it.
  const bare = await run(WF, { ...BRIEF, answers: { 'intake.q1': 'email' } }, design({}, NO_DOCS))
  for (const l of ['intake', 'roadmap', 'propose:m2']) assert.match(bare.prompt(l), /An entry above whose question equals its id was passed without its question text\. When its answer alone does not say what it settles, it settles nothing: never guess what it meant\./, l)
  assert.ok(bare.logs.some(m => /^Answer\(s\) without their question text: intake\.q1 /.test(m)), bare.logs.join('\n'))
  // The saved copy supplies the question: then nothing is said and nothing is logged.
  const saved = await run(WF, { ...BRIEF, answers: { 'intake.q1': 'email' } }, design({}, { ...NO_DOCS, saved_answers: [{ id: 'intake.q1', stage: 'intake', question: Q.question, answer: 'email', date: '2026-11-05' }] }))
  assert.doesNotMatch(saved.prompt('roadmap'), /passed without its question text/)
  assert.ok(!saved.logs.some(m => /without their question text/.test(m)))
})

await test('brief-to-proposals: assumptions an author or reviser reports reach the result with their stage (roadmap, a milestone, consistency, concern mode)', async () => {
  const over = {
    roadmap: { ...WRITTEN, assumptions: ['A-ROADMAP'] },
    'propose:m2': { doc: PATH.m2, steps: 3, lint_clean: true, assumptions: ['A-M2'] },
    'consistency:arch-m2': { findings: [{ doc: PATH.m2, severity: 'bug', description: 'uses a table the architecture does not have' }], coverage_gaps: [] },
    'revise:consistency-1': { summary: 'aligned', lint_clean: true, assumptions: ['A-CONSISTENCY'] },
  }
  const { result } = await run(WF, BRIEF, design(over, NO_DOCS))
  for (const want of [{ stage: 'architecture', assumption: 'A-ROADMAP' }, { stage: 'm2', assumption: 'A-M2' }, { stage: 'consistency', assumption: 'A-CONSISTENCY' }]) {
    assert.ok(result.assumptions.some(a => a.stage === want.stage && a.assumption === want.assumption), JSON.stringify([want, result.assumptions]))
  }
  assert.match(result.next_steps.find(s => s.startsWith('Before a doc is accepted')), /show the person this result's assumptions \(3\)/)
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p' }, design({ propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true, assumptions: ['A-CONCERN'] } }))
  assert.deepEqual(concern.result.assumptions, [{ stage: 'proposal', assumption: 'A-CONCERN' }])
})

await test('brief-to-proposals: an option taken on assumptions is never saved as the person\'s answer', async () => {
  const given = [{ id: 'intake.d1', question: 'Which licence?', answer: 'MIT', date: '2026-11-12' }]
  const brief = await run(WF, { ...BRIEF, on_question: 'assume', answers: given }, design({ intake: { questions: [Q] }, 'save-answers': { saved: true } }, NO_DOCS))
  assert.equal(brief.result.status, 'ready')
  assert.match(brief.prompt('roadmap'), /email \(assumed: the person chose to proceed on recommendations\)/, 'the authors build on the assumed option')
  assert.doesNotMatch(brief.prompt('save-answers'), /\(assumed|intake\.q1/, 'only what the person said is saved')
  assert.match(brief.prompt('save-answers'), /"id": "intake\.d1"/)
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p', on_question: 'assume', answers: given }, design({ intake: { questions: [Q] }, 'save-answers': { saved: true }, propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true } }))
  assert.doesNotMatch(concern.prompt('save-answers'), /\(assumed|intake\.q1/)
})

const savedStore = text => JSON.parse(text.match(/-----BEGIN ANSWERS-----\n([\s\S]*)\n-----END ANSWERS-----/)[1])

await test('brief-to-proposals: the Intake\'s assumptions are saved beside the answers and restored by a run that starts past the Intake', async () => {
  const TAKEN = 'INTAKE-ASSUMPTION: retention is 30 days'
  const KEEP = `Assumptions the Intake took that the person has not confirmed: keep each, or return a question to change it; never pick another value silently: ${JSON.stringify([TAKEN])}. `
  const judge = { scores: [{ sketch: 'validate-first', total: 26, notes: '' }], winner: 'validate-first', synthesis: SYNTHESIS, questions: [Q] }
  // Run 1: the Intake asks nothing and takes one thing as given; the judge asks, so the run stops after the Intake.
  const first = await run(WF, { ...BRIEF, panel: 1 }, design({ intake: { assumptions: [TAKEN] }, judge, 'save-answers': { saved: true } }, NO_DOCS))
  assert.equal(first.result.status, 'needs_input')
  assert.equal(first.result.resume_from, 'architecture')
  assert.deepEqual(first.labels.slice(0, 4), ['seed', 'existing-docs', 'intake', 'save-answers'], 'saved after the Intake, though no answer was given')
  assert.deepEqual(savedStore(first.prompt('save-answers')), { source: 'docs/brief.md', answers: [], assumptions: [TAKEN] })
  assert.equal(first.result.answers_saved, true)
  assert.ok(first.logs.includes('0 answer(s) and 1 assumption(s) of the Intake saved to the state branch (design/answers.json)'), first.logs.join('\n'))
  // Run 2, as the relay says (from: 'architecture', the answer): no Intake runs, and the survey hands the saved assumption back.
  const answers = [{ id: 'architecture.q1', question: Q.question, answer: 'email', date: '2026-11-13' }]
  const disk = { ...NO_DOCS, panel_synthesis: true, saved_assumptions: [TAKEN] }
  const second = await run(WF, { ...BRIEF, panel: 1, from: 'architecture', answers }, design({ 'save-answers': { saved: true },
    'review:architecture-1': { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'no rollback plan' }], completed: true } }, disk))
  assert.ok(!second.labels.includes('intake'))
  assert.match(second.prompt('existing-docs'), /and its assumptions array, when it has one, as saved_assumptions \(verbatim\)/)
  for (const l of ['roadmap', 'revise:architecture-1', 'propose:m2', 'propose:m5']) assert.ok(second.prompt(l).includes(KEEP), l)
  assert.equal(second.result.status, 'ready')
  assert.deepEqual(second.result.assumptions.filter(a => a.stage === 'intake'), [{ stage: 'intake', assumption: TAKEN }])
  assert.match(second.result.next_steps.find(s => s.startsWith('Before a doc is accepted')), /this result's assumptions \(1\)/)
  assert.ok(second.logs.some(l => l.startsWith('Restored 1 assumption(s) the Intake took')), second.logs.join('\n'))
  // The save of that run keeps them in the file, so the run after it finds them too.
  assert.deepEqual(savedStore(second.prompt('save-answers')).assumptions, [TAKEN])
  // A later run with nothing new to save (from: 'proposals', no answers passed) still gets them, and writes nothing back.
  const later = await run(WF, { ...BRIEF, from: 'proposals' }, design({}, { ...ON_DISK, saved_assumptions: [TAKEN] }))
  assert.ok(later.prompt('propose:m5').includes(KEEP))
  assert.ok(!later.labels.includes('save-answers'))
  assert.deepEqual(later.result.assumptions, [{ stage: 'intake', assumption: TAKEN }])
  // A run with an Intake finds its own: the saved ones are not added to it, and the new list replaces them in the file,
  // an empty one included.
  const again = await run(WF, { ...BRIEF, from: 'intake' }, design({ intake: { assumptions: ['NEW-ASSUMPTION'] }, 'save-answers': { saved: true } }, { ...ON_DISK, saved_assumptions: [TAKEN] }))
  assert.deepEqual(again.result.assumptions, [{ stage: 'intake', assumption: 'NEW-ASSUMPTION' }])
  assert.deepEqual(savedStore(again.prompt('save-answers')).assumptions, ['NEW-ASSUMPTION'])
  const none = await run(WF, { ...BRIEF, from: 'intake' }, design({ 'save-answers': { saved: true } }, { ...ON_DISK, saved_assumptions: [TAKEN] }))
  assert.deepEqual(savedStore(none.prompt('save-answers')).assumptions, [])
  // An Intake that took nothing, with nothing saved and no answer given: no save at all. A run that stops at the Intake saves
  // only when it was given answers (its re-run runs the Intake again).
  assert.ok(!(await run(WF, BRIEF, design({}, NO_DOCS))).labels.includes('save-answers'))
  assert.deepEqual((await run(WF, BRIEF, design({ intake: { questions: [Q], assumptions: [TAKEN] } }, NO_DOCS))).labels, ['seed', 'existing-docs', 'intake'])
  const stopGiven = await run(WF, { ...BRIEF, answers: [{ id: 'intake.d1', question: 'Which licence?', answer: 'MIT' }] }, design({ intake: { questions: [Q], assumptions: [TAKEN] } }, NO_DOCS))
  assert.deepEqual(stopGiven.labels, ['seed', 'existing-docs', 'intake', 'save-answers'])
  // on_question assume: what the run took at the Intake is an assumption in the file, never an answer.
  const assumed = await run(WF, { ...BRIEF, on_question: 'assume' }, design({ intake: { questions: [Q] }, 'save-answers': { saved: true } }, NO_DOCS))
  assert.deepEqual(savedStore(assumed.prompt('save-answers')), { source: 'docs/brief.md', answers: [], assumptions: [`${Q.question} -> email`] })
  // Every later author is told what limits the keeping: an answer outranks an assumption, and a person-owned one is asked.
  assert.match(second.prompt('roadmap'), /Two limits on keeping one\. An answer above outranks it: where an answer settles the same point, follow the answer\. And one that is a person-owned choice is a value nobody confirmed: a stage that returns questions returns it as a confirmation with that value recommended, and only a run the person told to proceed on assumptions takes it as it stands\./)
  // The Intake itself is told to keep person-owned choices out of its assumptions, and to sweep the classes the source never mentions.
  assert.match(first.prompt('intake'), /A class the source never mentions is not skipped: when the design must settle it and neither the framing nor an answer above does, return it as a blocking question\. /)
  assert.match(first.prompt('intake'), /In assumptions, list what you would otherwise take as given that the source does not state and that is yours to settle; never a person-owned choice: the value you would take for one is the recommended option of the question you return for it\. /)
})

await test('brief-to-proposals: an answer id is never reused: another question under a saved id, or the same id twice in args, stops the run before anything is saved', async () => {
  const saved = [
    { id: 'intake.d1', stage: 'intake', question: 'Licence: AGPL-3.0-only as the brief says?', answer: 'No: Apache-2.0', date: '2026-11-05' },
    { id: 'intake.d2', stage: 'intake', question: 'Who is it for?', answer: 'Agents', date: '2026-11-05' },
    { id: 'architecture.d1', stage: 'architecture', question: 'Hosting region', answer: 'EU only', date: '2026-11-06' }]
  const disk = { ...ON_DISK, saved_answers: saved }
  // A new session numbers its first correction intake.d1, which the state branch already holds for the licence.
  const reused = await run(WF, { ...BRIEF, answers: [{ id: 'intake.d1', question: 'Assumption corrected: retention', answer: '90 days' }] }, design({ 'save-answers': { saved: true } }, disk))
  assert.equal(reused.result.status, 'failed_at_start')
  assert.deepEqual(reused.labels, ['seed', 'existing-docs'], 'nothing is saved over the earlier answer, and no design agent runs')
  const why = reused.result.stop_reason
  assert.match(why, /^answer_id_reused: intake\.d1 \(passed for "Assumption corrected: retention", while design\/answers\.json holds it for "Licence: AGPL-3\.0-only as the brief says\?"\)\. An id is never reused, so nothing was saved or changed\. /)
  assert.match(why, /Pass a different question's answer under the next number not yet in use \(intake\.d3\), with its question; a newer answer to the same question keeps its id, is passed once, and carries the question text the earlier one had\. Ids in use: intake\.d1, intake\.d2, architecture\.d1$/)
  assert.ok(reused.logs.some(l => l.startsWith('Cannot start: answer_id_reused')))
  // Under the id it names, the same answer goes through, and the earlier ones are all still restored and saved back.
  const renumbered = await run(WF, { ...BRIEF, answers: [{ id: 'intake.d3', question: 'Assumption corrected: retention', answer: '90 days' }] }, design({ 'save-answers': { saved: true } }, disk))
  assert.equal(renumbered.result.status, 'ready')
  assert.deepEqual(renumbered.result.answers_restored, ['intake.d1', 'intake.d2', 'architecture.d1'])
  assert.deepEqual(savedStore(renumbered.prompt('save-answers')).answers.map(a => [a.id, a.answer]), [['intake.d3', '90 days'], ['intake.d1', 'No: Apache-2.0'], ['intake.d2', 'Agents'], ['architecture.d1', 'EU only']])
  assert.match(renumbered.prompt('propose:m5'), /No: Apache-2\.0/)
  // A question id is held the same way; the next free number counts the ids passed too.
  const qDisk = { ...ON_DISK, saved_answers: [{ id: 'm3.q1', question: 'Retry how often?', answer: 'twice' }] }
  const qReused = await run(WF, { ...BRIEF, answers: [{ id: 'm3.q1', question: 'Which queue?', answer: 'none' }, { id: 'm3.q4', question: 'Batch size?', answer: '50' }] }, design({}, qDisk))
  assert.equal(qReused.result.status, 'failed_at_start')
  assert.match(qReused.result.stop_reason, /next number not yet in use \(m3\.q5\)/)
  // A newer answer to the same question keeps the id: the question is the same whatever its case, spacing or punctuation,
  // and an entry passed without its question takes the saved one.
  for (const question of ['licence: AGPL-3.0-only  as the brief says', undefined]) {
    const newer = await run(WF, { ...BRIEF, answers: [{ id: 'intake.d1', question, answer: 'Yes: AGPL-3.0-only' }] }, design({ 'save-answers': { saved: true } }, disk))
    assert.equal(newer.result.status, 'ready', String(question))
    assert.equal(savedStore(newer.prompt('save-answers')).answers.find(a => a.id === 'intake.d1').answer, 'Yes: AGPL-3.0-only')
    assert.doesNotMatch(newer.prompt('propose:m5'), /No: Apache-2\.0/)
  }
  // The same id twice in args, with different answers or for different questions: neither binds, the run does not start.
  for (const answers of [
    [{ id: 'm5.q1', question: Q.question, answer: 'OLD-A' }, { id: 'm5.q1', question: Q.question, answer: 'NEW-B' }],
    [{ id: 'intake.d7', question: 'Retention?', answer: 'yes' }, { id: 'intake.d7', question: 'Billing by a paid provider?', answer: 'yes' }]]) {
    const twice = await run(WF, { ...BRIEF, answers }, design({ 'save-answers': { saved: true } }, disk))
    assert.equal(twice.result.status, 'failed_at_start', answers[0].id)
    assert.deepEqual(twice.labels, ['seed', 'existing-docs'])
    assert.ok(twice.result.stop_reason.startsWith(`answer_id_reused: ${answers[0].id} (args.answers holds it more than once, with different answers or questions). An id is never reused`), twice.result.stop_reason)
  }
  assert.match((await run(WF, { ...BRIEF, answers: [{ id: 'intake.d1', answer: 'A' }, { id: 'intake.d1', answer: 'B' }] }, design({}, disk))).result.stop_reason, /next number not yet in use \(intake\.d3\)/)
  // The same entry twice is one answer.
  const same = await run(WF, { ...BRIEF, answers: [{ id: 'm5.q1', answer: 'SAME' }, { id: 'm5.q1', question: Q.question, answer: 'SAME', date: '2026-11-13' }] }, design({ 'save-answers': { saved: true } }))
  assert.equal(same.result.status, 'ready')
  assert.deepEqual(savedStore(same.prompt('save-answers')).answers, [{ id: 'm5.q1', stage: 'm5', question: Q.question, answer: 'SAME', date: '2026-11-13' }])
  // Concern mode reads no saved copy: it still refuses an id passed twice.
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p', answers: [{ id: 'proposal.d1', answer: 'A' }, { id: 'proposal.d1', answer: 'B' }] }, design())
  assert.equal(concern.result.status, 'failed_at_start')
  assert.deepEqual(concern.labels, ['seed'])
  assert.match(concern.result.stop_reason, /^answer_id_reused: proposal\.d1 .*next number not yet in use \(proposal\.d2\)/)
})

await test('brief-to-proposals: a state branch that cannot be read is never written, and save_answers false neither saves nor restores', async () => {
  const answers = [{ id: 'm5.q1', question: Q.question, answer: 'email', date: '2026-11-13' }]
  // The read of design/answers.json failed (exit 2): what it holds is unknown, so a save could erase earlier answers.
  const unreadable = await run(WF, { ...BRIEF, answers }, design({}, { ...ON_DISK, answers_unreadable: true, notes: 'exit 2: could not reach origin' }))
  assert.match(unreadable.prompt('existing-docs'), /Set answers_unreadable true only when the read exits 2 \(the state branch could not be read: say why in notes\), and false otherwise\./)
  assert.ok(!unreadable.labels.includes('save-answers'), unreadable.labels.join(' '))
  assert.equal(unreadable.result.answers_saved, false)
  assert.equal(unreadable.result.status, 'ready')
  assert.ok(unreadable.logs.includes('The saved answers could not be read (design/answers.json on the state branch: exit 2: could not reach origin): none is restored, and this run saves none, so it cannot overwrite what is there'), unreadable.logs.join('\n'))
  // The same holds for the save after the Intake.
  const fresh = await run(WF, BRIEF, design({ intake: { assumptions: ['EU only'] } }, { ...NO_DOCS, answers_unreadable: true }))
  assert.ok(!fresh.labels.includes('save-answers'))
  assert.equal(fresh.result.answers_saved, false)
  // save_answers: false is the person's choice to keep the answers off the state branch: nothing is read, restored or saved
  // (the brief's file and the concern's), and the relay, the next steps and the result say so.
  const NOTE = "This run saves nothing to the state branch and restores nothing from it (save_answers: false): pass every answer given so far with each re-run, each with its question and date. " +
    "A re-run that starts past the Intake does not get the Intake's assumptions either: pass each one the person confirmed or corrected as an answer (intake.d<N>)."
  const disk = { ...ON_DISK, saved_answers: [{ id: 'architecture.q1', question: 'Hosted or self-run?', answer: 'SAVED-ARCH' }], saved_assumptions: ['SAVED-ASSUMPTION'] }
  const off = await run(WF, { ...BRIEF, save_answers: false, answers }, design({}, disk))
  assert.match(off.prompt('existing-docs'), /5\. Return saved_answers and saved_assumptions empty and answers_unreadable false: this run reads no saved answers \(save_answers: false\)\. /)
  assert.doesNotMatch(off.prompt('existing-docs'), /design\/answers\.json/)
  assert.ok(!off.labels.includes('save-answers'))
  for (const l of off.labels) assert.doesNotMatch(off.prompt(l), /SAVED-ARCH|SAVED-ASSUMPTION/, l)
  assert.equal(off.result.save_answers, false)
  assert.equal(off.result.answers_saved, undefined)
  assert.equal(off.result.answers_restored, undefined)
  assert.deepEqual(off.result.assumptions, [])
  assert.equal(off.result.next_steps.filter(s => s === NOTE).length, 1, off.result.next_steps.join('\n'))
  const asking = await run(WF, { ...BRIEF, save_answers: false }, design({ intake: { questions: [Q], assumptions: ['EU only'] } }, NO_DOCS))
  assert.deepEqual(asking.labels, ['seed', 'existing-docs', 'intake'])
  assert.ok(asking.result.relay.includes(NOTE), asking.result.relay)
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p', save_answers: false, answers: { 'proposal.q1': 'A' } }, design({ propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true } }))
  assert.ok(!concern.labels.includes('save-answers'))
  assert.equal(concern.result.save_answers, false)
  // Left out, or anything but false, the answers are saved and the result does not carry the field.
  const on = await run(WF, { ...BRIEF, answers }, design({ 'save-answers': { saved: true } }, disk))
  assert.ok(on.labels.includes('save-answers'))
  assert.equal(on.result.save_answers, undefined)
  assert.ok(!on.result.next_steps.some(s => /save_answers/.test(s)))
})

await test('brief-to-proposals: a milestones list is never cut by max_milestones, and the result names the milestones left without a proposal', async () => {
  // /start-product prints max_milestones: 1, so it is in "the same args" of every re-run: the relay's list of the milestones
  // that asked, with the one the person corrected, must still be proposed whole, or an answer goes unused.
  const disk = { ...ON_DISK, milestones: MILESTONES.map(m => m.n === 5 ? { ...m, proposal_exists: false } : m) }
  const answers = [{ id: 'm5.q1', question: Q.question, answer: 'ANSWER-M5' }, { id: 'm2.d1', question: 'File format: CSV only', answer: 'ANSWER-M2' }]
  const listed = await run(WF, { ...BRIEF, max_milestones: 1, from: 'proposals', milestones: [2, 5], answers }, design({}, disk))
  assert.deepEqual(proposed(listed.labels), ['propose:m2', 'propose:m5'])
  assert.match(listed.prompt('propose:m5'), /ANSWER-M5/)
  assert.deepEqual(listed.result.kept.map(k => k.milestone), [3])
  assert.deepEqual(listed.result.not_proposed, [])
  assert.equal(listed.result.status, 'ready')
  // max_milestones: 0 with a list proposes the list, and without one proposes nothing.
  assert.deepEqual(proposed((await run(WF, { ...BRIEF, max_milestones: 0, from: 'architecture', milestones: [3] }, design())).labels), ['propose:m3'])
  // A list that leaves a pending milestone unwritten, or a cap that does: the result names it, and a next step says how it
  // gets its proposal.
  const capped = await run(WF, { ...BRIEF, max_milestones: 1 }, design({}, NO_DOCS))
  assert.deepEqual(capped.result.not_proposed, [{ milestone: 3, title: 'Match', doc: PATH.m3 }, { milestone: 5, title: 'Alerts', doc: PATH.m5 }])
  assert.equal(capped.result.next_steps.find(s => s.startsWith('No proposal is written yet')),
    'No proposal is written yet for milestones 3 ("Match"), 5 ("Alerts") (not_proposed). Write each one when its milestone comes up, once the milestones before it have merged: ' +
    "re-run this workflow with the same args and from: 'proposals', with milestones: [N] (now [3]), which restores the person's saved answers; a bare /propose --milestone=N does not get them.")
  // max_milestones: 0 wrote none: the step says when the first is written, and no step says to build proposals that do not exist.
  const zero = await run(WF, { ...BRIEF, max_milestones: 0 }, design({}, NO_DOCS))
  assert.deepEqual(zero.result.not_proposed.map(m => m.milestone), [2, 3, 5])
  assert.match(zero.result.next_steps.find(s => s.startsWith('No proposal is written yet')),
    /^No proposal is written yet for milestones 2 \("Import"\), 3 \("Match"\), 5 \("Alerts"\) \(not_proposed\)\. Write the first once the person has confirmed the architecture and the roadmap, and each later one when its milestone comes up: re-run this workflow with the same args and from: 'proposals', with milestones: \[N\] \(now \[2\]\)/)
  assert.ok(!zero.result.next_steps.some(s => s.startsWith('Build each proposal')), zero.result.next_steps.join('\n'))
  assert.ok(capped.result.next_steps.some(s => s.startsWith('Build each proposal')))
  // That call, on the docs the run left: the listed milestone is written although max_milestones is still 0.
  assert.deepEqual(proposed((await run(WF, { ...BRIEF, max_milestones: 0, from: 'proposals', milestones: [2] }, design({}, { ...ON_DISK, milestones: WRITTEN.milestones }))).labels), ['propose:m2'])
  // A run that starts past the Proposals stage names them too; with every proposal written there is nothing to say.
  assert.deepEqual((await run(WF, { ...BRIEF, from: 'lint' }, design())).result.not_proposed.map(m => m.milestone), [5])
  const all = await run(WF, { ...BRIEF, from: 'proposals' }, design())
  assert.deepEqual(all.result.not_proposed, [])
  assert.ok(!all.result.next_steps.some(s => s.startsWith('No proposal is written yet')))
})

await test('brief-to-proposals: the judge\'s open questions are saved with the synthesis, and a re-run on assumptions takes the options the person was shown', async () => {
  const JQ = { question: 'Hosted for everyone,\n or self-run?', why: 'hosting opens an account in your name', options: ['hosted', 'self-run'], recommended: 'JUDGE-RECOMMENDED: self-run', confirm: true }
  const judge = { scores: [{ sketch: 'validate-first', total: 26, notes: '' }], winner: 'validate-first', synthesis: SYNTHESIS, questions: [JQ] }
  const asking = await run(WF, { ...BRIEF, panel: 1 }, design({ judge }, NO_DOCS))
  assert.equal(asking.result.status, 'needs_input')
  assert.ok(asking.prompt('save-panel').includes(`${SYNTHESIS}\n\n## Open questions for the person\n\n- Hosted for everyone, or self-run? Options: hosted | self-run. Recommended by the judge: JUDGE-RECOMMENDED: self-run\n-----END PANEL SYNTHESIS-----`), asking.prompt('save-panel'))
  // A judge that asks nothing saves the synthesis alone.
  assert.ok((await run(WF, { ...BRIEF, panel: 1 }, design({}, NO_DOCS))).prompt('save-panel').includes(`${SYNTHESIS}\n-----END PANEL SYNTHESIS-----`))
  // The re-run has no judge: /roadmap reads the section, and on assumptions takes the judge's option, not a pick of its own.
  const disk = { ...NO_DOCS, panel_synthesis: true }
  const READS = /Its "Open questions for the person" section, when it has one, lists what the panel's judge left open, each with the option the judge recommended, as the person was shown them: one that an answer above settles is settled by that answer; /
  const assumed = await run(WF, { ...BRIEF, panel: 1, from: 'architecture', on_question: 'assume' }, design({}, disk))
  assert.match(assumed.prompt('roadmap'), READS)
  assert.match(assumed.prompt('roadmap'), /settled by that answer; for each other one, take the option the judge recommended, tag the decision \(assumed\) and report it in assumptions\. /)
  const stop = await run(WF, { ...BRIEF, panel: 1, from: 'architecture' }, design({}, disk))
  assert.match(stop.prompt('roadmap'), READS)
  assert.match(stop.prompt('roadmap'), /settled by that answer; each other one is still a blocking question\. /)
  // The same run's /roadmap gets the synthesis in its prompt and the judge's questions as answers or assumptions: no section to read.
  assert.doesNotMatch((await run(WF, { ...BRIEF, panel: 1 }, design({}, NO_DOCS))).prompt('roadmap'), /Open questions for the person/)
})

await test('brief-to-proposals: an Intake that fails to report stops the run, and milestones that ask the same choice are asked once', async () => {
  const lost = await run(WF, { ...BRIEF, panel: 3, answers: [{ id: 'intake.d1', question: 'Which licence?', answer: 'MIT' }] }, design({ intake: null, 'save-answers': { saved: true } }, NO_DOCS))
  assert.equal(lost.result.status, 'failed_at_intake')
  assert.equal(lost.result.resume_from, 'intake')
  assert.equal(lost.result.stop_reason, 'the intake stage failed to report')
  assert.deepEqual(lost.labels, ['seed', 'existing-docs', 'intake', 'save-answers'], 'no panel, no /roadmap; the answers given are still saved')
  assert.ok(lost.result.seeded)
  assert.equal(lost.result.next_steps[0], "Re-run with the same args and from: 'intake' (this result's resume_from): nothing was designed, and the docs on disk are as they were.")
  assert.match(lost.result.next_steps[1], SEED_NOTE)
  assert.ok(lost.logs.includes('The Intake failed to report: stopping before any design is written without its questions'))
  assert.ok(!lost.logs.some(l => l.startsWith('Intake: no blocking questions')))
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p' }, design({ intake: null }))
  assert.equal(concern.result.status, 'failed_at_intake')
  assert.equal(concern.result.resume_from, undefined)
  assert.deepEqual(concern.labels, ['seed', 'intake'])
  assert.match(concern.result.next_steps[0], /^Re-run with the same args: nothing was designed/)
  // Sibling authors run at the same time and none sees another's question: the relay says what to do with a repeat.
  const ONCE = 'Questions from different milestones that ask the same choice are one question to the person: ask it once, and pass the one answer back under each of their ids. '
  const none = { ...ON_DISK, milestones: MILESTONES.map(m => ({ ...m, proposal_exists: false })) }
  const siblings = await run(WF, { ...BRIEF, from: 'proposals' }, design({ 'propose:m2': { questions: [Q] }, 'propose:m3': { questions: [Q] }, 'propose:m5': { questions: [Q] } }, none))
  assert.deepEqual(siblings.result.questions.map(q => q.id), ['m2.q1', 'm3.q1', 'm5.q1'])
  assert.ok(siblings.result.relay.includes(ONCE), siblings.result.relay)
  assert.ok(!(await run(WF, { ...BRIEF, from: 'proposals' }, design({ 'propose:m5': { questions: [Q] } }))).result.relay.includes(ONCE), 'one milestone asked: nothing to merge')
})

process.exit(failed ? 1 : 0)

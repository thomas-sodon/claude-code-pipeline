// Behavioural tests for brief-to-proposals' resumable design: where a run starts (args.from, or inferred from the answers and
// the docs on disk), what it keeps, its checkpoints on a design branch, the panel synthesis and the person's answers kept on
// the state branch, the pairwise Consistency phase, the context file, and how the run asks the person instead of choosing for
// them (the judge's questions, answers applied to existing docs, what nobody confirmed). The workflow body runs against
// scripted mock agents: a responder picks the reply by the agent's label, and every prompt is recorded so the tests can check
// which stages ran and what each was told.
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
  const noop = () => {}
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'workflow', 'phase', 'log', src)(
    args, agent, parallel, pipeline, workflow || (async () => { throw new Error('no nested workflow in this test') }), noop, noop)
  const labels = calls.map(c => c.label)
  return { result, calls, labels, prompt: label => (calls.find(c => c.label === label) || {}).prompt || '' }
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
  assert.doesNotMatch(prompt('propose:m5'), /ANSWER-M3/, 'a milestone answer reaches only its milestone')
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
  assert.match(revisers.find(c => c.prompt.includes(`--revise ${PATH.roadmap}`)).prompt, /Coverage gap: the CSV export/)
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
  for (const l of ['seed', 'save-panel', 'milestones', 'lint']) assert.doesNotMatch(prompt(l), /notes\/builder\.md/, l)
  // The survey names it only to check that it exists (and to restore it): it is told never to read it.
  assert.match(prompt('existing-docs'), /context_exists: whether notes\/builder\.md exists .* Never read it, and never copy any of its text/)
  // Concern mode too.
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p', context_file: 'notes/builder.md' }, design())
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
    assert.match(prompt(l), /Framing from the person, binding\. Where the source, the tree or research contradicts it, pick no side: return a blocking question naming both\. The framing: CTX-TEXT/, l)
    assert.match(prompt(l), /framing from the person, binding\. Where the source, the tree or research contradicts it, pick no side/, l)
  }
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
  // The source still wins over a synthesis nobody confirmed; what the synthesis leaves open is asked.
  assert.match(prompt('roadmap'), /where it contradicts the source, the source wins and you say so/)
  assert.match(prompt('roadmap'), /An open question the synthesis leaves for the person is a blocking question, never a D-record to confirm later/)
  assert.match(prompt('roadmap'), /Every departure from the synthesis is listed, with its reason, in assumptions; where the framing or an answer confirms the synthesis or one of its choices, a departure from it is a blocking question/)
  const reused = await run(WF, { ...BRIEF, panel: 3, from: 'architecture' }, design({}, { ...NO_DOCS, panel_synthesis: true }))
  assert.match(reused.prompt('roadmap'), /they win and you say so\)\. An open question the synthesis leaves for the person is a blocking question/)
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
    { id: 'm3.q1', stage: 'm3', question: 'Retry how often?', answer: 'A3', date: '' }] })
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
  // Concern mode saves after the seed, under the source "concern".
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p', answers: { 'proposal.q1': 'AP' } }, design({ propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true } }))
  assert.deepEqual(concern.labels.slice(0, 3), ['seed', 'save-answers', 'intake'])
  assert.match(concern.prompt('save-answers'), /"source": "concern"/)
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
  assert.match(missing.prompt('existing-docs'), /pipeline-state\.py get context\/builder-context\.md --to notes\/builder\.md \(the one write this stage may make/)
  assert.match(missing.prompt('existing-docs'), /Read-only but for the one restore step 6 allows/)
  // Restored: the run goes on.
  const back = await run(WF, args, design({}, { ...NO_DOCS, context_exists: true, context_restored: true }))
  assert.equal(back.result.status, 'ready')
  assert.ok(back.labels.includes('intake'))
  // With no context_file nothing is restored or required.
  const none = await run(WF, BRIEF, design({}, { ...NO_DOCS, context_exists: false }))
  assert.equal(none.result.status, 'ready')
  assert.doesNotMatch(none.prompt('existing-docs'), /builder-context/)
  assert.match(none.prompt('existing-docs'), /Read-only: change no file and no git state/)
})

await test('brief-to-proposals: results that stop early carry the assumptions, and a blocked architecture review hands the person the ways forward', async () => {
  const finding = { findings: [{ doc: PATH.roadmap, severity: 'concern', description: 'no rollback plan' }], completed: true }
  const blocked = await run(WF, { ...BRIEF, from: 'architecture', max_review_rounds: 1 }, design({
    'review:architecture-1': finding, 'review:architecture-2': finding, 'revise:architecture-1': { summary: 'tried', assumptions: ['took weekly backups'] } }))
  const r = blocked.result
  assert.equal(r.status, 'blocked_at_architecture_review')
  assert.deepEqual(r.assumptions, [{ stage: 'architecture', assumption: 'took weekly backups' }])
  assert.match(r.relay, /Show the person architecture_review\.findings_remaining/)
  assert.match(r.relay, /never choose for them/)
  assert.equal(r.next_steps.length, 3)
  assert.match(r.next_steps[0], /from: 'architecture', with max_review_rounds above 1/)
  assert.match(r.next_steps[1], /scope, money, legal posture, data handling, a departure from what they said.*architecture\.d<N>, with the finding as its question.*from: 'architecture'/)
  assert.match(r.next_steps[2], /from: 'proposals', accepting the findings that remain/)
  for (const s of r.next_steps) assert.ok(r.relay.includes(s), s)
  assert.equal(r.architecture_review.findings_remaining.length, 1)
  const noRoadmap = await run(WF, BRIEF, design({ intake: { assumptions: ['EU only'] }, roadmap: { stopped: true, stop_reason: 'error=source_too_vague' } }, NO_DOCS))
  assert.equal(noRoadmap.result.status, 'failed_at_roadmap')
  assert.deepEqual(noRoadmap.result.assumptions, [{ stage: 'intake', assumption: 'EU only' }])
  const noReview = await run(WF, BRIEF, design({ intake: { assumptions: ['EU only'] }, 'review:architecture-1': { findings: [], completed: false } }, NO_DOCS))
  assert.equal(noReview.result.status, 'review_failed')
  assert.deepEqual(noReview.result.assumptions, [{ stage: 'intake', assumption: 'EU only' }])
})

await test('brief-to-proposals: resuming at the architecture applies the person\'s answers to the existing docs before the review', async () => {
  const answers = [{ id: 'intake.d1', question: 'Which licence variant?', answer: 'AGPL-3.0-only', date: '2026-11-05' }, { id: 'architecture.q1', answer: 'ANSWER-ARCH' }, { id: 'm3.q1', answer: 'ANSWER-M3' }]
  const { result, labels, prompt } = await run(WF, { ...BRIEF, from: 'architecture', answers }, design())
  assert.ok(labels.includes('revise:architecture-answers'))
  assert.ok(labels.indexOf('revise:architecture-answers') < labels.indexOf('review:architecture-1'))
  assert.ok(!labels.includes('roadmap'))
  const p = prompt('revise:architecture-answers')
  assert.match(p, /skill "propose" with args "--revise <doc>"/)
  assert.match(p, /tag each decision an answer settles \(person, <the answer's date, or today's when it has none>, <the answer's id>\)/)
  assert.match(p, /When the docs already reflect every answer, write nothing/)
  assert.match(p, /Edit only docs\/design\/architecture\.md and docs\/design\/roadmap\.md/)
  for (const s of ['"id": "intake.d1"', 'Which licence variant?', '"date": "2026-11-05"', 'ANSWER-ARCH', 'QUESTIONS: this stage runs unattended']) assert.ok(p.includes(s), s)
  assert.doesNotMatch(p, /ANSWER-M3/, 'a milestone\'s answer is not the architecture\'s to apply')
  assert.equal(result.status, 'ready')
  assert.equal(result.architecture_review.revise_rounds, 0, 'applying the answers is not a review round')
  // Its question stops the run like any reviser's: after the Architecture checkpoint, before the review.
  const asking = await run(WF, { ...BRIEF, branch: 'design/20261110', from: 'architecture', answers }, design({ 'revise:architecture-answers': { questions: [Q], assumptions: ['kept the old name'] } }))
  assert.equal(asking.result.status, 'needs_input')
  assert.deepEqual(asking.result.questions.map(q => q.id), ['architecture.q2'])
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
  assert.match(prompt('lint'), /proposal-lint\.py <doc> --decisions on docs\/design\/architecture\.md and each proposal/)
  assert.match(prompt('lint'), /return in unconfirmed every record of its unconfirmed list .* and in proposed every entry of its proposed list/)
  assert.deepEqual(result.lint.unconfirmed.map(u => u.id), ['D3', 'D1'])
  const i = result.next_steps.findIndex(s => s.startsWith('Before a doc is accepted'))
  assert.ok(i >= 0 && i < result.next_steps.findIndex(s => s.startsWith('Read and edit the docs')), result.next_steps.join('\n'))
  const step = result.next_steps[i]
  assert.match(step, /lint\.unconfirmed \(2 decision\(s\) no person confirmed: D3 "Data store" in docs\/design\/architecture\.md; D1 "File format" in docs\/design\/01-import\.md\)/)
  assert.match(step, /lint\.proposed \(1 value\(s\) an author proposed\), and ask them to confirm or correct each/)
  assert.match(step, /\(architecture\.d<N>, or m<N>\.d<K> with milestones: \[N\], its question naming the decision by title\) with from set to that stage, or through the refresh-proposal workflow on the one doc; the revise tags the decision \(person, <date>\)/)
  // The run's assumptions alone call for the step; with nothing unconfirmed there is none.
  const assumedOnly = await run(WF, BRIEF, design({ intake: { assumptions: ['EU only'] } }, NO_DOCS))
  assert.match(assumedOnly.result.next_steps.find(s => s.startsWith('Before a doc is accepted')), /this result's assumptions \(1\)/)
  const clean = await run(WF, { ...BRIEF, from: 'lint' }, design())
  assert.ok(!clean.result.next_steps.some(s => s.startsWith('Before a doc is accepted')))
  // Concern mode has no architecture: the decisions are read from the proposal alone.
  const concern = await run(WF, { concern: 'big change', dir: '/abs/p' }, design({ propose: { doc: 'docs/design/big-change.md', steps: 3, lint_clean: true }, lint: { ...lint, unconfirmed: [], proposed: lint.proposed } }))
  assert.match(concern.prompt('lint'), /--decisions on each proposal/)
  assert.match(concern.result.next_steps.find(s => s.startsWith('Before a doc is accepted')), /through the refresh-proposal workflow on the doc/)
})

process.exit(failed ? 1 : 0)

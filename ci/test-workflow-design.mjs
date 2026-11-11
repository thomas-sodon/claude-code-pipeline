// Behavioural tests for brief-to-proposals' resumable design: where a run starts (args.from, or inferred from the answers and
// the docs on disk), what it keeps, its checkpoints on a design branch, the panel synthesis kept on the state branch, the
// pairwise Consistency phase and the context file. The workflow body runs against scripted mock agents: a responder picks the
// reply by the agent's label, and every prompt is recorded so the tests can check which stages ran and what each was told.
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
const ON_DISK = { brief_exists: true, out_dir: 'docs/design', architecture: PATH.arch, roadmap: PATH.roadmap, architecture_exists: true, roadmap_exists: true, milestones: MILESTONES, panel_synthesis: false }
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
  for (const l of ['seed', 'existing-docs', 'save-panel', 'milestones', 'lint']) assert.doesNotMatch(prompt(l), /notes\/builder\.md/, l)
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

process.exit(failed ? 1 : 0)

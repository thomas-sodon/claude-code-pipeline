// Behavioural tests for how the workflows surface blocking questions (status needs_input) instead of guessing.
// Each workflow body runs against scripted mock agents: a responder picks the reply by the agent's label, and every
// prompt is recorded so the tests can check which stages saw which answers.
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
  return { result, calls, prompt: label => (calls.find(c => c.label === label) || {}).prompt || '' }
}

const Q = { question: 'Should the cache be per process or shared?', why: 'per process needs no new service; shared needs Redis', options: ['per process', 'shared (Redis)'], recommended: 'per process' }
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`) }
}

// ---- plan-to-merged-pr: a happy path through build-only mode, with hooks to make one stage ask.
const ptmp = (ask, extra = {}) => (label) => {
  if (ask && label.startsWith(ask)) return { questions: [Q] }
  if (label === 'plan') return { branch: 'feat/x', plan: 'the plan' }
  if (label === 'impl') return { summary: 'done', files_changed: ['a.js'], gates_green: true }
  if (label.startsWith('review-changes')) return { findings: label.endsWith('-1') ? [{ file: 'a.js', severity: 'bug', description: 'b' }] : [], completed: true }
  if (label.startsWith('apply-review-fixes')) return { summary: 'fixed', gates_green: true }
  if (label.startsWith('polish')) return { issues_found_and_fixed: 0, summary: '', gates_green: true }
  if (label === 'merge-check') return { merge_check: 'clean', gates_green: true, pushed: true, pushed_sha: 'abc1234567' }
  return extra[label] || {}
}

await test('plan-to-merged-pr: a planner question stops the run before any later stage', async () => {
  const { result, calls } = await run('plan-to-merged-pr', { concern: 'cache prices', ship: false }, ptmp('plan'))
  assert.equal(result.status, 'needs_input')
  assert.equal(result.stage, 'plan')
  assert.deepEqual(result.questions.map(q => q.id), ['plan.q1'])
  assert.match(result.relay, /never answer them on their behalf/)
  assert.deepEqual(calls.map(c => c.label), ['plan'])
})

await test('plan-to-merged-pr: impl, fix and merge-check questions stop at their own stage', async () => {
  for (const [stage, label] of [['impl', 'impl'], ['fix', 'apply-review-fixes'], ['merge_check', 'merge-check']]) {
    const { result, calls } = await run('plan-to-merged-pr', { concern: 'c', ship: false }, ptmp(label))
    assert.equal(result.status, 'needs_input', stage)
    assert.equal(result.stage, stage)
    assert.equal(result.questions[0].id, `${stage}.q1`)
    assert.ok(calls.at(-1).label.startsWith(label), `${stage}: nothing ran after the stage that asked`)
  }
})

await test('plan-to-merged-pr: every stage prompt that can ask carries the questions rule', async () => {
  const { result, prompt } = await run('plan-to-merged-pr', { concern: 'c', ship: false }, ptmp(null))
  assert.equal(result.status, 'pushed')
  for (const l of ['plan', 'impl', 'apply-review-fixes-1', 'merge-check']) assert.match(prompt(l), /QUESTIONS: this stage runs unattended/, l)
  assert.match(prompt('plan'), /return every such question/)
})

await test('plan-to-merged-pr: an answer reaches the stage that asked and later ones, never earlier ones', async () => {
  const answers = [{ id: 'fix.q1', question: Q.question, answer: 'ANSWER-FIX' }]
  const { result, prompt } = await run('plan-to-merged-pr', { concern: 'c', ship: false, answers }, ptmp(null))
  assert.equal(result.status, 'pushed')
  assert.doesNotMatch(prompt('plan'), /ANSWER-FIX/)
  assert.doesNotMatch(prompt('impl'), /ANSWER-FIX/)
  for (const l of ['review-changes-1', 'apply-review-fixes-1', 'polish-1', 'merge-check']) assert.match(prompt(l), /ANSWER-FIX/, l)
  const planAns = await run('plan-to-merged-pr', { concern: 'c', ship: false, answers: { 'plan.q1': 'ANSWER-PLAN' } }, ptmp(null))
  for (const l of ['plan', 'impl', 'merge-check']) assert.match(planAns.prompt(l), /ANSWER-PLAN/, l)
})

await test('plan-to-merged-pr: on_question assume tells stages to proceed and collects their assumptions', async () => {
  const respond = label => label === 'plan' ? { branch: 'feat/x', plan: 'p', assumptions: ['per process -> taken'] } : ptmp(null)(label)
  const { result, prompt } = await run('plan-to-merged-pr', { concern: 'c', ship: false, on_question: 'assume' }, respond)
  assert.equal(result.status, 'pushed')
  assert.match(prompt('plan'), /proceed on assumptions/)
  assert.doesNotMatch(prompt('plan'), /return every such question/)
  assert.deepEqual(result.assumptions, [{ stage: 'plan', assumption: 'per process -> taken' }])
})

// ---- brief-to-proposals
const btp = (over = {}) => (label, prompt) => {
  if (over[label] !== undefined) return typeof over[label] === 'function' ? over[label](prompt) : over[label]
  if (label === 'seed') return { copied: 1, claude_md: 'written' }
  if (label === 'roadmap' || label === 'milestones') return {
    out_dir: 'docs/design', architecture: 'docs/design/architecture.md', roadmap: 'docs/design/roadmap.md', lint_clean: true,
    milestones: [{ n: 1, title: 'Bootstrap', done: false, human_gate: 'ops', proposal: '' },
      { n: 2, title: 'A', done: false, human_gate: '', proposal: '01-a.md' }, { n: 3, title: 'B', done: false, human_gate: '', proposal: '02-b.md' }],
  }
  if (label.startsWith('propose:m')) return { doc: `docs/design/${label.slice(9)}.md`, steps: 3, lint_clean: true }
  if (label.startsWith('review:')) return { findings: [], completed: true }
  if (label === 'consistency') return { findings: [], coverage_gaps: [] }
  if (label === 'lint') return { docs: [], lanes: [], next_milestones: [] }
  return {}
}
const BRIEF = { brief: 'brief.md', dir: '/abs/p', panel: 0 }

await test('brief-to-proposals: an intake question stops the run before any design is written', async () => {
  const { result, calls } = await run('brief-to-proposals', BRIEF, btp({ intake: { questions: [Q] } }))
  assert.equal(result.status, 'needs_input')
  assert.deepEqual(result.questions.map(q => q.id), ['intake.q1'])
  assert.deepEqual(calls.map(c => c.label), ['seed', 'intake'])
  assert.ok(result.seeded)
})

await test('brief-to-proposals: on_question assume turns intake recommendations into shared answers', async () => {
  const { result, prompt } = await run('brief-to-proposals', { ...BRIEF, on_question: 'assume' }, btp({ intake: { questions: [Q] } }))
  assert.equal(result.status, 'ready')
  for (const l of ['roadmap', 'propose:m2', 'review:m3-1', 'consistency']) assert.match(prompt(l), /per process \(assumed/, l)
  assert.ok(result.assumptions.some(a => a.stage === 'intake' && a.assumption.includes('per process')))
})

await test('brief-to-proposals: a roadmap question stops before any proposal', async () => {
  const { result, calls } = await run('brief-to-proposals', BRIEF, btp({ roadmap: { questions: [Q] } }))
  assert.equal(result.status, 'needs_input')
  assert.equal(result.questions[0].id, 'architecture.q1')
  assert.ok(!calls.some(c => c.label.startsWith('propose')))
})

await test('brief-to-proposals: one milestone asking lets the others finish and skips Consistency', async () => {
  const { result, calls } = await run('brief-to-proposals', BRIEF, btp({ 'propose:m2': { questions: [Q] } }))
  assert.equal(result.status, 'needs_input')
  assert.deepEqual(result.questions.map(q => q.id), ['m2.q1'])
  assert.ok(calls.some(c => c.label === 'review:m3-1'), 'milestone 3 was still reviewed')
  assert.ok(!calls.some(c => c.label === 'consistency'), 'Consistency waits on the answers')
  assert.equal(result.proposals.find(p => p.milestone === 2).needs_input, true)
  assert.match(result.next_steps[0], /answer the 1 question/)
})

await test('brief-to-proposals: a milestone answer reaches only that milestone and Consistency', async () => {
  const answers = [{ id: 'm2.q1', answer: 'ANSWER-M2' }]
  const { result, prompt } = await run('brief-to-proposals', { ...BRIEF, answers }, btp())
  assert.equal(result.status, 'ready')
  for (const l of ['intake', 'roadmap', 'review:architecture-1', 'propose:m3', 'review:m3-1']) assert.doesNotMatch(prompt(l), /ANSWER-M2/, l)
  for (const l of ['propose:m2', 'review:m2-1', 'consistency']) assert.match(prompt(l), /ANSWER-M2/, l)
})

await test('brief-to-proposals: a reviser that needs the person\'s call stops the architecture loop', async () => {
  const over = { 'review:architecture-1': { findings: [{ doc: 'docs/design/roadmap.md', severity: 'concern', description: 'brief is silent on X' }], completed: true },
    'revise:architecture-1': { questions: [Q] } }
  const { result, calls } = await run('brief-to-proposals', BRIEF, btp(over))
  assert.equal(result.status, 'needs_input')
  assert.equal(result.questions[0].id, 'architecture.q1')
  assert.ok(!calls.some(c => c.label === 'review:architecture-2'))
})

await test('brief-to-proposals: concern mode stops on a /propose question', async () => {
  const { result } = await run('brief-to-proposals', { concern: 'big change', dir: '/abs/p' }, btp({ propose: { questions: [Q] } }))
  assert.equal(result.status, 'needs_input')
  assert.equal(result.questions[0].id, 'proposal.q1')
})

// ---- proposal-build-chain and bug-fix-backlog carry a lane's questions up, and route answers per lane
await test('proposal-build-chain: a lane that needs input carries its questions, tagged with the lane, and gets only its answers', async () => {
  const seen = []
  const workflow = async (name, a) => {
    seen.push(a)
    return a.branch === 'feat/b' ? { status: 'needs_input', questions: [{ id: 'impl.q1', ...Q }] } : { status: 'pushed' }
  }
  const lanes = [{ key: 'a', dir: '/w/a', branch: 'feat/a', proposal: 'p.md', concern: 'ca' }, { key: 'b', dir: '/w/b', branch: 'feat/b', proposal: 'p.md', concern: 'cb', bases: ['feat/a'] }]
  const answers = [{ lane: 'b', id: 'plan.q1', answer: 'for b' }, { lane: 'a', id: 'plan.q1', answer: 'for a' }]
  const { result } = await run('proposal-build-chain', { lanes, answers, on_question: 'stop' }, () => ({}), { workflow })
  assert.equal(result[1].status, 'needs_input')
  assert.deepEqual(result[1].questions.map(q => [q.lane, q.id]), [['b', 'impl.q1']])
  assert.match(result[1].relay, /same args/)
  assert.deepEqual(seen[0].answers, [{ id: 'plan.q1', answer: 'for a' }])
  assert.deepEqual(seen[1].answers, [{ id: 'plan.q1', answer: 'for b' }])
  assert.equal(seen[0].on_question, 'stop')
})

process.exit(failed ? 1 : 0)

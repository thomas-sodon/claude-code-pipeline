// Behavioural tests for how the workflows surface blocking questions (status needs_input) instead of guessing, for
// ship-chain's merge-order sequencing, and for how plan-to-merged-pr hands a PR back to the person (resume_monitor, closeout).
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

// ---- plan-to-merged-pr: the monitor's hand-off (resume_monitor) and the close-out check after a merge
const OBS = { pr_state: 'OPEN', head_sha: 'abcdef1234', ai_review_done_on_head: true, ci_state: 'green', ci_configured: true }
const MON = { pr: 7, branch: 'feat/x', dir: '/w/x', plan_text: 'the plan', main_branch: 'trunk' }
await test('plan-to-merged-pr: a settled hand-off carries the monitor-only args and a one-line handoff', async () => {
  const { result, calls } = await run('plan-to-merged-pr', MON, label => label.startsWith('observe') ? OBS : {})
  assert.equal(result.status, 'OPEN')
  assert.deepEqual(result.resume_monitor, MON)
  assert.match(result.handoff, /settled/)
  assert.match(result.handoff, /monitor-only/)
  assert.doesNotMatch(result.handoff, /\n/)
  assert.ok(!calls.some(c => c.label === 'closeout'))
})

await test('plan-to-merged-pr: red CI not ours and the round cap both hand off with resume_monitor', async () => {
  const red = await run('plan-to-merged-pr', MON, label => label.startsWith('observe') ? { ...OBS, ci_state: 'red' } : {})
  assert.match(red.result.handoff, /outside this PR/)
  assert.equal(red.result.resume_monitor.pr, 7)
  const cap = await run('plan-to-merged-pr', { ...MON, max_monitor_rounds: 2 }, label => label.startsWith('observe') ? { ...OBS, ci_state: 'pending' } : {})
  assert.match(cap.result.handoff, /2-round cap/)
  assert.equal(cap.result.resume_monitor.max_monitor_rounds, 2)
})

await test('plan-to-merged-pr: a merged PR with a proposal reports the close-out edits without making them', async () => {
  const edits = [{ file: 'docs/design/x.md', line: 3, before: 'Status: in-progress', after: 'Status: done' }]
  const respond = label => label.startsWith('observe') ? { ...OBS, pr_state: 'MERGED' }
    : label === 'closeout' ? { checked: true, proposal_complete: true, edits, next_milestone: [{ n: 3, title: 'Go / no-go' }], roadmap: 'docs/design/roadmap.md' } : {}
  const { result, prompt } = await run('plan-to-merged-pr', { ...MON, proposal: 'docs/design/x.md' }, respond)
  assert.equal(result.status, 'MERGED')
  assert.deepEqual(result.closeout, { proposal_complete: true, edits, next_milestone: [{ n: 3, title: 'Go / no-go' }], roadmap: 'docs/design/roadmap.md' })
  assert.equal(result.resume_monitor, undefined)
  assert.match(prompt('closeout'), /WITHOUT making any of them/)
  assert.match(prompt('closeout'), /origin\/trunk/)
  const partial = await run('plan-to-merged-pr', { ...MON, proposal: 'docs/design/x.md' },
    label => label === 'closeout' ? { checked: true, proposal_complete: false, pending_steps: [4] } : respond(label))
  assert.deepEqual(partial.result.closeout, { proposal_complete: false, pending_steps: [4] })
  const none = await run('plan-to-merged-pr', MON, respond)
  assert.ok(!none.calls.some(c => c.label === 'closeout'), 'no proposal, no close-out check')
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

await test('brief-to-proposals: next steps say to re-review each later proposal before accepting it', async () => {
  const { result } = await run('brief-to-proposals', BRIEF, btp())
  const step = result.next_steps.find(s => s.includes('/review-proposal'))
  assert.ok(step, 'a re-review step')
  assert.match(step, /after the first \(docs\/design\/3\.md\)/)
  assert.match(step, /max_milestones: 1/)
  const one = await run('brief-to-proposals', { ...BRIEF, max_milestones: 1 }, btp())
  assert.ok(!one.result.next_steps.some(s => s.includes('/review-proposal')), 'one proposal needs no re-review step')
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

// ---- ship-chain: ships a ship_plan chain lane by lane, each only after the PR below it reads MERGED
const CHAIN = { chain: 's1', order: [
  { lane: 's1', branch: 'feat/p-s1', steps: [1], args: { ship_only: true, branch: 'feat/p-s1', dir: '/w/s1', title: '<title for steps 1>', proposal: 'p.md', main_branch: 'main' } },
  { lane: 's2', branch: 'feat/p-s2', steps: [2], args: { ship_only: true, branch: 'feat/p-s2', dir: '/w/s2', title: '<title for steps 2>', proposal: 'p.md', main_branch: 'main', predecessor_prs: ['<PR numbers of the lanes above, once merged>'] } },
] }
const sc = (over = {}) => (label, prompt) => {
  if (over[label] !== undefined) return typeof over[label] === 'function' ? over[label](prompt) : over[label]
  if (label.startsWith('lookup-')) return { state: 'NONE', pr_number: 0, title: `Title ${label.slice(7)}` }
  if (label.startsWith('wait-')) return { state: 'MERGED' }
  return {}
}
const shipWf = (byBranch, seen = []) => async (name, a) => {
  seen.push({ name, ...a })
  const f = byBranch[a.branch]
  return typeof f === 'function' ? f(a) : f
}

await test('ship-chain: ships each lane after the one below merged, with predecessor_prs and a filled title', async () => {
  const seen = []
  const workflow = shipWf({ 'feat/p-s1': { status: 'OPEN', pr: { pr_number: 10 } }, 'feat/p-s2': { status: 'OPEN', pr: { pr_number: 11 } } }, seen)
  const { result, calls, prompt } = await run('ship-chain', { chain: CHAIN, title_prefix: '[p] ', ai_review_check: 'Review' }, sc(), { workflow })
  assert.equal(result.status, 'merged')
  assert.deepEqual(result.merged_prs, [10, 11])
  assert.deepEqual(calls.map(c => c.label), ['lookup-s1', 'wait-s1-1', 'lookup-s2', 'wait-s2-1'])
  assert.match(prompt('lookup-s1'), /steps 1 under "## Steps" in p\.md/)
  assert.deepEqual(seen.map(s => s.name), ['plan-to-merged-pr', 'plan-to-merged-pr'])
  assert.equal(seen[0].ship_only, true)
  assert.equal(seen[0].title, '[p] Title s1')
  assert.equal(seen[0].predecessor_prs, undefined)
  assert.equal(seen[0].ai_review_check, 'Review')
  assert.deepEqual(seen[1].predecessor_prs, [10])
  for (const l of ['lookup-s1', 'wait-s1-1']) assert.match(prompt(l), /Never merge/, l)
})

await test('ship-chain: a lane that needs input stops the chain, carries its questions tagged with the lane, and gets only its answers', async () => {
  const seen = []
  const workflow = shipWf({ 'feat/p-s1': { status: 'MERGED', pr: { pr_number: 10 } }, 'feat/p-s2': { status: 'needs_input', stage: 'merge_check', questions: [{ id: 'merge_check.q1', ...Q }] } }, seen)
  const answers = [{ lane: 's1', id: 'monitor.q1', answer: 'for s1' }, { lane: 's2', id: 'plan.q1', answer: 'for s2' }]
  const { result, calls } = await run('ship-chain', { chain: CHAIN, answers }, sc(), { workflow })
  assert.equal(result.status, 'needs_input')
  assert.deepEqual(result.questions.map(q => [q.lane, q.id]), [['s2', 'merge_check.q1']])
  assert.match(result.relay, /never answer them on their behalf/)
  assert.equal(result.stopped_at.lane, 's2')
  assert.deepEqual(seen[0].answers, [{ id: 'monitor.q1', answer: 'for s1' }])
  assert.deepEqual(seen[1].answers, [{ id: 'plan.q1', answer: 'for s2' }])
  assert.ok(!calls.some(c => c.label.startsWith('wait-')), 'a PR that merged during its monitor is not waited on')
})

await test('ship-chain: a re-run skips merged lanes and monitors an already-open PR instead of opening another', async () => {
  const seen = []
  const workflow = shipWf({ 'feat/p-s2': { status: 'OPEN', pr: { pr_number: 11 } } }, seen)
  const over = { 'lookup-s1': { state: 'MERGED', pr_number: 10, title: 'x' }, 'lookup-s2': { state: 'OPEN', pr_number: 11, title: 'y' } }
  const { result } = await run('ship-chain', { chain: CHAIN }, sc(over), { workflow })
  assert.equal(result.status, 'merged')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].pr, 11)
  assert.equal(seen[0].ship_only, undefined)
  assert.equal(seen[0].title, undefined)
})

await test('ship-chain: stops on a closed PR, a PR still open at the wait cap, or a lane that did not ship', async () => {
  const two = { 'feat/p-s1': { status: 'OPEN', pr: { pr_number: 10 } }, 'feat/p-s2': { status: 'OPEN', pr: { pr_number: 11 } } }
  const closed = await run('ship-chain', { chain: CHAIN }, sc({ 'wait-s1-1': { state: 'CLOSED' } }), { workflow: shipWf(two) })
  assert.equal(closed.result.status, 'closed')
  assert.deepEqual(closed.result.not_shipped, ['s2'])
  const open = await run('ship-chain', { chain: CHAIN, max_wait_rounds: 2 }, sc({ 'wait-s1-1': { state: 'OPEN' }, 'wait-s1-2': { state: 'OPEN', notes: 'changes requested' } }), { workflow: shipWf(two) })
  assert.equal(open.result.status, 'not_merged')
  assert.match(open.result.stopped_at.reason, /changes requested/)
  assert.ok(!open.calls.some(c => c.label === 'lookup-s2'), 'the next lane is not touched while the one below is open')
  const blocked = await run('ship-chain', { chain: CHAIN }, sc(), { workflow: shipWf({ 'feat/p-s1': { status: 'blocked_at_merge_check' } }) })
  assert.equal(blocked.result.status, 'lane_failed')
  assert.match(blocked.result.stopped_at.reason, /blocked_at_merge_check/)
})

await test('proposal-build-chain: each ship_plan chain carries ship_chain_args for ship-chain', async () => {
  const lanesJson = JSON.stringify({ chains: [{ key: 's1', lanes: [
    { key: 's1', branch: 'feat/p-s1', dir: '/w/s1', bases: [], steps: [1], concern: 'c1' },
    { key: 's2', branch: 'feat/p-s2', dir: '/w/s2', bases: ['feat/p-s1'], steps: [2], concern: 'c2' }] }], blocked: [], errors: [] })
  const workflow = async () => ({ status: 'pushed', plan: 'the plan' })
  const respond = label => label === 'derive-lanes' ? { lanes_json: lanesJson, exit_code: 0, source: 'origin' } : {}
  const { result } = await run('proposal-build-chain', { proposal: 'p.md', dir: '/d', root: '/w' }, respond, { workflow })
  assert.equal(result.status, 'pushed')
  const c = result.ship_plan[0]
  assert.deepEqual(c.ship_chain_args.chain.order.map(l => [l.lane, l.steps]), [['s1', [1]], ['s2', [2]]])
  assert.deepEqual(c.order[1].args.predecessor_prs, ['<PR numbers of the lanes above, once merged>'])
})

// ---- bug-fix-backlog: without lanes, the Intake proposes them and stops for the person to confirm
const INTAKE_REPLY = {
  issues: [{ number: 11, title: 'a', labels: ['bug'], code_sites: ['src/auth.js:login'] }, { number: 12, title: 'b', labels: ['bug'], code_sites: ['src/auth.js:login'] },
    { number: 13, title: 'c', labels: ['bug'], code_sites: ['src/pay.js:charge'] }, { number: 14, title: 'd', labels: ['bug'], code_sites: [] }],
  lanes: [{ key: 'Auth Login', issues: [11, 12, 99], code_site: 'src/auth.js:login', why: 'same function' }, { key: 'auth-login', issues: [12, 13], code_site: 'src/pay.js:charge', why: 'x' }],
  unlaned: [{ number: 14, reason: 'an open PR already closes it' }],
  ci_red: [{ workflow: 'ci', url: 'https://ci/1', sha: 'abc', conclusion: 'failure', failing_jobs: ['test'], summary: 'flaky', tracked_by: [] }],
}
const bfb = (over = {}) => label => over[label] !== undefined ? over[label] : label === 'intake' ? INTAKE_REPLY : {}

await test('bug-fix-backlog: without lanes the Intake proposes lanes and stops with one question', async () => {
  const { result, calls, prompt } = await run('bug-fix-backlog', { root: '/w', labels: ['bug', 'crash'] }, bfb())
  assert.equal(result.status, 'needs_input')
  assert.equal(result.stage, 'intake')
  assert.deepEqual(calls.map(c => c.label), ['intake'])
  assert.deepEqual(result.questions.map(q => q.id), ['intake.q1'])
  // Each listed issue in one lane, out-of-list and unlaned issues dropped, keys unique slugs.
  assert.deepEqual(JSON.parse(result.questions[0].recommended), [{ key: 'auth-login', issues: [11, 12] }, { key: 'auth-login-2', issues: [13] }])
  assert.deepEqual(result.proposed_lanes.map(l => l.key), ['auth-login', 'auth-login-2'])
  assert.equal(result.ci_red.length, 1)
  assert.match(result.relay, /never confirm or edit the lanes on their behalf/)
  assert.match(prompt('intake'), /\["bug","crash"\]/)
  assert.match(prompt('intake'), /never create, edit, label, comment on, assign or close an issue/)
})

await test('bug-fix-backlog: the Intake stops even with on_question assume, and needs root', async () => {
  const { result } = await run('bug-fix-backlog', { root: '/w', on_question: 'assume' }, bfb())
  assert.equal(result.status, 'needs_input')
  await assert.rejects(run('bug-fix-backlog', {}, bfb()), /root is required with the Intake/)
  await assert.rejects(run('bug-fix-backlog', { root: '/w', intake: false }, bfb()), /lanes is required/)
})

await test('bug-fix-backlog: an intake answer runs the confirmed lanes, and reaches no lane', async () => {
  const seen = []
  const workflow = async (name, a) => { seen.push(a); return { status: 'pushed' } }
  const triage = { branch: 'bugfix/edited-11-undated', ahead_of_main: 0, behind_main: 0, issues: [{ number: 11, title: 'a', verdict: 'plan', evidence: 'e' }], plan: 'p' }
  const repro = { results: [{ number: 11, reproduced: true, behaviour_correct: false, tests: ['t.js::x'], failure_excerpt: '', notes: '' }] }
  const answers = [{ id: 'intake.q1', answer: JSON.stringify([{ key: 'edited', issues: [11], code_site: 'ignored' }]) }]
  const { result, calls } = await run('bug-fix-backlog', { root: '/w', answers }, bfb({ 'triage:edited': triage, 'reproduce:edited': repro }), { workflow })
  assert.ok(!calls.some(c => c.label === 'intake'), 'a lanes answer needs no Intake')
  assert.deepEqual(result.map(r => [r.lane, r.status]), [['edited', 'pushed']])
  assert.equal(seen[0].answers, undefined, 'the intake answer is not passed to a lane')
  const accepted = await run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: 'accept' }] }, bfb())
  assert.deepEqual(accepted.calls.map(c => c.label).filter(l => l === 'intake' || l.startsWith('triage:')).sort(), ['intake', 'triage:auth-login', 'triage:auth-login-2'])
  const none = await run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: '[]' }] }, bfb())
  assert.deepEqual(none.result, [])
  await assert.rejects(run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: 'yes please' }] }, bfb()), /must be 'accept' or a JSON array/)
})

process.exit(failed ? 1 : 0)

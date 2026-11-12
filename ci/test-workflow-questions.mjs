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
// The first sentence of every workflow's needs_input relay.
const RELAY_FIRST = 'Ask the person these questions yourself, in one batch, in as few prompts as the session\'s question tool allows and never dropping or merging one to fit (a numbered list when it has none), ' +
  'each with its why, its options and the recommended one first; never answer them on their behalf, and never re-run with on_question: \'assume\' unless the person says to proceed on assumptions. '
// The workflow files whose relay constants hold that sentence (checked in the source, one per relay constant).
const RELAY_FILES = { 'plan-to-merged-pr.js': 1, 'proposal-build-chain.js': 1, 'ship-chain.js': 1, 'bug-fix-backlog.js': 1, 'bootstrap-repo.js': 2, 'refresh-proposal.js': 1 }
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`) }
}

// What the monitor's observer reports for a settled PR, and the args of a monitor-only run.
const OBS = { pr_state: 'OPEN', head_sha: 'abcdef1234', ai_review_done_on_head: true, ci_state: 'green', ci_configured: true }
const MON = { pr: 7, branch: 'feat/x', dir: '/w/x', plan_text: 'the plan', main_branch: 'trunk' }

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

await test('plan-to-merged-pr: impl, fix, polish and merge-check questions stop at their own stage', async () => {
  for (const [stage, label] of [['impl', 'impl'], ['fix', 'apply-review-fixes'], ['polish', 'polish'], ['merge_check', 'merge-check']]) {
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
  for (const l of ['plan', 'impl', 'apply-review-fixes-1', 'polish-1', 'merge-check']) assert.match(prompt(l), /QUESTIONS: this stage runs unattended/, l)
  assert.match(prompt('plan'), /return every such question/)
  // The rule every stage asks by: a conflict with what the person said, a person-owned choice, what the person settled, titles.
  const p = prompt('impl')
  assert.match(p, /a conflict between what the person said \(an answer given to this run, the framing, a decision a design doc tags \(person, \.\.\.\)\) and the concern, the plan, the tree or your research/)
  assert.match(p, /In such a conflict pick no side: ask, naming both\./)
  assert.match(p, /A person-owned choice that no doc, plan or answer settles is asked as a blocking question, never assumed: money or an account in the person's name;/)
  assert.match(p, /a licence; a name \(product, package, domain, organization or bundle id\)\./)
  assert.match(p, /Never change what the person settled: an answer, the framing or a decision tagged \(person, \.\.\.\) is changed only by a newer answer from the person, and a reason to change it is a blocking question\./)
  assert.match(p, /name steps, decisions and milestones by title; a number may follow the title, but a number alone is never enough/)
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
  // A polish answer reaches polish and the merge check, never the fixer before it.
  const polishAns = await run('plan-to-merged-pr', { concern: 'c', ship: false, answers: [{ id: 'polish.q1', answer: 'ANSWER-POLISH' }] }, ptmp(null))
  for (const l of ['plan', 'impl', 'review-changes-1', 'apply-review-fixes-1']) assert.doesNotMatch(polishAns.prompt(l), /ANSWER-POLISH/, l)
  for (const l of ['polish-1', 'merge-check']) assert.match(polishAns.prompt(l), /ANSWER-POLISH/, l)
})

await test('plan-to-merged-pr: an answer travels with its id, question text and date, and binds what it settled', async () => {
  const answers = [{ id: 'impl.q1', question: Q.question, answer: 'per process', date: '2026-11-12' }]
  const { prompt } = await run('plan-to-merged-pr', { concern: 'c', ship: false, answers }, ptmp(null))
  const p = prompt('impl')
  assert.ok(p.includes(JSON.stringify([{ id: 'impl.q1', question: Q.question, answer: 'per process', date: '2026-11-12' }])), 'id, question, answer and date, as given')
  assert.match(p, /binding, like an explicit constraint; never re-ask them, and never change what one settled: a reason to change it is a blocking question/)
  // The reviewer reports a change that departs from it as a bug whose fix is the question to ask.
  assert.match(prompt('review-changes-1'), /A change that departs from what the person settled \(an answer from the person given above, or a decision the design doc tags \(person, \.\.\.\)\) is a bug: describe it as the question to ask the person, with its options, never as a fix to apply\./)
  // A question asked on a re-run never reuses an answered id.
  const again = await run('plan-to-merged-pr', { concern: 'c', ship: false, answers: [...answers, { id: 'impl.q3', answer: 'x' }, { id: 'impl.d1', answer: 'y' }, { id: 'fix.q7', answer: 'z' }] }, ptmp('impl'))
  assert.deepEqual(again.result.questions.map(q => q.id), ['impl.q4'])
})

await test('plan-to-merged-pr: the needs_input relay says how to ask, to show the assumptions, and what a new session finds', async () => {
  const stop = await run('plan-to-merged-pr', { concern: 'c', ship: false }, ptmp('impl', {}))
  const r = stop.result.relay
  assert.ok(r.startsWith(RELAY_FIRST), 'the first relay sentence every workflow shares')
  assert.match(r, /Also show the person this result's assumptions: a line they correct is passed as an answer too \(id <its stage>\.d<N>, with the assumption as its question\)\./)
  assert.match(r, /same args plus answers \(each question's id and question text with the person's answer and the date they gave it, added to any answers given before\)/)
  assert.match(r, /In this session, also set resumeFromRunId to this run's id/)
  // No plan was saved (the mock planner reports none): a new session plans again, and the work lives in the checkout alone.
  assert.match(r, /A new session has no run record: re-run the same way without resumeFromRunId; that run plans the work again, because no plan of this run is saved\./)
  assert.match(r, /The branch's uncommitted work is kept only while this checkout exists\.$/)
  // The planner saved the plan: the relay names it, and the branch this run created, for the new session.
  const saved = await run('plan-to-merged-pr', { concern: 'c', ship: false }, label => label === 'plan' ? { branch: 'feat/x', plan: 'the plan', plan_saved: true } : ptmp('impl')(label))
  assert.equal(saved.result.plan_ref, 'plans/feat-x-d03c3cb6.md')
  assert.match(saved.result.relay, /without resumeFromRunId, adding branch: 'feat\/x' \(the branch this run created\); that run continues from the branch's saved plan \(plans\/feat-x-d03c3cb6\.md on the pipeline state branch\) instead of planning again\./)
  assert.match(saved.result.relay, /The branch's uncommitted work is kept only while this checkout exists; a new container builds it again from that plan with the answers\. /)
  assert.match(saved.result.relay, /When the person's answer is to plan the work again, also pass replan: true and branch: 'feat\/x' \(in either session\): the planner then ignores the saved plan and saves the new one over it\.$/)
})

await test('plan-to-merged-pr: on_question assume tells stages to proceed and collects their assumptions', async () => {
  const respond = label => label === 'plan' ? { branch: 'feat/x', plan: 'p', assumptions: ['per process -> taken'] } : ptmp(null)(label)
  const { result, prompt } = await run('plan-to-merged-pr', { concern: 'c', ship: false, on_question: 'assume' }, respond)
  assert.equal(result.status, 'pushed')
  assert.match(prompt('plan'), /proceed on assumptions/)
  assert.doesNotMatch(prompt('plan'), /return every such question/)
  assert.deepEqual(result.assumptions, [{ stage: 'plan', assumption: 'per process -> taken' }])
  assert.match(prompt('plan'), /take the option you recommend \(in a conflict with what the person said, always what the person said\)/)
  assert.match(prompt('plan'), /A person-owned choice that no doc, plan or answer settles is a blocking question: money/)
})

// ---- plan-to-merged-pr: what a stage assumed reaches the later stages, the saved plan and the PR body
await test('plan-to-merged-pr: an assumption reaches every later stage, the reviewer included, and never an earlier one', async () => {
  const respond = label => label === 'impl' ? { summary: 'done', files_changed: ['a.js'], gates_green: true, assumptions: ['ASSUMED-TTL: 60 seconds'] } : ptmp(null)(label)
  const { result, prompt } = await run('plan-to-merged-pr', { concern: 'c', ship: false }, respond)
  assert.equal(result.status, 'pushed')
  const KEEP = 'Choices earlier stages of this run made that the person has not confirmed: keep each, never ask it again, and it is no defect; a reason to change one is a blocking question: ["ASSUMED-TTL: 60 seconds"]'
  for (const l of ['apply-review-fixes-1', 'polish-1', 'merge-check']) assert.ok(prompt(l).includes(KEEP), l)
  for (const l of ['review-changes-1', 'review-changes-2']) assert.ok(prompt(l).includes('a reason to change one is a concern that names the question to ask the person: ["ASSUMED-TTL: 60 seconds"]'), l)
  for (const l of ['plan', 'impl']) assert.doesNotMatch(prompt(l), /ASSUMED-TTL/, l)
  // The fixer and polish hold the plan the reviewer judged against.
  for (const l of ['apply-review-fixes-1', 'polish-1']) assert.ok(prompt(l).includes('The plan below is authoritative for this branch; ignore any other plan file in the plans directory.\n\nthe plan\n\n'), l)
  // With nothing assumed, nothing is added.
  const none = await run('plan-to-merged-pr', { concern: 'c', ship: false }, ptmp(null))
  for (const c of none.calls) assert.doesNotMatch(c.prompt, /Choices earlier stages of this run made/, c.label)
})

await test('plan-to-merged-pr: the PR body gets the assumptions and the answers, and the result lists what the fixer declined', async () => {
  const respond = label => label === 'impl' ? { summary: 'done', files_changed: ['a.js'], gates_green: true, assumptions: ['TTL is\n60 seconds'] }
    : label === 'apply-review-fixes-1' ? { summary: 'fixed', gates_green: true, declined: [{ finding: 'a.js: b', reason: 'the plan asks for it' }] }
      : label === 'merge-check' ? { merge_check: 'clean', gates_green: true, assumptions: ['kept both sides'] }
        : label === 'create-pr' ? { pr_number: 7, url: 'u' } : label.startsWith('observe') ? OBS : ptmp(null)(label)
  const answers = [{ id: 'fix.q1', question: Q.question, answer: 'per process', date: '2026-11-12' }, { id: 'impl.d1', answer: { ttl: 60 } }]
  const { result, prompt } = await run('plan-to-merged-pr', { concern: 'c', answers }, respond)
  assert.equal(result.status, 'OPEN')
  const LINES = '- assumed (impl): TTL is 60 seconds\n- assumed (merge_check): kept both sides\n- answered (fix.q1, 2026-11-12): Should the cache be per process or shared? -> per process\n- answered (impl.d1): impl.d1 -> {"ttl":60}\n'
  assert.ok(prompt('create-pr').includes('Give the PR body a "## Assumptions to review" section, after the Deploy notes, holding exactly these lines (choices this branch\'s stages made that the person has not confirmed, and what the person answered), so the person can correct one before merging:\n' + LINES))
  assert.deepEqual(result.declined, [{ round: 1, finding: 'a.js: b', reason: 'the plan asks for it' }])
  assert.deepEqual(result.assumptions, [{ stage: 'impl', assumption: 'TTL is\n60 seconds' }, { stage: 'merge_check', assumption: 'kept both sides' }])
  // The result's plan text ends with the section too: it is the fallback a ship-only run gets when the plan was not saved.
  assert.ok(result.plan.startsWith('the plan\n\n## Assumptions to review\n\n'))
  assert.ok(result.plan.endsWith(LINES))
  // Nothing assumed, nothing answered, nothing declined: no section, no list.
  const bare = await run('plan-to-merged-pr', { concern: 'c' }, label => label === 'create-pr' ? { pr_number: 7, url: 'u' } : label.startsWith('observe') ? OBS : ptmp(null)(label))
  assert.doesNotMatch(bare.prompt('create-pr'), /Assumptions to review/)
  assert.equal(bare.result.plan, 'the plan')
  assert.equal(bare.result.declined, undefined)
  assert.equal(bare.result.polish_unfixed, undefined)
})

// ---- plan-to-merged-pr: polish asks, and a round that leaves a bug or concern unfixed is not clean
await test('plan-to-merged-pr: polish asks what is the person\'s call, and what it leaves unfixed is not a clean round', async () => {
  const { prompt } = await run('plan-to-merged-pr', { concern: 'c', ship: false }, ptmp(null))
  assert.match(prompt('polish-1'), /Fix every bug found and run the quality gates, with two exceptions, which are blocking questions handled as QUESTIONS says \(never applied silently, never deferred\): a fix that changes observable behaviour the plan and the design doc do not call for, and a concern whose resolution is the person's call\./)
  assert.match(prompt('polish-1'), /List in unfixed every bug or concern you leave unfixed for any other reason, with that reason in its description \(suggestions and nits stay out of the list\)\./)
  assert.match(prompt('merge-check'), /polish's last clean round already ran the gates green/)
  const asked = await run('plan-to-merged-pr', { concern: 'c', ship: false }, ptmp('polish'))
  assert.deepEqual([asked.result.status, asked.result.stage, asked.result.questions[0].id], ['needs_input', 'polish', 'polish.q1'])
  assert.ok(!asked.calls.some(c => c.label === 'merge-check'), 'the merge check never runs on a polish question')
  // Fixed nothing, gates green, one concern left: not clean, reported, the full gates at the merge check, and no further round.
  const left = { file: 'a.js', severity: 'concern', description: 'retry policy: could not be decided from the plan' }
  const respond = label => label.startsWith('polish') ? { issues_found_and_fixed: 0, unfixed: [left], summary: 's', gates_green: true } : ptmp(null)(label)
  const dirty = await run('plan-to-merged-pr', { concern: 'c', ship: false }, respond)
  assert.equal(dirty.result.status, 'pushed')
  assert.equal(dirty.result.polish_clean, false)
  assert.deepEqual(dirty.result.polish_unfixed, [left])
  assert.match(dirty.prompt('merge-check'), /3\. Run the full QUALITY_GATES command .* polish never reached a clean, green round/)
  assert.deepEqual(dirty.calls.map(c => c.label).filter(l => l.startsWith('polish')), ['polish-1'])
  // A round that fixed something is followed by another, as before.
  const two = await run('plan-to-merged-pr', { concern: 'c', ship: false }, label => label === 'polish-1' ? { issues_found_and_fixed: 2, summary: '', gates_green: true } : ptmp(null)(label))
  assert.equal(two.result.polish_clean, true)
  assert.ok(two.calls.some(c => c.label === 'polish-2'))
})

// ---- plan-to-merged-pr: the monitor's hand-off (resume_monitor) and the close-out check after a merge
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

// ---- plan-to-merged-pr: the monitor's comment and CI steps ask instead of deciding for the person
const monitor = over => label => over[label] !== undefined ? over[label] : label.startsWith('observe') ? OBS : {}

await test('plan-to-merged-pr: a review comment that is the person\'s call stops the monitor with a question, its thread left without a reply', async () => {
  const over = { 'observe-1': { ...OBS, actionable_comments: 1 }, 'process-comments-1': { pushed: true, handled: 2, remaining: 1, summary: 's', questions: [Q] } }
  const { result, calls, prompt } = await run('plan-to-merged-pr', MON, monitor(over))
  assert.deepEqual([result.status, result.stage, result.questions[0].id], ['needs_input', 'monitor', 'monitor.q1'])
  assert.deepEqual(result.resume_monitor, MON)
  assert.ok(result.relay.startsWith(RELAY_FIRST))
  assert.match(result.relay, /monitor-only mode \(this result's resume_monitor as args, plus answers \(each question's id and question text with the person's answer and the date they gave it/)
  assert.doesNotMatch(result.relay, /resumeFromRunId/)
  assert.equal(calls.at(-1).label, 'process-comments-1', 'nothing runs after the step that asked')
  assert.deepEqual(result.monitor_actions.map(a => [a.step, a.pushed]), [['process-comments', true]], 'what the step did for the other items is kept')
  const p = prompt('process-comments-1')
  assert.match(p, /QUESTIONS: this stage runs unattended/)
  assert.match(p, /Two kinds of item are blocking questions, per QUESTIONS, never applied and never declined: a human reviewer's request that contradicts the plan, the design doc \(above all a decision tagged \(person, \.\.\.\)\) or an answer from the person given above; and any item, human or AI, whose fix is a product or trade-off choice neither the plan nor the design doc settles\./)
  assert.match(p, /covers that item alone: validate every item before changing anything, handle every other item as usual \(fix, push, reply\), post no reply on that thread/)
  assert.match(p, /return the question, naming the thread \(its URL, the reviewer and their words\) and what the plan or the design doc says/)
  assert.match(p, /verify every item carries one, apart from an item left for the person as described below/)
  assert.match(p, /A thread where a person replied after a terminal-marker or out-of-scope reply, asking for a change or asking a question, is actionable again/)
  // The observer counts such a thread again.
  assert.match(prompt('observe-1'), /counts again when a person replied after that reply \(a real user, not a bot and not one of this pipeline's own replies\), asking for a change or asking a question: that reply is unanswered/)
})

await test('plan-to-merged-pr: the comment step keeps the plan in assume mode, and gets the person\'s answer on the monitor-only re-run', async () => {
  const over = { 'observe-1': { ...OBS, actionable_comments: 1 }, 'process-comments-1': { pushed: false, handled: 1, remaining: 0, summary: 's', assumptions: ['rename the flag -> kept the plan'] } }
  const assume = await run('plan-to-merged-pr', { ...MON, on_question: 'assume' }, monitor(over))
  assert.equal(assume.result.status, 'OPEN')
  assert.deepEqual(assume.result.assumptions, [{ stage: 'monitor', assumption: 'rename the flag -> kept the plan' }])
  const p = assume.prompt('process-comments-1')
  assert.match(p, /the option taken is always to keep what the plan and the design doc say: change nothing for it, post the "Surfaced for human review — out of scope for automated remediation\." reply on its thread once, and list it in assumptions/)
  assert.doesNotMatch(p, /post no reply on that thread/)
  const answers = [{ id: 'monitor.q1', question: 'T', answer: 'ANSWER-MON' }]
  const answered = await run('plan-to-merged-pr', { ...MON, answers }, monitor({ 'observe-1': { ...OBS, actionable_comments: 1 } }))
  assert.match(answered.prompt('process-comments-1'), /ANSWER-MON/)
  assert.match(answered.prompt('process-comments-1'), /An item that an answer from the person given above settles is no question any more: handle it as that answer says and post its terminal-marker reply\./)
})

await test('plan-to-merged-pr: the CI fix never changes what a test asserts or a gate checks without the plan or a question', async () => {
  const red = { ...OBS, ci_state: 'red', ci_red_caused_by_pr: true }
  const asked = await run('plan-to-merged-pr', MON, monitor({ 'observe-1': red, 'fix-ci-1': { pushed: false, handled: 0, remaining: 1, summary: 's', questions: [Q] } }))
  assert.deepEqual([asked.result.status, asked.result.stage, asked.result.questions[0].id], ['needs_input', 'monitor', 'monitor.q1'])
  assert.deepEqual(asked.result.resume_monitor, MON)
  assert.equal(asked.calls.at(-1).label, 'fix-ci-1', 'nothing runs after the step that asked')
  const p = asked.prompt('fix-ci-1')
  assert.match(p, /QUESTIONS: this stage runs unattended/)
  assert.match(p, /Never get CI green by changing what an existing test asserts, deleting a test, or editing a CI workflow, a required check, the QUALITY_GATES line or a threshold, unless the plan or the design doc calls for that change: then make it and name the test or file and the plan line in assumptions\./)
  assert.match(p, /When neither the plan nor the design doc decides whether the test or the code is right, that is a blocking question, per QUESTIONS, naming the test, what it asserts and the two readings: push nothing and return it\./)
  const noted = await run('plan-to-merged-pr', MON, monitor({ 'observe-1': red, 'fix-ci-1': { pushed: true, handled: 1, remaining: 0, summary: 's', assumptions: ['parse.test.js::total now expects 12.50, plan step 2'] } }))
  assert.equal(noted.result.status, 'OPEN')
  assert.deepEqual(noted.result.assumptions, [{ stage: 'monitor', assumption: 'parse.test.js::total now expects 12.50, plan step 2' }])
})

await test('every relay constant starts with the shared first sentence', async () => {
  for (const [file, n] of Object.entries(RELAY_FILES)) {
    // The sentence as the source spells it: one template literal, split over two lines.
    const src = readFileSync(join(dir, file), 'utf8').replace(/` \+\n\s*`/g, '')
    assert.equal(src.split(RELAY_FIRST).length - 1, n, `${file}: ${n} relay constant(s) with the sentence`)
  }
})

await test('plan-to-merged-pr: a merged PR with a proposal reports the close-out edits without making them', async () => {
  const edits = [{ file: 'docs/design/x.md', line: 3, before: 'Status: in-progress', after: 'Status: done' }]
  const milestone = { n: 2, title: 'Import bank statements', acceptance: 'a user imports a real statement and the total matches' }
  const respond = label => label.startsWith('observe') ? { ...OBS, pr_state: 'MERGED' }
    : label === 'closeout' ? { checked: true, proposal_complete: true, edits, next_milestone: [{ n: 3, title: 'Go / no-go' }], roadmap: 'docs/design/roadmap.md', milestone } : {}
  const { result, prompt } = await run('plan-to-merged-pr', { ...MON, proposal: 'docs/design/x.md' }, respond)
  assert.equal(result.status, 'MERGED')
  // The milestone the person ticks comes with the Acceptance they check first.
  assert.deepEqual(result.closeout, { proposal_complete: true, edits, next_milestone: [{ n: 3, title: 'Go / no-go' }], roadmap: 'docs/design/roadmap.md', milestone })
  assert.equal(result.resume_monitor, undefined)
  // A report, never a question: the merged result carries neither questions nor a relay.
  assert.equal(result.questions, undefined)
  assert.equal(result.relay, undefined)
  assert.match(prompt('closeout'), /WITHOUT making any of them/)
  assert.match(prompt('closeout'), /origin\/trunk/)
  assert.match(prompt('closeout'), /pending = one entry per step in pending_steps, copied verbatim from that JSON: its n, its title, and human_gate = its human_gate\.text \(.. when its human_gate is null: a code step\)/)
  assert.match(prompt('closeout'), /run proposal-lint\.py <that file> --json and report milestone = \{ n: N, title, acceptance \}, the title and acceptance copied verbatim from its steps entry N/)
  // Unticked steps are named by title, a human gate with what the person does.
  const pending = [{ n: 4, title: 'Decide go or no-go', human_gate: 'the person reads the pilot numbers and decides' }]
  const partial = await run('plan-to-merged-pr', { ...MON, proposal: 'docs/design/x.md' },
    label => label === 'closeout' ? { checked: true, proposal_complete: false, pending_steps: [4], pending } : respond(label))
  assert.deepEqual(partial.result.closeout, { proposal_complete: false, pending_steps: [4], pending })
  // No roadmap resolved: the milestone is null, never an empty object.
  const loose = await run('plan-to-merged-pr', { ...MON, proposal: 'docs/design/x.md' },
    label => label === 'closeout' ? { checked: true, proposal_complete: true, edits, next_milestone: [], roadmap: '' } : respond(label))
  assert.deepEqual(loose.result.closeout, { proposal_complete: true, edits, next_milestone: [], roadmap: '', milestone: null })
  const none = await run('plan-to-merged-pr', MON, respond)
  assert.ok(!none.calls.some(c => c.label === 'closeout'), 'no proposal, no close-out check')
})

// ---- brief-to-proposals
const btp = (over = {}) => (label, prompt) => {
  if (over[label] !== undefined) return typeof over[label] === 'function' ? over[label](prompt) : over[label]
  if (label === 'seed') return { copied: 1, claude_md: 'written' }
  // No design docs on disk yet: the run starts at the Intake (see ci/test-workflow-design.mjs for resumed runs).
  if (label === 'existing-docs') return { brief_exists: true, out_dir: 'docs/design', architecture: 'docs/design/architecture.md', roadmap: 'docs/design/roadmap.md' }
  if (label === 'roadmap' || label === 'milestones') return {
    out_dir: 'docs/design', architecture: 'docs/design/architecture.md', roadmap: 'docs/design/roadmap.md', lint_clean: true,
    milestones: [{ n: 1, title: 'Bootstrap', done: false, human_gate: 'ops', proposal: '' },
      { n: 2, title: 'A', done: false, human_gate: '', proposal: '01-a.md' }, { n: 3, title: 'B', done: false, human_gate: '', proposal: '02-b.md' }],
  }
  if (label.startsWith('propose:m')) return { doc: `docs/design/${label.slice(9)}.md`, steps: 3, lint_clean: true }
  if (label.startsWith('review:')) return { findings: [], completed: true }
  if (label.startsWith('consistency:')) return { findings: [], coverage_gaps: [] }
  if (label === 'lint') return { docs: [], lanes: [], next_milestones: [] }
  return {}
}
const BRIEF = { brief: 'brief.md', dir: '/abs/p', panel: 0 }

await test('brief-to-proposals: an intake question stops the run before any design is written', async () => {
  const { result, calls } = await run('brief-to-proposals', BRIEF, btp({ intake: { questions: [Q] } }))
  assert.equal(result.status, 'needs_input')
  assert.deepEqual(result.questions.map(q => q.id), ['intake.q1'])
  assert.deepEqual(calls.map(c => c.label), ['seed', 'existing-docs', 'intake'])
  assert.ok(result.seeded)
  assert.equal(result.resume_from, 'intake')
})

await test('brief-to-proposals: the Intake sweeps the person-owned choices class by class, and a confirmation keeps its mark', async () => {
  const C = { question: 'The brief names the licence AGPL-3.0-only: confirm it?', why: 'the brief was drafted for you, and the variant decides who may relicense', options: ['AGPL-3.0-only', 'AGPL-3.0-or-later'], recommended: 'AGPL-3.0-only', confirm: true }
  const { result, calls, prompt } = await run('brief-to-proposals', BRIEF, btp({ intake: { questions: [Q, C], assumptions: ['EU only'] } }))
  const p = prompt('intake')
  assert.match(p, /find every blocking question and every confirmation/)
  assert.match(p, /Go through the person-owned choices class by class\. For each class the source touches, either quote in notes where the person settled it/)
  assert.match(p, /a confirmation \(confirm: true, the source's value as the recommended option\) when the source was drafted for the person or the framing lists it as open, recommended or not yet decided/)
  assert.match(p, /One item per choice; values of one kind \(several retention periods, several thresholds\) form one confirmation/)
  assert.match(p, /never an implementation choice/)
  assert.doesNotMatch(p, /prefer a few/)
  // The definitions it sweeps with: the conflict clause, the canonical list in its order, what is the author's, the gate boundary.
  assert.match(p, /a conflict between what the person said \(the framing, an answer, a decision a doc records as theirs\) and the source or your research/)
  assert.match(p, /The person-owned choices: who the product is for and what its first release leaves out; platforms and distribution, hosted or self-run; price, plans, the revenue model/)
  assert.match(p, /the licence and its variant, and the legal and compliance posture; what personal data is collected.*names \(product, package, domain, organization or bundle id\); the repository's owner and visibility; stop and go criteria, thresholds and dates; and a stack, provider or environment the person must run or pay for themselves\./)
  assert.match(p, /Yours, never asked: a choice inside a component/)
  assert.match(p, /a store, registry or register with a public search is desk research, recorded with its result and date/)
  assert.match(p, /Return no questions when nothing blocks/)
  // The confirmation stops the run with the blocking question, in the one batch, and keeps confirm and its id.
  assert.equal(result.status, 'needs_input')
  assert.deepEqual(calls.map(c => c.label), ['seed', 'existing-docs', 'intake'])
  assert.deepEqual(result.questions.map(q => [q.id, q.stage, q.confirm]), [['intake.q1', 'intake', undefined], ['intake.q2', 'intake', true]])
  assert.equal(result.questions[1].recommended, 'AGPL-3.0-only')
  assert.deepEqual(result.assumptions, [{ stage: 'intake', assumption: 'EU only' }])
  // The relay: the confirmations as one list, the assumptions shown too, and each answer passed back with its question and date.
  assert.match(result.relay, /Show the confirmations \(the questions with confirm: true\) as one list the person can accept whole or correct line by line/)
  assert.match(result.relay, /Also show the person this result's assumptions: a line they correct, or any decision they make outside these questions, is passed as an answer too \(id intake\.d<N>, with its question\)/)
  assert.match(result.relay, /each question's id and question text with the person's answer and the date they gave it/)
  assert.match(result.relay, /never answer them on their behalf/)
})

await test('brief-to-proposals: every author is told to return blocking questions and confirmations in one pass, or in assume mode to tag what it takes', async () => {
  const stop = await run('brief-to-proposals', BRIEF, btp())
  for (const l of ['roadmap', 'propose:m2']) {
    assert.match(stop.prompt(l), /write and change nothing, and return every blocking question and every confirmation \(all of them, in one pass\) in questions/, l)
    assert.match(stop.prompt(l), /a confirmation has confirm: true and the unconfirmed value as its recommended option/, l)
    assert.match(stop.prompt(l), /Report in assumptions every other choice the source did not settle/, l)
  }
  const assume = await run('brief-to-proposals', { ...BRIEF, on_question: 'assume' }, btp())
  assert.match(assume.prompt('roadmap'), /for each blocking question and each confirmation, take the option you recommend/)
  assert.match(assume.prompt('roadmap'), /tag a decision so taken \(assumed\) in the doc, and report it in assumptions/)
  assert.doesNotMatch(assume.prompt('roadmap'), /write and change nothing/)
})

await test('brief-to-proposals: the Intake\'s assumptions reach the sketches, the judge, /roadmap, every proposal author and every reviser of the same run', async () => {
  const over = { intake: { assumptions: ['ASSUMED-REGION: EU only'] },
    'review:architecture-1': { findings: [{ doc: 'docs/design/roadmap.md', severity: 'concern', description: 'no rollback plan' }], completed: true },
    'consistency:arch-m2': { findings: [{ doc: 'docs/design/2.md', severity: 'bug', description: 'y' }] } }
  const { result, prompt } = await run('brief-to-proposals', { ...BRIEF, panel: 1 }, btp(over))
  assert.equal(result.status, 'ready')
  for (const l of ['sketch:validate-first', 'judge', 'roadmap', 'revise:architecture-1', 'propose:m2', 'propose:m3', 'revise:consistency-1']) {
    assert.ok(prompt(l).includes('Assumptions the Intake took that the person has not confirmed: keep each, or return a question to change it; never pick another value silently: ["ASSUMED-REGION: EU only"]'), l)
  }
  assert.match(prompt('sketch:validate-first'), /A sketch returns no questions: .* name it in assumptions_to_validate, for the judge to ask/)
  // With no Intake assumption nothing is added.
  const none = await run('brief-to-proposals', { ...BRIEF, panel: 1 }, btp())
  for (const l of ['judge', 'roadmap', 'propose:m2']) assert.doesNotMatch(none.prompt(l), /Assumptions the Intake took/, l)
})

await test('brief-to-proposals: on_question assume turns intake recommendations into shared answers', async () => {
  const { result, prompt } = await run('brief-to-proposals', { ...BRIEF, on_question: 'assume' }, btp({ intake: { questions: [Q] } }))
  assert.equal(result.status, 'ready')
  for (const l of ['roadmap', 'propose:m2', 'review:m3-1', 'consistency:arch-m2', 'consistency:brief-roadmap']) assert.match(prompt(l), /per process \(assumed/, l)
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
  assert.ok(!calls.some(c => c.label.startsWith('consistency')), 'Consistency waits on the answers')
  assert.equal(result.resume_from, 'proposals')
  assert.equal(result.proposals.find(p => p.milestone === 2).needs_input, true)
  assert.match(result.next_steps[0], /answer the 1 question/)
})

// brief-to-proposals.js now hands every answer to every stage in brief mode (the same choice can arise in another doc); the
// routing by stage that this test pinned is concern mode's alone, and ci/test-workflow-design.mjs covers both.
await test('brief-to-proposals: in brief mode a milestone answer reaches every author, reviewer and pair', async () => {
  const answers = [{ id: 'm2.q1', answer: 'ANSWER-M2' }]
  const { result, prompt } = await run('brief-to-proposals', { ...BRIEF, answers }, btp())
  assert.equal(result.status, 'ready')
  for (const l of ['roadmap', 'review:architecture-1', 'propose:m2', 'review:m2-1', 'propose:m3', 'review:m3-1', 'consistency:arch-m2', 'consistency:arch-m3']) assert.match(prompt(l), /ANSWER-M2/, l)
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
  assert.equal(seen[1].replan, undefined, 'no lane plans again unless replan names it')
})

await test('proposal-build-chain: the relay says the lane that asked continues from its saved plan, and replan reaches only the lanes named', async () => {
  const lanes = [{ key: 'a', dir: '/w/a', branch: 'feat/a', proposal: 'p.md', concern: 'ca' }, { key: 'b', dir: '/w/b', branch: 'feat/b', proposal: 'p.md', concern: 'cb', bases: ['feat/a'] }]
  const ask = seen => async (name, a) => { seen.push(a); return a.branch === 'feat/b' ? { status: 'needs_input', stage: 'impl', plan_ref: 'plans/feat-b-1.md', questions: [{ id: 'impl.q1', ...Q }] } : { status: 'pushed' } }
  const seen = []
  const answers = [{ lane: 'b', id: 'impl.q1', answer: 'per process', question: Q.question, date: '2026-11-12' }]
  const { result } = await run('proposal-build-chain', { lanes, answers, replan: ['b'] }, () => ({}), { workflow: ask(seen) })
  const relay = result[1].relay
  assert.ok(relay.startsWith(RELAY_FIRST))
  assert.match(relay, /Also show the person the assumptions in each lane's result \(result\.assumptions\): a line they correct in a lane that asked is passed as an answer too \(that lane, id <its stage>\.d<N>, with the assumption as its question\)\./)
  assert.match(relay, /plus answers: each question's lane, id and question text with the person's answer and the date they gave it, added to any answers given before\./)
  assert.match(relay, /it continues from the plan its earlier run saved on the pipeline state branch \(its result's plan_ref\) instead of planning a second time, and plans again only when no plan for the same work is saved, when the saved plan contradicts an answer to a planning question, or when its key is listed in replan\./)
  assert.match(relay, /When the person's answer is to plan a lane again, add replan: \['<that lane's key>'\] to the re-run's args\./)
  assert.equal(result[1].result.plan_ref, 'plans/feat-b-1.md', 'the lane that asked names its saved plan')
  // The answer keeps its question text and date on the way to its lane; replan reaches lane b alone.
  assert.equal(seen[0].answers, undefined)
  assert.deepEqual(seen[1].answers, [{ id: 'impl.q1', answer: 'per process', question: Q.question, date: '2026-11-12' }])
  assert.deepEqual(seen.map(a => a.replan), [undefined, true])
  const all = []
  await run('proposal-build-chain', { lanes, replan: true }, () => ({}), { workflow: ask(all) })
  assert.deepEqual(all.map(a => a.replan), [true, true])
  // Derive mode: the result's own list of assumptions, and a pushed lane's correction goes to its PR.
  const lanesJson = JSON.stringify({ chains: [{ key: 's1', lanes: [{ key: 's1', branch: 'feat/b', dir: '/w/b', bases: [], steps: [1], concern: 'c1' }] }], blocked: [], errors: [] })
  const derived = await run('proposal-build-chain', { proposal: 'p.md', dir: '/d', root: '/w' }, label => label === 'derive-lanes' ? { lanes_json: lanesJson, exit_code: 0, source: 'origin' } : {}, { workflow: ask([]) })
  assert.equal(derived.result.status, 'needs_input')
  assert.match(derived.result.relay, /Also show the person this result's assumptions \(each names its lane\)/)
  assert.match(derived.result.relay, /A lane that already pushed is not built again by the re-run, so a correction to one of its lines is no answer: the person makes it on that lane's PR, as a review comment, once the PR is open\./)
  assert.match(derived.result.relay, /Lanes already pushed come back already_built\. A lane that asked builds again in its kept worktree with its answers: it continues from the plan/)
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
const CLOSEOUT = { proposal_complete: true, edits: [{ file: 'p.md', line: 3, before: 'Status: in-progress', after: 'Status: done' }], next_milestone: [], roadmap: '' }
const shipWf = (byBranch, seen = []) => async (name, a) => {
  seen.push({ name, ...a })
  // The close-out round: monitor-only on the last PR, which has merged.
  if (a.pr && a.max_monitor_rounds === 1) return { status: 'MERGED', pr: { pr_number: a.pr }, closeout: CLOSEOUT }
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
  assert.deepEqual(seen.map(s => s.name), ['plan-to-merged-pr', 'plan-to-merged-pr', 'plan-to-merged-pr'])
  assert.equal(seen[0].ship_only, true)
  assert.equal(seen[0].title, '[p] Title s1')
  assert.equal(seen[0].predecessor_prs, undefined)
  assert.equal(seen[0].ai_review_check, 'Review')
  assert.deepEqual(seen[1].predecessor_prs, [10])
  for (const l of ['lookup-s1', 'wait-s1-1']) assert.match(prompt(l), /Never merge/, l)
  // The last PR merged while the run waited: one monitor-only round on it runs the proposal's close-out check.
  assert.deepEqual([seen[2].pr, seen[2].branch, seen[2].proposal, seen[2].max_monitor_rounds, seen[2].ship_only], [11, 'feat/p-s2', 'p.md', 1, undefined])
  assert.deepEqual(result.closeout, CLOSEOUT)
})

await test('ship-chain: the lookup queries each lane\'s own main branch, as ship_chain_args carry it', async () => {
  const dev = { chain: 's1', order: CHAIN.order.map(e => ({ ...e, args: { ...e.args, main_branch: 'develop', title: '<title for steps 1>' } })) }
  const { prompt } = await run('ship-chain', { chain: dev }, sc(), { workflow: shipWf({}) })
  assert.match(prompt('lookup-s1'), /--base develop /)
  assert.doesNotMatch(prompt('lookup-s1'), /--base main /)
  const top = await run('ship-chain', { chain: dev, main_branch: 'trunk' }, sc(), { workflow: shipWf({}) })
  assert.match(top.prompt('lookup-s1'), /--base trunk /, 'a top-level main_branch still wins')
  const plain = await run('ship-chain', { chain: CHAIN }, sc(), { workflow: shipWf({}) })
  assert.match(plain.prompt('lookup-s1'), /--base main /, 'main by default')
})

await test('ship-chain: a placeholder title the lookup left empty stops the lane, even with a title_prefix', async () => {
  const seen = []
  const { result } = await run('ship-chain', { chain: CHAIN, title_prefix: '[p] ' }, sc({ 'lookup-s1': { state: 'NONE', pr_number: 0, title: '' } }), { workflow: shipWf({}, seen) })
  assert.equal(result.status, 'lane_failed')
  assert.match(result.stopped_at.reason, /no PR title/)
  assert.equal(seen.length, 0, 'no PR is opened with the prefix alone as its title')
})

await test('ship-chain: a closeout from the last lane\'s own run is kept, with no extra round; a stopped chain gets none', async () => {
  const seen = []
  const workflow = shipWf({ 'feat/p-s1': { status: 'MERGED', pr: { pr_number: 10 } }, 'feat/p-s2': { status: 'MERGED', pr: { pr_number: 11 }, closeout: { proposal_complete: false, pending_steps: [3] } } }, seen)
  const { result } = await run('ship-chain', { chain: CHAIN }, sc(), { workflow })
  assert.equal(result.status, 'merged')
  assert.equal(seen.length, 2)
  assert.deepEqual(result.closeout, { proposal_complete: false, pending_steps: [3] })
  const closed = await run('ship-chain', { chain: CHAIN }, sc({ 'wait-s1-1': { state: 'CLOSED' } }), { workflow: shipWf({ 'feat/p-s1': { status: 'OPEN', pr: { pr_number: 10 } } }) })
  assert.equal(closed.result.closeout, undefined)
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
  assert.equal(seen.length, 2, 'the open PR is monitored, then the close-out round runs on it')
  assert.equal(seen[0].pr, 11)
  assert.equal(seen[0].ship_only, undefined)
  assert.equal(seen[0].title, undefined)
})

await test('ship-chain: an open draft PR is readied through ship-only with existing_pr, after the lanes below merged', async () => {
  const seen = []
  const workflow = shipWf({ 'feat/p-s2': { status: 'OPEN', pr: { pr_number: 11 } } }, seen)
  const over = { 'lookup-s1': { state: 'MERGED', pr_number: 10, title: 'x' }, 'lookup-s2': { state: 'OPEN', pr_number: 11, is_draft: true, title: 'y' } }
  const { result } = await run('ship-chain', { chain: CHAIN }, sc(over), { workflow })
  assert.equal(result.status, 'merged')
  assert.equal(seen[0].ship_only, true)
  assert.equal(seen[0].existing_pr, 11)
  assert.equal(seen[0].pr, undefined, 'not monitor-only: monitoring never readies a draft')
  assert.deepEqual(seen[0].predecessor_prs, [10], 'readied only once the PR below reads MERGED')
  assert.equal(seen[0].title, 'y')
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

await test('ship-chain: a lane that did not ship says why: the PR stage\'s reason, the merge check\'s text, the blocking review findings', async () => {
  const stopped = async child => (await run('ship-chain', { chain: CHAIN }, sc(), { workflow: shipWf({ 'feat/p-s1': child }) })).result
  const atPr = await stopped({ status: 'blocked_at_pr', pr_stage: { blocked: true, blocked_reason: 'distinct issue numbers #4 and #9:\nask which one the PR closes' } })
  assert.equal(atPr.status, 'lane_failed')
  assert.equal(atPr.stopped_at.reason, 'plan-to-merged-pr ended with blocked_at_pr: distinct issue numbers #4 and #9: ask which one the PR closes')
  assert.equal(atPr.lanes[0].result.reason, 'distinct issue numbers #4 and #9: ask which one the PR closes', 'one line')
  const findings = [{ file: 'a.js', severity: 'bug', description: 'the merge dropped the null check' }, { file: 'b.js', severity: 'nit', description: 'naming' }]
  const atReview = await stopped({ status: 'blocked_at_review', merge_check: { merge_check: 'merged main, 2 conflicts resolved', gates_green: true }, review_findings: findings })
  assert.deepEqual(atReview.lanes[0].result.review_findings, ['bug: a.js: the merge dropped the null check'], 'only the blocking ones, one line each')
  assert.equal(atReview.stopped_at.reason, "plan-to-merged-pr ended with blocked_at_review: 1 blocking review finding(s), listed in this lane's result.review_findings")
  const atMerge = await stopped({ status: 'blocked_at_merge_check', merge_check: { merge_check: 'gates red: 2 tests fail after merging main', gates_green: false } })
  assert.match(atMerge.stopped_at.reason, /blocked_at_merge_check: gates red: 2 tests fail after merging main/)
  const atPreds = await stopped({ status: 'blocked_at_predecessors', merge_check: { blocked: true, blocked_reason: '#9 is not merged', merge_check: '' } })
  assert.match(atPreds.stopped_at.reason, /blocked_at_predecessors: #9 is not merged/)
  const asked = await stopped({ status: 'needs_input', stage: 'merge_check', questions: [{ id: 'merge_check.q1', ...Q }] })
  assert.equal(asked.lanes[0].result.stage, 'merge_check')
  assert.ok(asked.relay.startsWith(RELAY_FIRST))
  assert.match(asked.relay, /Also show the person the assumptions of the lane that asked \(lanes\[\]\.result\.assumptions/)
  assert.match(asked.relay, /plus answers: each question's lane, id and question text with the person's answer and the date they gave it, added to any answers given before\./)
})

// ---- ship-chain: while it waits for a merge, a PR that needs action gets its monitor again
await test('ship-chain: a wait round that finds the PR needing action re-runs its monitor, then goes on waiting', async () => {
  const seen = []
  const workflow = shipWf({ 'feat/p-s1': a => a.pr ? { status: 'OPEN', pr: { pr_number: 10 }, assumptions: [{ stage: 'monitor', assumption: 'kept the plan' }] } : { status: 'OPEN', pr: { pr_number: 10 }, assumptions: [{ stage: 'merge_check', assumption: 'kept both sides' }], left_uncommitted: ['docs/brief.md'] },
    'feat/p-s2': { status: 'MERGED', pr: { pr_number: 11 }, closeout: CLOSEOUT } }, seen)
  const answers = [{ lane: 's1', id: 'monitor.q1', answer: 'keep it' }]
  const over = { 'wait-s1-1': { state: 'OPEN', needs_monitor: true, notes: 'a reviewer asked for a change' }, 'wait-s1-2': { state: 'MERGED' } }
  const { result, calls, prompt } = await run('ship-chain', { chain: CHAIN, answers }, sc(over), { workflow })
  assert.equal(result.status, 'merged')
  assert.deepEqual(seen.map(s => [s.branch, s.ship_only, s.pr]), [['feat/p-s1', true, undefined], ['feat/p-s1', undefined, 10], ['feat/p-s2', true, undefined]], 'ship-only, then monitor-only on the open PR, then the next lane')
  assert.deepEqual(seen[1].answers, [{ id: 'monitor.q1', answer: 'keep it' }], 'the monitor run gets the lane\'s answers')
  assert.equal(seen[1].title, undefined)
  assert.deepEqual(calls.map(c => c.label), ['lookup-s1', 'wait-s1-1', 'wait-s1-2', 'lookup-s2'])
  assert.equal(result.lanes[0].re_monitored, 1)
  assert.equal(result.lanes[0].status, 'MERGED')
  // The later run's record replaces the earlier one, keeping what the earlier run assumed and left uncommitted.
  assert.deepEqual(result.lanes[0].result.assumptions, [{ stage: 'merge_check', assumption: 'kept both sides' }, { stage: 'monitor', assumption: 'kept the plan' }])
  assert.deepEqual(result.lanes[0].result.left_uncommitted, ['docs/brief.md'])
  const w = prompt('wait-s1-1')
  assert.match(w, /Set needs_monitor=true only when the PR is still OPEN at the end of the round and at least one of these holds/)
  assert.match(w, /an unresolved review thread whose latest comment is a person's/)
  assert.match(w, /a review that requested changes and was neither dismissed nor followed by that reviewer's approval; the PR conflicts with its base; a check is red\./)
  assert.match(w, /You still change nothing and post nothing/)
  // A round that does not ask for it, or a PR that left OPEN, starts no monitor.
  const quiet = []
  await run('ship-chain', { chain: CHAIN }, sc({ 'wait-s1-1': { state: 'OPEN', notes: 'waiting for a reviewer' }, 'wait-s1-2': { state: 'MERGED', needs_monitor: true } }),
    { workflow: shipWf({ 'feat/p-s1': { status: 'OPEN', pr: { pr_number: 10 } }, 'feat/p-s2': { status: 'MERGED', pr: { pr_number: 11 }, closeout: CLOSEOUT } }, quiet) })
  assert.deepEqual(quiet.map(s => s.pr), [undefined, undefined])
})

await test('ship-chain: a monitor the wait re-ran can stop the chain with questions, or see the merge itself', async () => {
  const asks = shipWf({ 'feat/p-s1': a => a.pr ? { status: 'needs_input', stage: 'monitor', pr: { pr_number: 10 }, questions: [{ id: 'monitor.q1', ...Q }] } : { status: 'OPEN', pr: { pr_number: 10 } } })
  const { result, calls } = await run('ship-chain', { chain: CHAIN }, sc({ 'wait-s1-1': { state: 'OPEN', needs_monitor: true } }), { workflow: asks })
  assert.equal(result.status, 'needs_input')
  assert.deepEqual(result.questions.map(q => [q.lane, q.id]), [['s1', 'monitor.q1']])
  assert.ok(result.relay.startsWith(RELAY_FIRST))
  assert.equal(result.stopped_at.lane, 's1')
  assert.equal(result.lanes[0].status, 'needs_input')
  assert.deepEqual(result.not_shipped, ['s2'])
  assert.deepEqual(calls.map(c => c.label), ['lookup-s1', 'wait-s1-1'], 'no further wait round, no next lane')
  // The re-run monitor saw the PR merge: the lane counts as merged without another wait round.
  const seen = []
  const merges = shipWf({ 'feat/p-s1': a => a.pr ? { status: 'MERGED', pr: { pr_number: 10 } } : { status: 'OPEN', pr: { pr_number: 10 } }, 'feat/p-s2': { status: 'MERGED', pr: { pr_number: 11 }, closeout: CLOSEOUT } }, seen)
  const merged = await run('ship-chain', { chain: CHAIN }, sc({ 'wait-s1-1': { state: 'OPEN', needs_monitor: true } }), { workflow: merges })
  assert.equal(merged.result.status, 'merged')
  assert.deepEqual(merged.result.merged_prs, [10, 11])
  assert.ok(!merged.calls.some(c => c.label === 'wait-s1-2'))
  assert.deepEqual(seen[2].predecessor_prs, [10])
})

await test('ship-chain: the wait re-runs a lane\'s monitor at most three times, then only reports', async () => {
  const seen = []
  const workflow = shipWf({ 'feat/p-s1': { status: 'OPEN', pr: { pr_number: 10 } } }, seen)
  const over = Object.fromEntries([1, 2, 3, 4, 5].map(n => [`wait-s1-${n}`, { state: 'OPEN', needs_monitor: true, notes: 'changes requested' }]))
  const { result, calls } = await run('ship-chain', { chain: CHAIN, max_wait_rounds: 5 }, sc(over), { workflow })
  assert.equal(result.status, 'not_merged')
  assert.equal(seen.filter(s => s.pr === 10 && !s.ship_only).length, 3, 'three monitor-only runs')
  assert.equal(seen.length, 4)
  assert.equal(calls.filter(c => c.label.startsWith('wait-s1-')).length, 5)
  assert.equal(result.lanes[0].re_monitored, 3)
  assert.match(result.stopped_at.reason, /still open after 5 wait round\(s\) and 3 more monitor run\(s\): changes requested/)
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
  // Accepting the lanes also allows public closes: the one question says so, and the relay names the way to decline it.
  assert.equal(result.questions.length, 1)
  assert.match(result.questions[0].why, /an issue of these lanes that triage and two independent refuters find already fixed on main is closed in public, with a comment quoting the evidence/)
  assert.match(result.relay, /Tell the person what confirming the lanes also allows/)
  assert.match(result.relay, /When the person wants those issues only reported, the re-run takes close: false/)
  assert.match(result.relay, /each issue by its number and title \(issues\)/)
  const noClose = await run('bug-fix-backlog', { root: '/w', close: false }, bfb())
  assert.equal(noClose.result.questions.length, 1)
  assert.doesNotMatch(noClose.result.questions[0].why, /closed in public/)
  assert.match(noClose.result.relay, /This run closes no issue \(close: false\)/)
  assert.equal(noClose.prompt('intake'), prompt('intake').replace('["bug","crash"]', '["bug"]'), 'the Intake prompt does not depend on close, so a replayed accept still fingerprints the same')
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
  // A bare 'accept' names no proposal: it stops again instead of building whatever this Intake proposes.
  const bare = await run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: 'accept' }] }, bfb())
  assert.equal(bare.result.status, 'needs_input')
  assert.equal(bare.result.accept_not_applied, 'no_fingerprint')
  assert.ok(!bare.calls.some(c => c.label.startsWith('triage:')), 'no lane runs on a bare accept')
  const none = await run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: '[]' }] }, bfb())
  assert.deepEqual(none.result, [])
  // The same answer as a JSON value, not a string: still "run nothing", never a re-asked Intake.
  const noneValue = await run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: [] }] }, bfb())
  assert.deepEqual(noneValue.result, [])
  assert.ok(!noneValue.calls.some(c => c.label === 'intake'), 'an empty-array answer is an answer')
  await assert.rejects(run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: 'yes please' }] }, bfb()), /must be 'accept' or a JSON array/)
})

await test('bug-fix-backlog: each intake option, relayed back as its own text, is understood', async () => {
  const stop = await run('bug-fix-backlog', { root: '/w' }, bfb())
  const opts = stop.result.questions[0].options
  const asked = async answer => run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer }] }, bfb())
  const triaged = calls => calls.map(c => c.label).filter(l => l.startsWith('triage:')).sort()
  const accepted = await asked(opts.find(o => /^accept/i.test(o)))
  assert.deepEqual(triaged(accepted.calls), ['triage:auth-login', 'triage:auth-login-2'], 'accept runs the proposed lanes')
  assert.deepEqual((await asked(opts.find(o => /^none/i.test(o)))).result, [], 'none runs nothing')
  assert.deepEqual((await asked('Accept')).calls.some(c => c.label === 'intake'), true)
  const inline = await asked('the edited lanes: [{"key": "x", "issues": [11]}]')
  assert.deepEqual(triaged(inline.calls), ['triage:x'], 'lanes JSON inside a sentence')
  await assert.rejects(asked(opts.find(o => /JSON array/.test(o))), /must be 'accept' or a JSON array/, 'the template itself is no answer')
})

await test('bug-fix-backlog: accept runs only the very proposal the person saw', async () => {
  const stop = await run('bug-fix-backlog', { root: '/w' }, bfb())
  const acceptOpt = stop.result.questions[0].options[0]
  assert.match(acceptOpt, /^accept [0-9a-f]{8} /, 'the accept option names its proposal')
  const triaged = calls => calls.map(c => c.label).filter(l => l.startsWith('triage:')).sort()
  // Same proposal on the re-run (a replay, or an Intake that grouped the same way): it runs.
  const same = await run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: acceptOpt }] }, bfb())
  assert.deepEqual(triaged(same.calls), ['triage:auth-login', 'triage:auth-login-2'])
  // The re-run's Intake grouped differently (or saw a new issue): nothing runs, the new proposal is asked again.
  const regrouped = { ...INTAKE_REPLY, lanes: [{ key: 'auth', issues: INTAKE_REPLY.issues.map(i => i.number).filter(n => !(INTAKE_REPLY.unlaned || []).some(u => u.number === n)), code_site: 's', why: 'w' }] }
  const changed = await run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: acceptOpt }] }, bfb({ intake: regrouped }))
  assert.equal(changed.result.status, 'needs_input')
  assert.equal(changed.result.accept_not_applied, 'proposal_changed')
  assert.ok(!changed.calls.some(c => c.label.startsWith('triage:')), 'no lane runs on a changed proposal')
  assert.notEqual(changed.result.questions[0].options[0], acceptOpt, 'the new proposal gets its own fingerprint')
})

await test('bug-fix-backlog: lanes a person edited are validated before any branch is named', async () => {
  const lanes = async given => run('bug-fix-backlog', { root: '/w', answers: [{ id: 'intake.q1', answer: JSON.stringify(given) }] }, bfb())
  for (const bad of [[{ key: 'a', issues: '12' }], [{ key: 'a', issues: 12 }], [{ key: 'a', issues: [] }], [{ key: 'a', issues: [0] }], [{ key: 'a', issues: ['x'] }], [{ key: 'a' }]]) {
    await assert.rejects(lanes(bad), /needs issues as a non-empty array of issue numbers/, JSON.stringify(bad))
  }
  const { calls } = await lanes([{ key: 'Auth session', issues: ['12'] }, { issues: [13] }])
  const triage = calls.map(c => c.label).filter(l => l.startsWith('triage:')).sort()
  assert.deepEqual(triage, ['triage:auth-session', 'triage:bug-13'], 'keys are slugged, a missing key is named after its first issue')
  await assert.rejects(lanes([{ key: 'A b', issues: [1] }, { key: 'a-b', issues: [2] }]), /share key a-b/)
  // An issue in two edited lanes would get two triages and two 'Fixes #12' PRs: refused before anything runs.
  const dup = lanes([{ key: 'a', issues: [12] }, { key: 'b', issues: [12, 14] }])
  await assert.rejects(dup, /issue #12 is in lanes a and b/)
})

// ---- bug-fix-backlog: a lane's question goes back through plan-to-merged-pr, and the lane result keeps what its run returned
const BUG_LANE = { key: 'k', issues: [11], dir: '/w/k', branch: 'bugfix/k' }
const BUG_TRIAGE = { branch: 'bugfix/k', ahead_of_main: 0, behind_main: 0, issues: [{ number: 11, title: 'a', verdict: 'plan', evidence: 'e' }], plan: 'the fix plan',
  assumptions: ['fixes the first of the two readings\nof #11'] }
const BUG_REPRO = { results: [{ number: 11, reproduced: true, behaviour_correct: false, tests: ['t.js::x'], failure_excerpt: '', notes: '' }] }
// One lane through triage and a reproduced bug, then the nested plan-to-merged-pr run returns `child`.
const bugLane = async (child, extra = {}, over = {}) => {
  const seen = []
  const workflow = async (name, a) => { seen.push({ name, args: a }); return child }
  const { result } = await run('bug-fix-backlog', { lanes: [BUG_LANE], ...extra }, bfb({ 'triage:k': BUG_TRIAGE, 'reproduce:k': BUG_REPRO, ...over }), { workflow })
  return { lane: result[0], seen }
}

await test('bug-fix-backlog: a lane\'s question is answered through plan-to-merged-pr with the lane\'s resume_args, never through triage again', async () => {
  const child = { status: 'needs_input', stage: 'fix', plan_ref: '', questions: [{ id: 'fix.q1', ...Q }], assumptions: [{ stage: 'impl', assumption: 'a' }] }
  const { lane, seen } = await bugLane(child, { on_question: 'stop', main_branch: 'trunk' })
  assert.equal(lane.status, 'needs_input')
  assert.equal(lane.stage, 'fix')
  assert.deepEqual(lane.questions.map(q => [q.lane, q.id]), [['k', 'fix.q1']])
  assert.equal(seen[0].name, 'plan-to-merged-pr')
  assert.deepEqual(lane.resume_args, seen[0].args, 'the args the lane\'s run was given')
  assert.deepEqual(Object.keys(lane.resume_args).sort(), ['branch', 'concern', 'dir', 'main_branch', 'on_question', 'plan_text', 'pr_note'])
  assert.ok(lane.relay.startsWith(RELAY_FIRST))
  assert.match(lane.relay, /Also show the person this lane's assumptions: a line they correct is passed as an answer too \(id <its stage>\.d<N>, with the assumption as its question\)\./)
  assert.match(lane.relay, /re-run plan-to-merged-pr with this lane's resume_args as args plus answers \(each question's id and question text with the person's answer and the date they gave it, without the lane key, added to any answers those args already hold\), without resumeFromRunId/)
  assert.doesNotMatch(lane.relay, /re-run bug-fix-backlog/)
  assert.match(lane.relay, /Never send this lane back through bug-fix-backlog: its triage would judge the kept worktree, which now holds the fix, or skip the issue once the lane's own PR is open\./)
  // What triage assumed and what the lane's stages assumed, in one list; triage's also travel in the plan, for the PR body.
  assert.deepEqual(lane.assumptions, [{ stage: 'triage', assumption: 'fixes the first of the two readings of #11' }, { stage: 'impl', assumption: 'a' }])
  assert.ok(seen[0].args.plan_text.endsWith('\n\n## Assumptions to review\n\n- assumed (triage): fixes the first of the two readings of #11\n'), 'the plan ends with the section plan-to-merged-pr keeps')
  assert.equal(seen[0].args.pr_note, 'Fixes #11')
  // An answer given with the lane reaches its run with its question text and date, and stays in resume_args.
  const answers = [{ lane: 'k', id: 'impl.q1', answer: 'per process', question: Q.question, date: '2026-11-12' }, { lane: 'other', id: 'impl.q1', answer: 'no' }]
  const again = await bugLane(child, { answers })
  assert.deepEqual(again.seen[0].args.answers, [{ id: 'impl.q1', answer: 'per process', question: Q.question, date: '2026-11-12' }])
  assert.deepEqual(again.lane.resume_args.answers, again.seen[0].args.answers)
})

await test('bug-fix-backlog: a lane whose monitor asked carries resume_monitor and a monitor-only relay, with no resume_args', async () => {
  const resume_monitor = { pr: 5, branch: 'bugfix/k', dir: '/w/k', plan_ref: 'plans/bugfix-k-1.md' }
  const { lane } = await bugLane({ status: 'needs_input', stage: 'monitor', pr: { pr_number: 5, url: 'u' }, questions: [{ id: 'monitor.q1', ...Q }], resume_monitor, assumptions: [] })
  assert.equal(lane.status, 'needs_input')
  assert.deepEqual(lane.resume_monitor, resume_monitor)
  assert.equal(lane.resume_args, undefined)
  assert.ok(lane.relay.startsWith(RELAY_FIRST))
  assert.match(lane.relay, /This lane's PR is already open: re-run plan-to-merged-pr with this lane's resume_monitor as args plus answers/)
  assert.match(lane.relay, /in monitor-only mode and without resumeFromRunId, so the PR is observed afresh\./)
  assert.doesNotMatch(lane.relay, /resume_args|re-run bug-fix-backlog/)
  assert.match(lane.relay, /Never send this lane back through bug-fix-backlog/)
})

await test('bug-fix-backlog: the lane result keeps the hand-off, the saved plan, the assumptions and what was left uncommitted', async () => {
  const child = { status: 'OPEN', pr: { pr_number: 5, url: 'u' }, review_clean: true, polish_clean: false, handoff: 'PR #5 handed off — settled', resume_monitor: { pr: 5, branch: 'bugfix/k' },
    plan_ref: 'plans/bugfix-k-1.md', assumptions: [{ stage: 'polish', assumption: 'p' }], left_uncommitted: ['docs/brief.md'],
    declined: [{ round: 1, finding: 'f', reason: 'r' }], polish_unfixed: [{ file: 'a.js', severity: 'concern', description: 'd' }] }
  const { lane } = await bugLane(child)
  assert.equal(lane.status, 'OPEN')
  for (const k of ['handoff', 'resume_monitor', 'plan_ref', 'left_uncommitted', 'declined', 'polish_unfixed']) assert.deepEqual(lane[k], child[k], k)
  assert.deepEqual(lane.assumptions, [{ stage: 'triage', assumption: 'fixes the first of the two readings of #11' }, { stage: 'polish', assumption: 'p' }])
  for (const k of ['resume_args', 'relay', 'questions', 'reason', 'stage', 'review_findings']) assert.equal(lane[k], undefined, k)
  // A lane with nothing to ship still lists what its triage assumed.
  const none = await run('bug-fix-backlog', { lanes: [BUG_LANE] }, bfb({ 'triage:k': { ...BUG_TRIAGE, issues: [{ number: 11, title: 'a', verdict: 'skip', evidence: 'e', skip_reason: 'issue_already_closed' }], plan: '' } }))
  assert.equal(none.result[0].status, 'nothing_to_ship')
  assert.deepEqual(none.result[0].assumptions, [{ stage: 'triage', assumption: 'fixes the first of the two readings of #11' }])
  assert.match(none.prompt('triage:k'), /List in assumptions every choice the plan makes that the issues and the code do not settle/)
  assert.match(none.prompt('triage:k'), /A choice that is the person's to make .* is never settled in the plan: write it there as open, naming the options, so the implementer's stage asks the person\./)
})

await test('bug-fix-backlog: a lane that stopped says why in one line and carries the args to go on with', async () => {
  const atMerge = await bugLane({ status: 'blocked_at_merge_check', merge_check: { blocked_reason: 'why' } })
  assert.equal(atMerge.lane.reason, 'why')
  assert.deepEqual(atMerge.lane.resume_args, atMerge.seen[0].args)
  assert.equal(atMerge.lane.relay, undefined, 'no question, no relay')
  assert.equal((await bugLane({ status: 'failed_at_impl', stop_reason: 'plan review:\n a blocker' })).lane.reason, 'plan review: a blocker')
  assert.equal((await bugLane({ status: 'blocked_at_pr', pr_stage: { blocked: true, blocked_reason: 'no push access' } })).lane.reason, 'no push access')
  assert.equal((await bugLane({ status: 'blocked_at_merge_check', merge_check: { merge_check: 'gates red after the merge', gates_green: false } })).lane.reason, 'gates red after the merge')
  const atReview = await bugLane({ status: 'blocked_at_review', review_findings: [{ file: 'a.js', severity: 'bug', description: 'still\nbroken' }, { file: 'b.js', severity: 'nit', description: 'n' }] })
  assert.deepEqual(atReview.lane.review_findings, ['bug: a.js: still broken'])
  assert.ok(atReview.lane.resume_args)
  // A lane that pushed (build-only) or whose PR is open is not unfinished: no resume_args.
  assert.equal((await bugLane({ status: 'pushed', plan_ref: 'plans/bugfix-k-1.md' }, { ship: false })).lane.resume_args, undefined)
})

await test('bug-fix-backlog: the PR note says which fixed issue no failing test reproduced, and adds no closing keyword', async () => {
  const over = { 'reproduce:k': { results: [{ number: 11, reproduced: false, behaviour_correct: false, tests: [], failure_excerpt: '', notes: '' }] }, 'skeptic:k': { results: [{ number: 11, refuted: false, evidence: 'real' }] } }
  const { lane, seen } = await bugLane({ status: 'pushed' }, {}, over)
  assert.equal(lane.bugs[0].note, 'not reproduced by a test; skeptic could not refute')
  assert.equal(seen[0].args.pr_note, 'Fixes #11\n#11 was not reproduced by a failing test before the fix.')
  // plan-to-merged-pr's test for closing keywords in a note: the added line holds none.
  assert.equal(seen[0].args.pr_note.match(/\b(fix(es|ed)?|close[sd]?|resolve[sd]?):?\s+#\d+\b/gi).length, 1)
})

process.exit(failed ? 1 : 0)

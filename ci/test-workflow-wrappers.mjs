// Behavioural tests for the wrapper workflows: bootstrap-repo (/bootstrap, then plan-to-merged-pr ship-only) and
// refresh-proposal (/review-proposal and /propose --revise until clean, then the lint). Both return a compact result to the
// session that runs them; these tests check what they hand back, which stages saw which answers, and what they never do.
// Each workflow body runs against scripted mock agents: a responder picks the reply by the agent's label, and every prompt and
// every log line is recorded. The nested plan-to-merged-pr run is a mock workflow() that records its args.
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
    calls.push({ label: opts.label, prompt, effort: opts.effort })
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
    args, agent, parallel, pipeline, workflow || (async () => { throw new Error('no nested workflow in this test') }), () => {}, m => logs.push(String(m)))
  return { result, calls, logs, prompt: label => (calls.find(c => c.label === label) || {}).prompt || '' }
}

const Q = { question: 'Which name goes in the LICENSE copyright line?', why: 'the product name or the person changes the licence text', options: ['the person', 'the product'], recommended: 'the person' }
const NO_TEXT_LOG = id => `Answer(s) passed without their question text: ${id} (pass each answer with its question, so every stage can tell what it settles)`
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`) }
}

// ---- bootstrap-repo
const BRANCH = 'bootstrap/20261110'
// The next steps /bootstrap's report prints: the workflow hands each on verbatim, the one that sends a Decision the person
// answered here back into the architecture (the refresh-proposal workflow) included.
const AFTER = ['Protect main: require the checks gates and docs.', 'Add each secret by NAME: gh secret set API_KEY.',
  'For each baked-in Decision the person confirmed or corrected in this run (listed under Answers): run the refresh-proposal workflow on docs/design/architecture.md with that answer, then re-accept the doc.',
  'Tick the roadmap\'s Bootstrap gate (milestone 2).']
const BOOT_OK = { outcome: 'committed', root_mode: false, branch: BRANCH, commit: 'abc1234', summary: 'one node package, gates PASS in 1 fix round, CI gates + docs, MIT', left_out: ['brief.md'], next_steps: AFTER }
const boot = (over = {}) => (label, prompt) => {
  if (over[label] !== undefined) return typeof over[label] === 'function' ? over[label](prompt) : over[label]
  if (label === 'bootstrap') return BOOT_OK
  return {}
}
const BARGS = { architecture: 'docs/design/architecture.md', dir: '/abs/p' }
// A plan-to-merged-pr result as heavy as a real one: the wrapper must slim it before it reaches the caller.
const P2MP_OPEN = {
  status: 'OPEN', branch: BRANCH, plan: null, impl: null, review_clean: null, polish_clean: false,
  assumptions: [{ stage: 'merge_check', assumption: 'kept the lockfile /bootstrap wrote' }],
  pr: { pr_number: 5, url: 'https://github.com/o/r/pull/5' },
  monitor_actions: Array.from({ length: 6 }, (_, i) => ({ round: i + 1, step: 'process-comments', pushed: true, handled: 3, remaining: 0, summary: 'x'.repeat(2000) })),
  final_state: { pr_state: 'OPEN', head_sha: 'abcdef1234567890', has_conflicts: false, behind_main: false, ai_review_done_on_head: true, ci_state: 'green', ci_red_caused_by_pr: false, ci_configured: true, actionable_comments: 0, notes: 'n'.repeat(3000) },
  resume_monitor: { pr: 5, branch: BRANCH, dir: '/abs/p' },
  handoff: 'PR #5 handed off — settled: nothing actionable for 2 rounds, ready for a person to merge. Later comments, conflicts or red CI are not watched.',
  merge_check: { blocked: false, merge_check: 'm'.repeat(4000), gates_green: true, pushed: false },
}
const noShip = async () => { throw new Error('this run must not ship') }

await test('bootstrap-repo: the ship path calls plan-to-merged-pr ship-only with the bootstrap branch and returns a slim result', async () => {
  const seen = []
  const workflow = async (name, a) => { seen.push({ name, ...a }); return P2MP_OPEN }
  const trailers = ['Co-Authored-By: Claude <noreply@anthropic.com>', 'Claude-Session: https://example.com/s']
  const args = { ...BARGS, github_access: 'connector', gate: './.claude/scripts/gate-slot.sh', commit_trailers: trailers, main_branch: 'main', ai_review_check: 'Review', on_question: 'stop', efforts: { bootstrap: 'high', monitor: 'medium' } }
  const { result, calls, prompt } = await run('bootstrap-repo', args, boot(), { workflow })
  assert.equal(result.status, 'pr_open')
  assert.deepEqual(calls.map(c => [c.label, c.effort]), [['bootstrap', 'high']])
  assert.deepEqual(seen, [{ name: 'plan-to-merged-pr', ship_only: true, branch: BRANCH, title: 'Bootstrap repository', dir: '/abs/p', main_branch: 'main', ai_review_check: 'Review', github_access: 'connector', gate: './.claude/scripts/gate-slot.sh', commit_trailers: trailers, on_question: 'stop', efforts: { monitor: 'medium' } }])
  // Slim: what the person and the next session act on, never the monitor's per-round log or the merge check's text.
  assert.deepEqual(Object.keys(result.ship).sort(), ['final_state', 'handoff', 'pr', 'resume_monitor', 'status'])
  assert.deepEqual(result.ship.pr, { pr_number: 5, url: 'https://github.com/o/r/pull/5' })
  assert.equal(result.ship.final_state, 'OPEN @abcdef123, CI green, 0 actionable comment(s)')
  assert.deepEqual(result.ship.resume_monitor, P2MP_OPEN.resume_monitor)
  assert.ok(JSON.stringify(result).length < 3000, `result is ${JSON.stringify(result).length} bytes`)
  assert.deepEqual(Object.keys(result).sort(), ['assumptions', 'bootstrap', 'next_steps', 'ship', 'status'])
  assert.deepEqual(result.bootstrap, { outcome: 'committed', root_mode: false, branch: BRANCH, commit: 'abc1234', summary: BOOT_OK.summary, left_out: ['brief.md'] })
  assert.match(result.next_steps[0], /merge PR #5 \(https:\/\/github\.com\/o\/r\/pull\/5\) yourself/)
  assert.match(result.next_steps[0], /ship\.resume_monitor/)
  assert.match(result.next_steps[1], /left brief\.md out of its commit on purpose/)
  assert.deepEqual(result.next_steps.slice(2), AFTER)
  assert.match(prompt('bootstrap'), /In next_steps, put every next step its report prints, each verbatim with the values it filled in, except reviewing the commit and shipping it/)
  assert.deepEqual(result.assumptions, [{ stage: 'ship.merge_check', assumption: 'kept the lockfile /bootstrap wrote' }])
  // The bootstrap stage: the skill and its doc, the access in use, the gate wrapper and the trailers; it never ships itself.
  const p = prompt('bootstrap')
  assert.match(p, /skill "bootstrap" with args "docs\/design\/architecture\.md"/)
  assert.match(p, /The access in use is connector/)
  assert.match(p, /github-access\.md/)
  assert.match(p, /`\.\/\.claude\/scripts\/gate-slot\.sh <command>`/)
  assert.match(p, /Bootstrapped-by: \/bootstrap trailer, then these lines[^\n]*\nCo-Authored-By: Claude <noreply@anthropic\.com>\nClaude-Session/)
  assert.match(p, /never pushes and never opens a PR, and neither do you/)
  assert.match(p, /Work ONLY in the git checkout \/abs\/p/)
})

await test('bootstrap-repo: defaults reach neither stage as settings nobody gave', async () => {
  const seen = []
  const { calls, prompt } = await run('bootstrap-repo', BARGS, boot(), { workflow: async (n, a) => { seen.push(a); return P2MP_OPEN } })
  assert.deepEqual(seen[0], { ship_only: true, branch: BRANCH, title: 'Bootstrap repository', dir: '/abs/p' })
  assert.equal(calls[0].effort, 'medium')
  assert.match(prompt('bootstrap'), /GITHUB_ACCESS from the "Pipeline config" section of CLAUDE\.md when it is set, else .*gh when it is authenticated, else the connector/)
  assert.doesNotMatch(prompt('bootstrap'), /gate wrapper|in place of the session's Co-Authored-By/)
})

await test('bootstrap-repo: root mode skips shipping and says to push main', async () => {
  const { result, prompt } = await run('bootstrap-repo', BARGS, boot({ bootstrap: { ...BOOT_OK, root_mode: true, branch: 'main' } }), { workflow: noShip })
  assert.equal(result.status, 'root_commit')
  assert.equal(result.ship, undefined)
  assert.match(result.next_steps[0], /push it yourself: git push -u origin main/)
  assert.match(result.next_steps[0], /Nothing was shipped/)
  assert.deepEqual(result.next_steps.slice(1), AFTER)
  assert.equal(result.bootstrap.root_mode, true)
  assert.match(prompt('bootstrap'), /in root mode pushing main/)
})

await test('bootstrap-repo: a bootstrap question stops before shipping; on a re-run its answer reaches the bootstrap stage and the ship run', async () => {
  const first = await run('bootstrap-repo', BARGS, boot({ bootstrap: { outcome: 'stopped', questions: [Q] } }), { workflow: noShip })
  assert.equal(first.result.status, 'needs_input')
  assert.deepEqual(first.result.questions.map(q => [q.id, q.stage]), [['bootstrap.q1', 'bootstrap']])
  assert.equal(first.result.questions[0].recommended, 'the person')
  assert.match(first.result.relay, /never answer them on their behalf/)
  assert.match(first.result.relay, /resumeFromRunId/)
  assert.match(first.result.next_steps[0], /answer the 1 question\(s\)/)
  assert.match(first.prompt('bootstrap'), /QUESTIONS: this stage runs unattended/)
  assert.match(first.prompt('bootstrap'), /return every such question/)
  assert.match(first.prompt('bootstrap'), /An error= stop the command defines is a stop to report, not a question/)
  // The stage asks before its first write, so a question stop leaves no branch and no file, and the result says so.
  assert.match(first.prompt('bootstrap'), /stop before the first write \(create no branch, write no file\)/)
  assert.doesNotMatch(first.prompt('bootstrap'), /what the command already wrote stays/)
  assert.match(first.result.next_steps[0], /nothing was written: \/bootstrap asked before its first write, so it created no branch and no file/)
  assert.match(first.result.relay, /It asked before its first write, so nothing was written: no branch, no file\./)
  // The relay: one batch through the question tool, the assumptions shown too, each answer back with its question and date.
  assert.match(first.result.relay, /^Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit \(a numbered list when it has none\), each with its why/)
  assert.match(first.result.relay, /never re-run with on_question: 'assume' unless the person says to proceed on assumptions/)
  assert.match(first.result.relay, /Also show the person this result's assumptions: a line they correct, or any decision they make outside these questions, is passed as an answer too \(id bootstrap\.d<N>, N the next number not yet in use, with the assumption or the decision as its question\)\./)
  assert.match(first.result.relay, /each question's id and question text with the person's answer and the date they gave it/)
  // The confirmations come as one list, and a session with no run record is told how to re-run.
  assert.match(first.result.relay, /Show the confirmations \(the questions with confirm: true\) as one list the person can accept whole or correct line by line\. Also show the person/)
  assert.match(first.result.relay, /no branch, no file\. A new session has no run record: re-run the same way without resumeFromRunId\.$/)
  // An answer replaces the architecture's value on the point it addresses: that difference is no conflict to ask about again.
  assert.ok(first.prompt('bootstrap').includes('What the person said in an answer outranks the architecture. On the point it addresses, it replaces what the architecture says: follow it, and never ask it again. That difference is not a conflict. ' +
    'The conflict that is a blocking question is the other one: another part of the architecture, the tree or your research makes what the person said impossible to follow. Then pick no side and ask, naming both. '))
  assert.match(first.prompt('bootstrap'), /A confirmation \(a baked-in decision the architecture records as unconfirmed\) has confirm: true and its Choice as the recommended option\./)
  // The stage reads the design run's saved answers itself, so a choice the person made there is not asked a second time.
  assert.match(first.prompt('bootstrap'), /read them with python3 \.claude\/scripts\/pipeline-state\.py get design\/answers\.json \(this read of the state branch is allowed and changes nothing in \/abs\/p; exit 3 or 2: none are saved, go on without them\)\. Each of its answers is the person's: binding, and never re-asked\./)
  assert.match(first.prompt('bootstrap'), /A choice the skeleton bakes in that one of them settles \(the licence, also between the architecture's and an existing LICENSE file's; the copyright holder; a name\) is settled: follow the answer, and ask nothing about it\./)
  assert.doesNotMatch(first.prompt('bootstrap'), /the one listed above is the newer/, 'no answers were passed')
  // What the stage is told about the person's choices: a conflict is asked, a person-owned choice is never assumed, nothing settled is changed.
  assert.match(first.prompt('bootstrap'), /a conflict between what the person said \(an answer, the framing, a decision the architecture tags \(person, \.\.\.\)\) and what you find/)
  assert.match(first.prompt('bootstrap'), /In two cases a person-owned choice the skeleton bakes in is asked as a blocking question, never assumed: when no decision of the architecture and no answer settles it, and when the architecture records it as unconfirmed \(a baked-in decision tagged \(assumed\) or untagged, which no answer confirms: a confirmation, with its Choice as the recommended option\)\./)
  assert.match(first.prompt('bootstrap'), /\(the copyright holder, an existing LICENSE of another licence, no licence decision, a published name, a baked-in decision nobody confirmed\)/)
  assert.match(first.prompt('bootstrap'), /Never change what the person settled/)
  assert.match(first.prompt('bootstrap'), /name decisions and milestones by title/)
  const seen = []
  const answers = [{ id: 'bootstrap.q1', question: Q.question, answer: 'ANSWER-BOOT', date: '2026-11-12' }]
  const again = await run('bootstrap-repo', { ...BARGS, answers }, boot(), { workflow: async (n, a) => { seen.push(a); return P2MP_OPEN } })
  assert.equal(again.result.status, 'pr_open')
  assert.match(again.prompt('bootstrap'), /ANSWER-BOOT/)
  assert.ok(again.prompt('bootstrap').includes(JSON.stringify([{ id: 'bootstrap.q1', question: Q.question, answer: 'ANSWER-BOOT', date: '2026-11-12' }])), 'the prompt shows the id, the question text and the date')
  assert.match(again.prompt('bootstrap'), /Where an answer listed above and a saved one settle the same point differently, the one listed above is the newer and holds\./)
  assert.deepEqual(seen[0].answers, answers, 'an answer reaches every later stage')
  // A new question on a later run never reuses the answered id.
  const third = await run('bootstrap-repo', { ...BARGS, answers }, boot({ bootstrap: { outcome: 'stopped', questions: [Q] } }), { workflow: noShip })
  assert.equal(third.result.questions[0].id, 'bootstrap.q2')
  // A decision the person made outside the questions (bootstrap.d<N>) reaches the bootstrap stage and takes no part in the numbering.
  const decided = [...answers, { id: 'bootstrap.d1', question: 'copyright holder', answer: 'DECISION-D1' }]
  const fourth = await run('bootstrap-repo', { ...BARGS, answers: decided }, boot({ bootstrap: { outcome: 'stopped', questions: [Q] } }), { workflow: noShip })
  assert.match(fourth.prompt('bootstrap'), /DECISION-D1/)
  assert.equal(fourth.result.questions[0].id, 'bootstrap.q2')
  // A confirmation keeps its mark, and a question's own id or stage never replaces the workflow's.
  const C = { question: 'The architecture names the package acme-app (assumed): publish under it?', why: 'a published name is hard to change', options: ['acme-app', 'another name'], recommended: 'acme-app', confirm: true, id: 'q1', stage: 'x' }
  const fifth = await run('bootstrap-repo', BARGS, boot({ bootstrap: { outcome: 'stopped', questions: [Q, C] } }), { workflow: noShip })
  assert.deepEqual(fifth.result.questions.map(q => [q.id, q.stage, q.confirm]), [['bootstrap.q1', 'bootstrap', undefined], ['bootstrap.q2', 'bootstrap', true]])
})

await test('bootstrap-repo: a design answer reaches the bootstrap stage and the ship run; an answer passed without its question says so', async () => {
  const seen = []
  const design = { id: 'intake.d4', question: 'Which licence does the product ship under?', answer: 'DESIGN-D4: MIT', date: '2026-11-12' }
  const answers = [design, { id: 'merge_check.q1', answer: 'ANSWER-SHIP' }, { id: 'monitor.d1', question: 'a monitor assumption', answer: 'ANSWER-MON' }]
  const { result, prompt } = await run('bootstrap-repo', { ...BARGS, answers }, boot(), { workflow: async (n, a) => { seen.push(a); return P2MP_OPEN } })
  assert.equal(result.status, 'pr_open')
  // The stage that writes the licence, the names and the skeleton sees the design answer, with its question and date.
  assert.ok(prompt('bootstrap').includes(JSON.stringify([design])), 'the bootstrap stage gets the design answer and no ship answer')
  assert.doesNotMatch(prompt('bootstrap'), /ANSWER-SHIP|ANSWER-MON/)
  assert.doesNotMatch(prompt('bootstrap'), /passed without its question text/, 'every answer it got has its question')
  assert.deepEqual(seen[0].answers, answers, 'the ship run gets every answer')
  // An id-only answer still binds, but the stage is told never to guess what it settled.
  const bare = await run('bootstrap-repo', { ...BARGS, answers: { 'bootstrap.q1': 'yes' } }, boot(), { workflow: async () => P2MP_OPEN })
  assert.ok(bare.prompt('bootstrap').includes('[{"id":"bootstrap.q1","question":"bootstrap.q1","answer":"yes"}]\nAn entry above whose question equals its id was passed without its question text. When its answer alone does not say what it settles, it settles nothing: never guess what it meant. '))
  assert.ok(bare.logs.includes(NO_TEXT_LOG('bootstrap.q1')), 'the run says so in its log')
  assert.ok(!(await run('bootstrap-repo', { ...BARGS, answers: [design] }, boot(), { workflow: async () => P2MP_OPEN })).logs.some(l => l.includes('without their question text')))
})

await test('bootstrap-repo: a question that surfaces after the first write names the unfinished branch the re-run resumes on', async () => {
  const { result } = await run('bootstrap-repo', BARGS, boot({ bootstrap: { outcome: 'stopped', branch: BRANCH, questions: [Q] } }), { workflow: noShip })
  assert.equal(result.status, 'needs_input')
  assert.equal(result.bootstrap.branch, BRANCH)
  assert.match(result.next_steps[0], new RegExp(`nothing is committed, and the uncommitted files /bootstrap wrote stay on ${BRANCH}, where the re-run resumes`))
  assert.doesNotMatch(result.next_steps[0], /nothing was written/)
  assert.match(result.relay, new RegExp(`the files it wrote stay on ${BRANCH}, and the re-run resumes there\\. A new session has no run record: re-run the same way without resumeFromRunId \\(/bootstrap resumes on ${BRANCH} while that checkout exists\\)\\.$`))
  assert.doesNotMatch(result.relay, /nothing was written/)
})

await test('bootstrap-repo: the bootstrap stage\'s assumptions reach the PR body and the first next step', async () => {
  const seen = []
  const assumed = { ...BOOT_OK, assumptions: ['SPDX-only LICENSE: replace with the canonical text', 'Decision "Licence" is tagged (assumed)'] }
  const { result, prompt } = await run('bootstrap-repo', BARGS, boot({ bootstrap: assumed }), { workflow: async (n, a) => { seen.push(a); return P2MP_OPEN } })
  assert.equal(result.status, 'pr_open')
  assert.match(prompt('bootstrap'), /with every line the command's report lists under Assumptions/)
  assert.deepEqual(result.assumptions, [
    { stage: 'bootstrap', assumption: 'SPDX-only LICENSE: replace with the canonical text' },
    { stage: 'bootstrap', assumption: 'Decision "Licence" is tagged (assumed)' },
    { stage: 'ship.merge_check', assumption: 'kept the lockfile /bootstrap wrote' },
  ])
  // The ship run gets them as assumptions: it lists them in the PR body, and its monitor knows each as a choice nobody confirmed.
  assert.deepEqual(seen[0].assumptions, [{ stage: 'bootstrap', assumption: 'SPDX-only LICENSE: replace with the canonical text' }, { stage: 'bootstrap', assumption: 'Decision "Licence" is tagged (assumed)' }])
  assert.equal(seen[0].pr_note, undefined)
  // The ship run's result lists them back beside its own: they are not counted a second time.
  const echo = await run('bootstrap-repo', BARGS, boot({ bootstrap: assumed }), { workflow: async (n, a) => ({ ...P2MP_OPEN, assumptions: [...a.assumptions, ...P2MP_OPEN.assumptions] }) })
  assert.deepEqual(echo.result.assumptions, result.assumptions)
  // The commit exists, so a line the person corrects is a review comment on the PR, never an answer nothing would apply.
  assert.match(result.next_steps[0], /Before the merge, show the person this result's assumptions \(3\): a line they correct is no answer to a re-run \(nothing would apply it\): they leave it as a review comment on the PR, and a monitor run's comment step applies it\./)
  assert.match(result.next_steps[0], /The PR body was given \/bootstrap's under "Assumptions to review"/)
  // ship: false hands the same note to the later ship run; root mode says to show them before the push.
  const later = await run('bootstrap-repo', { ...BARGS, ship: false }, boot({ bootstrap: assumed }), { workflow: noShip })
  assert.match(later.result.next_steps[0], /"assumptions":\[\{"stage":"bootstrap","assumption":"SPDX-only LICENSE: replace with the canonical text"\},/)
  assert.match(later.result.next_steps[0], /Before the merge, show the person this result's assumptions \(2\): a line they correct is no answer to a re-run \(nothing would apply it\): they leave it as a review comment on the PR, once it is open, and a monitor run's comment step applies it\./)
  const root = await run('bootstrap-repo', BARGS, boot({ bootstrap: { ...assumed, root_mode: true, branch: 'main' } }), { workflow: noShip })
  assert.match(root.result.next_steps[0], /Before the push, show the person this result's assumptions \(2\): a line they correct is a change to commit on main first\./)
  // No assumption: no note, and no step about them.
  const none = await run('bootstrap-repo', { ...BARGS, ship: false }, boot(), { workflow: noShip })
  assert.doesNotMatch(none.result.next_steps[0], /pr_note|assumptions|Assumptions to review/)
})

await test('bootstrap-repo: a ship question is relayed; its answer reaches the ship run only, so a resume replays the bootstrap stage', async () => {
  const asking = { status: 'needs_input', stage: 'merge_check', branch: BRANCH, questions: [{ id: 'merge_check.q1', stage: 'merge_check', ...Q }], relay: 'the child relay', assumptions: [] }
  const first = await run('bootstrap-repo', BARGS, boot(), { workflow: async () => asking })
  assert.equal(first.result.status, 'needs_input')
  assert.deepEqual(first.result.questions.map(q => q.id), ['merge_check.q1'])
  assert.match(first.result.relay, /re-run this workflow with the same args plus answers/)
  assert.match(first.result.relay, /resumeFromRunId/)
  assert.equal(first.result.ship.status, 'needs_input')
  assert.equal(first.result.ship.stage, 'merge_check')
  assert.match(first.result.next_steps[0], new RegExp(`the commit is on ${BRANCH}`))
  assert.match(first.result.relay, /the commit \/bootstrap made is kept \(a stage whose prompt is unchanged replays from the record\), and the ship run starts again with the answers\. A new session has no run record: re-run the same way without resumeFromRunId \(\/bootstrap finds its commit and changes nothing\)\.$/)
  assert.doesNotMatch(first.result.relay, /nothing was written/)
  // The commit exists: a corrected assumption is a review comment on the PR, never an answer no stage would apply.
  assert.match(first.result.relay, /Also show the person this result's assumptions\. A line they correct is no answer: the bootstrap commit exists, so no stage of the re-run would apply it\. The person leaves the correction as a review comment on the bootstrap PR, once it is open, and a monitor run's comment step applies it\. Only the answers to these questions go into answers\. Then re-run this workflow/)
  assert.doesNotMatch(first.result.relay, /is passed as an answer too|confirm: true/)
  const seen = []
  const answers = { 'merge_check.q1': 'ANSWER-SHIP' }
  const again = await run('bootstrap-repo', { ...BARGS, answers }, boot(), { workflow: async (n, a) => { seen.push(a); return P2MP_OPEN } })
  assert.equal(again.prompt('bootstrap'), first.prompt('bootstrap'), 'the bootstrap prompt is unchanged by a ship answer')
  assert.deepEqual(seen[0].answers, [{ id: 'merge_check.q1', answer: 'ANSWER-SHIP' }])
  assert.equal(again.result.status, 'pr_open')
})

await test('bootstrap-repo: a monitor question relays the monitor-only re-run on the open PR', async () => {
  const asking = { status: 'needs_input', stage: 'monitor', questions: [{ id: 'monitor.q1', stage: 'monitor', ...Q }], pr: { pr_number: 5, url: 'u' }, resume_monitor: { pr: 5, branch: BRANCH, dir: '/abs/p' }, assumptions: [] }
  const { result } = await run('bootstrap-repo', BARGS, boot(), { workflow: async () => asking })
  assert.equal(result.status, 'needs_input')
  assert.match(result.relay, /ship\.resume_monitor as args plus answers/)
  assert.match(result.relay, /never answer them on their behalf/)
  assert.match(result.relay, /^Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit \(a numbered list when it has none\), each with its why/)
  assert.match(result.relay, /Also show the person this result's assumptions\. A line they correct is no answer: the bootstrap commit exists, so no stage of the re-run would apply it\. The person leaves the correction as a review comment on the bootstrap PR, and a monitor run's comment step applies it\. Only the answers to these questions go into answers\. The bootstrap PR is already open/)
  assert.doesNotMatch(result.relay, /is passed as an answer too/)
  assert.match(result.relay, /the date they gave it/)
  assert.deepEqual(result.ship.resume_monitor, asking.resume_monitor)
  assert.match(result.next_steps[0], /PR #5 \(u\) is open/)
})

await test('bootstrap-repo: ship: false commits only and gives the ship-only args to run later', async () => {
  const { result } = await run('bootstrap-repo', { ...BARGS, ship: false, title: 'Bootstrap acme', github_access: 'gh' }, boot(), { workflow: noShip })
  assert.equal(result.status, 'committed')
  assert.equal(result.ship, undefined)
  assert.match(result.next_steps[0], new RegExp(`git -C /abs/p show --stat ${BRANCH}`))
  assert.ok(result.next_steps[0].includes(JSON.stringify({ ship_only: true, branch: BRANCH, title: 'Bootstrap acme', dir: '/abs/p', github_access: 'gh' })))
  assert.match(result.next_steps[1], /brief\.md/)
  // The args to ship with later carry what the person answered, so that run's merge check and monitor know what is settled.
  const answers = [{ id: 'bootstrap.q1', question: Q.question, answer: 'the person', date: '2026-11-12' }, { id: 'intake.d2', question: 'Which licence?', answer: 'MIT' }]
  const answered = await run('bootstrap-repo', { ...BARGS, ship: false, answers }, boot(), { workflow: noShip })
  assert.ok(answered.result.next_steps[0].includes(JSON.stringify({ ship_only: true, branch: BRANCH, title: 'Bootstrap repository', dir: '/abs/p', answers })))
  // So do the args a stopped ship prints.
  const stopped = await run('bootstrap-repo', { ...BARGS, answers }, boot(), { workflow: async () => ({ status: 'blocked_at_pr', pr_stage: { blocked: true, blocked_reason: 'error=github_unavailable' }, assumptions: [] }) })
  assert.ok(stopped.result.next_steps[0].includes(`or run plan-to-merged-pr with ${JSON.stringify({ ship_only: true, branch: BRANCH, title: 'Bootstrap repository', dir: '/abs/p', answers })}.`))
})

await test('bootstrap-repo: an error= stop fails at bootstrap with its next action; only a bootstrap branch is ever shipped', async () => {
  const stop = await run('bootstrap-repo', BARGS, boot({ bootstrap: { outcome: 'stopped', stop_reason: 'error=not_accepted: Status: draft', next_steps: ['Set Status: accepted on docs/design/architecture.md once you approve it.'] } }), { workflow: noShip })
  assert.equal(stop.result.status, 'failed_at_bootstrap')
  assert.equal(stop.result.stop_reason, 'error=not_accepted: Status: draft')
  assert.deepEqual(stop.result.next_steps, ['Set Status: accepted on docs/design/architecture.md once you approve it.', 'Then re-run this workflow with the same args.'])
  for (const branch of ['main', '', 'feat/x', 'bootstrap/ x']) {
    const r = await run('bootstrap-repo', BARGS, boot({ bootstrap: { ...BOOT_OK, branch } }), { workflow: noShip })
    assert.equal(r.result.status, 'failed_at_bootstrap', JSON.stringify(branch))
    assert.match(r.result.stop_reason, /not a bootstrap\/<date> branch/)
  }
  const dead = await run('bootstrap-repo', BARGS, () => null, { workflow: noShip })
  assert.equal(dead.result.status, 'failed_at_bootstrap')
  assert.match(dead.result.stop_reason, /failed to report/)
  assert.deepEqual(dead.result.next_steps, ['Fix what stopped it, then re-run this workflow with the same args.'])
})

await test('bootstrap-repo: an already-merged bootstrap ships nothing; a branch still waiting for its PR is shipped', async () => {
  const merged = await run('bootstrap-repo', BARGS, boot({ bootstrap: { outcome: 'already_bootstrapped', merged: true, next_steps: AFTER } }), { workflow: noShip })
  assert.equal(merged.result.status, 'already_bootstrapped')
  assert.equal(merged.result.bootstrap.merged, true)
  assert.deepEqual(merged.result.next_steps, AFTER)
  const seen = []
  const waiting = await run('bootstrap-repo', BARGS, boot({ bootstrap: { ...BOOT_OK, outcome: 'already_bootstrapped', merged: false } }), { workflow: async (n, a) => { seen.push(a); return { ...P2MP_OPEN, status: 'MERGED' } } })
  assert.equal(waiting.result.status, 'merged')
  assert.equal(seen[0].branch, BRANCH)
  assert.match(waiting.result.next_steps[0], /PR #5 .* has merged/)
  assert.deepEqual(waiting.result.next_steps.slice(1), AFTER)
  // A branch with no bootstrap commit is an unfinished run: it is never shipped, whatever the stage calls it.
  for (const commit of ['', '  ']) {
    const unfinished = await run('bootstrap-repo', BARGS, boot({ bootstrap: { ...BOOT_OK, outcome: 'already_bootstrapped', merged: false, commit } }), { workflow: noShip })
    assert.equal(unfinished.result.status, 'failed_at_bootstrap')
    assert.match(unfinished.result.stop_reason, new RegExp(`an earlier bootstrap on ${BRANCH} but no bootstrap commit; nothing was shipped`))
    assert.match(unfinished.result.next_steps[0], /the branch is an unfinished run, so re-run this workflow with the same args and \/bootstrap resumes on it/)
    assert.deepEqual(unfinished.result.next_steps.slice(1), AFTER)
  }
  assert.match(waiting.prompt('bootstrap'), /never for a bootstrap\/\* branch that holds no bootstrap commit, which is an unfinished run the command resumes/)
})

await test('bootstrap-repo: a ship run that stops, closes or throws says why and how to ship again', async () => {
  const blocked = await run('bootstrap-repo', BARGS, boot(), { workflow: async () => ({ status: 'blocked_at_pr', pr_stage: { blocked: true, blocked_reason: 'error=github_unavailable' }, assumptions: [] }) })
  assert.equal(blocked.result.status, 'ship_failed')
  assert.deepEqual(blocked.result.ship, { status: 'blocked_at_pr', reason: 'error=github_unavailable' })
  assert.match(blocked.result.next_steps[0], /blocked_at_pr: error=github_unavailable/)
  assert.ok(blocked.result.next_steps[0].includes(JSON.stringify({ ship_only: true, branch: BRANCH, title: 'Bootstrap repository', dir: '/abs/p' })))
  const closed = await run('bootstrap-repo', BARGS, boot(), { workflow: async () => ({ ...P2MP_OPEN, status: 'CLOSED' }) })
  assert.equal(closed.result.status, 'closed')
  assert.match(closed.result.next_steps[0], /closed without merging/)
  const threw = await run('bootstrap-repo', BARGS, boot(), { workflow: async () => { throw new Error('workflow() nesting is one level only') } })
  assert.equal(threw.result.status, 'ship_failed')
  assert.deepEqual(threw.result.ship, { status: 'failed', reason: 'workflow() nesting is one level only' })
  const unwatched = await run('bootstrap-repo', BARGS, boot(), { workflow: async () => ({ ...P2MP_OPEN, status: 'monitor_failed', final_state: null }) })
  assert.equal(unwatched.result.status, 'pr_open', 'the PR exists even when no observe round worked')
})

await test('bootstrap-repo: on_question assume proceeds on recommendations and collects the assumptions', async () => {
  const { result, prompt } = await run('bootstrap-repo', { ...BARGS, on_question: 'assume', ship: false }, boot({ bootstrap: { ...BOOT_OK, assumptions: ['copyright holder -> the person'] } }), { workflow: noShip })
  assert.equal(result.status, 'committed')
  assert.match(prompt('bootstrap'), /proceed on assumptions/)
  assert.match(prompt('bootstrap'), /for a conflict with what the person said, what the person said; for a baked-in decision nobody confirmed, its Choice as the architecture states it; an existing LICENSE is never replaced/)
  // On assumptions an unconfirmed baked-in decision is a blocking question taken on its recommendation, never "asked".
  assert.match(prompt('bootstrap'), /In two cases a person-owned choice the skeleton bakes in is a blocking question: when no decision of the architecture and no answer settles it, and when the architecture records it as unconfirmed/)
  assert.doesNotMatch(prompt('bootstrap'), /never assumed/)
  assert.doesNotMatch(prompt('bootstrap'), /return every such question/)
  assert.deepEqual(result.assumptions, [{ stage: 'bootstrap', assumption: 'copyright holder -> the person' }])
})

await test('bootstrap-repo: args are checked before anything runs', async () => {
  await assert.rejects(run('bootstrap-repo', { dir: '/abs/p' }, boot()), /args\.architecture/)
  await assert.rejects(run('bootstrap-repo', { architecture: 'docs/design/architecture.md' }, boot()), /args\.dir/)
  await assert.rejects(run('bootstrap-repo', { ...BARGS, architecture: 'docs/design/architecture.md --dry-run' }, boot()), /no spaces or flags/)
  await assert.rejects(run('bootstrap-repo', { ...BARGS, github_access: 'mcp' }, boot()), /github_access/)
  const abs = await run('bootstrap-repo', { ...BARGS, architecture: '/abs/p/docs/design/architecture.md', ship: false }, boot(), { workflow: noShip })
  assert.match(abs.prompt('bootstrap'), /with args "docs\/design\/architecture\.md"/, 'a path under dir is passed relative to it')
})

// ---- refresh-proposal
const DOC = 'docs/design/03-export.md'
const RARGS = { doc: DOC, dir: '/abs/p' }
const F = (severity, description, doc = DOC) => ({ doc, severity, description })
const LINT_OK = { kind: 'proposal', status: 'draft', chains: 1, lanes: 2, blocked: 0, human_gates_pending: 1, branch: 'main' }
const rp = (over = {}) => (label, prompt) => {
  if (over[label] !== undefined) return typeof over[label] === 'function' ? over[label](prompt) : over[label]
  if (label.startsWith('review-')) return { findings: [], completed: true, doc_status: 'draft' }
  if (label.startsWith('revise-')) return { summary: 'applied', declined: [], lint_clean: true }
  if (label === 'lint') return LINT_OK
  return {}
}

await test('refresh-proposal: a clean first review stops there, then lints the doc and previews its lanes', async () => {
  const { result, calls, prompt } = await run('refresh-proposal', RARGS, rp())
  assert.equal(result.status, 'clean')
  assert.deepEqual(calls.map(c => [c.label, c.effort]), [['review-1', 'high'], ['lint', 'low']])
  assert.equal(result.rounds, 1)
  assert.equal(result.revisions, 0)
  assert.deepEqual(result.findings_remaining, [])
  assert.deepEqual(result.lint, { errors: 0, warnings: 0, lanes: { chains: 1, lanes: 2, blocked: 0, human_gates_pending: 1, errors: 0 } })
  assert.equal(result.doc_status, 'draft')
  assert.match(prompt('review-1'), /skill "review-proposal" with args "docs\/design\/03-export\.md"\./)
  assert.match(prompt('review-1'), /re-reviewed against the tree as it is now/)
  assert.match(prompt('review-1'), /change nothing but docs\/design\/03-export\.md/)
  assert.match(prompt('review-1'), /pipeline-state\.py\) is theirs to write/)
  assert.match(prompt('lint'), /proposal-lint\.py docs\/design\/03-export\.md --lanes --allow-draft/)
  assert.match(prompt('lint'), /do not fetch/)
  assert.ok(!result.next_steps.some(s => /re-accept/.test(s)), 'nothing was revised')
  assert.ok(!result.next_steps.some(s => /show the person/.test(s)), 'nothing unconfirmed, nothing to show')
  assert.match(prompt('lint'), /proposal-lint\.py docs\/design\/03-export\.md --decisions \(any kind\)/)
  assert.match(prompt('review-1'), /A doc that departs from the person's framing, an answer from the person, or a decision tagged \(person, \.\.\.\), with no newer answer from the person, is a bug whose fix is the question to ask/)
  assert.doesNotMatch(prompt('review-1'), /An answer in the list above/, 'no answers were given')
  assert.match(result.next_steps[0], /No revision was needed\. docs\/design\/03-export\.md is a draft: set Status: accepted/)
  assert.ok(result.next_steps.some(s => /proposal-build-chain \{ proposal: 'docs\/design\/03-export\.md'/.test(s) && /2 lane\(s\)/.test(s)))
  assert.equal(result.other_docs, undefined)
})

await test('refresh-proposal: findings are revised and re-reviewed until clean; the next steps say to re-accept the doc', async () => {
  const over = { 'review-1': { findings: [F('concern', 'Files: src/a.ts moved to src/b.ts')], completed: true, doc_status: 'accepted' } }
  const { result, calls, prompt } = await run('refresh-proposal', RARGS, rp(over))
  assert.equal(result.status, 'clean')
  assert.deepEqual(calls.map(c => [c.label, c.effort]), [['review-1', 'high'], ['revise-1', 'medium'], ['review-2', 'high'], ['lint', 'low']])
  assert.equal(result.rounds, 2)
  assert.equal(result.revisions, 1)
  assert.match(prompt('revise-1'), /skill "propose" with args "--revise docs\/design\/03-export\.md"/)
  assert.match(prompt('revise-1'), /src\/a\.ts moved to src\/b\.ts/)
  assert.match(prompt('revise-1'), /Edit only docs\/design\/03-export\.md; never any other doc/)
  assert.match(prompt('review-2'), /Earlier rounds and what the reviser did/)
  const step = result.next_steps.find(s => /re-accept/.test(s))
  assert.ok(step, 'a re-accept step')
  assert.match(step, /A revise resets Status: to draft \(it was accepted\)/)
  assert.match(step, /docs PR/)
  assert.match(step, /git -C \/abs\/p diff -- docs\/design\/03-export\.md/)
})

await test('refresh-proposal: suggestions and nits get one revise round, then the review counts as clean', async () => {
  const nit = { findings: [F('nit', 'typo in step 2')], completed: true, doc_status: 'draft' }
  const { result, calls } = await run('refresh-proposal', RARGS, rp({ 'review-1': nit, 'review-2': nit }))
  assert.equal(result.status, 'clean')
  assert.deepEqual(calls.map(c => c.label), ['review-1', 'revise-1', 'review-2', 'lint'])
  assert.deepEqual(result.findings_remaining, ['nit: typo in step 2'])
  assert.ok(result.next_steps.some(s => /re-accept/.test(s)))
})

await test('refresh-proposal: a defect left at the cap ends with findings_remain, one line each', async () => {
  const bug = { findings: [F('suggestion', 'name the bucket'), F('bug', 'step 4 builds past\n  the ops gate')], completed: true, doc_status: 'draft' }
  const always = label => label.startsWith('review-') ? bug : rp()(label)
  const { result, calls } = await run('refresh-proposal', { ...RARGS, max_review_rounds: 2 }, always)
  assert.equal(result.status, 'findings_remain')
  assert.deepEqual(calls.map(c => c.label), ['review-1', 'revise-1', 'review-2', 'revise-2', 'review-3', 'lint'])
  assert.equal(result.rounds, 3)
  assert.equal(result.revisions, 2)
  assert.deepEqual(result.findings_remaining, ['bug: step 4 builds past the ops gate', 'suggestion: name the bucket'])
  assert.ok(result.next_steps.some(s => /^1 blocking finding\(s\) remain \(findings_remaining\) after 2 revise round\(s\)/.test(s)))
  assert.ok(result.next_steps.some(s => /re-accept/.test(s)), 'it was revised, so it needs accepting again')
  assert.ok(!result.next_steps.some(s => /proposal-build-chain/.test(s)), 'nothing to build from a doc with defects')
  const only = await run('refresh-proposal', { ...RARGS, max_review_rounds: 0 }, always)
  assert.equal(only.result.status, 'findings_remain')
  assert.deepEqual(only.calls.map(c => c.label), ['review-1', 'lint'], 'max_review_rounds 0 reviews only')
  assert.ok(!only.result.next_steps.some(s => /re-accept/.test(s)))
})

await test('refresh-proposal: a long review comes back capped, one line per finding, and says how many it left out', async () => {
  const many = { findings: Array.from({ length: 30 }, (_, i) => F('bug', `defect ${i} ${'y'.repeat(1000)}`)), completed: true }
  const { result } = await run('refresh-proposal', { ...RARGS, max_review_rounds: 0 }, rp({ 'review-1': many }))
  assert.equal(result.findings_remaining.length, 21)
  assert.ok(result.findings_remaining.every(l => l.length <= 400 && !l.includes('\n')))
  assert.match(result.findings_remaining.at(-1), /^… 10 more: \/review-proposal's ledger/)
  assert.ok(JSON.stringify(result).length < 12000, `result is ${JSON.stringify(result).length} bytes`)
})

await test('refresh-proposal: a reviser question stops with needs_input; on a re-run the answers reach every review and revise', async () => {
  const concern = { findings: [F('concern', 'the source is silent on how long exports are kept')], completed: true, doc_status: 'draft' }
  const first = await run('refresh-proposal', RARGS, rp({ 'review-1': concern, 'revise-1': { questions: [Q] } }))
  assert.equal(first.result.status, 'needs_input')
  assert.deepEqual(first.result.questions.map(q => [q.id, q.stage]), [['revise.q1', 'revise']])
  assert.match(first.result.relay, /never answer them on their behalf/)
  assert.match(first.result.relay, /same args plus answers/)
  assert.match(first.result.relay, /^Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit \(a numbered list when it has none\), each with its why/)
  assert.match(first.result.relay, /never re-run with on_question: 'assume' unless the person says to proceed on assumptions/)
  assert.match(first.result.relay, /Show the confirmations \(the questions with confirm: true\) as one list the person can accept whole or correct line by line/)
  assert.match(first.result.relay, /Also show the person this result's assumptions: a line they correct, or any decision they make outside these questions, is passed as an answer too \(id revise\.d<N>, N the next number not yet in use, with its question\)/)
  assert.match(first.result.relay, /each question's id and question text with the person's answer and the date they gave it/)
  assert.ok(!first.calls.some(c => c.label === 'lint'), 'nothing is linted while a question is open')
  assert.equal(first.result.lint, null)
  assert.match(first.result.next_steps[0], /^First answer the 1 question\(s\)/)
  // While a question is open the assumptions are shown with it (the relay), never in a step about accepting the doc.
  const both = await run('refresh-proposal', RARGS, rp({ 'review-1': concern, 'revise-1': { questions: [Q], assumptions: ['retention -> 30 days'] } }))
  assert.deepEqual(both.result.assumptions, [{ stage: 'revise', assumption: 'retention -> 30 days' }])
  assert.ok(!both.result.next_steps.some(s => /show the person|is accepted/.test(s)))
  assert.match(first.prompt('revise-1'), /QUESTIONS: this stage runs unattended/)
  assert.match(first.prompt('revise-1'), /return every such question/)
  assert.match(first.prompt('revise-1'), /never decline it or pick a side/)
  assert.doesNotMatch(first.prompt('review-1'), /QUESTIONS:/, 'the review is read-only and asks nothing')
  // The reviser's rule follows the design run's: a conflict with what the person said is asked, a confirmation is a question,
  // and nothing the person settled is changed.
  assert.match(first.prompt('revise-1'), /a conflict between what the person said \(the framing, an answer, a decision a doc records as theirs\) and the doc's sources, the tree or your research/)
  assert.match(first.prompt('revise-1'), /A confirmation is a question about a person-owned choice that already has a value nobody confirmed with the person/)
  assert.match(first.prompt('revise-1'), /return every such question and every confirmation \(all of them, in one pass\)/)
  assert.match(first.prompt('revise-1'), /Never change what the person settled/)
  assert.match(first.prompt('revise-1'), /a finding whose fix would change what the person settled \(an answer, the framing, a decision tagged \(person, \.\.\.\)\): never apply it and never decline it/)
  assert.match(first.prompt('revise-1'), /name milestones, steps and decisions by title/)
  const answers = [{ id: 'revise.q1', question: Q.question, answer: 'ANSWER-R', date: '2026-11-12' }]
  const again = await run('refresh-proposal', { ...RARGS, answers }, rp({ 'review-1': concern }))
  assert.equal(again.result.status, 'clean')
  for (const l of ['review-1', 'revise-1', 'review-2']) assert.match(again.prompt(l), /ANSWER-R/, l)
  assert.match(again.prompt('review-1'), /a choice that follows one is not a defect/)
  // Each answer travels with its id, question text and date; an answer the doc does not yet reflect is found by the review and
  // applied by the revise, which tags the decision it settles.
  for (const l of ['review-1', 'revise-1']) assert.ok(again.prompt(l).includes(JSON.stringify([{ id: 'revise.q1', question: Q.question, answer: 'ANSWER-R', date: '2026-11-12' }])), l)
  assert.match(again.prompt('review-1'), /An answer in the list above \(one passed to this run\) that the doc does not yet reflect .* is a bug too: report it, naming the answer's id, so the reviser applies it/)
  assert.match(again.prompt('revise-1'), /Apply every answer in the list above \(the ones passed to this run\) that the doc does not yet reflect, and tag each decision an answer settles \(person, <the answer's date, or today's when it has none>, <the answer's id>\)/)
  assert.doesNotMatch(first.prompt('revise-1'), /Apply every answer in the list above/, 'no answers were given')
  const third = await run('refresh-proposal', { ...RARGS, answers }, rp({ 'review-1': concern, 'revise-1': { questions: [Q] } }))
  assert.equal(third.result.questions[0].id, 'revise.q2', 'a new question never reuses an answered id')
  // A confirmation keeps its mark, and a decision's id (revise.d<N>) takes no part in the numbering.
  const decided = [...answers, { id: 'revise.d7', question: 'Decision "Retention"', answer: '30 days' }]
  const fourth = await run('refresh-proposal', { ...RARGS, answers: decided }, rp({ 'review-1': concern, 'revise-1': { questions: [{ ...Q, confirm: true }] } }))
  assert.deepEqual(fourth.result.questions.map(q => [q.id, q.confirm]), [['revise.q2', true]])
})

await test('refresh-proposal: every review and revise reads the saved design answers and the person\'s framing; a missing framing file stops the run', async () => {
  const concern = { findings: [F('concern', 'the retention period departs from the brief')], completed: true, doc_status: 'draft' }
  const plain = await run('refresh-proposal', RARGS, rp({ 'review-1': concern }))
  // The answers the design run saved bind a refresh too, with or without answers of its own.
  for (const l of ['review-1', 'revise-1', 'review-2']) {
    assert.match(plain.prompt(l), /read them with python3 \.claude\/scripts\/pipeline-state\.py get design\/answers\.json \(this read of the state branch is allowed and changes nothing in \/abs\/p; exit 3 or 2: none are saved, go on without them\)/, l)
    assert.match(plain.prompt(l), /Each is the person's: binding, never re-asked, and a choice that follows one is not a defect\./, l)
    assert.match(plain.prompt(l), /an answer asked elsewhere binds this doc wherever the same choice arises, and one plainly about another doc's detail does not/, l)
    assert.doesNotMatch(plain.prompt(l), /Framing from the person|builder-context|the one listed above is the newer/, l)
  }
  assert.doesNotMatch(plain.prompt('lint'), /design\/answers\.json/)
  const answers = [{ id: 'revise.d1', question: 'Decision "Retention"', answer: '30 days', date: '2026-11-12' }]
  const framed = await run('refresh-proposal', { ...RARGS, answers, context: 'FRAMING-TEXT: solo builder', context_file: 'docs/builder-context.md' }, rp({ 'review-1': concern }))
  assert.equal(framed.result.status, 'clean')
  // The reviser gets the framing as binding, in the design run's words; the reviewer is told a choice that follows it is no defect.
  const rev = framed.prompt('revise-1')
  assert.ok(rev.includes('Framing from the person, binding. On the point it addresses it replaces what the source says (the brief\'s Assumed builder, a field the person corrected): follow it, say so in what you write, and never ask it again. Where another part of the source, the tree or research makes it impossible to follow, pick no side: return a blocking question naming both. The framing: FRAMING-TEXT: solo builder\n'))
  assert.match(rev, /Before anything else, read docs\/builder-context\.md \(relative to \/abs\/p\) in full: its text is framing from the person, binding\./)
  assert.match(rev, /When that file has a line starting "- Not confirmed by me yet", \/start-product assumed the framing/)
  for (const l of ['review-1', 'review-2']) {
    assert.match(framed.prompt(l), /The authors were told to follow this framing from the person as binding; a choice that follows it or an answer from the person is not a defect: FRAMING-TEXT: solo builder/, l)
    assert.match(framed.prompt(l), /The authors were also told to treat the text of docs\/builder-context\.md \(read it\) as binding framing from the person/, l)
    assert.match(framed.prompt(l), /Where an answer listed above and a saved one settle the same point differently, the one listed above is the newer and holds\./, l)
  }
  assert.doesNotMatch(framed.prompt('lint'), /builder-context|FRAMING-TEXT|design\/answers\.json/, 'the lint stage reads neither')
  // A missing framing file is restored from the state branch by the first review, or the run fails before any revise.
  assert.match(framed.prompt('review-1'), /If docs\/builder-context\.md \(relative to \/abs\/p\) does not exist, restore it before the review: python3 \.claude\/scripts\/pipeline-state\.py get context\/builder-context\.md --to docs\/builder-context\.md/)
  const missing = await run('refresh-proposal', { ...RARGS, context_file: 'docs/builder-context.md' }, rp({ 'review-1': { findings: [], completed: false, doc_status: '', stop_reason: 'context_not_found: docs/builder-context.md does not exist and the state branch holds no context/builder-context.md' } }))
  assert.equal(missing.result.status, 'failed')
  assert.match(missing.result.stop_reason, /^context_not_found: docs\/builder-context\.md/)
  assert.deepEqual(missing.calls.map(c => c.label), ['review-1'], 'no revise and no lint without the person\'s framing')
  // An answer passed without its question text is named as such to the stages.
  const bare = await run('refresh-proposal', { ...RARGS, answers: { 'revise.q1': 'yes' } }, rp({ 'review-1': concern }))
  for (const l of ['review-1', 'revise-1']) assert.match(bare.prompt(l), /An entry above whose question equals its id was passed without its question text\. When its answer alone does not say what it settles, it settles nothing: never guess what it meant\./, l)
  assert.ok(bare.logs.includes(NO_TEXT_LOG('revise.q1')), 'the run says so in its log')
  assert.ok(!framed.logs.some(l => l.includes('without their question text')))
  assert.doesNotMatch(framed.prompt('revise-1'), /passed without its question text/)
})

await test('refresh-proposal: what no person confirmed comes back with the lint, and the next steps say to show it before the doc is accepted', async () => {
  const lint = { ...LINT_OK, unconfirmed: [{ id: 'D3', title: 'Data store', by: 'assumed' }, { id: 'D5', title: 'Queue', by: '' }], proposed: [{ line: 41, text: '   - Retention: 30 days (proposed)' }] }
  const over = { 'review-1': { findings: [F('concern', 'c')], completed: true, doc_status: 'accepted' }, 'revise-1': { summary: 's', declined: [], lint_clean: true, assumptions: ['retention -> 30 days'] }, lint }
  const { result } = await run('refresh-proposal', RARGS, rp(over))
  assert.equal(result.status, 'clean')
  assert.deepEqual(result.lint.unconfirmed, ['D3 "Data store" (assumed)', 'D5 "Queue" (untagged)'])
  assert.deepEqual(result.lint.proposed, ['41: - Retention: 30 days (proposed)'])
  const show = result.next_steps.findIndex(s => /show the person/.test(s))
  const accept = result.next_steps.findIndex(s => /re-accept/.test(s))
  assert.ok(show >= 0 && show < accept, 'shown before the step that says to re-accept')
  assert.match(result.next_steps[show], /^Before docs\/design\/03-export\.md is accepted again, show the person this result's assumptions \(1\), lint\.unconfirmed \(2 decision\(s\) no person confirmed: D3 "Data store" \(assumed\); D5 "Queue" \(untagged\)\) and lint\.proposed \(1 value\(s\) an author proposed\)/)
  // A decision confirmed as it stands is retagged by hand, with no re-run; one the person changes comes back as an answer.
  assert.ok(result.next_steps[show].endsWith(', and ask them to confirm or correct each. A decision they confirm as it stands needs no re-run: its heading tag becomes (person, <today>, edit); ' +
    'the person changes it while accepting the doc, or you make that one-line edit when the person says so (the tag only, never the Choice or any other text). ' +
    'A decision they change goes back as an answer (id revise.d<N>, N the next number not yet in use, its question naming the decision by title, with the date) to a re-run of this workflow: ' +
    'the review reports what the doc does not yet reflect and the revise applies it and tags the decision (person, <date>, <id>). A confirmation may be passed the same way when a re-run happens anyway.'))
  // No revision and nothing assumed: the unconfirmed decisions alone are still shown, before a draft is accepted.
  const only = await run('refresh-proposal', RARGS, rp({ lint: { ...LINT_OK, unconfirmed: lint.unconfirmed } }))
  assert.match(only.result.next_steps[0], /^Before docs\/design\/03-export\.md is accepted, show the person this result's assumptions \(0\), lint\.unconfirmed \(2 decision/)
  assert.equal(only.result.lint.proposed, undefined)
  // A long list comes back capped, and says where the rest is.
  const many = await run('refresh-proposal', RARGS, rp({ lint: { ...LINT_OK, proposed: Array.from({ length: 30 }, (_, i) => ({ line: i + 1, text: `value ${i} (proposed) ${'z'.repeat(500)}` })) } }))
  assert.equal(many.result.lint.proposed.length, 21)
  assert.ok(many.result.lint.proposed.every(l => l.length <= 200))
  assert.match(many.result.lint.proposed.at(-1), /^… 10 more: python3 \.claude\/scripts\/proposal-lint\.py docs\/design\/03-export\.md --decisions lists them all$/)
})

await test('refresh-proposal: --roadmap reaches the review; findings about other docs are reported, never revised', async () => {
  const over = { 'review-1': { findings: [F('bug', 'milestone 4 names no proposal', 'docs/design/roadmap.md'), F('nit', 'wording in step 1', '/abs/p/docs/design/03-export.md'), F('nit', 'step 2 title', '03-export.md')], completed: true, doc_status: 'draft' } }
  const { result, calls, prompt } = await run('refresh-proposal', { ...RARGS, roadmap: true }, rp(over))
  assert.match(prompt('review-1'), /with args "docs\/design\/03-export\.md --roadmap"/)
  assert.deepEqual(calls.map(c => c.label), ['review-1', 'revise-1', 'review-2', 'lint'])
  assert.doesNotMatch(prompt('revise-1'), /names no proposal/)
  assert.match(prompt('revise-1'), /wording in step 1/)
  assert.match(prompt('revise-1'), /step 2 title/)
  assert.equal(result.status, 'clean')
  assert.deepEqual(result.other_docs, ['bug: docs/design/roadmap.md: milestone 4 names no proposal'])
  assert.ok(result.next_steps.some(s => /other_docs/.test(s) && /refresh-proposal \{ doc: '<that doc>', dir: '\/abs\/p' \}/.test(s)))
})

await test('refresh-proposal: lint errors after a clean review leave findings_remain; a stage that did not report fails', async () => {
  const dirty = await run('refresh-proposal', RARGS, rp({ lint: { ...LINT_OK, errors: 1, messages: ['12: missing_depends: step 3 has no Depends on'] } }))
  assert.equal(dirty.result.status, 'findings_remain')
  assert.deepEqual(dirty.result.findings_remaining, ['bug: lint: 12: missing_depends: step 3 has no Depends on'])
  assert.equal(dirty.result.lint.errors, 1)
  const lanes = await run('refresh-proposal', RARGS, rp({ lint: { ...LINT_OK, lane_errors: 1 } }))
  assert.equal(lanes.result.status, 'findings_remain')
  assert.equal(lanes.result.lint.lanes.errors, 1)
  const stopped = await run('refresh-proposal', RARGS, rp({ 'review-1': { findings: [], completed: false, stop_reason: 'error=doc_not_found' } }))
  assert.equal(stopped.result.status, 'failed')
  assert.equal(stopped.result.stop_reason, 'error=doc_not_found')
  assert.ok(!stopped.calls.some(c => c.label === 'lint'))
  assert.match(stopped.result.next_steps[0], /Fix what stopped it \(error=doc_not_found\)/)
  const dead = await run('refresh-proposal', RARGS, rp({ 'review-1': { findings: [F('bug', 'x')], completed: true }, 'revise-1': null }))
  assert.equal(dead.result.status, 'failed')
  assert.match(dead.result.stop_reason, /revise stage failed to report/)
  const noLint = await run('refresh-proposal', RARGS, rp({ lint: null }))
  assert.equal(noLint.result.status, 'failed')
  assert.match(noLint.result.stop_reason, /lint stage failed to report/)
  // A run that failed after a revise assumed something never ran the lint: the step says where the lists are, and blames no lint failure.
  const assumed = { 'review-1': { findings: [F('concern', 'c')], completed: true, doc_status: 'draft' }, 'revise-1': { summary: 's', declined: [], lint_clean: true, assumptions: ['retention -> 30 days'] }, 'review-2': null }
  const cut = await run('refresh-proposal', { ...RARGS, on_question: 'assume' }, rp(assumed))
  assert.equal(cut.result.status, 'failed')
  assert.equal(cut.result.lint, null)
  assert.ok(!cut.calls.some(c => c.label === 'lint'))
  const step = cut.result.next_steps.find(s => /show the person/.test(s))
  assert.match(step, /^Before docs\/design\/03-export\.md is accepted, show the person this result's assumptions \(1\) and what python3 \.claude\/scripts\/proposal-lint\.py docs\/design\/03-export\.md --decisions lists as unconfirmed and proposed \(this run has no lint result, so it holds neither list\), and ask them to confirm or correct each\./)
  assert.doesNotMatch(step, /the lint failed|not read/)
})

await test('refresh-proposal: an architecture\'s CLAUDE.md drift and a stale checkout reach the next steps', async () => {
  const { result, prompt } = await run('refresh-proposal', { doc: 'docs/design/architecture.md', dir: '/abs/p/' },
    rp({ 'review-1': { findings: [], completed: true, doc_status: 'accepted' }, lint: { kind: 'architecture', status: 'accepted', claude_md_drift: ['## Invariants'], branch: 'main', behind_main: 3 } }))
  assert.equal(result.status, 'clean')
  assert.deepEqual(result.lint, { errors: 0, warnings: 0, claude_md_drift: ['## Invariants'] })
  assert.match(result.next_steps[0], /No revision was needed; docs\/design\/architecture\.md keeps Status: accepted/)
  assert.ok(result.next_steps.some(s => /CLAUDE\.md's ## Invariants no longer match/.test(s) && /claude_md_drift/.test(s)))
  assert.ok(result.next_steps.some(s => /3 commit\(s\) behind origin's main branch/.test(s)))
  assert.ok(!result.next_steps.some(s => /proposal-build-chain/.test(s)), 'only a proposal is built')
  assert.match(prompt('lint'), /--claude-md CLAUDE\.md --json/)
  assert.match(prompt('lint'), /--roadmap --json/)
})

await test('refresh-proposal: on_question assume tells the reviser to proceed and collects its assumptions; args are checked', async () => {
  const over = { 'review-1': { findings: [F('concern', 'c')], completed: true }, 'revise-1': { summary: 's', declined: [], lint_clean: true, assumptions: ['retention -> 30 days'] } }
  const { result, prompt } = await run('refresh-proposal', { ...RARGS, on_question: 'assume' }, rp(over))
  assert.equal(result.status, 'clean')
  assert.match(prompt('revise-1'), /proceed on assumptions/)
  assert.match(prompt('revise-1'), /for a confirmation the unconfirmed value; for a conflict with what the person said, what the person said/)
  assert.match(prompt('revise-1'), /tag a decision so taken \(assumed\) in the doc/)
  assert.doesNotMatch(prompt('revise-1'), /return every such question/)
  // The reviewer is told the same, so a decision the reviser tags (assumed) does not come back as a concern every round.
  assert.match(prompt('review-1'), /The person chose to proceed on assumptions, so a decision tagged \(assumed\) is not a defect\./)
  const stop = await run('refresh-proposal', RARGS, rp(over))
  assert.match(stop.prompt('review-1'), /A person-owned decision tagged \(assumed\), or \(source\) when the source was drafted for the person \(.*\), is a concern whose fix is the question to ask\. The person-owned choices: who the product is for/)
  assert.deepEqual(result.assumptions, [{ stage: 'revise', assumption: 'retention -> 30 days' }])
  assert.ok(result.next_steps.some(s => /show the person this result's assumptions \(1\)/.test(s)), 'an assumption is shown before the doc is accepted')
  await assert.rejects(run('refresh-proposal', { dir: '/abs/p' }, rp()), /args\.doc/)
  await assert.rejects(run('refresh-proposal', { doc: DOC }, rp()), /args\.dir/)
  await assert.rejects(run('refresh-proposal', { ...RARGS, doc: `${DOC} --roadmap` }, rp()), /no spaces or flags/)
  const abs = await run('refresh-proposal', { doc: `/abs/p/${DOC}`, dir: '/abs/p', efforts: { review: 'max' } }, rp())
  assert.equal(abs.result.doc, DOC)
  assert.equal(abs.calls[0].effort, 'max')
})

process.exit(failed ? 1 : 0)

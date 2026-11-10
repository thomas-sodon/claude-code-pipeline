// Behavioural tests for the wrapper workflows: bootstrap-repo (/bootstrap, then plan-to-merged-pr ship-only) and
// refresh-proposal (/review-proposal and /propose --revise until clean, then the lint). Both return a compact result to the
// session that runs them; these tests check what they hand back, which stages saw which answers, and what they never do.
// Each workflow body runs against scripted mock agents: a responder picks the reply by the agent's label, and every prompt is
// recorded. The nested plan-to-merged-pr run is a mock workflow() that records its args.
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
  const noop = () => {}
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'workflow', 'phase', 'log', src)(
    args, agent, parallel, pipeline, workflow || (async () => { throw new Error('no nested workflow in this test') }), noop, noop)
  return { result, calls, prompt: label => (calls.find(c => c.label === label) || {}).prompt || '' }
}

const Q = { question: 'Which name goes in the LICENSE copyright line?', why: 'the product name or the person changes the licence text', options: ['the person', 'the product'], recommended: 'the person' }
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`) }
}

// ---- bootstrap-repo
const BRANCH = 'bootstrap/20261110'
const AFTER = ['Protect main: require the checks gates and docs.', 'Add each secret by NAME: gh secret set API_KEY.', 'Tick the roadmap\'s Bootstrap gate (milestone 2).']
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
  assert.match(prompt('bootstrap'), /GITHUB_ACCESS from the "Pipeline config" section of CLAUDE\.md, default gh/)
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
  const seen = []
  const answers = [{ id: 'bootstrap.q1', question: Q.question, answer: 'ANSWER-BOOT' }]
  const again = await run('bootstrap-repo', { ...BARGS, answers }, boot(), { workflow: async (n, a) => { seen.push(a); return P2MP_OPEN } })
  assert.equal(again.result.status, 'pr_open')
  assert.match(again.prompt('bootstrap'), /ANSWER-BOOT/)
  assert.deepEqual(seen[0].answers, answers, 'an answer reaches every later stage')
  // A new question on a later run never reuses the answered id.
  const third = await run('bootstrap-repo', { ...BARGS, answers }, boot({ bootstrap: { outcome: 'stopped', questions: [Q] } }), { workflow: noShip })
  assert.equal(third.result.questions[0].id, 'bootstrap.q2')
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
  assert.ok(!first.calls.some(c => c.label === 'lint'), 'nothing is linted while a question is open')
  assert.equal(first.result.lint, null)
  assert.match(first.result.next_steps[0], /^First answer the 1 question\(s\)/)
  assert.match(first.prompt('revise-1'), /QUESTIONS: this stage runs unattended/)
  assert.match(first.prompt('revise-1'), /return every such question/)
  assert.match(first.prompt('revise-1'), /never decline it or pick a side/)
  assert.doesNotMatch(first.prompt('review-1'), /QUESTIONS:/, 'the review is read-only and asks nothing')
  const answers = [{ id: 'revise.q1', question: Q.question, answer: 'ANSWER-R' }]
  const again = await run('refresh-proposal', { ...RARGS, answers }, rp({ 'review-1': concern }))
  assert.equal(again.result.status, 'clean')
  for (const l of ['review-1', 'revise-1', 'review-2']) assert.match(again.prompt(l), /ANSWER-R/, l)
  assert.match(again.prompt('review-1'), /a choice that follows one is not a defect/)
  const third = await run('refresh-proposal', { ...RARGS, answers }, rp({ 'review-1': concern, 'revise-1': { questions: [Q] } }))
  assert.equal(third.result.questions[0].id, 'revise.q2', 'a new question never reuses an answered id')
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
  assert.doesNotMatch(prompt('revise-1'), /return every such question/)
  assert.deepEqual(result.assumptions, [{ stage: 'revise', assumption: 'retention -> 30 days' }])
  await assert.rejects(run('refresh-proposal', { dir: '/abs/p' }, rp()), /args\.doc/)
  await assert.rejects(run('refresh-proposal', { doc: DOC }, rp()), /args\.dir/)
  await assert.rejects(run('refresh-proposal', { ...RARGS, doc: `${DOC} --roadmap` }, rp()), /no spaces or flags/)
  const abs = await run('refresh-proposal', { doc: `/abs/p/${DOC}`, dir: '/abs/p', efforts: { review: 'max' } }, rp())
  assert.equal(abs.result.doc, DOC)
  assert.equal(abs.calls[0].effort, 'max')
})

process.exit(failed ? 1 : 0)

// Behavioural tests for how bug-fix-backlog carries the GitHub access (github_access; .claude/scripts/github-access.md) into its prompts and
// through to its nested plan-to-merged-pr runs. Same small harness as ci/test-workflow-questions.mjs (copied, not imported).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = process.argv[2] || '.claude/workflows'
const AsyncFunction = (async () => {}).constructor

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
  return { result, calls, prompts: label => calls.filter(c => c.label === label).map(c => c.prompt) }
}

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`) }
}

const SENTENCE = 'Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools.'
// One lane with issue 11 to plan (reproduced) and issue 12 to close (both refuters fail), so every GitHub stage runs.
const LANE = { key: 'k', issues: [11, 12], dir: '/w/k', branch: 'bugfix/k' }
const respond = label => {
  if (label === 'triage:k') return { branch: 'bugfix/k', ahead_of_main: 0, behind_main: 0, baseline_dirty: [], plan: 'p',
    issues: [{ number: 11, title: 'a', verdict: 'plan', evidence: 'e' }, { number: 12, title: 'b', verdict: 'close', evidence: 'e', close_reason: 'r', close_comment: 'c' }] }
  if (label === 'reproduce:k') return { results: [{ number: 11, reproduced: true, behaviour_correct: false, tests: ['t.js::x'], failure_excerpt: '', notes: '' }] }
  if (label === 'refute-close:k') return { results: [{ number: 12, refuted: false, evidence: 'none' }] }
  if (label === 'close:k') return { closed: [12], not_closed: [] }
  return {}
}
const lanes = async (extra = {}) => {
  const seen = []
  const workflow = async (name, a) => { seen.push({ name, ...a }); return { status: 'pushed' } }
  const out = await run('bug-fix-backlog', { lanes: [LANE], ...extra }, respond, { workflow })
  return { ...out, seen }
}

await test('bug-fix-backlog: every GitHub stage carries the access sentence, and the default leaves it to the config', async () => {
  const { result, prompts, seen } = await lanes()
  assert.equal(result[0].status, 'pushed')
  assert.deepEqual(result[0].closed, [12])
  for (const l of ['triage:k', 'refute-close:k', 'close:k']) {
    assert.ok(prompts(l).length, `${l} ran`)
    for (const p of prompts(l)) {
      assert.ok(p.includes(SENTENCE), `${l} carries the GitHub access sentence`)
      assert.match(p, /GITHUB_ACCESS line in the "Pipeline config"/, l)
      assert.match(p, /error=github_unavailable/, l)
    }
  }
  assert.match(prompts('refute-close:k')[0], /\(connector: issue_read get\)/)
  assert.match(prompts('close:k')[0], /add_issue_comment, then close with issue_write/)
  assert.equal(seen[0].name, 'plan-to-merged-pr')
  assert.equal('github_access' in seen[0], false, "'' is not passed: the child reads the config the same way")
})

await test('bug-fix-backlog: github_access connector names the access in every prompt and reaches plan-to-merged-pr', async () => {
  const { prompts, seen } = await lanes({ github_access: 'connector' })
  for (const l of ['triage:k', 'refute-close:k', 'close:k']) {
    for (const p of prompts(l)) {
      assert.match(p, /The access for this run is connector/, l)
      assert.match(p, /load the mcp__github__ tool schemas with ToolSearch/, l)
    }
  }
  assert.equal(seen[0].github_access, 'connector')
  const upper = await lanes({ github_access: ' Connector ' })
  assert.equal(upper.seen[0].github_access, 'connector', 'normalized before it is passed on')
})

await test('bug-fix-backlog: github_access gh keeps the prompts gh-only and is passed on', async () => {
  const { prompts, seen } = await lanes({ github_access: 'gh' })
  for (const l of ['triage:k', 'refute-close:k', 'close:k']) {
    for (const p of prompts(l)) {
      assert.ok(p.includes(SENTENCE), l)
      assert.match(p, /The access for this run is gh/, l)
      assert.doesNotMatch(p, /\(connector:|add_issue_comment|ToolSearch/, l)
    }
  }
  assert.match(prompts('close:k')[0], /gh issue close <n> --reason completed/)
  assert.equal(seen[0].github_access, 'gh')
})

await test('bug-fix-backlog: close false closes nothing and returns each prepared close for the person to post', async () => {
  const { result, calls } = await lanes({ close: false })
  assert.ok(!calls.some(c => c.label === 'close:k'), 'no close stage runs')
  assert.ok(calls.some(c => c.label === 'refute-close:k'), 'the close verdict is still verified')
  assert.deepEqual(result[0].closed, [])
  assert.deepEqual(result[0].confirmed_fixed_unclosed, [12], 'the numbers list keeps its shape')
  assert.deepEqual(result[0].prepared_closes, [{ number: 12, close_reason: 'r', close_comment: 'c' }])
  // With the default, issues are closed and no prepared close is listed.
  const closing = await lanes()
  assert.deepEqual(closing.result[0].confirmed_fixed_unclosed, [])
  assert.equal(closing.result[0].prepared_closes, undefined)
})

await test('bug-fix-backlog: an unknown github_access is refused before anything runs', async () => {
  let calls = 0
  await assert.rejects(run('bug-fix-backlog', { lanes: [LANE], github_access: 'api' }, () => { calls++; return {} }), /github_access must be 'gh', 'connector' or ''/)
  assert.equal(calls, 0)
})

await test('bug-fix-backlog: the Intake names each connector call, and an unreachable GitHub stops it instead of proposing no lanes', async () => {
  const stop = await run('bug-fix-backlog', { root: '/w' }, label => label === 'intake' ? { error: 'github_unavailable' } : {})
  assert.deepEqual(stop.result, { status: 'failed_at_intake', error: 'github_unavailable' })
  const p = stop.calls.find(c => c.label === 'intake').prompt
  assert.ok(p.includes(SENTENCE))
  for (const tool of ['list_issues with state OPEN', 'list_pull_requests with state open', 'actions_list list_workflow_runs', 'actions_list list_workflow_jobs', 'get_job_logs with run_id']) assert.ok(p.includes(tool), tool)
  assert.match(p, /never create, edit, label, comment on, assign or close an issue/)
  const gh = await run('bug-fix-backlog', { root: '/w', github_access: 'gh' }, label => label === 'intake' ? { issues: [], lanes: [], unlaned: [], ci_red: [] } : {})
  assert.equal(gh.result.status, 'needs_input', 'no error: the usual stop for the person to confirm (here, no lanes)')
  assert.doesNotMatch(gh.calls[0].prompt, /\(connector:/)
})

process.exit(failed ? 1 : 0)

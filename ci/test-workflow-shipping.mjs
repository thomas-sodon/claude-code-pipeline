// Behavioural tests for shipping without carried state (plan-to-merged-pr, proposal-build-chain, ship-chain): a lane's plan
// is saved to the pipeline state branch at its merge check and travels as plan_ref; ship-only and monitor-only restore it and
// recreate a missing checkout; lane results stay slim; and the GitHub access (github_access) reaches every prompt that
// touches GitHub and every nested run. The workflows' copy of the state branch's slug is checked against
// pipeline-state.py slug itself. Same small harness as ci/test-workflow-questions.mjs (copied, not imported).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`) } catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`) }
}

const SENTENCE = 'Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools.'
const PLAN = 'PLAN-TEXT: the full plan for this lane\n## Rollout\nFlip the flag after deploy.'
const Q = { question: 'Keep both behaviours?', why: 'they conflict', options: ['ours', 'theirs'], recommended: 'ours' }

// ---- plan-to-merged-pr: every stage of a full run, with per-label overrides.
const OBS = { pr_state: 'OPEN', head_sha: 'abcdef1234', ai_review_done_on_head: true, ci_state: 'green', ci_configured: true }
const MC_OK = { merge_check: 'clean', gates_green: true, pushed: true, pushed_sha: 'abc1234567', plan_saved: true }
const p2m = (over = {}) => (label, prompt) => {
  if (over[label] !== undefined) return typeof over[label] === 'function' ? over[label](prompt) : over[label]
  if (label === 'plan') return { branch: 'feat/x', plan: PLAN }
  if (label === 'impl') return { summary: 'done', files_changed: ['a.js'], gates_green: true }
  if (label.startsWith('review-changes')) return { findings: [], completed: true }
  if (label.startsWith('polish')) return { issues_found_and_fixed: 0, summary: '', gates_green: true }
  if (label === 'merge-check') return MC_OK
  if (label === 'create-pr' || label === 'ready-pr') return { pr_number: 7, url: 'https://github.com/acme/app/pull/7' }
  if (label.startsWith('observe')) return OBS
  return {}
}
const RESTORE_S1 = /python3 \.claude\/scripts\/pipeline-state\.py get plans\/feat-p-s1\.md --to <PLANS_DIR>\/p-s1\.md/

await test('plan-to-merged-pr: build-only saves the plan to the state branch at the merge check and returns plan_ref', async () => {
  const { result, prompt } = await run('plan-to-merged-pr', { concern: 'c', ship: false }, p2m())
  assert.equal(result.status, 'pushed')
  assert.equal(result.plan_ref, 'plans/feat-x-d03c3cb6.md', 'feat/x, as pipeline-state.py slug spells it')
  const mc = prompt('merge-check')
  assert.match(mc, /python3 \.claude\/scripts\/pipeline-state\.py save <that file> --as plans\/feat-x-d03c3cb6\.md/)
  assert.ok(mc.includes(PLAN), 'the merge check is given the whole plan to save')
  assert.match(mc, /best effort/)
  // A failed save stops nothing: the lane still pushes, and says plan_ref ''.
  const unsaved = await run('plan-to-merged-pr', { concern: 'c', ship: false }, p2m({ 'merge-check': { ...MC_OK, plan_saved: false } }))
  assert.equal(unsaved.result.status, 'pushed')
  assert.equal(unsaved.result.plan_ref, '')
  assert.equal(unsaved.result.plan, PLAN, 'the run\'s own result still carries its plan text')
})

await test('plan-to-merged-pr: the state path slugs the branch, and a run that stops before saving carries plan_ref \'\'', async () => {
  const odd = await run('plan-to-merged-pr', { concern: 'c', ship: false }, p2m({ plan: { branch: 'feat/p_s1.v2+x@1', plan: PLAN } }))
  assert.equal(odd.result.plan_ref, 'plans/feat-p_s1.v2-x-1-389cc003.md')
  assert.match(odd.prompt('merge-check'), /--as plans\/feat-p_s1\.v2-x-1-389cc003\.md /)
  const stopped = await run('plan-to-merged-pr', { concern: 'c', ship: false }, p2m({ impl: { summary: '', files_changed: [], gates_green: false, stopped: true, stop_reason: 'blocked' } }))
  assert.equal(stopped.result.status, 'failed_at_impl')
  assert.equal(stopped.result.plan_ref, '')
  const asked = await run('plan-to-merged-pr', { concern: 'c', ship: false }, p2m({ 'merge-check': { questions: [Q] } }))
  assert.equal(asked.result.status, 'needs_input')
  assert.equal(asked.result.plan_ref, '', 'a merge check that asks saves nothing')
})

await test('plan-to-merged-pr: a full run hands off with resume_monitor carrying plan_ref, the plan text only when unsaved', async () => {
  const { result } = await run('plan-to-merged-pr', { concern: 'c' }, p2m())
  assert.equal(result.status, 'OPEN')
  assert.equal(result.plan_ref, 'plans/feat-x-d03c3cb6.md')
  assert.equal(result.resume_monitor.plan_ref, 'plans/feat-x-d03c3cb6.md')
  assert.equal(result.resume_monitor.plan_text, undefined)
  assert.ok(!JSON.stringify(result.resume_monitor).includes('PLAN-TEXT'))
  const unsaved = await run('plan-to-merged-pr', { concern: 'c' }, p2m({ 'merge-check': { ...MC_OK, plan_saved: false } }))
  assert.equal(unsaved.result.resume_monitor.plan_text, PLAN)
  assert.equal(unsaved.result.resume_monitor.plan_ref, undefined)
})

await test('plan-to-merged-pr: ship-only with plan_ref restores the plan for /create-pr and the monitor, and saves nothing', async () => {
  const args = { ship_only: true, branch: 'feat/p-s1', dir: '/w/s1', title: 'T', plan_ref: 'plans/feat-p-s1.md' }
  const { result, prompt } = await run('plan-to-merged-pr', args, p2m({ 'observe-1': { ...OBS, actionable_comments: 1 } }))
  assert.equal(result.status, 'OPEN')
  assert.equal(result.plan_ref, 'plans/feat-p-s1.md')
  assert.doesNotMatch(prompt('merge-check'), /pipeline-state\.py save/)
  assert.match(prompt('merge-check'), /read it with python3 \.claude\/scripts\/pipeline-state\.py get plans\/feat-p-s1\.md when a conflict needs it/)
  assert.match(prompt('create-pr'), RESTORE_S1)
  assert.match(prompt('create-pr'), /Hand that file to the skill as the branch's plan \(by its path\)/)
  assert.match(prompt('create-pr'), /exit 3: the plan was never saved/)
  assert.match(prompt('process-comments-1'), RESTORE_S1)
  assert.match(prompt('process-comments-1'), /That file, the plan this branch was built from, is its design intent/)
  assert.doesNotMatch(prompt('observe-1'), /pipeline-state\.py get/, 'the read-only observer needs no plan')
  assert.deepEqual(result.resume_monitor, { pr: 7, branch: 'feat/p-s1', dir: '/w/s1', plan_ref: 'plans/feat-p-s1.md' })
  // Readying an existing PR restores it for the Deploy notes the same way.
  const ready = await run('plan-to-merged-pr', { ...args, title: undefined, existing_pr: 7 }, p2m())
  assert.match(ready.prompt('ready-pr'), RESTORE_S1)
  assert.match(ready.prompt('ready-pr'), /Deploy notes from that plan's ## Rollout section/)
})

await test('plan-to-merged-pr: ship-only saves a given plan_text, and with both plan_ref wins with the text as its fallback', async () => {
  const textOnly = await run('plan-to-merged-pr', { ship_only: true, branch: 'feat/p-s1', dir: '/w/s1', title: 'T', plan_text: PLAN }, p2m())
  assert.match(textOnly.prompt('merge-check'), /--as plans\/feat-p-s1-80775a7d\.md /)
  assert.equal(textOnly.result.plan_ref, 'plans/feat-p-s1-80775a7d.md')
  assert.equal(textOnly.result.resume_monitor.plan_ref, 'plans/feat-p-s1-80775a7d.md')
  assert.equal(textOnly.result.resume_monitor.plan_text, undefined)
  const both = await run('plan-to-merged-pr', { ship_only: true, branch: 'feat/p-s1', dir: '/w/s1', title: 'T', plan_ref: 'plans/feat-p-s1.md', plan_text: PLAN }, p2m())
  assert.doesNotMatch(both.prompt('merge-check'), /pipeline-state\.py save/)
  assert.match(both.prompt('create-pr'), RESTORE_S1)
  assert.match(both.prompt('create-pr'), /If that get fails, use this copy of the plan instead/)
  assert.ok(both.prompt('create-pr').includes(PLAN))
  assert.equal(both.result.resume_monitor.plan_ref, 'plans/feat-p-s1.md')
  assert.equal(both.result.resume_monitor.plan_text, undefined)
})

await test('plan-to-merged-pr: monitor-only takes plan_ref, restores it for the action steps, and resume_monitor carries it', async () => {
  const MON = { pr: 7, branch: 'feat/x', dir: '/w/x', plan_ref: 'plans/feat-x.md', main_branch: 'trunk' }
  const { result, prompt } = await run('plan-to-merged-pr', MON, p2m({ 'observe-1': { ...OBS, actionable_comments: 1, has_conflicts: true } }))
  assert.equal(result.status, 'OPEN')
  assert.equal(result.plan_ref, 'plans/feat-x.md')
  assert.deepEqual(result.resume_monitor, MON)
  for (const l of ['merge-main-1', 'process-comments-1']) assert.match(prompt(l), /pipeline-state\.py get plans\/feat-x\.md --to <PLANS_DIR>\/x\.md/, l)
})

await test('plan-to-merged-pr: plan_ref is refused outside ship-only and monitor-only, and plan_ref and repo are checked', async () => {
  await assert.rejects(run('plan-to-merged-pr', { concern: 'c', plan_ref: 'plans/x.md' }, p2m()), /plan_ref is read in ship-only and monitor-only modes/)
  await assert.rejects(run('plan-to-merged-pr', { pr: 7, branch: 'b', plan_ref: 'plans/x.md; rm -rf ~' }, p2m()), /plan_ref must be a path on the pipeline state branch/)
  await assert.rejects(run('plan-to-merged-pr', { pr: 7, branch: 'b', repo: 'https://github.com/acme/app' }, p2m()), /owner\/name/)
})

await test('plan-to-merged-pr: ship-only and monitor-only have their first agent recreate a missing dir; the build modes do not', async () => {
  const recreate = /If \/w\/s1 does not exist .*recreate it before anything else, on branch feat\/p-s1 as it is on origin/
  const ship = await run('plan-to-merged-pr', { ship_only: true, branch: 'feat/p-s1', dir: '/w/s1', title: 'T' }, p2m())
  assert.equal(ship.calls[0].label, 'merge-check')
  for (const l of ['merge-check', 'create-pr', 'observe-1']) {
    const p = ship.prompt(l)
    assert.match(p, recreate, l)
    assert.ok(p.includes('git fetch origin +refs/heads/feat/p-s1:refs/remotes/origin/feat/p-s1'), `${l}: fetches the branch even into a single-branch clone`)
    assert.ok(p.includes('git worktree prune, then git worktree add --track -b feat/p-s1 /w/s1 origin/feat/p-s1'), l)
  }
  assert.match(ship.prompt('merge-check'), /error=checkout_missing/, 'with no repo arg, a checkout it cannot add is reported')
  const mon = await run('plan-to-merged-pr', { pr: 7, branch: 'feat/x', dir: '/w/x', repo: 'acme/app' }, p2m())
  assert.equal(mon.calls[0].label, 'observe-1')
  assert.match(mon.prompt('observe-1'), /If \/w\/x does not exist/)
  assert.match(mon.prompt('observe-1'), /allowed even in a read-only step/)
  assert.ok(mon.prompt('observe-1').includes('git clone https://github.com/acme/app /w/x, then git -C /w/x switch feat/x'), 'with repo, a fresh clone')
  assert.equal(mon.result.resume_monitor.repo, 'acme/app')
  const build = await run('plan-to-merged-pr', { concern: 'c', ship: false, branch: 'feat/x', dir: '/w/x' }, p2m())
  for (const c of build.calls) assert.doesNotMatch(c.prompt, /recreate it before anything else/, c.label)
  const noDir = await run('plan-to-merged-pr', { ship_only: true, branch: 'feat/p-s1', title: 'T' }, p2m())
  for (const c of noDir.calls) assert.doesNotMatch(c.prompt, /recreate it before anything else/, c.label)
})

await test('plan-to-merged-pr: a PR that cannot be read stops the monitor at once, with the error in the hand-off', async () => {
  const { result, calls } = await run('plan-to-merged-pr', { pr: 7, branch: 'feat/x' }, p2m({ 'observe-1': { error: 'error=github_unavailable' } }))
  assert.equal(result.status, 'monitor_failed')
  assert.match(result.handoff, /could not be read \(error=github_unavailable\)/)
  assert.deepEqual(calls.map(c => c.label), ['observe-1'])
  const none = await run('plan-to-merged-pr', { pr: 7, branch: 'feat/x' }, p2m({ 'observe-1': { ...OBS, error: 'none' } }))
  assert.equal(none.result.status, 'OPEN', 'an empty or "none" error is no error')
})

await test('plan-to-merged-pr: github_access reaches every GitHub prompt, names connector tools only when they may be used, and is resumed', async () => {
  const GH_LABELS = ['plan', 'merge-check', 'create-pr', 'observe-1']
  const conn = await run('plan-to-merged-pr', { concern: 'c', github_access: ' Connector ' }, p2m())
  for (const l of GH_LABELS) {
    const p = conn.prompt(l)
    assert.ok(p.includes(SENTENCE), `${l} carries the GitHub access sentence`)
    assert.match(p, /The access for this run is connector/, l)
    assert.match(p, /load the mcp__github__ tool schemas with ToolSearch/, l)
    assert.match(p, /error=github_unavailable/, l)
  }
  for (const l of ['impl', 'review-changes-1', 'polish-1']) assert.ok(!conn.prompt(l).includes(SENTENCE), `${l} touches no GitHub`)
  assert.match(conn.prompt('create-pr'), /gh pr create --base main; connector: create_pull_request with base main\)/)
  const obs = conn.prompt('observe-1')
  assert.match(obs, /pull_request_read method get_check_runs/)
  assert.match(obs, /timed wait of about 2 minutes with the Monitor tool, an until-loop on the clock/)
  assert.doesNotMatch(obs, /gh pr checks 7 --watch/)
  assert.equal(conn.result.resume_monitor.github_access, 'connector')
  const gh = await run('plan-to-merged-pr', { concern: 'c', github_access: 'gh' }, p2m())
  for (const l of GH_LABELS) {
    assert.ok(gh.prompt(l).includes(SENTENCE), l)
    assert.match(gh.prompt(l), /The access for this run is gh/, l)
    assert.doesNotMatch(gh.prompt(l), /connector:|ToolSearch/, l)
  }
  assert.match(gh.prompt('observe-1'), /gh pr checks 7 --watch --interval 30/)
  const dflt = await run('plan-to-merged-pr', { concern: 'c' }, p2m())
  for (const l of GH_LABELS) assert.match(dflt.prompt(l), /The access for this run is the GITHUB_ACCESS line in the "Pipeline config"/, l)
  assert.match(dflt.prompt('observe-1'), /In gh mode: Try `gh pr checks 7 --watch/)
  assert.match(dflt.prompt('observe-1'), /In connector mode: There is no --watch/)
  assert.equal(dflt.result.resume_monitor.github_access, undefined, '\'\' is not carried: the re-run reads the config the same way')
  await assert.rejects(run('plan-to-merged-pr', { concern: 'c', github_access: 'api' }, p2m()), /github_access must be 'gh', 'connector' or ''/)
})

// ---- proposal-build-chain: slim lane results, and a ship plan that carries plan_ref
const LANES_JSON = JSON.stringify({ chains: [
  { key: 's1', lanes: [
    { key: 's1', branch: 'feat/p-s1', dir: '/w/s1', bases: [], steps: [1], concern: 'c1' },
    { key: 's2', branch: 'feat/p-s2', dir: '/w/s2', bases: ['feat/p-s1'], steps: [2], concern: 'c2' }] },
  { key: 's3', lanes: [{ key: 's3', branch: 'feat/p-s3', dir: '/w/s3', bases: [], steps: [3], concern: 'c3', already_built: true }] }],
blocked: [], errors: [] })
// A lane run's full result; the save failed for feat/p-s2.
const built = a => ({ status: 'pushed', branch: a.branch, plan: `PLAN-TEXT for ${a.branch}`, plan_ref: a.branch === 'feat/p-s2' ? '' : 'plans/feat-p-s1-80775a7d.md',
  impl: { summary: 'built it', files_changed: ['a.js'] }, merge_check: { merge_check: 'clean', pushed_sha: 'abc' }, review_clean: true, polish_clean: true,
  assumptions: [{ stage: 'impl', assumption: 'kept the old flag' }] })

await test('proposal-build-chain: lane results drop the plan text, and the ship plan carries plan_ref, with plan_text only as a fallback', async () => {
  const seen = []
  const workflow = async (name, a) => { seen.push({ name, ...a }); return built(a) }
  const respond = label => label === 'derive-lanes' ? { lanes_json: LANES_JSON, exit_code: 0, source: 'origin', repo: 'acme/app.git' } : {}
  const { result, prompt } = await run('proposal-build-chain', { proposal: 'p.md', dir: '/d', root: '/w', github_access: 'connector', ai_review_check: 'Review' }, respond, { workflow })
  assert.equal(result.status, 'pushed')
  assert.match(prompt('derive-lanes'), /Report repo: origin's GitHub owner\/name/)
  assert.deepEqual(seen.map(s => [s.branch, s.ship, s.github_access]), [['feat/p-s1', false, 'connector'], ['feat/p-s2', false, 'connector']])
  assert.deepEqual(result.chains[0].lanes[0].result, { status: 'pushed', branch: 'feat/p-s1', plan_ref: 'plans/feat-p-s1-80775a7d.md', review_clean: true, polish_clean: true, assumptions: [{ stage: 'impl', assumption: 'kept the old flag' }] })
  assert.ok(!JSON.stringify(result.chains).includes('PLAN-TEXT'), 'no lane result carries plan text')
  const [c1, c3] = result.ship_plan
  assert.equal(c1.order[0].args.plan_ref, 'plans/feat-p-s1-80775a7d.md')
  assert.equal(c1.order[0].args.plan_text, undefined)
  assert.equal(c1.order[1].args.plan_ref, undefined, 'the lane whose save failed')
  assert.equal(c1.order[1].args.plan_text, 'PLAN-TEXT for feat/p-s2')
  assert.equal(c3.order[0].args.plan_ref, 'plans/feat-p-s3-7e775757.md', 'an already-built lane: where its earlier run saved it')
  for (const c of result.ship_plan) {
    for (const o of c.order) assert.deepEqual([o.args.github_access, o.args.repo, o.args.ai_review_check, o.args.ship_only], ['connector', 'acme/app', 'Review', true], o.lane)
    assert.deepEqual(c.ship_chain_args, { chain: { chain: c.chain, order: c.order } })
  }
  assert.ok(!JSON.stringify(result).includes('PLAN-TEXT for feat/p-s1'), 'a saved plan\'s text appears nowhere in the result')
})

await test('proposal-build-chain: a lane that did not push keeps what stopped it; explicit lanes are slim too; \'\' access is not passed on', async () => {
  const workflow = async (name, a) => a.branch === 'feat/b'
    ? { status: 'blocked_at_review', branch: 'feat/b', plan: 'PLAN-TEXT b', plan_ref: '', review_clean: false, polish_clean: false, assumptions: [], review_findings: [{ file: 'a.js', severity: 'bug', description: 'd' }] }
    : { status: 'pushed', branch: 'feat/a', plan: 'PLAN-TEXT a', plan_ref: 'plans/feat-a.md', review_clean: true, polish_clean: true, assumptions: [], review_findings: [] }
  const lanes = [{ key: 'a', dir: '/w/a', branch: 'feat/a', proposal: 'p.md', concern: 'ca' }, { key: 'b', dir: '/w/b', branch: 'feat/b', proposal: 'p.md', concern: 'cb', bases: ['feat/a'] }]
  const { result } = await run('proposal-build-chain', { lanes, github_access: 'gh' }, () => ({}), { workflow })
  assert.deepEqual(result.map(r => r.status), ['pushed', 'blocked_at_review'])
  assert.equal(result[0].result.plan_ref, 'plans/feat-a.md')
  assert.equal(result[0].result.review_findings, undefined, 'a pushed lane is exactly the slim record')
  assert.deepEqual(result[1].result.review_findings, [{ file: 'a.js', severity: 'bug', description: 'd' }])
  assert.ok(!JSON.stringify(result).includes('PLAN-TEXT'))
  const seen = []
  await run('proposal-build-chain', { lanes: [lanes[0]], github_access: '' }, () => ({}), { workflow: async (n, a) => { seen.push(a); return { status: 'pushed' } } })
  assert.equal('github_access' in seen[0], false)
  await assert.rejects(run('proposal-build-chain', { lanes, github_access: 'mcp' }, () => ({}), { workflow }), /github_access must be 'gh', 'connector' or ''/)
})

await test('proposal-build-chain: an explicit lane pushed without a saved plan keeps its text, as the derive-mode ship plan does', async () => {
  const lanes = [{ key: 's1', dir: '/w/s1', branch: 'feat/p-s1', proposal: 'p.md', concern: 'c1' },
    { key: 's2', dir: '/w/s2', branch: 'feat/p-s2', proposal: 'p.md', concern: 'c2', bases: ['feat/p-s1'] }]
  const { result } = await run('proposal-build-chain', { lanes }, () => ({}), { workflow: async (n, a) => built(a) })
  assert.deepEqual(result.map(r => r.status), ['pushed', 'pushed'])
  assert.equal(result[0].result.plan_ref, 'plans/feat-p-s1-80775a7d.md')
  assert.equal(result[0].result.plan_text, undefined, 'a saved plan travels by reference only')
  assert.equal(result[1].result.plan_ref, '')
  assert.equal(result[1].result.plan_text, 'PLAN-TEXT for feat/p-s2', 'the plan whose save failed comes back with its lane')
  // The same fallback derive mode puts in its ship plan for that lane.
  const respond = label => label === 'derive-lanes' ? { lanes_json: LANES_JSON, exit_code: 0, source: 'origin', repo: 'acme/app' } : {}
  const derived = await run('proposal-build-chain', { proposal: 'p.md', dir: '/d', root: '/w' }, respond, { workflow: async (n, a) => built(a) })
  assert.equal(derived.result.ship_plan[0].order[1].args.plan_text, result[1].result.plan_text)
  // A lane that did not push is planned again when it is rebuilt, never shipped as it is: it stays slim.
  const unpushed = await run('proposal-build-chain', { lanes }, () => ({}), { workflow: async (n, a) => ({ ...built(a), status: 'failed_at_push', plan_ref: '' }) })
  assert.deepEqual(unpushed.result.map(r => [r.status, r.result.plan_text]), [['failed_at_push', undefined]])
  // A lane key given twice never carries the other lane's text.
  const twice = await run('proposal-build-chain', { lanes: [{ ...lanes[1], key: 'k' }, { ...lanes[1], key: 'k', branch: 'feat/p-s2b' }] }, () => ({}),
    { workflow: async (n, a) => a.branch === 'feat/p-s2' ? built(a) : { ...built(a), plan_ref: '', plan: null } })
  assert.deepEqual(twice.result.map(r => r.result.plan_text), ['PLAN-TEXT for feat/p-s2', undefined])
})

// ---- the state branch's slug: each workflow's copy (stateSlug, behind planRefFor) prints what pipeline-state.py slug does
const SLUG_NAMES = ['feat/x', 'feat-x', 'feat:x', 'feat x', 'feat/42-foo', 'Feat/Foo_bar.baz@x y', 'feat/p_s1.v2+x@1',
  'bootstrap/20261110', 'main', 'v1.2_rc-3', '.hidden', 'a--b', 'feat//x/', 'feat/ünïcødé', 'feat/日本語', 'feat/😀-x',
  'feat/é', 'docs/design/01-Free_Checker', 'x\ty', 'lone\ud800surrogate']
// The function's source, cut from the workflow file as the harness reads it, and run on its own.
function slugCopy(file) {
  const src = readFileSync(join(dir, file), 'utf8')
  const fn = src.match(/^const stateSlug = [\s\S]*?\n\}\n/m)
  const ref = src.match(/^const planRefFor = .*$/m)
  assert.ok(fn && ref, `${file} defines stateSlug and planRefFor at top level`)
  return { file, source: fn[0], ...new Function(`${fn[0]}${ref[0]}\nreturn { stateSlug, planRefFor }`)() }
}

await test('state-branch slug: both workflows\' planRefFor gives the path pipeline-state.py slug spells, for every name', async () => {
  const script = join(dir, '..', 'scripts', 'pipeline-state.py')
  const copies = ['plan-to-merged-pr.js', 'proposal-build-chain.js'].map(slugCopy)
  assert.equal(copies[0].source, copies[1].source, 'the two copies are the same code')
  for (const name of SLUG_NAMES) {
    const want = execFileSync('python3', [script, 'slug', name], { encoding: 'utf8' }).replace(/\n$/, '')
    for (const c of copies) {
      assert.equal(c.stateSlug(name), want, `${c.file}: ${JSON.stringify(name)}`)
      assert.equal(c.planRefFor(name), `plans/${want}.md`, `${c.file}: ${JSON.stringify(name)}`)
    }
  }
  const refs = ['feat/x', 'feat-x', 'feat:x', 'feat x'].map(copies[0].planRefFor)
  assert.equal(new Set(refs).size, 4, `names that read the same once replaced get different files: ${refs.join(', ')}`)
  assert.equal(copies[0].planRefFor('feat-x'), 'plans/feat-x.md', 'a name with nothing to replace is its own slug')
})

// ---- ship-chain: slim lane records, recreated checkouts, and the access in every stage
const CHAIN = { chain: 's1', order: [
  { lane: 's1', branch: 'feat/p-s1', steps: [1], args: { ship_only: true, branch: 'feat/p-s1', dir: '/w/s1', title: '<title for steps 1>', proposal: 'p.md', plan_ref: 'plans/feat-p-s1.md', repo: 'acme/app', github_access: 'connector' } },
] }
const sc = (over = {}) => (label, prompt) => {
  if (over[label] !== undefined) return typeof over[label] === 'function' ? over[label](prompt) : over[label]
  if (label.startsWith('lookup-')) return { state: 'NONE', pr_number: 0, title: `Title ${label.slice(7)}` }
  if (label.startsWith('wait-')) return { state: 'MERGED' }
  return {}
}
const opened = { status: 'OPEN', pr: { pr_number: 10, url: 'https://github.com/acme/app/pull/10' } }

await test('ship-chain: lane records keep a slim child result, never the whole plan-to-merged-pr result', async () => {
  const whole = { ...opened, branch: 'feat/p-s1', plan: null, plan_ref: 'plans/feat-p-s1.md', impl: null, review_clean: null, polish_clean: false,
    monitor_actions: [{ round: 1, step: 'process-comments', summary: 'answered every thread' }],
    final_state: { ...OBS, has_conflicts: false, behind_main: false, ci_red_caused_by_pr: false, actionable_comments: 0, notes: 'OBSERVER-NOTES' },
    resume_monitor: { pr: 10, branch: 'feat/p-s1', plan_ref: 'plans/feat-p-s1.md' }, handoff: 'PR #10 handed off — settled', assumptions: [{ stage: 'merge_check', assumption: 'kept both sides' }] }
  const closeout = { proposal_complete: true, edits: [], next_milestone: [], roadmap: '' }
  const workflow = async (name, a) => a.max_monitor_rounds === 1 ? { status: 'MERGED', pr: { pr_number: a.pr }, closeout, monitor_actions: [{ x: 1 }] } : whole
  const { result } = await run('ship-chain', { chain: CHAIN }, sc(), { workflow })
  assert.equal(result.status, 'merged')
  const rec = result.lanes[0].result
  assert.deepEqual(Object.keys(rec).sort(), ['assumptions', 'final_state', 'handoff', 'pr', 'status'])
  assert.deepEqual(rec.final_state, { pr_state: 'OPEN', head_sha: 'abcdef1234', ci_state: 'green', ai_review_done_on_head: true, actionable_comments: 0, has_conflicts: false, behind_main: false })
  assert.equal(rec.handoff, 'PR #10 handed off — settled')
  const text = JSON.stringify(result)
  for (const gone of ['OBSERVER-NOTES', 'answered every thread', 'resume_monitor']) assert.ok(!text.includes(gone), gone)
  assert.deepEqual(result.closeout, closeout, 'the close-out round still reports')
  // A close-out from the lane's own run survives the slimming, so no extra round runs.
  const seen = []
  const own = await run('ship-chain', { chain: CHAIN }, sc(), { workflow: async (n, a) => { seen.push(a); return { status: 'MERGED', pr: { pr_number: 10 }, closeout, monitor_actions: [] } } })
  assert.deepEqual(own.result.lanes[0].result, { status: 'MERGED', pr: { pr_number: 10 }, closeout })
  assert.deepEqual(own.result.closeout, closeout)
  assert.equal(seen.length, 1)
})

await test('ship-chain: the lookup and the wait recreate a missing checkout, and the access reaches them and every nested run', async () => {
  const seen = []
  const { result, prompt } = await run('ship-chain', { chain: CHAIN }, sc(), { workflow: async (n, a) => { seen.push(a); return opened } })
  assert.equal(result.status, 'merged')
  for (const l of ['lookup-s1', 'wait-s1-1']) {
    const p = prompt(l)
    assert.match(p, /If \/w\/s1 does not exist .*recreate it before anything else, on branch feat\/p-s1/, l)
    assert.ok(p.includes('git worktree add --track -b feat/p-s1 /w/s1 origin/feat/p-s1'), l)
    assert.ok(p.includes('git clone https://github.com/acme/app /w/s1'), `${l}: the lane's repo is the clone source`)
    assert.ok(p.includes(SENTENCE), l)
    assert.match(p, /The access for this run is connector/, l)
    assert.match(p, /never push, through gh or the GitHub MCP tools alike/, l)
  }
  assert.match(prompt('lookup-s1'), /git fetch origin \+refs\/heads\/feat\/p-s1:refs\/remotes\/origin\/feat\/p-s1/)
  assert.match(prompt('lookup-s1'), /connector: list_pull_requests with head <owner>:feat\/p-s1, base main and state all/)
  // The ship run, then the close-out round: each gets the lane's access, repo and plan_ref from the ship plan.
  assert.deepEqual(seen.map(s => [s.github_access, s.repo, s.plan_ref, s.dir]), [['connector', 'acme/app', 'plans/feat-p-s1.md', '/w/s1'], ['connector', 'acme/app', 'plans/feat-p-s1.md', '/w/s1']])
  const noRepo = { chain: 's1', order: [{ ...CHAIN.order[0], args: { ...CHAIN.order[0].args, repo: undefined } }] }
  const bare = await run('ship-chain', { chain: noRepo }, sc(), { workflow: async () => opened })
  assert.match(bare.prompt('lookup-s1'), /report error=checkout_missing/)
})

await test('ship-chain: in connector mode the wait polls with GitHub MCP reads and Monitor timed waits; a top-level access overrides the lanes\'', async () => {
  const { prompt } = await run('ship-chain', { chain: CHAIN }, sc(), { workflow: async () => opened })
  const w = prompt('wait-s1-1')
  assert.match(w, /Poll it with GitHub MCP reads and timed waits: read the PR \(pull_request_read method get/)
  assert.match(w, /timed wait of about 3 minutes with the Monitor tool, never a foreground sleep: an until-loop on the clock/)
  assert.match(w, /until \[ "\$\(date \+%s\)" -ge "\$end" \]/)
  assert.match(w, /get_check_runs and get_status/)
  assert.doesNotMatch(w, /Poll gh pr view/)
  const seen = []
  const gh = await run('ship-chain', { chain: CHAIN, github_access: 'gh' }, sc(), { workflow: async (n, a) => { seen.push(a); return opened } })
  assert.match(gh.prompt('wait-s1-1'), /Poll gh pr view 10 --json state,mergedAt every ~60 seconds with the Monitor tool's until-loop/)
  assert.doesNotMatch(gh.prompt('wait-s1-1'), /pull_request_read|ToolSearch/)
  assert.deepEqual(seen.map(s => s.github_access), ['gh', 'gh'])
  // Nowhere set: the Pipeline config decides, so the wait carries both ways.
  const plainChain = { chain: 's1', order: [{ ...CHAIN.order[0], args: { ...CHAIN.order[0].args, github_access: undefined } }] }
  const seenPlain = []
  const plain = await run('ship-chain', { chain: plainChain, github_access: '' }, sc(), { workflow: async (n, a) => { seenPlain.push(a); return opened } })
  assert.match(plain.prompt('wait-s1-1'), /In gh mode: Poll gh pr view/)
  assert.match(plain.prompt('wait-s1-1'), /In connector mode: Poll it with GitHub MCP reads and timed waits/)
  assert.match(plain.prompt('lookup-s1'), /The access for this run is the GITHUB_ACCESS line in the "Pipeline config"/)
  assert.equal(seenPlain[0].github_access, undefined)
  await assert.rejects(run('ship-chain', { chain: CHAIN, github_access: 'graphql' }, sc(), { workflow: async () => opened }), /github_access must be 'gh', 'connector' or ''/)
})

await test('ship-chain: a lookup or a wait that cannot read GitHub stops the chain with lane_failed', async () => {
  const lookup = await run('ship-chain', { chain: CHAIN }, sc({ 'lookup-s1': { state: 'NONE', pr_number: 0, title: '', error: 'github_unavailable' } }), { workflow: async () => opened })
  assert.equal(lookup.result.status, 'lane_failed')
  assert.match(lookup.result.stopped_at.reason, /the lookup could not run \(error=github_unavailable\)/)
  const wait = await run('ship-chain', { chain: CHAIN }, sc({ 'wait-s1-1': { state: 'OPEN', error: 'error=gh_unauthenticated' } }), { workflow: async () => opened })
  assert.equal(wait.result.status, 'lane_failed')
  assert.match(wait.result.stopped_at.reason, /could not be read while waiting for its merge \(error=gh_unauthenticated\)/)
  assert.ok(!wait.calls.some(c => c.label === 'wait-s1-2'), 'no further wait rounds')
})

// ---- the brief and the builder context never reach a commit, in any of the three workflows
await test('plan-to-merged-pr: every committing stage keeps the brief and the builder context out, and the result lists them', async () => {
  const KEEP = /never stage or commit docs\/brief\.md or docs\/builder-context\.md, nor any file outside the change you are shipping that the plan or \/bootstrap's report lists as left out/
  const busy = { ...OBS, has_conflicts: true, actionable_comments: 1, ci_state: 'red', ci_red_caused_by_pr: true }
  const ship = await run('plan-to-merged-pr', { ship_only: true, branch: 'feat/p-s1', dir: '/w/s1', title: 'T' },
    p2m({ 'merge-check': { ...MC_OK, left_uncommitted: ['docs/brief.md'] }, 'observe-1': busy, 'fix-ci-1': { pushed: false, handled: 0, remaining: 1, summary: 's', left_uncommitted: ['docs/builder-context.md', 'docs/brief.md'] } }))
  for (const l of ['merge-check', 'create-pr', 'merge-main-1', 'process-comments-1', 'fix-ci-1']) {
    assert.match(ship.prompt(l), KEEP, l)
    assert.match(ship.prompt(l), /Stage files by explicit path only \(never git add -A, git add \. or git commit -a\)/, l)
    assert.match(ship.prompt(l), /not a dirty tree to stop on/, l)
  }
  assert.doesNotMatch(ship.prompt('observe-1'), KEEP, 'the read-only observer commits nothing')
  assert.match(ship.prompt('merge-check'), /git status must be clean before merging, apart from the files kept out below/)
  assert.deepEqual(ship.result.left_uncommitted, ['docs/brief.md', 'docs/builder-context.md'])
  const build = await run('plan-to-merged-pr', { concern: 'c', ship: false }, p2m({ 'merge-check': { ...MC_OK, left_uncommitted: ['docs/brief.md'] } }))
  assert.match(build.prompt('merge-check'), KEEP)
  assert.deepEqual(build.result.left_uncommitted, ['docs/brief.md'])
  const clean = await run('plan-to-merged-pr', { concern: 'c', ship: false }, p2m())
  assert.equal(clean.result.left_uncommitted, undefined, 'listed only when something was kept out')
  // The slim lane records keep the list.
  const pbc = await run('proposal-build-chain', { lanes: [{ key: 'a', dir: '/w/a', branch: 'feat/a', proposal: 'p.md', concern: 'ca' }] }, () => ({}),
    { workflow: async () => ({ status: 'pushed', branch: 'feat/a', plan_ref: 'plans/feat-a.md', review_clean: true, polish_clean: true, assumptions: [], left_uncommitted: ['docs/brief.md'] }) })
  assert.deepEqual(pbc.result[0].result.left_uncommitted, ['docs/brief.md'])
  const sch = await run('ship-chain', { chain: CHAIN }, sc(), { workflow: async () => ({ ...opened, left_uncommitted: ['docs/brief.md'] }) })
  assert.deepEqual(sch.result.lanes[0].result.left_uncommitted, ['docs/brief.md'])
})

process.exit(failed ? 1 : 0)

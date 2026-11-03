// Control-flow tests for the workflow scripts, run with stubbed agents (see harness.mjs): `node --test ci/`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './harness.mjs'

// Answers agent calls by label: the first [pattern, reply] whose pattern matches the label wins. A function
// reply gets the call and how many times its pattern matched before; null stands for an agent that died.
const stubs = (...table) => {
  const hits = table.map(() => 0)
  return call => {
    for (const [i, [re, reply]] of table.entries()) {
      if (!re.test(call.label)) continue
      const out = typeof reply === 'function' ? reply(call, hits[i]++) : (hits[i]++, reply)
      return out === null ? null : structuredClone(out)
    }
    throw new Error(`no stub for agent "${call.label}"`)
  }
}
const labels = trace => trace.calls.map(c => c.label)
const promptOf = (trace, re) => {
  const c = trace.calls.find(x => re.test(x.label))
  assert.ok(c, `no agent call matching ${re} in ${labels(trace).join(', ')}`)
  return c.prompt
}

// ---- plan-to-merged-pr

const PR = {
  plan: { branch: 'feat/cache-price-table-20261016', plan: '# Plan: Cache the price table\n\n## Implementation steps\n1. Add the cache.' },
  impl: { summary: 'built the cache', files_changed: ['src/prices.ts', 'test/prices.test.ts'], gates_green: true },
  clean: { findings: [], completed: true },
  bug: { findings: [{ file: 'src/prices.ts', severity: 'bug', description: 'the webhook clears the wrong key' }], completed: true },
  fix: { summary: 'fixed the key', declined: [], gates_green: true },
  polish: { issues_found_and_fixed: 0, summary: 'clean', gates_green: true },
  merge: { blocked: false, merge_check: 'merged 2 commits from origin/main; gates green', gates_green: true, pushed: false },
  pushed: { blocked: false, merge_check: 'merged; gates green', gates_green: true, pushed: true, pushed_sha: '0123456789abcdef' },
  opened: { blocked: false, pr_number: 42, url: 'https://github.com/o/r/pull/42', head_branch: 'feat/cache-price-table-20261016' },
  quiet: { pr_state: 'OPEN', head_sha: 'feedface00', has_conflicts: false, behind_main: false, ai_review_done_on_head: true, ci_state: 'green', ci_red_caused_by_pr: false, actionable_comments: 0, notes: '' },
  action: { pushed: true, handled: 1, remaining: 0, summary: 'done' },
}
// A run where every stage succeeds first time; entries passed in take precedence.
const fullRun = (...overrides) => stubs(
  ...overrides,
  [/^plan$/, PR.plan], [/^setup$/, PR.plan], [/^impl$/, PR.impl], [/^review-changes-/, PR.clean], [/^apply-review-fixes-/, PR.fix],
  [/^polish-/, PR.polish], [/^merge-check$/, PR.merge], [/^(create|ready)-pr$/, PR.opened], [/^observe-/, PR.quiet],
)

test('plan-to-merged-pr: one concern goes from plan to a PR that settles', async () => {
  const t = await run('plan-to-merged-pr', { concern: 'cache the price table' }, { agent: fullRun() })
  assert.equal(t.result.status, 'OPEN')
  assert.equal(t.result.pr.pr_number, 42)
  assert.equal(t.result.review_clean, true)
  assert.equal(t.result.polish_clean, true)
  assert.deepEqual(labels(t), ['plan', 'impl', 'review-changes-1', 'polish-1', 'merge-check', 'create-pr', 'observe-1', 'observe-2'])
})

test('plan-to-merged-pr: a defect is fixed and re-reviewed before anything ships', async () => {
  const t = await run('plan-to-merged-pr', { concern: 'x' }, { agent: fullRun([/^review-changes-1$/, PR.bug]) })
  assert.deepEqual(labels(t).slice(0, 5), ['plan', 'impl', 'review-changes-1', 'apply-review-fixes-1', 'review-changes-2'])
  assert.match(promptOf(t, /^review-changes-2$/), /the webhook clears the wrong key/)
  assert.equal(t.result.review_clean, true)
})

test('plan-to-merged-pr: a defect still standing at the cap stops the run before any push', async () => {
  const t = await run('plan-to-merged-pr', { concern: 'x', max_review_rounds: 2 }, { agent: fullRun([/^review-changes-/, PR.bug]) })
  assert.equal(t.result.status, 'blocked_at_review')
  assert.equal(labels(t).filter(l => l.startsWith('apply-review-fixes')).length, 2)
  assert.ok(!labels(t).some(l => /merge-check|create-pr|observe/.test(l)))
})

test('plan-to-merged-pr: the monitor runs only the steps an observation calls for', async () => {
  const busy = { ...PR.quiet, actionable_comments: 2, has_conflicts: true, ci_state: 'none', ai_review_done_on_head: false }
  const t = await run('plan-to-merged-pr', { pr: 42, branch: 'feat/x' }, {
    agent: stubs([/^observe-1$/, busy], [/^observe-/, PR.quiet], [/^merge-main-1$/, PR.action], [/^process-comments-1$/, PR.action]),
  })
  assert.deepEqual(labels(t), ['observe-1', 'merge-main-1', 'process-comments-1', 'observe-2', 'observe-3'])
  assert.match(promptOf(t, /^process-comments-1$/), /A merge-main step just ran; pull the branch first/)
  assert.equal(t.result.status, 'OPEN')
})

test('plan-to-merged-pr: red CI caused by the PR gets a fix step', async () => {
  const red = { ...PR.quiet, ci_state: 'red', ci_red_caused_by_pr: true }
  const t = await run('plan-to-merged-pr', { pr: 42, branch: 'feat/x' }, {
    agent: stubs([/^observe-1$/, red], [/^observe-/, PR.quiet], [/^fix-ci-1$/, PR.action]),
  })
  assert.deepEqual(labels(t), ['observe-1', 'fix-ci-1', 'observe-2', 'observe-3'])
})

test('plan-to-merged-pr: a stacked build-only lane pushes its branch and opens no PR', async () => {
  const t = await run('plan-to-merged-pr', {
    concern: 'step 3', proposal: 'docs/design/events.md', dir: '/wt/b', branch: 'feat/events-b', bases: ['feat/events-a'], ship: false,
  }, { agent: fullRun([/^plan$/, { ...PR.plan, branch: 'feat/events-b' }], [/^merge-check$/, PR.pushed]) })
  assert.equal(t.result.status, 'pushed')
  assert.ok(!labels(t).includes('create-pr'))
  assert.match(promptOf(t, /^review-changes-1$/), /args "all:origin\/feat\/events-a"/)
  assert.match(promptOf(t, /^plan$/), /from origin\/feat\/events-a/)
})

test('plan-to-merged-pr: the review is measured from origin, never from a possibly stale local main', async () => {
  // A worktree cut from origin/main leaves local main where it was; a diff against it would show main's newer commits.
  const t = await run('plan-to-merged-pr', { concern: 'x', dir: '/wt/x', branch: 'feat/x' }, { agent: fullRun([/^plan$/, { ...PR.plan, branch: 'feat/x' }]) })
  assert.match(promptOf(t, /^review-changes-1$/), /with args "all:origin\/main"/)
  const trunk = await run('plan-to-merged-pr', { concern: 'x', main_branch: 'trunk' }, { agent: fullRun() })
  assert.match(promptOf(trunk, /^review-changes-1$/), /with args "all:origin\/trunk"/)
})

test('plan-to-merged-pr: an already-written plan skips the planner but must find its branch', async () => {
  const given = { plan_text: '# Plan: fix it', dir: '/wt/fix', branch: 'bugfix/a-1-x' }
  const ok = await run('plan-to-merged-pr', { concern: 'Fix #1', ...given }, { agent: fullRun([/^setup$/, { branch: 'bugfix/a-1-x', plan: 'given' }]) })
  assert.equal(ok.result.status, 'OPEN')
  assert.match(promptOf(ok, /^impl$/), /# Plan: fix it/)
  const wrong = await run('plan-to-merged-pr', { concern: 'Fix #1', ...given }, { agent: fullRun([/^setup$/, { branch: 'main', plan: 'given' }]) })
  assert.equal(wrong.result.status, 'failed_at_plan')
  assert.deepEqual(labels(wrong), ['setup'])
})

test('plan-to-merged-pr: argument combinations that could ship unmerged work are refused', async () => {
  await assert.rejects(run('plan-to-merged-pr', { concern: 'x', branch: 'feat/b', bases: ['feat/a'] }), /predecessor_prs/)
  await assert.rejects(run('plan-to-merged-pr', { ship_only: true, branch: 'feat/b' }), /title/)
  await assert.rejects(run('plan-to-merged-pr', { plan_text: 'p', concern: 'x' }), /plan_text needs args.branch/)
})

test('plan-to-merged-pr: ship-only refuses to open a PR while a predecessor is unmerged', async () => {
  const t = await run('plan-to-merged-pr', { ship_only: true, branch: 'feat/b', dir: '/wt/b', title: 'Step 2', predecessor_prs: [41] }, {
    agent: stubs([/^merge-check$/, { blocked: true, blocked_reason: '#41 is OPEN', merge_check: '', gates_green: false, pushed: false }]),
  })
  assert.equal(t.result.status, 'blocked_at_predecessors')
  assert.match(promptOf(t, /^merge-check$/), /#41 reads MERGED/)
})

// ---- proposal-build-chain

const chainLanes = ['a', 'b', 'c'].map((k, i) => ({
  key: k, dir: `/wt/${k}`, branch: `feat/events-${k}`, proposal: 'docs/design/events.md', concern: `step ${i + 1}`,
  ...(i ? { bases: ['feat/events-a', 'feat/events-b'].slice(0, i) } : {}),
}))

test('proposal-build-chain: lanes build in order and the chain stops at the first that does not push', async () => {
  const seen = []
  const t = await run('proposal-build-chain', { lanes: chainLanes, gate: './g.sh', efforts: { review: 'xhigh' } }, {
    workflow: (name, a) => { seen.push({ name, ...a }); return { status: a.branch === 'feat/events-b' ? 'blocked_at_review' : 'pushed' } },
  })
  assert.deepEqual(t.result.map(r => [r.lane, r.status]), [['a', 'pushed'], ['b', 'blocked_at_review']])
  assert.ok(seen.every(a => a.name === 'plan-to-merged-pr' && a.ship === false && a.gate === './g.sh' && a.efforts.review === 'xhigh'))
  assert.deepEqual(seen[1].bases, ['feat/events-a'])
})

test('proposal-build-chain: each lane runs the real plan-to-merged-pr one level down', async () => {
  const t = await run('proposal-build-chain', { lanes: chainLanes.slice(0, 2) }, {
    agent: fullRun([/^plan$/, call => ({ ...PR.plan, branch: /events-b/.test(call.prompt) ? 'feat/events-b' : 'feat/events-a' })], [/^merge-check$/, PR.pushed]),
    workflow: (name, a, ctx) => ctx.run(name, a),
  })
  assert.deepEqual(t.result.map(r => r.status), ['pushed', 'pushed'])
})

// ---- bug-fix-backlog

test('bug-fix-backlog: a reproduced bug ships with Fixes #N and a refuted-by-nobody close is closed', async () => {
  const lane = { key: 'tz', issues: [212, 230] }
  const branch = 'bugfix/tz-212-230-20261016'
  const triage = {
    branch, ahead_of_main: 0, behind_main: 0, baseline_dirty: [],
    issues: [
      { number: 212, title: 'Offsets parse wrong', verdict: 'plan', evidence: 'src/tz.ts:parseOffset', linked_open_pr: '' },
      { number: 230, title: 'Old tz crash', verdict: 'close', evidence: 'fixed by abc123', linked_open_pr: '', close_reason: 'fixed', close_comment: 'Resolved by abc123.\nClosed by /bug-fix after verifying intent against current main.' },
    ],
    plan: '# Plan: Parse offsets\n\nFixes #212',
  }
  const shipped = []
  const t = await run('bug-fix-backlog', { lanes: [lane], root: '/wt', date: '20261016' }, {
    agent: stubs(
      [/^triage:tz$/, triage],
      [/^reproduce:tz$/, { results: [{ number: 212, reproduced: true, behaviour_correct: false, tests: ['test/tz.test.ts::parses offsets'], failure_excerpt: 'expected +05:30', notes: '' }] }],
      [/^skeptic:tz$/, { results: [{ number: 212, refuted: false, evidence: 'no guard upstream' }] }],
      [/^refute-close:tz$/, { results: [{ number: 230, refuted: false, evidence: 'no remaining site' }] }],
      [/^close:tz$/, { closed: [230], not_closed: [] }],
    ),
    workflow: (name, a) => { shipped.push(a); return { status: 'OPEN', pr: { pr_number: 77, url: 'u' }, review_clean: true, polish_clean: true } },
  })
  const [r] = t.result
  assert.deepEqual(r.closed, [230])
  assert.deepEqual(r.bugs.map(b => b.number), [212])
  assert.equal(shipped.length, 1)
  assert.equal(shipped[0].pr_note, 'Fixes #212')
  assert.equal(shipped[0].branch, branch)
  assert.match(shipped[0].plan_text, /Regression tests already written[\s\S]*test\/tz.test.ts::parses offsets/)
  assert.equal(labels(t).filter(l => l === 'refute-close:tz').length, 2)
})

test('bug-fix-backlog: lanes that share an issue are refused', async () => {
  await assert.rejects(run('bug-fix-backlog', { root: '/wt', lanes: [{ key: 'a', issues: [1] }, { key: 'b', issues: [1, 2] }] }), /issue #1 is in lanes a and b/)
})

// Control-flow tests for idea-to-inception: every gate, re-ask, and build path, with stubbed agents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from './harness.mjs'

const IDEA = 'A place where friends swap family recipes, with the story behind each one.'
const DIR = '/repos/recipes-worktrees/inception-recipe-swap'
const stubs = (...table) => call => {
  for (const [re, reply] of table) if (re.test(call.label)) return structuredClone(typeof reply === 'function' ? reply(call) : reply)
  throw new Error(`no stub for agent "${call.label}"`)
}
const labels = t => t.calls.map(c => c.label)
const promptOf = (t, re) => {
  const c = t.calls.find(x => re.test(x.label))
  assert.ok(c, `no agent call matching ${re} in ${labels(t).join(', ')}`)
  return c.prompt
}
// The next run's args: the previous result's next_args with the user's answers added.
const answer = (t, answers) => ({ ...t.result.next_args, answers: { ...t.result.next_args.answers, ...answers } })

const Q = (header, question, options, extra = {}) => ({
  header, question, why: `decides the ${header.toLowerCase()}`, multi_select: false,
  options: options.map(label => ({ label, description: `means ${label.toLowerCase()}` })), recommended: '', recommended_reason: '', ...extra,
})
const INTAKE = {
  title: 'Recipe Swap', slug: 'Recipe Swap!', restated: 'Friends share family recipes and the stories behind them.',
  facts: ['friends share recipes', 'each recipe carries a story'],
  repo: { toplevel: '/repos/recipes/\n', main_ok: true, greenfield: true, existing: '', has_ci: false, has_license: false, conventions: '' },
  questions: [
    Q('Platform users', 'Where do people use it?', ['Web app', 'Phone app'], { recommended: 'Web app', recommended_reason: 'recipes are shared by link' }),
    Q('Scale', 'How many users in a year?', ['Hundreds', 'Thousands', 'Millions', 'Billions', 'More']),
    Q('Priorities', 'Which quality attributes matter most?', ['Running cost', 'Time to market', 'Privacy', 'Offline use'], { multi_select: true }),
    Q('Stack', 'Which language does the team know?', ['TypeScript and Node on the server side']),
  ],
}
const BRIEF = {
  blocked: false, summary: 'A small web app for sharing recipes among friends, cheap to run.',
  quality_attributes: [
    { key: 'speed', name: 'Time to market', description: 'ship a first version soon', top: false },
    { key: 'cost', name: 'Running cost', description: 'cheap to run', top: true },
  ],
  hard_constraints: ['runs on one small VM'], follow_up_questions: [],
}
const DIRECTIONS = {
  directions: [
    { key: 'mono', label: 'Modular monolith', sketch: 'One server-rendered app with SQLite on a VM.', optimizes: 'cost', sacrifices: 'scale-out', serves: 'cost' },
    { key: 'serverless', label: 'Serverless functions', sketch: 'Functions and a managed database.', optimizes: 'operations', sacrifices: 'portability', serves: 'speed' },
    { key: 'local', label: 'Local-first app', sketch: 'An offline app that syncs.', optimizes: 'offline use', sacrifices: 'simplicity', serves: 'privacy' },
  ],
  recommended: ['mono', 'serverless'], recommended_reason: 'they bracket the cost trade-off',
}
const proposal = key => ({ summary: `The ${key} proposal.`, stack: [key], top_risk: `${key} risk`, assumptions: [`${key} assumption`] })
const CRITIQUE = { findings: [{ severity: 'major', section: 'Operations', finding: 'no backups', evidence: '"backups: none"', fix: 'nightly backups' }], hidden_assumptions: ['friends already have accounts'] }
// Criteria are fit (weight 3), delivery (2), then the brief's qualities: cost (top: 3), speed (1).
const judge = rows => ({
  scores: Object.entries(rows).flatMap(([proposal, vals]) => ['fit', 'delivery', 'cost', 'speed'].map((criterion, i) => ({ proposal, criterion, score: vals[i], why: 'cited' }))),
  dealbreakers: [], grafts: [{ from: 'serverless', idea: 'use a managed auth service', benefit: 'less to build' }],
})
const SYNTH = { summary: 'The monolith leads on cost.', recommendation_reason: 'cheapest to run at this scale', grafts: [{ label: 'Managed auth service', from: 'serverless', idea: 'use a managed auth service', benefit: 'less to build' }] }
const DESIGN = {
  base_proposal: 'mono', summary: 'A modular monolith on one VM.',
  questions: [
    Q('Gates', 'Which quality gates should the skeleton set up?', ['Lint, types, tests', 'Tests only']),
    Q('CI', 'Should the skeleton add CI that runs the gates on pull requests?', ['GitHub Actions', 'No CI yet']),
  ],
}
const step = (number, title, extra = {}) => ({ number, title, description: `${title}.`, depends_on: number > 1 ? [number - 1] : [], acceptance: [`${title.toLowerCase()} works`], human_gated: '', ...extra })
const DOCS = {
  adr: 'docs/adr/0001-recipe-swap-architecture.md', design_doc: 'docs/design/recipe-swap.md', claude_md: 'created',
  gates: { full: 'npm run lint && npm run typecheck && npm test', fast: 'npm test' },
  steps: [step(4, 'Swap requests', { depends_on: [2] }), step(1, 'Walking skeleton'), step(2, 'Share a recipe'), step(3, 'Production rollout', { human_gated: 'run the first deploy' })],
  commit_sha: 'abcdef1234567', summary: 'The ADR, the design doc and CLAUDE.md are committed.',
}
const agents = (...overrides) => stubs(
  ...overrides,
  [/^intake$/, INTAKE], [/^brief-/, BRIEF], [/^directions$/, DIRECTIONS],
  [/^(propose|revise):/, call => proposal(call.label.split(':')[1])], [/^critique:/, CRITIQUE],
  [/^judge-/, judge({ mono: [5, 4, 5, 4], serverless: [3, 3, 3, 5] })], [/^synthesize$/, SYNTH],
  [/^design$/, DESIGN], [/^docs$/, DOCS], [/^docs-pr$/, { blocked: false, pr_number: 5, url: 'https://github.com/o/r/pull/5' }],
)
const builds = (children, override = () => null) => (name, a) => {
  children.push({ name, ...a })
  const r = override(a)
  if (r) return r
  if (a.ship_only) return { status: 'OPEN', pr: { pr_number: 9, url: 'https://github.com/o/r/pull/9' }, open_questions: [] }
  return { status: 'pushed', plan: `# Plan: ${a.lane}`, review_clean: true, polish_clean: true, open_questions: a.lane === 'step2' ? ['Should a swap expire?'] : [] }
}

// Walks the gates with these answers and returns every run: intake → directions → decision → design → build.
async function journey(agent = agents()) {
  const intake = await run('idea-to-inception', { idea: IDEA }, { agent })
  const directions = await run('idea-to-inception', answer(intake, { i1: 'Web app (Recommended)', i2: 'Thousands', i3: ['Running cost'], i4: 'TypeScript and Node on the' }), { agent })
  const decision = await run('idea-to-inception', answer(directions, { directions: ['Modular monolith (Recommended)', 'Serverless functions'] }), { agent })
  const design = await run('idea-to-inception', answer(decision, { winner: 'Modular monolith', grafts: ['Managed auth service'] }), { agent })
  const build = await run('idea-to-inception', answer(design, { d1: 'Lint, types, tests', d2: 'GitHub Actions' }), { agent })
  return { intake, directions, decision, design, build }
}

test('inception: the first run only restates the idea and asks, in AskUserQuestion shape', async () => {
  const t = await run('idea-to-inception', IDEA, { agent: agents() })
  assert.equal(t.result.status, 'needs_input')
  assert.equal(t.result.gate, 'intake')
  assert.deepEqual(labels(t), ['intake'])
  assert.match(promptOf(t, /^intake$/), /Read-only/)
  const qs = t.result.questions
  assert.deepEqual(qs.map(q => q.id), ['i1', 'i2', 'i3', 'i4'])
  for (const q of qs) {
    assert.ok(q.header.length <= 12, q.header)
    assert.ok(q.options.length >= 2 && q.options.length <= 4, q.id)
    for (const o of q.options) assert.ok(o.label.replace(' (Recommended)', '').split(' ').length <= 5, o.label)
  }
  // An over-long header is cut at a word boundary, never mid-word.
  assert.equal(qs[0].header, 'Platform')
  assert.deepEqual(qs[0].options.map(o => o.label), ['Web app (Recommended)', 'Phone app'])
  assert.match(qs[0].why, /Recommended: recipes are shared by link/)
  assert.equal(qs[1].options.length, 4)
  assert.equal(qs[2].multiSelect, true)
  // A five-word cap keeps the full text in the description; a lone option is padded rather than dropped.
  assert.deepEqual(qs[3].options.map(o => o.label), ['TypeScript and Node on the', 'No preference'])
  assert.match(qs[3].options[0].description, /^TypeScript and Node on the server side — /)
  const s = t.result.next_args.state
  assert.equal(s.slug, 'recipe-swap')
  assert.equal(s.dir, DIR)
  assert.equal(s.branch, 'inception/recipe-swap')
})

test('inception: it never proceeds past an unanswered question, and spends no agent asking again', async () => {
  const agent = agents()
  const first = await run('idea-to-inception', { idea: IDEA }, { agent })
  const again = await run('idea-to-inception', first.result.next_args, { agent })
  assert.equal(again.calls.length, 0)
  assert.equal(again.result.questions.length, 4)
  const partly = await run('idea-to-inception', answer(first, { i1: 'Web app', i2: 'Thousands', i3: [] }), { agent })
  assert.equal(partly.calls.length, 0)
  // An empty multi-select answer is the user choosing none; a missing one is not an answer.
  assert.deepEqual(partly.result.questions.map(q => q.id), ['i4'])
})

test('inception: the whole journey, gate by gate, with each answer bound into the next stage', async () => {
  const { directions, decision, design, build } = await journey()

  assert.equal(directions.result.gate, 'directions')
  assert.deepEqual(labels(directions), ['brief-1', 'directions'])
  const briefPrompt = promptOf(directions, /^brief-1$/)
  assert.match(briefPrompt, /\[i1\] Where do people use it\?\n {2}Answer: Web app — means web app/)
  assert.match(briefPrompt, /\[i4\] .*\n {2}Answer: TypeScript and Node on the — TypeScript and Node on the server side/)
  assert.match(briefPrompt, /git worktree add -b inception\/recipe-swap \/repos\/recipes-worktrees\/inception-recipe-swap origin\/main/)
  const dq = directions.result.questions[0]
  assert.equal(dq.multiSelect, true)
  assert.deepEqual(dq.options.map(o => o.label), ['Modular monolith (Recommended)', 'Serverless functions (Recommended)', 'Local-first app'])

  assert.equal(decision.result.gate, 'decision')
  // Barriers keep the agent order fixed (resume replays by order): all proposals, all critiques, all revisions, all judges.
  assert.deepEqual(labels(decision), [
    'propose:mono', 'propose:serverless',
    'critique:mono:fit', 'critique:mono:delivery', 'critique:mono:operations',
    'critique:serverless:fit', 'critique:serverless:delivery', 'critique:serverless:operations',
    'revise:mono', 'revise:serverless', 'judge-1', 'judge-2', 'judge-3', 'synthesize',
  ])
  assert.match(promptOf(decision, /^propose:mono$/), /It competes with: Serverless functions\. Do not read the other proposals/)
  assert.match(promptOf(decision, /^revise:mono$/), /friends already have accounts/)
  assert.match(promptOf(decision, /^judge-1$/), /known weaknesses: mono \(/)
  assert.match(promptOf(decision, /^judge-2$/), /known weaknesses: serverless \(/)
  // Weighted in code: mono (3·5 + 2·4 + 3·5 + 1·4) / 9 = 4.67, serverless 29 / 9 = 3.22.
  assert.deepEqual(decision.result.scores.proposals.map(p => [p.proposal, p.total]), [['mono', 4.67], ['serverless', 3.22]])
  const [winner, grafts] = decision.result.questions
  assert.deepEqual(winner.options.map(o => o.label), ['Modular monolith (Recommended)', 'Serverless functions'])
  assert.match(winner.options[0].description, /^4\.67\/5\. The mono proposal\. Biggest risk: mono risk/)
  assert.equal(grafts.id, 'grafts')
  assert.equal(grafts.multiSelect, true)

  assert.equal(design.result.gate, 'design')
  assert.deepEqual(labels(design), ['design'])
  const designPrompt = promptOf(design, /^design$/)
  assert.match(designPrompt, /the proposal \/repos\/recipes-worktrees\/inception-recipe-swap\/docs\/inception\/recipe-swap\/proposals\/mono\.md/)
  assert.match(designPrompt, /"label":"Managed auth service"/)
  assert.match(designPrompt, /whether the skeleton should add CI/)
  assert.match(designPrompt, /the license/)
  assert.deepEqual(design.result.questions.map(q => q.id), ['d1', 'd2'])

  assert.equal(build.result.gate, 'build')
  assert.deepEqual(labels(build), ['docs'])
  assert.match(promptOf(build, /^docs$/), /\[d2\] .*\n {2}Answer: GitHub Actions — means github actions/)
  assert.deepEqual(build.result.questions[0].options.map(o => o.label), ['Skeleton + all lanes', 'Skeleton PR only', 'Docs PR only', 'Stop here'])
  assert.deepEqual(build.result.steps.map(s => s.number), [1, 2, 3, 4])
})

test('inception: "Skeleton + all lanes" builds the skeleton on the docs commit, opens the PR and stacks the later steps', async () => {
  const { build } = await journey()
  const children = []
  const t = await run('idea-to-inception', answer(build, { build: 'Skeleton + all lanes' }), { agent: agents(), workflow: builds(children) })
  assert.equal(t.result.status, 'built')
  assert.deepEqual(children.map(c => [c.name, c.lane]), [['plan-to-merged-pr', 'skeleton'], ['plan-to-merged-pr', 'inception-pr'], ['plan-to-merged-pr', 'step2'], ['plan-to-merged-pr', 'step4']])
  const [skeleton, pr, step2, step4] = children
  assert.deepEqual([skeleton.ship, skeleton.review_base, skeleton.branch, skeleton.dir, skeleton.repo, skeleton.proposal],
    [false, 'abcdef1234567', 'inception/recipe-swap', DIR, '/repos/recipes', 'docs/design/recipe-swap.md'])
  assert.match(skeleton.concern, /^Step 1 of the design doc docs\/design\/recipe-swap\.md: Walking skeleton\. .*Acceptance: walking skeleton works\.$/)
  assert.deepEqual([pr.ship_only, pr.branch, pr.plan_text, pr.title], [true, 'inception/recipe-swap', '# Plan: skeleton', 'Inception: Recipe Swap'])
  assert.deepEqual([step2.ship, step2.branch, step2.dir, step2.bases], [false, 'feat/recipe-swap-step2-share-a-recipe', '/repos/recipes-worktrees/recipe-swap-step2', ['inception/recipe-swap']])
  assert.deepEqual(step4.bases, ['inception/recipe-swap', 'feat/recipe-swap-step2-share-a-recipe'])
  // Step 3 needs a person but nothing depends on it, so the chain goes past it.
  assert.deepEqual(t.result.lanes.map(l => [l.step, l.status]), [[2, 'pushed'], [3, 'skipped_human_step'], [4, 'pushed']])
  assert.deepEqual(t.result.pr, { pr_number: 9, url: 'https://github.com/o/r/pull/9' })
  assert.deepEqual(t.result.open_questions, ['Should a swap expire?'])
  // The first lane may ship once the inception PR merges; a later one is refused until its predecessors are named.
  const [first, second] = t.result.ship_plan
  assert.deepEqual(first.args.predecessor_prs, [9])
  assert.ok(!('predecessor_prs' in second.args))
  await assert.rejects(run('plan-to-merged-pr', second.args), /predecessor_prs/)
})

test('inception: a human step that later steps depend on stops the lanes there', async () => {
  const docs = { ...DOCS, steps: [step(1, 'Walking skeleton'), step(2, 'Production rollout', { human_gated: 'create the cloud account' }), step(3, 'Share a recipe')] }
  const { build } = await journey(agents([/^docs$/, docs]))
  const children = []
  const t = await run('idea-to-inception', answer(build, { build: 'Skeleton + all lanes' }), { agent: agents([/^docs$/, docs]), workflow: builds(children) })
  assert.deepEqual(children.map(c => c.lane), ['skeleton', 'inception-pr'])
  assert.deepEqual(t.result.lanes.map(l => [l.step, l.status]), [[2, 'waits_on_human']])
  assert.ok(t.logs.some(l => /Not built: step\(s\) 3/.test(l)))
})

test('inception: the other build answers stop at the docs, a docs PR, or the skeleton PR', async () => {
  const { build } = await journey()
  const stop = await run('idea-to-inception', answer(build, { build: 'Stop here' }), { agent: agents() })
  assert.equal(stop.result.status, 'docs_committed')
  assert.equal(stop.calls.length, 0)
  assert.deepEqual(stop.result.resume_args.state.pending, { gate: 'build', ids: ['build'] })
  assert.ok(!('build' in stop.result.resume_args.answers))

  const docsPr = await run('idea-to-inception', answer(build, { build: 'Docs PR only' }), { agent: agents() })
  assert.deepEqual([docsPr.result.status, docsPr.result.pr.pr_number], ['docs_pr', 5])
  assert.match(promptOf(docsPr, /^docs-pr$/), /never force, never main/)

  const children = []
  const only = await run('idea-to-inception', answer(build, { build: 'Skeleton PR only' }), { agent: agents(), workflow: builds(children) })
  assert.equal(only.result.status, 'built')
  assert.deepEqual(children.map(c => c.lane), ['skeleton', 'inception-pr'])

  const failing = []
  const broken = await run('idea-to-inception', answer(build, { build: 'Skeleton + all lanes' }), {
    agent: agents(), workflow: builds(failing, a => a.lane === 'skeleton' && { status: 'blocked_at_review', review_clean: false }),
  })
  assert.equal(broken.result.status, 'failed_at_skeleton')
  assert.deepEqual(failing.map(c => c.lane), ['skeleton'])
  assert.equal(broken.result.retry_args.answers.build, 'Skeleton + all lanes')
})

test('inception: fewer than two directions, or none of the proposals, goes back to the directions question', async () => {
  const agent = agents()
  const { directions, decision } = await journey(agent)
  const one = await run('idea-to-inception', answer(directions, { directions: ['Modular monolith'] }), { agent })
  assert.equal(one.calls.length, 0)
  assert.match(one.result.summary, /at least two/)
  assert.ok(!('directions' in one.result.next_args.answers))
  // A direction the user describes in their own words competes too.
  const own = await run('idea-to-inception', answer(directions, { directions: ['Modular monolith', 'A static site regenerated nightly'] }), { agent })
  assert.ok(labels(own).includes('propose:own1'))
  assert.match(promptOf(own, /^propose:own1$/), /in their own words: honour it/)

  const none = await run('idea-to-inception', answer(decision, { winner: 'None of them', grafts: [] }), { agent })
  assert.equal(none.result.gate, 'directions')
  assert.equal(none.calls.length, 0)
  const s = none.result.next_args.state
  assert.ok(!s.proposals && !s.comparison && !s.chosen && !s.questions.winner)
  assert.ok(!('winner' in none.result.next_args.answers))
})

test('inception: a close call marks no option recommended; a free-text winner is read against every proposal', async () => {
  const close = agents([/^judge-/, judge({ mono: [4, 4, 4, 4], serverless: [4, 4, 4, 3] })])
  const { decision } = await journey(close)
  assert.ok(decision.result.questions[0].options.every(o => !/Recommended/.test(o.label)))
  assert.match(decision.result.summary, /within judging noise/)

  const free = await run('idea-to-inception', answer(decision, { winner: 'The monolith, but with serverless image resizing', grafts: [] }), { agent: close })
  assert.equal(free.result.gate, 'design')
  assert.match(promptOf(free, /^design$/), /in their own words, so read it against every proposal/)
  assert.match(promptOf(free, /^design$/), /which proposal the design builds on/)
})

test('inception: follow-up questions get a second round; the last round asks none', async () => {
  const followUp = { ...BRIEF, follow_up_questions: [Q('Platforms', 'Which phone platforms?', ['iOS', 'Android', 'Both'])] }
  const agent = agents([/^brief-1$/, followUp])
  const first = await run('idea-to-inception', { idea: IDEA }, { agent })
  const second = await run('idea-to-inception', answer(first, { i1: 'Phone app', i2: 'Thousands', i3: [], i4: 'No preference' }), { agent })
  assert.equal(second.result.gate, 'intake')
  assert.deepEqual(second.result.questions.map(q => q.id), ['i5'])
  const third = await run('idea-to-inception', answer(second, { i5: 'Both' }), { agent: agents([/^brief-2$/, followUp]) })
  assert.equal(third.result.gate, 'directions')
  assert.match(promptOf(third, /^brief-2$/), /follow_up_questions=\[\] — there are no more question rounds/)
  assert.ok(third.logs.some(l => /were not asked/.test(l)))
})

test('inception: a repository without a first commit on main is blocked, and a changed idea needs a fresh start', async () => {
  const empty = await run('idea-to-inception', { idea: IDEA }, { agent: agents([/^intake$/, { ...INTAKE, repo: { ...INTAKE.repo, main_ok: false } }]) })
  assert.equal(empty.result.status, 'blocked')
  assert.match(empty.result.blocked_reason, /never pushes to main/)
  const first = await run('idea-to-inception', { idea: IDEA }, { agent: agents() })
  await assert.rejects(run('idea-to-inception', { ...first.result.next_args, idea: 'Something else' }), /differs from the idea/)
})

test('inception: the /inception command and the workflow describe the same loop', async () => {
  const { readFileSync } = await import('node:fs')
  const command = readFileSync(new URL('../.claude/commands/inception.md', import.meta.url), 'utf8')
  const first = await run('idea-to-inception', { idea: IDEA }, { agent: agents() })
  const how = first.result.how_to_continue
  for (const s of ['next_args.answers', 'next_args.state', 'AskUserQuestion', 'multiSelect', '(Recommended)']) {
    assert.ok(how.includes(s), `how_to_continue does not mention ${s}`)
    assert.ok(command.includes(s.replace('(Recommended)', '"(Recommended)"')) || command.includes(s), `/inception does not mention ${s}`)
  }
  for (const s of ['idea-to-inception', 'needs_input', 'ship_plan', 'retry_args', 'resume_args', 'predecessor_prs', 'build_context', 'human_done', 'lanes_stopped']) assert.ok(command.includes(s), `/inception does not mention ${s}`)
})

// ---- Regressions found by an independent review of the workflow

// Every question a gate returns must be one AskUserQuestion accepts.
const assertAskable = result => {
  for (const q of result.questions) {
    assert.ok(q.header.length <= 12, `${q.id}: header "${q.header}"`)
    assert.ok(q.options.length >= 2 && q.options.length <= 4, `${q.id} has ${q.options.length} option(s)`)
    for (const o of q.options) assert.ok(o.label.replace(/ \(Recommended\)$/, '').split(' ').length <= 5, `${q.id}: label "${o.label}"`)
    assert.ok(q.options.filter(o => /\(Recommended\)/.test(o.label)).every(o => / \(Recommended\)$/.test(o.label) && !/\(Recommended\).*\(Recommended\)/.test(o.label)), `${q.id}: doubled recommendation`)
  }
}

test('review: every gate returns only questions AskUserQuestion accepts, a single graft included', async () => {
  const runs = await journey()
  for (const t of Object.values(runs)) assertAskable(t.result)
  const grafts = runs.decision.result.questions.find(q => q.id === 'grafts')
  assert.deepEqual(grafts.options.map(o => o.label), ['Managed auth service', 'Adopt none'])
  const design = await run('idea-to-inception', answer(runs.decision, { winner: 'Modular monolith', grafts: ['Adopt none'] }), { agent: agents() })
  assert.match(promptOf(design, /^design$/), /Grafts adopted from other proposals: none/)
})

test('review: only an answer that is wholly "none" counts as none', async () => {
  const agent = agents()
  const { decision } = await journey(agent)
  const free = await run('idea-to-inception', answer(decision, { winner: 'Neither as written: the monolith, with serverless image resizing', grafts: [] }), { agent })
  assert.equal(free.result.gate, 'design')
  assert.match(promptOf(free, /^design$/), /Neither as written/)
  const none = await run('idea-to-inception', answer(decision, { winner: 'None of them.', grafts: [] }), { agent })
  assert.equal(none.result.gate, 'directions')
  const first = await run('idea-to-inception', { idea: IDEA }, { agent })
  const own = await run('idea-to-inception', answer(first, { i1: 'Web app', i2: 'Thousands', i3: ['None of these – accessibility matters most'], i4: 'No preference' }), { agent })
  assert.match(promptOf(own, /^brief-1$/), /\[i3\] .*\n {2}Answer: "None of these – accessibility matters most" \(in the user's own words\)/)
})

test('review: the ship plan carries the build settings the run was given', async () => {
  const settings = { main_branch: 'trunk', ai_review_check: 'AI Code Review', gate: './g.sh', commit_trailers: ['Co-Authored-By: X <x@y>'] }
  const agent = agents()
  const first = await run('idea-to-inception', { idea: IDEA, ...settings }, { agent })
  const { build } = await (async () => {
    const d = await run('idea-to-inception', answer(first, { i1: 'Web app', i2: 'Thousands', i3: ['Running cost'], i4: 'No preference' }), { agent })
    const dec = await run('idea-to-inception', answer(d, { directions: ['Modular monolith', 'Serverless functions'] }), { agent })
    const des = await run('idea-to-inception', answer(dec, { winner: 'Modular monolith', grafts: [] }), { agent })
    return { build: await run('idea-to-inception', answer(des, { d1: 'Lint, types, tests', d2: 'GitHub Actions' }), { agent }) }
  })()
  const children = []
  const t = await run('idea-to-inception', answer(build, { build: 'Skeleton + all lanes' }), { agent, workflow: builds(children) })
  for (const c of children) assert.deepEqual([c.main_branch, c.ai_review_check, c.gate], ['trunk', 'AI Code Review', './g.sh'])
  for (const s of t.result.ship_plan) {
    assert.deepEqual([s.args.main_branch, s.args.ai_review_check, s.args.gate, s.args.commit_trailers], ['trunk', 'AI Code Review', './g.sh', ['Co-Authored-By: X <x@y>']])
    assert.ok(!('context' in s.args))
  }
})

test('review: an agent\'s own "(Recommended)" never reaches a label', async () => {
  const marked = { ...DIRECTIONS, directions: DIRECTIONS.directions.map((d, i) => (i ? d : { ...d, label: 'Modular monolith (Recommended)' })), recommended: [] }
  const agent = agents([/^directions$/, marked], [/^judge-/, judge({ mono: [4, 4, 4, 4], serverless: [4, 4, 4, 3] })])
  const { directions, decision } = await journey(agent)
  assert.deepEqual(directions.result.questions[0].options.map(o => o.label), ['Modular monolith', 'Serverless functions', 'Local-first app'])
  assert.ok(decision.result.questions[0].options.every(o => !/Recommended/.test(o.label)))
})

test('review: picking the "In my own words" placeholder is not an answer', async () => {
  const lone = { ...INTAKE, questions: [Q('Data', 'What data does it keep?', [])] }
  const agent = agents([/^intake$/, lone])
  const first = await run('idea-to-inception', { idea: IDEA }, { agent })
  assert.deepEqual(first.result.questions[0].options.map(o => o.label), ['No preference', 'In my own words'])
  const again = await run('idea-to-inception', answer(first, { i1: 'In my own words' }), { agent })
  assert.equal(again.calls.length, 0)
  assert.match(again.result.summary, /choose Other/)
})

test('review: answers recorded at a gate survive a caller that passes only the newest ones', async () => {
  const followUp = { ...BRIEF, follow_up_questions: [Q('Platforms', 'Which phone platforms?', ['iOS', 'Android', 'Both'])] }
  const first = await run('idea-to-inception', { idea: IDEA }, { agent: agents([/^brief-1$/, followUp]) })
  const second = await run('idea-to-inception', answer(first, { i1: 'Phone app', i2: 'Thousands', i3: ['Privacy'], i4: 'No preference' }), { agent: agents([/^brief-1$/, followUp]) })
  // Only the follow-up answer is passed; the intake answers come from state.
  const third = await run('idea-to-inception', { ...second.result.next_args, answers: { i5: 'Both' } }, { agent: agents() })
  const brief = promptOf(third, /^brief-2$/)
  assert.match(brief, /\[i1\] .*\n {2}Answer: Phone app/)
  assert.match(brief, /\[i3\] .*\n {2}Answer: Privacy/)
  assert.doesNotMatch(brief, /\(no answer\)|Answer: none/)
  // A recorded answer cannot be swapped by a later caller.
  assert.equal(third.result.next_args.state.answers.i1, 'Phone app')
})

test('review: follow-up questions with no text do not use up an intake round', async () => {
  const empty = { ...BRIEF, follow_up_questions: [{ ...Q('X', '', ['a', 'b']) }] }
  const first = await run('idea-to-inception', { idea: IDEA }, { agent: agents([/^brief-1$/, empty]) })
  const next = await run('idea-to-inception', answer(first, { i1: 'Web app', i2: 'Thousands', i3: [], i4: 'No preference' }), { agent: agents([/^brief-1$/, empty]) })
  assert.equal(next.result.gate, 'directions')
})

test('review: proposals rejected with "none" are named as rejected in the docs', async () => {
  const agent = agents()
  const { decision } = await journey(agent)
  const back = await run('idea-to-inception', answer(decision, { winner: 'None of them', grafts: [] }), { agent })
  const dec2 = await run('idea-to-inception', answer(back, { directions: ['Local-first app', 'Serverless functions'] }), { agent })
  const des = await run('idea-to-inception', answer(dec2, { winner: 'Local-first app', grafts: [] }), { agent })
  const docs = await run('idea-to-inception', answer(des, { d1: 'Lint, types, tests', d2: 'GitHub Actions' }), { agent })
  const prompt = promptOf(docs, /^docs$/)
  assert.match(prompt, /rejected in an earlier round[^\n]*Modular monolith[^\n]*proposals\/mono\.md/)
  assert.doesNotMatch(prompt, /rejected in an earlier round[^\n]*Serverless functions/)
})

test('review: a build that stopped resumes where it stopped, with the user\'s answer passed on', async () => {
  const { build } = await journey()
  // The inception PR fails to open, and lane step4 stops with a question.
  const first = []
  const t1 = await run('idea-to-inception', answer(build, { build: 'Skeleton + all lanes' }), {
    agent: agents(),
    workflow: builds(first, a => (a.ship_only && { status: 'blocked_at_merge_check' }) || (a.lane === 'step4' && { status: 'failed_at_impl', stop_reason: 'Should a swap expire?' })),
  })
  assert.equal(t1.result.status, 'failed_at_inception_pr')
  assert.deepEqual(t1.result.lanes.map(l => [l.step, l.status]), [[2, 'pushed'], [3, 'skipped_human_step'], [4, 'failed_at_impl']])
  assert.match(t1.result.how_to_continue, /build_context/)
  // The retry skips the pushed skeleton and step 2, opens the PR, and rebuilds step 4 with the answer as context.
  const second = []
  const t2 = await run('idea-to-inception', { ...t1.result.retry_args, build_context: 'Swaps expire after a week.' }, { agent: agents(), workflow: builds(second) })
  assert.deepEqual(second.map(c => c.lane), ['inception-pr', 'step4'])
  assert.match(second[1].context, /Swaps expire after a week/)
  assert.deepEqual(second[1].bases, ['inception/recipe-swap', 'feat/recipe-swap-step2-share-a-recipe'])
  assert.equal(t2.result.status, 'built')
  assert.deepEqual(t2.result.ship_plan.map(s => s.lane), ['step2', 'step4'])
  // A third run has nothing left to build.
  const third = []
  const t3 = await run('idea-to-inception', { ...t2.result.resume_args }, { agent: agents(), workflow: builds(third) })
  assert.deepEqual(third, [])
  assert.equal(t3.result.status, 'built')
})

test('review: a human-gated step that later steps need waits until the user says it is done', async () => {
  const docs = { ...DOCS, steps: [step(1, 'Walking skeleton'), step(2, 'Cloud account', { human_gated: 'create the cloud account' }), step(3, 'Share a recipe')] }
  const { build } = await journey(agents([/^docs$/, docs]))
  const t1 = await run('idea-to-inception', answer(build, { build: 'Skeleton + all lanes' }), { agent: agents([/^docs$/, docs]), workflow: builds([]) })
  assert.equal(t1.result.status, 'lanes_stopped')
  assert.match(t1.result.how_to_continue, /human_done: \[2\]/)
  const children = []
  const t2 = await run('idea-to-inception', { ...t1.result.retry_args, human_done: [2] }, { agent: agents([/^docs$/, docs]), workflow: builds(children) })
  assert.deepEqual(children.map(c => c.lane), ['step3'])
  assert.deepEqual(t2.result.lanes.map(l => [l.step, l.status]), [[2, 'done_by_human'], [3, 'pushed']])
})

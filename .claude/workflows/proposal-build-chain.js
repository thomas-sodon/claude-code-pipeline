export const meta = {
  name: 'proposal-build-chain',
  description: 'Build a proposal\'s lanes as stacked chains, each lane through plan-to-merged-pr in build-only mode (plan → /impl → review/fix until clean → polish → merge check → push, no PR); lanes come from args.lanes or are derived from the proposal\'s step list',
  whenToUse: 'Implementing the steps of a proposal / design doc as stacked lanes; each lane is later shipped with plan-to-merged-pr {ship_only: true} once every PR below it has merged. Pass { proposal, dir, root, date } to derive the lanes from the doc, or { lanes } to give them by hand. See the pipeline README.',
  phases: [
    { title: 'Derive', detail: 'proposal-lint.py --lanes on the proposal as it is on main (derive mode only)' },
    { title: 'Lanes', detail: 'one plan-to-merged-pr build per lane, in stack order; independent chains run at the same time' },
  ],
}

// Two modes.
// Explicit lanes: { lanes: [Lane], planner?, gate?, main_branch?, commit_trailers?, max_review_rounds?, max_polish?, efforts? }
//   (the shared keys pass through to every lane). Lanes are built in the order given and the run stops at the first
//   lane that does not push.
// Lane: { key, dir, branch, bases?: string[], proposal, concern, planner_args?, steps?: number[] }
//   proposal — path of the proposal / design doc this lane implements part of
//   concern  — the steps in scope for this lane, planned as one increment
//   bases    — branches this lane stacks on (the earlier lanes' branches, still unmerged)
//   steps    — the proposal's step numbers this lane implements; ticked in the proposal in the lane's own commit
// Derive mode: { proposal, dir, root, date?, branch_prefix?, parallel_chains?, ...the shared keys }
//   proposal — the proposal's path relative to the repo root (its step list is the source of the lanes)
//   dir      — an existing checkout of the repo, used only to read the proposal and the remote's branches
//   root     — directory for the lane worktrees (<root>/<doc-slug>-<lane>)
//   date     — suffix of the lane branch names (feat/<doc-slug>-<lane>-<date>), e.g. '20261104' (default 'undated')
//   parallel_chains — default true: independent chains build at the same time; false = one chain after another
//   A lane that does not push stops only its own chain. A lane already pushed by an earlier run (its branch exists on
//   origin) is not rebuilt; later lanes stack on it. Lanes waiting on a human-gated step, on an unfinished step of
//   another doc or on an unfinished roadmap milestone are reported as blocked, never built.
const A = args || {}
const DERIVE = !A.lanes && !!A.proposal
if (!DERIVE && (!A.lanes || !A.lanes.length)) throw new Error('proposal-build-chain: pass args.lanes, or args.proposal (with dir and root) to derive the lanes from the proposal (see the pipeline README)')
if (A.lanes && A.proposal) throw new Error('proposal-build-chain: pass args.lanes or args.proposal, not both (each lane names its own proposal)')
if (DERIVE && (!A.dir || !A.root)) throw new Error('proposal-build-chain: derive mode needs args.dir (a checkout of the repo) and args.root (where the lane worktrees go)')
const MAIN = A.main_branch || 'main'
const SHARED = {}
for (const k of ['planner', 'gate', 'main_branch', 'commit_trailers', 'max_review_rounds', 'max_polish', 'efforts']) if (A[k] !== undefined) SHARED[k] = A[k]

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path); record it as blocked and report it. `
const AUTH = `For gh/git network commands use the GH_WRAPPER prefix from the "Pipeline config" section of CLAUDE.md when it is set and works in this checkout; otherwise run gh/git directly (ambient auth works). `

// Build one lane through plan-to-merged-pr in build-only mode; never throws.
async function buildLane(l) {
  log(`Lane ${l.key}: building ${l.branch}${l.bases && l.bases.length ? ` on ${l.bases.join(', ')}` : ''}`)
  let r = null
  try {
    r = await workflow('plan-to-merged-pr', {
      ...SHARED,
      ...(l.planner_args ? { planner_args: l.planner_args } : {}),
      ...(l.steps && l.steps.length ? { proposal_steps: l.steps } : {}),
      concern: l.concern,
      proposal: l.proposal,
      dir: l.dir,
      branch: l.branch,
      bases: l.bases || [],
      ship: false,
    })
  } catch (err) {
    log(`Lane ${l.key}: ${err && err.message ? err.message : err}`)
  }
  const status = (r && r.status) || 'failed'
  log(`Lane ${l.key}: ${status}`)
  return { lane: l.key, branch: l.branch, steps: l.steps || null, status, result: r }
}

if (!DERIVE) {
  // ---- Explicit lanes: in the order given; a later lane stacks on this one, so stop at the first that does not push.
  phase('Lanes')
  const results = []
  for (const l of A.lanes) {
    if (!l.key || !l.dir || !l.branch || !l.concern || !l.proposal) throw new Error(`proposal-build-chain: lane ${l.key || '?'} needs key, dir, branch, proposal and concern`)
    const r = await buildLane(l)
    results.push(r)
    if (r.status !== 'pushed') break
  }
  return results
}

// ---- Derive the lanes from the proposal as it is on main (the lint script does the derivation; the agent only runs it)
phase('Derive')
const DERIVE_SCHEMA = {
  type: 'object',
  properties: {
    lanes_json: { type: 'string', description: 'the exact stdout of proposal-lint.py --lanes, unedited' },
    exit_code: { type: 'integer', description: 'the exit code of proposal-lint.py --lanes' },
    source: { type: 'string', enum: ['origin', 'working_copy'], description: `origin = the proposal as on origin/${MAIN}; working_copy = it is not on origin/${MAIN} yet` },
    notes: { type: 'string' },
  },
  required: ['lanes_json', 'exit_code', 'source'],
}
const derived = await agent(
  GUARD + AUTH + `Work ONLY in the git checkout ${A.dir} (cd there); change nothing in it: no checkout, no commit, no edit. Use a scratch directory outside the checkout for every file you write.\n` +
  `1. git fetch origin ${MAIN}. Copy the proposals directory as it is on origin/${MAIN} into the scratch directory, keeping repo-relative paths, so cross-doc references resolve: ` +
  `git archive origin/${MAIN} -- "$(dirname ${A.proposal})" | tar -x -C <scratch>. If ${A.proposal} is not on origin/${MAIN}, copy that directory from the working copy instead and report source=working_copy.\n` +
  `2. git ls-remote --heads origin > <scratch>/heads.txt\n` +
  `3. From <scratch> (so the doc path stays repo-relative), run: python3 ${A.dir}/.claude/scripts/proposal-lint.py ${A.proposal} --lanes --repo ${A.dir} --root ${A.root} --date ${A.date || 'undated'}` +
  (A.branch_prefix ? ` --branch-prefix ${A.branch_prefix}` : '') + ` --remote-heads <scratch>/heads.txt\n` +
  `Return its stdout verbatim as lanes_json (do not edit, summarise or reformat it) and its exit code.`,
  { label: 'derive-lanes', phase: 'Derive', effort: 'low', schema: DERIVE_SCHEMA },
)
if (!derived) return { status: 'failed_at_derive' }
let L = null
try { L = JSON.parse(derived.lanes_json) } catch (err) { L = null }
if (!L || !Array.isArray(L.chains)) {
  log('Lane derivation did not return the lint script\'s JSON — stopping')
  return { status: 'failed_at_derive', derive: derived }
}
if (L.errors && L.errors.length) {
  log(`${A.proposal} has ${L.errors.length} lint error(s) — fix the doc (or run /review-proposal) before building`)
  return { status: 'proposal_lint_errors', errors: L.errors, warnings: L.warnings || [] }
}
if (derived.source === 'working_copy') log(`${A.proposal} is not on origin/${MAIN} yet: lanes come from the working copy; merge the doc first so every lane's worktree has it`)
const nLanes = L.chains.reduce((n, c) => n + c.lanes.length, 0)
log(`${A.proposal}: ${L.chains.length} chain(s), ${nLanes} lane(s), ${(L.blocked || []).length} blocked, ${(L.human_gates_pending || []).length} human gate(s) pending`)
for (const b of L.blocked || []) log(`Blocked lane ${b.lane} (steps ${b.steps.join(', ')}): waits on ${b.waiting_on.map(w => `${w.doc ? w.doc + '#' : 'step '}${w.n} (${w.reason})`).join(', ')}`)

// ---- Build: lanes within a chain in order, chains independently (and, by default, at the same time)
phase('Lanes')
async function runChain(chain) {
  const out = []
  for (const lane of chain.lanes) {
    if (lane.already_built) {
      log(`Lane ${lane.key}: ${lane.branch} is already on origin — not rebuilding; later lanes stack on it`)
      out.push({ lane: lane.key, branch: lane.branch, steps: lane.steps, status: 'already_built', result: null })
      continue
    }
    if (!lane.dir) { out.push({ lane: lane.key, branch: lane.branch, steps: lane.steps, status: 'failed', result: null }); break }
    const r = await buildLane({ key: lane.key, dir: lane.dir, branch: lane.branch, bases: lane.bases, proposal: A.proposal, concern: lane.concern, steps: lane.steps })
    out.push(r)
    // A later lane in this chain stacks on this one: never build it on a branch that did not get pushed.
    if (r.status !== 'pushed') break
  }
  const stopped = out.length < chain.lanes.length
  return { chain: chain.key, lanes: out, not_built: stopped ? chain.lanes.slice(out.length).map(l => l.key) : [] }
}
const chains = A.parallel_chains === false
  ? await (async () => { const rs = []; for (const c of L.chains) rs.push(await runChain(c)); return rs })()
  : await parallel(L.chains.map(c => () => runChain(c)))

// Ship plan: each chain in merge order; a stacked lane's PR waits until every PR below it has merged.
const ship_plan = chains.filter(Boolean).map(c => {
  const lanes = (L.chains.find(x => x.key === c.chain) || { lanes: [] }).lanes
  const ok = c.lanes.filter(r => r.status === 'pushed' || r.status === 'already_built').map(r => r.lane)
  return {
    chain: c.chain,
    order: lanes.filter(l => ok.includes(l.key)).map((l, i) => {
      const built = c.lanes.find(r => r.lane === l.key)
      const planText = built && built.result && built.result.plan
      return {
        lane: l.key,
        branch: l.branch,
        // plan_text and proposal give the ship-only monitor this lane's own design context for comments and conflicts.
        args: {
          ship_only: true, branch: l.branch, dir: l.dir, title: `<title for steps ${l.steps.join(', ')}>`, proposal: A.proposal,
          ...(planText ? { plan_text: planText } : {}),
          ...(i ? { predecessor_prs: ['<PR numbers of the lanes above, once merged>'] } : {}),
        },
      }
    }),
  }
})
const built = chains.filter(Boolean).flatMap(c => c.lanes)
const allOk = built.length && built.every(r => r.status === 'pushed' || r.status === 'already_built') && chains.every(c => c && !c.not_built.length)
return {
  status: !L.chains.length ? (L.blocked && L.blocked.length ? 'all_blocked' : 'nothing_to_build') : allOk ? 'pushed' : 'partial',
  proposal: A.proposal,
  source: derived.source,
  chains: chains.filter(Boolean),
  blocked: L.blocked || [],
  human_gates_pending: L.human_gates_pending || [],
  milestone_waits: L.milestone_waits || [],
  ship_plan,
}

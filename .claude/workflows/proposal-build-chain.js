export const meta = {
  name: 'proposal-build-chain',
  description: 'Build a proposal\'s lanes as stacked chains, each lane through plan-to-merged-pr in build-only mode (plan → /impl → review/fix until clean → polish → merge check → push, no PR); lanes come from args.lanes or are derived from the proposal\'s step list',
  whenToUse: 'Implementing the steps of a proposal / design doc as stacked lanes; each lane is later shipped with plan-to-merged-pr {ship_only: true} once every PR below it has merged, or a whole chain in merge order with ship-chain (ship_chain_args in its ship_plan). Pass { proposal, dir, root, date } to derive the lanes from the doc, or { lanes } to give them by hand. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with answers, as its relay says.',
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
// Derive mode: { proposal, dir, root, date?, branch_prefix?, parallel_chains?, allow_draft?, ...the shared keys }
//   proposal — the proposal's path relative to the repo root (its step list is the source of the lanes)
//   dir      — an existing checkout of the repo, used only to read the proposal and the remote's branches
//   root     — directory for the lane worktrees (<root>/<doc-slug>-<lane>)
//   date     — suffix of the lane branch names (feat/<doc-slug>-<lane>-<date>), e.g. '20261104' (default 'undated')
//   parallel_chains — default true: independent chains build at the same time; false = one chain after another
//   allow_draft — build even when the proposal's Status is not accepted / in-progress (default false: a person accepts it first)
//   ai_review_check, required_checks — not used to build; copied into the ship plan's args for the later ship-only runs
//   The result's ship_plan lists, per chain in merge order, each lane's ship-only args, and ship_chain_args: the args of the
//   ship-chain workflow, which ships the chain's lanes one at a time, each once the PR below it reads MERGED.
//   The proposal must already be on origin/<main>: every lane worktree is cut from origin and reads it there.
//   A lane that does not push stops only its own chain. A lane already pushed by an earlier run (its branch exists on
//   origin) is not rebuilt; later lanes stack on it. Lanes waiting on a human-gated step, on an unfinished step of
//   another doc, on an unfinished roadmap milestone, on the proposal's acceptance (a draft: proposal_not_accepted),
//   on a Source: roadmap milestone that does not resolve (milestone_unresolved) or on a blocked lane before them are
//   reported as blocked, never built (the blocking reasons in docs/PROPOSALS.md).
//   Each lane's plan travels by reference: a lane run saves it to the pipeline state branch at its merge check, and the ship
//   plan's args carry plan_ref ('plans/<branch-slug>.md'; for an already_built lane, where its earlier run saved it), with
//   plan_text only for a lane whose save failed. They also carry repo (origin's owner/name), so a ship-only run can recreate a
//   missing lane checkout from a fresh clone.
// Both modes: on_question ('stop' | 'assume') and github_access ('gh' | 'connector' | ''; '' leaves it to the GITHUB_ACCESS
//   line of the Pipeline config) pass through to every lane; github_access also goes into the ship plan's args. A lane whose
//   run stops with needs_input carries its questions (each tagged with the lane's key) up into this result; re-run with the
//   same args plus answers: [{ lane, id, answer }], and each lane gets only its own answers.
// Each lane's result is slim, never the plan text: { status, branch, plan_ref, review_clean, polish_clean, assumptions,
//   questions?, left_uncommitted? }, plus, on a lane that did not push, what stopped it (stage, stop_reason, blocked_reason,
//   review_findings).
const A = args || {}
const DERIVE = !A.lanes && !!A.proposal
if (!DERIVE && (!A.lanes || !A.lanes.length)) throw new Error('proposal-build-chain: pass args.lanes, or args.proposal (with dir and root) to derive the lanes from the proposal (see the pipeline README)')
if (A.lanes && A.proposal) throw new Error('proposal-build-chain: pass args.lanes or args.proposal, not both (each lane names its own proposal)')
if (DERIVE && (!A.dir || !A.root)) throw new Error('proposal-build-chain: derive mode needs args.dir (a checkout of the repo) and args.root (where the lane worktrees go)')
const MAIN = A.main_branch || 'main'
// GitHub access for every lane and the ship plan; '' is not passed on: each run reads the Pipeline config the same way.
const GH_ACCESS = String(A.github_access ?? '').trim().toLowerCase()
if (!['', 'gh', 'connector'].includes(GH_ACCESS)) throw new Error(`github_access must be 'gh', 'connector' or '' (got ${JSON.stringify(A.github_access)})`)
const SHARED = {}
for (const k of ['planner', 'gate', 'main_branch', 'commit_trailers', 'max_review_rounds', 'max_polish', 'efforts', 'allow_draft', 'on_question']) if (A[k] !== undefined) SHARED[k] = A[k]
if (GH_ACCESS) SHARED.github_access = GH_ACCESS
// Answers to a lane's questions go to that lane only (an answer with no lane goes to every lane).
const ANSWERS = Array.isArray(A.answers) ? A.answers.filter(Boolean) : []
const laneAnswers = key => ANSWERS.filter(a => !a.lane || a.lane === key).map(({ lane, ...a }) => a)
const RELAY = `Ask the person these questions yourself, all at once, each with its options and the recommended one first; never answer them on their behalf. ` +
  `Then re-run proposal-build-chain with the same args (the same date) plus answers: each question's lane and id with the person's answer. ` +
  `Lanes already pushed come back already_built; the lane that asked builds again in its kept worktree with its answers.`
// Settings the later ship-only runs need, carried into the ship plan's args.
const SHIP_SHARED = {}
for (const k of ['main_branch', 'ai_review_check', 'required_checks', 'gate', 'commit_trailers']) if (A[k] !== undefined) SHIP_SHARED[k] = A[k]
if (GH_ACCESS) SHIP_SHARED.github_access = GH_ACCESS
// A lane's plan on the pipeline state branch: plans/<branch-slug>.md (every character outside [A-Za-z0-9._-] becomes '-').
const planRefFor = b => `plans/${String(b).replace(/[^A-Za-z0-9._-]/g, '-')}.md`
// Plan text kept out of this result: the ship plan's fallback for a lane whose plan could not be saved (plan_ref '').
const PLAN_TEXT = {}
// A lane's plan-to-merged-pr result without its plan text. What stopped a lane that did not push stays, so a person can act on it.
const slimLane = r => {
  if (!r) return null
  const out = { status: r.status, branch: r.branch, plan_ref: r.plan_ref || '', review_clean: r.review_clean, polish_clean: r.polish_clean, assumptions: r.assumptions || [] }
  if (Array.isArray(r.questions) && r.questions.length) out.questions = r.questions
  // Files the lane's commits kept out on purpose (the brief, the builder context): a person decides what becomes of them.
  if (Array.isArray(r.left_uncommitted) && r.left_uncommitted.length) out.left_uncommitted = r.left_uncommitted
  if (r.status !== 'pushed') {
    if (r.stage) out.stage = r.stage
    if (r.stop_reason) out.stop_reason = r.stop_reason
    if (r.merge_check && r.merge_check.blocked_reason) out.blocked_reason = r.merge_check.blocked_reason
    if (Array.isArray(r.review_findings) && r.review_findings.length) out.review_findings = r.review_findings
  }
  return out
}

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path); record it as blocked and report it. `
const AUTH = `For gh/git network commands use the GH_WRAPPER prefix from the "Pipeline config" section of CLAUDE.md when it is set and works in this checkout; otherwise run gh/git directly (ambient auth works). `

// Build one lane through plan-to-merged-pr in build-only mode; never throws.
async function buildLane(l) {
  log(`Lane ${l.key}: building ${l.branch}${l.bases && l.bases.length ? ` on ${l.bases.join(', ')}` : ''}`)
  let r = null
  try {
    const answers = laneAnswers(l.key)
    r = await workflow('plan-to-merged-pr', {
      ...SHARED,
      ...(answers.length ? { answers } : {}),
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
  log(`Lane ${l.key}: ${status}${r && r.status === 'pushed' ? (r.plan_ref ? ` (plan saved as ${r.plan_ref})` : ' (plan not saved: the ship plan carries its text)') : ''}`)
  if (r && !r.plan_ref && typeof r.plan === 'string' && r.plan) PLAN_TEXT[l.key] = r.plan
  const questions = status === 'needs_input' ? ((r && r.questions) || []).map(q => ({ lane: l.key, ...q })) : []
  return { lane: l.key, branch: l.branch, steps: l.steps || null, status, result: slimLane(r), ...(questions.length ? { questions, relay: RELAY } : {}) }
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
    repo: { type: 'string', description: 'origin\'s GitHub owner/name, e.g. acme/app; empty when origin is not on GitHub. Never a URL or credentials' },
    notes: { type: 'string' },
  },
  required: ['lanes_json', 'exit_code', 'source'],
}
const derived = await agent(
  GUARD + AUTH + `Work ONLY in the git checkout ${A.dir} (cd there); change nothing in it: no checkout, no commit, no edit. Use a scratch directory outside the checkout for every file you write.\n` +
  `1. git fetch origin ${MAIN}. Copy the proposals directory as it is on origin/${MAIN} into the scratch directory, keeping repo-relative paths, so cross-doc references resolve: ` +
  `git archive origin/${MAIN} -- "$(dirname ${A.proposal})" | tar -x -C <scratch>; if the proposal's Source: header names a roadmap in another directory (e.g. ../roadmap.md#3), archive that directory too, so the roadmap's milestone gates resolve (an unresolvable one blocks every lane). If ${A.proposal} is not on origin/${MAIN}, copy those directories from the working copy instead and report source=working_copy.\n` +
  `2. git ls-remote --heads origin > <scratch>/heads.txt\n` +
  `3. From <scratch> (so the doc path stays repo-relative), run: python3 ${A.dir}/.claude/scripts/proposal-lint.py ${A.proposal} --lanes --repo ${A.dir} --root ${A.root} --date ${A.date || 'undated'}` +
  (A.branch_prefix ? ` --branch-prefix ${A.branch_prefix}` : '') + (A.allow_draft ? ' --allow-draft' : '') + ` --remote-heads <scratch>/heads.txt\n` +
  `Return its stdout verbatim as lanes_json (do not edit, summarise or reformat it) and its exit code.\n` +
  `4. Report repo: origin's GitHub owner/name, read from git remote get-url origin (acme/app for https://github.com/acme/app.git); never the URL itself or any credentials in it.`,
  { label: 'derive-lanes', phase: 'Derive', effort: 'low', schema: DERIVE_SCHEMA },
)
if (!derived) return { status: 'failed_at_derive' }
// Where a ship-only run clones a lane's checkout from when it is missing and no checkout of the repository is at hand.
const REPO = (s => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) ? s : '')(String(derived.repo || '').trim().replace(/\.git$/, ''))
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
if (derived.source === 'working_copy') {
  log(`${A.proposal} is not on origin/${MAIN} yet. Land it first (commit it on a branch, /create-pr, merge): every lane worktree is cut from origin/${MAIN} and must read it there`)
  return { status: 'proposal_not_on_main', proposal: A.proposal, preview: L }
}
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
// ship_chain_args is the whole chain as the ship-chain workflow takes it: it ships the lanes in this order and waits for each merge.
const ship_plan = chains.filter(Boolean).map(c => {
  const lanes = (L.chains.find(x => x.key === c.chain) || { lanes: [] }).lanes
  const ok = c.lanes.filter(r => r.status === 'pushed' || r.status === 'already_built').map(r => r.lane)
  const entry = {
    chain: c.chain,
    order: lanes.filter(l => ok.includes(l.key)).map((l, i) => {
      const built = c.lanes.find(r => r.lane === l.key)
      // The plan travels by reference: the lane run's saved plan_ref, or, for a lane an earlier run built, where that run saved
      // it (a ship-only run that finds nothing there goes on without a plan). Its text only when this run's save failed.
      const ref = built && built.status === 'already_built' ? planRefFor(l.branch) : ((built && built.result && built.result.plan_ref) || '')
      const text = ref ? '' : (PLAN_TEXT[l.key] || '')
      return {
        lane: l.key,
        branch: l.branch,
        steps: l.steps,
        // plan_ref (or plan_text) and proposal give the ship-only monitor this lane's own design context for comments and conflicts.
        args: {
          ...SHIP_SHARED, ship_only: true, branch: l.branch, dir: l.dir, title: `<title for steps ${l.steps.join(', ')}>`, proposal: A.proposal,
          ...(REPO ? { repo: REPO } : {}),
          ...(ref ? { plan_ref: ref } : text ? { plan_text: text } : {}),
          ...(i ? { predecessor_prs: ['<PR numbers of the lanes above, once merged>'] } : {}),
        },
      }
    }),
  }
  return { ...entry, ship_chain_args: { chain: entry } }
})
const built = chains.filter(Boolean).flatMap(c => c.lanes)
const questions = built.flatMap(r => r.questions || [])
const allOk = built.length && built.every(r => r.status === 'pushed' || r.status === 'already_built') && chains.every(c => c && !c.not_built.length)
return {
  status: !L.chains.length ? (L.blocked && L.blocked.length ? 'all_blocked' : 'nothing_to_build') : allOk ? 'pushed' : questions.length ? 'needs_input' : 'partial',
  ...(questions.length ? { questions, relay: RELAY } : {}),
  proposal: A.proposal,
  source: derived.source,
  chains: chains.filter(Boolean),
  blocked: L.blocked || [],
  human_gates_pending: L.human_gates_pending || [],
  milestone_waits: L.milestone_waits || [],
  ship_plan,
}

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
// Explicit lanes: { lanes: [Lane], planner?, gate?, main_branch?, commit_trailers?, max_review_rounds?, max_polish?, efforts?, replan? }
//   (the shared keys pass through to every lane). Lanes are built in the order given and the run stops at the first
//   lane that does not push.
// Lane: { key, dir, branch, bases?: string[], proposal, concern, planner_args?, steps?: number[] }
//   proposal — path of the proposal / design doc this lane implements part of
//   concern  — the steps in scope for this lane, planned as one increment
//   bases    — branches this lane stacks on (the earlier lanes' branches, still unmerged)
//   steps    — the proposal's step numbers this lane implements; ticked in the proposal in the lane's own commit
// Derive mode: { proposal, dir, root, date?, branch_prefix?, parallel_chains?, allow_draft?, replan?, ...the shared keys }
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
//   Each lane's plan travels by reference: a lane run saves it to the pipeline state branch when its planning ends and again
//   at its merge check (then with its "## Assumptions to review" section), and the ship plan's args carry plan_ref
//   ('plans/<branch-slug>.md'; for an already_built lane, where its earlier run saved it), with plan_text only for a lane
//   whose save failed. They also carry repo (origin's owner/name), so a ship-only run can recreate a missing lane checkout
//   from a fresh clone.
// Both modes: on_question ('stop' | 'assume') and github_access ('gh' | 'connector' | ''; '' leaves it to the GITHUB_ACCESS
//   line of the Pipeline config) pass through to every lane; github_access also goes into the ship plan's args. A lane whose
//   run stops with needs_input carries its questions (each tagged with the lane's key) up into this result; re-run with the
//   same args plus answers: [{ lane, id, answer, question?, date? }], and each lane gets only its own answers. An answer with
//   no lane reaches every lane: that is for a decision the person made for the whole run, under an id no lane issues (a design
//   answer, intake.d<N>). The ids a lane's own run issues (plan, impl, fix, polish, merge_check, monitor, .q<N> or .d<N>)
//   repeat across lanes, so one of those with no lane is refused (the run throws) when the run has more than one lane. answers
//   is an array: an { id: answer } map cannot name a lane and is refused. An answer whose lane is no lane of the run reaches
//   nobody, and never silently: with explicit lanes it is refused (a mistyped key), and in derive mode, where a lane may have
//   merged since the answer was given, it is logged and returned in answers_unused. The lane
//   that asked then continues from the plan its earlier run saved (its result's plan_ref) instead of planning a second time, so
//   the answer reaches the stage that asked and no planner re-asks or contradicts it.
//   assumptions — [{ lane, stage, assumption }]: what an earlier run's lanes assumed (derive mode: its result's assumptions, as
//   they are; explicit lanes: each lane's result.assumptions with lane: '<its key>' added). Each lane's run gets its own, so a
//   lane that builds on in its kept worktree still lists them in its result, its saved plan and its PR body. One whose lane is
//   not built by this run is not used.
//   replan — true, or the keys of the lanes ([key, ...]) whose planner plans again instead of continuing from a saved plan
//   (passed to those lanes as replan: true). Pass it when the person's answer is to plan a lane again, or when a lane failed on
//   its saved plan itself (its result's hint says so, naming the lane's key). Default: no lane. It is for one run: a lane that
//   planned again leaves replan on the re-run (a needs_input relay gives the value to pass), or it would plan a further time.
// Each lane's result is slim, never the plan text: { status, branch, plan_ref, review_clean, polish_clean, assumptions,
//   questions?, left_uncommitted?, declined?, polish_unfixed? }, plus, on a lane that did not push, what stopped it (stage,
//   stop_reason, blocked_reason, review_findings, hint). The one exception is explicit mode, which has no ship plan: a lane that
//   pushed with plan_ref '' (its plan could not be saved) also carries plan_text, the text derive mode's ship plan would carry
//   for it, for its ship-only run.
// Derive mode's result also lists every built lane's assumptions at the top level: assumptions: [{ lane, stage, assumption }]
//   (each lane's PR body lists its own, under "## Assumptions to review", once the lane is shipped), and, when there are any,
//   answers_unused: the answers given for a lane this run does not have.
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
// Answers to a lane's questions go to that lane only. An answer with no lane goes to every lane, which is for a decision the
// person made for the whole run; an id a lane's own run issues repeats across lanes, so with no lane it could be read against
// another lane's question: refused once the run has more than one lane.
// A map cannot name a lane, so it is refused: dropped without a word, every answer in it would be asked again.
if (A.answers !== undefined && A.answers !== null && !Array.isArray(A.answers)) throw new Error('proposal-build-chain: answers must be an array of { lane?, id, answer, question?, date? } (an { id: answer } map cannot name a lane)')
const ANSWERS = Array.isArray(A.answers) ? A.answers.filter(Boolean) : []
const laneAnswers = key => ANSWERS.filter(a => !a.lane || a.lane === key).map(({ lane, ...a }) => a)
const LANE_SCOPES = ['plan', 'impl', 'fix', 'polish', 'merge_check', 'monitor']
// The answers whose lane is no lane of the run (keys: every lane key the run knows): they would reach nobody.
const strayAnswers = keys => ANSWERS.filter(a => a.lane && !keys.includes(a.lane))
const checkLaneAnswers = keys => {
  const loose = ANSWERS.filter(a => !a.lane && LANE_SCOPES.includes(String(a.id || '').split('.')[0])).map(a => a.id)
  if (keys.length > 1 && loose.length) throw new Error(`proposal-build-chain: answers: ${loose.join(', ')} ${loose.length > 1 ? 'name' : 'names'} no lane; these ids repeat across lanes: pass the lane its question carried`)
}
// What an earlier run's lanes assumed, each line with its lane: a lane's run gets its own.
const laneAssumptions = key => (Array.isArray(A.assumptions) ? A.assumptions : []).filter(a => a && a.assumption && a.lane === key).map(({ lane, ...a }) => a)
// The lanes whose planner plans again instead of continuing from the plan an earlier run saved.
const replanLane = key => A.replan === true || (Array.isArray(A.replan) && A.replan.includes(key))
// The lanes replan named whose planner ran to its end in this run, and the keys of the lanes this run may build. replan is for
// one run: a lane that planned again leaves it on the re-run, or it would plan a further time over the plan its work was built on.
const REPLANNED = new Set()
let LANE_KEYS = []
const replanNext = () => {
  const named = LANE_KEYS.filter(replanLane)
  if (!named.length) return ''
  const keep = named.filter(k => !REPLANNED.has(k))
  return ` This run was given replan, which is for one run: a lane left in it plans a further time, over the plan its work was built on. On the re-run ` +
    (keep.length
      ? `pass replan: ${JSON.stringify(keep)} (the lanes it named whose planner has not planned again yet), with the key of any lane the person's answer says to plan once more.`
      : `leave replan out (every lane it named has planned again), or pass only the key of a lane the person's answer says to plan once more.`)
}
// The relay of a needs_input result; `replan` is replanNext() as it stands when the relay is built.
const relayFor = replan => `Ask the person these questions yourself, in one batch, in as few prompts as the session's question tool allows and never dropping or merging one to fit (a numbered list when it has none), ` +
  `each with its why, its options and the recommended one first; never answer them on their behalf, and never re-run with on_question: 'assume' unless the person says to proceed on assumptions. ` +
  `Also show the person ${DERIVE ? `this result's assumptions (each names its lane)` : `the assumptions in each lane's result (result.assumptions)`}: ` +
  `a line they correct in a lane that asked is passed as an answer too (that lane, id <its stage>.d<N>, N the next number not yet in use, with the assumption as its question). ` +
  (DERIVE ? `A lane that already pushed is not built again by the re-run, so a correction to one of its lines is no answer: the person makes it on that lane's PR, as a review comment, once the PR is open. ` : '') +
  `Then re-run proposal-build-chain with the same args (the same date${replan ? `, and replan as the end of this relay says` : ''}) plus answers: each question's lane, id and question text with the person's answer and the date they gave it, added to any answers given before. ` +
  `Pass assumptions too: ${DERIVE ? `this result's assumptions, as they are` : `the assumptions in each lane's result, each with lane: '<that lane's key>' added`} ` +
  `(a lane that builds on finds its earlier work in place and does not report them again, so without them its PR body would not list them). ` +
  (DERIVE
    ? `Lanes already pushed come back already_built. A lane that asked builds again in its kept worktree with its answers: `
    : `Every lane runs again in the order given, each in its kept worktree, and a lane that asked gets its answers: `) +
  `it continues from the plan its earlier run saved on the pipeline state branch (its result's plan_ref) instead of planning a second time, and plans again only when no plan for the same work is saved, when the saved plan contradicts an answer to a planning question, or when its key is listed in replan. ` +
  `Its uncommitted work is kept only while its worktree exists: in a new container the lane is built again from that plan, with the answers. ` +
  `When the person's answer is to plan a lane again, add replan: ['<that lane's key>'] to the re-run's args.` + replan
// Settings the later ship-only runs need, carried into the ship plan's args.
const SHIP_SHARED = {}
for (const k of ['main_branch', 'ai_review_check', 'required_checks', 'gate', 'commit_trailers']) if (A[k] !== undefined) SHIP_SHARED[k] = A[k]
if (GH_ACCESS) SHIP_SHARED.github_access = GH_ACCESS
// A name as the pipeline state branch spells it in paths: `pipeline-state.py slug`, copied here and in plan-to-merged-pr.js
// (ci/test-workflow-shipping.mjs checks both copies against the script). Every character outside [A-Za-z0-9._-] becomes '-';
// when any did, '-' and 8 hex digits of FNV-1a 32 over the name's UTF-8 bytes follow, so feat/x and feat-x never share a file.
const stateSlug = name => {
  const s = String(name)
  const out = s.replace(/[^A-Za-z0-9._-]/gu, '-')
  if (out === s) return out
  let h = 0x811c9dc5
  const add = b => { h = Math.imul(h ^ b, 0x01000193) >>> 0 }
  for (const ch of s) {
    let c = ch.codePointAt(0)
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd   // a lone surrogate, written as U+FFFD as a UTF-8 encoder does
    if (c < 0x80) add(c)
    else if (c < 0x800) { add(0xc0 | (c >> 6)); add(0x80 | (c & 63)) }
    else if (c < 0x10000) { add(0xe0 | (c >> 12)); add(0x80 | ((c >> 6) & 63)); add(0x80 | (c & 63)) }
    else { add(0xf0 | (c >> 18)); add(0x80 | ((c >> 12) & 63)); add(0x80 | ((c >> 6) & 63)); add(0x80 | (c & 63)) }
  }
  return `${out}-${h.toString(16).padStart(8, '0')}`
}
// A lane's plan on the pipeline state branch: plans/<branch-slug>.md, where the lane's own run saved it.
const planRefFor = b => `plans/${stateSlug(b)}.md`
// Plan text kept out of the lane results: the fallback for a lane whose plan could not be saved (plan_ref ''), read by derive
// mode's ship plan, and in explicit mode added to that lane's own result once it pushed.
const PLAN_TEXT = {}
// A lane's plan-to-merged-pr result without its plan text. What stopped a lane that did not push stays, so a person can act on it.
const slimLane = r => {
  if (!r) return null
  const out = { status: r.status, branch: r.branch, plan_ref: r.plan_ref || '', review_clean: r.review_clean, polish_clean: r.polish_clean, assumptions: r.assumptions || [] }
  if (Array.isArray(r.questions) && r.questions.length) out.questions = r.questions
  // Files the lane's commits kept out on purpose (the brief, the builder context): a person decides what becomes of them.
  if (Array.isArray(r.left_uncommitted) && r.left_uncommitted.length) out.left_uncommitted = r.left_uncommitted
  // Review findings the fixer judged wrong, and the bugs and concerns polish left unfixed: the person sees them, pushed or not.
  if (Array.isArray(r.declined) && r.declined.length) out.declined = r.declined
  if (Array.isArray(r.polish_unfixed) && r.polish_unfixed.length) out.polish_unfixed = r.polish_unfixed
  if (r.status !== 'pushed') {
    if (r.stage) out.stage = r.stage
    if (r.stop_reason) out.stop_reason = r.stop_reason
    if (r.merge_check && r.merge_check.blocked_reason) out.blocked_reason = r.merge_check.blocked_reason
    if (Array.isArray(r.review_findings) && r.review_findings.length) out.review_findings = r.review_findings
    // How to plan the lane again when its saved plan is what stopped it (replan).
    if (r.hint) out.hint = r.hint
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
    const assumed = laneAssumptions(l.key)
    r = await workflow('plan-to-merged-pr', {
      ...SHARED,
      ...(answers.length ? { answers } : {}),
      ...(assumed.length ? { assumptions: assumed } : {}),
      ...(l.planner_args ? { planner_args: l.planner_args } : {}),
      ...(l.steps && l.steps.length ? { proposal_steps: l.steps } : {}),
      ...(replanLane(l.key) ? { replan: true } : {}),
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
  // The lane's planner ran to its end unless the run failed outright, the planner stopped, or the planner itself asked.
  if (replanLane(l.key) && r && status !== 'failed_at_plan' && !(status === 'needs_input' && r.stage === 'plan')) REPLANNED.add(l.key)
  log(`Lane ${l.key}: ${status}${r && r.status === 'pushed' ? (r.plan_ref ? ` (plan saved as ${r.plan_ref})` : ` (plan not saved: ${DERIVE ? 'the ship plan' : 'the lane\'s result'} carries its text)`) : ''}`)
  PLAN_TEXT[l.key] = r && !r.plan_ref && typeof r.plan === 'string' ? r.plan : ''
  const questions = status === 'needs_input' ? ((r && r.questions) || []).map(q => ({ lane: l.key, ...q })) : []
  const result = slimLane(r)
  // The lane run's hint names its own replan arg; through this workflow the lane is named by its key.
  if (result && result.hint) result.hint += ` Through proposal-build-chain, that is replan: ['${l.key}'] added to the same args.`
  return { lane: l.key, branch: l.branch, steps: l.steps || null, status, result, ...(questions.length ? { questions, relay: relayFor(replanNext()) } : {}) }
}

if (!DERIVE) {
  // ---- Explicit lanes: in the order given; a later lane stacks on this one, so stop at the first that does not push.
  // No ship plan carries the fallback here, so a lane that pushed without saving its plan keeps the text in its own result,
  // for the ship-only run that opens its PR. One that did not push is built again by a re-run (from its saved plan, else from a
  // new one), so it stays slim.
  LANE_KEYS = A.lanes.map(l => l && l.key).filter(Boolean)
  checkLaneAnswers(LANE_KEYS)
  // The caller named the lanes, so an answer for any other lane is a mistake in its key: say so before any lane runs.
  const stray = strayAnswers(LANE_KEYS)
  if (stray.length) throw new Error(`proposal-build-chain: answers: ${stray.map(a => `${a.id} (lane ${a.lane})`).join(', ')} ${stray.length > 1 ? 'name' : 'names'} no lane of this run (lanes: ${LANE_KEYS.join(', ')}): fix the lane key, or leave the answer out`)
  phase('Lanes')
  const results = []
  for (const l of A.lanes) {
    if (!l.key || !l.dir || !l.branch || !l.concern || !l.proposal) throw new Error(`proposal-build-chain: lane ${l.key || '?'} needs key, dir, branch, proposal and concern`)
    const r = await buildLane(l)
    if (r.status === 'pushed' && r.result && !r.result.plan_ref && PLAN_TEXT[l.key]) r.result.plan_text = PLAN_TEXT[l.key]
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
// The lanes this run may build: an already-built lane is never built again, so replan and its answers do not concern it.
LANE_KEYS = L.chains.flatMap(c => c.lanes.filter(l => !l.already_built).map(l => l.key))
checkLaneAnswers(L.chains.flatMap(c => c.lanes.map(l => l.key)))
// An answer for a lane the doc no longer derives (it merged, or its steps were edited) or that is blocked reaches no lane of this
// run. That is no mistake of the caller's, who was told to add to the answers given before: it is logged and returned.
const KNOWN_KEYS = [...L.chains.flatMap(c => c.lanes.map(l => l.key)), ...(L.blocked || []).map(b => b.lane)]
const answers_unused = strayAnswers(KNOWN_KEYS)
if (answers_unused.length) log(`Answer(s) for no lane of this run, used by nobody: ${answers_unused.map(a => `${a.id} (lane ${a.lane})`).join(', ')}. Lanes: ${KNOWN_KEYS.join(', ') || 'none'}`)
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
// Every chain has ended: the relay now names the lanes that planned again in any of them, in the lanes' own copies too.
const relay = relayFor(replanNext())
for (const r of built) if (r.relay) r.relay = relay
// What the lanes of this run assumed, in one list: the person sees every lane's before accepting the build.
const assumptions = built.flatMap(r => ((r.result && r.result.assumptions) || []).map(a => ({ lane: r.lane, ...a })))
const allOk = built.length && built.every(r => r.status === 'pushed' || r.status === 'already_built') && chains.every(c => c && !c.not_built.length)
return {
  status: !L.chains.length ? (L.blocked && L.blocked.length ? 'all_blocked' : 'nothing_to_build') : allOk ? 'pushed' : questions.length ? 'needs_input' : 'partial',
  ...(questions.length ? { questions, relay } : {}),
  assumptions,
  ...(answers_unused.length ? { answers_unused } : {}),
  proposal: A.proposal,
  source: derived.source,
  chains: chains.filter(Boolean),
  blocked: L.blocked || [],
  human_gates_pending: L.human_gates_pending || [],
  milestone_waits: L.milestone_waits || [],
  ship_plan,
}

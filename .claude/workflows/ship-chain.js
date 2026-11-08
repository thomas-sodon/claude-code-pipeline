export const meta = {
  name: 'ship-chain',
  description: 'Ship one chain of a proposal-build-chain ship_plan in merge order: each lane through plan-to-merged-pr in ship-only mode, then wait until its PR reads MERGED before the next lane is opened with predecessor_prs filled in',
  whenToUse: 'After proposal-build-chain built a proposal\'s lanes: pass one ship_plan entry as { chain } (each chain\'s ship_chain_args) to open, babysit and wait out its stacked PRs one at a time. A person still merges every PR; the run stops on anything other than MERGED. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with answers, as its relay says.',
  phases: [
    { title: 'Lookup', detail: 'per lane: any PR already open or merged for its branch; fill a placeholder title from its steps' },
    { title: 'Ship', detail: 'plan-to-merged-pr ship-only (or monitor-only for a PR already open), predecessor_prs filled with the merged PRs above' },
    { title: 'Wait', detail: 'poll the PR until it reads MERGED (a person merges it); stop on CLOSED or at the wait cap' },
    { title: 'Close-out', detail: 'once the last lane merged, with a proposal: one plan-to-merged-pr monitor-only round reports the close-out edits (read-only)' },
  ],
}

// args: { chain: { chain, order: [{ lane, branch, steps?, args }] }, title_prefix?, max_wait_rounds?, answers?, ...shared ship settings }
//   chain           — one entry of proposal-build-chain's derive-mode ship_plan (its ship_chain_args.chain), lanes in merge order;
//                     each lane's args are plan-to-merged-pr ship-only args ({ ship_only: true, branch, dir, title, proposal, plan_text?, predecessor_prs? })
//   title_prefix    — prepended to every lane's PR title (e.g. '[status page] '), unless the title already starts with it
//   max_wait_rounds — default 48: wait rounds per lane, each polling the PR for up to ~30 minutes, before the run stops with not_merged
//   main_branch, ai_review_check, required_checks, gate, commit_trailers, max_monitor_rounds, efforts, on_question
//                   — shared ship settings; each one given here overrides the lane's own args
//   answers         — [{ lane, id, answer }]: answers to the questions a needs_input result returned; each lane gets only its own
// A lane's placeholder title (empty, or '<...>' as the ship plan writes it) is written from its proposal steps (steps, or the
// numbers in the placeholder), else from the branch's own commits. predecessor_prs placeholders are replaced by the PR numbers
// of the lanes above, as merged; numbers already given are kept.
// Once every lane has merged, a lane given a proposal gets the close-out check (plan-to-merged-pr's closeout, read-only): from the
// last lane's own run when it saw the merge, else from one monitor-only round on the last PR, which sees MERGED and runs it.
// Re-runs are safe: a lane whose branch already has a MERGED PR is skipped (its PR counts as merged), one with an OPEN PR is
// monitored (plan-to-merged-pr monitor-only) and waited on, never opened twice. This workflow never merges, approves or
// enables auto-merge: a person merges each PR.
const A = args || {}
const C = A.chain
if (!C || !Array.isArray(C.order) || !C.order.length) throw new Error('ship-chain: pass args.chain, one entry of proposal-build-chain\'s ship_plan ({ chain, order: [{ lane, branch, args }] })')
for (const e of C.order) {
  if (!e || !e.lane || !e.branch || !e.args) throw new Error(`ship-chain: every lane in chain.order needs lane, branch and args (lane ${(e && e.lane) || '?'})`)
  if (e.args.branch && e.args.branch !== e.branch) throw new Error(`ship-chain: lane ${e.lane}: args.branch ${e.args.branch} differs from branch ${e.branch}`)
  if (!e.args.dir) throw new Error(`ship-chain: lane ${e.lane} needs args.dir (the checkout it was built in)`)
}
const keys = C.order.map(e => e.lane)
if (new Set(keys).size !== keys.length) throw new Error('ship-chain: lane keys in chain.order must be unique')
const CHAIN = C.chain || keys[0]
const MAIN = A.main_branch || 'main'
const PREFIX = A.title_prefix || ''
const MAX_WAIT = A.max_wait_rounds ?? 48
const SHARED = {}
for (const k of ['main_branch', 'ai_review_check', 'required_checks', 'gate', 'commit_trailers', 'max_monitor_rounds', 'efforts', 'on_question']) if (A[k] !== undefined) SHARED[k] = A[k]
// Answers to a lane's questions go to that lane only (an answer with no lane goes to every lane).
const ANSWERS = Array.isArray(A.answers) ? A.answers.filter(Boolean) : []
const laneAnswers = key => ANSWERS.filter(a => !a.lane || a.lane === key).map(({ lane, ...a }) => a)
const RELAY = `Ask the person these questions yourself, all at once, each with its options and the recommended one first; never answer them on their behalf. ` +
  `Then re-run ship-chain with the same args plus answers: each question's lane and id with the person's answer. ` +
  `Lanes whose PR already merged are skipped; the lane that asked ships again with its answers (monitored, if its PR is already open).`

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path); record it as blocked and report it. `
const AUTH = `For gh/git network commands use the GH_WRAPPER prefix from the "Pipeline config" section of CLAUDE.md when it is set and works in this checkout; otherwise run gh/git directly (ambient auth works). `
const HANDS_OFF = `Never merge, approve, close, reopen or edit a PR, never enable auto-merge, never push: a person merges. `
const isPlaceholder = t => !t || /^\s*<[^>]*>\s*$/.test(String(t))
const stepsOf = e => (Array.isArray(e.steps) && e.steps.length ? e.steps : (String(e.args.title || '').match(/\d+/g) || [])).map(Number).filter(n => Number.isInteger(n) && n > 0)
const prefixed = t => PREFIX && !t.startsWith(PREFIX) ? PREFIX + t : t

const LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['NONE', 'OPEN', 'MERGED', 'CLOSED'], description: 'the branch\'s PR to the main branch: MERGED if any merged, else OPEN if one is open, else CLOSED if one was closed unmerged, else NONE' },
    pr_number: { type: 'integer', description: 'that PR\'s number (0 when NONE)' },
    url: { type: 'string' },
    title: { type: 'string', description: 'the PR title to use when none exists yet: the given title, or the one you wrote for a placeholder' },
    notes: { type: 'string' },
  },
  required: ['state', 'pr_number', 'title'],
}
const WAIT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['OPEN', 'MERGED', 'CLOSED'] },
    notes: { type: 'string', description: 'anything a person should know while it stays open: conflicts, red CI, unanswered review comments, requested changes' },
  },
  required: ['state'],
}

// Find any PR already opened for this lane (an earlier run), and settle its title.
async function lookup(e) {
  const t = e.args.title
  const steps = stepsOf(e)
  const proposal = e.args.proposal
  const titleTask = isPlaceholder(t)
    ? (proposal && steps.length
        ? `The lane has no title yet: read steps ${steps.join(', ')} under "## Steps" in ${proposal} (in this checkout) and write one PR title for them: imperative, specific, under 70 characters, no trailing period, no step numbers. `
        : `The lane has no title yet: read the branch's own commits (git log --format=%s%n%b origin/${MAIN}..origin/${e.branch}) and write one PR title for them: imperative, specific, under 70 characters, no trailing period. `) +
      `Return it as title.`
    : `Return the given title unchanged as title: ${JSON.stringify(String(t))}.`
  return agent(
    GUARD + AUTH + HANDS_OFF + `Work ONLY in the git checkout ${e.args.dir} (cd there); read-only: change no file and no git state beyond git fetch.\n` +
    `1. git fetch origin. List the PRs for head branch ${e.branch}: gh pr list --head ${e.branch} --base ${MAIN} --state all --json number,state,url,title. ` +
    `Report state MERGED with that PR if any merged, else OPEN if one is open, else CLOSED (the latest) if one was closed unmerged, else NONE with pr_number 0.\n` +
    `2. ${titleTask}`,
    { label: `lookup-${e.lane}`, phase: 'Lookup', effort: 'low', schema: LOOKUP_SCHEMA },
  )
}

// Poll the PR until it leaves OPEN, for up to ~30 minutes per round.
async function waitRound(e, n, r) {
  return agent(
    GUARD + AUTH + HANDS_OFF + `Work ONLY in the git checkout ${e.args.dir}. Read-only: change no file, post nothing.\n` +
    `Wait for PR #${n} (branch ${e.branch}) to leave OPEN, round ${r}. Poll gh pr view ${n} --json state,mergedAt every ~60 seconds with the Monitor tool's until-loop ` +
    `(never a foreground sleep), for at most ~30 minutes, and stop polling as soon as state reads MERGED or CLOSED. ` +
    `If it is still OPEN at the end, report OPEN and, in notes, anything holding it: merge conflicts (gh pr view ${n} --json mergeable,mergeStateStatus), ` +
    `red checks (gh pr checks ${n}), unresolved review threads, requested changes, or that it is a draft.`,
    { label: `wait-${e.lane}-${r}`, phase: 'Wait', effort: 'low', schema: WAIT_SCHEMA },
  )
}

const lanes = []
const merged = []
let stop = null
for (let i = 0; i < C.order.length && !stop; i++) {
  const e = C.order[i]
  phase('Lookup')
  const found = await lookup(e)
  if (!found) { stop = { lane: e.lane, status: 'lane_failed', reason: 'the lookup stage did not report' }; lanes.push({ lane: e.lane, branch: e.branch, status: 'lookup_failed' }); break }
  // Prefix only a real title: an empty one must stay empty, so the check below catches it.
  const bare = String(found.title || (isPlaceholder(e.args.title) ? '' : e.args.title) || '').trim()
  const title = bare ? prefixed(bare) : ''
  if (found.state === 'MERGED' && found.pr_number) {
    log(`Lane ${e.lane}: PR #${found.pr_number} already merged — skipping`)
    merged.push(found.pr_number)
    lanes.push({ lane: e.lane, branch: e.branch, pr: { pr_number: found.pr_number, url: found.url || '' }, status: 'MERGED', already_merged: true })
    continue
  }
  if (found.state === 'CLOSED') {
    log(`Lane ${e.lane}: PR #${found.pr_number} was closed without merging — stopping the chain`)
    lanes.push({ lane: e.lane, branch: e.branch, pr: { pr_number: found.pr_number, url: found.url || '' }, status: 'CLOSED' })
    stop = { lane: e.lane, status: 'closed', reason: `PR #${found.pr_number} was closed without merging (an earlier run, or by a person); reopen it or ship the lane by hand` }
    break
  }
  if (found.state !== 'OPEN' && !title) { stop = { lane: e.lane, status: 'lane_failed', reason: 'no PR title: the lookup returned none for a placeholder title' }; lanes.push({ lane: e.lane, branch: e.branch, status: 'lookup_failed' }); break }

  // ---- Ship: ship-only for a lane with no PR yet; monitor-only for one an earlier run already opened.
  phase('Ship')
  const answers = laneAnswers(e.lane)
  const given = (e.args.predecessor_prs || []).map(Number).filter(n => Number.isInteger(n) && n > 0)
  const preds = [...new Set([...given, ...merged])]
  // The lane's own args, minus the keys this run sets (bases belong to the build; ship-only needs predecessor_prs instead).
  const { ship_only, ship, title: _t, predecessor_prs: _p, existing_pr: _x, pr: _pr, bases: _b, ...base } = e.args
  const common = { ...base, ...SHARED, ...(answers.length ? { answers } : {}), branch: e.branch, ...(preds.length ? { predecessor_prs: preds } : {}) }
  const shipArgs = found.state === 'OPEN' ? { ...common, pr: found.pr_number } : { ...common, ship_only: true, title }
  log(found.state === 'OPEN'
    ? `Lane ${e.lane}: PR #${found.pr_number} already open — monitoring it`
    : `Lane ${e.lane}: shipping ${e.branch} as "${title}"${preds.length ? ` after ${preds.map(n => '#' + n).join(', ')}` : ''}`)
  let r = null
  try { r = await workflow('plan-to-merged-pr', shipArgs) } catch (err) { log(`Lane ${e.lane}: ${err && err.message ? err.message : err}`) }
  const status = (r && r.status) || 'failed'
  const pr = (r && r.pr) || (found.state === 'OPEN' ? { pr_number: found.pr_number, url: found.url || '' } : null)
  const entry = { lane: e.lane, branch: e.branch, title: found.state === 'OPEN' ? undefined : title, pr, status, result: r }
  lanes.push(entry)
  log(`Lane ${e.lane}: ${status}${pr ? ` (PR #${pr.pr_number})` : ''}`)
  if (status === 'needs_input') {
    entry.questions = ((r && r.questions) || []).map(q => ({ lane: e.lane, ...q }))
    stop = { lane: e.lane, status: 'needs_input', reason: `stage ${(r && r.stage) || '?'} asked questions only the person can answer` }
    break
  }
  if (status === 'MERGED' && pr) { merged.push(pr.pr_number); continue }
  if (status === 'CLOSED') { stop = { lane: e.lane, status: 'closed', reason: `PR #${pr ? pr.pr_number : '?'} was closed without merging` }; break }
  if (status !== 'OPEN' || !pr || !pr.pr_number) {
    stop = { lane: e.lane, status: 'lane_failed', reason: `plan-to-merged-pr ended with ${status}${r && r.merge_check && r.merge_check.blocked_reason ? `: ${r.merge_check.blocked_reason}` : ''}` }
    break
  }

  // ---- Wait: the next lane's PR must not exist until this one has merged.
  phase('Wait')
  let state = 'OPEN', notes = ''
  for (let w = 1; w <= MAX_WAIT && state === 'OPEN'; w++) {
    const o = await waitRound(e, pr.pr_number, w)
    if (o) { state = o.state; notes = o.notes || notes }
  }
  entry.status = state
  if (notes) entry.wait_notes = notes
  log(`Lane ${e.lane}: PR #${pr.pr_number} ${state}`)
  if (state === 'MERGED') { merged.push(pr.pr_number); continue }
  stop = state === 'CLOSED'
    ? { lane: e.lane, status: 'closed', reason: `PR #${pr.pr_number} was closed without merging` }
    : { lane: e.lane, status: 'not_merged', reason: `PR #${pr.pr_number} is still open after ${MAX_WAIT} wait round(s)${notes ? `: ${notes}` : ''}; merge it, then re-run ship-chain with the same args` }
}

// ---- Close-out: the chain's last PR merged. Report whether the proposal is now complete on main and the edits a person makes.
let closeout
const lastE = C.order[C.order.length - 1]
const lastL = lanes.find(l => l.lane === lastE.lane)
if (!stop && lastE.args.proposal && lastL && lastL.pr && lastL.pr.pr_number) {
  if (lastL.result && lastL.result.closeout) closeout = lastL.result.closeout
  else {
    phase('Close-out')
    const { ship_only, ship, title: _t, predecessor_prs: _p, existing_pr: _x, pr: _pr, bases: _b, ...base } = lastE.args
    let r = null
    try {
      r = await workflow('plan-to-merged-pr', { ...base, ...SHARED, branch: lastE.branch, pr: lastL.pr.pr_number, max_monitor_rounds: 1 })
    } catch (err) { log(`Close-out: ${err && err.message ? err.message : err}`) }
    if (r && r.closeout) closeout = r.closeout
    else log(`Close-out check of ${lastE.args.proposal} did not run — check it by hand (proposal-lint.py --roadmap)`)
  }
}

const shipped = lanes.map(l => l.lane)
const questions = lanes.flatMap(l => l.questions || [])
if (stop) log(`Chain ${CHAIN} stopped at lane ${stop.lane}: ${stop.reason}`)
return {
  status: stop ? stop.status : 'merged',
  chain: CHAIN,
  lanes,
  merged_prs: merged,
  ...(stop ? { stopped_at: { lane: stop.lane, reason: stop.reason } } : {}),
  not_shipped: keys.filter(k => !shipped.includes(k)),
  ...(closeout ? { closeout } : {}),
  ...(questions.length ? { questions, relay: RELAY } : {}),
}

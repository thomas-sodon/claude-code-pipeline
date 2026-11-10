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
//   github_access   — 'gh' | 'connector' | '' (default: each lane's own, as the ship plan gives it, else ''): how the agents reach
//                     GitHub; '' leaves it to the GITHUB_ACCESS line of the Pipeline config (gh when it is absent). It reaches the
//                     lookup, the wait (which in connector mode polls with GitHub MCP reads and Monitor timed waits) and every
//                     lane's plan-to-merged-pr run; given here, it overrides the lanes' own
//   repo            — the repository's GitHub owner/name (default: each lane's own, as the ship plan gives it): what a missing
//                     lane checkout is cloned from when no checkout of the repository is at hand; given here, it overrides
//   answers         — [{ lane, id, answer }]: answers to the questions a needs_input result returned; each lane gets only its own
// A lane's placeholder title (empty, or '<...>' as the ship plan writes it) is written from its proposal steps (steps, or the
// numbers in the placeholder), else from the branch's own commits. predecessor_prs placeholders are replaced by the PR numbers
// of the lanes above, as merged; numbers already given are kept.
// Once every lane has merged, a lane given a proposal gets the close-out check (plan-to-merged-pr's closeout, read-only): from the
// last lane's own run when it saw the merge, else from one monitor-only round on the last PR, which sees MERGED and runs it.
// Re-runs are safe: a lane whose branch already has a MERGED PR is skipped (its PR counts as merged), one with an OPEN PR is
// monitored (plan-to-merged-pr monitor-only) and waited on, never opened twice. This workflow never merges, approves or
// enables auto-merge: a person merges each PR.
// A lane checkout (args.dir) that does not exist, e.g. in a new container, is recreated on the lane's branch from origin by
// the first agent that works in it: here the lookup, and in a lane's own run its first stage.
// Each lane record keeps a slim child result, { status, pr, final_state, handoff, closeout, assumptions, left_uncommitted },
// final_state being a summary of the PR's last observed state: never the whole plan-to-merged-pr result (monitor actions,
// observations, plan).
const A = args || {}
const C = A.chain
if (!C || !Array.isArray(C.order) || !C.order.length) throw new Error('ship-chain: pass args.chain, one entry of proposal-build-chain\'s ship_plan ({ chain, order: [{ lane, branch, args }] })')
const normAccess = v => String(v ?? '').trim().toLowerCase()
const MODES = ['', 'gh', 'connector']
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const TOP_ACCESS = normAccess(A.github_access)
if (!MODES.includes(TOP_ACCESS)) throw new Error(`ship-chain: github_access must be 'gh', 'connector' or '' (got ${JSON.stringify(A.github_access)})`)
const TOP_REPO = A.repo ? String(A.repo).trim() : ''
if (TOP_REPO && !REPO_RE.test(TOP_REPO)) throw new Error('ship-chain: repo must be the repository\'s GitHub owner/name, e.g. acme/app')
for (const e of C.order) {
  if (!e || !e.lane || !e.branch || !e.args) throw new Error(`ship-chain: every lane in chain.order needs lane, branch and args (lane ${(e && e.lane) || '?'})`)
  if (e.args.branch && e.args.branch !== e.branch) throw new Error(`ship-chain: lane ${e.lane}: args.branch ${e.args.branch} differs from branch ${e.branch}`)
  if (!e.args.dir) throw new Error(`ship-chain: lane ${e.lane} needs args.dir (the checkout it was built in)`)
  if (!MODES.includes(normAccess(e.args.github_access))) throw new Error(`ship-chain: lane ${e.lane}: github_access must be 'gh', 'connector' or '' (got ${JSON.stringify(e.args.github_access)})`)
  if (e.args.repo && !REPO_RE.test(String(e.args.repo).trim())) throw new Error(`ship-chain: lane ${e.lane}: repo must be the repository's GitHub owner/name, e.g. acme/app`)
}
const keys = C.order.map(e => e.lane)
if (new Set(keys).size !== keys.length) throw new Error('ship-chain: lane keys in chain.order must be unique')
const CHAIN = C.chain || keys[0]
// proposal-build-chain's ship_chain_args carry main_branch inside each lane's args, not at the top level.
const mainOf = e => A.main_branch || (e.args && e.args.main_branch) || 'main'
const PREFIX = A.title_prefix || ''
const MAX_WAIT = A.max_wait_rounds ?? 48
const SHARED = {}
for (const k of ['main_branch', 'ai_review_check', 'required_checks', 'gate', 'commit_trailers', 'max_monitor_rounds', 'efforts', 'on_question']) if (A[k] !== undefined) SHARED[k] = A[k]
// An empty github_access is no override: each lane keeps its own (from the ship plan), else the Pipeline config decides.
if (TOP_ACCESS) SHARED.github_access = TOP_ACCESS
if (TOP_REPO) SHARED.repo = TOP_REPO
const accessOf = e => TOP_ACCESS || normAccess(e.args.github_access)
const repoOf = e => TOP_REPO || (e.args.repo ? String(e.args.repo).trim() : '')
// Answers to a lane's questions go to that lane only (an answer with no lane goes to every lane).
const ANSWERS = Array.isArray(A.answers) ? A.answers.filter(Boolean) : []
const laneAnswers = key => ANSWERS.filter(a => !a.lane || a.lane === key).map(({ lane, ...a }) => a)
const RELAY = `Ask the person these questions yourself, all at once, each with its options and the recommended one first; never answer them on their behalf. ` +
  `Then re-run ship-chain with the same args plus answers: each question's lane and id with the person's answer. ` +
  `Lanes whose PR already merged are skipped; the lane that asked ships again with its answers (monitored, if its PR is already open).`

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route ` +
  `(Bash, python, sed, heredocs, a different file path); record it as blocked and report it. `
// GitHub access: gh, or the GitHub MCP connector (.claude/scripts/github-access.md maps each gh operation to its tool), named in
// every prompt that touches GitHub. cxOf names a gh command's connector tool and byMode picks mode-specific text, each only
// when the lane's run may be in that mode.
const accessText = (mode, repo) => (mode
  ? `The access for this run is ${mode} (the github_access arg, which overrides the GITHUB_ACCESS line in the "Pipeline config" section of CLAUDE.md). `
  : `The access for this run is the GITHUB_ACCESS line in the "Pipeline config" section of CLAUDE.md (gh when it is absent). `) +
  `Do GitHub reads and writes through the access in use (see .claude/scripts/github-access.md): gh, or with GITHUB_ACCESS: connector the GitHub MCP tools. ` +
  (mode === 'gh' ? '' : `In connector mode, load the mcp__github__ tool schemas with ToolSearch, do each gh command named here with the tool named after it (that file maps the rest), and take the owner and name ${repo ? `from ${repo}` : 'from git remote get-url origin'}, never guessed. `) +
  `If the access in use is unavailable, stop with error=github_unavailable${mode === 'connector' ? '' : ' (gh mode keeps its existing error names, gh_unauthenticated and gh_auth_failed)'}. ` +
  `git fetch and git push stay plain git in both modes. `
const authText = mode => `For ${mode === 'connector' ? 'git' : 'gh/git'} network commands use the GH_WRAPPER prefix from the "Pipeline config" section of CLAUDE.md when it is set and works in this checkout; otherwise run ${mode === 'connector' ? 'git' : 'gh/git'} directly (ambient auth works). `
const cxOf = mode => tool => mode === 'gh' ? '' : ` (connector: ${tool})`
const byMode = (mode, gh, connector) => mode === 'gh' ? gh : mode === 'connector' ? connector : `In gh mode: ${gh} In connector mode: ${connector}`
const HANDS_OFF = `Never merge, approve, close, reopen or edit a PR, never enable auto-merge, never push, through gh or the GitHub MCP tools alike: a person merges. `
// A lane checkout that does not exist (a new container, a removed worktree) is recreated on the lane's branch from origin first.
const recreate = (dir, branch, repo) =>
  `If ${dir} does not exist (a new container, or a removed worktree), recreate it before anything else, on branch ${branch} as it is on origin; this is allowed even in a read-only step. ` +
  `If the checkout you started in (your working directory before any cd) is a checkout of this repository, its origin${repo ? ` being ${repo} and` : ''} having the branch (git ls-remote --heads origin ${branch} lists it), add a worktree from it: ` +
  `git fetch origin +refs/heads/${branch}:refs/remotes/origin/${branch} (a single-branch clone's plain fetch skips other branches), git worktree prune, then git worktree add --track -b ${branch} ${dir} origin/${branch}, ` +
  `or, when a local ${branch} already exists, git worktree add ${dir} ${branch} and git -C ${dir} merge --ff-only origin/${branch}. ` +
  (repo
    ? `Otherwise make a fresh clone: git clone https://github.com/${repo} ${dir}, then git -C ${dir} switch ${branch}. `
    : `Otherwise, with no checkout of this repository to add it from and no repo arg to clone it from, change nothing and report error=checkout_missing (a re-run with repo: '<owner>/<name>' recreates it by a fresh clone). `) +
  `Never recreate it on any other branch. `
// The error code an agent reported for a step it could not run at all ('' when none: an empty or "none" error is no error).
const errorOf = r => { const m = r && typeof r.error === 'string' ? r.error.match(/\b(github_unavailable|gh_unauthenticated|gh_auth_failed|checkout_missing)\b/) : null; return m ? `error=${m[1]}` : '' }
// A lane's plan-to-merged-pr result, slimmed for this result: its status, PR, a summary of the PR's last observed state, the
// hand-off line, the close-out and any assumptions (so none is silent). Monitor actions, observations and plans stay out.
const slim = r => {
  if (!r) return null
  const f = r.final_state
  return {
    status: r.status,
    ...(r.pr ? { pr: r.pr } : {}),
    ...(f ? { final_state: { pr_state: f.pr_state, head_sha: f.head_sha, ci_state: f.ci_state, ai_review_done_on_head: f.ai_review_done_on_head, actionable_comments: f.actionable_comments, has_conflicts: f.has_conflicts, behind_main: f.behind_main } } : {}),
    ...(r.handoff ? { handoff: r.handoff } : {}),
    ...(r.closeout ? { closeout: r.closeout } : {}),
    ...(Array.isArray(r.assumptions) && r.assumptions.length ? { assumptions: r.assumptions } : {}),
    // Files the lane's commits kept out on purpose (the brief, the builder context): a person decides what becomes of them.
    ...(Array.isArray(r.left_uncommitted) && r.left_uncommitted.length ? { left_uncommitted: r.left_uncommitted } : {}),
  }
}
const isPlaceholder = t => !t || /^\s*<[^>]*>\s*$/.test(String(t))
const stepsOf = e => (Array.isArray(e.steps) && e.steps.length ? e.steps : (String(e.args.title || '').match(/\d+/g) || [])).map(Number).filter(n => Number.isInteger(n) && n > 0)
const prefixed = t => PREFIX && !t.startsWith(PREFIX) ? PREFIX + t : t

const LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['NONE', 'OPEN', 'MERGED', 'CLOSED'], description: 'the branch\'s PR to the main branch: MERGED if any merged, else OPEN if one is open, else CLOSED if one was closed unmerged, else NONE' },
    pr_number: { type: 'integer', description: 'that PR\'s number (0 when NONE)' },
    url: { type: 'string' },
    is_draft: { type: 'boolean', description: 'whether that PR is a draft (isDraft); false when there is no open PR' },
    title: { type: 'string', description: 'the PR title to use when none exists yet: the given title, or the one you wrote for a placeholder' },
    notes: { type: 'string' },
    error: { type: 'string', description: 'only when the lookup could not run at all: the error, e.g. error=github_unavailable, error=gh_unauthenticated or error=checkout_missing (the other fields are then ignored); omit it otherwise' },
  },
  required: ['state', 'pr_number', 'title', 'is_draft'],
}
const WAIT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['OPEN', 'MERGED', 'CLOSED'] },
    notes: { type: 'string', description: 'anything a person should know while it stays open: conflicts, red CI, unanswered review comments, requested changes' },
    error: { type: 'string', description: 'only when the PR could not be read at all: the error, e.g. error=github_unavailable or error=checkout_missing (state is then ignored); omit it otherwise' },
  },
  required: ['state'],
}

// Find any PR already opened for this lane (an earlier run), and settle its title.
async function lookup(e) {
  const t = e.args.title
  const MAIN = mainOf(e)
  const steps = stepsOf(e)
  const proposal = e.args.proposal
  const mode = accessOf(e)
  const cx = cxOf(mode)
  const titleTask = isPlaceholder(t)
    ? (proposal && steps.length
        ? `The lane has no title yet: read steps ${steps.join(', ')} under "## Steps" in ${proposal} (in this checkout) and write one PR title for them: imperative, specific, under 70 characters, no trailing period, no step numbers. `
        : `The lane has no title yet: read the branch's own commits (git log --format=%s%n%b origin/${MAIN}..origin/${e.branch}) and write one PR title for them: imperative, specific, under 70 characters, no trailing period. `) +
      `Return it as title.`
    : `Return the given title unchanged as title: ${JSON.stringify(String(t))}.`
  return agent(
    GUARD + accessText(mode, repoOf(e)) + authText(mode) + HANDS_OFF +
    `Work ONLY in the git checkout ${e.args.dir} (cd there); read-only: change no file and no git state beyond git fetch and, if it is missing, recreating that checkout as below.\n` +
    recreate(e.args.dir, e.branch, repoOf(e)) + `\n` +
    `1. git fetch origin, and git fetch origin +refs/heads/${e.branch}:refs/remotes/origin/${e.branch} (a single-branch clone's plain fetch skips it). ` +
    `List the PRs for head branch ${e.branch}: gh pr list --head ${e.branch} --base ${MAIN} --state all --json number,state,url,title,isDraft${cx(`list_pull_requests with head <owner>:${e.branch}, base ${MAIN} and state all, where merged true is MERGED`)}. ` +
    `Report state MERGED with that PR if any merged, else OPEN if one is open (with is_draft from isDraft), else CLOSED (the latest) if one was closed unmerged, else NONE with pr_number 0.\n` +
    `2. ${titleTask}\n` +
    `If the lookup cannot run at all (the access in use is unavailable, or the checkout is missing and could not be recreated), report the error code in error.`,
    { label: `lookup-${e.lane}`, phase: 'Lookup', effort: 'low', schema: LOOKUP_SCHEMA },
  )
}

// Poll the PR until it leaves OPEN, for up to ~30 minutes per round: gh in a Monitor until-loop, or, in connector mode, GitHub
// MCP reads with Monitor timed waits between them (no shell loop can call an MCP tool).
async function waitRound(e, n, r) {
  const mode = accessOf(e)
  return agent(
    GUARD + accessText(mode, repoOf(e)) + authText(mode) + HANDS_OFF + `Work ONLY in the git checkout ${e.args.dir}. Read-only: change no file, post nothing.\n` +
    recreate(e.args.dir, e.branch, repoOf(e)) + `\n` +
    `Wait for PR #${n} (branch ${e.branch}) to leave OPEN, round ${r}. ` +
    byMode(mode,
      `Poll gh pr view ${n} --json state,mergedAt every ~60 seconds with the Monitor tool's until-loop ` +
      `(never a foreground sleep), for at most ~30 minutes, and stop polling as soon as state reads MERGED or CLOSED. ` +
      `If it is still OPEN at the end, report OPEN and, in notes, anything holding it: merge conflicts (gh pr view ${n} --json mergeable,mergeStateStatus), ` +
      `red checks (gh pr checks ${n}), unresolved review threads, requested changes, or that it is a draft.`,
      `Poll it with GitHub MCP reads and timed waits: read the PR (pull_request_read method get: its state, and merged), and while it is open make a timed wait of about 3 minutes with the Monitor tool, ` +
      `never a foreground sleep: an until-loop on the clock (end=$(( $(date +%s) + 180 )); until [ "$(date +%s)" -ge "$end" ]; do sleep 15; done; echo waited), then read again. ` +
      `Keep this up for at most ~30 minutes, and stop as soon as it reads merged (MERGED) or closed unmerged (CLOSED). ` +
      `If it is still open at the end, report OPEN and, in notes, anything holding it, read the same way: merge conflicts (mergeable_state dirty), red checks (pull_request_read get_check_runs and get_status), ` +
      `unresolved review threads (get_review_comments), requested changes (get_reviews), or that it is a draft.`) +
    `\nIf the PR cannot be read at all (the access in use is unavailable, or the checkout is missing and could not be recreated), report the error code in error.`,
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
  const lookupError = errorOf(found)
  if (lookupError) {
    stop = { lane: e.lane, status: 'lane_failed', reason: `the lookup could not run (${lookupError})${found.notes ? `: ${found.notes}` : ''}` }
    lanes.push({ lane: e.lane, branch: e.branch, status: 'lookup_failed' })
    break
  }
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
  // An open PR is monitored as it is; an open draft (a stacked lane's early PR) goes through ship-only with
  // existing_pr, which checks the PRs below it merged and then readies it: nobody can merge a draft.
  const draft = found.state === 'OPEN' && found.is_draft === true
  const shipArgs = found.state === 'OPEN' && !draft ? { ...common, pr: found.pr_number }
    : draft ? { ...common, ship_only: true, existing_pr: found.pr_number, title: title || found.title }
    : { ...common, ship_only: true, title }
  log(found.state === 'OPEN' && !draft
    ? `Lane ${e.lane}: PR #${found.pr_number} already open — monitoring it`
    : draft ? `Lane ${e.lane}: PR #${found.pr_number} is an open draft — readying it${preds.length ? ` after ${preds.map(n => '#' + n).join(', ')}` : ''}`
    : `Lane ${e.lane}: shipping ${e.branch} as "${title}"${preds.length ? ` after ${preds.map(n => '#' + n).join(', ')}` : ''}`)
  let r = null
  try { r = await workflow('plan-to-merged-pr', shipArgs) } catch (err) { log(`Lane ${e.lane}: ${err && err.message ? err.message : err}`) }
  const status = (r && r.status) || 'failed'
  const pr = (r && r.pr) || (found.state === 'OPEN' ? { pr_number: found.pr_number, url: found.url || '' } : null)
  const entry = { lane: e.lane, branch: e.branch, title: found.state === 'OPEN' ? undefined : title, pr, status, result: slim(r) }
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
  let state = 'OPEN', notes = '', waitError = ''
  for (let w = 1; w <= MAX_WAIT && state === 'OPEN'; w++) {
    const o = await waitRound(e, pr.pr_number, w)
    waitError = errorOf(o)
    if (waitError) break
    if (o) { state = o.state; notes = o.notes || notes }
  }
  if (waitError) {
    log(`Lane ${e.lane}: PR #${pr.pr_number} could not be read while waiting (${waitError})`)
    stop = { lane: e.lane, status: 'lane_failed', reason: `PR #${pr.pr_number} could not be read while waiting for its merge (${waitError}); restore the access, then re-run ship-chain with the same args` }
    break
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

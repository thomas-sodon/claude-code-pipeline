export const meta = {
  name: 'bug-fix-backlog',
  description: 'Triage open bug issues with /bug-fix, adversarially verify each verdict (reproduce + refute), close the confirmed-fixed ones, and take each confirmed bug through plan-to-merged-pr',
  whenToUse: 'Walking the open bug backlog: one lane per issue (or per group of issues that share a code site), each triaged, verified and shipped as its own PR. Without lanes, an Intake proposes them from the open bug issues and stops for the person to confirm them. See the pipeline README. A needs_input result carries questions only the person can answer: ask the person (never answer them yourself), then re-run with answers, as its relay says.',
  phases: [
    { title: 'Intake', detail: 'without lanes: list open bug issues and red CI on main, propose lanes, stop for the person to confirm them' },
    { title: 'Triage', detail: '/bug-fix <n> --dry-run per issue, in the lane worktree' },
    { title: 'Verify', detail: 'plan verdicts: failing regression test + skeptic; close verdicts: two refuters' },
    { title: 'Close', detail: 'close only the issues every refuter failed to keep open' },
    { title: 'Ship', detail: 'plan-to-merged-pr with the verified plan (impl → review → polish → PR → monitor)' },
  ],
}

// args: { lanes?: [Lane], intake?, labels?, dir?, root?, date?, gate?, main_branch?, ai_review_check?, commit_trailers?, max_review_rounds?, max_polish?, max_monitor_rounds?, efforts?, ship?, close? }
//   intake  — run the Intake (read-only) instead of taking lanes: it lists the open issues carrying any of labels and the red
//             CI runs on the latest commits of main (report only), groups issues that share a code site, and the run stops
//             with status needs_input (stage intake): one question whose recommended answer is the proposed lanes.
//             Default true when lanes is absent or empty (with intake: false, lanes is required). It never files, edits, labels, comments on or closes an issue.
//   labels  — issue labels the Intake lists (default ['bug'])
//   dir     — the checkout the Intake reads (default: the working directory)
//   root    — directory for lane worktrees (required unless every lane gives its own dir; with the Intake, always)
//   date    — suffix of the default lane branch names, e.g. '20261016' (default 'undated')
//   ship    — default true; false = build only (push, no PR)
//   close   — default true; false = report confirmed-fixed issues instead of closing them
//   efforts — { intake, triage, verify, close } for this workflow's stages; the whole object is also passed to plan-to-merged-pr
//   gate, main_branch, ai_review_check, commit_trailers, max_review_rounds, max_polish, max_monitor_rounds, efforts,
//             on_question and ship: false are passed through to plan-to-merged-pr; no other key is
//   answers — [{ lane, id, answer }]: answers to the questions a lane's needs_input result returned; each lane gets only its own.
//             The Intake's question is answered with [{ id: 'intake.q1', answer }] and no lane: the confirmed lanes as JSON
//             (an array of Lane: the recommended answer or the person's edit of it; '[]' runs nothing), or the accept
//             option ('accept <fingerprint> …'), which runs the re-run's proposal only when it fingerprints the same as
//             the one the person saw (a resumeFromRunId replay does); otherwise the run stops again with the new proposal
// Lane: { key, issues: number[], branch?, dir? }
//   issues  — issues fixed together in one PR (group issues that edit the same code site)
//   branch  — default bugfix/<key>-<issues>-<date> (not fix/<NNN>-…, which /create-pr would read as the issue to close);  dir — default <root>/fix-<issues>
const A = args || {}
const ROOT = A.root
const DATE = A.date || 'undated'
const MAIN = A.main_branch || 'main'
const GATE = A.gate !== undefined ? A.gate : ''
const EFF = { intake: 'medium', triage: 'medium', verify: 'high', close: 'low', ...(A.efforts || {}) }
const SHARED = {}
for (const k of ['gate', 'main_branch', 'ai_review_check', 'commit_trailers', 'max_review_rounds', 'max_polish', 'max_monitor_rounds', 'efforts', 'on_question']) if (A[k] !== undefined) SHARED[k] = A[k]
if (A.ship === false) SHARED.ship = false
// Answers to a lane's questions go to that lane only (an answer with no lane goes to every lane); the Intake's goes to none.
const ANSWERS = Array.isArray(A.answers) ? A.answers.filter(Boolean) : []
const isIntakeAnswer = a => String(a.id || '').split('.')[0] === 'intake'
const laneAnswers = key => ANSWERS.filter(a => !isIntakeAnswer(a) && (!a.lane || a.lane === key)).map(({ lane, ...a }) => a)
const RELAY = `Ask the person these questions yourself, all at once, each with its options and the recommended one first; never answer them on their behalf. ` +
  `Then re-run bug-fix-backlog with the same args (the same date) plus answers: each question's lane and id with the person's answer. ` +
  `Issues already closed or shipped are re-checked and skipped; the lane that asked runs again in its kept worktree with its answers.`
const INTAKE_RELAY = `Ask the person this question yourself: show the proposed lanes (the recommended answer, also in proposed_lanes), the issues left out (unlaned) and the red CI runs (ci_red); ` +
  `never confirm or edit the lanes on their behalf, and file no issue for a red run yourself: whether one becomes an issue is the person's call. ` +
  `Then re-run bug-fix-backlog with the same args (the same date, still without lanes) plus answers: [{ id: 'intake.q1', answer: <the lanes JSON the person confirmed or edited> }] ` +
  `('[]' runs nothing; the accept option, passed back exactly as offered with its fingerprint, runs the proposal only if the re-run's Intake proposes the very same lanes — set resumeFromRunId to this run's id so it replays; a changed proposal stops for confirmation again).`

const GUARD = `If a permission check or classifier denies any action, do NOT retry it through another tool or route (Bash, python, sed, heredocs, a different file path); report it as blocked. `
const AUTH = `For gh/git network commands use the GH_WRAPPER prefix from the "Pipeline config" section of CLAUDE.md when it is set and works in this checkout; otherwise run gh/git directly (ambient auth works). ` +
  `A skill's auth check (e.g. /bug-fix's stop when its first gh call fails on authentication) passes when plain gh is authenticated, even if the GH_WRAPPER prefix does not work here; stop only when plain gh is unauthenticated too. `
const GATES = (GATE
  ? `Run every lint / typecheck / test invocation through the gate semaphore \`${GATE} <command>\` from the checkout root (a compound command as \`${GATE} bash -c '<command>'\`, writing any ' inside it as '\\''; use this instead of any GATE_WRAPPER from the Pipeline config, including where a skill says to use GATE_WRAPPER, and never nest the two; exit 75 = every slot busy: re-run; exit 125/127 = report, never bypass). `
  : `When the "Pipeline config" section of CLAUDE.md sets GATE_WRAPPER, prefix every lint / typecheck / test invocation with it (a compound command as \`$GATE_WRAPPER bash -c '<command>'\`, writing any ' inside it as '\\''). `) +
  `Use the project's test runner as CLAUDE.md describes. Background long runs and wait for them to exit. `
const where = l => `Work ONLY in the git checkout ${l.dir} (cd there / use absolute paths); other agents are using other checkouts, including the main checkout, which you must not touch. `
const nums = l => l.issues.map(n => '#' + n).join(', ')

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string', description: 'branch checked out in the lane worktree' },
    ahead_of_main: { type: 'integer', description: `git rev-list --count origin/${MAIN}..HEAD in the lane worktree after git fetch origin, at setup` },
    behind_main: { type: 'integer', description: `git rev-list --count HEAD..origin/${MAIN} in the lane worktree after git fetch origin, at setup` },
    baseline_dirty: { type: 'array', items: { type: 'string' }, description: 'git status --porcelain --untracked-files=all lines in the lane worktree at setup, before any skill ran' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          verdict: { type: 'string', enum: ['plan', 'close', 'skip'], description: 'skip = the skill stopped with an error (closed, claimed by another folder)' },
          linked_open_pr: { type: 'string', description: 'URL of an open PR whose body closes this issue (the skill warns and proceeds); empty when none' },
          evidence: { type: 'string', description: 'the code facts (current path:symbol) behind the verdict' },
          close_reason: { type: 'string', description: "close verdict: the skill's one-line close reason" },
          close_comment: { type: 'string', description: 'close verdict: the full comment body the skill would post' },
          skip_reason: { type: 'string' },
        },
        required: ['number', 'title', 'verdict', 'evidence'],
      },
    },
    plan: { type: 'string', description: 'ONE combined fix plan covering every plan-verdict issue (empty when none): intent, current code locations, ordered per-file edits, the failing regression tests to add first, gate commands, and a "Fixes #N" line per issue' },
  },
  required: ['branch', 'ahead_of_main', 'behind_main', 'baseline_dirty', 'issues', 'plan'],
}
const REPRO_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          reproduced: { type: 'boolean', description: 'true only if a new test fails on today\'s code for exactly the reason the issue states' },
          behaviour_correct: { type: 'boolean', description: 'true only if running today\'s code showed it already behaves as the issue asks (no defect); false when you merely could not build a test that fails for the right reason' },
          tests: { type: 'array', items: { type: 'string' }, description: 'ids of the regression tests written, as <test file path>::<test name> (left uncommitted in the worktree)' },
          failure_excerpt: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['number', 'reproduced', 'behaviour_correct', 'tests', 'failure_excerpt', 'notes'],
      },
    },
  },
  required: ['results'],
}
const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          refuted: { type: 'boolean', description: 'true if you found concrete code evidence the verdict under test is wrong' },
          evidence: { type: 'string', description: 'current path:symbol and the reasoning; quote the code' },
        },
        required: ['number', 'refuted', 'evidence'],
      },
    },
  },
  required: ['results'],
}
const CLOSE_SCHEMA = {
  type: 'object',
  properties: {
    closed: { type: 'array', items: { type: 'integer' } },
    not_closed: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, reason: { type: 'string' } }, required: ['number', 'reason'] } },
  },
  required: ['closed', 'not_closed'],
}
const REPLAN_SCHEMA = {
  type: 'object',
  properties: { plan: { type: 'string', description: 'the full combined plan, now also covering the reopened issues' } },
  required: ['plan'],
}

const CLEANUP_SCHEMA = {
  type: 'object',
  properties: {
    dirty: { type: 'array', items: { type: 'string' }, description: 'git status --porcelain lines left in the worktree after the cleanup' },
    unresolved: { type: 'array', items: { type: 'string' }, description: 'test ids or paths that could not be located or safely removed' },
  },
  required: ['dirty', 'unresolved'],
}

// ---- Intake: without lanes, propose them from the open bug issues and stop for the person to confirm them.
// Which issues to work, and how they group, is the person's call (on_question does not apply here), so the run never builds on a
// proposal nobody confirmed. Read-only: nothing is filed, labelled, commented on or closed, and a red CI run is only reported.
const INTAKE_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          code_sites: { type: 'array', items: { type: 'string' }, description: 'current path:symbol on origin/main the issue points at (empty when you could not locate one)' },
        },
        required: ['number', 'title', 'labels', 'code_sites'],
      },
      description: 'every open issue carrying any of the labels, once each',
    },
    lanes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'short lowercase slug naming the code site, e.g. "auth-session"' },
          issues: { type: 'array', items: { type: 'integer' } },
          code_site: { type: 'string', description: 'the shared path:symbol' },
          why: { type: 'string', description: 'why these issues are fixed together (one line); for a single-issue lane, its code site' },
        },
        required: ['key', 'issues', 'code_site', 'why'],
      },
    },
    unlaned: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, reason: { type: 'string' } }, required: ['number', 'reason'] }, description: 'listed issues left out of every lane: an open PR already closes it, it is not a bug report, it needs information only its reporter has' },
    ci_red: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          workflow: { type: 'string' }, url: { type: 'string' }, sha: { type: 'string' }, conclusion: { type: 'string' },
          failing_jobs: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string', description: 'one line: what fails, from the failing step\'s log' },
          tracked_by: { type: 'array', items: { type: 'integer' }, description: 'listed issues that already describe this failure' },
        },
        required: ['workflow', 'url', 'sha', 'conclusion', 'failing_jobs', 'summary', 'tracked_by'],
      },
    },
  },
  required: ['issues', 'lanes', 'unlaned', 'ci_red'],
}
const INTAKE_DIR = A.dir || ''
const LABELS = (Array.isArray(A.labels) && A.labels.length ? A.labels : ['bug']).map(String)
// An answer may be a string or a JSON value; an empty array ('run nothing') is an answer, not a missing one.
const INTAKE_ANSWER = ANSWERS.find(a => a.id === 'intake.q1' && a.answer !== undefined && a.answer !== null && (typeof a.answer !== 'string' || a.answer.trim() !== ''))
const INTAKE = A.intake === true || (A.intake !== false && (!A.lanes || !A.lanes.length))
if (!INTAKE && (!A.lanes || !A.lanes.length)) throw new Error('bug-fix-backlog: args.lanes is required with intake: false (see the pipeline README)')
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
// The agent's grouping, made safe to run: each listed issue in exactly one lane (an unplaced one gets its own), keys unique.
function proposeLanes(r) {
  const listed = new Set(r.issues.map(i => i.number))
  const left = new Set(r.unlaned.map(u => u.number))
  const placed = new Set(), keys = new Set(), out = []
  const add = (key, issues, extra) => {
    let k = slug(key) || `bug-${issues[0]}`
    for (let n = 2; keys.has(k); n++) k = `${slug(key) || 'bug'}-${n}`
    keys.add(k); for (const n of issues) placed.add(n)
    out.push({ key: k, issues, ...extra })
  }
  for (const l of r.lanes) {
    const issues = [...new Set((l.issues || []).filter(n => listed.has(n) && !left.has(n) && !placed.has(n)))]
    if (issues.length) add(l.key, issues, { code_site: l.code_site, why: l.why })
  }
  for (const i of r.issues) if (!left.has(i.number) && !placed.has(i.number)) add(`bug-${i.number}`, [i.number], { code_site: (i.code_sites || [])[0] || '', why: 'not grouped by the Intake' })
  return out
}
// A short, deterministic fingerprint of a lane proposal (FNV-1a over its canonical JSON), so an 'accept' can name exactly
// the lanes the person saw.
function fingerprint(lanes) {
  const canon = JSON.stringify(lanes.map(l => ({ key: l.key, issues: [...l.issues].sort((a, b) => a - b) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
  let h = 0x811c9dc5
  for (let i = 0; i < canon.length; i++) { h ^= canon.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
let LANES = A.lanes || []
if (INTAKE) {
  if (!ROOT) throw new Error('bug-fix-backlog: args.root is required with the Intake (its lanes give no dir)')
  // The answer may be an option's own text, relayed back as given: 'accept …', 'none: [] …', or lanes JSON
  // (bare, or inside a sentence).
  const text = INTAKE_ANSWER && typeof INTAKE_ANSWER.answer === 'string' ? INTAKE_ANSWER.answer.trim() : null
  const accept = !!text && /^accept\b/i.test(text)
  // The accept option carries a fingerprint of the lanes the person saw; only that exact proposal is ever run.
  const acceptedFp = accept ? ((text.match(/^accept\s+([0-9a-f]{8})\b/i) || [])[1] || '').toLowerCase() : ''
  if (INTAKE_ANSWER && !accept) {
    let given = INTAKE_ANSWER.answer
    if (text !== null) {
      given = null
      if (/^none\b/i.test(text)) given = []
      else {
        try { given = JSON.parse(text) } catch {
          const a = text.indexOf('['), b = text.lastIndexOf(']')
          try { if (a >= 0 && b > a) given = JSON.parse(text.slice(a, b + 1)) } catch { given = null }
        }
      }
    }
    if (given && !Array.isArray(given) && Array.isArray(given.lanes)) given = given.lanes
    if (!Array.isArray(given)) throw new Error(`bug-fix-backlog: answer intake.q1 must be 'accept' or a JSON array of lanes ({ key, issues })`)
    // Only what a lane is; the Intake's notes (code_site, why) are not lane args.
    // A person may have edited them: issue numbers must be positive integers, and the key becomes a branch name.
    LANES = given.map(l => {
      const issues = Array.isArray(l && l.issues) ? l.issues.map(Number) : []
      if (!issues.length || issues.some(n => !Number.isInteger(n) || n <= 0)) throw new Error(`bug-fix-backlog: confirmed lane ${(l && l.key) || '?'} needs issues as a non-empty array of issue numbers`)
      return { key: slug(l.key) || `bug-${issues[0]}`, issues, ...(l.branch ? { branch: l.branch } : {}), ...(l.dir ? { dir: l.dir } : {}) }
    })
    log(`Intake: running the ${LANES.length} lane(s) the person confirmed`)
  } else {
    phase('Intake')
    const r = await agent(
      GUARD + AUTH + (INTAKE_DIR ? `Work in the git checkout ${INTAKE_DIR} (cd there / use absolute paths). ` : '') +
      `Read-only: edit no file, change no branch and no worktree (git fetch origin is the only git write), and never create, edit, label, comment on, assign or close an issue or PR — even for a red CI run no issue tracks; you only report. ` +
      `You are the intake for a bug-fix backlog run: propose the lanes a person will confirm.\n` +
      `1. List every OPEN issue carrying any of the labels ${JSON.stringify(LABELS)}: gh issue list --state open --label <label> --limit 500 --json number,title,labels,body, once per label, merged so each issue appears once. ` +
      `For each, locate the code it points at on origin/${MAIN} (git fetch origin, then git grep <pattern> origin/${MAIN} / git show origin/${MAIN}:<path>) and record it as code_sites (current path:symbol). ` +
      `Leave out of every lane, in unlaned with the reason, an issue an open PR already closes (gh pr list --state open --search "<n> in:body" --json number,body, with a closing keyword for it), one that is not a bug report (a feature request, a question), or one that cannot be worked without information only its reporter has.\n` +
      `2. Group the rest into lanes: issues whose fix edits the same code site (the same function or a tightly coupled pair) go in one lane, so one PR fixes them together; every other issue is a lane of its own. Never group by topic or label alone. ` +
      `Each lane gets a short lowercase slug key naming its code site, its issues, the shared code_site and a one-line why.\n` +
      `3. Report, never act on, red CI on ${MAIN}: take the 5 newest commits of origin/${MAIN} (git log -5 --format=%H origin/${MAIN}) and their runs (gh run list --branch ${MAIN} --limit 50 --json databaseId,headSha,workflowName,conclusion,url); ` +
      `for each run on those commits whose conclusion is failure, timed_out or startup_failure, give its workflow, url, sha, conclusion, failing jobs (gh run view <id> --json jobs), a one-line summary from the failing step's log (gh run view <id> --log-failed), and tracked_by: the listed issues that already describe it. ` +
      `Nothing to report → empty lists.`,
      { label: 'intake', phase: 'Intake', effort: EFF.intake, schema: INTAKE_SCHEMA },
    )
    if (!r) return { status: 'failed_at_intake' }
    const proposed = proposeLanes(r)
    const lanesOnly = proposed.map(({ key, issues }) => ({ key, issues }))
    const fp = fingerprint(lanesOnly)
    if (accept && acceptedFp === fp) { LANES = lanesOnly; log(`Intake: running the ${LANES.length} proposed lane(s) the person accepted (${fp})`) }
    else {
      if (accept) log(acceptedFp
        ? `Intake: accepted proposal ${acceptedFp} differs from this run's ${fp} (issues regrouped or new ones) — stopping to confirm again`
        : `Intake: 'accept' carried no fingerprint, so it cannot name the lanes the person saw — stopping to confirm again`)
      log(`Intake: ${r.issues.length} open issue(s) labelled ${LABELS.join(' or ')}, ${proposed.length} proposed lane(s), ${r.unlaned.length} left out, ${r.ci_red.length} red CI run(s) on ${MAIN} — stopping for the person to confirm the lanes (status needs_input)`)
      const question = {
        id: 'intake.q1', stage: 'intake',
        question: `Run these ${proposed.length} bug lane(s)? Confirm the grouping, or edit it (regroup issues, drop or add some).`,
        why: 'each lane becomes one branch and one PR fixing its issues together; issues that share a code site belong in one lane, unrelated ones in separate lanes',
        options: [`accept ${fp} (the proposed lanes as listed)`, 'the edited lanes, as a JSON array of { key, issues }', 'none: [] (run nothing)'],
        recommended: JSON.stringify(lanesOnly),
      }
      return { status: 'needs_input', stage: 'intake', ...(accept ? { accept_not_applied: acceptedFp ? 'proposal_changed' : 'no_fingerprint' } : {}), questions: [question], relay: INTAKE_RELAY, labels: LABELS, proposed_lanes: proposed, unlaned: r.unlaned, ci_red: r.ci_red, issues: r.issues }
    }
  }
  if (!LANES.length) { log('Intake: no lanes to run'); return [] }
}
if (!A.root && LANES.some(l => !l.dir)) throw new Error('bug-fix-backlog: args.root is required unless every lane gives its own dir')

const lanes = LANES.map(l => {
  if (!l.key || !l.issues || !l.issues.length) throw new Error(`bug-fix-backlog: lane ${l.key || '?'} needs key and issues`)
  const tag = l.issues.join('-')
  return { ...l, branch: l.branch || `bugfix/${l.key}-${tag}-${DATE}`, dir: l.dir || `${ROOT}/fix-${tag}` }
})
// Lanes run concurrently and every per-issue safeguard assumes an issue, a checkout and a branch belong to one lane.
for (const field of ['key', 'dir', 'branch']) {
  const seen = {}
  for (const l of lanes) { if (seen[l[field]]) throw new Error(`bug-fix-backlog: lanes ${seen[l[field]]} and ${l.key} share ${field} ${l[field]}`); seen[l[field]] = l.key }
}
const owner = {}
for (const l of lanes) for (const n of l.issues) { if (owner[n]) throw new Error(`bug-fix-backlog: issue #${n} is in lanes ${owner[n]} and ${l.key}`); owner[n] = l.key }

const results = await pipeline(
  lanes,

  // ---- Triage: the bug-fix skill decides plan or close for each issue, without mutating anything public
  l => agent(
    GUARD + AUTH + where(l) +
    `Set up first: if ${l.dir} does not exist, git fetch origin and create it as a git worktree on a new branch ${l.branch} from origin/${MAIN}; if it exists, keep it and any work in it. Run git rev-parse --abbrev-ref HEAD there and return its output verbatim as branch (do not switch branches to make it match ${l.branch}; a mismatch stops the lane). Also return git status --porcelain --untracked-files=all there verbatim as baseline_dirty, one line per entry ([] when it prints nothing), and, after git fetch origin, git rev-list --count origin/${MAIN}..HEAD as ahead_of_main and git rev-list --count HEAD..origin/${MAIN} as behind_main.\n` +
    `Then, from ${l.dir}, for EACH of ${nums(l)}: invoke the Skill tool with skill "bug-fix" and args "<number> --dry-run". Stay on branch ${l.branch} (skip the skill's switch-to-${MAIN} step). ` +
    `Dry-run means the skill writes no plan file and closes nothing — keep it that way. Record its verdict per issue (plan / close, or skip if it stopped with an error such as issue_already_closed or issue_claimed_by_other_folder), exactly one entry per issue. ` +
    `If the skill's open-PR precheck warns that an open PR already closes the issue, record that PR's URL as linked_open_pr (it proceeds anyway; this workflow does not).\n` +
    `Then write ONE combined plan for every plan-verdict issue, at today's code locations, in the skill's plan layout: the failing regression test(s) to add first (following the project's testing rules in CLAUDE.md), the ordered per-file edits, the acceptance criteria, and the gate commands; end it with a "Fixes #N" line per plan-verdict issue. ` +
    (l.issues.length > 1 ? `These issues share a code site: design one fix that resolves all of them rather than stacking patches. ` : '') +
    `Do NOT edit any repo file in this step.`,
    { label: `triage:${l.key}`, phase: 'Triage', effort: EFF.triage, schema: TRIAGE_SCHEMA },
  ),

  // ---- Verify: every verdict faces an independent check before it is acted on
  async (tri, l) => {
    if (!tri) return { lane: l, status: 'failed_at_triage' }
    if ((tri.branch || '').trim() !== l.branch) { log(`${l.key}: ${l.dir} is on ${tri.branch || '(unknown)'}, not ${l.branch}`); return { lane: l, status: 'branch_mismatch' } }
    // Only the lane's own issues count, and every one of them must come out of this lane somewhere.
    const rows = tri.issues.filter(i => l.issues.includes(i.number))
    const missing = l.issues.filter(n => !rows.some(i => i.number === n))
    if (missing.length) log(`${l.key}: triage returned no verdict for ${missing.map(n => '#' + n).join(', ')}`)
    // One row per issue: rows that disagree on the verdict could both close an issue and claim to fix it, so neither is acted on.
    const conflicting = l.issues.filter(n => new Set(rows.filter(i => i.number === n).map(i => i.verdict)).size > 1)
    const triaged = l.issues.filter(n => !conflicting.includes(n)).map(n => {
      const same = rows.filter(i => i.number === n)
      return same.length && { ...same[0], linked_open_pr: same.map(i => i.linked_open_pr).find(Boolean) || '' }
    }).filter(Boolean)
    // An issue an open PR already closes is that PR's to fix or close: shipping it (even after a refuted close) would open a competing PR.
    const linked = triaged.filter(i => i.verdict !== 'skip' && i.linked_open_pr)
    // A plan verdict judged on a tree behind origin/${MAIN} cannot see fixes that landed since, so shipping it could re-fix a bug main no longer has.
    const planRows = triaged.filter(i => i.verdict === 'plan' && !i.linked_open_pr)
    const stalePlans = tri.behind_main === 0 ? [] : planRows
    const planned = planRows.filter(i => !stalePlans.includes(i))
    // A close is public and claims the fix is on main, so it is judged only in a worktree that is exactly origin/${MAIN}:
    // a kept worktree holding an earlier run's unlanded fix would show the bug as gone when main still has it.
    tri.baseline_dirty = (tri.baseline_dirty || []).filter(b => b.trim())
    const atMain = tri.ahead_of_main === 0 && tri.behind_main === 0 && !tri.baseline_dirty.length
    const closeRows = triaged.filter(i => i.verdict === 'close' && !i.linked_open_pr)
    const unclosable = closeRows.filter(i => !atMain || !(i.close_comment || '').trim())
    const closing = closeRows.filter(i => !unclosable.includes(i))
    const brief = list => JSON.stringify(list.map(i => ({ number: i.number, title: i.title, evidence: i.evidence, close_reason: i.close_reason })), null, 1)
    const thunks = []
    if (planned.length) {
      // Reproduce lens: the failing test the fix is later held to (a bug needs a failing test first).
      thunks.push(() => agent(
        GUARD + where(l) + GATES +
        `On branch ${tri.branch}, for each issue below write the failing regression test(s) the plan calls for, in the right test module, following the project's testing rules in CLAUDE.md. ` +
        `Run them and confirm each fails on today's code for EXACTLY the reason the issue states — a failure for any other reason (import error, wrong fixture, a typo) does not count; fix the test until it fails for the right reason, or report reproduced=false; set behaviour_correct=true only if running the code showed the behaviour is in fact correct. ` +
        `Change NO production code. Leave the tests uncommitted in the worktree — the implementer builds on them.\nIssues:\n${brief(planned)}\nPlan:\n${tri.plan}`,
        { label: `reproduce:${l.key}`, phase: 'Verify', effort: EFF.verify, schema: REPRO_SCHEMA },
      ).then(r => ({ kind: 'repro', r })))
      // Skeptic lens: is the bug real and reachable at all?
      thunks.push(() => agent(
        GUARD + where(l) +
        `Read-only (edit nothing, change no git state). Try to REFUTE that each bug below is real in today's code at ${l.dir}: look for an upstream guard that already prevents it, a caller that never produces the triggering input, a recent commit that fixed it (git fetch origin, then git log -S / -G since the issue date on both HEAD and origin/${MAIN}, reading origin/${MAIN} with git show origin/${MAIN}:<path>), or a misread of the code. ` +
        `Set refuted=true only with concrete quoted code evidence; if the bug is real, refuted=false.\n${brief(planned)}`,
        { label: `skeptic:${l.key}`, phase: 'Verify', effort: EFF.verify, schema: REFUTE_SCHEMA },
      ).then(r => ({ kind: 'skeptic', r })))
    }
    // Two independent refuters per close verdict: a wrong close is public, so it needs both to fail.
    for (const lens of ['trace the issue\'s failure scenario through today\'s call path end to end', 'search for sibling sites and alternative inputs that still exhibit the bug'])
      if (closing.length) thunks.push(() => agent(
        GUARD + where(l) +
        `Read-only (edit nothing, change no git state). The bug-fix triage concluded each issue below is ALREADY FIXED (or its surface removed) and wants to close it. Try to REFUTE that: ${lens}. ` +
        `Fetch each issue body with gh issue view <n> --json body. Set refuted=true if the described behaviour (by intent, not literal line numbers) still occurs anywhere in origin/${MAIN} (git fetch origin, then read it with git show origin/${MAIN}:<path> / git grep <pattern> origin/${MAIN}), quoting the code; a fix present only in the working tree or in commits not on origin/${MAIN} does not count.\n${brief(closing)}`,
        { label: `refute-close:${l.key}`, phase: 'Verify', effort: EFF.verify, schema: REFUTE_SCHEMA },
      ).then(r => ({ kind: 'refute', r })))
    const checks = (await parallel(thunks)).filter(Boolean)
    const of = kind => checks.filter(c => c.kind === kind && c.r).flatMap(c => c.r.results)
    const repro = of('repro'), skeptic = of('skeptic')

    const confirmedBugs = [], confirmedFixed = [], reopened = []
    const needsHuman = [
      ...missing.map(n => ({ number: n, why: 'absent from triage output' })),
      ...conflicting.map(n => ({ number: n, why: 'conflicting triage verdicts' })),
      ...unclosable.map(i => ({ number: i.number, why: atMain ? 'close verdict missing close comment' : `close verdict judged in a worktree that differs from origin/${MAIN}` })),
      ...stalePlans.map(i => ({ number: i.number, why: `plan verdict judged in a worktree behind origin/${MAIN}` })),
    ]
    for (const i of planned) {
      const rep = repro.find(x => x.number === i.number)
      const sk = skeptic.find(x => x.number === i.number)
      // A reproduction is decisive; otherwise the bug survives only if the skeptic could not refute it.
      if (rep && rep.reproduced) confirmedBugs.push({ ...i, tests: rep.tests })
      else if (rep && rep.behaviour_correct) needsHuman.push({ number: i.number, why: 'reproducer ran the code and found the behaviour correct', repro: rep, skeptic: sk, tests: rep.tests || [] })
      else if (sk && !sk.refuted) confirmedBugs.push({ ...i, tests: [], unreproduced_tests: (rep && rep.tests) || [], unreported: !rep, note: 'not reproduced by a test; skeptic could not refute' })
      else needsHuman.push({ number: i.number, why: 'plan verdict neither reproduced nor survived the skeptic', repro: rep, skeptic: sk, tests: (rep && rep.tests) || [] })
    }
    // One vote per refuter report, never per result row, so a refuter listing an issue twice cannot stand in for two.
    const refuteReports = checks.filter(c => c.kind === 'refute' && c.r)
    for (const i of closing) {
      const votes = refuteReports.map(c => c.r.results.find(x => x.number === i.number)).filter(Boolean)
      if (votes.length < 2) needsHuman.push({ number: i.number, why: 'close verdict lacked two refuter reports' })
      else if (votes.some(v => v.refuted)) reopened.push({ ...i, refutations: votes.filter(v => v.refuted) })
      else confirmedFixed.push(i)
    }
    log(`${l.key}: ${confirmedBugs.length} confirmed bug(s), ${confirmedFixed.length} confirmed fixed, ${reopened.length} close verdict(s) refuted, ${needsHuman.length} for a human`)
    return { lane: l, tri, planned, missing, conflicting, confirmedBugs, confirmedFixed, reopened, needsHuman, skipped: [...triaged.filter(i => i.verdict === 'skip'), ...linked.map(i => ({ ...i, skip_reason: `linked_open_pr:${i.linked_open_pr}` }))] }
  },

  // ---- Close confirmed-fixed issues (with the race re-check), and fold refuted closes back into the plan
  async v => {
    if (!v.tri) return v
    const l = v.lane
    let plan = v.tri.plan
    if (v.reopened.length) {
      const r = await agent(
        GUARD + where(l) +
        `Read-only. The triage judged these issues fixed, but a refuter showed the bug still occurs:\n${JSON.stringify(v.reopened, null, 1)}\n` +
        `Rewrite the combined plan below so it also fixes them (failing regression test first, per-file edits, gates, a "Fixes #N" line each). Return the full plan.\n\n${plan || '(no plan yet)'}`,
        { label: `replan:${l.key}`, phase: 'Verify', effort: EFF.triage, schema: REPLAN_SCHEMA },
      )
      if (r && r.plan) { plan = r.plan; v.confirmedBugs.push(...v.reopened.map(i => ({ ...i, tests: [], note: 'reopened by a refuter' }))) }
      else v.needsHuman.push(...v.reopened.map(i => ({ number: i.number, why: 'close verdict refuted; re-plan failed' })))
    }
    let closed = { closed: [], not_closed: [] }
    if (v.confirmedFixed.length && A.close !== false) {
      closed = (await agent(
        GUARD + AUTH + where(l) +
        `Close each issue below as already fixed. Immediately before each close, re-check: gh issue view <n> --json state (skip it if no longer OPEN), and gh pr list --state open --search "<n> in:body" --json number,body — skip it if an open PR body has a closing keyword for it. ` +
        `Close with gh issue close <n> --reason completed --comment "$(cat <file>)" (gh issue close has no --comment-file flag), writing the comment (the triage's close comment, which quotes the evidence, with its closing "Closed by /bug-fix …" line replaced by — not followed by — "Auto-closed by /bug-fix after verifying intent against current ${MAIN}; two independent refuters found no remaining instance.") to a file in your scratchpad first. Change nothing else on the issue.\n` +
        JSON.stringify(v.confirmedFixed.map(i => ({ number: i.number, close_reason: i.close_reason, close_comment: i.close_comment })), null, 1),
        { label: `close:${l.key}`, phase: 'Close', effort: EFF.close, schema: CLOSE_SCHEMA },
      )) || { closed: [], not_closed: v.confirmedFixed.map(i => ({ number: i.number, reason: 'close stage failed' })) }
      if (closed.closed.length) log(`${l.key}: closed ${closed.closed.map(n => '#' + n).join(', ')}`)
    }
    return { ...v, plan, closed }
  },

  // ---- Ship the confirmed bugs through the shared engine
  async v => {
    if (!v.tri) return { lane: v.lane.key, status: v.status || 'failed_at_triage' }
    const l = v.lane
    const summary = {
      lane: l.key, branch: l.branch, dir: l.dir,
      closed: v.closed.closed, not_closed: v.closed.not_closed,
      confirmed_fixed_unclosed: A.close === false ? v.confirmedFixed.map(i => i.number) : [],
      needs_human: v.needsHuman, skipped: v.skipped.map(i => ({ number: i.number, reason: i.skip_reason })),
      bugs: v.confirmedBugs.map(i => ({ number: i.number, tests: i.tests, note: i.note })),
    }
    const humanTests = v.needsHuman.flatMap(h => h.tests || [])
    // Triage edits nothing and the other checks are read-only, so a test file dirty now but not at setup is the reproducer's;
    // one already dirty at setup (a kept worktree) holds earlier work and is never touched.
    const baseline = v.tri.baseline_dirty || []
    const before = `Before the reproducer ran, git status --porcelain --untracked-files=all in the worktree read: ${baseline.length ? JSON.stringify(baseline) : '(clean)'}. `
    const sparing = before + `Never touch a file listed there (or under a directory listed there); report a test in such a file as unresolved instead. `
    // For the implementer the guard limits only its deletions: the plan's own edits may well target a file that was dirty at setup.
    const deleteSparing = baseline.length ? ' ' + before + 'When deleting these tests, do not delete or revert anything in a file listed there or under a directory listed there (it holds work from before this run); leave such a test in place and say so in your summary. This does not restrict the plan\'s edits.' : ''
    if (!v.confirmedBugs.length) {
      // Nothing reaches an implementer, so nobody else removes the reproducer's uncommitted tests, and a re-run keeps the worktree.
      // The reproducer ran whenever a plan verdict existed, even if it reported no test ids (it may have failed after writing them).
      if (!v.planned.length) return { ...summary, status: 'nothing_to_ship' }
      const c = await agent(
        GUARD + where(l) +
        `A reproducer wrote regression tests in this worktree for ${v.planned.map(i => '#' + i.number).join(', ')}, none of which will ship. Remove them. ` +
        `Recorded test ids: ${humanTests.join(', ') || 'none (the reproducer may have failed before reporting)'}. ` + sparing +
        `Every other test file that git status now shows as changed was changed only by the reproducer: git restore it if tracked, delete it if untracked. ` +
        `Change nothing else and commit nothing. ` +
        `Report each test you could not resolve as unresolved, then return git status --porcelain (run in ${l.dir}) verbatim as dirty, one line per entry.`,
        { label: `cleanup:${l.key}`, phase: 'Ship', effort: EFF.close, schema: CLEANUP_SCHEMA },
      )
      if (!c) { log(`${l.key}: cleanup failed; reproducer tests may remain uncommitted in ${l.dir}`); return { ...summary, status: 'nothing_to_ship', cleanup_failed: true, uncommitted_tests: humanTests } }
      return { ...summary, status: 'nothing_to_ship', dirty: c.dirty, unresolved_tests: c.unresolved }
    }
    // Only the confirmed bugs are claimed fixed; a dropped issue's plan section is removed by the implementer.
    const kept = v.confirmedBugs.map(i => i.number)
    // Every issue the triage plan may cover but this PR will not claim: unconfirmed or already-linked plan verdicts, out-of-lane verdicts, lane issues triage left out or contradicted.
    const dropped = [...new Set([...v.tri.issues.filter(i => i.verdict === 'plan').map(i => i.number), ...v.missing, ...v.conflicting])].filter(n => !kept.includes(n))
    const concern = `Fix ${v.confirmedBugs.map(i => `#${i.number} (${i.title})`).join('; ')}`
    const tests = v.confirmedBugs.flatMap(i => i.tests)
    // Tests the reproducer wrote but could not make fail for the stated reason stay uncommitted; they must not ship.
    const unreproduced = v.confirmedBugs.flatMap(i => i.unreproduced_tests || [])
    // The reproducer may have written tests and then failed to report them; nothing else names those files to the implementer.
    const unreported = v.confirmedBugs.filter(i => i.unreported).map(i => i.number)
    // Their cleanup is scoped by file: the kept tests' files may also hold fixtures and helpers those tests need.
    const keptFiles = [...new Set(tests.map(t => t.split('::')[0]))]
    // Tests the implementer is told to delete but must spare because their file held earlier work; surfaced so a human can tidy them.
    const spared = [...unreproduced, ...(dropped.length ? humanTests : [])].filter(t => baseline.some(b => { const f = b.trim().replace(/^\S{1,2}\s+/, '').split(' -> ').pop().trim(); return t.split('::')[0] === f || (f.endsWith('/') && t.startsWith(f)) }))
    const planText = v.plan +
      (tests.length ? `\n\n## Regression tests already written (uncommitted in the worktree, failing on today's code — keep them; they must pass after the fix)\n${tests.map(t => '- ' + t).join('\n')}\n` : '') +
      (unreproduced.length ? `\n\nDELETE these tests the reproducer wrote but could not make fail for the issue's reason (uncommitted in the worktree; write the plan's regression tests afresh): ${unreproduced.join(', ')}.${deleteSparing}\n` : '') +
      (unreported.length ? `\n\nThe reproducer for ${unreported.map(n => '#' + n).join(', ')} may have left uncommitted tests it never reported: delete any uncommitted change to a test file outside ${keptFiles.length ? `the files holding the tests listed above as already written (${keptFiles.join(', ')}); inside those files remove only test functions not listed, keeping every fixture, helper and import the listed tests use, and never remove a conftest or helper change a listed test depends on` : 'nothing already written (no tests were listed)'}. Then write the plan's regression tests afresh.${deleteSparing}\n` : '') +
      (dropped.length ? `\n\nOUT OF SCOPE: drop the plan sections for ${dropped.map(n => '#' + n).join(', ')} (not confirmed), delete any regression test written for them (${humanTests.join(', ') || 'none recorded; the reproducer may have failed before reporting, so check the test files for uncommitted ones written for them'}), and do not claim to fix them.${deleteSparing}\n` : '')
    let r = null
    try {
      const answers = laneAnswers(l.key)
      r = await workflow('plan-to-merged-pr', {
        ...SHARED,
        ...(answers.length ? { answers } : {}),
        concern,
        plan_text: planText,
        dir: l.dir,
        branch: l.branch,
        pr_note: kept.map(n => `Fixes #${n}`).join('\n'),
      })
    } catch (err) {
      log(`${l.key}: ${err && err.message ? err.message : err}`)
    }
    const status = (r && r.status) || 'failed'
    log(`${l.key}: ${status}${r && r.pr ? ` (${r.pr.url})` : ''}`)
    const questions = status === 'needs_input' ? ((r && r.questions) || []).map(q => ({ lane: l.key, ...q })) : []
    return { ...summary, status, spared_tests: spared, pr: r && r.pr, review_clean: r && r.review_clean, polish_clean: r && r.polish_clean, final_state: r && r.final_state,
      ...(questions.length ? { questions, relay: RELAY } : {}) }
  },
)

const dropped = lanes.filter((_, i) => !results[i]).map(l => l.key)
if (dropped.length) log(`Lanes that failed outright: ${dropped.join(', ')}`)
return results.map((r, i) => r || { lane: lanes[i].key, status: 'failed' })

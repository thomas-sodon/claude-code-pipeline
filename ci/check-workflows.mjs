// Static checks for Claude Code workflow scripts.
// A workflow file is an ES module body that exports `meta` and then runs at top level (top-level await and a
// top-level `return`), so `node --check` alone rejects it. Compile each body as an async function instead, then
// check the rules the runtime enforces only when a run reaches them:
//   - meta is a pure literal with name (matching the file name), description, whenToUse and phases;
//   - every literal phase title (phase('X'), or { phase: 'X' } in agent options) is listed in meta.phases;
//   - no clock or random calls (they would break resume);
//   - workflow('x') names a workflow in this directory that does not itself call workflow() (one level of nesting).
// ci/workflows.test.mjs runs each script's control flow with stubbed agents (ci/harness.mjs).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { compile, readMeta } from './harness.mjs'

const dir = process.argv[2] || '.claude/workflows'
const files = readdirSync(dir).filter(f => f.endsWith('.js'))
if (!files.length) { console.error(`no workflow files in ${dir}`); process.exit(1) }

// Comments may name what the code must not call: drop whole-line and block comments before matching code.
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const NONDETERMINISTIC = [
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/\bnew\s+Date\s*\(\s*\)/, 'new Date() without arguments'],
  [/\bMath\.random\s*\(/, 'Math.random()'],
  [/\bperformance\.now\s*\(/, 'performance.now()'],
  [/\bcrypto\.randomUUID\s*\(/, 'crypto.randomUUID()'],
]
const sources = Object.fromEntries(files.map(f => [f.slice(0, -3), readFileSync(join(dir, f), 'utf8')]))
const childrenOf = src => [...code(src).matchAll(/\bworkflow\(\s*(['"`])([^'"`]+)\1/g)].map(m => m[2])
const callsWorkflow = src => /\bworkflow\(/.test(code(src))

let failed = 0
for (const f of files) {
  const name = f.slice(0, -3)
  const src = sources[name]
  const problems = []
  try {
    compile(src)
    const { text, value: meta } = readMeta(src)
    if (/\$\{|\.\.\.|`/.test(text)) problems.push('meta must be a pure literal: no template literal, interpolation or spread')
    for (const k of ['name', 'description', 'whenToUse', 'phases']) if (!meta[k]) problems.push(`meta.${k} missing`)
    if (meta.name !== name) problems.push(`meta.name ${meta.name} does not match the file name`)
    const titles = new Set((meta.phases || []).map(p => p.title))
    const body = code(src.slice(src.indexOf(text) + text.length))
    for (const m of body.matchAll(/\bphase(?:\(\s*|:\s*)(['"`])([^'"`]+)\1/g)) {
      if (!titles.has(m[2])) problems.push(`phase "${m[2]}" is not listed in meta.phases`)
    }
    for (const [re, what] of NONDETERMINISTIC) if (re.test(body)) problems.push(`${what} is not available in workflow scripts (it would break resume)`)
    for (const child of childrenOf(src)) {
      if (!sources[child]) problems.push(`workflow('${child}') names no workflow in ${dir}`)
      else if (callsWorkflow(sources[child])) problems.push(`workflow('${child}') runs a workflow that itself calls workflow(): nesting is one level only`)
    }
  } catch (err) {
    problems.push(err.message)
  }
  if (problems.length) {
    failed++
    for (const p of problems) console.error(`FAIL ${f}: ${p}`)
  } else {
    console.log(`ok   ${f}`)
  }
}
process.exit(failed ? 1 : 0)

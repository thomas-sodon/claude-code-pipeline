// Syntax check for Claude Code workflow scripts.
// A workflow file is an ES module body that exports `meta` and then runs at top level
// (top-level await and a top-level `return`), so `node --check` alone rejects it.
// Compile each body as an async function instead, and validate `meta`.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || '.claude/workflows'
const AsyncFunction = (async () => {}).constructor
const GLOBALS = ['args', 'agent', 'parallel', 'pipeline', 'workflow', 'phase', 'log']
let failed = 0
const files = readdirSync(dir).filter(f => f.endsWith('.js'))
if (!files.length) { console.error(`no workflow files in ${dir}`); process.exit(1) }
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8')
  try {
    if (!/^export const meta = \{/m.test(src)) throw new Error('missing `export const meta = {`')
    const body = src.replace(/^export const meta = /m, 'const meta = ') + '\n;'
    new AsyncFunction(...GLOBALS, body)
    const meta = new Function(src.match(/^export const meta = (\{[\s\S]*?\n\})/m)[1].replace(/^/, 'return '))()
    for (const k of ['name', 'description', 'whenToUse', 'phases']) if (!meta[k]) throw new Error(`meta.${k} missing`)
    if (`${meta.name}.js` !== f) throw new Error(`meta.name ${meta.name} does not match file name`)
    console.log(`ok   ${f}`)
  } catch (err) {
    failed++
    console.error(`FAIL ${f}: ${err.message}`)
  }
}
process.exit(failed ? 1 : 0)

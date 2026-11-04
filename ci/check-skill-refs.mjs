// Cross-check workflow scripts against the commands they drive.
// Every `skill "<name>"` a workflow invokes must exist as .claude/commands/<name>.md, and every --flag the workflow
// passes in that call's args must be documented in the command's file. A workflow handing a skill a flag the skill
// does not know makes the skill stop with error=invalid_argument, which no syntax check catches.
//
// The args are read from the text right after the skill name: `with args "<...>"`, `and args "<...>"`, or
// `with args ${JSON.stringify(`<...>`)}`. A simple ${IDENT} inside them is resolved through `const IDENT = ...`
// in the same file, so flags built in a constant (e.g. const OUT_FLAG = ` --out=...`) are checked too.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const wfDir = process.argv[2] || '.claude/workflows'
const cmdDir = process.argv[3] || '.claude/commands'
const FLAG = /--[a-z][a-z-]*/g
let failed = 0
const fail = msg => { failed++; console.error(`FAIL ${msg}`) }

function constText(src, ident) {
  // the constant's statement ends at the next line that starts another statement (or a blank line)
  const m = src.match(new RegExp(`^\\s*const ${ident} = ([\\s\\S]*?)\\n(?=\\s*(?:const |let |var |if |for |return |\\/\\/|\\}|\\n))`, 'm'))
  return m ? m[1] : ''
}
function argsRegion(rest) {
  const m = rest.match(/^\s*(?:with|and)\s+args\s*:?\s*/)
  if (!m) return ''
  const after = rest.slice(m[0].length)
  if (after.startsWith('"')) {
    const end = after.indexOf('"', 1)
    return end > 0 ? after.slice(1, end) : ''
  }
  if (after.startsWith('${JSON.stringify(')) {
    const end = after.indexOf(')}')
    return end > 0 ? after.slice('${JSON.stringify('.length, end) : ''
  }
  return ''
}
function flagsIn(src, text, depth = 0) {
  const flags = new Set(text.match(FLAG) || [])
  if (depth < 3) {
    for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      for (const f of flagsIn(src, constText(src, m[1]), depth + 1)) flags.add(f)
    }
  }
  return flags
}

const files = readdirSync(wfDir).filter(f => f.endsWith('.js'))
let calls = 0
for (const f of files) {
  const src = readFileSync(join(wfDir, f), 'utf8')
  for (const m of src.matchAll(/skill "([a-z][a-z0-9-]*)"/g)) {
    calls++
    const name = m[1]
    const cmd = join(cmdDir, `${name}.md`)
    const line = src.slice(0, m.index).split('\n').length
    if (!existsSync(cmd)) { fail(`${f}:${line}: invokes skill "${name}", but ${cmd} does not exist`); continue }
    const doc = readFileSync(cmd, 'utf8')
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 400)
    for (const flag of flagsIn(src, argsRegion(rest))) {
      if (!new RegExp(`${flag}(?![a-z-])`).test(doc)) fail(`${f}:${line}: passes ${flag} to skill "${name}", which ${cmd} does not document`)
    }
  }
}
if (!calls) fail(`no skill invocations found in ${wfDir}`)
if (!failed) console.log(`ok   ${calls} skill invocations in ${files.length} workflows match ${cmdDir}`)
process.exit(failed ? 1 : 0)

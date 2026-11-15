// Cross-check workflow scripts against the commands they drive.
// Every `skill "<name>"` a workflow invokes must exist as .claude/commands/<name>.md, and every --flag the workflow
// passes in that call's args must be documented in the command's file. A workflow handing a skill a flag the skill
// does not know makes the skill stop with error=invalid_argument, which no syntax check catches.
//
// A workflow that tells a stage how to ask (its prompt carries the QUESTIONS rule: ASK(...) or ASK_RULE) relies on the skill
// to stop with error=needs_input and print its questions when no one can answer. So every skill invoked in such a prompt
// must define that stop in its command file.
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

// Whether the prompt a skill invocation belongs to carries the questions rule. The prompt is the agent( call that holds the
// invocation: its text from `agent(` to the invocation. An invocation written in a constant (const X = ...) declared after the
// last agent( call belongs to every agent( call whose prompt, up to its options, uses X.
const ASKS = /\bASK(_RULE\b|\()/
function promptAsks(src, index) {
  const before = src.slice(0, index)
  const call = before.lastIndexOf('agent(')
  const decls = [...before.matchAll(/^\s*(?:const|let) ([A-Za-z_][A-Za-z0-9_]*) = /gm)]
  const decl = decls[decls.length - 1]
  if (decl && decl.index > call) {
    const used = new RegExp(`\\b${decl[1]}\\b`)
    return [...src.matchAll(/agent\(/g)].some(m => {
      const prompt = src.slice(m.index, m.index + 4000).split(/\n\s*(?:opts\(|\{ label:)/)[0]
      return used.test(prompt) && ASKS.test(prompt)
    })
  }
  return call >= 0 && ASKS.test(src.slice(call, index))
}

const files = readdirSync(wfDir).filter(f => f.endsWith('.js'))
let calls = 0, asking = 0
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
    if (promptAsks(src, m.index)) {
      asking++
      if (!doc.includes('error=needs_input')) fail(`${f}:${line}: tells the stage that invokes skill "${name}" how to ask, but ${cmd} defines no error=needs_input stop`)
    }
  }
}
if (!calls) fail(`no skill invocations found in ${wfDir}`)
if (!asking) fail(`no skill invocation in ${wfDir} sits in a prompt with the questions rule: the check for error=needs_input found nothing to check`)
if (!failed) console.log(`ok   ${calls} skill invocations in ${files.length} workflows match ${cmdDir} (${asking} in prompts that can ask: each command defines error=needs_input)`)
process.exit(failed ? 1 : 0)

// Stub runtime for Claude Code workflow scripts. It runs a script's control flow with scripted agents instead of
// real ones, so CI exercises every branch of a workflow without spending tokens, and it enforces the rules the
// real runtime only enforces when a run reaches them: phase titles listed in meta.phases, schemas the
// StructuredOutput tool accepts (and stub replies that match them), one level of workflow() nesting, and no
// Date.now() / Math.random() / argless new Date().
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'workflows')
export const GLOBALS = ['args', 'agent', 'parallel', 'pipeline', 'workflow', 'phase', 'log', 'budget']
const AsyncFunction = (async () => {}).constructor

// A broken rule or a stub mismatch. It fails the test even inside parallel() / pipeline(), which turn an
// ordinary throw into a null result the way the runtime does.
export class HarnessError extends Error {}

export function readMeta(src) {
  const m = src.match(/^export const meta = (\{[\s\S]*?\n\})/m)
  if (!m) throw new HarnessError('missing `export const meta = {`')
  return { text: m[1], value: new Function(`return ${m[1]}`)() }
}

// The script body as the runtime runs it: top-level await and return, the runtime's globals as parameters, and
// Date / Math shadowed by versions whose nondeterministic calls throw.
export function compile(src) {
  const body = src.replace(/^export const meta = /m, 'const meta = ') + '\n;'
  return new AsyncFunction(...GLOBALS, 'Date', 'Math', body)
}

const unavailable = what => () => { throw new HarnessError(`${what} is not available in workflow scripts (it would break resume)`) }
const SafeMath = Object.create(Math, { random: { value: unavailable('Math.random()') } })
const SafeDate = new Proxy(Date, {
  construct(target, argv, newTarget) {
    if (!argv.length) unavailable('new Date() without arguments')()
    return Reflect.construct(target, argv, newTarget)
  },
  apply: unavailable('Date()'),
  get(target, key, receiver) { return key === 'now' ? unavailable('Date.now()') : Reflect.get(target, key, receiver) },
})

// The StructuredOutput tool needs {type: 'object', properties} at the root and required ⊆ properties at every level.
export function checkSchema(schema, where) {
  if (!schema || schema.type !== 'object' || !schema.properties) throw new HarnessError(`${where}: a schema needs {type: 'object', properties} at its root`)
  const walk = (s, path) => {
    if (!s || typeof s !== 'object') throw new HarnessError(`${where}: ${path} is not a schema`)
    if (s.type === 'object' && s.properties) {
      for (const r of s.required || []) if (!(r in s.properties)) throw new HarnessError(`${where}: ${path} requires "${r}", which it does not define`)
      for (const [k, sub] of Object.entries(s.properties)) walk(sub, `${path}.${k}`)
    }
    if (s.type === 'array' && s.items) walk(s.items, `${path}[]`)
  }
  walk(schema, '$')
}

// Enough JSON Schema to hold a stub reply to the shape the script asked for.
export function validate(value, schema) {
  const errors = []
  const check = (x, s, p) => {
    if (s.enum && !s.enum.includes(x)) errors.push(`${p}: ${JSON.stringify(x)} is not one of ${JSON.stringify(s.enum)}`)
    if (typeof x === 'number' && s.minimum !== undefined && x < s.minimum) errors.push(`${p}: below ${s.minimum}`)
    if (typeof x === 'number' && s.maximum !== undefined && x > s.maximum) errors.push(`${p}: above ${s.maximum}`)
    switch (s.type) {
      case 'object':
        if (!x || typeof x !== 'object' || Array.isArray(x)) { errors.push(`${p}: expected an object`); return }
        for (const r of s.required || []) if (x[r] === undefined) errors.push(`${p}.${r}: required`)
        for (const [k, sub] of Object.entries(s.properties || {})) if (x[k] !== undefined) check(x[k], sub, `${p}.${k}`)
        return
      case 'array':
        if (!Array.isArray(x)) { errors.push(`${p}: expected an array`); return }
        if (s.minItems !== undefined && x.length < s.minItems) errors.push(`${p}: fewer than ${s.minItems} items`)
        if (s.maxItems !== undefined && x.length > s.maxItems) errors.push(`${p}: more than ${s.maxItems} items`)
        if (s.items) x.forEach((e, i) => check(e, s.items, `${p}[${i}]`))
        return
      case 'string': if (typeof x !== 'string') errors.push(`${p}: expected a string`); return
      case 'integer': if (!Number.isInteger(x)) errors.push(`${p}: expected an integer`); return
      case 'number': if (typeof x !== 'number') errors.push(`${p}: expected a number`); return
      case 'boolean': if (typeof x !== 'boolean') errors.push(`${p}: expected a boolean`)
    }
  }
  check(value, schema, '$')
  return errors
}

const noAgent = call => { throw new HarnessError(`unexpected agent "${call.label}"`) }

// Run the workflow `name` with `args` and return its trace: { result, calls, logs, phases, children }.
//   opts.agent(call)    answers each agent() call, given { workflow, prompt, label, phase, effort, schema, index }:
//                       the structured reply, or null for an agent that died. undefined (no stub) fails the test.
//   opts.workflow(name, args, ctx)   answers workflow() calls; ctx.run(name, args) runs the real child script
//                       with the same stubs, one level down.
export async function run(name, args, opts = {}) {
  const depth = opts.depth || 0
  const src = readFileSync(join(opts.dir || WORKFLOWS, `${name}.js`), 'utf8')
  const meta = readMeta(src).value
  if (meta.name !== name) throw new HarnessError(`${name}.js: meta.name is ${meta.name}`)
  const titles = new Set((meta.phases || []).map(p => p.title))
  const trace = { result: undefined, calls: [], logs: [], phases: [], children: [] }
  let current = null
  const listed = (title, what) => { if (!titles.has(title)) throw new HarnessError(`${name}: ${what} uses phase "${title}", which meta.phases does not list`) }

  const agent = async (prompt, o = {}) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HarnessError(`${name}: agent "${o.label}" needs a prompt string`)
    const phase = o.phase || current
    if (phase) listed(phase, `agent "${o.label}"`)
    if (o.schema) checkSchema(o.schema, `${name}: agent "${o.label}"`)
    const call = { workflow: name, prompt, label: o.label, phase, effort: o.effort, schema: o.schema, index: trace.calls.length }
    trace.calls.push(call)
    let out
    try { out = await (opts.agent || noAgent)(call) } catch (err) {
      throw err instanceof HarnessError ? err : new HarnessError(`${name}: the stub for "${o.label}" threw: ${err.message}`)
    }
    if (out === undefined) throw new HarnessError(`${name}: no stub answered "${o.label}"`)
    if (out !== null && o.schema) {
      const errors = validate(out, o.schema)
      if (errors.length) throw new HarnessError(`${name}: the stub for "${o.label}" does not match its schema: ${errors.join('; ')}`)
    }
    return out
  }
  const swallow = err => { if (err instanceof HarnessError) throw err; return null }
  const parallel = thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(swallow)))
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let prev = item
    for (const stage of stages) {
      try { prev = await stage(prev, item, i) } catch (err) { return swallow(err) }
    }
    return prev
  }))
  const workflow = async (child, childArgs) => {
    if (depth > 0) throw new HarnessError(`${name}: workflow("${child}") inside a child workflow — nesting is one level only`)
    trace.children.push({ name: child, args: childArgs })
    if (!opts.workflow) throw new HarnessError(`${name}: unexpected workflow("${child}")`)
    // A real child's agent calls and log lines join this trace (each call keeps its `workflow` name).
    const runChild = (n, a) => run(n, a, { ...opts, depth: depth + 1 }).then(t => {
      trace.calls.push(...t.calls)
      trace.logs.push(...t.logs)
      return t.result
    })
    return opts.workflow(child, childArgs, { run: runChild })
  }
  const phase = title => { listed(title, 'phase()'); current = title; trace.phases.push(title) }
  const log = message => { trace.logs.push(String(message)) }
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }

  trace.result = await compile(src)(args, agent, parallel, pipeline, workflow, phase, log, budget, SafeDate, SafeMath)
  return trace
}

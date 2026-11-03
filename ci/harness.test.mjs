// The harness's own rules, shown to fire on small scripts that break them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './harness.mjs'

const SCHEMA = `{ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }`
const withScripts = async (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'))
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, `${name}.js`), `export const meta = {\n  name: '${name}',\n  description: 'd',\n  whenToUse: 'w',\n  phases: [{ title: 'Build' }],\n}\n${body}`)
    }
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a stub reply that does not match the schema fails, even inside parallel()', () => withScripts({
  a: `return parallel([() => agent('go', { label: 'x', schema: ${SCHEMA} })])\n`,
}, async dir => {
  await assert.rejects(run('a', {}, { dir, agent: () => ({ n: 'one' }) }), /does not match its schema: \$\.n: expected an integer/)
  const ok = await run('a', {}, { dir, agent: () => ({ n: 1 }) })
  assert.deepEqual(ok.result, [{ n: 1 }])
}))

test('a dead agent (null) reaches the script; an ordinary throw in parallel() becomes null', () => withScripts({
  a: `const r = await agent('go', { label: 'x', schema: ${SCHEMA} })\nconst p = await parallel([() => { throw new Error('boom') }])\nreturn { r, p }\n`,
}, async dir => {
  const t = await run('a', {}, { dir, agent: () => null })
  assert.deepEqual(t.result, { r: null, p: [null] })
}))

test('a schema the StructuredOutput tool would reject fails', () => withScripts({
  a: `return agent('go', { label: 'x', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } })\n`,
  b: `return agent('go', { label: 'x', schema: { type: 'array', items: { type: 'string' } } })\n`,
}, async dir => {
  await assert.rejects(run('a', {}, { dir, agent: () => ({ a: 'x' }) }), /requires "b", which it does not define/)
  await assert.rejects(run('b', {}, { dir, agent: () => [] }), /needs \{type: 'object', properties\} at its root/)
}))

test('an unlisted phase, a clock call and a nested workflow() fail at run time', () => withScripts({
  phased: `phase('Ship')\n`,
  dynamic: `const p = 'Sh' + 'ip'\nawait agent('go', { label: 'x', phase: p })\n`,
  clock: `return [1].map(() => Date.now())\n`,
  random: `return Math.random()\n`,
  top: `return workflow('mid')\n`,
  mid: `return workflow('leaf')\n`,
}, async dir => {
  await assert.rejects(run('phased', {}, { dir }), /uses phase "Ship", which meta.phases does not list/)
  await assert.rejects(run('dynamic', {}, { dir, agent: () => 'ok' }), /uses phase "Ship"/)
  await assert.rejects(run('clock', {}, { dir }), /Date\.now\(\) is not available/)
  await assert.rejects(run('random', {}, { dir }), /Math\.random\(\) is not available/)
  await assert.rejects(run('top', {}, { dir, workflow: (n, a, ctx) => ctx.run(n, a) }), /nesting is one level only/)
}))

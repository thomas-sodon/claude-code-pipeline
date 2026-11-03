// Each static rule in check-workflows.mjs, shown to fire on a workflow that breaks it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'check-workflows.mjs')
const meta = (name, extra = '') => `export const meta = {\n  name: '${name}',\n  description: 'd',\n  whenToUse: 'w',\n  phases: [{ title: 'Build' }],${extra}\n}\n`
const check = files => {
  const dir = mkdtempSync(join(tmpdir(), 'workflows-'))
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, `${name}.js`), body)
    const r = spawnSync(process.execPath, [CHECK, dir], { encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a workflow that follows every rule passes', () => {
  const r = check({
    ok: meta('ok') + `// Date.now() in a comment is fine\nphase('Build')\nconst r = await agent('go', { phase: 'Build', label: 'x' })\nreturn workflow('leaf', { r })\n`,
    leaf: meta('leaf') + `phase('Build')\nreturn 1\n`,
  })
  assert.equal(r.code, 0, r.out)
})

test('a phase title missing from meta.phases fails', () => {
  assert.match(check({ a: meta('a') + `phase('Ship')\n` }).out, /phase "Ship" is not listed/)
  assert.match(check({ a: meta('a') + `await agent('go', { phase: 'Ship' })\n` }).out, /phase "Ship" is not listed/)
})

test('clock and random calls fail', () => {
  assert.match(check({ a: meta('a') + `const t = Date.now()\n` }).out, /Date\.now\(\) is not available/)
  assert.match(check({ a: meta('a') + `const t = new Date()\n` }).out, /new Date\(\) without arguments/)
  assert.match(check({ a: meta('a') + `const t = Math.random()\n` }).out, /Math\.random\(\) is not available/)
  assert.equal(check({ a: meta('a') + `const t = new Date('2026-01-01')\n` }).code, 0)
})

test('nested and unknown workflow() calls fail', () => {
  const nested = check({
    top: meta('top') + `return workflow('mid')\n`,
    mid: meta('mid') + `return workflow('leaf')\n`,
    leaf: meta('leaf') + `return 1\n`,
  })
  assert.match(nested.out, /FAIL top\.js: workflow\('mid'\) runs a workflow that itself calls workflow\(\)/)
  assert.match(check({ a: meta('a') + `return workflow('nope')\n` }).out, /workflow\('nope'\) names no workflow/)
})

test('meta must be a pure literal named after its file', () => {
  assert.match(check({ a: meta('a', "\n  extra: `x${1}`,") }).out, /meta must be a pure literal/)
  assert.match(check({ a: meta('b') }).out, /meta\.name b does not match the file name/)
  assert.match(check({ a: `export const meta = { name: 'a', description: 'd', phases: [] }\n` }).out, /missing `export const meta = \{`|meta\.whenToUse missing/)
})

test('a script that does not compile fails', () => {
  assert.match(check({ a: meta('a') + `const x = ;\n` }).out, /FAIL a\.js/)
})

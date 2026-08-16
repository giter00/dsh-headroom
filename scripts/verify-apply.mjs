/**
 * dsh-headroom integration smoke test against the real @deepseek-ai/dsh-tools.
 *
 * This script needs the harness packages to be resolvable (for example by
 * pointing `node_modules` at a dsh checkout). It exercises the actual plugin
 * `apply()` surface with a minimal mock ctx and proves:
 *
 *   - `tools/post-execute` listener is installed
 *   - a large grep output is compressed and carries a CCR marker
 *   - `headroom_retrieve` returns the exact original
 *   - excluded / own / code / error / short outputs are left unchanged
 *
 * Run: node scripts/verify-apply.mjs
 */

import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const listeners = {}
const defs = []
let cleanup = null
const ctx = {
  logger: console,
  on(name, fn) { (listeners[name] ??= []).push(fn); return () => true },
  effect(fn) { cleanup = fn(); return { dispose() { cleanup?.() } } },
  tools: {
    register(def) { defs.push(def); return () => true }
  }
}

await apply(ctx, { minChars: 120, ccr: { persist: false }, excludeTools: ['fs-*'] })

assert.ok(listeners['tools/post-execute']?.length >= 1, 'post-execute listener must be installed')
const toolNames = defs.map((def) => def.name)
assert.deepEqual(toolNames, ['headroom_retrieve', 'headroom_compress', 'headroom_stats'])

const post = listeners['tools/post-execute'][0]
const accept = async () => ({ kind: 'accept' })

// 1) Large grep output must be compressed and retrievable.
const grepLines = Array.from({ length: 200 }, (_, index) => `src/server.ts:${index + 1}: TODO(${index}) replace this temporary implementation with the real provider call`).join('\n')
const grepResult = { isError: false, content: [{ type: 'text', text: grepLines }], additionalContexts: [] }
const grepDecision = await post({ name: 'grep', callId: 'call-grep', agent: { id: 'session-1' } }, grepResult, accept)

assert.equal(grepDecision.kind, 'accept')
assert.ok(grepDecision.content[0].text.length < grepLines.length, 'grep output should shrink')
assert.match(grepDecision.content[0].text, /headroom_retrieve\(id="hr:/, 'grep output should carry a CCR marker')

const retrieve = defs.find((def) => def.name === 'headroom_retrieve')
const markerMatch = grepDecision.content[0].text.match(/id="(hr:[^"]+)"/)
assert.ok(markerMatch, 'marker must contain a retrieval id')
const retrieved = await retrieve.execute({ id: markerMatch[1] })
assert.equal(retrieved.found, true)
assert.equal(retrieved.content, grepLines, 'retrieved original must be byte-identical to the pre-compression text')

/** Mirror dsh-tools postExecute materialization: a decision without `content` keeps `result.content`. */
function materializedContent(decision, result) {
  return decision.content ?? result.content
}

// 2) Excluded tool must be untouched.
const fsResult = { isError: false, content: [{ type: 'text', text: 'long '.repeat(300) }], additionalContexts: [] }
const fsDecision = await post({ name: 'fs-read-file', callId: 'call-fs', agent: { id: 'session-1' } }, fsResult, accept)
assert.equal(materializedContent(fsDecision, fsResult)[0].text, fsResult.content[0].text, 'excluded tools must not be compressed')

// 3) dsh-headroom's own tools must be untouched.
const ownResult = { isError: false, content: [{ type: 'text', text: 'long '.repeat(300) }], additionalContexts: [] }
const ownDecision = await post({ name: 'headroom_stats', callId: 'call-own', agent: { id: 'session-1' } }, ownResult, accept)
assert.equal(materializedContent(ownDecision, ownResult)[0].text, ownResult.content[0].text, 'own tools must not be compressed')

// 4) Code output must be untouched (JS port never lossy-compresses code).
const codeText = `export function render(state: State): string {\n${'  return state.items.map((item) => item.label).join(', ')\n'.repeat(30)}}\n`
const codeResult = { isError: false, content: [{ type: 'text', text: codeText }], additionalContexts: [] }
const codeDecision = await post({ name: 'fs-read-file', callId: 'call-code', agent: { id: 'session-1' } }, codeResult, accept)
assert.equal(materializedContent(codeDecision, codeResult)[0].text, codeText, 'code output must be left unchanged')

// 5) Error output must be untouched by default.
const errorResult = { isError: true, content: [{ type: 'text', text: 'long '.repeat(300) }], additionalContexts: [] }
const errorDecision = await post({ name: 'grep', callId: 'call-error', agent: { id: 'session-1' } }, errorResult, accept)
assert.equal(materializedContent(errorDecision, errorResult)[0].text, errorResult.content[0].text, 'error output must be left unchanged by default')

// 6) Short output must be untouched.
const shortResult = { isError: false, content: [{ type: 'text', text: 'ok' }], additionalContexts: [] }
const shortDecision = await post({ name: 'grep', callId: 'call-short', agent: { id: 'session-1' } }, shortResult, accept)
assert.equal(materializedContent(shortDecision, shortResult)[0].text, 'ok', 'short output must be left unchanged')

cleanup?.()
console.log('apply() integration checks passed against @deepseek-ai/dsh-tools.')

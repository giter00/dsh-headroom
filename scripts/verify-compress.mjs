/**
 * dsh-headroom compression verification:
 *  1) every lossy strategy must shrink the block (and keep the CCR marker)
 *  2) key facts must survive compression
 *  3) code / short / already-compressed text must pass through unchanged
 *  4) CCR retrieval must return the exact original
 *
 * Run: node scripts/verify-compress.mjs
 */

import assert from 'node:assert/strict'
import { createCcrStore } from '../lib/ccr.js'
import {
  compressTextBlock,
  detectContentType,
  estimateTokens,
  resolveLimits
} from '../lib/compress.js'

const limits = resolveLimits({
  minChars: 120,
  maxRows: 40,
  maxCellChars: 80,
  maxSearchMatchesPerFile: 15,
  maxLogLines: 40,
  maxTextChars: 400,
  maxTabularLines: 30
})

function makeJsonOutput() {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    file: `src/components/widget-${index}.tsx`,
    severity: index % 4 === 0 ? 'error' : index % 3 === 0 ? 'warning' : 'info',
    line: 10 + index,
    message: `The component failed to hydrate because the requested chunk was not available in the manifest and the fallback also failed for entry ${index}`,
    stack: `  at Widget.render (widget-${index}.tsx:${index + 10}:1)\n  at ReactFiber.workLoop (react.js:${index + 100}:5)`
  }))
  return JSON.stringify(rows)
}

function makeSearchOutput() {
  const files = ['src/api/server.ts', 'src/api/client.ts', 'src/db/query.ts']
  const lines = []
  for (let index = 0; index < 90; index += 1) {
    const file = files[index % files.length]
    lines.push(`${file}:${index + 1}:${index * 3}: TODO(${index}) - replace the temporary implementation with the real provider call for this code path`)
  }
  return lines.join('\n')
}

function makeLogOutput() {
  const lines = ['INFO  starting build for dsh-headroom']
  for (let index = 0; index < 80; index += 1) lines.push('INFO  worker processed item 0')
  for (let index = 0; index < 60; index += 1) lines.push('INFO  progress tick ' + index)
  lines.push('ERROR compilation failed: module not found')
  lines.push('WARN  falling back to legacy resolver')
  lines.push('INFO  build finished')
  return lines.join('\n')
}

function makeTabularOutput() {
  const rows = ['id,module,level,message,created_at']
  for (let index = 0; index < 200; index += 1) {
    rows.push(`${index},dsh-headroom-${index % 10},info,processed record number ${index} with a reasonably long message field,2026-01-${String((index % 28) + 1).padStart(2, '0')}`)
  }
  return rows.join('\n')
}

function makeProseOutput() {
  const fragments = [
    'The quick brown fox jumps over the lazy dog while the lazy dog sleeps.',
    'Context compression removes tokens that do not change the answer.',
    'A reversible store keeps the exact original bytes available on demand.',
    'Routing chooses a specialised compressor for each kind of content.',
    'JSON arrays pivot into compact row form with common fields hoisted.',
    'Search output folds repeated path prefixes into grouped match blocks.'
  ]
  const parts = []
  for (let index = 0; index < 180; index += 1) parts.push(`${index + 1}: ${fragments[index % fragments.length]}`)
  parts.push('NEEDLE-42: the exact original middle content that must be recoverable through CCR')
  for (let index = 180; index < 400; index += 1) parts.push(`${index + 1}: ${fragments[index % fragments.length]}`)
  return parts.join(' ')
}

function makeCodeOutput() {
  return `export function makeReducer(initialState: State): Reducer<State, Action> {
  const cache = new Map<string, unknown>()
  return function reducer(state: State = initialState, action: Action): State {
    switch (action.type) {
      case 'hydrate': {
        const next = { ...state, ...action.payload }
        cache.set('hydrate', next)
        return next
      }
      case 'reset': {
        cache.clear()
        return initialState
      }
      default:
        return state
    }
  }
}
`
}

const store = createCcrStore({ persist: false })
await store.init()

const samples = [
  { name: 'json-array-200', text: makeJsonOutput(), kind: 'json', mustChange: true, facts: ['_keys', '_count', 'error', 'widget-0'] },
  { name: 'search-270', text: makeSearchOutput(), kind: 'search', mustChange: true, facts: ['src/api/server.ts', 'omitted'] },
  { name: 'log-180', text: makeLogOutput(), kind: 'log', mustChange: true, facts: ['repeated', 'ERROR compilation failed', 'WARN'] },
  { name: 'tabular-201', text: makeTabularOutput(), kind: 'tabular', mustChange: true, facts: ['id,module,level,message,created_at', 'omitted'] },
  { name: 'prose-400', text: makeProseOutput(), kind: 'text', mustChange: true, facts: ['headroom_retrieve'], omittedFact: 'NEEDLE-42' },
  { name: 'code-js', text: makeCodeOutput(), kind: 'code', mustChange: false, facts: ['function reducer', 'switch'] },
  { name: 'short', text: 'just a small result', kind: 'text', mustChange: false, facts: ['just a small result'] }
]

let failures = 0
console.log('Compression benchmark (char-level; token estimate = chars/4):')
console.log('')
console.log('sample             kind      before   after    saved%   tokens_before tokens_after strategy')

for (const sample of samples) {
  const detected = detectContentType(sample.text)
  assert.equal(detected, sample.kind, `${sample.name}: expected kind ${sample.kind}, got ${detected}`)

  const outcome = compressTextBlock(sample.text, {
    limits,
    retrievalId: `hr:${sample.name}`,
    withMarker: true
  })

  if (sample.mustChange) {
    assert.equal(outcome.changed, true, `${sample.name}: expected compression to change the text`)
    assert.ok(outcome.compressedChars < outcome.originalChars, `${sample.name}: expected a size reduction`)
    assert.match(outcome.text, /headroom_retrieve\(id="hr:/, `${sample.name}: expected a CCR marker`)
  } else {
    assert.equal(outcome.changed, false, `${sample.name}: expected no compression`)
    assert.equal(outcome.text, sample.text, `${sample.name}: expected unchanged text`)
  }

  for (const fact of sample.facts) {
    assert.ok(outcome.text.includes(fact), `${sample.name}: compressed output must preserve fact "${fact}"`)
  }

  // CCR reversibility for every lossy compression
  if (outcome.changed) {
    if (sample.omittedFact) {
      assert.equal(outcome.text.includes(sample.omittedFact), false, `${sample.name}: omitted fact must NOT be in the compressed view`)
    }
    const id = `hr:${sample.name}`
    store.put({
      id,
      toolName: 'verify',
      callId: sample.name,
      sessionId: 'verify-session',
      strategy: outcome.strategy,
      originalChars: outcome.originalChars,
      compressedChars: outcome.compressedChars,
      originalText: sample.text
    })
    const entry = store.get(id)
    assert.equal(entry.originalText, sample.text, `${sample.name}: CCR must return the exact original`)
    if (sample.omittedFact) {
      assert.ok(entry.originalText.includes(sample.omittedFact), `${sample.name}: omitted fact must be recoverable through CCR`)
    }
  }

  const savedPct = ((outcome.originalChars - outcome.compressedChars) / outcome.originalChars) * 100
  console.log(
    `${sample.name.padEnd(18)} ${sample.kind.padEnd(8)} ${String(outcome.originalChars).padStart(7)} ${String(outcome.compressedChars).padStart(7)} ${savedPct.toFixed(1).padStart(7)} ${String(estimateTokens(sample.text)).padStart(7)} ${String(estimateTokens(outcome.text)).padStart(13)} ${outcome.strategy}`
  )
}

const stats = store.stats()
assert.equal(stats.compressedCalls, samples.filter((sample) => sample.mustChange).length)
assert.equal(store.get('hr:does-not-exist'), undefined)

console.log('')
console.log(`CCR store entries: ${stats.storeEntries}, retrievable original chars: ${stats.originalChars}`)
console.log('All verification checks passed.')

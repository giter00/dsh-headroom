import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compressContentBlocks,
  compressTextBlock,
  detectContentType,
  globToRegExp,
  resolveLimits,
  internals
} from '../lib/compress.js'

const limits = resolveLimits({ minChars: 80, maxRows: 10, maxCellChars: 40, maxSearchMatchesPerFile: 5, maxLogLines: 20, maxTextChars: 120, maxTabularLines: 20 })

test('globToRegExp matches * wildcards only', () => {
  assert.equal(globToRegExp('fs-*').test('fs-read'), true)
  assert.equal(globToRegExp('fs-*').test('grep'), false)
  assert.equal(globToRegExp('*.search').test('web.search'), true)
})

test('detectContentType routes JSON, search, log, code and text', () => {
  assert.equal(detectContentType('[{"a":1},{"a":2}]'), 'json')
  assert.equal(detectContentType('src/a.ts:10: const x = 1\nsrc/b.ts:20: const y = 2\nsrc/c.ts:30: const z = 3'), 'search')
  assert.equal(detectContentType('INFO start\nINFO work\nINFO done\nERROR boom'), 'log')
  assert.equal(detectContentType('function hello() {\n  return 1\n}\n'), 'code')
  assert.equal(detectContentType('just some plain prose here'), 'text')
})

test('JSON object rows are pivoted and compressed', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    file: `src/file-${index}.ts`,
    severity: index % 2 === 0 ? 'warn' : 'error',
    message: 'The quick brown fox jumps over the lazy dog ' + String(index).repeat(80)
  }))
  const original = JSON.stringify(rows)
  const outcome = compressTextBlock(original, { limits, retrievalId: 'hr:test', withMarker: true })
  assert.equal(outcome.changed, true)
  assert.ok(outcome.compressedChars < outcome.originalChars)
  assert.match(outcome.text, /headroom_retrieve\(id="hr:test"\)/)
  assert.match(outcome.text, /_keys/)
})

test('search results are folded by file', () => {
  const original = Array.from({ length: 40 }, (_, index) => `src/file.ts:${index + 1}: message number ${index}`).join('\n')
  const outcome = compressTextBlock(original, { limits, retrievalId: 'hr:search', withMarker: true })
  assert.equal(outcome.strategy, 'search-fold')
  assert.equal(outcome.changed, true)
  assert.ok(outcome.text.includes('src/file.ts (40 matches)'))
  assert.ok(outcome.text.includes('omitted'))
})

test('log output collapses repeated lines and keeps errors', () => {
  const lines = ['INFO start']
  for (let index = 0; index < 50; index += 1) lines.push('INFO progress tick')
  lines.push('ERROR fatal failure')
  const original = lines.join('\n')
  const outcome = compressTextBlock(original, { limits, retrievalId: 'hr:log', withMarker: true })
  assert.equal(outcome.strategy, 'log-fold')
  assert.equal(outcome.changed, true)
  assert.match(outcome.text, /repeated/)
  assert.match(outcome.text, /ERROR fatal failure/)
})

test('plain prose is truncated and marked', () => {
  const original = 'word '.repeat(200)
  const outcome = compressTextBlock(original, { limits, retrievalId: 'hr:text', withMarker: true })
  assert.equal(outcome.strategy, 'text-head/tail')
  assert.equal(outcome.changed, true)
  assert.ok(outcome.compressedChars < outcome.originalChars)
})

test('small text is left unchanged', () => {
  const original = 'small text'
  const outcome = compressTextBlock(original, { limits, retrievalId: 'hr:small', withMarker: true })
  assert.equal(outcome.changed, false)
  assert.equal(outcome.text, original)
})

test('compressContentBlocks only touches text blocks', () => {
  const original = 'long '.repeat(300)
  const blocks = [
    { type: 'text', text: original },
    { type: 'image', attachment: 'not touched' }
  ]
  const result = compressContentBlocks(blocks, { limits, retrievalId: 'hr:blocks', withMarker: true })
  assert.equal(result.changed, true)
  assert.equal(result.blocks[0].type, 'text')
  assert.ok(result.blocks[0].text.length < original.length)
  assert.deepEqual(result.blocks[1], blocks[1])
})

test('internals.collapseRepeatedLines keeps the right count', () => {
  const lines = ['a', 'a', 'a', 'b', 'b', 'c']
  const collapsed = internals.collapseRepeatedLines(lines)
  assert.deepEqual(collapsed, ['a', 'a [repeated 3 times]', 'b', 'b', 'c'])
})

test('tabular compression does not duplicate head/tail when the table is small', () => {
  const text = 'a,b,c\n1,2,3\n4,5,6\n7,8,9\n10,11,12\n13,14,15'
  const result = internals.compressTabularText(text, resolveLimits({ maxTabularLines: 4 }))
  assert.ok(result === null || result.split('\n').filter((line) => line === 'a,b,c').length === 1)
})

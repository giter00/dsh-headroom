import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compressContentBlocks,
  compressKompressText,
  compressTextBlock,
  detectContentType,
  globToRegExp,
  resolveLimits,
  internals
} from '../lib/compress.js'
import {
  KOMPRESS_MUST_KEEP_RE,
  scoreWordsHeuristic,
  splitKompressWords
} from '../lib/kompress.js'

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

test('plain prose is head/tail truncated when textStrategy is head-tail', () => {
  const original = 'word '.repeat(200)
  const outcome = compressTextBlock(original, {
    limits: resolveLimits({ ...limits, textStrategy: 'head-tail' }),
    retrievalId: 'hr:text',
    withMarker: true
  })
  assert.equal(outcome.strategy, 'text-head/tail')
  assert.equal(outcome.changed, true)
  assert.ok(outcome.compressedChars < outcome.originalChars)
})

test('plain prose uses the Kompress pipeline by default (auto)', () => {
  // Distinct facts keep the text compressible-but-not-empty under Kompress.
  const prose = Array.from({ length: 60 }, (_, i) => `the process handled event ${i} with result ${i * 7}`).join(' ')
  const outcome = compressTextBlock(prose, { limits, retrievalId: 'hr:text', withMarker: true })
  assert.equal(outcome.strategy, 'kompress')
  assert.equal(outcome.changed, true)
  assert.ok(outcome.compressedChars < outcome.originalChars)
  assert.match(outcome.text, /headroom_retrieve\(id="hr:text"\)/)
})

test('Kompress never emits an empty block (all-high-frequency text falls back)', () => {
  // Regression: 'word '.repeat(200) made every word high-frequency and the
  // heuristic deleted all of them, producing a 0-content "compression".
  const original = 'word '.repeat(200)
  const outcome = compressTextBlock(original, { limits, retrievalId: 'hr:empty', withMarker: true })
  assert.notEqual(outcome.strategy, 'kompress', 'empty result must not be adopted as kompress')
  if (outcome.changed) {
    const contentOnly = outcome.text.replace(/\[headroom:[^\]]*\]/g, '').trim()
    assert.ok(contentOnly.length > 0, 'compressed output must keep real content')
  }
})

test('Kompress forced mode passes through when every word would be deleted', () => {
  const original = 'word '.repeat(200)
  const outcome = compressTextBlock(original, {
    limits: resolveLimits({ ...limits, textStrategy: 'kompress' }),
    retrievalId: 'hr:forced',
    withMarker: true
  })
  assert.equal(outcome.changed, false)
  assert.equal(outcome.text, original)
})

test('Kompress does not wipe repeated CJK content', () => {
  // Regression: repeated Chinese used to collapse to "500 0x1f4d" only —
  // every CJK word was deleted. CJK must never be wiped to zero content.
  const sentence = '系统处理事件并记录结果，错误码 500 发生在 0x1f4d 位置'
  const original = (sentence + ' ').repeat(30)
  const outcome = compressTextBlock(original, {
    limits: resolveLimits({ ...limits, textStrategy: 'kompress', kompress: { minWords: 5 } }),
    retrievalId: 'hr:cjk',
    withMarker: true
  })
  if (outcome.changed) {
    assert.ok(/[\u4e00-\u9fff]/.test(outcome.text), 'CJK content must survive compression')
    assert.ok(outcome.text.includes('500'), 'CJK output must keep the number fact')
    assert.ok(outcome.text.includes('0x1f4d'), 'CJK output must keep the hex fact')
  }
})

test('Kompress compresses mixed CJK+English text while keeping CJK facts', () => {
  const facts = '错误码 500 发生在 0x1f4d 位置 请保留 /var/log/app.log 路径'
  const filler = 'the system repeated the same boilerplate line many times over and over again'
  const original = facts + ' ' + filler.repeat(40)
  const outcome = compressTextBlock(original, {
    limits: resolveLimits({ ...limits, textStrategy: 'kompress', kompress: { minWords: 5 } }),
    retrievalId: 'hr:cjk-mix',
    withMarker: true
  })
  assert.equal(outcome.changed, true)
  assert.ok(outcome.compressedChars < outcome.originalChars)
  assert.ok(/[\u4e00-\u9fff]/.test(outcome.text), 'CJK facts must survive')
  assert.ok(outcome.text.includes('500'))
  assert.ok(outcome.text.includes('0x1f4d'))
  assert.ok(outcome.text.includes('/var/log/app.log'))
})

test('Kompress preserves semantically fragile tokens', () => {
  const prose = [
    'the build failed with status 500 at /usr/lib/python3.so',
    'checking 0x7fff2038 and IndexError and --verbose flag',
    'the version 3.14 was deployed to libsystem_kernel.dylib'
  ]
  const original = (prose.join(' ') + ' ').repeat(12)
  const outcome = compressTextBlock(original, {
    limits: resolveLimits({ textStrategy: 'kompress', kompress: { minWords: 5 } }),
    retrievalId: 'hr:keep',
    withMarker: true
  })
  assert.equal(outcome.changed, true)
  for (const fact of ['500', '0x7fff2038', '/usr/lib/python3.so', 'IndexError', '--verbose', '3.14', 'libsystem_kernel.dylib']) {
    assert.ok(outcome.text.includes(fact), `Kompress output must preserve "${fact}"`)
  }
})

test('Kompress falls back to head/tail when there is no word-level win', () => {
  // Every word matches must-keep, so Kompress cannot shrink the text.
  const original = Array.from({ length: 80 }, (_, i) => `0x${(0x1000 + i).toString(16)}`).join(' ')
  const outcome = compressTextBlock(original, {
    limits: resolveLimits({ ...limits, textStrategy: 'auto', kompress: { minWords: 5 } }),
    retrievalId: 'hr:fallback',
    withMarker: true
  })
  assert.equal(outcome.strategy, 'text-head/tail')
  assert.equal(outcome.changed, true)
})

test('Kompress targetRatio keeps the top-k fraction of words', () => {
  const words = Array.from({ length: 100 }, (_, i) => `contentword${String(i).padStart(3, '0')}`)
  const original = words.join(' ')
  const compressed = compressKompressText(original, {
    targetRatio: 0.3,
    mustKeep: false,
    minWords: 5,
    chunkWords: 500
  })
  assert.ok(compressed !== null)
  const keptCount = compressed.split(' ').length
  assert.ok(keptCount <= 35 && keptCount >= 25, `targetRatio 0.3 should keep ~30 words, got ${keptCount}`)
})

test('splitKompressWords subdivides long CJK runs', () => {
  const longRun = '这是一个非常长的没有空格的中文段落'.repeat(20)
  const words = splitKompressWords(longRun)
  assert.ok(words.length > 1, 'long CJK run must be subdivided')
  assert.equal(words.join(''), longRun.replace(/\s+/g, ''), 'subdivision must be lossless')
})

test('scoreWordsHeuristic returns scores in [0, 1] and is deterministic', () => {
  const words = ['the', 'ERROR', '0x7fff', 'hydrate', '/usr/lib/x.so', 'compilation']
  const ctx = { start: 0, freq: new Map(words.map((w) => [w, w === 'the' ? 20 : 1])) }
  const scores = scoreWordsHeuristic(words, ctx)
  assert.ok(scores.every((s) => s >= 0 && s <= 1))
  const again = scoreWordsHeuristic(words, ctx)
  assert.deepEqual([...scores], [...again])
  // Must-keep classes score above the default 0.5 threshold.
  assert.ok(scores[1] > 0.5, 'ALLCAPS must score above threshold')
  assert.ok(scores[2] > 0.5, 'hex must score above threshold')
  assert.ok(scores[4] > 0.5, 'path must score above threshold')
  // A repeated function word scores below the threshold.
  assert.ok(scores[0] < 0.5, 'repeated function word must score below threshold')
})

test('detectContentType does not route single-ERROR prose to log', () => {
  assert.equal(detectContentType('The build failed with status 500 because of an ERROR in the pipeline.'), 'text')
  const multiLine = [
    'The system processed the request and recorded the outcome.',
    'An ERROR budget was exceeded but the service continued.',
    'Operators should review the metrics before the next deploy.'
  ].join('\n')
  assert.equal(detectContentType(multiLine), 'text')
})

test('real multi-line logs still route to log', () => {
  const log = [
    'INFO starting build',
    'INFO compiling module',
    'ERROR compilation failed: module not found',
    'WARN falling back to legacy resolver'
  ].join('\n')
  assert.equal(detectContentType(log), 'log')
})

test('prose containing ERROR is compressed by Kompress instead of 0% log route', () => {
  const facts = 'ERROR the request failed with status 500 at /var/log/app.log for IndexError'
  const filler = 'the system processed the event and recorded the outcome many times over'
  const original = facts + ' ' + filler.repeat(40)
  const outcome = compressTextBlock(original, {
    limits: resolveLimits({ ...limits, textStrategy: 'auto' }),
    retrievalId: 'hr:error-prose',
    withMarker: true
  })
  assert.notEqual(outcome.strategy, 'none')
  assert.ok(outcome.compressedChars < outcome.originalChars)
  assert.ok(outcome.text.includes('500'))
  assert.ok(outcome.text.includes('/var/log/app.log'))
  assert.ok(outcome.text.includes('IndexError'))
})

test('KOMPRESS_MUST_KEEP_RE does not match hyphenated words', () => {
  for (const token of ['re-ran', 'co-op', 'well-known', 'state-of-the-art', 'user-friendly']) {
    assert.equal(KOMPRESS_MUST_KEEP_RE.test(token), false, `must-keep regex should NOT match ${token}`)
  }
  assert.equal(KOMPRESS_MUST_KEEP_RE.test('--verbose'), true)
  assert.equal(KOMPRESS_MUST_KEEP_RE.test('-n'), true)
})

test('KOMPRESS_MUST_KEEP_RE matches fragile token classes', () => {
  for (const token of ['0x7fff2038', '42', '3.14', 'SIGILL', 'HTTP', 'libsystem_kernel.dylib', '/usr/lib/python3.so', '.json', '--verbose', '-n', 'IndexError']) {
    assert.ok(KOMPRESS_MUST_KEEP_RE.test(token), `must-keep regex should match ${token}`)
  }
  for (const token of ['the', 'quiet', 'running', 'compilation']) {
    assert.equal(KOMPRESS_MUST_KEEP_RE.test(token), false, `must-keep regex should NOT match ${token}`)
  }
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

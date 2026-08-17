/**
 * dsh-headroom deterministic content compressors.
 *
 * This module is intentionally dependency-free (no `node:*` imports) so the
 * compression strategies can be unit-tested in isolation and reused by both
 * the plugin body and the `headroom_compress` tool.
 *
 * The routing is a lightweight JavaScript port of the Headroom idea
 * (https://github.com/headroomlabs-ai/headroom):
 *
 *   ContentRouter → SmartCrusher (JSON) | search-fold | log-fold | text-*
 *
 * Plain prose has two strategies, selected by `textStrategy`:
 *   - 'kompress' / 'auto': the Kompress-style pipeline from `kompress.js`,
 *     a faithful port of Headroom's Kompress-v2-base ML compression approach
 *     (word-level keep/discard scoring with must-keep protection). 'auto'
 *     falls back to head/tail truncation when Kompress has no win.
 *   - 'head-tail': the original reversible head/tail truncation.
 *
 * Every lossy compression emits a CCR marker so the model can call
 * `headroom_retrieve` to recover the exact original. The caller owns the CCR
 * store and passes the retrieval id in.
 */

/** @typedef {'json'|'search'|'log'|'tabular'|'code'|'text'} ContentKind */
/** @typedef {{ text: string, strategy: string, changed: boolean, originalChars: number, compressedChars: number }} CompressOutcome */

import { KOMPRESS_DEFAULTS, compressKompressText } from './kompress.js'

export const DEFAULT_LIMITS = Object.freeze({
  /** Only text blocks with at least this many chars are considered. */
  minChars: 600,
  /** JSON table rows kept before offloading. */
  maxRows: 80,
  /** Truncate a single JSON/search cell to this many chars. */
  maxCellChars: 200,
  /** Search matches kept per file. */
  maxSearchMatchesPerFile: 60,
  /** Log lines kept before collapsing the middle. */
  maxLogLines: 80,
  /** Head/tail budget for plain prose (chars). */
  maxTextChars: 2400,
  /** Head/tail budget for tabular data (lines). */
  maxTabularLines: 80,
  /** File-content tools that must never be folded (read/edit/str_replace_editor etc.). */
  noFoldForTools: ['read', 'str_replace_editor', 'edit', 'write'],
  /** Glob patterns for file paths/tool names that must never be folded (e.g. *.js, *.ts). */
  noFoldForPatterns: ['*.js', '*.ts', '*.json', '*.yml', '*.yaml'],
  /** Marker style: 'full' keeps strategy/savings + headroom_retrieve hint; 'compact' emits only the id. */
  markerStyle: 'full',
  /** Code is never lossy-compressed by this JS port (AST support is required). */
  compressCode: false,
  /**
   * Plain-prose strategy: 'auto' (Kompress first, head/tail fallback),
   * 'kompress' (Kompress only), 'head-tail' (original truncation only).
   */
  textStrategy: 'auto',
  /** Kompress-style ML pipeline knobs (see lib/kompress.js). */
  kompress: Object.freeze({ ...KOMPRESS_DEFAULTS })
})

export function resolveLimits(overrides = {}) {
  const kompress = overrides.kompress === undefined
    ? DEFAULT_LIMITS.kompress
    : Object.freeze({ ...KOMPRESS_DEFAULTS, ...overrides.kompress })
  const { kompress: _ignored, ...rest } = overrides
  return Object.freeze({ ...DEFAULT_LIMITS, ...rest, kompress })
}

/** Coarse token estimate. 4 chars/token is conservative for CJK and close for code. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

/** Compile a `*` wildcard while treating every other regexp character literally. */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

export function isGlobMatch(toolName, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(toolName))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.toString.call(value) === '[object Object]'
}

function deepEqualJson(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqualJson(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqualJson(a[key], b[key]))
  }
  return false
}

/** Keep the head and tail of a long string, with an explicit length marker. */
export function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return text
  const head = Math.max(0, Math.floor(maxChars * 0.6))
  const tail = Math.max(0, maxChars - head)
  return `${text.slice(0, head)}…[len ${text.length}]${text.slice(-tail)}`
}

function scalarForJson(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * SmartCrusher-inspired JSON compressor.
 *
 * Arrays of objects are pivoted into `_keys` + `_rows` (CSV-like) form, which
 * removes repeated key names. Common constant fields move to `_common`.
 * Oversized rows/cells are offloaded; the caller's CCR marker keeps the
 * original recoverable.
 */
function compressJsonText(text, limits) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const crushed = crushJsonValue(parsed, limits)
  if (!crushed || crushed === parsed || JSON.stringify(crushed) === text) return null
  const rendered = safeStringify(crushed)
  if (rendered === null || rendered.length >= text.length) return null
  return rendered
}

function crushJsonValue(value, limits) {
  if (Array.isArray(value)) return crushJsonArray(value, limits)
  if (isPlainObject(value)) return crushJsonObject(value, limits)
  return value
}

function crushJsonArray(array, limits) {
  if (array.length === 0) return array

  const objectRows = array.filter(isPlainObject)
  if (objectRows.length === array.length && array.length > 1) {
    return pivotObjectRows(array, limits)
  }

  // Primitive/mixed arrays: deduplicate, cap, and offload the tail.
  const seen = new Set()
  const unique = []
  let duplicates = 0
  for (const item of array) {
    const key = safeStringify(item) ?? String(item)
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    unique.push(crushJsonValue(item, limits))
  }
  const kept = unique.slice(0, limits.maxRows)
  const omitted = Math.max(0, unique.length - kept.length)
  const result = [...kept]
  if (duplicates > 0) result.push({ _headroom: `duplicates: ${duplicates}` })
  if (omitted > 0) result.push({ _headroom: `omitted: ${omitted}` })
  return result
}

function pivotObjectRows(rows, limits) {
  const keySet = []
  const seenKeys = new Set()
  const rowCount = rows.length
  const sampleLimit = Math.min(rowCount, 200)
  for (let index = 0; index < sampleLimit; index += 1) {
    for (const key of Object.keys(rows[index])) {
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      keySet.push(key)
      if (keySet.length >= 80) break
    }
    if (keySet.length >= 80) break
  }

  const common = {}
  const commonCandidate = {}
  for (const key of keySet) {
    const first = rows[0][key]
    if (rows.every((row) => deepEqualJson(row[key], first))) {
      commonCandidate[key] = first
    }
  }
  for (const key of keySet) {
    if (Object.hasOwn(commonCandidate, key)) {
      const value = truncateValue(commonCandidate[key], limits.maxCellChars)
      common[key] = value
    }
  }

  const pivotKeys = keySet.filter((key) => !Object.hasOwn(common, key))
  const outRows = []
  for (const row of rows.slice(0, limits.maxRows)) {
    const cells = pivotKeys.map((key) => truncateValue(row[key], limits.maxCellChars))
    outRows.push(cells)
  }
  const omitted = Math.max(0, rows.length - outRows.length)

  const out = { _keys: pivotKeys, _rows: outRows, _count: rows.length }
  if (Object.keys(common).length > 0) out._common = common
  if (omitted > 0) out._omittedRows = omitted
  return out
}

function crushJsonObject(object, limits) {
  let changed = false
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === 'string') {
      const truncated = truncateValue(value, limits.maxCellChars)
      if (truncated !== value) changed = true
      out[key] = truncated
    } else if (Array.isArray(value)) {
      const crushed = crushJsonArray(value, limits)
      if (crushed !== value) changed = true
      out[key] = crushed
    } else if (isPlainObject(value)) {
      const crushed = crushJsonObject(value, limits)
      if (crushed !== value) changed = true
      out[key] = crushed
    } else {
      out[key] = value
    }
  }
  return changed ? out : object
}

function truncateValue(value, maxCellChars) {
  if (typeof value !== 'string') return value
  return truncateMiddle(value, maxCellChars)
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

const SEARCH_LINE_RE = /^(.+?):(\d+)(?::(\d+))?:(.*)$/

/** Fold grep/ripgrep-style `file:line[:col]: content` results. */
function compressSearchText(text, limits) {
  const lines = text.split(/\r?\n/)
  const groups = new Map()
  let totalNonEmpty = 0
  let matched = 0
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue
    totalNonEmpty += 1
    const match = SEARCH_LINE_RE.exec(line)
    if (!match) continue
    matched += 1
    const file = match[1]
    const lineNo = match[2]
    const col = match[3]
    const rest = match[4] ?? ''
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push({ lineNo, col, rest, raw: line })
  }
  if (matched < 3 || matched / Math.max(1, totalNonEmpty) < 0.5) return null

  const out = []
  let omitted = 0
  for (const [file, matches] of groups) {
    out.push(`${file} (${matches.length} match${matches.length === 1 ? '' : 'es'})`)
    const kept = matches.slice(0, limits.maxSearchMatchesPerFile)
    for (const match of kept) {
      const colText = match.col === undefined ? '' : `:${match.col}`
      // Keep every kept match line byte-for-byte: search-fold must preserve
      // line numbers and the full matched line so the model can locate/verify
      // matches without a second grep. Only the number of kept matches is capped.
      out.push(`${match.lineNo}${colText}: ${match.rest}`)
    }
    omitted += Math.max(0, matches.length - kept.length)
  }
  if (omitted > 0) out.push(`… [${omitted} search matches omitted — headroom]`)
  const result = out.join('\n')
  return result.length < text.length ? result : null
}

const LOG_ERROR_RE = /(^|\b)(error|fail|failure|fatal|panic|exception|traceback|assert|warning|warn)\b/i
const LOG_MARKER_RE = /(^|\b)(info|debug|trace|warn|warning|error|fatal|panic|pass|fail|ok|skip|todo)\b/i

/** Collapse log/build output: deduplicate repeats, keep errors, cap the middle. */
function compressLogText(text, limits) {
  const rawLines = text.split(/\r?\n/)
  if (rawLines.length < 20) return null

  const collapsed = collapseRepeatedLines(rawLines)
  const totalLines = collapsed.length
  const errorLike = new Set()
  const markerCount = collapsed.reduce((count, line) => count + (LOG_MARKER_RE.test(line) ? 1 : 0), 0)
  const duplicateLines = rawLines.length - collapsed.length
  const looksLikeLog = markerCount >= 3 || duplicateLines >= 5 || rawLines.some((line) => LOG_ERROR_RE.test(line))
  if (!looksLikeLog) return null

  collapsed.forEach((line, index) => {
    if (LOG_ERROR_RE.test(line)) {
      errorLike.add(index)
      errorLike.add(Math.max(0, index - 2))
      errorLike.add(Math.min(totalLines - 1, index + 2))
    }
  })

  const headLines = Math.max(0, Math.floor(limits.maxLogLines / 2))
  const tailLines = Math.max(0, limits.maxLogLines - headLines)
  const out = []
  let omitted = 0
  let openOmission = false
  for (let index = 0; index < totalLines; index += 1) {
    const line = collapsed[index]
    const isHead = index < headLines
    const isTail = index >= totalLines - tailLines
    if (isHead || isTail || errorLike.has(index)) {
      if (openOmission) {
        out.push(`… [${omitted} lines omitted — headroom]`)
        openOmission = false
        omitted = 0
      }
      out.push(line)
    } else if (!openOmission) {
      openOmission = true
      omitted = 1
    } else {
      omitted += 1
    }
  }
  if (openOmission) out.push(`… [${omitted} lines omitted — headroom]`)

  const result = out.join('\n')
  return result.length < text.length ? result : null
}

function collapseRepeatedLines(lines) {
  const out = []
  let previous = null
  let run = 0
  for (const line of lines) {
    if (line === previous) {
      run += 1
      continue
    }
    flushRepeatedLine(out, previous, run)
    out.push(line)
    previous = line
    run = 0
  }
  flushRepeatedLine(out, previous, run)
  return out
}

function flushRepeatedLine(out, previous, run) {
  if (run <= 0) return
  if (run >= 2) out.push(`${previous} [repeated ${run + 1} times]`)
  else out.push(previous)
}

/** Conservative tabular compressor: keep the header, first N and last M rows. */
function compressTabularText(text, limits) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 6) return null
  const first = lines[0]
  const hasComma = first.split(',').length >= 3
  const hasTab = first.split('\t').length >= 2
  const hasPipe = first.includes('|') && lines.some((line) => /^\s*\|?\s*:?-{2,}/.test(line))
  if (!hasComma && !hasTab && !hasPipe) return null

  const keepHead = Math.max(1, Math.floor(limits.maxTabularLines / 2))
  const keepTail = Math.max(1, limits.maxTabularLines - keepHead)
  const omitStart = keepHead
  const omitEnd = lines.length - keepTail
  if (omitEnd <= omitStart) return null
  const omitted = omitEnd - omitStart
  const head = lines.slice(0, omitStart)
  const tail = lines.slice(omitEnd)
  const out = [...head, `… [${omitted} rows omitted — headroom]`, ...tail]
  const result = out.join('\n')
  return result.length < text.length ? result : null
}

/** Plain-prose fallback: head/tail truncation. Reversible via CCR only. */
function compressPlainText(text, limits) {
  if (text.length <= limits.maxTextChars) return null
  const head = Math.max(0, Math.floor(limits.maxTextChars * 0.65))
  const tail = Math.max(0, limits.maxTextChars - head)
  return `${text.slice(0, head)}\n… [${text.length - head - tail} chars omitted — headroom]\n${text.slice(-tail)}`
}

const CODE_HINTS = [
  /^\s*(def|class|import|from|async def)\s+\w+/m,
  /^\s*(function|const|let|var|class|import|export)\s+/m,
  /^\s*(interface|type|enum|namespace)\s+\w+/m,
  /^\s*(func|type|package|import)\s+/m,
  /^\s*(fn|struct|enum|impl|mod|use|pub)\s+/m,
  /^\s*(public|private|protected)\s+(class|interface|enum)/m,
  /^\s*using\s+[\w.]+\s*;/m,
  /^\s*namespace\s+[\w.]/m,
  /^\s*package\s+[\w.]+;/m,
  /^\s*<\?php\b/m
]

export function detectContentType(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'text'
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') return 'json'
  } catch {
    /* not JSON */
  }

  const lines = text.split(/\r?\n/)
  let nonEmpty = 0
  let searchMatches = 0
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') continue
    nonEmpty += 1
    if (SEARCH_LINE_RE.test(rawLine)) searchMatches += 1
  }
  if (searchMatches >= 3 && searchMatches / Math.max(1, nonEmpty) >= 0.5) return 'search'

  const rawLines = lines.filter((line) => line.trim() !== '')
  if (rawLines.length >= 6) {
    const first = rawLines[0]
    const hasComma = first.split(',').length >= 3
    const hasTab = first.split('\t').length >= 2
    const hasPipe = first.includes('|') && rawLines.some((line) => /^\s*\|?\s*:?-{2,}/.test(line))
    if (hasComma || hasTab || hasPipe) return 'tabular'
  }

  // Detect code before log routing. read/str_replace_editor prefix every line
  // with "N: ", so strip that prefix before testing the code hints; otherwise
  // JS/TS source is misclassified as log/kompress and its operators are lost.
  const lineNumberPrefix = /^\s*\d+:\s*/
  const codeText = lines.map((line) => line.replace(lineNumberPrefix, '')).join('\n')
  if (CODE_HINTS.some((pattern) => pattern.test(codeText))) return 'code'

  const markerCount = rawLines.reduce((count, line) => count + (LOG_MARKER_RE.test(line) ? 1 : 0), 0)
  const errorLikeCount = rawLines.reduce((count, line) => count + (LOG_ERROR_RE.test(line) ? 1 : 0), 0)
  // A single "error/failure" word in a prose paragraph is NOT a log: require
  // multiple log signals (>=3 lines plus enough markers, repeated lines, or
  // >=2 error-like lines) so ordinary prose containing ERROR is routed to the
  // text/Kompress pipeline instead of being stranded in log-fold.
  const looksLikeLog = rawLines.length >= 3
    && (markerCount >= 3 || errorLikeCount >= 2 || hasRepeatedLines(lines))
  if (looksLikeLog) return 'log'

  return 'text'
}

function hasRepeatedLines(lines) {
  const counts = new Map()
  for (const line of lines) {
    const key = line.trimEnd()
    if (key === '') continue
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count >= 3) return true
  }
  return false
}

/**
 * Build a compact retrieval marker. Kept short on purpose: the model only
 * needs the id, and every extra token reduces the net saving.
 */
export function markerFor(retrievalId, strategy, originalChars, compressedChars, style = 'full') {
  if (style === 'compact') {
    return `\n\n[headroom: id="${retrievalId}"]`
  }
  return `\n\n[headroom: ${strategy} ${originalChars}→${compressedChars} chars; headroom_retrieve(id="${retrievalId}")]`
}

/**
 * Choose a plain-prose candidate: Kompress-style ML pipeline, head/tail
 * truncation, or both (textStrategy auto/kompress/head-tail).
 *
 * @returns {{ candidate: string|null, strategy: string }}
 */
function compressTextWithStrategies(text, limits) {
  const strategyCfg = limits.textStrategy ?? 'auto'
  const kompressEnabled = limits.kompress === undefined || limits.kompress.enabled !== false
  if (strategyCfg === 'head-tail' || !kompressEnabled) {
    return { candidate: compressPlainText(text, limits), strategy: 'text-head/tail' }
  }

  const kompressLimits = limits.kompress === undefined ? {} : limits.kompress
  const { enabled: _enabled, ...kompressKnobs } = kompressLimits
  const kompressCandidate = compressKompressText(text, kompressKnobs)
  // Defense in depth: never adopt a candidate with zero content — even a
  // custom scorer must not be able to empty a block (see kompress.js).
  if (kompressCandidate !== null && kompressCandidate.trim().length > 0) {
    return { candidate: kompressCandidate, strategy: 'kompress' }
  }
  if (strategyCfg === 'kompress') {
    return { candidate: null, strategy: 'none' }
  }
  return { candidate: compressPlainText(text, limits), strategy: 'text-head/tail' }
}

/**
 * Compress one text block.
 *
 * @param {string} text - original text block content.
 * @param {{ limits: object, retrievalId?: string, withMarker?: boolean }} options
 * @returns {CompressOutcome}
 */
export function compressTextBlock(text, options = {}) {
  const limits = options.limits ?? DEFAULT_LIMITS
  const originalChars = text.length
  if (text.includes('retrieve full original with headroom_retrieve')) {
    return { text, strategy: 'none', changed: false, originalChars, compressedChars: originalChars }
  }
  if (originalChars < limits.minChars) {
    return { text, strategy: 'none', changed: false, originalChars, compressedChars: originalChars }
  }

  const kind = detectContentType(text)
  let strategy = kind
  let candidate = null
  if (kind === 'json') {
    candidate = compressJsonText(text, limits)
  } else if (kind === 'search') {
    candidate = compressSearchText(text, limits)
    strategy = 'search-fold'
  } else if (kind === 'log') {
    candidate = compressLogText(text, limits)
    strategy = 'log-fold'
    // Route safety: if log folding has no win (e.g. short prose misclassified
    // as log, or a real log that does not fold), fall back to the text
    // pipeline instead of returning 0% compression.
    if (candidate === null) {
      const fallback = compressTextWithStrategies(text, limits)
      candidate = fallback.candidate
      strategy = fallback.strategy
    }
  } else if (kind === 'tabular') {
    candidate = compressTabularText(text, limits)
    strategy = 'tabular-fold'
  } else if (kind === 'code') {
    if (limits.compressCode === true) candidate = compressPlainText(text, limits)
    else candidate = null
  } else {
    const selected = compressTextWithStrategies(text, limits)
    candidate = selected.candidate
    strategy = selected.strategy
  }

  if (candidate === null) {
    return { text, strategy: 'none', changed: false, originalChars, compressedChars: originalChars }
  }

  const withMarker = options.withMarker === true && options.retrievalId !== undefined
  const marker = withMarker
    ? markerFor(options.retrievalId, strategy, originalChars, candidate.length, limits.markerStyle)
    : ''
  const finalText = candidate + marker
  if (finalText.length >= originalChars) {
    return { text, strategy: 'none', changed: false, originalChars, compressedChars: originalChars }
  }

  return {
    text: finalText,
    strategy,
    changed: true,
    originalChars,
    compressedChars: finalText.length
  }
}

/**
 * Compress every text block in a ContentBlock[] and report whether anything
 * changed. Non-text blocks pass through untouched.
 *
 * @param {Array<{type: string, text?: string}>} blocks
 * @param {{ limits: object, retrievalId?: string, withMarker?: boolean }} options
 */
export function compressContentBlocks(blocks, options = {}) {
  const limits = options.limits ?? DEFAULT_LIMITS
  const textBlocks = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string')
  const totalChars = textBlocks.reduce((total, block) => total + block.text.length, 0)
  if (totalChars < limits.minChars) return { blocks, changed: false, strategy: 'none', originalChars: totalChars, compressedChars: totalChars }

  let changed = false
  let originalChars = 0
  let compressedChars = 0
  const strategies = new Set()
  const outBlocks = blocks.map((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    originalChars += block.text.length
    const outcome = compressTextBlock(block.text, options)
    compressedChars += outcome.compressedChars
    if (outcome.changed) {
      changed = true
      strategies.add(outcome.strategy)
      return { type: 'text', text: outcome.text }
    }
    return block
  })

  return {
    blocks: changed ? outBlocks : blocks,
    changed,
    strategy: changed ? [...strategies].join('+') : 'none',
    originalChars,
    compressedChars: changed ? compressedChars : totalChars
  }
}

export const internals = {
  compressJsonText,
  compressSearchText,
  compressLogText,
  compressTabularText,
  compressPlainText,
  pivotObjectRows,
  collapseRepeatedLines,
  deepEqualJson
}

export { compressKompressText } from './kompress.js'

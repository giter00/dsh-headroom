/**
 * dsh-headroom Kompress-style ML text compressor (pure JS port).
 *
 * This module mirrors the compression pipeline of Headroom's Kompress
 * (https://github.com/headroomlabs-ai/headroom, `kompress_compressor.py`,
 * model `chopratejas/kompress-v2-base` — a dual-head ModernBERT that scores
 * every token with a keep/discard classifier plus a span-importance CNN):
 *
 *   1. split the text into words (with long CJK/run-on blocks subdivided)
 *   2. score every word in ~350-word chunks   (score = keepProb * (0.5 + 0.5 * spanScore))
 *   3. keep a word when  score > scoreThreshold (default 0.5)  — or top-k by
 *      score when a targetRatio is set
 *   4. always keep "semantically fragile" words (numbers, hex, ALLCAPS,
 *      dotted/unix paths, file extensions, CLI flags, CamelCase) — the same
 *      must-keep rule Headroom applies on top of the model
 *   5. rebuild the text as " ".join(kept words) — lossy, reversible via CCR
 *
 * The pipeline and its knobs are faithful to Headroom; only the per-word
 * scorer is a deterministic, dependency-free heuristic approximation of the
 * model's two heads (token classifier + span CNN). An external scorer can be
 * injected through `createKompressCompressor({ scorer })` — e.g. a wrapper
 * around the real Kompress-v2-base ONNX model — so the same pipeline works
 * with the genuine ML backend where the model is available.
 *
 * This module is intentionally dependency-free (no `node:*` imports) so it can
 * be unit-tested in isolation, exactly like `compress.js`.
 */

/** @typedef {(words: string[], ctx: { start: number, freq: Map<string, number> }) => Float64Array} WordScorer */

export const KOMPRESS_DEFAULTS = Object.freeze({
  /** Skip texts with fewer than this many words (Kompress: 10). */
  minWords: 10,
  /** Words per inference chunk (Kompress default for kompress-v2-base: 350). */
  chunkWords: 350,
  /** Keep a word when its score is strictly above this (Kompress: 0.5). */
  scoreThreshold: 0.5,
  /** Force keep-ratio (0..1). null = model/heuristic decides via threshold. */
  targetRatio: null,
  /** Always keep semantically fragile words (numbers/paths/flags/ALLCAPS…). */
  mustKeep: true,
  /** Words longer than this are subdivided for scoring (CJK / run-on text). */
  maxWordChars: 64
})

/**
 * Words that carry semantic meaning agents cannot reconstruct from context.
 * Ported verbatim from Headroom's `_KOMPRESS_MUST_KEEP_RE`:
 *   hex addresses, standalone numbers, ALLCAPS identifiers, dotted paths,
 *   unix paths, file extensions, CLI flags, CamelCase names.
 */
export const KOMPRESS_MUST_KEEP_RE = new RegExp(
  '\\b0x[0-9A-Fa-f]+\\b' // hex addresses/IDs: 0x7fff2038
  + '|(?<![\\w.])\\d+(?:\\.\\d+)?(?![\\w.])' // standalone numbers: 42, 3.14
  + '|[A-Z_]{2,}' // ALLCAPS: SIGILL, HTTP, EOF, ERROR
  + '|[a-z_][a-z0-9_]*\\.[a-z0-9_]+' // dotted.paths: libsystem_kernel.dylib
  + '|/[a-z0-9/._-]{2,}' // unix paths: /usr/lib/python3.so
  + '|\\.[a-z]{2,4}\\b' // extensions: .py .so .json
  + '|^-{1,2}[a-z][\\w-]*' // CLI flags at token start: --verbose, -n (anchored so re-ran / co-op are NOT matched)
  + '|\\b[A-Z][a-z]+[A-Z]\\w*' // CamelCase: EXC_BAD_INSTRUCTION, IndexError
)

/**
 * JS/TS and common config-syntax operators that must survive even when a text
 * block is misclassified and reaches Kompress. Dropping these makes code look
 * like "const appId config.appId process.env" and breaks read→edit workflows.
 */
export const KOMPRESS_SYNTAX_RE = /^(?:=>|===|!==|==|!=|<=|>=|\?\?|\?\.|&&|\|\||::|->|=>|[=?:<>!&|+\-*/%^~.,;(){}[\]`'"\\])$/

/** Any token carrying a JS/TS operator or syntax character (e.g. `(x)`, `foo=>bar`). */
export const KOMPRESS_SYNTAX_HAS_RE = /[=?:<>!&|+*/%^~.,;(){}[\]`'"\\]/

/** English function words and shell/log filler that carry little signal. */
const STOP_WORDS = new Set(
  ('the a an and or but if then else when while for of to in on at by with from into onto upon '
   + 'is are was were be been being am do does did doing have has had having will would shall should '
   + 'can could may might must not no yes so as than that this these those it its he she they them his her '
   + 'their our your my me we us you i there here what which who whom whose how why where when all any '
   + 'each every both few more most other some such only own same very just about against between '
   + 'through during before after above below under again further once also nor because until while '
   + 'out up down off over under again too').split(/\s+/)
)

/** Words that are near-certainly boilerplate in tool output. */
const FILLER_WORDS = new Set(
  'info debug trace warn warning error fatal panic pass fail ok skip todo done okays success failed '
   + 'please note see e.g i.e eg ie etc'.split(/\s+/)
)

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
const CJK_PUNCT_RE = /[，。！？；：、,.!?;:()（）"'“”‘’<>《》]/u

/**
 * Split text into words. Whitespace-separated tokens are the primary unit
 * (same as Kompress's `content.split()`); a token longer than `maxWordChars`
 * (typically an unbroken CJK run or a minified blob) is subdivided at CJK
 * punctuation and script boundaries so the scorer can act on it.
 */
export function splitKompressWords(text, maxWordChars = KOMPRESS_DEFAULTS.maxWordChars) {
  const tokens = text.split(/\s+/).filter((part) => part.length > 0)
  const words = []
  for (const token of tokens) {
    if (token.length <= maxWordChars) {
      words.push(token)
      continue
    }
    words.push(...subdivideLongToken(token))
  }
  return words
}

function subdivideLongToken(token, maxPiece = 16) {
  const pieces = []
  let current = ''
  let currentScript = null
  const flush = () => {
    if (current.length > 0) {
      pieces.push(current)
      current = ''
    }
    currentScript = null
  }
  for (const char of token) {
    const isCjk = CJK_RE.test(char)
    const isPunct = CJK_PUNCT_RE.test(char)
    const script = isCjk ? 'cjk' : isPunct ? 'punct' : 'latin'
    if (currentScript === null) {
      currentScript = script
    } else if (script !== currentScript && !(script === 'punct' && currentScript === 'punct')) {
      flush()
      currentScript = script
    } else if (current.length >= maxPiece) {
      // Same-script runaway (unbroken CJK run): cap each piece so the scorer
      // can still act on it instead of treating the whole blob as one word.
      flush()
      currentScript = script
    }
    current += char
  }
  flush()
  return pieces
}

/**
 * Deterministic heuristic scorer approximating Kompress's dual-head model:
 *
 *   score(word) = keepProb(word) * (0.5 + 0.5 * spanScore(word))
 *
 * `keepProb` (the token-classifier head) is derived from word class and how
 * rare the word is in this text: numbers/identifiers/must-keep tokens are
 * near-certain keeps, function words and high-frequency filler are near-certain
 * drops, and content words score by frequency (rarer = more informative).
 * `spanScore` (the span-CNN head) boosts tokens around error markers, sentence
 * boundaries, key/value positions, and list items, and dampens heavily
 * repeated boilerplate.
 *
 * @param {string[]} words - the chunk's words (already globally indexed via ctx.start).
 * @param {{ start: number, freq?: Map<string, number> }} ctx
 * @returns {Float64Array} per-word scores in [0, 1].
 */
export function scoreWordsHeuristic(words, ctx = {}) {
  const { start = 0, freq } = ctx
  const scores = new Float64Array(words.length)
  for (let i = 0; i < words.length; i += 1) {
    scores[i] = scoreSingleWord(words, i, start, freq)
  }
  return scores
}

function wordFrequency(word, freq) {
  if (!freq) return 1
  const n = freq.get(word)
  return n === undefined ? 1 : n
}

function scoreSingleWord(words, index, start, freq) {
  const word = words[index]
  if (word.length === 0) return 0

  // ── keep-prob head ────────────────────────────────────────────────
  let keepProb
  if (KOMPRESS_MUST_KEEP_RE.test(word)) {
    keepProb = 0.9 // fragile token: model-level must-keep also forces it in
  } else if (KOMPRESS_SYNTAX_RE.test(word) || KOMPRESS_SYNTAX_HAS_RE.test(word)) {
    keepProb = 0.95 // operators/syntax must survive even in misclassified code
  } else if (/^[\W_]+$/.test(word) && !CJK_RE.test(word)) {
    keepProb = 0.12 // bare punctuation/separators (JS \W also matches CJK, so exclude it)
  } else if (STOP_WORDS.has(word.toLowerCase()) && wordFrequency(word, freq) > 5) {
    keepProb = 0.28 // repeated function word
  } else if (STOP_WORDS.has(word.toLowerCase())) {
    keepProb = 0.38
  } else if (FILLER_WORDS.has(word.toLowerCase()) && wordFrequency(word, freq) > 3) {
    keepProb = 0.35 // boilerplate marker repeated across lines
  } else if (/\d/.test(word)) {
    keepProb = 0.88 // numbers carry facts
  } else if (CJK_RE.test(word)) {
    keepProb = 0.74 // CJK tokens are information-dense
  } else {
    const f = wordFrequency(word, freq)
    if (f === 1) keepProb = 0.82
    else if (f <= 3) keepProb = 0.75
    else if (f <= 10) keepProb = 0.68
    else keepProb = 0.5
  }

  // ── span head ─────────────────────────────────────────────────────
  let span = 0.5
  const prev = index > 0 ? words[index - 1] : ''
  const next = index < words.length - 1 ? words[index + 1] : ''
  const lower = word.toLowerCase()

  // Error context: keep the ±2 window around failure markers.
  if (/(^|\b)(error|fail|fatal|panic|exception|traceback|assert)\b/.test(lower)
      || /(error|fail|fatal|panic|exception|traceback|assert)\b/.test(prev.toLowerCase())
      || /(error|fail|fatal|panic|exception|traceback|assert)\b/.test(next.toLowerCase())) {
    span += 0.4
  }
  // Sentence boundaries: end/start of a sentence, or word ending in punctuation.
  if (/[.!?]$/.test(word) || /[.!?;:]$/.test(prev) || (next !== '' && /^[A-Z0-9]/.test(next))) {
    span += 0.2
  }
  // Key/value positions: "key: value" and "key=value" carriers.
  if (/[:=]$/.test(prev) || /^[=:]/.test(word) || /^["'“].*["'”]$/.test(word)) {
    span += 0.2
  }
  // List items.
  if (/^[-*•]/.test(word) || /^\d+[.)]/.test(word)) {
    span += 0.15
  }
  // Long content words are information-dense.
  if (word.length >= 12 && !STOP_WORDS.has(lower)) {
    span += 0.1
  }
  // Heavily repeated boilerplate is dampened. CJK pieces are exempt: their
  // coarse segmentation (16-char script runs) makes repetition a weak
  // redundancy signal, and dropping them en masse would wipe the content.
  if (!CJK_RE.test(word)) {
    const f = wordFrequency(word, freq)
    if (f > 30) span -= 0.2
    else if (f > 12) span -= 0.1
  }

  span = Math.max(0.25, Math.min(0.95, span))
  return Math.max(0, Math.min(1, keepProb * (0.5 + 0.5 * span)))
}

/**
 * Kompress-style compress one text block.
 *
 * @param {string} text - original text.
 * @param {{ minWords?: number, chunkWords?: number, scoreThreshold?: number,
 *           targetRatio?: number|null, mustKeep?: boolean, maxWordChars?: number,
 *           scorer?: WordScorer }} options
 * @returns {string|null} compressed text, or null when there is no win.
 */
export function compressKompressText(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return null
  const minWords = options.minWords ?? KOMPRESS_DEFAULTS.minWords
  const chunkWords = options.chunkWords ?? KOMPRESS_DEFAULTS.chunkWords
  const scoreThreshold = options.scoreThreshold ?? KOMPRESS_DEFAULTS.scoreThreshold
  const targetRatio = options.targetRatio === undefined ? KOMPRESS_DEFAULTS.targetRatio : options.targetRatio
  const mustKeep = options.mustKeep !== false
  const scorer = options.scorer ?? scoreWordsHeuristic

  const words = splitKompressWords(text, options.maxWordChars ?? KOMPRESS_DEFAULTS.maxWordChars)
  if (words.length < minWords) return null

  const freq = new Map()
  for (const word of words) freq.set(word, (freq.get(word) ?? 0) + 1)

  const kept = new Set()
  const nWords = words.length
  const step = Math.max(1, chunkWords)
  for (let start = 0; start < nWords; start += step) {
    const chunk = words.slice(start, start + step)
    const scores = scorer(chunk, { start, freq })

    if (targetRatio !== null && targetRatio !== undefined) {
      // Top-k by score (Kompress: keep the `ratio`-fraction with the best scores).
      const ranked = chunk
        .map((word, offset) => ({ word, score: scores[offset], id: start + offset }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
      const numKeep = Math.max(1, Math.floor(chunk.length * targetRatio))
      for (const entry of ranked.slice(0, numKeep)) kept.add(entry.id)
    } else {
      // Threshold decision (Kompress default path: score > 0.5).
      for (let offset = 0; offset < chunk.length; offset += 1) {
        if (scores[offset] > scoreThreshold) kept.add(start + offset)
      }
    }

    // Must-keep protection: fragile words and syntax operators are always kept
    // regardless of score.
    if (mustKeep) {
      for (let offset = 0; offset < chunk.length; offset += 1) {
        if (KOMPRESS_MUST_KEEP_RE.test(chunk[offset])
          || KOMPRESS_SYNTAX_RE.test(chunk[offset])
          || KOMPRESS_SYNTAX_HAS_RE.test(chunk[offset])) {
          kept.add(start + offset)
        }
      }
    }
  }

  // Never accept a compression that deletes everything: an empty (or
  // whitespace-only) result is treated as no win so the caller can fall back
  // to head/tail truncation instead of showing the model an empty block.
  if (kept.size === 0) return null
  const compressed = words.filter((word, index) => kept.has(index)).join(' ')
  if (compressed.length >= text.length || compressed.trim().length === 0) return null
  return compressed
}

/**
 * Build a reusable compressor with a fixed configuration (optionally with a
 * custom scorer, e.g. a real Kompress-v2-base ONNX wrapper).
 */
export function createKompressCompressor(options = {}) {
  const opts = { ...KOMPRESS_DEFAULTS, ...options }
  return {
    compress(text) {
      return compressKompressText(text, opts)
    },
    split(text) {
      return splitKompressWords(text, opts.maxWordChars)
    }
  }
}

export const internals = {
  splitKompressWords,
  subdivideLongToken,
  scoreWordsHeuristic,
  scoreSingleWord,
  wordFrequency,
  KOMPRESS_SYNTAX_RE,
  KOMPRESS_SYNTAX_HAS_RE
}

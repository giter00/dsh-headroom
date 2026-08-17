/**
 * dsh-headroom — Headroom-inspired automatic context compression for dsh.
 *
 * The plugin hooks `tools/post-execute` (the dsh-native seam that runs after
 * a tool body settles but before the tool result is materialized into the
 * session log and model history) and compresses every text block with the
 * deterministic compressors in `./compress.js`:
 *
 *   JSON arrays/objects → SmartCrusher-style pivoting
 *   grep/ripgrep output  → search-fold
 *   build/test/log output → log-fold
 *   CSV/TSV/markdown     → tabular-fold
 *   prose                → head/tail truncation
 *
 * Each lossy compression is reversible: the exact original is stored in a
 * local CCR store and a short marker tells the model to call
 * `headroom_retrieve(id=…)`. `headroom_compress` and `headroom_stats` mirror
 * Headroom's MCP surface.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  compressContentBlocks,
  compressTextBlock,
  DEFAULT_LIMITS,
  isGlobMatch,
  resolveLimits
} from './compress.js'
import { createCcrStore } from './ccr.js'

export const name = 'dsh-headroom'

/** Services required before this plugin activates. */
export const inject = ['tools']

const OWN_TOOL_NAMES = new Set(['headroom_retrieve', 'headroom_compress', 'headroom_stats'])

function positiveInteger(value, fallback, field = 'value') {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`dsh-headroom: ${field} must be a positive safe integer, got ${String(resolved)}`)
  }
  return resolved
}

function stringArray(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`dsh-headroom: ${field} must be an array of strings`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.trim() !== entry) {
      throw new Error(`dsh-headroom: ${field}[${index}] must be a non-empty string with no surrounding whitespace`)
    }
    return entry
  })
}

const TEXT_STRATEGIES = new Set(['auto', 'kompress', 'head-tail'])

function textStrategyOf(value) {
  const resolved = value ?? 'auto'
  if (!TEXT_STRATEGIES.has(resolved)) {
    throw new Error(`dsh-headroom: textStrategy must be one of ${[...TEXT_STRATEGIES].join(', ')}, got ${String(resolved)}`)
  }
  return resolved
}

function ratioInRange(value, fallback, field) {
  const resolved = value === undefined || value === null ? fallback : value
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error(`dsh-headroom: ${field} must be a number in [0, 1], got ${String(resolved)}`)
  }
  return resolved
}

/** Normalize and validate plugin config once at load time. */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-headroom: config must be a plain object')
  }
  const ccr = raw.ccr === undefined ? {} : raw.ccr
  if (ccr === null || typeof ccr !== 'object' || Array.isArray(ccr)) {
    throw new Error('dsh-headroom: config.ccr must be a plain object')
  }
  const kompress = raw.kompress === undefined ? {} : raw.kompress
  if (kompress === null || typeof kompress !== 'object' || Array.isArray(kompress)) {
    throw new Error('dsh-headroom: config.kompress must be a plain object')
  }
  return Object.freeze({
    enabled: raw.enabled !== false,
    minChars: positiveInteger(raw.minChars, DEFAULT_LIMITS.minChars, 'minChars'),
    maxRows: positiveInteger(raw.maxRows, DEFAULT_LIMITS.maxRows, 'maxRows'),
    maxCellChars: positiveInteger(raw.maxCellChars, DEFAULT_LIMITS.maxCellChars, 'maxCellChars'),
    maxSearchMatchesPerFile: positiveInteger(raw.maxSearchMatchesPerFile, DEFAULT_LIMITS.maxSearchMatchesPerFile, 'maxSearchMatchesPerFile'),
    maxLogLines: positiveInteger(raw.maxLogLines, DEFAULT_LIMITS.maxLogLines, 'maxLogLines'),
    maxTextChars: positiveInteger(raw.maxTextChars, DEFAULT_LIMITS.maxTextChars, 'maxTextChars'),
    maxTabularLines: positiveInteger(raw.maxTabularLines, DEFAULT_LIMITS.maxTabularLines, 'maxTabularLines'),
    excludeTools: stringArray(raw.excludeTools, 'excludeTools'),
    includeErrors: raw.includeErrors === true,
    textStrategy: textStrategyOf(raw.textStrategy),
    kompress: Object.freeze({
      enabled: kompress.enabled !== false,
      minWords: positiveInteger(kompress.minWords, DEFAULT_LIMITS.kompress.minWords, 'kompress.minWords'),
      chunkWords: positiveInteger(kompress.chunkWords, DEFAULT_LIMITS.kompress.chunkWords, 'kompress.chunkWords'),
      scoreThreshold: ratioInRange(kompress.scoreThreshold, DEFAULT_LIMITS.kompress.scoreThreshold, 'kompress.scoreThreshold'),
      targetRatio: kompress.targetRatio === undefined || kompress.targetRatio === null
        ? null
        : ratioInRange(kompress.targetRatio, null, 'kompress.targetRatio'),
      mustKeep: kompress.mustKeep !== false,
      maxWordChars: positiveInteger(kompress.maxWordChars, DEFAULT_LIMITS.kompress.maxWordChars, 'kompress.maxWordChars')
    }),
    ccr: Object.freeze({
      enabled: ccr.enabled !== false,
      persist: ccr.persist !== false,
      ttlMs: positiveInteger(ccr.ttlMs, 24 * 60 * 60 * 1000, 'ccr.ttlMs'),
      maxEntries: positiveInteger(ccr.maxEntries, 2000, 'ccr.maxEntries')
    })
  })
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-headroom',
    validate(value) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    }
  }
}

function textBlocksOf(blocks) {
  return blocks.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
}

function originalTextOf(blocks) {
  return textBlocksOf(blocks).map((block) => block.text).join('\n\n')
}

function toolId(exec) {
  return String(exec.callId ?? '')
}

function sessionId(exec) {
  return String(exec.agent?.id ?? '')
}

function makePostExecuteListener(config, ccrStore, logger) {
  const limits = resolveLimits(config)
  return async function postExecuteListener(exec, result, next) {
    const decision = await next()
    if (!config.enabled || !config.ccr.enabled) return decision
    if (result.isError && !config.includeErrors) return decision
    if (OWN_TOOL_NAMES.has(exec.name)) return decision
    if (config.excludeTools.length > 0 && isGlobMatch(exec.name, config.excludeTools)) return decision
    if (decision === null || typeof decision !== 'object') return decision
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision

    const sourceBlocks = decision.content ?? result.content
    if (!Array.isArray(sourceBlocks) || sourceBlocks.length === 0) return decision
    const textBlocks = textBlocksOf(sourceBlocks)
    const totalChars = textBlocks.reduce((total, block) => total + block.text.length, 0)
    if (totalChars < config.minChars) return decision

    try {
      const retrievalId = ccrStore.newId()
      const outcome = compressContentBlocks(sourceBlocks, {
        limits,
        retrievalId,
        withMarker: true
      })
      if (!outcome.changed) return decision

      ccrStore.put({
        id: retrievalId,
        toolName: exec.name,
        callId: toolId(exec),
        sessionId: sessionId(exec),
        strategy: outcome.strategy,
        originalChars: outcome.originalChars,
        compressedChars: outcome.compressedChars,
        originalText: originalTextOf(sourceBlocks)
      })

      return { ...decision, content: outcome.blocks }
    } catch (error) {
      logger.warn(`dsh-headroom: compressing "${exec.name}" output failed, leaving it unchanged: ${String(error)}`)
      return decision
    }
  }
}

function retrieveTool(ccrStore) {
  return defineTool({
    name: 'headroom_retrieve',
    description:
      'Retrieve the full original content of a tool output that dsh-headroom compressed. '
      + 'Call this only when you need exact bytes that a compressed tool result omitted. '
      + 'The id is printed in the [headroom: …] marker inside the compressed result.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'The retrieval id from a compressed tool result marker, e.g. hr:0123456789abcdef.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          found: { type: 'boolean', required: true },
          content: { type: 'string' },
          toolName: { type: 'string' },
          originalChars: { type: 'integer' },
          compressedChars: { type: 'integer' }
        }
      },
      render: (_args, value) => {
        if (!value.found) {
          return [{ type: 'text', text: `Headroom retrieval id "${value.id}" was not found or has expired.` }]
        }
        return [{ type: 'text', text: value.content }]
      }
    },
    execute: async (args) => {
      const entry = ccrStore.get(args.id)
      if (entry === undefined) return { id: args.id, found: false }
      return {
        id: args.id,
        found: true,
        content: entry.originalText,
        toolName: entry.toolName,
        originalChars: entry.originalChars,
        compressedChars: entry.compressedChars
      }
    }
  })
}

function compressTool(config) {
  const limits = resolveLimits(config)
  return defineTool({
    name: 'headroom_compress',
    description:
      'Compress a single text block with the dsh-headroom content router. '
      + 'Useful before embedding a large document or tool output into a prompt. '
      + 'Returns the compressed text and the strategy used; no original is stored.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The exact text to compress.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          compressed: { type: 'string', required: true },
          strategy: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
          originalChars: { type: 'integer', required: true },
          compressedChars: { type: 'integer', required: true }
        }
      },
      render: (_args, value) => {
        if (!value.changed) {
          return [{ type: 'text', text: `No compression applied (strategy: none, ${value.originalChars} chars).` }]
        }
        return [{
          type: 'text',
          text: `Compressed with ${value.strategy} (${value.originalChars}→${value.compressedChars} chars).\n\n${value.compressed}`
        }]
      }
    },
    execute: async (args) => {
      const outcome = compressTextBlock(args.text, { limits, withMarker: false })
      return {
        compressed: outcome.text,
        strategy: outcome.strategy,
        changed: outcome.changed,
        originalChars: outcome.originalChars,
        compressedChars: outcome.compressedChars
      }
    }
  })
}

function statsTool(ccrStore) {
  return defineTool({
    name: 'headroom_stats',
    description: 'Report dsh-headroom compression statistics for the current process.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          compressedCalls: { type: 'integer', required: true },
          originalChars: { type: 'integer', required: true },
          compressedChars: { type: 'integer', required: true },
          savedChars: { type: 'integer', required: true },
          storeEntries: { type: 'integer', required: true }
        }
      },
      render: (_args, value) => {
        const ratio = value.originalChars > 0
          ? Math.round((value.savedChars / value.originalChars) * 1000) / 10
          : 0
        return [{
          type: 'text',
          text: `dsh-headroom stats: ${value.compressedCalls} tool outputs compressed, ${value.originalChars}→${value.compressedChars} chars (${ratio}% saved), ${value.storeEntries} retrievable originals in the CCR store.`
        }]
      }
    },
    execute: async () => ccrStore.stats()
  })
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console
  const ccrStore = createCcrStore({
    ...config.ccr,
    logger
  })
  await ccrStore.init()

  const disposers = []
  try {
    ctx.on('tools/post-execute', makePostExecuteListener(config, ccrStore, logger))
    disposers.push(ctx.tools.register(retrieveTool(ccrStore)))
    disposers.push(ctx.tools.register(compressTool(config)))
    disposers.push(ctx.tools.register(statsTool(ccrStore)))
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* noop */ }
    }
    throw error
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* noop */ }
    }
    ccrStore.dispose()
  }, 'dsh-headroom: post-execute compression + CCR tools')
}

export { compressContentBlocks, compressTextBlock, estimateTokens, globToRegExp, isGlobMatch } from './compress.js'
export { createCcrStore } from './ccr.js'

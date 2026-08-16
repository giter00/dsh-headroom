/**
 * dsh-headroom CCR (Compressed Context Retrieval) store.
 *
 * Headroom's reversible-compression idea, adapted to the dsh plugin model:
 * every lossy compression stores the exact original in a small local JSON
 * store and injects a retrieval marker. The model can call
 * `headroom_retrieve` to pull the original back on demand.
 *
 * The store is in-memory first (the hot path is synchronous) and is persisted
 * to `<DSH_HOME>/storages/dsh-headroom-ccr.json` on a short debounce. This is
 * best-effort durability, not a replacement for the session log.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STORE_VERSION = 1

function defaultStorePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-headroom-ccr.json')
}

function isEntryUsable(entry, now) {
  if (entry === null || typeof entry !== 'object') return false
  if (typeof entry.id !== 'string' || entry.id.length === 0) return false
  if (typeof entry.storedAt !== 'number' || !Number.isFinite(entry.storedAt)) return false
  if (typeof entry.originalText !== 'string') return false
  if (typeof entry.toolName !== 'string') return false
  return entry.expiresAt === undefined || (Number.isFinite(entry.expiresAt) && entry.expiresAt > now)
}

function serializeStore(store) {
  return {
    version: STORE_VERSION,
    entries: [...store.map.entries()].map(([id, entry]) => ({ id, ...entry }))
  }
}

function deserializeStore(payload, now, maxEntries) {
  const map = new Map()
  if (payload === null || typeof payload !== 'object') return map
  if (payload.version !== STORE_VERSION || !Array.isArray(payload.entries)) return map
  for (const entry of payload.entries.slice(-maxEntries)) {
    if (!isEntryUsable(entry, now)) continue
    map.set(entry.id, {
      toolName: entry.toolName,
      callId: entry.callId ?? '',
      sessionId: entry.sessionId ?? '',
      strategy: entry.strategy ?? '',
      originalChars: entry.originalChars ?? entry.originalText.length,
      compressedChars: entry.compressedChars ?? 0,
      originalText: entry.originalText,
      storedAt: entry.storedAt,
      expiresAt: entry.expiresAt
    })
  }
  return map
}

/**
 * @param {{ enabled?: boolean, persist?: boolean, ttlMs?: number, maxEntries?: number, storePath?: string, logger?: { warn: (msg: string) => void } }} options
 */
export function createCcrStore(options = {}) {
  const enabled = options.enabled !== false
  const persist = enabled && options.persist !== false
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 24 * 60 * 60 * 1000
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 2000
  const storePath = typeof options.storePath === 'string' && options.storePath.length > 0
    ? options.storePath
    : defaultStorePath()
  const logger = options.logger ?? console

  const map = new Map()
  let ready = null
  let saveTimer = null
  let dirty = false

  async function load() {
    const now = Date.now()
    try {
      const raw = await readFile(storePath, 'utf8')
      const parsed = JSON.parse(raw)
      const loaded = deserializeStore(parsed, now, maxEntries)
      for (const [id, entry] of loaded) map.set(id, entry)
    } catch {
      /* first run, missing file, or corrupt store — start empty */
    }
  }

  function scheduleSave() {
    if (!persist || saveTimer !== null) return
    dirty = true
    saveTimer = setTimeout(() => {
      saveTimer = null
      void save()
    }, 1000)
    saveTimer?.unref?.()
  }

  let saveChain = Promise.resolve()

  async function save() {
    saveChain = saveChain.then(async () => {
      if (!persist || !dirty) return
      dirty = false
      const payload = serializeStore({ map })
      try {
        await mkdir(dirname(storePath), { recursive: true })
        const tmp = `${storePath}.tmp`
        await writeFile(tmp, JSON.stringify(payload), 'utf8')
        await rename(tmp, storePath)
      } catch (error) {
        logger.warn(`dsh-headroom: saving CCR store failed: ${String(error)}`)
      }
    })
    await saveChain
  }

  function pruneLocked() {
    const now = Date.now()
    for (const [id, entry] of map) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) map.delete(id)
    }
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  function newId() {
    const digest = createHash('sha256')
      .update(`${randomUUID()}:${Date.now()}:${map.size}`)
      .digest('hex')
    return `hr:${digest.slice(0, 16)}`
  }

  function put(entry) {
    const id = entry.id ?? newId()
    const storedAt = Date.now()
    const record = {
      toolName: entry.toolName,
      callId: entry.callId ?? '',
      sessionId: entry.sessionId ?? '',
      strategy: entry.strategy ?? '',
      originalChars: entry.originalChars ?? entry.originalText.length,
      compressedChars: entry.compressedChars ?? 0,
      originalText: entry.originalText,
      storedAt,
      expiresAt: storedAt + ttlMs
    }
    map.set(id, record)
    pruneLocked()
    scheduleSave()
    return id
  }

  function get(id) {
    const entry = map.get(id)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      map.delete(id)
      scheduleSave()
      return undefined
    }
    return entry
  }

  function stats() {
    let compressedCalls = 0
    let originalChars = 0
    let compressedChars = 0
    for (const entry of map.values()) {
      compressedCalls += 1
      originalChars += entry.originalChars
      compressedChars += entry.compressedChars
    }
    return {
      compressedCalls,
      originalChars,
      compressedChars,
      savedChars: originalChars - compressedChars,
      storeEntries: map.size
    }
  }

  async function init() {
    if (ready === null) {
      ready = enabled ? load() : Promise.resolve()
      await ready
    }
    return store
  }

  async function flush() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await save()
  }

  function dispose() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    void save()
  }

  const store = { init, newId, put, get, stats, flush, dispose, get size() { return map.size } }
  return store
}

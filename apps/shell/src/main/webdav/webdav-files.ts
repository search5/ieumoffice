/**
 * WebDAV files on this PC: a file opens as a local copy in the data folder's
 * `webdav-cache`, any editor saves it like a normal file, and a watcher on
 * that folder uploads each save back to the server. It follows the shape of
 * the Drive copies (`drive-files.ts`) with the server's entity tag in place
 * of Drive's content hash:
 *
 * - The write carries `If-Match` with the tag the copy was made from, so a
 *   file someone else changed is never overwritten silently. The person
 *   chooses: overwrite, save a copy beside it, or keep the change on this PC.
 * - A save that could not go up stays on this PC and is retried: later in
 *   this run, when the server comes back, and at the next start.
 */
import { createHash } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { MAX_OPEN_BYTES, localFileName, openPlan, uploadMime } from '@genoffice/google-drive'
import type { DavError, Validator, WebDavClient } from '@genoffice/webdav'
import { atomicWriteFile } from '../atomic-write'

export interface WebDavCacheEntry {
  /** server id and the file's path on it: the identity of the copy */
  serverId: string
  remotePath: string
  name: string
  localPath: string
  /** hash of the bytes the server holds for this copy as of the last download or upload */
  syncedSha: string
  /** what the server held then */
  validator: Validator
  /** the person chose to keep this copy's changes on this PC only */
  detached: boolean
  /** epoch ms of the last open, for pruning */
  openedAt: number
}

export type WebDavQuestion =
  | { kind: 'changed'; name: string }
  | { kind: 'read-only'; name: string }
  | { kind: 'gone'; name: string }

export type WebDavAnswer = 'overwrite' | 'copy' | 'local'

export type WebDavNotice =
  { kind: 'saved-copy'; name: string; copyName: string } | { kind: 'upload-failed'; name: string }

export interface WebDavFilesDeps {
  /** the client for a server, or null when it is gone or has no password */
  client: (serverId: string) => WebDavClient | null
  cacheDir: string
  openPath: (path: string) => boolean
  isOpen: (path: string) => boolean
  ask: (question: WebDavQuestion) => Promise<WebDavAnswer>
  notify: (notice: WebDavNotice) => void
  /** "{name} (copy)" in the UI language */
  copyName: (name: string) => string
  debounceMs?: number
  retryDelaysMs?: readonly number[]
  now?: () => number
  /** test seam: the folder watcher */
  watch?: (dir: string, onChange: (path: string) => void) => () => void
}

export type WebDavOpenOutcome =
  { ok: true } | { ok: false; kind: DavError['kind'] | 'unsupported' | 'disk' }

const INDEX_FILE = 'index.json'
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_RETRIES = [30_000, 2 * 60_000, 10 * 60_000]
const COPY_TRIES = 9

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function samePath(a: string, b: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

function keyOf(serverId: string, remotePath: string): string {
  return `${serverId}\n${remotePath}`
}

function defaultWatch(dir: string, onChange: (path: string) => void): () => void {
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(dir, { recursive: true }, (_event, file) => {
      if (file) onChange(join(dir, file.toString()))
    })
    watcher.on('error', () => {})
  } catch {
    // no watcher: saves still go up at the next start
  }
  return () => watcher?.close()
}

/** "name.docx" → "name (copy).docx" style names with a counter after the first try */
function numbered(name: string, attempt: number): string {
  if (attempt === 0) return name
  const dot = name.lastIndexOf('.')
  return dot > 0
    ? `${name.slice(0, dot)} (${attempt + 1})${name.slice(dot)}`
    : `${name} (${attempt + 1})`
}

export class WebDavFiles {
  private entries = new Map<string, WebDavCacheEntry>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = new Map<string, Promise<void>>()
  private rerun = new Set<string>()
  private failures = new Map<string, number>()
  private unwatch: (() => void) | null = null
  private loaded: Promise<void> | null = null

  constructor(private readonly deps: WebDavFilesDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  start(): Promise<void> {
    this.loaded ??= (async () => {
      await mkdir(this.deps.cacheDir, { recursive: true })
      try {
        const raw = JSON.parse(await readFile(join(this.deps.cacheDir, INDEX_FILE), 'utf8')) as {
          entries?: WebDavCacheEntry[]
        }
        for (const entry of raw.entries ?? []) {
          if (
            entry &&
            typeof entry.serverId === 'string' &&
            typeof entry.remotePath === 'string' &&
            this.inCache(entry.localPath)
          ) {
            this.entries.set(keyOf(entry.serverId, entry.remotePath), entry)
          }
        }
      } catch {
        // no index yet
      }
      await this.prune()
      this.unwatch = (this.deps.watch ?? defaultWatch)(this.deps.cacheDir, (path) =>
        this.changed(path),
      )
      for (const key of this.entries.keys()) void this.syncIfChanged(key)
    })()
    return this.loaded
  }

  stop(): void {
    this.unwatch?.()
    this.unwatch = null
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** A server came back or got its password: try every save still waiting on it */
  reconnected(serverId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.serverId !== serverId) continue
      this.failures.delete(key)
      void this.syncIfChanged(key)
    }
  }

  /** A server was removed: its copies stay readable on disk but are never sent anywhere */
  async forget(serverId: string): Promise<void> {
    await this.start()
    for (const [key, entry] of [...this.entries]) {
      if (entry.serverId !== serverId) continue
      clearTimeout(this.timers.get(key))
      this.timers.delete(key)
      this.entries.delete(key)
      if (!this.deps.isOpen(entry.localPath)) {
        await rm(dirname(entry.localPath), { recursive: true, force: true }).catch(() => {})
      }
    }
    await this.saveIndex()
  }

  entryFor(path: string): WebDavCacheEntry | undefined {
    for (const entry of this.entries.values()) if (samePath(entry.localPath, path)) return entry
    return undefined
  }

  /** a path inside the cache folder (anything else is never touched) */
  inCache(path: unknown): path is string {
    if (typeof path !== 'string' || !path) return false
    const rel = relative(resolve(this.deps.cacheDir), resolve(path))
    const up = rel === '..' || rel.startsWith(`..${sep}`) || (sep === '\\' && rel.startsWith('../'))
    return Boolean(rel) && !up && !isAbsolute(rel)
  }

  private async saveIndex(): Promise<void> {
    const body = JSON.stringify({ entries: [...this.entries.values()] }, null, 2)
    await atomicWriteFile(join(this.deps.cacheDir, INDEX_FILE), Buffer.from(body, 'utf8')).catch(
      () => {},
    )
  }

  private async localSha(entry: WebDavCacheEntry): Promise<string | null> {
    try {
      return sha(await readFile(entry.localPath))
    } catch {
      return null
    }
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - PRUNE_AFTER_MS
    for (const [key, entry] of [...this.entries]) {
      const exists = existsSync(entry.localPath)
      const stale = entry.openedAt < cutoff && !this.deps.isOpen(entry.localPath)
      if (exists && !stale) continue
      if (exists && (await this.localSha(entry)) !== entry.syncedSha && !entry.detached) continue
      this.entries.delete(key)
      await rm(dirname(entry.localPath), { recursive: true, force: true }).catch(() => {})
    }
    await this.saveIndex()
  }

  /** Open a server file: fetch it unless the local copy is current or holds unsent changes */
  async open(
    serverId: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<WebDavOpenOutcome> {
    await this.start()
    const client = this.deps.client(serverId)
    if (!client) return { ok: false, kind: 'not-connected' }
    const meta = await client.stat(remotePath, signal)
    if (!meta.ok) return meta
    const { entry: file } = meta
    if (file.isCollection) return { ok: false, kind: 'unsupported' }
    const plan = openPlan({ name: file.name, mimeType: '' })
    if (plan.kind !== 'download') return { ok: false, kind: 'unsupported' }

    const key = keyOf(serverId, remotePath)
    const existing = this.entries.get(key)
    if (existing && existsSync(existing.localPath)) {
      const dirty = (await this.localSha(existing)) !== existing.syncedSha
      const current =
        existing.validator.etag !== null && file.etag !== null
          ? existing.validator.etag === file.etag
          : existing.validator.modified !== '' && existing.validator.modified === file.modified
      if (this.deps.isOpen(existing.localPath) || dirty || current) {
        existing.openedAt = this.now()
        await this.saveIndex()
        if (dirty && !existing.detached) void this.syncIfChanged(key)
        return this.deps.openPath(existing.localPath) ? { ok: true } : { ok: false, kind: 'disk' }
      }
    }

    const got = await client.download(remotePath, MAX_OPEN_BYTES, signal)
    if (!got.ok) return got
    const folder = join(
      this.deps.cacheDir,
      serverId.replace(/[^A-Za-z0-9_-]/g, '_'),
      createHash('sha256').update(remotePath).digest('hex').slice(0, 24),
    )
    const localPath = join(folder, localFileName(file.name, plan.extension))
    try {
      await mkdir(folder, { recursive: true })
      if (existing && !samePath(existing.localPath, localPath)) {
        await unlink(existing.localPath).catch(() => {})
      }
      await atomicWriteFile(localPath, got.bytes)
    } catch {
      return { ok: false, kind: 'disk' }
    }
    // the tag of the download itself; the listing's is the fallback for servers that send none
    const validator: Validator = {
      etag: got.validator.etag ?? file.etag,
      modified: got.validator.modified || file.modified,
      size: got.bytes.byteLength,
    }
    this.entries.set(key, {
      serverId,
      remotePath,
      name: file.name,
      localPath,
      syncedSha: sha(got.bytes),
      validator,
      detached: false,
      openedAt: this.now(),
    })
    await this.saveIndex()
    return this.deps.openPath(localPath) ? { ok: true } : { ok: false, kind: 'disk' }
  }

  private changed(path: string): void {
    const entry = this.entryFor(path)
    if (!entry || entry.detached) return
    const key = keyOf(entry.serverId, entry.remotePath)
    clearTimeout(this.timers.get(key))
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        void this.syncIfChanged(key)
      }, this.deps.debounceMs ?? 2_500),
    )
  }

  /** One upload at a time per file; a save during an upload runs another pass after it */
  syncIfChanged(key: string): Promise<void> {
    const pending = this.running.get(key)
    if (pending) {
      this.rerun.add(key)
      return pending
    }
    const run = this.syncOnce(key)
      .catch(() => {})
      .finally(() => {
        this.running.delete(key)
        if (this.rerun.delete(key)) void this.syncIfChanged(key)
      })
    this.running.set(key, run)
    return run
  }

  private retryLater(key: string, entry: WebDavCacheEntry): void {
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRIES
    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)
    if (count === delays.length) this.deps.notify({ kind: 'upload-failed', name: entry.name })
    const delay = delays[Math.min(count - 1, delays.length - 1)]!
    clearTimeout(this.timers.get(key))
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        void this.syncIfChanged(key)
      }, delay),
    )
  }

  private retryOrStop(key: string, entry: WebDavCacheEntry, error: DavError): void {
    // not-connected waits for reconnected()
    if (error.kind === 'not-connected') return
    if (error.kind === 'too-large') {
      this.deps.notify({ kind: 'upload-failed', name: entry.name })
      return
    }
    this.retryLater(key, entry)
  }

  private async syncOnce(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry || entry.detached) return
    let bytes: Uint8Array
    try {
      if (!(await stat(entry.localPath)).isFile()) return
      bytes = await readFile(entry.localPath)
    } catch {
      return
    }
    const hash = sha(bytes)
    if (hash === entry.syncedSha) return
    const client = this.deps.client(entry.serverId)
    // no client: wait for reconnected()
    if (!client) return
    const mime = uploadMime(entry.localPath)

    let put = await client.upload(entry.remotePath, bytes, mime, { expect: entry.validator })
    if (!put.ok && put.kind === 'changed') {
      // a failed If-Match is also what a missing file answers: look which it is
      const now = await client.stat(entry.remotePath)
      const gone = !now.ok && now.kind === 'not-found'
      const answer = await this.ask(
        gone ? { kind: 'gone', name: entry.name } : { kind: 'changed', name: entry.name },
        gone,
      )
      if (answer === 'local') {
        entry.detached = true
        await this.saveIndex()
        return
      }
      if (answer === 'copy') {
        await this.saveCopy(key, entry, client, bytes, mime, hash)
        return
      }
      put = await client.upload(entry.remotePath, bytes, mime, {})
    } else if (!put.ok && (put.kind === 'forbidden' || put.kind === 'conflict')) {
      const answer = await this.ask(
        put.kind === 'forbidden'
          ? { kind: 'read-only', name: entry.name }
          : { kind: 'gone', name: entry.name },
        true,
      )
      if (answer !== 'copy') {
        entry.detached = true
        await this.saveIndex()
        return
      }
      await this.saveCopy(key, entry, client, bytes, mime, hash)
      return
    }
    if (!put.ok) return this.retryOrStop(key, entry, put)
    entry.validator = put.validator
    entry.syncedSha = hash
    this.failures.delete(key)
    await this.saveIndex()
  }

  /** "overwrite" is only offered for a file that still exists and is only changed */
  private async ask(question: WebDavQuestion, noOverwrite: boolean): Promise<WebDavAnswer> {
    const answer = await this.deps.ask(question)
    return answer === 'overwrite' && noOverwrite ? 'local' : answer
  }

  /** The change goes up as a new file beside the original; the copy becomes this PC copy's target */
  private async saveCopy(
    key: string,
    entry: WebDavCacheEntry,
    client: WebDavClient,
    bytes: Uint8Array,
    mime: string,
    hash: string,
  ): Promise<void> {
    const folder = posix.dirname(entry.remotePath)
    const original = entry.name
    const base = this.deps.copyName(original)
    for (let attempt = 0; attempt < COPY_TRIES; attempt += 1) {
      const name = numbered(base, attempt)
      const path = posix.join(folder, name)
      const made = await client.upload(path, bytes, mime, { create: true })
      if (made.ok) {
        entry.remotePath = path
        entry.name = name
        entry.validator = made.validator
        entry.syncedSha = hash
        // the copy lives under a new key from now on
        this.entries.delete(key)
        this.entries.set(keyOf(entry.serverId, path), entry)
        this.failures.delete(key)
        await this.saveIndex()
        this.deps.notify({ kind: 'saved-copy', name: original, copyName: name })
        return
      }
      // the name is taken: try the next number
      if (made.kind !== 'changed') {
        this.retryOrStop(key, entry, made)
        return
      }
    }
    this.deps.notify({ kind: 'upload-failed', name: entry.name })
  }

  /** test seam: the entries as stored */
  snapshot(): WebDavCacheEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }))
  }
}

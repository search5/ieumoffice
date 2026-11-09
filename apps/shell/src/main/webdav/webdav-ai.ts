/**
 * What the editors' AI gets from WebDAV (decision 0118): a folder listing, a
 * file-name search that walks a few levels of folders, and a paged read of one
 * file's text. A read downloads the file to a private temporary folder, parses
 * it with parseFileToText (so parts hidden from AI stay hidden, decision
 * 0016) and deletes the download. Parsed text is kept in memory for a few
 * minutes so paging does not download again.
 *
 * Nothing here writes: the AI has no way to change, delete or upload.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_READ_BYTES, localFileName, openPlan } from '@genoffice/google-drive'
import type { DavError, DavResource, WebDavClient } from '@genoffice/webdav'
import { entryType, type AiResult, type ParseToText } from '../drive/drive-ai'

export const WEBDAV_READ_CHUNK_CHARS = 24_000
const TEXT_CACHE_MS = 10 * 60 * 1000
const TEXT_CACHE_MAX = 4

/** How far a name search walks: deep enough for a tidy share, bounded for a huge one */
export const SEARCH_MAX_DEPTH = 4
export const SEARCH_MAX_FOLDERS = 80
export const SEARCH_MAX_VISITED = 5000
const SEARCH_BUDGET_MS = 25_000
const SEARCH_PARALLEL = 4
const LIST_MAX_ENTRIES = 200

export interface WebDavAiServer {
  id: string
  name: string
}

export interface WebDavAiDeps {
  /** the servers the AI may use: connected and holding a password if one is needed */
  servers: () => WebDavAiServer[]
  client: (serverId: string) => WebDavClient | null
  parse: ParseToText
  now?: () => number
}

export interface AiEntry {
  path: string
  name: string
  type: string
  modified: string
  size?: number
}

export interface AiHit extends AiEntry {
  server: string
  serverName: string
}

/** The model reads these; English, short, no file content */
const ERROR_TEXT: Record<
  DavError['kind'] | 'unsupported' | 'unreadable' | 'folder' | 'server',
  string
> = {
  'not-connected': 'The WebDAV server refused the sign-in.',
  'not-found': 'No such file or folder on that WebDAV server.',
  forbidden: 'This account may not do that on the WebDAV server.',
  'too-large': 'The file is too large to read here.',
  changed: 'The file changed while it was read; try again.',
  conflict: 'The folder is not there.',
  locked: 'Another user has locked the file.',
  'rate-limit': 'The WebDAV server asked to slow down; try again shortly.',
  network: 'The WebDAV server could not be reached.',
  unsupported: 'That kind of file cannot be read as text.',
  unreadable: 'The file could not be read as text.',
  folder: 'That is a folder; list it with webdav_list or search inside it with webdav_search.',
  server: 'No such WebDAV server. Call webdav_list with no arguments to see the connected ones.',
}

function normalizePath(raw: string): string | null {
  const path = raw.trim() || '/'
  if (path.length > 2000 || path.includes('\0')) return null
  const clean = path.startsWith('/') ? path : `/${path}`
  return clean.split('/').includes('..') ? null : clean
}

function toEntry(item: DavResource): AiEntry {
  const entry: AiEntry = {
    path: item.path,
    name: item.name,
    type: item.isCollection ? 'folder' : entryType({ name: item.name, mimeType: '' }),
    modified: item.modified,
  }
  if (item.size !== undefined) entry.size = item.size
  return entry
}

const fold = (text: string) => text.normalize('NFC').toLowerCase()

export class WebDavAi {
  private texts = new Map<string, { version: string; name: string; text: string; at: number }>()

  constructor(private readonly deps: WebDavAiDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** A server by id, or by name when the model gave the name and it is unambiguous */
  private resolve(ref: string): { server: WebDavAiServer; client: WebDavClient } | null {
    const all = this.deps.servers()
    const wanted = ref.trim()
    let server = all.find((s) => s.id === wanted)
    if (!server) {
      const byName = all.filter((s) => fold(s.name) === fold(wanted))
      if (byName.length === 1) server = byName[0]
    }
    const client = server ? this.deps.client(server.id) : null
    return server && client ? { server, client } : null
  }

  async list(
    serverRef: string,
    rawPath: string,
  ): Promise<AiResult<{ servers?: WebDavAiServer[]; entries?: AiEntry[] }>> {
    if (!serverRef.trim()) return { ok: true, servers: this.deps.servers() }
    const found = this.resolve(serverRef)
    const path = normalizePath(rawPath)
    if (!found) return { ok: false, error: ERROR_TEXT.server }
    if (!path) return { ok: false, error: ERROR_TEXT['not-found'] }
    const result = await found.client.list(path)
    if (!result.ok) return { ok: false, error: ERROR_TEXT[result.kind] }
    return { ok: true, entries: result.entries.slice(0, LIST_MAX_ENTRIES).map(toEntry) }
  }

  /**
   * File names that contain every word of the query, walking down from the
   * start folder on one server or on all. Breadth first, a few levels and a
   * bounded number of folders and entries; `incomplete` tells the model the
   * walk stopped before it covered everything.
   */
  async search(
    query: string,
    serverRef: string,
    rawPath: string,
    limit: number,
  ): Promise<AiResult<{ hits: AiHit[]; incomplete: boolean }>> {
    const words = fold(query.trim().slice(0, 200)).split(/\s+/).filter(Boolean)
    if (words.length === 0) return { ok: false, error: 'query must not be empty' }
    const path = normalizePath(rawPath)
    if (!path) return { ok: false, error: ERROR_TEXT['not-found'] }
    let targets: { server: WebDavAiServer; client: WebDavClient }[]
    if (serverRef.trim()) {
      const found = this.resolve(serverRef)
      if (!found) return { ok: false, error: ERROR_TEXT.server }
      targets = [found]
    } else {
      targets = this.deps
        .servers()
        .map((s) => this.resolve(s.id))
        .filter((t): t is NonNull => t !== null)
    }
    if (targets.length === 0) return { ok: false, error: ERROR_TEXT.server }

    const hits: AiHit[] = []
    let incomplete = false
    let folders = 0
    let visited = 0
    let firstError: string | null = null
    const deadline = AbortSignal.timeout(SEARCH_BUDGET_MS)

    for (const { server, client } of targets) {
      let level: string[] = [path]
      for (let depth = 0; depth <= SEARCH_MAX_DEPTH && level.length > 0; depth += 1) {
        const next: string[] = []
        for (let i = 0; i < level.length; i += SEARCH_PARALLEL) {
          if (deadline.aborted || folders >= SEARCH_MAX_FOLDERS || hits.length >= limit) {
            incomplete = true
            break
          }
          const batch = level.slice(i, i + SEARCH_PARALLEL).slice(0, SEARCH_MAX_FOLDERS - folders)
          folders += batch.length
          const results = await Promise.all(batch.map((p) => client.list(p, deadline)))
          for (const result of results) {
            if (!result.ok) {
              firstError ??= ERROR_TEXT[result.kind]
              continue
            }
            for (const item of result.entries) {
              visited += 1
              if (item.name.startsWith('.')) continue
              if (item.isCollection) next.push(item.path)
              const name = fold(item.name)
              if (words.every((w) => name.includes(w)) && hits.length < limit) {
                hits.push({ ...toEntry(item), server: server.id, serverName: server.name })
              }
            }
            if (visited >= SEARCH_MAX_VISITED) incomplete = true
          }
          if (visited >= SEARCH_MAX_VISITED) break
        }
        if (incomplete) break
        if (depth === SEARCH_MAX_DEPTH && next.length > 0) incomplete = true
        level = next
      }
      if (incomplete && (hits.length >= limit || deadline.aborted)) break
    }
    // every folder failed: say why instead of an empty answer
    if (hits.length === 0 && folders > 0 && firstError && visited === 0) {
      return { ok: false, error: firstError }
    }
    return { ok: true, hits, incomplete }
  }

  async read(
    serverRef: string,
    rawPath: string,
    offset: number,
  ): Promise<
    AiResult<{ page: { name: string; text: string; totalChars: number; offset: number } }>
  > {
    const loaded = await this.text(serverRef, rawPath)
    if (!loaded.ok) return loaded
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
    return {
      ok: true,
      page: {
        name: loaded.name,
        text: loaded.text.slice(start, start + WEBDAV_READ_CHUNK_CHARS),
        totalChars: loaded.text.length,
        offset: start,
      },
    }
  }

  private async text(
    serverRef: string,
    rawPath: string,
  ): Promise<AiResult<{ name: string; text: string }>> {
    const found = this.resolve(serverRef)
    const path = normalizePath(rawPath)
    if (!found) return { ok: false, error: ERROR_TEXT.server }
    if (!path) return { ok: false, error: ERROR_TEXT['not-found'] }
    const { server, client } = found
    const meta = await client.stat(path)
    if (!meta.ok) return { ok: false, error: ERROR_TEXT[meta.kind] }
    const file = meta.entry
    if (file.isCollection) return { ok: false, error: ERROR_TEXT.folder }
    const key = `${server.id}\n${path}`
    const version = `${file.etag ?? ''}|${file.modified}|${file.size ?? ''}`
    const cached = this.texts.get(key)
    if (cached && cached.version === version && this.now() - cached.at < TEXT_CACHE_MS) {
      return { ok: true, name: cached.name, text: cached.text }
    }
    const plan = openPlan({ name: file.name, mimeType: '' })
    if (plan.kind !== 'download') return { ok: false, error: ERROR_TEXT.unsupported }
    const got = await client.download(path, MAX_READ_BYTES)
    if (!got.ok) return { ok: false, error: ERROR_TEXT[got.kind] }

    // the download lives only as long as the parse
    let dir: string | null = null
    try {
      dir = await mkdtemp(join(tmpdir(), 'ieumoffice-webdav-'))
      const local = join(dir, localFileName(file.name, plan.extension))
      await writeFile(local, got.bytes)
      const parsed = await this.deps.parse(local)
      if (!parsed.ok || parsed.kind !== 'text' || typeof parsed.text !== 'string') {
        return { ok: false, error: ERROR_TEXT.unreadable }
      }
      this.texts.set(key, { version, name: file.name, text: parsed.text, at: this.now() })
      while (this.texts.size > TEXT_CACHE_MAX) {
        this.texts.delete(this.texts.keys().next().value!)
      }
      return { ok: true, name: file.name, text: parsed.text }
    } catch {
      return { ok: false, error: ERROR_TEXT.unreadable }
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Forget everything read (when the AI switch goes off or a server goes away) */
  clear(): void {
    this.texts.clear()
  }
}

type NonNull = { server: WebDavAiServer; client: WebDavClient }

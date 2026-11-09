import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { differs, type DavError, type Validator, type WebDavClient } from '@genoffice/webdav'
import {
  WebDavFiles,
  type WebDavAnswer,
  type WebDavFilesDeps,
  type WebDavNotice,
  type WebDavQuestion,
} from '../src/main/webdav/webdav-files'

interface Remote {
  bytes: Buffer
  etag: string
  modified: string
}

/** A WebDAV server in memory with entity tags, honoring If-Match and If-None-Match */
class FakeServer {
  files = new Map<string, Remote>()
  puts: { path: string; text: string; create: boolean; expect?: Validator | undefined }[] = []
  failNext: DavError['kind'] | null = null
  private counter = 1

  put(path: string, text: string) {
    this.files.set(path, {
      bytes: Buffer.from(text),
      etag: `"e${this.counter++}"`,
      modified: '2026-11-01T00:00:00.000Z',
    })
  }

  client(): WebDavClient {
    const entryOf = (path: string, f: Remote) => ({
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      isCollection: false,
      size: f.bytes.byteLength,
      modified: f.modified,
      etag: f.etag,
    })
    return {
      stat: async (path: string) => {
        const f = this.files.get(path)
        return f ? { ok: true, entry: entryOf(path, f) } : { ok: false, kind: 'not-found' }
      },
      download: async (path: string) => {
        const f = this.files.get(path)
        if (!f) return { ok: false, kind: 'not-found' }
        return {
          ok: true,
          bytes: f.bytes,
          validator: { etag: f.etag, modified: f.modified, size: f.bytes.byteLength },
        }
      },
      upload: async (
        path: string,
        bytes: Uint8Array,
        _mime: string,
        options: { expect?: Validator; create?: boolean } = {},
      ) => {
        if (this.failNext) {
          const kind = this.failNext
          this.failNext = null
          return { ok: false, kind }
        }
        const existing = this.files.get(path)
        if (options.create && existing) return { ok: false, kind: 'changed' }
        if (options.expect) {
          if (!existing || differs(options.expect, entryOf(path, existing))) {
            return { ok: false, kind: 'changed' }
          }
        }
        this.puts.push({
          path,
          text: Buffer.from(bytes).toString(),
          create: options.create === true,
          expect: options.expect,
        })
        this.put(path, Buffer.from(bytes).toString())
        const f = this.files.get(path)!
        return {
          ok: true,
          validator: { etag: f.etag, modified: f.modified, size: f.bytes.byteLength },
        }
      },
    } as unknown as WebDavClient
  }
}

let dir: string
let server: FakeServer
let opened: string[]
let questions: WebDavQuestion[]
let notices: WebDavNotice[]
let answer: WebDavAnswer
let onChange: (path: string) => void

const keyOf = (path: string) => `s1\n${path}`

function service(over: Partial<WebDavFilesDeps> = {}): WebDavFiles {
  return new WebDavFiles({
    client: (id) => (id === 's1' ? server.client() : null),
    cacheDir: join(dir, 'webdav-cache'),
    openPath: (path) => {
      opened.push(path)
      return true
    },
    isOpen: () => false,
    ask: async (q) => {
      questions.push(q)
      return answer
    },
    notify: (n) => notices.push(n),
    copyName: (name) => `${name} (copy)`,
    debounceMs: 0,
    retryDelaysMs: [10, 10, 10],
    watch: (_dir, cb) => {
      onChange = cb
      return () => {}
    },
    ...over,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'webdav-files-'))
  server = new FakeServer()
  opened = []
  questions = []
  notices = []
  answer = 'copy'
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function save(files: WebDavFiles, path: string, text: string) {
  writeFileSync(path, text)
  onChange(path)
  await new Promise((r) => setTimeout(r, 5))
  const entry = files.entryFor(path)!
  await files.syncIfChanged(keyOf(entry.remotePath))
  // the watcher's own pass may still be finishing (the dialog answer, the index write)
  await new Promise((r) => setTimeout(r, 20))
}

describe('WebDavFiles.open', () => {
  it('downloads into the cache and opens the copy', async () => {
    server.put('/Reports/report.pdf', 'v1')
    const files = service()
    expect(await files.open('s1', '/Reports/report.pdf')).toEqual({ ok: true })
    expect(opened).toHaveLength(1)
    expect(readFileSync(opened[0]!, 'utf8')).toBe('v1')
    expect(files.inCache(opened[0])).toBe(true)
  })

  it('refuses folders, unknown formats and unknown servers', async () => {
    server.put('/a.bin', 'x')
    const files = service()
    expect(await files.open('s1', '/a.bin')).toEqual({ ok: false, kind: 'unsupported' })
    expect(await files.open('s1', '/missing.pdf')).toEqual({ ok: false, kind: 'not-found' })
    expect(await files.open('other', '/a.pdf')).toEqual({ ok: false, kind: 'not-connected' })
  })

  it('refreshes a stale copy but keeps one with unsent edits', async () => {
    server.put('/a.md', 'v1')
    const files = service()
    await files.open('s1', '/a.md')
    const path = opened[0]!
    server.put('/a.md', 'v2')
    await files.open('s1', '/a.md')
    expect(readFileSync(path, 'utf8')).toBe('v2')
    // an unsent local edit survives the next open
    writeFileSync(path, 'local edit')
    server.put('/a.md', 'v3')
    await files.open('s1', '/a.md')
    expect(readFileSync(path, 'utf8')).toBe('local edit')
  })
})

describe('WebDavFiles saves', () => {
  it('uploads a save with the tag the copy came from', async () => {
    server.put('/a.md', 'v1')
    const files = service()
    await files.start()
    await files.open('s1', '/a.md')
    const before = files.snapshot()[0]!.validator
    await save(files, opened[0]!, 'v2')
    expect(server.puts).toHaveLength(1)
    expect(server.puts[0]!.expect?.etag).toBe(before.etag)
    expect(server.files.get('/a.md')!.bytes.toString()).toBe('v2')
    expect(questions).toEqual([])
    // a second save goes against the new tag
    await save(files, opened[0]!, 'v3')
    expect(server.files.get('/a.md')!.bytes.toString()).toBe('v3')
  })

  it('asks before touching a file someone else changed, and saves a copy on request', async () => {
    server.put('/a.md', 'v1')
    const files = service()
    await files.start()
    await files.open('s1', '/a.md')
    server.put('/a.md', 'theirs')
    await save(files, opened[0]!, 'mine')
    expect(questions).toEqual([{ kind: 'changed', name: 'a.md' }])
    expect(server.files.get('/a.md')!.bytes.toString()).toBe('theirs')
    expect(server.files.get('/a.md (copy)')?.bytes.toString()).toBe('mine')
    expect(notices).toEqual([{ kind: 'saved-copy', name: 'a.md', copyName: 'a.md (copy)' }])
  })

  it('overwrites only when the person says so', async () => {
    server.put('/a.md', 'v1')
    answer = 'overwrite'
    const files = service()
    await files.start()
    await files.open('s1', '/a.md')
    server.put('/a.md', 'theirs')
    await save(files, opened[0]!, 'mine')
    expect(server.files.get('/a.md')!.bytes.toString()).toBe('mine')
  })

  it('keeps the change on this PC when asked, and stops uploading', async () => {
    server.put('/a.md', 'v1')
    answer = 'local'
    const files = service()
    await files.start()
    await files.open('s1', '/a.md')
    server.put('/a.md', 'theirs')
    await save(files, opened[0]!, 'mine')
    expect(server.files.get('/a.md')!.bytes.toString()).toBe('theirs')
    expect(files.snapshot()[0]!.detached).toBe(true)
    const puts = server.puts.length
    await save(files, opened[0]!, 'mine 2')
    expect(server.puts).toHaveLength(puts)
  })

  it('asks "gone" when the file was deleted and never offers overwrite', async () => {
    server.put('/a.md', 'v1')
    answer = 'overwrite'
    const files = service()
    await files.start()
    await files.open('s1', '/a.md')
    server.files.delete('/a.md')
    await save(files, opened[0]!, 'mine')
    expect(questions).toEqual([{ kind: 'gone', name: 'a.md' }])
    // an "overwrite" answer to a gone file is treated as keep-local
    expect(server.files.has('/a.md')).toBe(false)
    expect(files.snapshot()[0]!.detached).toBe(true)
  })

  it('numbers the copy when its name is taken', async () => {
    server.put('/a.md', 'v1')
    server.put('/a.md (copy)', 'older copy')
    const files = service()
    await files.start()
    await files.open('s1', '/a.md')
    server.put('/a.md', 'theirs')
    await save(files, opened[0]!, 'mine')
    expect(server.files.get('/a.md (copy)')!.bytes.toString()).toBe('older copy')
    expect(server.files.get('/a.md (copy) (2)')).toBeUndefined()
    expect([...server.files.keys()].some((p) => p.endsWith('(2).md') || p.includes('(2)'))).toBe(
      true,
    )
  })

  it('keeps the save and retries after a network failure', async () => {
    server.put('/a.md', 'v1')
    const files = service({ retryDelaysMs: [150, 150, 150] })
    await files.start()
    await files.open('s1', '/a.md')
    server.failNext = 'network'
    // only the watcher's pass runs here, so the failed upload is what the retry timer must redo
    writeFileSync(opened[0]!, 'v2')
    onChange(opened[0]!)
    await new Promise((r) => setTimeout(r, 60))
    expect(server.files.get('/a.md')!.bytes.toString()).toBe('v1')
    await new Promise((r) => setTimeout(r, 300))
    expect(server.files.get('/a.md')!.bytes.toString()).toBe('v2')
  })

  it('waits quietly while the server has no sign-in', async () => {
    server.put('/a.md', 'v1')
    let signedIn = true
    const files = service({ client: (id) => (id === 's1' && signedIn ? server.client() : null) })
    await files.start()
    await files.open('s1', '/a.md')
    signedIn = false
    await save(files, opened[0]!, 'v2')
    expect(server.puts).toHaveLength(0)
    signedIn = true
    files.reconnected('s1')
    await new Promise((r) => setTimeout(r, 20))
    expect(server.files.get('/a.md')!.bytes.toString()).toBe('v2')
  })

  it('forgets the copies of a removed server and never sends them', async () => {
    server.put('/a.md', 'v1')
    const files = service()
    await files.start()
    await files.open('s1', '/a.md')
    await files.forget('s1')
    expect(files.snapshot()).toEqual([])
  })
})

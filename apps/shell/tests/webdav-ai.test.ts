import { describe, expect, it } from 'vitest'
import type { DavResource, WebDavClient } from '@genoffice/webdav'
import { WebDavAi, WEBDAV_READ_CHUNK_CHARS, SEARCH_MAX_DEPTH } from '../src/main/webdav/webdav-ai'

type Tree = Record<string, DavResource[]>

const dir = (path: string): DavResource => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  isCollection: true,
  modified: '',
  etag: null,
})
const file = (path: string, size = 10): DavResource => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  isCollection: false,
  size,
  modified: '2026-11-01T00:00:00.000Z',
  etag: '"e1"',
})

function fakeClient(tree: Tree, contents: Record<string, string> = {}, calls: string[] = []) {
  return {
    list: async (path: string) => {
      calls.push(path)
      return tree[path] ? { ok: true, entries: tree[path] } : { ok: false, kind: 'not-found' }
    },
    stat: async (path: string) => {
      for (const entries of Object.values(tree)) {
        const hit = entries.find((e) => e.path === path)
        if (hit) return { ok: true, entry: hit }
      }
      return { ok: false, kind: 'not-found' }
    },
    download: async (path: string) =>
      path in contents
        ? { ok: true, bytes: Buffer.from(contents[path]!), validator: { etag: null, modified: '' } }
        : { ok: false, kind: 'not-found' },
  } as unknown as WebDavClient
}

function ai(tree: Tree, contents: Record<string, string> = {}, over: { calls?: string[] } = {}) {
  const client = fakeClient(tree, contents, over.calls)
  const parsed: string[] = []
  const service = new WebDavAi({
    servers: () => [{ id: 's1', name: 'Home NAS' }],
    client: (id) => (id === 's1' ? client : null),
    parse: async (path) => {
      parsed.push(path)
      const { readFileSync } = await import('node:fs')
      return { ok: true, kind: 'text', text: readFileSync(path, 'utf8') }
    },
  })
  return { service, parsed }
}

const TREE: Tree = {
  '/': [dir('/Reports'), dir('/.hidden'), file('/readme.md')],
  '/Reports': [dir('/Reports/2026'), file('/Reports/Q3 Minutes.docx')],
  '/Reports/2026': [file('/Reports/2026/minutes-nov.md'), file('/Reports/2026/photo.jpg')],
  '/.hidden': [file('/.hidden/minutes-secret.md')],
}

describe('WebDavAi.list', () => {
  it('lists servers with no server given and a folder otherwise', async () => {
    const { service } = ai(TREE)
    expect(await service.list('', '/')).toEqual({
      ok: true,
      servers: [{ id: 's1', name: 'Home NAS' }],
    })
    const folder = await service.list('s1', '/Reports')
    expect(folder.ok && folder.entries?.map((e) => [e.path, e.type])).toEqual([
      ['/Reports/2026', 'folder'],
      ['/Reports/Q3 Minutes.docx', 'document'],
    ])
  })

  it('accepts the server by name and refuses unknown servers and ".." paths', async () => {
    const { service } = ai(TREE)
    expect((await service.list('home nas', '/')).ok).toBe(true)
    expect(await service.list('nope', '/')).toMatchObject({ ok: false })
    expect(await service.list('s1', '/a/../etc')).toMatchObject({ ok: false })
  })
})

describe('WebDavAi.search', () => {
  it('finds file names across folders, needs every word, skips hidden folders', async () => {
    const { service } = ai(TREE)
    const result = await service.search('minutes', '', '/', 10)
    if (!result.ok) throw new Error(result.error)
    expect(result.hits.map((h) => h.path).sort()).toEqual([
      '/Reports/2026/minutes-nov.md',
      '/Reports/Q3 Minutes.docx',
    ])
    expect(result.hits[0]).toMatchObject({ server: 's1', serverName: 'Home NAS' })
    expect(result.incomplete).toBe(false)
    const both = await service.search('minutes nov', 's1', '/', 10)
    expect(both.ok && both.hits.map((h) => h.name)).toEqual(['minutes-nov.md'])
  })

  it('stops at the limit and says it did not cover everything', async () => {
    const { service } = ai(TREE)
    const result = await service.search('minutes', '', '/', 1)
    expect(result).toMatchObject({ ok: true, incomplete: true })
    expect(result.ok && result.hits).toHaveLength(1)
  })

  it('does not walk deeper than the limit', async () => {
    const tree: Tree = { '/': [dir('/d0')] }
    for (let i = 0; i <= SEARCH_MAX_DEPTH + 2; i += 1) {
      tree[`/d${i}`] = [dir(`/d${i + 1}`)]
    }
    const calls: string[] = []
    const { service } = ai(tree, {}, { calls })
    const result = await service.search('zzz', '', '/', 5)
    expect(result).toMatchObject({ ok: true, hits: [], incomplete: true })
    expect(calls.length).toBeLessThanOrEqual(SEARCH_MAX_DEPTH + 2)
  })

  it('reports why when no folder could be listed', async () => {
    const { service } = ai({})
    expect(await service.search('x', '', '/', 5)).toMatchObject({ ok: false })
  })
})

describe('WebDavAi.read', () => {
  it('parses the file, pages the text, and keeps no download behind', async () => {
    const text = 'a'.repeat(WEBDAV_READ_CHUNK_CHARS + 100)
    const { service, parsed } = ai(TREE, { '/readme.md': text })
    const first = await service.read('s1', '/readme.md', 0)
    expect(first).toMatchObject({ ok: true, page: { offset: 0, totalChars: text.length } })
    expect(first.ok && first.page.text).toHaveLength(WEBDAV_READ_CHUNK_CHARS)
    const second = await service.read('s1', '/readme.md', WEBDAV_READ_CHUNK_CHARS)
    expect(second.ok && second.page.text).toHaveLength(100)
    // the second page came from memory
    expect(parsed).toHaveLength(1)
    const { existsSync } = await import('node:fs')
    expect(existsSync(parsed[0]!)).toBe(false)
  })

  it('refuses folders, formats nobody reads, missing files and unknown servers', async () => {
    const { service } = ai(TREE, { '/Reports/2026/photo.jpg': 'x' })
    expect(await service.read('s1', '/Reports', 0)).toMatchObject({ ok: false })
    expect(await service.read('s1', '/Reports/2026/photo.jpg', 0)).toMatchObject({ ok: false })
    expect(await service.read('s1', '/missing.md', 0)).toMatchObject({ ok: false })
    expect(await service.read('zzz', '/readme.md', 0)).toMatchObject({ ok: false })
  })
})

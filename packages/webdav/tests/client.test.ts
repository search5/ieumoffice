import { describe, expect, it } from 'vitest'
import { WebDavClient, differs, parseServerUrl, type FetchLike } from '../src/client'
import { chooseScheme, digestHeader, parseDigestChallenge } from '../src/auth'
import { parseMultiStatus } from '../src/xml'

const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/files/me/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/files/me/Reports/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/files/me/%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C.docx</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>2048</d:getcontentlength>
      <d:getlastmodified>Mon, 09 Nov 2026 01:02:03 GMT</d:getlastmodified>
      <d:getetag>"abc&amp;1"</d:getetag>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    <d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
  </d:response>
</d:multistatus>`

function reply(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body || null, { status, headers })
}

describe('parseMultiStatus', () => {
  it('reads folders and files with any namespace prefix', () => {
    const list = parseMultiStatus(MULTISTATUS)
    expect(list.map((r) => [r.path, r.isCollection])).toEqual([
      ['/dav/files/me', true],
      ['/dav/files/me/Reports', true],
      ['/dav/files/me/한글 문서.docx', false],
    ])
    const file = list[2]!
    expect(file.name).toBe('한글 문서.docx')
    expect(file.size).toBe(2048)
    expect(file.etag).toBe('"abc&1"')
    expect(file.modified).toBe('2026-11-09T01:02:03.000Z')
  })

  it('reads responses without a prefix', () => {
    const xml =
      '<multistatus xmlns="DAV:"><response><href>/a.txt</href><propstat><prop>' +
      '<getcontentlength>3</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'
    expect(parseMultiStatus(xml)).toMatchObject([{ path: '/a.txt', size: 3, isCollection: false }])
  })

  it('skips an href that climbs out with ..', () => {
    const xml =
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a/../../etc</d:href></d:response></d:multistatus>'
    expect(parseMultiStatus(xml)).toEqual([])
  })

  it('does not resolve entities beyond the five XML ones', () => {
    const xml =
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:"><d:response>' +
      '<d:href>/x&e;.txt</d:href></d:response></d:multistatus>'
    expect(parseMultiStatus(xml)[0]?.path).toBe('/x&e;.txt')
  })
})

describe('parseServerUrl', () => {
  it('accepts http and https without credentials', () => {
    expect(parseServerUrl('https://cloud.example.com/remote.php/dav/files/me/')).toEqual({
      url: 'https://cloud.example.com/remote.php/dav/files/me',
      insecure: false,
    })
    expect(parseServerUrl('http://nas.local:5005')).toEqual({
      url: 'http://nas.local:5005',
      insecure: true,
    })
  })

  it('refuses other schemes, embedded credentials and junk', () => {
    expect(parseServerUrl('ftp://x.example.com')).toBeNull()
    expect(parseServerUrl('https://user:pw@x.example.com')).toBeNull()
    expect(parseServerUrl('not a url')).toBeNull()
  })
})

describe('auth', () => {
  it('chooses Digest over Basic', () => {
    expect(chooseScheme('Basic realm="x", Digest realm="x", nonce="n"')).toBe('digest')
    expect(chooseScheme('Basic realm="x"')).toBe('basic')
    expect(chooseScheme('Negotiate')).toBeNull()
  })

  it('matches the RFC 2617 example response', () => {
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    )!
    const header = digestHeader(
      challenge,
      { username: 'Mufasa', password: 'Circle Of Life' },
      { method: 'GET', uri: '/dir/index.html' },
      { nc: 1, cnonce: '0a4f113b' },
    )
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"')
    expect(header).toContain('nc=00000001')
  })
})

describe('differs', () => {
  it('compares tags first, then time and size', () => {
    expect(differs({ etag: '"a"', modified: '' }, { etag: '"b"', modified: '' })).toBe(true)
    expect(differs({ etag: '"a"', modified: '' }, { etag: '"a"', modified: 'x' })).toBe(false)
    expect(
      differs({ etag: null, modified: 't1', size: 1 }, { etag: null, modified: 't1', size: 2 }),
    ).toBe(true)
    expect(differs({ etag: null, modified: '', size: 1 }, { etag: null, modified: '' })).toBe(false)
  })
})

describe('WebDavClient', () => {
  const credentials = { username: 'me', password: 'secret' }
  const make = (fetch: FetchLike, creds = credentials) =>
    new WebDavClient({ baseUrl: 'https://h.example.com/dav/files/me', credentials: creds, fetch })

  it('answers a Basic challenge once, then signs ahead', async () => {
    const seen: (string | null)[] = []
    const client = make(async (_url, init) => {
      const auth = new Headers(init?.headers).get('Authorization')
      seen.push(auth)
      if (!auth) return reply(401, '', { 'WWW-Authenticate': 'Basic realm="x"' })
      return reply(207, MULTISTATUS)
    })
    expect((await client.check()).ok).toBe(true)
    expect((await client.list('/')).ok).toBe(true)
    expect(seen[0]).toBeNull()
    expect(seen[1]).toBe(`Basic ${Buffer.from('me:secret').toString('base64')}`)
    expect(seen[2]).toBe(seen[1])
  })

  it('reports refused credentials as not-connected without looping', async () => {
    let calls = 0
    const client = make(async () => {
      calls += 1
      return reply(401, '', { 'WWW-Authenticate': 'Basic realm="x"' })
    })
    expect(await client.check()).toEqual({ ok: false, kind: 'not-connected' })
    expect(calls).toBe(2)
  })

  it('answers a Digest challenge', async () => {
    const client = make(async (_url, init) => {
      const auth = new Headers(init?.headers).get('Authorization')
      if (!auth?.startsWith('Digest ')) {
        return reply(401, '', {
          'WWW-Authenticate': 'Digest realm="r", nonce="n1", qop="auth", algorithm=SHA-256',
        })
      }
      return reply(207, MULTISTATUS)
    })
    expect((await client.check()).ok).toBe(true)
  })

  it('lists entries relative to the connected folder, without the folder itself', async () => {
    const client = make(async () => reply(207, MULTISTATUS))
    const result = await client.list('/')
    if (!result.ok) throw new Error('list failed')
    expect(result.entries.map((e) => [e.path, e.name, e.isCollection])).toEqual([
      ['/Reports', 'Reports', true],
      ['/한글 문서.docx', '한글 문서.docx', false],
    ])
  })

  it('encodes names in the request address', async () => {
    const urls: string[] = []
    const client = make(async (url) => {
      urls.push(url)
      return reply(207, MULTISTATUS)
    })
    await client.stat('/한글 문서.docx')
    expect(urls[0]).toBe(
      'https://h.example.com/dav/files/me/%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C.docx',
    )
  })

  it('follows a redirect on the same server and refuses another one', async () => {
    let step = 0
    const same = make(async (url) => {
      step += 1
      if (step === 1) return reply(301, '', { Location: `${url}/` })
      return reply(207, MULTISTATUS)
    })
    expect((await same.list('/Reports')).ok).toBe(true)
    const other = make(async () => reply(302, '', { Location: 'https://evil.example.net/' }))
    expect(await other.list('/')).toEqual({ ok: false, kind: 'network' })
  })

  it('downloads with validators and refuses past the limit', async () => {
    const client = make(async () =>
      reply(200, 'hello', { ETag: '"e1"', 'Last-Modified': 'Mon, 09 Nov 2026 01:02:03 GMT' }),
    )
    const ok = await client.download('/a.txt', 100)
    expect(ok).toMatchObject({ ok: true, validator: { etag: '"e1"', size: 5 } })
    expect(await client.download('/a.txt', 3)).toEqual({ ok: false, kind: 'too-large' })
  })

  it('uploads with If-Match and reports a changed file', async () => {
    const sent: Record<string, string>[] = []
    const client = make(async (_url, init) => {
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value
      })
      if (init?.method === 'PUT') {
        sent.push(headers)
        return headers['if-match'] === '"old"' ? reply(412) : reply(204, '', { ETag: '"new"' })
      }
      return reply(207, MULTISTATUS)
    })
    const bytes = new Uint8Array([1, 2, 3])
    expect(
      await client.upload('/a.docx', bytes, 'x/y', { expect: { etag: '"old"', modified: '' } }),
    ).toEqual({
      ok: false,
      kind: 'changed',
    })
    const done = await client.upload('/a.docx', bytes, 'x/y', {
      expect: { etag: '"cur"', modified: '' },
    })
    expect(done.ok).toBe(true)
    expect(sent[1]?.['if-match']).toBe('"cur"')
  })

  it('looks first when the tag is weak or missing', async () => {
    let puts = 0
    const client = make(async (_url, init) => {
      if (init?.method === 'PUT') {
        puts += 1
        return reply(201)
      }
      return reply(207, MULTISTATUS)
    })
    const changed = await client.upload('/한글 문서.docx', new Uint8Array(1), 'x/y', {
      expect: { etag: 'W/"abc&1"', modified: '' },
    })
    // a weak tag cannot go into If-Match, so the server is asked first; the same tag means unchanged
    expect(changed.ok).toBe(true)
    const stale = await client.upload('/한글 문서.docx', new Uint8Array(1), 'x/y', {
      expect: { etag: null, modified: '2020-01-01T00:00:00.000Z' },
    })
    expect(stale).toEqual({ ok: false, kind: 'changed' })
    expect(puts).toBe(1)
  })

  it('creates only when the name is free', async () => {
    const headers: string[] = []
    const client = make(async (_url, init) => {
      if (init?.method === 'PUT') {
        headers.push(new Headers(init.headers).get('If-None-Match') ?? '')
        return reply(412)
      }
      return reply(207, MULTISTATUS)
    })
    expect(await client.upload('/a.docx', new Uint8Array(1), 'x/y', { create: true })).toEqual({
      ok: false,
      kind: 'changed',
    })
    expect(headers).toEqual(['*'])
  })
})

/**
 * The WebDAV calls the app makes. Every call takes its `fetch` from the
 * caller, so tests never reach a server. Calls do not throw: a failure is a
 * `DavError` with a kind the screen translates.
 *
 * Paths given to and returned by the client are relative to the folder the
 * person connected (`baseUrl`): '' or '/' is that folder, '/Reports/a.docx' a
 * file in it. Names are plain text; the client does the percent-encoding.
 */
import {
  basicHeader,
  chooseScheme,
  digestHeader,
  parseDigestChallenge,
  type AuthScheme,
  type Credentials,
  type DigestChallenge,
} from './auth'
import { PROPFIND_BODY, parseMultiStatus, type DavResource } from './xml'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000
const MAX_REDIRECTS = 5
/** A listing larger than this is not a listing the app wants to hold */
const MAX_LISTING_BYTES = 16 * 1024 * 1024

/**
 * not-connected: the server wants a sign-in the account could not give (or
 * the password was refused); not-found: the file or folder is gone;
 * forbidden: the account may see it but not do this; too-large: past the
 * app's limit or the server's quota; changed: the file on the server is no
 * longer the one this copy came from; conflict: a folder on the way is
 * missing; locked: another client holds a lock; rate-limit: the server asked
 * to slow down; network: anything else.
 */
export type DavErrorKind =
  | 'not-connected'
  | 'not-found'
  | 'forbidden'
  | 'too-large'
  | 'changed'
  | 'conflict'
  | 'locked'
  | 'rate-limit'
  | 'network'

export interface DavError {
  ok: false
  kind: DavErrorKind
}

export type DavResult<T> = ({ ok: true } & T) | DavError

/** What identifies the state of a file on the server at one moment */
export interface Validator {
  etag: string | null
  /** ISO time or '' */
  modified: string
  size?: number
}

export interface ServerUrl {
  /** origin and path, without query, fragment or trailing slash */
  url: string
  /** the connection is plain HTTP: the password and the files cross the network readable */
  insecure: boolean
}

/**
 * What the person typed as the server address. Only http and https, no
 * credentials inside the address (they have their own fields), and no query.
 */
export function parseServerUrl(input: string): ServerUrl | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password || !url.hostname) return null
  const path = url.pathname.replace(/\/+$/, '')
  return { url: `${url.origin}${path}`, insecure: url.protocol === 'http:' }
}

export interface WebDavClientOptions {
  /** from `parseServerUrl` */
  baseUrl: string
  /** null: the server is open */
  credentials: Credentials | null
  fetch: FetchLike
}

function timeout(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

function kindOfStatus(status: number): DavErrorKind {
  if (status === 401) return 'not-connected'
  if (status === 404 || status === 410) return 'not-found'
  if (status === 403 || status === 405) return 'forbidden'
  if (status === 409) return 'conflict'
  if (status === 412) return 'changed'
  if (status === 413 || status === 507) return 'too-large'
  if (status === 423) return 'locked'
  if (status === 429 || status === 503) return 'rate-limit'
  return 'network'
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map(encodeURIComponent)
    .join('/')
}

/** A weak entity tag cannot guard a write (RFC 9110 If-Match compares strongly) */
function strongEtag(etag: string | null): string | null {
  return etag && !/^W\//i.test(etag) ? etag : null
}

export class WebDavClient {
  private readonly base: URL
  private readonly basePath: string
  private scheme: AuthScheme | null = null
  private challenge: DigestChallenge | null = null
  private nc = 0

  constructor(private readonly options: WebDavClientOptions) {
    this.base = new URL(options.baseUrl)
    this.basePath = safeDecode(this.base.pathname).replace(/\/+$/, '')
  }

  /** the address of a path relative to the connected folder */
  private urlFor(path: string, collection = false): string {
    const encoded = encodePath(path)
    const root = this.base.pathname.replace(/\/+$/, '')
    const tail = encoded ? `/${encoded}` : ''
    return `${this.base.origin}${root}${tail}${collection ? '/' : ''}`
  }

  /** a server path (as in a listing) → the path relative to the connected folder, or null if outside it */
  private relative(serverPath: string): string | null {
    if (serverPath === this.basePath || (this.basePath === '' && serverPath === '/')) return '/'
    const prefix = `${this.basePath}/`
    if (!serverPath.startsWith(prefix)) return null
    return `/${serverPath.slice(prefix.length)}`
  }

  private authorization(method: string, url: string): string | null {
    const credentials = this.options.credentials
    if (!credentials) return null
    if (this.scheme === 'basic') return basicHeader(credentials)
    if (this.scheme === 'digest' && this.challenge) {
      this.nc += 1
      const target = new URL(url)
      return digestHeader(
        this.challenge,
        credentials,
        { method, uri: `${target.pathname}${target.search}` },
        { nc: this.nc },
      )
    }
    return null
  }

  /** Learn the scheme from a 401; false when there is nothing to answer it with */
  private learn(response: Response): boolean {
    if (!this.options.credentials) return false
    const header = response.headers.get('WWW-Authenticate')
    const scheme = chooseScheme(header)
    if (scheme === 'digest') {
      const challenge = header ? parseDigestChallenge(header) : null
      if (!challenge) return false
      this.scheme = 'digest'
      this.challenge = challenge
      this.nc = 0
      return true
    }
    if (scheme === 'basic') {
      // a Basic retry after a Basic refusal would only repeat the refusal
      if (this.scheme === 'basic') return false
      this.scheme = 'basic'
      return true
    }
    return false
  }

  /** One request with sign-in and same-server redirects; the response, or the error */
  private async send(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: Uint8Array | string; collection?: boolean },
    signal: AbortSignal | undefined,
    ms = REQUEST_TIMEOUT_MS,
  ): Promise<Response | DavError> {
    let url = this.urlFor(path, init.collection)
    let signedIn = false
    for (let hops = 0; hops <= MAX_REDIRECTS;) {
      const headers = new Headers(init.headers)
      const auth = this.authorization(method, url)
      if (auth) headers.set('Authorization', auth)
      let response: Response
      try {
        response = await this.options.fetch(url, {
          method,
          headers,
          body: init.body as BodyInit | undefined,
          redirect: 'manual',
          signal: timeout(ms, signal),
        })
      } catch {
        return { ok: false, kind: 'network' }
      }
      if (response.status === 401 && !signedIn && this.learn(response)) {
        signedIn = true
        await response.body?.cancel().catch(() => {})
        continue
      }
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('Location')
        await response.body?.cancel().catch(() => {})
        let next: URL
        try {
          next = new URL(location ?? '', url)
        } catch {
          return { ok: false, kind: 'network' }
        }
        // the sign-in never follows a redirect to another server or to plain HTTP from HTTPS
        if (next.origin !== this.base.origin) return { ok: false, kind: 'network' }
        url = next.toString()
        hops += 1
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return { ok: false, kind: kindOfStatus(response.status) }
      }
      return response
    }
    return { ok: false, kind: 'network' }
  }

  /** The connected folder answers the sign-in: the check behind "Connect" */
  async check(signal?: AbortSignal): Promise<DavResult<{ insecure: boolean }>> {
    const res = await this.send(
      'PROPFIND',
      '/',
      {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
        collection: true,
      },
      signal,
    )
    if (!(res instanceof Response)) return res
    await res.body?.cancel().catch(() => {})
    return { ok: true, insecure: this.base.protocol === 'http:' }
  }

  /** The entries directly inside a folder, folders first, then by name */
  async list(path: string, signal?: AbortSignal): Promise<DavResult<{ entries: DavResource[] }>> {
    const res = await this.send(
      'PROPFIND',
      path,
      {
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
        collection: true,
      },
      signal,
    )
    if (!(res instanceof Response)) return res
    const text = await readText(res, MAX_LISTING_BYTES)
    if (text === null) return { ok: false, kind: 'too-large' }
    const self = this.relative(
      safeDecode(new URL(this.urlFor(path, true)).pathname).replace(/\/+$/, '') || '/',
    )
    const entries: DavResource[] = []
    for (const item of parseMultiStatus(text)) {
      const relative = this.relative(item.path)
      // entries outside the connected folder are never shown; the folder itself is not an entry
      if (relative === null || relative === self) continue
      entries.push({ ...item, path: relative })
    }
    entries.sort(
      (a, b) =>
        Number(b.isCollection) - Number(a.isCollection) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    )
    return { ok: true, entries }
  }

  /** One file's or folder's properties */
  async stat(path: string, signal?: AbortSignal): Promise<DavResult<{ entry: DavResource }>> {
    const res = await this.send(
      'PROPFIND',
      path,
      {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      },
      signal,
    )
    if (!(res instanceof Response)) return res
    const text = await readText(res, MAX_LISTING_BYTES)
    if (text === null) return { ok: false, kind: 'too-large' }
    const items = parseMultiStatus(text)
    // a Depth 0 answer holds one entry; if a server sends more, the one asked for wins
    const wanted = this.relative(
      safeDecode(new URL(this.urlFor(path)).pathname).replace(/\/+$/, '') || '/',
    )
    const first = items.find((item) => this.relative(item.path) === wanted) ?? items[0]
    const relative = first ? this.relative(first.path) : null
    // a server may answer a folder asked for without its slash with the slash: same entry
    return first && relative !== null
      ? { ok: true, entry: { ...first, path: relative } }
      : { ok: false, kind: 'not-found' }
  }

  /** A file's bytes with what identifies them, refusing past `maxBytes` */
  async download(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<DavResult<{ bytes: Uint8Array; validator: Validator }>> {
    const res = await this.send('GET', path, {}, signal, TRANSFER_TIMEOUT_MS)
    if (!(res instanceof Response)) return res
    const declared = Number(res.headers.get('Content-Length') ?? NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, kind: 'too-large' }
    }
    const bytes = await readCapped(res, maxBytes)
    if (bytes === 'too-large') return { ok: false, kind: 'too-large' }
    if (bytes === null) return { ok: false, kind: 'network' }
    const modified = Date.parse(res.headers.get('Last-Modified') ?? '')
    return {
      ok: true,
      bytes,
      validator: {
        etag: res.headers.get('ETag'),
        modified: Number.isNaN(modified) ? '' : new Date(modified).toISOString(),
        size: bytes.byteLength,
      },
    }
  }

  /**
   * Write a file. `expect` is what the copy was made from: the write goes
   * through only if the server still holds that (`changed` otherwise).
   * `create` refuses to replace a file that already exists.
   */
  async upload(
    path: string,
    bytes: Uint8Array,
    mime: string,
    options: { expect?: Validator | undefined; create?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<DavResult<{ validator: Validator }>> {
    const headers: Record<string, string> = { 'Content-Type': mime }
    if (options.create) {
      headers['If-None-Match'] = '*'
    } else if (options.expect) {
      const etag = strongEtag(options.expect.etag)
      if (etag) {
        headers['If-Match'] = etag
      } else {
        // no strong tag to send: look first (a small window remains, but it is all this server offers)
        const now = await this.stat(path, signal)
        if (!now.ok) return now
        if (differs(options.expect, now.entry)) return { ok: false, kind: 'changed' }
      }
    }
    const res = await this.send('PUT', path, { headers, body: bytes }, signal, TRANSFER_TIMEOUT_MS)
    if (!(res instanceof Response)) return res
    await res.body?.cancel().catch(() => {})
    // what the server now holds, to compare at the next save
    const after = await this.stat(path, signal)
    if (after.ok) {
      const validator: Validator = {
        etag: after.entry.etag ?? res.headers.get('ETag'),
        modified: after.entry.modified,
      }
      if (after.entry.size !== undefined) validator.size = after.entry.size
      return { ok: true, validator }
    }
    return { ok: true, validator: { etag: res.headers.get('ETag'), modified: '' } }
  }
}

/** Weak comparison of entity tags: W/"x" and "x" name the same state */
function weakless(etag: string): string {
  return etag.replace(/^W\//i, '')
}

/** The server's entry is not the state `expect` describes */
export function differs(
  expect: Validator,
  entry: { etag: string | null; modified: string; size?: number },
): boolean {
  if (expect.etag && entry.etag) return weakless(expect.etag) !== weakless(entry.etag)
  if (expect.modified && entry.modified) {
    if (expect.modified !== entry.modified) return true
    return expect.size !== undefined && entry.size !== undefined && expect.size !== entry.size
  }
  return false
}

async function readText(response: Response, maxBytes: number): Promise<string | null> {
  const bytes = await readCapped(response, maxBytes)
  if (bytes === null || bytes === 'too-large') return null
  return new TextDecoder('utf-8').decode(bytes)
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | 'too-large' | null> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return 'too-large'
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

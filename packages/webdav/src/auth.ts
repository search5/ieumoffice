/**
 * HTTP authentication for WebDAV servers: Basic, and Digest (RFC 7616, with
 * MD5 or SHA-256 and `qop=auth`). The password never leaves this module
 * except inside the `Authorization` header of a request to the server the
 * person configured.
 */
import { createHash, randomBytes } from 'node:crypto'

export interface Credentials {
  username: string
  password: string
}

export type AuthScheme = 'basic' | 'digest'

export interface DigestChallenge {
  realm: string
  nonce: string
  opaque?: string
  algorithm: 'MD5' | 'SHA-256'
  qop: 'auth' | null
}

export function basicHeader(credentials: Credentials): string {
  const raw = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8')
  return `Basic ${raw.toString('base64')}`
}

/** `key="quoted, value", key2=token` pairs of one challenge */
function parameters(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/gi
  for (const match of text.matchAll(pattern)) {
    out.set(match[1]!.toLowerCase(), (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1'))
  }
  return out
}

/**
 * The schemes a `WWW-Authenticate` value offers (several challenges may be
 * folded into one value). Digest wins over Basic when both are offered.
 */
export function chooseScheme(header: string | null): AuthScheme | null {
  if (!header) return null
  if (/(^|[\s,])digest\s/i.test(header)) return 'digest'
  if (/(^|[\s,])basic(\s|,|$)/i.test(header)) return 'basic'
  return null
}

export function parseDigestChallenge(header: string): DigestChallenge | null {
  const at = header.search(/digest\s/i)
  if (at < 0) return null
  // the Digest challenge runs to the next scheme name, if another follows
  const rest = header.slice(at + 7)
  const next = rest.search(/,\s*(?:basic|negotiate|ntlm|bearer)\b/i)
  const params = parameters(next >= 0 ? rest.slice(0, next) : rest)
  const realm = params.get('realm')
  const nonce = params.get('nonce')
  if (realm === undefined || !nonce) return null
  const algorithm = (params.get('algorithm') ?? 'MD5').toUpperCase()
  if (algorithm !== 'MD5' && algorithm !== 'SHA-256') return null
  const qops = (params.get('qop') ?? '').split(',').map((q) => q.trim().toLowerCase())
  const challenge: DigestChallenge = {
    realm,
    nonce,
    algorithm,
    qop: qops.includes('auth') ? 'auth' : null,
  }
  const opaque = params.get('opaque')
  if (opaque !== undefined) challenge.opaque = opaque
  return challenge
}

function hash(algorithm: DigestChallenge['algorithm'], text: string): string {
  return createHash(algorithm === 'SHA-256' ? 'sha256' : 'md5')
    .update(text, 'utf8')
    .digest('hex')
}

function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`
}

/** The `Authorization` value answering a Digest challenge for one request */
export function digestHeader(
  challenge: DigestChallenge,
  credentials: Credentials,
  request: { method: string; uri: string },
  state: { nc: number; cnonce?: string },
): string {
  const { algorithm, realm, nonce } = challenge
  const ha1 = hash(algorithm, `${credentials.username}:${realm}:${credentials.password}`)
  const ha2 = hash(algorithm, `${request.method}:${request.uri}`)
  const parts = [
    `username=${quoted(credentials.username)}`,
    `realm=${quoted(realm)}`,
    `nonce=${quoted(nonce)}`,
    `uri=${quoted(request.uri)}`,
    `algorithm=${algorithm}`,
  ]
  let response: string
  if (challenge.qop === 'auth') {
    const nc = state.nc.toString(16).padStart(8, '0')
    const cnonce = state.cnonce ?? randomBytes(8).toString('hex')
    response = hash(algorithm, `${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    parts.push('qop=auth', `nc=${nc}`, `cnonce=${quoted(cnonce)}`)
  } else {
    response = hash(algorithm, `${ha1}:${nonce}:${ha2}`)
  }
  parts.push(`response=${quoted(response)}`)
  if (challenge.opaque !== undefined) parts.push(`opaque=${quoted(challenge.opaque)}`)
  return `Digest ${parts.join(', ')}`
}

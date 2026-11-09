/**
 * A small reader for the WebDAV `207 Multi-Status` body of a PROPFIND. It
 * matches elements by local name, so any namespace prefix (`d:`, `D:`, none)
 * works, and it never resolves entities or DTDs: the body comes from a server
 * the person typed in, and a real XML parser would be one more way for it to
 * reach this PC.
 */

export interface DavResource {
  /** the server path as given in `href`, percent-decoded, no trailing slash except for the root */
  path: string
  /** the last path segment, or the server's display name */
  name: string
  isCollection: boolean
  /** bytes; absent for collections and servers that do not say */
  size?: number
  /** ISO time, or '' when the server gives none */
  modified: string
  /** the entity tag as sent (quotes and `W/` kept), or null */
  etag: string | null
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** The text of the first element with this local name inside `xml`, or null */
function elementText(xml: string, local: string): string | null {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${local}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}\\s*>)`,
    'i',
  )
  const match = pattern.exec(xml)
  if (!match) return null
  const inner = match[1] ?? ''
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner)
  return cdata ? (cdata[1] ?? '') : decodeEntities(inner.trim())
}

function hasElement(xml: string, local: string): boolean {
  return new RegExp(`<(?:[\\w.-]+:)?${local}(?:[\\s/>])`, 'i').test(xml)
}

/** A `propstat` block is good when its status line says 2xx */
function okStatus(status: string | null): boolean {
  const match = status ? /\s(\d{3})(?:\s|$)/.exec(status) : null
  return match ? match[1]!.startsWith('2') : false
}

function decodePath(href: string): string | null {
  let path = href.trim()
  // an absolute URL: keep only the path
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(path)
  if (absolute) path = absolute[1] ?? '/'
  const cut = path.search(/[?#]/)
  if (cut >= 0) path = path.slice(0, cut)
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  if (!path.startsWith('/')) path = `/${path}`
  // `..` never appears in a server's own listing; a listing that has one is not trusted
  if (path.split('/').includes('..')) return null
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function modifiedIso(value: string | null): string {
  if (!value) return ''
  const time = Date.parse(value)
  return Number.isNaN(time) ? '' : new Date(time).toISOString()
}

/** Every `response` of a multi-status body that carries usable properties */
export function parseMultiStatus(body: string): DavResource[] {
  const out: DavResource[] = []
  const responses = body.match(
    /<(?:[\w.-]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?response\s*>/gi,
  )
  for (const response of responses ?? []) {
    const href = elementText(response, 'href')
    const path = href === null ? null : decodePath(href)
    if (!path) continue
    // only the propstat blocks the server answered with 2xx
    const stats = response.match(
      /<(?:[\w.-]+:)?propstat(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?propstat\s*>/gi,
    )
    const good = (stats ?? []).filter((s) => okStatus(elementText(s, 'status'))).join('\n')
    const props = stats ? good : response
    if (stats && !good) continue
    const resourceType =
      /<(?:[\w.-]+:)?resourcetype(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?resourcetype\s*>/i.exec(
        props,
      )?.[1] ?? ''
    const isCollection = hasElement(resourceType, 'collection')
    const lengthText = elementText(props, 'getcontentlength')
    const size = lengthText !== null && /^\d+$/.test(lengthText) ? Number(lengthText) : undefined
    const display = elementText(props, 'displayname')
    const last = path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1)
    const resource: DavResource = {
      path,
      name: last || display || '/',
      isCollection,
      modified: modifiedIso(elementText(props, 'getlastmodified')),
      etag: elementText(props, 'getetag') || null,
    }
    if (size !== undefined && !isCollection) resource.size = size
    out.push(resource)
  }
  return out
}

/** The body of a PROPFIND asking for exactly what the app reads */
export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:displayname/>' +
  '</d:prop></d:propfind>'

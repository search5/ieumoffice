/**
 * WebDAV between the shell's main process and its screens. Settings adds,
 * lists and removes servers; the home screen browses a server's folders and
 * opens its files. Passwords go in through `add` and never come back: a
 * screen only learns whether a server has one.
 */

import { WEBDAV_AI_CHANNELS } from '@genoffice/electron-utils/webdav-ai-channels'

export const WEBDAV_CHANNELS = {
  servers: 'webdav:servers',
  serversChanged: 'webdav:servers-changed',
  add: 'webdav:add',
  setPassword: 'webdav:set-password',
  remove: 'webdav:remove',
  list: 'webdav:list',
  open: 'webdav:open',
  aiAccess: 'webdav:ai-access',
  setAiAccess: 'webdav:set-ai-access',
  aiChanged: WEBDAV_AI_CHANNELS.changed,
  aiEnabled: WEBDAV_AI_CHANNELS.enabled,
  aiList: WEBDAV_AI_CHANNELS.list,
  aiSearch: WEBDAV_AI_CHANNELS.search,
  aiRead: WEBDAV_AI_CHANNELS.read,
} as const

/**
 * app-settings.json key: the person lets the AI browse, search and read the
 * connected WebDAV servers (decision 0118). Off until they turn it on: the
 * AI can walk the whole folder tree a server shows.
 */
export const WEBDAV_AI_ACCESS_KEY = 'webdavAiAccess'

/**
 * One saved server. hasPassword false on a server that needs one: the PC
 * could not keep it encrypted (or it was lost), so it is asked for again.
 * persisted false: this PC cannot encrypt, so the password lasts until the
 * app closes.
 */
export interface WebDavServerInfo {
  id: string
  name: string
  url: string
  username: string
  /** the server needs no sign-in (an empty user name) */
  open: boolean
  hasPassword: boolean
  persisted: boolean
  insecure: boolean
}

export interface WebDavAddRequest {
  name: string
  url: string
  username: string
  password: string
  /** the person confirmed that plain HTTP is meant (the password crosses the network readable) */
  allowInsecure: boolean
}

/**
 * url: not a usable http(s) address; insecure: plain HTTP without the
 * person's confirmation; auth: the server refused the sign-in; not-found: the
 * folder is not on that server; forbidden; network: nothing answered;
 * limit: too many servers.
 */
export type WebDavAddFailure =
  'url' | 'insecure' | 'auth' | 'not-found' | 'forbidden' | 'network' | 'limit'

export type WebDavAddResult = { ok: true; id: string } | { ok: false; reason: WebDavAddFailure }

export type WebDavErrorKind =
  'not-connected' | 'not-found' | 'forbidden' | 'too-large' | 'rate-limit' | 'locked' | 'network'

export type WebDavEntryType =
  | 'folder'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'mindmap'
  | 'hwp'
  | 'epub'
  | 'diagram'
  | 'other'

export interface WebDavEntry {
  /** the path inside the server's connected folder, beginning with "/" */
  path: string
  name: string
  type: WebDavEntryType
  /** ISO time or '' */
  modifiedTime: string
  size?: number
  /** an editor here opens it */
  openable: boolean
}

export type WebDavListResult =
  { ok: true; entries: WebDavEntry[] } | { ok: false; kind: WebDavErrorKind }

export type WebDavOpenResult =
  { ok: true } | { ok: false; kind: WebDavErrorKind | 'unsupported' | 'disk' }

/** The screens' window.aiOfficeWebDav */
export interface WebDavApi {
  servers(): Promise<WebDavServerInfo[]>
  onServersChanged(listener: (servers: WebDavServerInfo[]) => void): () => void
  add(request: WebDavAddRequest): Promise<WebDavAddResult>
  setPassword(id: string, password: string): Promise<WebDavAddResult>
  remove(id: string): Promise<void>
  list(id: string, path: string): Promise<WebDavListResult>
  open(id: string, path: string): Promise<WebDavOpenResult>
  /** the AI may use the connected servers */
  aiAccess(): Promise<boolean>
  setAiAccess(on: boolean): Promise<boolean>
}

/** The most servers one person connects; keeps the lists and the cache bounded */
export const MAX_WEBDAV_SERVERS = 10

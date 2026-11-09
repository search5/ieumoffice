/**
 * WebDAV in the shell's main process: the saved servers, the local copies of
 * opened files and the two-way sync of saves. The screens get server lists
 * and folder listings; passwords never leave this process.
 *
 * Only a person at the screen starts anything: there is no AI tool, terminal
 * command or MCP tool for WebDAV. The AI reads a WebDAV file only the way it
 * reads any file the person has open or attaches.
 */
import { join } from 'node:path'
import { dialog, ipcMain, net, safeStorage, webContents, type BrowserWindow } from 'electron'
import type { Lang } from '@genoffice/i18n'
import { openPlan } from '@genoffice/google-drive'
import { WebDavClient, parseServerUrl, type DavError, type FetchLike } from '@genoffice/webdav'
import {
  MAX_WEBDAV_SERVERS,
  WEBDAV_AI_ACCESS_KEY,
  WEBDAV_CHANNELS,
  type WebDavAddFailure,
  type WebDavAddRequest,
  type WebDavAddResult,
  type WebDavEntry,
  type WebDavListResult,
  type WebDavOpenResult,
  type WebDavServerInfo,
} from '../../shared/webdav-api'
import { entryType, type ParseToText } from '../drive/drive-ai'
import { readAppSettings, writeAppSetting } from '../app-settings'
import { driveTokenSeals } from '../drive/drive-vault'
import {
  WebDavFiles,
  type WebDavAnswer,
  type WebDavNotice,
  type WebDavQuestion,
} from './webdav-files'
import { WebDavAi } from './webdav-ai'
import { WebDavServers } from './webdav-servers'
import { copyFileName, webdavText } from './webdav-strings'

export interface WebDavIpcDeps {
  userData: () => string
  lang: () => Lang
  /** the window dialogs attach to */
  window: () => BrowserWindow | null
  openPath: (path: string) => boolean
  isOpen: (path: string) => boolean
  settingsPath: () => string
  parse: ParseToText
  /** the AI the person chose is a free connection, which may train on what it gets (drive-consent.ts) */
  freeAi: () => boolean
}

export interface WebDavService {
  /** a local path is a copy of a server file: reopen through the server so a stale copy is refreshed */
  reopen(path: string): Promise<boolean> | null
  stop(): void
}

const ID = /^[0-9a-f-]{36}$/
const MAX_PATH = 2000

function pathOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_PATH || raw.includes('\0')) return null
  return raw.startsWith('/') ? raw : `/${raw}`
}

function addFailure(error: DavError): WebDavAddFailure {
  switch (error.kind) {
    case 'not-connected':
      return 'auth'
    case 'not-found':
      return 'not-found'
    case 'forbidden':
      return 'forbidden'
    default:
      return 'network'
  }
}

export function registerWebDavIpc(deps: WebDavIpcDeps): WebDavService {
  const fetch: FetchLike = (url, init) => net.fetch(url, init)
  const servers = new WebDavServers(join(deps.userData(), 'webdav-servers.json'), {
    available: () => driveTokenSeals(safeStorage, process.platform),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (bytes) => safeStorage.decryptString(bytes),
  })
  const t = (key: Parameters<typeof webdavText>[1], params?: Record<string, string>) =>
    webdavText(deps.lang(), key, params)

  // one client per server, so a Digest sign-in is not redone for every call
  const clients = new Map<string, WebDavClient>()
  const clientFor = (id: string): WebDavClient | null => {
    const cached = clients.get(id)
    if (cached) return cached
    const secrets = servers.secrets(id)
    if (!secrets) return null
    const client = new WebDavClient({
      baseUrl: secrets.url,
      credentials: secrets.username
        ? { username: secrets.username, password: secrets.password }
        : null,
      fetch,
    })
    clients.set(id, client)
    return client
  }

  // the AI's read-only view (decision 0118); the servers it may use are those with a password in hand
  const ai = new WebDavAi({
    servers: () =>
      servers
        .info()
        .filter((s) => s.hasPassword)
        .map((s) => ({ id: s.id, name: s.name })),
    client: clientFor,
    parse: deps.parse,
  })
  const aiAccess = () => readAppSettings(deps.settingsPath())[WEBDAV_AI_ACCESS_KEY] === true
  const aiEnabled = () => aiAccess() && servers.info().some((s) => s.hasPassword)

  const broadcast = () => {
    const list = servers.info()
    const on = aiEnabled()
    if (!on) ai.clear()
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue
      wc.send(WEBDAV_CHANNELS.serversChanged, list)
      wc.send(WEBDAV_CHANNELS.aiChanged, on)
    }
  }

  const ask = async (question: WebDavQuestion): Promise<WebDavAnswer> => {
    const message =
      question.kind === 'changed'
        ? t('askChanged', { name: question.name })
        : question.kind === 'read-only'
          ? t('askReadOnly', { name: question.name })
          : t('askGone', { name: question.name })
    const answers: WebDavAnswer[] =
      question.kind === 'changed' ? ['overwrite', 'copy', 'local'] : ['copy', 'local']
    const labels = answers.map((a) =>
      a === 'overwrite' ? t('btnOverwrite') : a === 'copy' ? t('btnCopy') : t('btnLocal'),
    )
    const options = {
      type: 'warning' as const,
      title: t('dialogTitle'),
      message,
      detail: t('askDetail'),
      buttons: labels,
      defaultId: answers.indexOf('copy'),
      cancelId: answers.indexOf('local'),
      noLink: true,
    }
    const win = deps.window()
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    return answers[response] ?? 'local'
  }

  const notify = (notice: WebDavNotice) => {
    const options = {
      type: notice.kind === 'upload-failed' ? ('warning' as const) : ('info' as const),
      title: t('dialogTitle'),
      message:
        notice.kind === 'saved-copy'
          ? t('noticeCopy', { copyName: notice.copyName })
          : t('noticeUploadFailed', { name: notice.name }),
      buttons: [t('ok')],
      noLink: true,
    }
    const win = deps.window()
    void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  }

  const files = new WebDavFiles({
    client: clientFor,
    cacheDir: join(deps.userData(), 'webdav-cache'),
    openPath: deps.openPath,
    isOpen: deps.isOpen,
    ask,
    notify,
    copyName: (name) => copyFileName(name, t('copySuffix')),
  })

  void servers.load().then(() => {
    if (servers.info().length > 0) void files.start()
    broadcast()
  })

  ipcMain.handle(WEBDAV_CHANNELS.servers, async (): Promise<WebDavServerInfo[]> => {
    await servers.load()
    return servers.info()
  })

  /** Check a sign-in against the server before anything is saved */
  const probe = async (
    url: string,
    username: string,
    password: string,
  ): Promise<DavError | null> => {
    const client = new WebDavClient({
      baseUrl: url,
      credentials: username ? { username, password } : null,
      fetch,
    })
    const result = await client.check()
    return result.ok ? null : result
  }

  ipcMain.handle(WEBDAV_CHANNELS.add, async (_event, raw: unknown): Promise<WebDavAddResult> => {
    await servers.load()
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<WebDavAddRequest>
    const parsed = typeof r.url === 'string' ? parseServerUrl(r.url) : null
    if (!parsed) return { ok: false, reason: 'url' }
    if (parsed.insecure && r.allowInsecure !== true) return { ok: false, reason: 'insecure' }
    if (servers.info().length >= MAX_WEBDAV_SERVERS) return { ok: false, reason: 'limit' }
    const username = typeof r.username === 'string' ? r.username.trim().slice(0, 200) : ''
    const password = typeof r.password === 'string' ? r.password.slice(0, 500) : ''
    const name =
      (typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '') || new URL(parsed.url).hostname
    const problem = await probe(parsed.url, username, password)
    if (problem) return { ok: false, reason: addFailure(problem) }
    const id = await servers.add({ name, url: parsed.url, username, password })
    if (!id) return { ok: false, reason: 'limit' }
    void files.start()
    broadcast()
    return { ok: true, id }
  })

  ipcMain.handle(
    WEBDAV_CHANNELS.setPassword,
    async (_event, rawId: unknown, rawPassword: unknown): Promise<WebDavAddResult> => {
      await servers.load()
      if (typeof rawId !== 'string' || !ID.test(rawId) || !servers.has(rawId)) {
        return { ok: false, reason: 'not-found' }
      }
      const password = typeof rawPassword === 'string' ? rawPassword.slice(0, 500) : ''
      const known = servers.info().find((s) => s.id === rawId)!
      const problem = await probe(known.url, known.username, password)
      if (problem) return { ok: false, reason: addFailure(problem) }
      await servers.setPassword(rawId, password)
      clients.delete(rawId)
      files.reconnected(rawId)
      broadcast()
      return { ok: true, id: rawId }
    },
  )

  ipcMain.handle(WEBDAV_CHANNELS.remove, async (_event, rawId: unknown): Promise<void> => {
    await servers.load()
    if (typeof rawId !== 'string' || !ID.test(rawId)) return
    await servers.remove(rawId)
    clients.delete(rawId)
    ai.clear()
    await files.forget(rawId)
    broadcast()
  })

  ipcMain.handle(
    WEBDAV_CHANNELS.list,
    async (_event, rawId: unknown, rawPath: unknown): Promise<WebDavListResult> => {
      await servers.load()
      const path = pathOf(rawPath)
      const client = typeof rawId === 'string' && ID.test(rawId) ? clientFor(rawId) : null
      if (!client || !path) return { ok: false, kind: 'not-connected' }
      const result = await client.list(path)
      if (!result.ok) return toErrorKind(result)
      const entries: WebDavEntry[] = result.entries.map((item) => {
        const entry: WebDavEntry = {
          path: item.path,
          name: item.name,
          type: item.isCollection ? 'folder' : entryType({ name: item.name, mimeType: '' }),
          modifiedTime: item.modified,
          openable:
            !item.isCollection && openPlan({ name: item.name, mimeType: '' }).kind !== 'none',
        }
        if (item.size !== undefined) entry.size = item.size
        return entry
      })
      return { ok: true, entries }
    },
  )

  ipcMain.handle(
    WEBDAV_CHANNELS.open,
    async (_event, rawId: unknown, rawPath: unknown): Promise<WebDavOpenResult> => {
      await servers.load()
      const path = pathOf(rawPath)
      if (typeof rawId !== 'string' || !ID.test(rawId) || !path) {
        return { ok: false, kind: 'not-found' }
      }
      const result = await files.open(rawId, path)
      if (result.ok) return result
      if (result.kind === 'unsupported' || result.kind === 'disk') {
        return { ok: false, kind: result.kind }
      }
      return toErrorKind({ ok: false, kind: result.kind })
    },
  )

  // ---- the editors' AI (screen requests only; the CLI, MCP and agent mode have no WebDAV) ----

  const FREE_AI_REFUSAL =
    'WebDAV files are not given to the AI in use: it is a free connection that may use what it receives to train models. Tell the person to choose another AI to work with WebDAV files.'
  const NOT_AVAILABLE = 'WebDAV is not available now.'
  const objectOf = (raw: unknown): Record<string, unknown> =>
    (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const textOf = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

  ipcMain.handle(WEBDAV_CHANNELS.aiAccess, (): boolean => aiAccess())

  ipcMain.handle(WEBDAV_CHANNELS.setAiAccess, (_event, on: unknown): boolean => {
    writeAppSetting(deps.settingsPath(), WEBDAV_AI_ACCESS_KEY, on === true)
    broadcast()
    return aiAccess()
  })

  ipcMain.handle(WEBDAV_CHANNELS.aiEnabled, async (): Promise<boolean> => {
    await servers.load()
    return aiEnabled()
  })

  ipcMain.handle(WEBDAV_CHANNELS.aiList, async (_event, raw: unknown) => {
    await servers.load()
    if (!aiEnabled()) return { ok: false, error: NOT_AVAILABLE }
    if (deps.freeAi()) return { ok: false, error: FREE_AI_REFUSAL }
    const r = objectOf(raw)
    return ai.list(textOf(r.server, 100), textOf(r.path, 2000))
  })

  ipcMain.handle(WEBDAV_CHANNELS.aiSearch, async (_event, raw: unknown) => {
    await servers.load()
    if (!aiEnabled()) return { ok: false, error: NOT_AVAILABLE }
    if (deps.freeAi()) return { ok: false, error: FREE_AI_REFUSAL }
    const r = objectOf(raw)
    const limit = Math.min(Math.max(1, Math.floor(Number(r.limit) || 15)), 30)
    return ai.search(textOf(r.q, 200), textOf(r.server, 100), textOf(r.path, 2000), limit)
  })

  ipcMain.handle(WEBDAV_CHANNELS.aiRead, async (_event, raw: unknown) => {
    await servers.load()
    if (!aiEnabled()) return { ok: false, error: NOT_AVAILABLE }
    if (deps.freeAi()) return { ok: false, error: FREE_AI_REFUSAL }
    const r = objectOf(raw)
    return ai.read(textOf(r.server, 100), textOf(r.path, 2000), Number(r.offset) || 0)
  })

  return {
    reopen(path) {
      const entry = files.entryFor(path)
      if (!entry) return null
      return files.open(entry.serverId, entry.remotePath).then((r) => r.ok || deps.openPath(path))
    },
    stop() {
      files.stop()
    },
  }
}

/** The client's error kinds the screens know; the rest read as a network problem */
function toErrorKind(error: DavError): {
  ok: false
  kind: Extract<WebDavListResult, { ok: false }>['kind']
} {
  switch (error.kind) {
    case 'not-connected':
    case 'not-found':
    case 'forbidden':
    case 'too-large':
    case 'rate-limit':
    case 'locked':
    case 'network':
      return { ok: false, kind: error.kind }
    default:
      return { ok: false, kind: 'network' }
  }
}

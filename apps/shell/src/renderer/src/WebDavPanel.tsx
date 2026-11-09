import { useCallback, useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type {
  WebDavApi,
  WebDavEntry,
  WebDavEntryType,
  WebDavErrorKind,
  WebDavServerInfo,
} from '../../shared/webdav-api'
import { webdavUiText, type WebDavStringKey } from './i18n/strings-webdav'
import iconDocx from './assets/file-docx.svg'
import iconXlsx from './assets/file-xlsx.svg'
import iconPptx from './assets/file-pptx.svg'
import iconPdf from './assets/file-pdf.svg'
import iconMd from './assets/file-md.svg'
import iconHtml from './assets/file-html.svg'
import iconMindmap from './assets/file-mindmap.svg'
import iconHwp from './assets/file-hwp.svg'
import iconEpub from './assets/file-epub.svg'
import iconDiagram from './assets/file-diagram.svg'
import './drive.css'

declare global {
  interface Window {
    /** WebDAV servers (src/preload/index.ts) */
    aiOfficeWebDav?: WebDavApi
  }
}

const ICONS: Partial<Record<WebDavEntryType, string>> = {
  document: iconDocx,
  spreadsheet: iconXlsx,
  presentation: iconPptx,
  pdf: iconPdf,
  markdown: iconMd,
  html: iconHtml,
  mindmap: iconMindmap,
  hwp: iconHwp,
  epub: iconEpub,
  diagram: iconDiagram,
}

/** What a failed list or open shows */
export const WEBDAV_ERROR_KEYS: Record<WebDavErrorKind | 'unsupported' | 'disk', WebDavStringKey> =
  {
    'not-connected': 'webdavErrAuth',
    'not-found': 'webdavErrNotFound',
    forbidden: 'webdavErrForbidden',
    'too-large': 'webdavErrTooLarge',
    'rate-limit': 'webdavErrRateLimit',
    locked: 'webdavErrLocked',
    network: 'webdavErrNetwork',
    unsupported: 'webdavUnsupported',
    disk: 'webdavErrDisk',
  }

/** The live server list from the main process; null until it answers, [] when there is no bridge */
export function useWebDavServers(): WebDavServerInfo[] | null {
  const [servers, setServers] = useState<WebDavServerInfo[] | null>(null)
  useEffect(() => {
    const api = window.aiOfficeWebDav
    if (!api) {
      setServers([])
      return
    }
    let live = true
    void api.servers().then(
      (s) => live && setServers(s),
      () => live && setServers([]),
    )
    const off = api.onServersChanged((s) => setServers(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return servers
}

export function WebDavNavIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2" y="9.5" width="12" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.8" cy="4.5" r=".7" fill="currentColor" />
      <circle cx="4.8" cy="11.5" r=".7" fill="currentColor" />
    </svg>
  )
}

function OtherIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M2.5 5.5a1 1 0 0 1 1-1h4l1.5 1.8h7.5a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** "/a/b" → [{name:'a',path:'/a'},{name:'b',path:'/a/b'}] */
function crumbsOf(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))
}

/**
 * The home screen's WebDAV page: pick a server, walk its folders, open a
 * file. Opening copies the file to this PC; the editor saves it like any
 * file and the main process sends each save back to the server.
 */
export function WebDavPanel({
  lang,
  dateLocale,
  onOpenSettings,
}: {
  lang: Lang
  dateLocale: string
  /** Settings → Integrations, where servers are added */
  onOpenSettings: () => void
}) {
  const t = (key: WebDavStringKey, params?: Record<string, string>) =>
    webdavUiText(lang, key, params)
  const servers = useWebDavServers()
  const [serverId, setServerId] = useState<string | null>(null)
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<WebDavEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<WebDavStringKey | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const request = useRef(0)

  // keep the chosen server valid as servers come and go
  useEffect(() => {
    if (!servers) return
    if (serverId && servers.some((s) => s.id === serverId)) return
    setServerId(servers[0]?.id ?? null)
    setPath('/')
  }, [servers, serverId])

  const load = useCallback(async () => {
    const api = window.aiOfficeWebDav
    if (!api || !serverId) return
    const id = ++request.current
    setLoading(true)
    setError(null)
    const result = await api.list(serverId, path).catch(() => null)
    if (id !== request.current) return
    setLoading(false)
    if (!result || !result.ok) {
      setError(WEBDAV_ERROR_KEYS[result?.kind ?? 'network'])
      setEntries([])
      return
    }
    setEntries(result.entries)
  }, [serverId, path])

  useEffect(() => {
    void load()
  }, [load])

  const activate = async (entry: WebDavEntry) => {
    const api = window.aiOfficeWebDav
    if (!api || !serverId || opening) return
    if (entry.type === 'folder') {
      setPath(entry.path)
      return
    }
    if (!entry.openable) return
    setOpening(entry.path)
    setError(null)
    const result = await api.open(serverId, entry.path).catch(() => null)
    setOpening(null)
    if (!result?.ok) setError(WEBDAV_ERROR_KEYS[result?.kind ?? 'network'])
  }

  if (!servers) return <main className="content drive-panel" />

  if (servers.length === 0) {
    return (
      <main className="content drive-panel" data-testid="webdav-panel">
        <div className="drive-head">
          <h2 className="drive-title">{t('webdavNav')}</h2>
        </div>
        <div className="drive-empty-card">
          <div className="drive-empty-title">{t('webdavEmptyTitle')}</div>
          <p className="drive-empty-body">{t('webdavEmptyBody')}</p>
          <button className="drive-primary" onClick={onOpenSettings}>
            {t('webdavOpenSettings')}
          </button>
        </div>
      </main>
    )
  }

  const server = servers.find((s) => s.id === serverId)
  const crumbs = crumbsOf(path)

  return (
    <main className="content drive-panel" data-testid="webdav-panel">
      <div className="drive-head">
        <h2 className="drive-title">{t('webdavNav')}</h2>
        {server && <span className="drive-account">{server.url}</span>}
      </div>
      <div className="drive-toolbar">
        {servers.length > 1 && (
          <select
            aria-label={t('webdavServer')}
            value={serverId ?? ''}
            onChange={(e) => {
              setServerId(e.target.value)
              setPath('/')
            }}
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button className="drive-ghost" onClick={() => void load()} disabled={loading}>
          {t('webdavRefresh')}
        </button>
      </div>

      {server && !server.hasPassword ? (
        <div className="drive-empty-card">
          <p className="drive-empty-body">{t('webdavNeedPassword')}</p>
          <button className="drive-primary" onClick={onOpenSettings}>
            {t('webdavOpenSettings')}
          </button>
        </div>
      ) : (
        <>
          <nav className="drive-crumbs" aria-label={t('webdavRoot')}>
            {crumbs.length === 0 ? (
              <span className="drive-crumb-current">{server?.name ?? t('webdavRoot')}</span>
            ) : (
              <button className="drive-crumb" onClick={() => setPath('/')}>
                {server?.name ?? t('webdavRoot')}
              </button>
            )}
            {crumbs.map((crumb, i) => (
              <span className="drive-crumb-item" key={crumb.path}>
                <span className="drive-crumb-sep">›</span>
                {i === crumbs.length - 1 ? (
                  <span className="drive-crumb-current">{crumb.name}</span>
                ) : (
                  <button className="drive-crumb" onClick={() => setPath(crumb.path)}>
                    {crumb.name}
                  </button>
                )}
              </span>
            ))}
          </nav>

          {error && (
            <p className="drive-warn" role="alert">
              {t(error)}
            </p>
          )}

          <ul className="drive-list" aria-busy={loading}>
            {entries.map((entry) => {
              const isFolder = entry.type === 'folder'
              const icon = ICONS[entry.type]
              const unsupported = !isFolder && !entry.openable
              return (
                <li key={entry.path}>
                  <button
                    className="drive-row"
                    disabled={unsupported || opening !== null}
                    title={unsupported ? t('webdavUnsupported') : undefined}
                    onClick={() => void activate(entry)}
                  >
                    <span className="drive-icon">
                      {isFolder ? (
                        <FolderIcon />
                      ) : icon ? (
                        <img src={icon} alt="" width={20} height={20} />
                      ) : (
                        <OtherIcon />
                      )}
                    </span>
                    <span className="drive-name">{entry.name}</span>
                    <span className="drive-date">
                      {opening === entry.path
                        ? t('webdavOpening')
                        : entry.modifiedTime
                          ? new Date(entry.modifiedTime).toLocaleDateString(dateLocale)
                          : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {!loading && entries.length === 0 && !error && (
            <p className="drive-muted">{t('webdavFolderEmpty')}</p>
          )}
          {loading && <p className="drive-muted">{t('webdavLoading')}</p>}
        </>
      )}
    </main>
  )
}

import { useEffect, useState } from 'react'
import type { WebDavAddFailure, WebDavServerInfo } from '../../shared/webdav-api'
import { webdavUiText, type WebDavStringKey } from './i18n/strings-webdav'
import { useI18n } from './locale'
import { useWebDavServers } from './WebDavPanel'
import './drive.css'

const FAILURE_KEYS: Record<WebDavAddFailure, WebDavStringKey> = {
  url: 'webdavErrUrl',
  insecure: 'webdavErrInsecure',
  auth: 'webdavErrAuth',
  'not-found': 'webdavErrNotFound',
  forbidden: 'webdavErrForbidden',
  network: 'webdavErrNetwork',
  limit: 'webdavErrLimit',
}

/** A server that wants a password this PC does not hold: asks for it again */
function PasswordAgain({ server }: { server: WebDavServerInfo }) {
  const { lang } = useI18n()
  const t = (key: WebDavStringKey) => webdavUiText(lang, key)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<WebDavStringKey | null>(null)
  const api = window.aiOfficeWebDav
  if (!api) return null
  return (
    <div className="set-intg-confirm set-webdav-form">
      <div className="set-field-desc set-intg-warn">{t('webdavNeedPassword')}</div>
      <div className="set-drive-row">
        <input
          className="set-input"
          type="password"
          autoComplete="off"
          value={password}
          aria-label={t('webdavFieldPassword')}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button
          className="set-btn set-btn-primary"
          disabled={busy || !password}
          onClick={async () => {
            setBusy(true)
            setFailure(null)
            const result = await api
              .setPassword(server.id, password)
              .catch(() => ({ ok: false as const, reason: 'network' as const }))
            setBusy(false)
            if (result.ok) setPassword('')
            else setFailure(FAILURE_KEYS[result.reason])
          }}
        >
          {t('webdavSave')}
        </button>
      </div>
      {failure && <div className="set-field-desc set-intg-warn">{t(failure)}</div>}
    </div>
  )
}

/**
 * Settings → Integrations: the WebDAV servers. Add one with its address, user
 * name and password (checked against the server before it is saved), see the
 * saved ones, remove one. The password goes to the main process and never
 * comes back.
 */
export function WebDavSettingsCard() {
  const { lang } = useI18n()
  const t = (key: WebDavStringKey) => webdavUiText(lang, key)
  const servers = useWebDavServers()
  const api = window.aiOfficeWebDav
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [allowInsecure, setAllowInsecure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<WebDavStringKey | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [aiAccess, setAiAccess] = useState(false)

  useEffect(() => {
    let live = true
    void window.aiOfficeWebDav?.aiAccess().then(
      (on) => live && setAiAccess(on === true),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])

  if (!api || !servers) return null

  const insecure = /^http:\/\//i.test(url.trim())

  const reset = () => {
    setAdding(false)
    setName('')
    setUrl('')
    setUsername('')
    setPassword('')
    setAllowInsecure(false)
    setFailure(null)
  }

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    const result = await api
      .add({ name, url, username, password, allowInsecure })
      .catch(() => ({ ok: false as const, reason: 'network' as const }))
    setBusy(false)
    if (result.ok) reset()
    else setFailure(FAILURE_KEYS[result.reason])
  }

  return (
    <section className="set-intg-part set-drive" data-testid="webdav-settings">
      <h4 className="set-pane-subtitle">{t('webdavNav')}</h4>
      <div className="set-field-desc set-intg-lead">{t('webdavDesc')}</div>

      {servers.length === 0 && <div className="set-field-desc">{t('webdavNoServers')}</div>}
      {servers.map((server) => (
        <div key={server.id} className="set-intg-part">
          <div className="set-drive-row">
            <span className="set-drive-account">
              {server.name} · {server.url}
              {server.username ? ` · ${server.username}` : ''}
            </span>
            {removing === server.id ? null : (
              <button className="set-btn" onClick={() => setRemoving(server.id)}>
                {t('webdavRemove')}
              </button>
            )}
          </div>
          {server.insecure && (
            <div className="set-field-desc set-intg-warn">{t('webdavInsecureWarn')}</div>
          )}
          {!server.hasPassword && <PasswordAgain server={server} />}
          {server.hasPassword && !server.persisted && !server.open && (
            <div className="set-field-desc set-intg-warn">{t('webdavNotPersisted')}</div>
          )}
          {removing === server.id && (
            <div className="set-intg-confirm">
              <div className="set-field-desc">{t('webdavRemoveConfirm')}</div>
              <div className="set-drive-row">
                <button
                  className="set-btn"
                  onClick={() => {
                    setRemoving(null)
                    void api.remove(server.id)
                  }}
                >
                  {t('webdavRemoveYes')}
                </button>
                <button className="set-btn" onClick={() => setRemoving(null)}>
                  {t('webdavCancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {adding ? (
        <form
          className="set-intg-confirm set-webdav-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy) void submit()
          }}
        >
          <label className="set-field-desc">
            {t('webdavFieldName')}
            <input
              className="set-input"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="set-field-desc">
            {t('webdavFieldUrl')}
            <input
              className="set-input"
              type="url"
              value={url}
              placeholder="https://cloud.example.com/remote.php/dav/files/me"
              autoComplete="off"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="set-field-desc">
            {t('webdavFieldUser')}
            <input
              className="set-input"
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="set-field-desc">
            {t('webdavFieldPassword')}
            <input
              className="set-input"
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="set-field-desc">{t('webdavUserHint')}</div>
          {insecure && (
            <>
              <div className="set-field-desc set-intg-warn">{t('webdavInsecureWarn')}</div>
              <label className="set-drive-toggle">
                <input
                  type="checkbox"
                  checked={allowInsecure}
                  onChange={(e) => setAllowInsecure(e.target.checked)}
                />
                <span className="set-drive-toggle-title">{t('webdavInsecureConfirm')}</span>
              </label>
            </>
          )}
          <div className="set-drive-row">
            <button
              type="submit"
              className="set-btn set-btn-primary"
              disabled={busy || !url.trim() || (insecure && !allowInsecure)}
            >
              {busy ? t('webdavChecking') : t('webdavSave')}
            </button>
            <button type="button" className="set-btn" onClick={reset} disabled={busy}>
              {t('webdavCancel')}
            </button>
          </div>
          {failure && (
            <div className="set-field-desc set-intg-warn" role="alert">
              {t(failure)}
            </div>
          )}
        </form>
      ) : (
        <div className="set-drive-row">
          <button className="set-btn set-btn-primary" onClick={() => setAdding(true)}>
            {t('webdavAdd')}
          </button>
        </div>
      )}
      <label className="set-drive-toggle">
        <input
          type="checkbox"
          checked={aiAccess}
          onChange={(e) => {
            setAiAccess(e.target.checked)
            void api.setAiAccess(e.target.checked).then(setAiAccess, () => {})
          }}
        />
        <span>
          <span className="set-drive-toggle-title">{t('webdavAiAccess')}</span>
          <span className="set-field-desc">{t('webdavAiAccessDesc')}</span>
        </span>
      </label>
      <div className="set-field-desc">{t('webdavPrivacy')}</div>
    </section>
  )
}

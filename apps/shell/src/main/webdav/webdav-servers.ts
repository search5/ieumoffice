import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { atomicWriteFile } from '../atomic-write'
import type { SecretCipher } from '../drive/drive-vault'
import { MAX_WEBDAV_SERVERS, type WebDavServerInfo } from '../../shared/webdav-api'

interface StoredServer {
  id: string
  name: string
  url: string
  username: string
  /** base64 of the encrypted password; null when none is kept on disk */
  password: string | null
}

interface ServersFile {
  version: 1
  servers: StoredServer[]
}

export interface ServerSecrets {
  id: string
  name: string
  url: string
  username: string
  password: string
}

/**
 * The saved WebDAV servers in `webdav-servers.json` in the data folder. A
 * password is written only encrypted (Electron safeStorage); where encryption
 * is not available the server is kept without it and the password lasts until
 * the app closes, like the Drive token (decision 0033).
 */
export class WebDavServers {
  private servers: StoredServer[] = []
  /** passwords in memory, by server id */
  private passwords = new Map<string, string>()
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<ServersFile>
      if (raw.version !== 1 || !Array.isArray(raw.servers)) return
      for (const item of raw.servers) {
        if (
          !item ||
          typeof item.id !== 'string' ||
          typeof item.name !== 'string' ||
          typeof item.url !== 'string' ||
          typeof item.username !== 'string'
        ) {
          continue
        }
        this.servers.push({
          id: item.id,
          name: item.name,
          url: item.url,
          username: item.username,
          password: typeof item.password === 'string' ? item.password : null,
        })
        if (typeof item.password === 'string' && this.cipher.available()) {
          try {
            const password = this.cipher.decrypt(Buffer.from(item.password, 'base64'))
            if (password) this.passwords.set(item.id, password)
          } catch {
            // encrypted by another user or PC: the password is asked for again
          }
        }
      }
    } catch {
      // no file yet
    }
  }

  private async save(): Promise<boolean> {
    const file: ServersFile = { version: 1, servers: this.servers }
    try {
      await atomicWriteFile(this.filePath, Buffer.from(JSON.stringify(file), 'utf8'))
      return true
    } catch {
      return false
    }
  }

  info(): WebDavServerInfo[] {
    return this.servers.map((server) => this.infoOf(server))
  }

  private infoOf(server: StoredServer): WebDavServerInfo {
    const open = server.username === ''
    return {
      id: server.id,
      name: server.name,
      url: server.url,
      username: server.username,
      open,
      hasPassword: open || this.passwords.has(server.id),
      persisted: open || (server.password !== null && this.cipher.available()),
      insecure: server.url.startsWith('http://'),
    }
  }

  /** What a call needs to sign in; null for a server that wants a password it does not have */
  secrets(id: string): ServerSecrets | null {
    const server = this.servers.find((s) => s.id === id)
    if (!server) return null
    const password = this.passwords.get(id)
    if (server.username !== '' && password === undefined) return null
    return {
      id,
      name: server.name,
      url: server.url,
      username: server.username,
      password: password ?? '',
    }
  }

  has(id: string): boolean {
    return this.servers.some((s) => s.id === id)
  }

  /** Add a server; false when the limit is reached */
  async add(input: {
    name: string
    url: string
    username: string
    password: string
  }): Promise<string | null> {
    if (this.servers.length >= MAX_WEBDAV_SERVERS) return null
    const id = randomUUID()
    this.servers.push({
      id,
      name: input.name,
      url: input.url,
      username: input.username,
      password: this.seal(input.password),
    })
    if (input.username !== '') this.passwords.set(id, input.password)
    await this.save()
    return id
  }

  async setPassword(id: string, password: string): Promise<boolean> {
    const server = this.servers.find((s) => s.id === id)
    if (!server) return false
    server.password = this.seal(password)
    this.passwords.set(id, password)
    await this.save()
    return true
  }

  async remove(id: string): Promise<void> {
    this.servers = this.servers.filter((s) => s.id !== id)
    this.passwords.delete(id)
    await this.save()
  }

  private seal(password: string): string | null {
    if (password === '' || !this.cipher.available()) return null
    try {
      return this.cipher.encrypt(password).toString('base64')
    } catch {
      return null
    }
  }
}

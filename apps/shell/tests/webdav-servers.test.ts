import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SecretCipher } from '../src/main/drive/drive-vault'
import { WebDavServers } from '../src/main/webdav/webdav-servers'
import { MAX_WEBDAV_SERVERS } from '../src/shared/webdav-api'

/** reversible stand-in for the OS cipher; marks its output so plain text would show */
const cipher = (available = true): SecretCipher => ({
  available: () => available,
  encrypt: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
  decrypt: (bytes) => [...bytes.toString().slice(4)].reverse().join(''),
})

const fileIn = () => join(mkdtempSync(join(tmpdir(), 'webdav-servers-')), 'webdav-servers.json')

const input = {
  name: 'Home NAS',
  url: 'https://nas.example.com/dav',
  username: 'me',
  password: 'hunter2',
}

describe('WebDavServers', () => {
  it('stores the password encrypted and reads it back after a restart', async () => {
    const file = fileIn()
    const first = new WebDavServers(file, cipher())
    const id = await first.add(input)
    expect(id).toBeTruthy()
    expect(readFileSync(file, 'utf8')).not.toContain('hunter2')

    const second = new WebDavServers(file, cipher())
    await second.load()
    expect(second.secrets(id!)).toMatchObject({ username: 'me', password: 'hunter2' })
    expect(second.info()[0]).toMatchObject({ hasPassword: true, persisted: true, insecure: false })
  })

  it('keeps the password only in memory when the system cannot encrypt', async () => {
    const file = fileIn()
    const first = new WebDavServers(file, cipher(false))
    const id = await first.add(input)
    expect(readFileSync(file, 'utf8')).not.toContain('hunter2')
    expect(first.info()[0]).toMatchObject({ hasPassword: true, persisted: false })

    const second = new WebDavServers(file, cipher(false))
    await second.load()
    expect(second.info()[0]).toMatchObject({ hasPassword: false })
    expect(second.secrets(id!)).toBeNull()
    await second.setPassword(id!, 'again')
    expect(second.secrets(id!)?.password).toBe('again')
  })

  it('treats an empty user name as an open server that needs no password', async () => {
    const servers = new WebDavServers(fileIn(), cipher())
    const id = await servers.add({ ...input, username: '', password: '' })
    expect(servers.info()[0]).toMatchObject({ open: true, hasPassword: true })
    expect(servers.secrets(id!)).toMatchObject({ username: '', password: '' })
  })

  it('flags plain HTTP and honors the limit', async () => {
    const servers = new WebDavServers(fileIn(), cipher())
    await servers.add({ ...input, url: 'http://nas.local' })
    expect(servers.info()[0]!.insecure).toBe(true)
    for (let i = 1; i < MAX_WEBDAV_SERVERS; i += 1) await servers.add(input)
    expect(await servers.add(input)).toBeNull()
  })

  it('removes a server and its password', async () => {
    const file = fileIn()
    const servers = new WebDavServers(file, cipher())
    const id = await servers.add(input)
    await servers.remove(id!)
    expect(servers.info()).toEqual([])
    expect(servers.secrets(id!)).toBeNull()
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain(id!)
  })
})

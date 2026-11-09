import { describe, expect, it, vi } from 'vitest'
import {
  WEBDAV_OUTBOUND_BLOCKED,
  createBridgedWebDavSkill,
  createWebDavSkill,
  guardWebDavContent,
  hasWebDavBridge,
  holdsWebDavContent,
  listAnswerOf,
  webdavReadAnswerOf,
  webdavSearchAnswerOf,
  type WebDavSkillDeps,
} from '../src/webdav-skill'
import { composeWithDrive } from '../src/drive-skill'
import { composeSkills, type AgentSkill } from '../src/skill'
import type { AgentMessage, AgentToolCall } from '../src/types'

const call = (name: string, input: Record<string, unknown> = {}): AgentToolCall => ({
  id: name,
  name,
  input,
})

function setup(over: Partial<WebDavSkillDeps> = {}) {
  let history: AgentMessage[] = []
  let enabled = true
  const deps: WebDavSkillDeps = {
    enabled: () => enabled,
    list: vi.fn(async (server: string) =>
      server
        ? {
            ok: true as const,
            entries: [
              { path: '/Reports', name: 'Reports', type: 'folder', modified: '' },
              {
                path: '/a.docx',
                name: 'a.docx',
                type: 'document',
                modified: '2026-11-01T00:00:00Z',
                size: 12,
              },
            ],
          }
        : { ok: true as const, servers: [{ id: 's1', name: 'Home NAS' }] },
    ),
    search: vi.fn(async () => ({
      ok: true as const,
      hits: [
        {
          server: 's1',
          serverName: 'Home NAS',
          path: '/Reports/minutes.docx',
          name: 'minutes.docx',
          type: 'document',
          modified: '2026-11-01T00:00:00Z',
        },
      ],
      incomplete: false,
    })),
    read: vi.fn(async (_s: string, _p: string, offset: number) => ({
      ok: true as const,
      page: { name: 'minutes.docx', text: 'hello', totalChars: 10, offset },
    })),
    messages: () => history,
    ...over,
  }
  const webdav = createWebDavSkill(deps)
  const editor: AgentSkill = {
    id: 'editor',
    systemPrompt: 'editor',
    tools: [{ name: 'web_search', description: '', inputSchema: { type: 'object' } }],
    executeTool: (c) => ({ output: `ran ${c.name}`, summary: c.name }),
  }
  const skill = guardWebDavContent(composeSkills('x', '', [webdav, editor]), webdav)
  return {
    deps,
    webdav,
    skill,
    setHistory: (h: AgentMessage[]) => (history = h),
    setEnabled: (v: boolean) => (enabled = v),
  }
}

describe('createWebDavSkill', () => {
  it('offers its tools and prompt only while enabled', () => {
    const { skill, setEnabled } = setup()
    const names = () => skill.tools.map((t) => t.name)
    expect(names()).toEqual(expect.arrayContaining(['webdav_list', 'webdav_search', 'webdav_read']))
    expect(skill.systemPrompt).toContain('WebDAV')
    setEnabled(false)
    expect(names()).toEqual(['web_search'])
    expect(skill.systemPrompt).not.toContain('WebDAV')
  })

  it('lists servers with no argument and a folder with one', async () => {
    const { skill } = setup()
    const servers = await skill.executeTool(call('webdav_list'))
    expect(servers.output).toContain('Home NAS')
    expect(servers.output).toContain('id: s1')
    const folder = await skill.executeTool(call('webdav_list', { server: 's1', path: '/' }))
    expect(folder.output).toContain('/Reports/')
    expect(folder.output).toContain('/a.docx')
  })

  it('searches and names the server id the read needs', async () => {
    const { skill, deps } = setup()
    const out = await skill.executeTool(call('webdav_search', { query: 'minutes', limit: 99 }))
    expect(out.output).toContain('/Reports/minutes.docx')
    expect(out.output).toContain('server id: s1')
    expect(deps.search).toHaveBeenCalledWith('minutes', '', '/', 30)
    expect((await skill.executeTool(call('webdav_search', { query: '  ' }))).isError).toBe(true)
  })

  it('says when a search was cut short', async () => {
    const { skill } = setup({
      search: async () => ({ ok: true as const, hits: [], incomplete: true }),
    })
    const out = await skill.executeTool(call('webdav_search', { query: 'x' }))
    expect(out.output).toContain('cut short')
  })

  it('refuses tools while disabled', async () => {
    const { skill, setEnabled } = setup()
    setEnabled(false)
    const out = await skill.executeTool(call('webdav_read', { server: 's1', path: '/a.docx' }))
    expect(out.isError).toBe(true)
  })

  it('needs server and path to read, and pages with the offset', async () => {
    const { skill, deps } = setup()
    expect((await skill.executeTool(call('webdav_read', { server: 's1' }))).isError).toBe(true)
    const out = await skill.executeTool(
      call('webdav_read', { server: 's1', path: '/a.docx', offset: 5 }),
    )
    expect(out.output).toContain('characters 5..10 of 10')
    expect(deps.read).toHaveBeenCalledWith('s1', '/a.docx', 5)
  })

  it('turns outbound tools off once a read succeeded, until a new chat', async () => {
    const { skill, setHistory } = setup()
    expect((await skill.executeTool(call('web_search', { q: 'x' }))).output).toBe('ran web_search')
    await skill.executeTool(call('webdav_read', { server: 's1', path: '/a.docx' }))
    const blocked = await skill.executeTool(call('web_search', { q: 'leak' }))
    expect(blocked).toMatchObject({ isError: true, output: WEBDAV_OUTBOUND_BLOCKED })
    // a new chat starts empty again
    setHistory([])
    skill.buildContext?.()
    expect((await skill.executeTool(call('web_search', { q: 'x' }))).isError).toBeFalsy()
  })

  it('does not block after a failed read, and blocks again for a restored transcript', async () => {
    const { skill, setHistory } = setup({
      read: async () => ({ ok: false as const, error: 'nope' }),
    })
    await skill.executeTool(call('webdav_read', { server: 's1', path: '/a.docx' }))
    expect((await skill.executeTool(call('web_search', { q: 'x' }))).isError).toBeFalsy()
    const restored: AgentMessage[] = [
      {
        role: 'tool',
        results: [{ id: '1', name: 'webdav_read', output: 'text', isError: false }],
      } as AgentMessage,
    ]
    expect(holdsWebDavContent(restored)).toBe(true)
    setHistory(restored)
    skill.buildContext?.()
    expect((await skill.executeTool(call('web_search', { q: 'x' }))).isError).toBe(true)
  })
})

describe('answers from the preload bridge', () => {
  it('checks the shape of each answer', () => {
    expect(listAnswerOf({ ok: true, servers: [{ id: 'a', name: 'b' }, { id: 1 }] })).toEqual({
      ok: true,
      servers: [{ id: 'a', name: 'b' }],
    })
    expect(listAnswerOf({ ok: false, error: 'bad' })).toEqual({ ok: false, error: 'bad' })
    expect(listAnswerOf(null).ok).toBe(false)
    expect(
      webdavSearchAnswerOf({
        ok: true,
        incomplete: true,
        hits: [
          { server: 's', serverName: 'n', path: '/p', name: 'p', type: 'pdf', modified: '' },
          { path: '/no-server', name: 'x', type: 'pdf', modified: '' },
        ],
      }),
    ).toMatchObject({ ok: true, incomplete: true, hits: [{ server: 's', path: '/p' }] })
    expect(webdavReadAnswerOf({ ok: true, page: { name: 'n', text: 't' } }).ok).toBe(false)
  })

  it('builds a skill over a bridge and follows its on/off broadcasts', async () => {
    let push: (on: boolean) => void = () => {}
    const bridge = {
      webdavAiEnabled: async () => true,
      webdavList: async () => ({ ok: true, servers: [] }),
      webdavSearch: async () => ({ ok: true, hits: [], incomplete: false }),
      webdavRead: async () => ({ ok: false, error: 'x' }),
      onWebdavAiChanged: (l: (on: boolean) => void) => {
        push = l
        return () => {}
      },
    }
    expect(hasWebDavBridge(bridge)).toBe(true)
    expect(hasWebDavBridge({})).toBe(false)
    const skill = createBridgedWebDavSkill(bridge, () => [])
    await new Promise((r) => setTimeout(r, 0))
    expect(skill.tools).toHaveLength(3)
    push(false)
    expect(skill.tools).toHaveLength(0)
  })

  it('joins an editor through composeWithDrive when the window bridge carries WebDAV', () => {
    const g = globalThis as { aiOfficeDriveAi?: unknown }
    g.aiOfficeDriveAi = {
      webdavAiEnabled: async () => true,
      webdavList: async () => ({ ok: true, servers: [] }),
      webdavSearch: async () => ({ ok: true, hits: [], incomplete: false }),
      webdavRead: async () => ({ ok: false, error: 'x' }),
    }
    try {
      const editor: AgentSkill = {
        id: 'editor',
        systemPrompt: 'editor',
        tools: [],
        executeTool: () => ({ output: '', summary: '' }),
      }
      const skill = composeWithDrive('x', '', () => [], [editor])
      // not enabled yet (the answer arrives asynchronously): the skill is composed in but offers nothing
      expect(skill.tools.map((t) => t.name)).not.toContain('webdav_read')
    } finally {
      delete g.aiOfficeDriveAi
    }
  })
})

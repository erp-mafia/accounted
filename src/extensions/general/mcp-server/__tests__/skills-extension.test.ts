/**
 * Tests for the MCP Skills extension (io.modelcontextprotocol/skills):
 * the capability, skills/list, skills/get and skill://<slug>/SKILL.md reads,
 * and the host-side checks every served skill has to pass (front matter
 * equal to the entry, digest and size equal to the bytes, a valid name).
 */
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import type { Skill } from '@/lib/agent-skills/types'
import { workflowSkills } from '../skills'
import { SKILLS_EXTENSION_ID, buildSkillFile, buildSkillFiles, skillEntry, skillFileUri, slugFromSkillFileUri } from '../skills/extension'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const ATOM_BODY = `---
name: konsult-it
description: >-
  IT consultancy bookkeeping. Trigger on konsult, timpris.
---

# IT-konsult

Book hours with gnubok_create_invoice.
`

const ATOM_ROW = {
  id: 'vertical/konsult-it',
  tier: 'vertical',
  title: 'IT-konsult',
  description: 'IT consultancy bookkeeping: "konsult", timpris, F-skatt. Trigger on konsult, timpris.',
  sni_prefixes: ['62.0'],
  body: ATOM_BODY,
  body_path: '.claude/skills/vertical/konsult-it/SKILL.md',
  version: 1,
  reviewed_at: null,
}

const mocks = vi.hoisted(() => ({ token: 'test-token' as string | null }))

function atomRegistry() {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => {
        const chain: Record<string, ReturnType<typeof vi.fn>> = {
          eq: vi.fn(() => chain),
          is: vi.fn(() => chain),
          not: vi.fn(() => chain),
          order: vi.fn().mockResolvedValue({ data: [ATOM_ROW], error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }
        return chain
      }),
    })),
  }
}

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn(() => mocks.token),
    validateApiKey: vi.fn().mockResolvedValue({ userId: 'user-1', companyId: 'company-1', scopes: [] }),
    createServiceClientNoCookies: vi.fn(() => atomRegistry()),
  }
})

import { handleMcpRequest } from '../server'

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

interface WireEntry {
  uri: string
  frontmatter: { name: string; description: string }
  resources: { uri: string; digest: string; size: number }[]
}

interface WireResult {
  resultType?: string
  ttlMs?: number
  cacheScope?: string
  nextCursor?: string
  capabilities?: { resources?: unknown; extensions: Record<string, unknown> }
  skills?: WireEntry[]
  skill?: WireEntry
  contents?: { uri: string; mimeType: string; text: string }[]
}

async function call(method: string, params: Record<string, unknown> = {}, query = '') {
  const response = await handleMcpRequest(
    new Request(`http://localhost:3000/api/extensions/ext/mcp-server/mcp${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(mocks.token ? { Authorization: `Bearer ${mocks.token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }),
    })
  )
  const body = await response.json()
  return { status: response.status, result: body.result as WireResult | undefined, error: body.error as { code: number } | undefined }
}

/** What a host does before it loads a skill: size, digest, then the front matter field by field. */
function hostVerifies(entry: WireEntry | Record<string, unknown> | undefined, text: string | undefined): void {
  const e = entry as WireEntry
  expect(typeof text).toBe('string')
  verifyEntry(e, text as string)
}

function verifyEntry(entry: WireEntry, text: string): void {
  const bytes = Buffer.from(text, 'utf8')
  const [file] = entry.resources
  expect(entry.resources).toHaveLength(1)
  expect(file.uri).toBe(entry.uri)
  expect(bytes.length).toBe(file.size)
  expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(file.digest)
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  expect(match).not.toBeNull()
  expect(yaml.load(match![1])).toEqual(entry.frontmatter)
  expect(entry.uri.split('/').at(-2)).toBe(entry.frontmatter.name)
}

const identity = (text: string) => text

describe('MCP Skills extension', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.token = 'test-token'
  })

  describe('building a SKILL.md', () => {
    it('serves every workflow skill under a valid, unique name with a description a host accepts', () => {
      const files = buildSkillFiles(workflowSkills, identity)
      expect(files).toHaveLength(workflowSkills.length)
      expect(new Set(files.map((f) => f.name)).size).toBe(files.length)
      for (const file of files) {
        expect(file.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        expect(file.name.length).toBeLessThanOrEqual(64)
        expect(file.description.length).toBeGreaterThan(0)
        expect(file.description.length).toBeLessThanOrEqual(1024)
        hostVerifies(skillEntry(file), file.text)
      }
    })

    it('replaces an atom\'s stored front matter with its name and full description, keeping the body', () => {
      const atom: Skill = {
        slug: 'vertical/konsult-it', name: 'IT-konsult', summary: 'IT consultancy bookkeeping.',
        description: ATOM_ROW.description, tags: [], body: ATOM_BODY, tier: 'vertical',
      }
      const file = buildSkillFile(atom, identity)!
      expect(file.uri).toBe('skill://vertical/konsult-it/SKILL.md')
      expect(file.name).toBe('konsult-it')
      expect(file.description).toBe(ATOM_ROW.description)
      expect(file.text.match(/^---$/gm)).toHaveLength(2)
      expect(file.text).toContain('# IT-konsult\n\nBook hours with gnubok_create_invoice.')
      hostVerifies(skillEntry(file), file.text)
    })

    it('round-trips a description holding quotes, colons, backslashes and line breaks', () => {
      const skill: Skill = {
        slug: 'odd', name: 'Odd', summary: 'x', tags: [], body: 'Body', tier: 'workflow',
        description: 'Moms: "25 %" \\ backslash\n# not a comment, - not a list: {not: a map} åäö',
      }
      const file = buildSkillFile(skill, identity)!
      expect(file.description).toBe('Moms: "25 %" \\ backslash # not a comment, - not a list: {not: a map} åäö')
      hostVerifies(skillEntry(file), file.text)
    })

    it('cuts a description past 1024 characters at a word boundary', () => {
      const skill: Skill = {
        slug: 'long', name: 'Long', summary: 'x', tags: [], body: 'Body', tier: 'workflow',
        description: 'word '.repeat(400),
      }
      const file = buildSkillFile(skill, identity)!
      expect(file.description.length).toBeLessThanOrEqual(1024)
      hostVerifies(skillEntry(file), file.text)
    })

    it('keeps a description within 1024 characters after tool names are renamed for the connection', () => {
      const skill: Skill = {
        slug: 'near-limit', name: 'Near', summary: 'x', tags: [], body: 'Body', tier: 'workflow',
        description: `${'gnubok_list_invoices '.repeat(48)}end`.slice(0, 1020),
      }
      const accountedNames = (text: string) => text.replace(/gnubok_/g, 'accounted_')
      const file = buildSkillFile(skill, accountedNames)!
      expect(file.description).toContain('accounted_list_invoices')
      expect(file.description).not.toContain('gnubok_')
      expect(file.description.length).toBeLessThanOrEqual(1024)
      hostVerifies(skillEntry(file), file.text)
    })

    it('serves no skill whose slug is an own item or not a valid skill path', () => {
      const base = { name: 'x', summary: 'x', tags: [], body: 'Body', tier: 'workflow' as const }
      expect(buildSkillFile({ ...base, slug: 'own/0b3c9a52-7a51-4f1e-9a51-0e6d3c1c2b11' }, identity)).toBeNull()
      expect(buildSkillFile({ ...base, slug: 'Month-End' }, identity)).toBeNull()
      expect(buildSkillFile({ ...base, slug: 'a--b' }, identity)).toBeNull()
      expect(buildSkillFile({ ...base, slug: `${'a'.repeat(65)}` }, identity)).toBeNull()
    })

    it('maps a slug to its SKILL.md URI and back, and nothing else', () => {
      expect(skillFileUri('vertical/konsult-it')).toBe('skill://vertical/konsult-it/SKILL.md')
      expect(slugFromSkillFileUri('skill://vertical/konsult-it/SKILL.md')).toBe('vertical/konsult-it')
      expect(slugFromSkillFileUri('skill://vertical/konsult-it/references/x.md')).toBeNull()
      expect(slugFromSkillFileUri('Accounted://skill/month-end-close')).toBeNull()
      expect(slugFromSkillFileUri('skill:///SKILL.md')).toBeNull()
      expect(slugFromSkillFileUri(42)).toBeNull()
    })
  })

  describe('over the wire', () => {
    it('declares the extension next to resources in server/discover', async () => {
      const { result } = await call('server/discover')
      expect(result?.capabilities?.resources).toBeDefined()
      expect(result?.capabilities?.extensions[SKILLS_EXTENSION_ID]).toEqual({})
    })

    it('lists the workflow skills and the registry atoms as complete entries with freshness hints', async () => {
      const { result } = await call('skills/list')
      expect(result?.resultType).toBe('complete')
      expect(result?.ttlMs).toBe(300_000)
      expect(result?.cacheScope).toBe('private')
      expect(result?.nextCursor).toBeUndefined()
      const uris = (result?.skills ?? []).map((s) => s.uri)
      expect(uris).toContain('skill://month-end-close/SKILL.md')
      expect(uris).toContain('skill://vertical/konsult-it/SKILL.md')
      expect(uris).toHaveLength(workflowSkills.length + 1)
    })

    it('serves each listed SKILL.md byte for byte as its entry describes', async () => {
      const { result: list } = await call('skills/list')
      expect(list?.skills?.length).toBeGreaterThan(0)
      for (const entry of list?.skills ?? []) {
        const { result } = await call('resources/read', { uri: entry.uri })
        expect(result?.contents?.[0]).toMatchObject({ uri: entry.uri, mimeType: 'text/markdown' })
        hostVerifies(entry, result?.contents?.[0].text)
      }
    })

    it('answers skills/get with the same entry, and -32602 for a skill it does not serve', async () => {
      const { result: list } = await call('skills/list')
      const listed = list?.skills?.find((s) => s.uri === 'skill://vertical/konsult-it/SKILL.md')
      const { result } = await call('skills/get', { uri: 'skill://vertical/konsult-it/SKILL.md' })
      expect(result?.resultType).toBe('complete')
      expect(result?.ttlMs).toBe(300_000)
      expect(result?.skill).toEqual(listed)

      for (const uri of ['skill://no-such-skill/SKILL.md', 'Accounted://skill/month-end-close', undefined]) {
        const { error } = await call('skills/get', uri === undefined ? {} : { uri })
        expect(error?.code).toBe(-32602)
      }
      const { error } = await call('resources/read', { uri: 'skill://month-end-close/references/x.md' })
      expect(error?.code).toBe(-32602)
    })

    it('names the tools of the connection\'s namespace, and digests those bytes', async () => {
      const legacy = (await call('skills/get', { uri: 'skill://vertical/konsult-it/SKILL.md' })).result?.skill
      const accounted = (await call('skills/get', { uri: 'skill://vertical/konsult-it/SKILL.md' }, '?tool_namespace=accounted')).result?.skill
      expect(accounted?.resources[0].digest).not.toBe(legacy?.resources[0].digest)
      const { result } = await call('resources/read', { uri: 'skill://vertical/konsult-it/SKILL.md' }, '?tool_namespace=accounted')
      expect(result?.contents?.[0].text).toContain('accounted_create_invoice')
      hostVerifies(accounted, result?.contents?.[0].text)
    })

    it('lists and describes skills to a client that has not connected an account yet', async () => {
      mocks.token = null
      const list = await call('skills/list')
      expect(list.status).toBe(200)
      expect(list.result?.skills).toHaveLength(workflowSkills.length + 1)
      const get = await call('skills/get', { uri: 'skill://month-end-close/SKILL.md' })
      expect(get.result?.skill?.frontmatter.name).toBe('month-end-close')
    })
  })
})

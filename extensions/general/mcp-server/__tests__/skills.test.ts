/**
 * Tests for skills over MCP: registry, discovery tools, and resource exposure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { workflowSkills, findSkill, SKILL_URI_PREFIX, skillUri, __resetAtomCache } from '../skills'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

/** Build a supabase mock that satisfies the queries gnubok_list_skills issues:
 *   - agent_atom_registry (empty atom set, so only static workflows surface)
 *   - company_settings (entity_type + vat_registered, used by applicability filter)
 *   - employees (active count, used by applicability filter)
 *
 *  All test queries resolve to the same defaults: entity_type='AB',
 *  vat_registered=true, 1 active employee: so every applicability-filtered
 *  skill is included by default. Individual tests can override via the
 *  optional overrides parameter.
 */
function makeSupabaseWithEmptyAtomRegistry(
  rows: unknown[] = [],
  overrides: { entityType?: string | null; vatRegistered?: boolean; employeeCount?: number } = {},
  refRow: unknown = null,
) {
  const entityType = overrides.entityType ?? 'AB'
  const vatRegistered = overrides.vatRegistered ?? true
  const employeeCount = overrides.employeeCount ?? 1

  return {
    from: vi.fn((table: string) => {
      if (table === 'company_settings') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: entityType === null ? null : { entity_type: entityType, vat_registered: vatRegistered },
                error: null,
              }),
            })),
          })),
        }
      }
      if (table === 'employees') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ count: employeeCount, data: null, error: null }),
            })),
          })),
        }
      }
      // Default: agent_atom_registry. The same chain serves two query shapes:
      //   - loadAtomsAsSkills:   .eq().eq().is('parent_atom_id', null).order()  → resolves `rows`
      //   - loadReferenceById:   .eq('id').not('parent_atom_id','is',null).maybeSingle() → resolves `refRow`
      return {
        select: vi.fn(() => {
          const chain: Record<string, ReturnType<typeof vi.fn>> = {
            eq: vi.fn(() => chain),
            is: vi.fn(() => chain),
            not: vi.fn(() => chain),
            order: vi.fn().mockResolvedValue({ data: rows, error: null }),
            maybeSingle: vi.fn().mockResolvedValue({ data: refRow, error: null }),
          }
          return chain
        }),
      }
    }),
  }
}

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      // Minimal scopes: list/load skill tools are intentionally unscoped.
      scopes: [],
    }),
    createServiceClientNoCookies: vi.fn(() => makeSupabaseWithEmptyAtomRegistry()),
  }
})

import { handleMcpRequest } from '../server'

/** Alias for the legacy workflow-only array. New code reads `workflowSkills`. */
const skills = workflowSkills

function mcpRequest(method: string, params?: Record<string, unknown>, id: number | string = 1): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

async function parseResult(response: Response) {
  const json = await response.json()
  return json.result
}

describe('Skills registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAtomCache()
  })

  it('exports a non-empty workflowSkills array', () => {
    expect(skills.length).toBeGreaterThanOrEqual(5)
  })

  it('every skill has unique slug', () => {
    const slugs = skills.map((s) => s.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('every skill body is non-trivial and contains a Tools section', () => {
    for (const s of skills) {
      expect(s.body.length, `skill ${s.slug} body length`).toBeGreaterThan(500)
      expect(s.body, `skill ${s.slug} should have a ## Tools section`).toMatch(/## Tools/i)
    }
  })

  it('every skill has the expected metadata shape', () => {
    for (const s of skills) {
      expect(s.slug).toMatch(/^[a-z0-9-]+$/)
      expect(s.name).toBeTruthy()
      expect(s.summary.length).toBeGreaterThan(20)
      expect(s.summary.length).toBeLessThan(200)
      expect(Array.isArray(s.tags)).toBe(true)
      expect(s.tags.length).toBeGreaterThan(0)
      expect(s.tier).toBe('workflow')
    }
  })

  it('findSkill resolves the workflow skill or null (sync workflow lookup)', async () => {
    const supabase = makeSupabaseWithEmptyAtomRegistry()
    expect(await findSkill('month-end-close', supabase as never)).toBeTruthy()
    expect(await findSkill('does-not-exist', supabase as never)).toBeNull()
  })

  it('skillUri uses the Accounted://skill/ prefix; atom slugs are URL-encoded', () => {
    expect(skillUri('foo')).toBe('Accounted://skill/foo')
    expect(skillUri('vertical/konsult-it')).toBe('Accounted://skill/vertical%2Fkonsult-it')
    expect(SKILL_URI_PREFIX).toBe('Accounted://skill/')
  })
})

describe('gnubok_list_skills tool', () => {
  beforeEach(() => {
    __resetAtomCache()
  })

  it('is registered with correct annotations and no scope requirement', () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')
    expect(tool).toBeDefined()
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.annotations.idempotentHint).toBe(true)
  })

  it('returns all workflow skills when called with no args (empty atom registry)', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const supabase = makeSupabaseWithEmptyAtomRegistry()
    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      skills: Array<{ slug: string; name: string; summary: string; tags: string[]; tier: string }>
      count: number
    }
    expect(result.count).toBe(skills.length)
    expect(result.skills.every((s) => s.slug && s.name && s.summary && s.tier === 'workflow')).toBe(true)
    // Body should NOT be returned by list (token saving).
    expect((result.skills[0] as Record<string, unknown>).body).toBeUndefined()
  })

  it('filters by tag', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const supabase = makeSupabaseWithEmptyAtomRegistry()
    const result = (await tool.execute({ tag: 'vat' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      skills: Array<{ slug: string; tags: string[] }>
      count: number
    }
    expect(result.count).toBeGreaterThan(0)
    for (const s of result.skills) {
      expect(s.tags.map((t) => t.toLowerCase())).toContain('vat')
    }
  })

  it('filters by tier=workflow (excludes atoms when both present)', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const supabase = makeSupabaseWithEmptyAtomRegistry()
    const result = (await tool.execute({ tier: 'workflow' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      skills: Array<{ tier: string }>
      count: number
    }
    expect(result.count).toBeGreaterThan(0)
    for (const s of result.skills) {
      expect(s.tier).toBe('workflow')
    }
  })

  it('filters by tier=horizontal/vertical/modifier (returns empty when no atoms)', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const supabase = makeSupabaseWithEmptyAtomRegistry()
    for (const tier of ['horizontal', 'vertical', 'modifier']) {
      const result = (await tool.execute({ tier }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
        count: number
      }
      expect(result.count).toBe(0)
    }
  })

  it('surfaces registry atoms alongside workflow skills', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    // Body path points at a real SKILL.md on disk (seeded by Phase 3).
    const supabase = makeSupabaseWithEmptyAtomRegistry([
      {
        id: 'vertical/konsult-it',
        tier: 'vertical',
        title: 'IT-konsult & systemutvecklare (SNI 62)',
        description: 'Konsult-IT description',
        sni_prefixes: ['62.01'],
        body_path: '.claude/skills/industry/konsult-it/SKILL.md',
      },
    ])
    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      skills: Array<{ slug: string; tier: string }>
      count: number
    }
    expect(result.count).toBe(skills.length + 1)
    expect(result.skills.find((s) => s.slug === 'vertical/konsult-it')?.tier).toBe('vertical')
  })

  it('applicability filter hides AB-only skills for EF companies', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const supabase = makeSupabaseWithEmptyAtomRegistry([], { entityType: 'EF', employeeCount: 0, vatRegistered: true })
    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      skills: Array<{ slug: string }>
      hidden_count: number
      company_context: { entity_type: string | null; has_employees: boolean; vat_registered: boolean }
    }
    const slugs = result.skills.map((s) => s.slug)
    expect(slugs).not.toContain('year-end-close') // AB-only
    expect(slugs).not.toContain('payroll-monthly') // requires employees
    expect(slugs).toContain('month-end-close')
    expect(slugs).toContain('invoicing-rules')
    expect(slugs).toContain('quarterly-vat-review') // vat_registered=true
    expect(result.hidden_count).toBeGreaterThan(0)
    expect(result.company_context).toEqual({ entity_type: 'EF', has_employees: false, vat_registered: true })
  })

  it('include_all=true bypasses applicability filter', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const supabase = makeSupabaseWithEmptyAtomRegistry([], { entityType: 'EF', employeeCount: 0, vatRegistered: false })
    const filtered = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      count: number
      hidden_count: number
    }
    const unfiltered = (await tool.execute({ include_all: true }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      count: number
      hidden_count: number
    }
    expect(unfiltered.count).toBe(filtered.count + filtered.hidden_count)
    expect(unfiltered.hidden_count).toBe(0)
  })

  it('tier=vertical filter returns only verticals', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_skills')!
    const supabase = makeSupabaseWithEmptyAtomRegistry([
      {
        id: 'vertical/konsult-it',
        tier: 'vertical',
        title: 'Konsult-IT',
        description: 'desc',
        sni_prefixes: ['62.01'],
        body_path: '.claude/skills/industry/konsult-it/SKILL.md',
      },
    ])
    const result = (await tool.execute({ tier: 'vertical' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      skills: Array<{ slug: string; tier: string }>
      count: number
    }
    expect(result.count).toBe(1)
    expect(result.skills[0].slug).toBe('vertical/konsult-it')
  })
})

describe('gnubok_load_skill tool', () => {
  beforeEach(() => {
    __resetAtomCache()
  })

  it('is registered', () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')
    expect(tool).toBeDefined()
  })

  it('returns full body for a valid workflow slug', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    const supabase = makeSupabaseWithEmptyAtomRegistry()
    const result = (await tool.execute({ slug: 'month-end-close' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      slug: string
      name: string
      tier: string
      body: string
    }
    expect(result.slug).toBe('month-end-close')
    expect(result.tier).toBe('workflow')
    expect(result.body).toContain('# Month-End Close')
    expect(result.body).toContain('## Tools')
  })

  it('throws structured error for unknown slug', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    const supabase = makeSupabaseWithEmptyAtomRegistry()
    await expect(
      tool.execute({ slug: 'nonexistent-skill' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
    ).rejects.toThrow(/Skill not found.*Available skills/)
  })

  it('throws when slug is missing or empty', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    const supabase = makeSupabaseWithEmptyAtomRegistry()
    await expect(
      tool.execute({ slug: '' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
    ).rejects.toThrow(/slug is required/)
  })

  it('resolves an atom slug from the registry and returns its DB body', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    const supabase = makeSupabaseWithEmptyAtomRegistry([
      {
        id: 'vertical/konsult-it',
        tier: 'vertical',
        title: 'Konsult-IT',
        description: 'desc',
        sni_prefixes: ['62.01'],
        // Body now comes from the DB column, not disk. The frontmatter must be
        // preserved verbatim (the composer/system-prompt rely on the `id:` line).
        body: '---\nid: vertical/konsult-it\ntier: vertical\n---\n\n# Konsult-IT (loaded from DB)',
        body_path: '.claude/skills/industry/konsult-it/SKILL.md',
      },
    ])
    const result = (await tool.execute({ slug: 'vertical/konsult-it' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      slug: string
      tier: string
      body: string
    }
    expect(result.slug).toBe('vertical/konsult-it')
    expect(result.tier).toBe('vertical')
    // Frontmatter preserved, and the body is the DB value (not the on-disk file).
    expect(result.body).toContain('id: vertical/konsult-it')
    expect(result.body).toContain('loaded from DB')
  })

  it('resolves a reference child by id even though it is hidden from the listed atom set', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    // Listed atoms (loadAtomsAsSkills) is empty: the reference is only reachable
    // via loadReferenceById, which findSkill falls back to.
    const supabase = makeSupabaseWithEmptyAtomRegistry([], {}, {
      id: 'horizontal/swedish-vat/vat-compliance-reference',
      tier: 'horizontal',
      title: 'Swedish VAT (Moms) Complete Compliance Reference',
      description: 'desc',
      sni_prefixes: [],
      body: '# Swedish VAT (Moms) Complete Compliance Reference\n\nDeep reference body.',
      body_path: '.claude/skills/swedish-vat/references/vat-compliance-reference.md',
      is_active: true,
      mcp_exposed: true,
      parent_atom_id: 'horizontal/swedish-vat',
    })
    const result = (await tool.execute(
      { slug: 'horizontal/swedish-vat/vat-compliance-reference' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { slug: string; tier: string; tags: string[]; body: string }
    expect(result.slug).toBe('horizontal/swedish-vat/vat-compliance-reference')
    expect(result.tier).toBe('horizontal')
    expect(result.tags).toContain('reference')
    expect(result.body).toContain('Deep reference body.')
  })

  it('does not resolve a reference whose curation switch (mcp_exposed) is off', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
    const supabase = makeSupabaseWithEmptyAtomRegistry([], {}, {
      id: 'horizontal/swedish-vat/vat-compliance-reference',
      tier: 'horizontal',
      title: 'x',
      description: 'desc',
      sni_prefixes: [],
      body: '# body',
      body_path: '.claude/skills/swedish-vat/references/vat-compliance-reference.md',
      is_active: true,
      mcp_exposed: false,
      parent_atom_id: 'horizontal/swedish-vat',
    })
    await expect(
      tool.execute(
        { slug: 'horizontal/swedish-vat/vat-compliance-reference' },
        'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/Skill not found/)
  })

  it('skips an atom whose body is null in the DB (no on-disk fallback in prod)', async () => {
    const prev = process.env.NODE_ENV
    // Force the prod path so the dev disk-fallback is disabled.
    process.env.NODE_ENV = 'production'
    try {
      const tool = tools.find((t) => t.name === 'gnubok_load_skill')!
      const supabase = makeSupabaseWithEmptyAtomRegistry([
        {
          id: 'vertical/konsult-it',
          tier: 'vertical',
          title: 'Konsult-IT',
          description: 'desc',
          sni_prefixes: ['62.01'],
          body: null,
          body_path: '.claude/skills/industry/konsult-it/SKILL.md',
        },
      ])
      // The atom is skipped (empty body), so the slug is not found.
      await expect(
        tool.execute({ slug: 'vertical/konsult-it' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      ).rejects.toThrow()
    } finally {
      process.env.NODE_ENV = prev
    }
  })
})

describe('Skills via MCP protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Protocol tests use the createServiceClientNoCookies mock (empty registry):
    // reset the module-level atom cache so we don't see stragglers from
    // earlier tests in the file that populated the cache via direct execute().
    __resetAtomCache()
  })

  it('resources/list includes one entry per skill at Accounted://skill/<slug>', async () => {
    const res = await handleMcpRequest(mcpRequest('resources/list'))
    const result = await parseResult(res)
    const uris = result.resources.map((r: { uri: string }) => r.uri)
    for (const skill of skills) {
      expect(uris).toContain(skillUri(skill.slug))
    }
  })

  it('skill resources have the text/markdown mimeType', async () => {
    const res = await handleMcpRequest(mcpRequest('resources/list'))
    const result = await parseResult(res)
    const skillResources = result.resources.filter((r: { uri: string }) =>
      r.uri.startsWith(SKILL_URI_PREFIX)
    )
    expect(skillResources.length).toBe(skills.length)
    for (const r of skillResources) {
      expect(r.mimeType).toBe('text/markdown')
    }
  })

  it('resources/read returns the Markdown body for a skill URI', async () => {
    const res = await handleMcpRequest(
      mcpRequest('resources/read', { uri: 'Accounted://skill/quarterly-vat-review' })
    )
    const result = await parseResult(res)
    expect(result.contents).toHaveLength(1)
    expect(result.contents[0].uri).toBe('Accounted://skill/quarterly-vat-review')
    expect(result.contents[0].mimeType).toBe('text/markdown')
    expect(result.contents[0].text).toContain('# Quarterly VAT Review')
  })

  it('resources/read returns Resource not found for unknown skill slug', async () => {
    const res = await handleMcpRequest(
      mcpRequest('resources/read', { uri: 'Accounted://skill/does-not-exist' })
    )
    const json = await res.json()
    expect(json.error).toBeDefined()
    expect(json.error.message).toContain('Resource not found')
  })

  it('tools/list includes both skill tools', async () => {
    const res = await handleMcpRequest(mcpRequest('tools/list'))
    const result = await parseResult(res)
    const names = result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('gnubok_list_skills')
    expect(names).toContain('gnubok_load_skill')
  })
})

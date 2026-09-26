/**
 * gnubok_get_task as a tool: what it records. An agent run or an analysis
 * delivers its bodies inline instead of through load_skill, so the tool emits
 * mcp.skill_loaded for them itself, in the company the task runs in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/agent-skills/catalog', () => ({ loadSkillCatalog: vi.fn(), loadCatalogSkill: vi.fn() }))
vi.mock('@/lib/agent-skills/agent-bundle', async (original) => ({ ...(await original<object>()), loadAgentBundle: vi.fn() }))

import { eventBus } from '@/lib/events/bus'
import { loadCatalogSkill } from '@/lib/agent-skills/catalog'
import { loadAgentBundle } from '@/lib/agent-skills/agent-bundle'
import { analysisSkills } from '@/lib/agent-skills/analyses'
import { tools, type ActorContext } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_get_task')!
const actor: ActorContext = { type: 'api_key', id: 'key-1', label: 'MCP-klient (OAuth)', sessionId: 'session-1' }

/** Answers the company name and the key's stored client; every call is recorded. */
function db(storedClient: string | null = null) {
  const calls: Array<{ table: string; args: unknown[] }> = []
  return {
    calls,
    from(table: string) {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = (...args: unknown[]) => { calls.push({ table, args }); return chain }
      chain.maybeSingle = async () => ({ data: table === 'companies' ? { name: 'Arcim Technology AB' } : table === 'api_keys' ? { client: storedClient } : null, error: null })
      return chain
    },
  }
}

describe('gnubok_get_task', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('lists unattended in its wire schema and stays a read', () => {
    expect((tool.inputSchema.properties as Record<string, unknown>).unattended).toEqual({ type: 'boolean' })
    expect(tool.annotations.readOnlyHint).toBe(true)
  })

  it('records an analysis it delivered inline, as load_skill would have', async () => {
    const emit = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined as never)
    vi.mocked(loadCatalogSkill).mockResolvedValue(analysisSkills[1])
    const task = await tool.execute({ kind: 'skill:analys-kassaprognos' }, 'company-a', 'user-1', db() as never, actor) as { analysis: { slug: string } }
    expect(task.analysis.slug).toBe('analys-kassaprognos')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mcp.skill_loaded',
      payload: expect.objectContaining({ slug: 'analys-kassaprognos', tier: 'workflow', companyId: 'company-a', actorId: 'key-1', sessionId: 'session-1' }),
    }))
  })

  it('reads the key it was called with for a missing client', async () => {
    vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined as never)
    vi.mocked(loadAgentBundle).mockResolvedValue(null)
    const supabase = db('grok')
    await expect(tool.execute({ kind: 'agent:kvittojakten' }, 'company-a', 'user-1', supabase as never, actor)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(loadAgentBundle).toHaveBeenCalledWith(supabase, 'company-a', 'kvittojakten', 'grok')
    expect(supabase.calls).toContainEqual({ table: 'api_keys', args: ['id', 'key-1'] })
  })

  it('records an agent run in the company it ran in', async () => {
    const emit = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined as never)
    vi.mocked(loadAgentBundle).mockResolvedValue({
      agent: { id: 'quarterly-vat-review', name: 'Momsdeklaration' },
      workflow: { slug: 'quarterly-vat-review', version: 4, body: '# Moms' },
      knowledge: [{ id: 'horizontal/swedish-vat', tier: 'horizontal', source: 'default', title: 'Moms', summary: '', version: 7, reviewed_at: null, body: '# VAT' }],
      industry_sections: [], references: [], company: [], connections: [],
      company_knowledge: { name: 'Arcim', org_number: null, onboarding_summary: null, facts: [], remembered: [], documents: { total: 0, look_up: [] } },
    })
    await tool.execute({ kind: 'agent:quarterly-vat-review', client: 'claude' }, 'company-a', 'user-1', db() as never, actor)
    const slugs = emit.mock.calls.map(([event]) => (event as { payload: { slug: string; companyId: string } }).payload)
    expect(slugs).toEqual([
      expect.objectContaining({ slug: 'quarterly-vat-review', companyId: 'company-a' }),
      expect.objectContaining({ slug: 'horizontal/swedish-vat', companyId: 'company-a' }),
    ])
  })
})

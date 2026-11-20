/**
 * gnubok_remember_fact: where a fact came from (origin, the MCP client) and
 * updating an older fact (replaces), which retires it so agents stop seeing it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const tool = tools.find((t) => t.name === 'gnubok_remember_fact')!
const actor = { type: 'api_key' as const, id: 'key-1', client: 'claude' }

const saved = (id: string, content: string) => ({ id, kind: 'fact', content, created_at: '2026-10-29T08:00:00Z' })

beforeEach(() => reset())

describe('gnubok_remember_fact', () => {
  it('records origin conversation and the MCP client when the agent passes no origin', async () => {
    enqueue({ data: [] }) // dedup read: nothing similar
    enqueue({ data: saved('fact-1', 'Bolaget har två anställda sedan september.') })
    const result = await tool.execute({ content: 'Bolaget har två anställda sedan september.' }, 'company-a', 'user-1', supabase as never, actor)

    expect(result).toMatchObject({ fact_id: 'fact-1' })
    expect(result).not.toHaveProperty('replaced_fact_id')
    expect(findCalls('agent_memory', 'insert')[0][0]).toMatchObject({
      company_id: 'company-a',
      content: 'Bolaget har två anställda sedan september.',
      source: 'agent_learned',
      origin: 'conversation',
      client: 'claude',
    })
  })

  it('records the origin the agent names', async () => {
    enqueue({ data: [] })
    enqueue({ data: saved('fact-2', 'Ägaren tar lön, ingen utdelning.') })
    await tool.execute({ content: 'Ägaren tar lön, ingen utdelning.', origin: 'onboarding_import' }, 'company-a', 'user-1', supabase as never, actor)
    expect(findCalls('agent_memory', 'insert')[0][0]).toMatchObject({ origin: 'onboarding_import' })
  })

  it('refuses an unknown origin before reading anything', async () => {
    await expect(
      tool.execute({ content: 'Hyran är 12 000 kr.', origin: 'gossip' }, 'company-a', 'user-1', supabase as never, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'origin' }] })
    expect(findCalls('agent_memory', 'select')).toEqual([])
  })

  it('saves the update and retires the fact it replaces, without the duplicate check', async () => {
    enqueue({ data: { id: 'fact-old' } }) // the fact to replace: active, this company
    enqueue({ data: saved('fact-new', 'Hyran höjs till 14 000 kr från januari 2027.') })
    enqueue({ data: null }) // retire
    const result = await tool.execute(
      { content: 'Hyran höjs till 14 000 kr från januari 2027.', replaces: 'fact-old' },
      'company-a', 'user-1', supabase as never, actor,
    )

    expect(result).toMatchObject({ fact_id: 'fact-new', replaced_fact_id: 'fact-old' })
    // The lookup is scoped to the company and to active facts.
    expect(findCalls('agent_memory', 'eq').slice(0, 3)).toEqual([['id', 'fact-old'], ['company_id', 'company-a'], ['is_active', true]])
    // One read (the target), no dedup scan over the company's facts.
    expect(findCalls('agent_memory', 'limit')).toEqual([])
    const update = findCalls('agent_memory', 'update')[0][0] as Record<string, unknown>
    expect(update).toMatchObject({ is_active: false, superseded_by: 'fact-new' })
    expect(findCalls('agent_memory', 'eq').slice(-2)).toEqual([['id', 'fact-old'], ['company_id', 'company-a']])
  })

  it('refuses to replace a fact that is not an active fact of this company, and writes nothing', async () => {
    enqueue({ data: null }) // not found in this company (another company's, retired or made up)
    await expect(
      tool.execute({ content: 'Hyran är 14 000 kr.', replaces: 'fact-of-another-company' }, 'company-a', 'user-1', supabase as never, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'replaces' }] })
    expect(findCalls('agent_memory', 'insert')).toEqual([])
    expect(findCalls('agent_memory', 'update')).toEqual([])
  })

  it('saves without origin and client while the migration that adds them has not run', async () => {
    enqueue({ data: [] })
    enqueue({ data: null, error: { code: 'PGRST204', message: "Could not find the 'client' column" } })
    enqueue({ data: saved('fact-3', 'Kunder i Tyskland sedan i våras.') })
    const result = await tool.execute({ content: 'Kunder i Tyskland sedan i våras.' }, 'company-a', 'user-1', supabase as never, actor)

    expect(result).toMatchObject({ fact_id: 'fact-3' })
    const inserts = findCalls('agent_memory', 'insert').map((args) => args[0] as Record<string, unknown>)
    expect(inserts).toHaveLength(2)
    expect(inserts[0]).toHaveProperty('origin', 'conversation')
    expect(inserts[1]).not.toHaveProperty('origin')
    expect(inserts[1]).not.toHaveProperty('client')
  })

  it('stores no client outside MCP', async () => {
    enqueue({ data: [] })
    enqueue({ data: saved('fact-4', 'Bokslut görs av byrån.') })
    await tool.execute({ content: 'Bokslut görs av byrån.' }, 'company-a', 'user-1', supabase as never, { type: 'user' })
    expect(findCalls('agent_memory', 'insert')[0][0]).toMatchObject({ client: null })
  })
})

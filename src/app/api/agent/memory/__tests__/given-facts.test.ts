/**
 * One set of memory rows read through every place that says what an agent is
 * given: the briefing's read, the count on the agent picture's company card
 * and the list a person reads beside it (GET /api/agent/memory?given=true).
 * A fact a later one replaced is in none of them, whether it is hidden or
 * was shown again.
 *
 * The client answers from the rows, applying each read's own filters, so the
 * test judges what each place concludes and not which calls it makes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockRequest, createMockRouteParams, createRowsMockSupabase, parseJsonResponse } from '@/tests/helpers'

const COMPANY = 'company-1'

type MemoryRow = Record<string, unknown>

const memory = (id: string, over: MemoryRow = {}): MemoryRow => ({
  id,
  company_id: COMPANY,
  kind: 'fact',
  content: `Fact ${id}`,
  source: 'agent_learned',
  source_ref: null,
  relevance_score: 0.8,
  is_pinned: false,
  is_active: true,
  superseded_by: null,
  last_accessed_at: null,
  created_at: '2026-03-01T08:00:00.000Z',
  updated_at: '2026-03-01T08:00:00.000Z',
  created_by_user_id: null,
  origin: null,
  client: null,
  ...over,
})

/** Every state a memory row can be in, and one row of another company. */
function rows(): MemoryRow[] {
  return [
    memory('current'),
    memory('newer', { created_at: '2026-03-03T08:00:00.000Z' }),
    // Hidden by a person: not given, and it can be brought back.
    memory('hidden', { is_active: false }),
    // Replaced by `newer`: hidden when it was replaced.
    memory('replaced', { is_active: false, superseded_by: 'newer' }),
    // Replaced by `newer`, then shown again: still replaced.
    memory('replaced-shown-again', { superseded_by: 'newer' }),
    memory('other-company', { company_id: 'company-2' }),
  ]
}

const state = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(state.client),
  createServiceClient: () => state.client,
}))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: async () => COMPANY }))

import { GET } from '../route'
import { filterGivenFacts, loadRememberedFacts } from '@/lib/agent-context/remembered-facts'
import { loadAgentActivity } from '@/lib/agent-context/agent-picture'

let supabase: SupabaseClient

beforeEach(() => {
  const mock = createRowsMockSupabase({ agent_memory: rows() })
  mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } }, error: null })
  state.client = mock.supabase
  supabase = mock.supabase as unknown as SupabaseClient
})

async function listed(query: string): Promise<string[]> {
  const response = await GET(createMockRequest(`/api/agent/memory${query}`), createMockRouteParams({}))
  const { status, body } = await parseJsonResponse<{ data: Array<{ id: string }> }>(response)
  expect(status).toBe(200)
  return body.data.map((row) => row.id).sort()
}

describe('the facts an agent is given', () => {
  it('are the ones that are not hidden and that no later fact replaced, in the briefing', async () => {
    const { facts } = await loadRememberedFacts(supabase, COMPANY)
    expect(facts.map((fact) => fact.fact_id)).toEqual(['newer', 'current'])
  })

  it('are counted the same on the agent picture: a replaced row is not counted', async () => {
    const activity = await loadAgentActivity(supabase, COMPANY, new Date('2026-03-04T09:00:00.000Z'))
    expect(activity.memory_facts).toBe(2)
  })

  it('are the rows of the plain memory list: a replaced row is not listed, shown again or not', async () => {
    expect(await listed('?given=true')).toEqual(['current', 'newer'])
  })

  it('are joined in the plain list by the rows a person hid, never by a replaced one', async () => {
    expect(await listed('?given=true&include_dismissed=true')).toEqual(['current', 'hidden', 'newer'])
  })

  it('agree across the three: the count is the length of the list and of the briefing', async () => {
    const [list, briefing, activity] = await Promise.all([
      listed('?given=true'),
      loadRememberedFacts(supabase, COMPANY),
      loadAgentActivity(supabase, COMPANY, new Date('2026-03-04T09:00:00.000Z')),
    ])
    expect(list).toEqual(briefing.facts.map((fact) => fact.fact_id).sort())
    expect(activity.memory_facts).toBe(list.length)
  })

  it('are one rule: the count read through it is the same number', async () => {
    const { count } = await filterGivenFacts(supabase.from('agent_memory').select('id', { count: 'exact', head: true }).eq('company_id', COMPANY))
    expect(count).toBe(2)
  })
})

describe('the full memory list', () => {
  it('keeps what it showed: every row that is not hidden, a replaced one that was shown again among them', async () => {
    expect(await listed('')).toEqual(['current', 'newer', 'replaced-shown-again'])
  })

  it('keeps every row of the company with the hidden ones asked for', async () => {
    expect(await listed('?include_dismissed=true')).toEqual(['current', 'hidden', 'newer', 'replaced', 'replaced-shown-again'])
  })

  it('reads `given=false` as no choice at all', async () => {
    expect(await listed('?given=false')).toEqual(['current', 'newer', 'replaced-shown-again'])
  })
})

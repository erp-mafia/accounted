import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('../build', () => ({ buildCompanyGraph: vi.fn() }))

import { buildCompanyGraph } from '../build'
import { getCompanyGraph, markCompanyGraphStale, refreshCompanyGraph } from '../snapshot'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const built = { company: { ref: 'company:c', name: 'X' }, computed_at: '2026-10-01T10:00:00Z', period: { from: '', to: '' }, months: [], series: {}, clusters: [], nodes: [{ ref: 'a' }], links: [], truncated: false }

beforeEach(() => {
  reset()
  vi.clearAllMocks()
  ;(buildCompanyGraph as ReturnType<typeof vi.fn>).mockResolvedValue(built)
})

describe('company graph snapshot', () => {
  it('serves a fresh snapshot without building', async () => {
    enqueue({ data: { graph: { nodes: [], links: [], computed_at: 'x' }, computed_at: new Date().toISOString(), stale: false } })
    const g = await getCompanyGraph(supabase, 'c')
    expect(g).toMatchObject({ nodes: [] })
    expect(buildCompanyGraph).not.toHaveBeenCalled()
  })

  it('rebuilds and saves when the snapshot is missing, stale, or old', async () => {
    enqueue({ data: null })
    enqueue({})
    expect(await getCompanyGraph(supabase, 'c')).toBe(built)
    expect(JSON.stringify(findCalls('arkiv_graph_snapshots', 'upsert'))).toContain('"node_count":1')

    enqueue({ data: { graph: {}, computed_at: new Date().toISOString(), stale: true } })
    enqueue({})
    await getCompanyGraph(supabase, 'c')
    enqueue({ data: { graph: {}, computed_at: '2026-01-01T00:00:00Z', stale: false } })
    enqueue({})
    await getCompanyGraph(supabase, 'c')
    expect(buildCompanyGraph).toHaveBeenCalledTimes(3)
  })

  it('keeps the graph when the save fails, and marks stale without ever throwing', async () => {
    enqueue({ error: { message: 'permission denied' } })
    expect(await refreshCompanyGraph(supabase, 'c', '2026-10-01')).toBe(built)
    enqueue({ error: { message: 'permission denied' } })
    await expect(markCompanyGraphStale(supabase, 'c')).resolves.toBeUndefined()
  })
})

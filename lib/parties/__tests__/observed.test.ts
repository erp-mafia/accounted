import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getObservedParties, rhythmFromCadence } from '../observed'

function clientWith(result: { data: unknown; error: { message: string } | null }): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue(result) } as unknown as SupabaseClient
}

const row = (over: Partial<Record<string, unknown>>) => ({
  key: 'beijer byggmaterial',
  name: 'Levfakt Beijer Byggmaterial AB (2089)',
  variants: ['Levfakt Beijer Byggmaterial AB (2089)'],
  variant_count: 1,
  occurrences: 12,
  expense_sek: 48000,
  revenue_sek: 0,
  first_seen: '2026-01-05',
  last_seen: '2026-06-09',
  cadence_days: 14,
  dominant_account_number: '4000',
  dominant_account_share: 0.9,
  dominant_account_count: 11,
  dominant_account_total: 12,
  ...over,
})

describe('getObservedParties', () => {
  it('calls the RPC with company, window and limit, and classifies each row', async () => {
    const client = clientWith({
      data: [row({}), row({ key: 'inköp av varor', name: 'Inköp av varor', dominant_account_number: '4010' })],
      error: null,
    })
    const out = await getObservedParties(client, 'co-1', { fromDate: '2025-09-01', limit: 50 })
    expect(client.rpc).toHaveBeenCalledWith('get_observed_parties', {
      p_company_id: 'co-1',
      p_from_date: '2025-09-01',
      p_limit: 50,
    })
    expect(out.map((p) => [p.key, p.label, p.rhythm])).toEqual([
      ['beijer byggmaterial', 'party', 'irregular'],
      ['inköp av varor', 'category', 'irregular'],
    ])
  })

  it('filters to the requested labels', async () => {
    const client = clientWith({
      data: [row({}), row({ key: 'löneutbetalning anställd 3', name: 'Löneutbetalning', dominant_account_number: '7210' })],
      error: null,
    })
    const out = await getObservedParties(client, 'co-1', { labels: ['party'] })
    expect(out).toHaveLength(1)
    expect(out[0]!.key).toBe('beijer byggmaterial')
  })

  it('surfaces RPC errors and tolerates a null payload', async () => {
    await expect(getObservedParties(clientWith({ data: null, error: { message: 'boom' } }), 'co-1')).rejects.toThrow(
      'get_observed_parties failed: boom',
    )
    expect(await getObservedParties(clientWith({ data: null, error: null }), 'co-1')).toEqual([])
  })
})

describe('rhythmFromCadence', () => {
  it.each([
    [null, null],
    [7, 'weekly'],
    [30, 'monthly'],
    [91, 'quarterly'],
    [365, 'yearly'],
    [2, 'irregular'],
    [180, 'irregular'],
  ] as const)('%s -> %s', (days, expected) => {
    expect(rhythmFromCadence(days)).toBe(expected)
  })
})

import { describe, expect, it } from 'vitest'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'
import { getDossier, getRegister } from '../register'
import type { ObservedPartyRow } from '../observed'

/**
 * accounted#16: get_observed_parties ranks at most 1,000 keys by money. The
 * register asked for 5,000 and read every party's stats out of that list, so
 * a party whose keys ranked below the cut showed no stats and defaulted to
 * the supplier role. The mock RPC answers the way the SQL does: the top
 * min(p_limit, 1000) keys by money, plus every key named in p_keys.
 */

const observedRow = (key: string, over: Partial<ObservedPartyRow> = {}): ObservedPartyRow => ({
  key,
  name: key,
  variants: [key],
  variant_count: 1,
  occurrences: 3,
  expense_sek: 0,
  revenue_sek: 0,
  first_seen: '2025-11-01',
  last_seen: '2026-09-01',
  cadence_days: 30,
  dominant_account_number: '4000',
  dominant_account_share: 0.8,
  dominant_account_count: 3,
  dominant_account_total: 3,
  ...over,
})

// 1,500 expense-side keys, each bigger than the one after it, then the
// customer-side key a party owns, ranked last at 1,501.
const OBSERVED = [
  ...manyRows(1500, (i) => observedRow(`leverantor ${i}`, { expense_sek: 1_000_000 - i })),
  observedRow('kund ab', { revenue_sek: 10, dominant_account_number: '3011' }),
]

const party = {
  id: 'p-kund',
  display_name: 'Kund AB',
  org_number: null,
  legal_name: null,
  vat_number: null,
  kind: 'company',
  status: 'suggested',
  alias_keys: ['kund ab'],
  suggested_reason: null,
  created_at: '2026-01-01',
  merged_into: null,
  archived_at: null,
}

function supabaseWithObservedRpc() {
  const mock = createPagedMockSupabase({ parties: [party] })
  const rpcArgs: Array<Record<string, unknown>> = []
  const pagedRpc = mock.supabase.rpc
  const rpc = (name: string, args?: Record<string, unknown>) => {
    if (name !== 'get_observed_parties') return pagedRpc(name, args)
    rpcArgs.push(args ?? {})
    // As the RPC: at most 1,000 ranked, none at 0 or below (20261123005000).
    const limit = Math.max(0, Math.min(Number(args?.p_limit ?? 200), 1000))
    const named = new Set((args?.p_keys as string[] | undefined) ?? [])
    const ranked = [...OBSERVED].sort((a, b) => b.expense_sek + b.revenue_sek - (a.expense_sek + a.revenue_sek))
    const top = new Set(ranked.slice(0, limit).map((r) => r.key))
    return Promise.resolve({ data: ranked.filter((r) => top.has(r.key) || named.has(r.key)), error: null })
  }
  return { supabase: { ...mock.supabase, rpc } as never, rpcArgs }
}

describe('parties past the observed ranking cap', () => {
  it('the register gives a party ranked below 1,000 its ledger stats and role', async () => {
    const { supabase, rpcArgs } = supabaseWithObservedRpc()

    const register = await getRegister(supabase, 'company-1', { view: 'suggested', period: 'all' })

    const row = register.rows.find((r) => r.id === 'p-kund')!
    expect(row.stats).toMatchObject({ revenueSek: 10, expenseSek: 0, dominantAccount: '3011' })
    expect(row.defaultRoles).toEqual(['customer'])
    expect(rpcArgs[0]).toMatchObject({ p_limit: 1000, p_keys: ['kund ab'] })
    // The observed queue is still the top 1,000 by money, the named key claimed.
    expect(register.counts.observed).toBe(1000)
    expect(register.observed).toEqual([])
  })

  it('the dossier reads its party by key, whatever the rank', async () => {
    const { supabase, rpcArgs } = supabaseWithObservedRpc()

    const dossier = await getDossier(supabase, 'company-1', 'p-kund')

    expect(dossier!.party.stats).toMatchObject({ revenueSek: 10, occurrences: 3 })
    expect(dossier!.party.defaultRoles).toEqual(['customer'])
    expect(rpcArgs[0]).toMatchObject({ p_limit: 0, p_keys: ['kund ab'] })
  })
})

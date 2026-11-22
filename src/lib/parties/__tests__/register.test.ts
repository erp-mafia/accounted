import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { defaultRoles, getDossier, periodStart } from '../register'
import type { LedgerStats } from '../register'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const PARTY = '11111111-1111-4111-8111-111111111111'
const SURVIVOR = '22222222-2222-4222-8222-222222222222'

function row(over: Record<string, unknown>) {
  return {
    id: PARTY,
    display_name: 'Loopia AB',
    legal_name: null,
    org_number: null,
    vat_number: null,
    kind: 'company',
    status: 'suggested',
    alias_keys: ['loopia'],
    suggested_reason: null,
    created_at: '2026-09-03T00:00:00Z',
    merged_into: null,
    archived_at: null,
    ...over,
  }
}

describe('getDossier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('hides a dismissed (archived) party like the register does', async () => {
    enqueue({ data: row({ archived_at: '2026-09-03T10:00:00Z' }) })
    expect(await getDossier(supabase as never, 'company-1', PARTY)).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('follows a merged party to its survivor', async () => {
    enqueue({ data: row({ merged_into: SURVIVOR }) })
    enqueue({ data: SURVIVOR }) // canonical_party_id
    enqueue({ data: null }) // survivor lookup: absent, so the walk ends here
    expect(await getDossier(supabase as never, 'company-1', PARTY)).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledWith('canonical_party_id', { p_party_id: PARTY })
    expect(supabase.from).toHaveBeenCalledTimes(2)
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'parties')
  })

  it('reads the ledger stats for the period it is given, the whole history by default', async () => {
    const dossierReads = () => {
      enqueue({ data: row({}) }) // the party
      for (let i = 0; i < 5; i++) enqueue({ data: [] }) // facts, identities, decisions, customer, supplier
      enqueue({ data: [] }) // get_observed_parties
    }
    dossierReads()
    await getDossier(supabase as never, 'company-1', PARTY, 0, '12m')
    expect(supabase.rpc).toHaveBeenCalledWith(
      'get_observed_parties',
      expect.objectContaining({ p_from_date: periodStart('12m'), p_keys: ['loopia'] }),
    )

    vi.clearAllMocks()
    reset()
    dossierReads()
    await getDossier(supabase as never, 'company-1', PARTY)
    expect(supabase.rpc).toHaveBeenCalledWith('get_observed_parties', expect.objectContaining({ p_from_date: null }))
  })

  it('returns null for an unknown id without touching anything else', async () => {
    enqueue({ data: null })
    expect(await getDossier(supabase as never, 'company-1', PARTY)).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})

describe('defaultRoles', () => {
  const stats = (over: Partial<LedgerStats>): LedgerStats => ({
    occurrences: 3,
    expenseSek: 0,
    revenueSek: 0,
    firstSeen: null,
    lastSeen: null,
    cadenceDays: null,
    rhythm: null,
    dominantAccount: null,
    dominantAccountName: null,
    dominantShare: null,
    variants: [],
    ...over,
  })

  it('reads the ledger side', () => {
    expect(defaultRoles(stats({ expenseSek: 1000 }))).toEqual(['supplier'])
    expect(defaultRoles(stats({ revenueSek: 1000 }))).toEqual(['customer'])
    expect(defaultRoles(stats({ expenseSek: 10, revenueSek: 10 }))).toEqual(['supplier', 'customer'])
  })

  it('falls back to the dominant account, then to supplier', () => {
    expect(defaultRoles(stats({ dominantAccount: '3011' }))).toEqual(['customer'])
    expect(defaultRoles(stats({ dominantAccount: '6212' }))).toEqual(['supplier'])
    expect(defaultRoles(null)).toEqual(['supplier'])
  })
})

/*
 * accounted#18: the register's 12-month period (and the counterpart list,
 * which reads the same bound) starts twelve months before the Swedish
 * calendar day. 23:30 UTC is already the next day in Stockholm, in summer
 * (UTC+2) and in winter (UTC+1).
 */
describe('periodStart', () => {
  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2025-07-02'],
    ['winter', '2026-01-15T23:30:00Z', '2025-01-16'],
  ])('%s: at %s the 12-month period starts %s', (_season, instant, from) => {
    expect(periodStart('12m', new Date(instant))).toBe(from)
  })

  it('has no start for all time', () => {
    expect(periodStart('all', new Date('2026-07-01T23:30:00Z'))).toBeNull()
  })
})

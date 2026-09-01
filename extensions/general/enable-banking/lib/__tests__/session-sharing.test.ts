import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/cash-accounts/service', () => ({
  normalizeIban: (iban?: string | null) => {
    if (!iban) return null
    const normalized = iban.replace(/\s+/g, '').toUpperCase()
    return normalized || null
  },
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchCrossCompanyAccountContext,
  unclaimedAccountsFor,
} from '../session-sharing'
import type { StoredAccount } from '../../types'

interface TableResult {
  data?: unknown
  error?: { message: string } | null
}

/**
 * Chainable mock resolving per table: every filter method returns the chain,
 * awaiting it yields the preset result for that table.
 */
function makeSupabase(results: Record<string, TableResult>): SupabaseClient {
  return {
    from: (table: string) => {
      const result = results[table] ?? { data: [], error: null }
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'not', 'is', 'order', 'limit']) {
        chain[m] = vi.fn().mockReturnValue(chain)
      }
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: result.data ?? null, error: result.error ?? null })
      return chain
    },
  } as unknown as SupabaseClient
}

describe('fetchCrossCompanyAccountContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('claims enabled accounts of sibling companies, remembers deselections, resolves names', async () => {
    const supabase = makeSupabase({
      company_members: {
        data: [{ company_id: 'company-1' }, { company_id: 'company-2' }],
      },
      bank_connections: {
        data: [
          {
            id: 'conn-sibling',
            company_id: 'company-2',
            accounts_data: [
              { uid: 'a1', iban: 'SE11', currency: 'SEK', enabled: true },
              { uid: 'a2', iban: 'SE22', currency: 'SEK', enabled: false },
            ],
          },
          {
            id: 'conn-own-other-row',
            company_id: 'company-1',
            // The active company's own account never becomes a claim, but its
            // deselection is remembered.
            accounts_data: [
              { uid: 'a3', iban: 'SE33', currency: 'SEK', enabled: true },
              { uid: 'a4', iban: 'SE44', currency: 'SEK', enabled: false },
            ],
          },
        ],
      },
      cash_accounts: { data: [] },
      companies: { data: [{ id: 'company-2', name: 'Sibling AB' }] },
    })

    const context = await fetchCrossCompanyAccountContext(
      supabase,
      'user-1',
      'company-1',
      'conn-active',
    )

    expect(context).not.toBeNull()
    expect(context!.claims.get('SE11')).toEqual({
      companyId: 'company-2',
      companyName: 'Sibling AB',
    })
    expect(context!.claims.has('SE33')).toBe(false)
    expect(context!.deselectedIbans).toEqual(new Set(['SE22', 'SE44']))
  })

  it('claims IBANs held by sibling companies via cash_accounts too', async () => {
    const supabase = makeSupabase({
      company_members: {
        data: [{ company_id: 'company-1' }, { company_id: 'company-2' }],
      },
      bank_connections: { data: [] },
      cash_accounts: { data: [{ company_id: 'company-2', iban: 'SE55' }] },
      companies: { data: [] },
    })

    const context = await fetchCrossCompanyAccountContext(
      supabase,
      'user-1',
      'company-1',
      'conn-active',
    )

    expect(context!.claims.get('SE55')).toEqual({ companyId: 'company-2', companyName: null })
  })

  it('lets a claim outrank a remembered deselection for the same IBAN', async () => {
    const supabase = makeSupabase({
      company_members: {
        data: [{ company_id: 'company-1' }, { company_id: 'company-2' }],
      },
      bank_connections: {
        data: [
          {
            id: 'conn-a',
            company_id: 'company-2',
            accounts_data: [{ uid: 'a1', iban: 'SE11', currency: 'SEK', enabled: true }],
          },
          {
            id: 'conn-b',
            company_id: 'company-1',
            accounts_data: [{ uid: 'a2', iban: 'SE11', currency: 'SEK', enabled: false }],
          },
        ],
      },
      cash_accounts: { data: [] },
      companies: { data: [] },
    })

    const context = await fetchCrossCompanyAccountContext(
      supabase,
      'user-1',
      'company-1',
      'conn-active',
    )

    expect(context!.claims.has('SE11')).toBe(true)
    expect(context!.deselectedIbans.has('SE11')).toBe(false)
  })

  it('returns null when a lookup fails, so the caller can fail closed', async () => {
    const supabase = makeSupabase({
      bank_connections: { data: null, error: { message: 'boom' } },
    })

    const context = await fetchCrossCompanyAccountContext(
      supabase,
      'user-1',
      'company-1',
      'conn-active',
    )

    expect(context).toBeNull()
  })
})

describe('unclaimedAccountsFor', () => {
  it('strips stale claimed_by flags from offered accounts', () => {
    const accounts: StoredAccount[] = [
      {
        uid: 'a1',
        iban: 'SE11',
        currency: 'SEK',
        enabled: false,
        ledger_account: '1938',
        claimed_by_company_id: 'company-9',
        claimed_by_company_name: 'Stale AB',
      },
    ]

    const offered = unclaimedAccountsFor(accounts, new Set())

    expect(offered).toHaveLength(1)
    expect(offered[0].enabled).toBe(true)
    expect(offered[0].ledger_account).toBeUndefined()
    expect(offered[0].claimed_by_company_id).toBeUndefined()
    expect(offered[0].claimed_by_company_name).toBeUndefined()
  })
})

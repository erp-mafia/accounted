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

type MockChain = Record<string, ReturnType<typeof vi.fn>> & {
  then: (resolve: (v: unknown) => void) => void
}

/**
 * Chainable mock resolving per table: every filter method returns the chain,
 * awaiting it yields the preset result for that table. Chains are recorded so
 * tests can assert which filters were applied (the mock does not filter).
 */
function makeSupabase(results: Record<string, TableResult>): {
  supabase: SupabaseClient
  chainsByTable: Map<string, MockChain[]>
} {
  const chainsByTable = new Map<string, MockChain[]>()
  const supabase = {
    from: (table: string) => {
      const result = results[table] ?? { data: [], error: null }
      const chain = {} as MockChain
      for (const m of ['select', 'eq', 'neq', 'in', 'not', 'is', 'order', 'limit', 'range']) {
        chain[m] = vi.fn().mockReturnValue(chain)
      }
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: result.data ?? null, error: result.error ?? null })
      const bucket = chainsByTable.get(table)
      if (bucket) bucket.push(chain)
      else chainsByTable.set(table, [chain])
      return chain
    },
  } as unknown as SupabaseClient
  return { supabase, chainsByTable }
}

describe('fetchCrossCompanyAccountContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('claims enabled accounts of sibling companies, remembers deselections, resolves names', async () => {
    const { supabase } = makeSupabase({
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
            // The active company's own account never becomes a claim; its
            // enabled accounts are its standing set and its deselections are
            // remembered.
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
    expect(context!.activeCompanyIbans).toEqual(new Set(['SE33']))
    expect(context!.deselectedIbans).toEqual(new Set(['SE22', 'SE44']))
  })

  it("lets the active company's own standing state outrank a sibling claim", async () => {
    // The bank-list renewal case: the active company's old row (about to be
    // superseded) and its cash_accounts row still book the IBAN. A sibling
    // claim on the same IBAN must not win, or a renewal arriving on a fresh
    // row would switch a working feed off.
    const { supabase } = makeSupabase({
      company_members: {
        data: [{ company_id: 'company-1' }, { company_id: 'company-2' }],
      },
      bank_connections: {
        data: [
          {
            id: 'conn-sibling',
            company_id: 'company-2',
            accounts_data: [{ uid: 'a1', iban: 'SE11', currency: 'SEK', enabled: true }],
          },
        ],
      },
      cash_accounts: {
        data: [{ company_id: 'company-1', iban: 'SE11' }],
      },
      companies: { data: [] },
    })

    const context = await fetchCrossCompanyAccountContext(
      supabase,
      'user-1',
      'company-1',
      'conn-active',
    )

    expect(context!.claims.has('SE11')).toBe(false)
    expect(context!.activeCompanyIbans.has('SE11')).toBe(true)
    expect(context!.deselectedIbans.has('SE11')).toBe(false)
  })

  it('claims IBANs held by sibling companies via cash_accounts too', async () => {
    const { supabase } = makeSupabase({
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
    const { supabase } = makeSupabase({
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

  it('treats pending_selection rows asymmetrically: enabled accounts claim, disabled flags are ignored', async () => {
    // An attach-created row is pending_selection with deliberately-offered
    // enabled accounts and NO cash rows until its picker is saved: those must
    // claim, or a second company can take the same physical account inside
    // that window. Its disabled flags are unconfirmed callback output
    // (including the guard's own fail-closed writes) and must NOT feed the
    // deselection memory.
    const { supabase, chainsByTable } = makeSupabase({
      company_members: {
        data: [{ company_id: 'company-1' }, { company_id: 'company-2' }],
      },
      bank_connections: {
        data: [
          {
            id: 'conn-attached',
            company_id: 'company-2',
            status: 'pending_selection',
            accounts_data: [
              { uid: 'a1', iban: 'SE11', currency: 'SEK', enabled: true },
              { uid: 'a2', iban: 'SE22', currency: 'SEK', enabled: false },
            ],
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
    expect(context!.deselectedIbans.has('SE22')).toBe(false)

    const connectionChain = chainsByTable.get('bank_connections')![0]
    expect(connectionChain.in).toHaveBeenCalledWith('status', [
      'active',
      'pending_selection',
      'expired',
      'error',
    ])
    // Paged reads must order on a unique column or rows can be silently
    // skipped at page boundaries (a skipped row is a missed claim).
    expect(connectionChain.order).toHaveBeenCalledWith('id')
    expect(chainsByTable.get('cash_accounts')![0].order).toHaveBeenCalledWith('id')
  })

  it('reads cash_accounts for ALL member companies (active included)', async () => {
    const { supabase, chainsByTable } = makeSupabase({
      company_members: {
        data: [{ company_id: 'company-1' }, { company_id: 'company-2' }],
      },
      bank_connections: { data: [] },
      cash_accounts: { data: [] },
      companies: { data: [] },
    })

    await fetchCrossCompanyAccountContext(supabase, 'user-1', 'company-1', 'conn-active')

    const cashChain = chainsByTable.get('cash_accounts')![0]
    expect(cashChain.in).toHaveBeenCalledWith('company_id', ['company-1', 'company-2'])
  })

  it('returns null when a lookup fails, so the caller can fail closed', async () => {
    const { supabase } = makeSupabase({
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
  it('strips stale claimed_by and deselected flags from offered accounts', () => {
    const accounts: StoredAccount[] = [
      {
        uid: 'a1',
        iban: 'SE11',
        currency: 'SEK',
        enabled: false,
        ledger_account: '1938',
        claimed_by_company_id: 'company-9',
        claimed_by_company_name: 'Stale AB',
        deselected_elsewhere: true,
      },
    ]

    const offered = unclaimedAccountsFor(accounts, new Set())

    expect(offered).toHaveLength(1)
    expect(offered[0].enabled).toBe(true)
    expect(offered[0].ledger_account).toBeUndefined()
    expect(offered[0].claimed_by_company_id).toBeUndefined()
    expect(offered[0].claimed_by_company_name).toBeUndefined()
    expect(offered[0].deselected_elsewhere).toBeUndefined()
  })
})

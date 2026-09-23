/**
 * resolveCashAccountScope: turns a settlement account BAS code into the trailing
 * scope arguments getReconciliationStatus / runReconciliation take.
 *
 * The whole point is that callers stop passing 4 positional args and leaving
 * cashAccountId undefined: that made scopeTransactionsToAccount fall back to a
 * currency-only filter, so the bank side pooled every same-currency cash account
 * while the GL side stayed on one account (issue #1290).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveCashAccountScope } from '../cash-account-scope'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CASH_1930 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CASH_1932 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const CASH_1935 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

interface LookupResult {
  data: unknown
  error?: unknown
}

/**
 * Table-routed double that answers each cash_accounts lookup from a queue, so
 * the "no 1930 row, fall back to the primary account" path can give a different
 * answer to the second query than to the first. Every eq() filter pair is
 * recorded so the tenant + account scoping can be asserted.
 */
function mockSupabase(results: LookupResult[]) {
  const tables: string[] = []
  const eqPairs: Array<[string, unknown]> = []
  const selects: string[] = []
  let call = 0

  const chain = {
    select: vi.fn((cols: string) => {
      selects.push(cols)
      return chain
    }),
    eq: vi.fn((col: string, val: unknown) => {
      eqPairs.push([col, val])
      return chain
    }),
    maybeSingle: vi.fn(async () => {
      const result = results[call] ?? { data: null }
      call += 1
      return { data: result.data, error: result.error ?? null }
    }),
  }
  const supabase = {
    from: vi.fn((table: string) => {
      tables.push(table)
      return chain
    }),
  } as unknown as SupabaseClient
  return { supabase, tables, eqPairs, selects, chain }
}

const found = (data: unknown): LookupResult[] => [{ data }]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveCashAccountScope', () => {
  it('resolves the primary 1930 row and claims unassigned rows', async () => {
    const { supabase, tables, eqPairs, selects } = mockSupabase(
      found({ id: CASH_1930, currency: 'SEK', is_primary: true, ledger_account: '1930' }),
    )

    const scope = await resolveCashAccountScope(supabase, COMPANY_ID)

    expect(scope).toEqual({
      accountNumber: '1930',
      currency: 'SEK',
      cashAccountId: CASH_1930,
      includeUnassigned: true,
      found: true,
    })
    // One lookup only: the primary fallback must not fire when 1930 resolved.
    expect(tables).toEqual(['cash_accounts'])
    // Account numbers are strings, never numbers: '1930' must reach the filter
    // verbatim, alongside the tenant scope.
    expect(eqPairs).toEqual([
      ['company_id', COMPANY_ID],
      ['ledger_account', '1930'],
    ])
    expect(selects).toEqual(['id, currency, is_primary, ledger_account'])
  })

  it('never claims unassigned rows for a non-primary account', async () => {
    // A savings account pulling in the checking account's NULL cash_account_id
    // rows is the double-count scopeTransactionsToAccount's includeUnassigned
    // flag exists to prevent.
    const { supabase } = mockSupabase(
      found({ id: CASH_1930, currency: 'SEK', is_primary: false, ledger_account: '1931' }),
    )

    const scope = await resolveCashAccountScope(supabase, COMPANY_ID, '1931')

    expect(scope.includeUnassigned).toBe(false)
    expect(scope.cashAccountId).toBe(CASH_1930)
    expect(scope.accountNumber).toBe('1931')
    expect(scope.found).toBe(true)
  })

  it('carries the account currency so EUR GL movements are not compared with SEK rows', async () => {
    const { supabase, eqPairs } = mockSupabase(
      found({ id: CASH_1932, currency: 'EUR', is_primary: false, ledger_account: '1932' }),
    )

    const scope = await resolveCashAccountScope(supabase, COMPANY_ID, '1932')

    expect(scope.currency).toBe('EUR')
    expect(scope.cashAccountId).toBe(CASH_1932)
    expect(eqPairs).toContainEqual(['ledger_account', '1932'])
  })

  it('falls back to the primary cash account when the company has no 1930 row', async () => {
    // The worst instance of #1290: 2 prod companies run two SEK cash accounts
    // (1935+1936 and 1932+1935) with NO 1930 row and zero journal_entry_lines on
    // 1930. Scoping them to '1930' compares their entire SEK bank volume against
    // an empty GL side, i.e. a bank_unreconciled blocker worth the whole bank
    // balance with 0 unmatched items and nothing the user can do about it.
    const { supabase, eqPairs } = mockSupabase([
      { data: null },
      { data: { id: CASH_1935, currency: 'SEK', is_primary: true, ledger_account: '1935' } },
    ])

    const scope = await resolveCashAccountScope(supabase, COMPANY_ID)

    expect(scope).toEqual({
      accountNumber: '1935',
      currency: 'SEK',
      cashAccountId: CASH_1935,
      includeUnassigned: true,
      found: true,
    })
    expect(eqPairs).toEqual([
      ['company_id', COMPANY_ID],
      ['ledger_account', '1930'],
      ['company_id', COMPANY_ID],
      ['is_primary', true],
    ])
  })

  it('does not fall back to the primary account when the caller named an account', async () => {
    // gnubok_get_reconciliation_status must be able to reject "1931" as unknown.
    // Silently answering with the primary account would label the result 1931
    // while reporting a different account's figures.
    const { supabase, tables } = mockSupabase([
      { data: null },
      { data: { id: CASH_1935, currency: 'SEK', is_primary: true, ledger_account: '1935' } },
    ])

    const scope = await resolveCashAccountScope(supabase, COMPANY_ID, '1931')

    expect(scope.found).toBe(false)
    expect(scope.accountNumber).toBe('1931')
    expect(scope.cashAccountId).toBeUndefined()
    expect(tables).toEqual(['cash_accounts'])
  })

  it('falls back to the legacy currency-only scope when the company has no cash accounts at all', async () => {
    // Pins the deliberate leniency: companies predating cash_accounts keep the
    // exact behaviour they have today rather than losing their bank check.
    const { supabase } = mockSupabase([{ data: null }, { data: null }])

    const scope = await resolveCashAccountScope(supabase, COMPANY_ID)

    expect(scope).toEqual({
      accountNumber: '1930',
      currency: 'SEK',
      cashAccountId: undefined,
      includeUnassigned: true,
      found: false,
    })
  })

  it('tolerates null currency / is_primary from the client without widening the scope', async () => {
    // Not a reachable DB state: migration 20260519110000 declares both columns
    // NOT NULL (is_primary DEFAULT false). This pins the TypeScript-nullable
    // shape only, and specifically that an absent is_primary means "do NOT
    // claim the unassigned rows" rather than defaulting to the wider filter.
    const { supabase } = mockSupabase(
      found({ id: CASH_1930, currency: null, is_primary: null, ledger_account: '1930' }),
    )

    const scope = await resolveCashAccountScope(supabase, COMPANY_ID)

    expect(scope.currency).toBe('SEK')
    expect(scope.includeUnassigned).toBe(false)
    expect(scope.found).toBe(true)
  })

  it('reports found:false when the client resolves without a data key at all', async () => {
    // `found` is the shared "no cash_accounts row" contract: callers reject an
    // unknown account number on it. A `row !== null` check would report
    // undefined as FOUND, so gnubok_get_reconciliation_status would stop
    // throwing "Okänt kassakonto 9999" and instead return a status labelled
    // 9999 whose bank side is every SEK transaction of the company.
    const { supabase } = mockSupabase([{ data: undefined }])

    const scope = await resolveCashAccountScope(supabase, COMPANY_ID, '9999')

    expect(scope.found).toBe(false)
    expect(scope.cashAccountId).toBeUndefined()
  })

  it('fails closed on a lookup error instead of returning the unscoped fallback', async () => {
    // A transient failure or an RLS denial would otherwise yield
    // cashAccountId: undefined, which is precisely the pooling path #1290 exists
    // to remove: the caller would show a phantom difference and call it a
    // blocker. This is the contract PR #1295 set for the MCP call site.
    const { supabase } = mockSupabase([
      { data: null, error: { code: '57014', message: 'canceling statement' } },
    ])

    await expect(resolveCashAccountScope(supabase, COMPANY_ID, '1931')).rejects.toThrow(
      'Kunde inte hämta kassakonto 1931',
    )
  })

  it('fails closed when the primary-account fallback lookup errors', async () => {
    const { supabase } = mockSupabase([
      { data: null },
      { data: null, error: { code: '57014', message: 'canceling statement' } },
    ])

    await expect(resolveCashAccountScope(supabase, COMPANY_ID)).rejects.toThrow(
      'Kunde inte hämta företagets primära kassakonto',
    )
  })
})

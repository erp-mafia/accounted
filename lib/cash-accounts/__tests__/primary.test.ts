import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { makePrimary, primaryIneligibleReason } from '../primary'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ca-1940',
  company_id: 'c1',
  ledger_account: '1940',
  currency: 'SEK',
  enabled: true,
  is_primary: false,
  bank_connection_id: null,
  ...overrides,
})

describe('primaryIneligibleReason', () => {
  it('accepts an enabled SEK giro or bank account (BAS 1920-1999)', () => {
    expect(primaryIneligibleReason({ enabled: true, currency: 'SEK', ledger_account: '1940' })).toBeNull()
    expect(primaryIneligibleReason({ enabled: true, currency: 'sek', ledger_account: '1920' })).toBeNull()
  })

  it('refuses in a fixed order: disabled, then currency, then ledger', () => {
    expect(primaryIneligibleReason({ enabled: false, currency: 'EUR', ledger_account: '1686' })).toBe('disabled')
    expect(primaryIneligibleReason({ enabled: true, currency: 'EUR', ledger_account: '1686' })).toBe('not_sek')
    expect(primaryIneligibleReason({ enabled: true, currency: 'SEK', ledger_account: '1686' })).toBe('not_bank_account')
    expect(primaryIneligibleReason({ enabled: true, currency: 'SEK', ledger_account: '1910' })).toBe('not_bank_account')
  })
})

describe('makePrimary', () => {
  beforeEach(() => {
    reset()
    supabase.rpc.mockClear()
    supabase.from.mockClear()
  })

  it('scopes the lookup to the company, so another company\'s id is not_found', async () => {
    enqueue({ data: null })
    await expect(makePrimary(client, 'c1', 'ca-other')).resolves.toEqual({ ok: false, reason: 'not_found' })
    expect(findCalls('cash_accounts', 'eq')).toEqual([
      ['company_id', 'c1'],
      ['id', 'ca-other'],
    ])
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses an ineligible account before the RPC', async () => {
    enqueue({ data: row({ enabled: false }) })
    await expect(makePrimary(client, 'c1', 'ca-1940')).resolves.toEqual({ ok: false, reason: 'disabled' })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('swaps through set_cash_account_primary and returns the re-read row', async () => {
    enqueue({ data: row() })
    enqueue({ data: { id: 'ca-1930' } }) // current primary
    enqueue({ data: null })
    enqueue({ data: row({ is_primary: true }) })
    const result = await makePrimary(client, 'c1', 'ca-1940')
    expect(result).toEqual({ ok: true, account: row({ is_primary: true }) })
    expect(supabase.rpc).toHaveBeenCalledWith('set_cash_account_primary', {
      p_company_id: 'c1',
      p_cash_account_id: 'ca-1940',
    })
    // Reads cash_accounts, calls the RPC, and nothing else: no journal table.
    expect(new Set(supabase.from.mock.calls.map((c) => c[0]))).toEqual(new Set(['cash_accounts']))
  })

  it('undoes the swap when the target turned ineligible between the check and the swap', async () => {
    enqueue({ data: row() })
    enqueue({ data: { id: 'ca-1930' } }) // current primary
    enqueue({ data: null }) // swap
    enqueue({ data: row({ is_primary: true, enabled: false }) }) // disabled meanwhile
    enqueue({ data: null }) // swap back
    await expect(makePrimary(client, 'c1', 'ca-1940')).resolves.toEqual({ ok: false, reason: 'disabled' })
    expect(supabase.rpc.mock.calls.map((c) => (c[1] as { p_cash_account_id: string }).p_cash_account_id)).toEqual([
      'ca-1940',
      'ca-1930',
    ])
  })

  it('throws when the RPC fails, leaving the old primary in place', async () => {
    enqueue({ data: row() })
    enqueue({ data: { id: 'ca-1930' } }) // current primary
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(makePrimary(client, 'c1', 'ca-1940')).rejects.toThrow(/setPrimary failed: boom/)
  })

  it('throws on a lookup error instead of reporting not_found', async () => {
    enqueue({ data: null, error: { message: 'rls' } })
    await expect(makePrimary(client, 'c1', 'ca-1940')).rejects.toThrow(/lookup failed: rls/)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { makePrimary, paymentBankRow, primaryIneligibleReason } from '../primary'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ca-1940',
  company_id: 'c1',
  ledger_account: '1940',
  currency: 'SEK',
  enabled: true,
  is_primary: true,
  bank_connection_id: null,
  ...overrides,
})

describe('paymentBankRow', () => {
  const bank = (ledger_account: string, overrides: Record<string, unknown> = {}) => ({
    ledger_account,
    currency: 'SEK',
    enabled: true,
    is_primary: false,
    kind: 'bank' as const,
    ...overrides,
  })

  it('answers the primary, even beside a 1930', () => {
    const primary = bank('1931', { is_primary: true })
    expect(paymentBankRow([bank('1930'), primary])).toBe(primary)
  })

  it('a primary that cannot carry a payment answers the only enabled SEK bank account', () => {
    const only = bank('1940')
    expect(paymentBankRow([bank('1930', { is_primary: true, enabled: false }), only])).toBe(only)
    expect(paymentBankRow([bank('1932', { is_primary: true, currency: 'EUR' }), only])).toBe(only)
  })

  it('a card or a foreign account is no candidate', () => {
    const only = bank('1940')
    expect(paymentBankRow([only, bank('2891', { kind: 'card' }), bank('1932', { currency: 'EUR' })])).toBe(only)
  })

  it('no answer among several accounts, or none', () => {
    expect(paymentBankRow([bank('1940'), bank('1941')])).toBeNull()
    expect(paymentBankRow([])).toBeNull()
  })
})

// The UI-side mirror. That it agrees with make_cash_account_primary is
// asserted against real Postgres in tests/pg/cash-accounts-routing-audit.pg.test.ts.
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

  it('is one RPC call, check and swap together, and no table access', async () => {
    enqueue({ data: row() })
    await expect(makePrimary(client, 'c1', 'ca-1940')).resolves.toEqual({ ok: true, account: row() })
    expect(supabase.rpc.mock.calls).toEqual([
      ['make_cash_account_primary', { p_company_id: 'c1', p_cash_account_id: 'ca-1940' }],
    ])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('accepts the row as a one-element array as well', async () => {
    enqueue({ data: [row()] })
    await expect(makePrimary(client, 'c1', 'ca-1940')).resolves.toEqual({ ok: true, account: row() })
  })

  it.each([
    ['CASH_ACCOUNT_NOT_FOUND', 'not_found'],
    ['CASH_ACCOUNT_PRIMARY_ADMIN_ONLY: only owner or admin may choose the primary bank account', 'forbidden'],
    ['CASH_ACCOUNT_PRIMARY_INELIGIBLE: disabled', 'disabled'],
    ['CASH_ACCOUNT_PRIMARY_INELIGIBLE: not_sek', 'not_sek'],
    ['CASH_ACCOUNT_PRIMARY_INELIGIBLE: not_bank_account', 'not_bank_account'],
  ])('turns the refusal "%s" into reason %s', async (message, reason) => {
    enqueue({ data: null, error: { message } })
    await expect(makePrimary(client, 'c1', 'ca-1940')).resolves.toEqual({ ok: false, reason })
  })

  it('throws on any other RPC error instead of inventing a reason', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(makePrimary(client, 'c1', 'ca-1940')).rejects.toThrow(/makePrimary failed: connection reset/)
  })
})

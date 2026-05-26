import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { detectOwnAccountTransfer } from '../own-account-detector'
import type { Transaction } from '@/types'

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    user_id: 'user-1',
    company_id: 'company-1',
    bank_connection_id: 'conn-sek',
    external_id: 'eb_sek_1',
    date: '2026-06-12',
    description: 'Överföring till EUR-konto',
    amount: -1000,
    currency: 'SEK',
    amount_sek: -1000,
    exchange_rate: null,
    exchange_rate_date: null,
    category: 'uncategorized',
    is_business: null,
    invoice_id: null,
    supplier_invoice_id: null,
    potential_invoice_id: null,
    potential_supplier_invoice_id: null,
    journal_entry_id: null,
    mcc_code: null,
    merchant_name: null,
    receipt_id: null,
    document_id: null,
    reconciliation_method: null,
    import_source: 'enable_banking',
    reference: null,
    counterparty_iban: 'SE9550000000054910000003',
    counterparty_account: null,
    notes: null,
    created_at: '2026-06-12T00:00:00Z',
    updated_at: '2026-06-12T00:00:00Z',
    ...overrides,
  }
}

describe('detectOwnAccountTransfer', () => {
  it('returns null when transaction has no counterparty_iban', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ counterparty_iban: null }),
    )
    expect(result).toBeNull()
  })

  it('returns null when IBAN does not match any cash account for the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // findByIban miss
    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ counterparty_iban: 'NORANDOMVALUE' }),
    )
    expect(result).toBeNull()
  })

  it('matches IBAN and returns counter ledger account when present', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // findByIban hit
    enqueue({
      data: {
        id: 'ca-eur',
        company_id: 'company-1',
        bank_connection_id: 'conn-eur',
        currency: 'EUR',
        ledger_account: '1932',
        iban: 'SE9550000000054910000003',
        is_primary: false,
        enabled: true,
        source: 'enable_banking',
      },
    })
    // pair candidate lookup — find the matching EUR-side leg
    enqueue({
      data: [{ id: 'tx-eur-leg', amount: 90.50, date: '2026-06-12' }],
    })

    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ amount: -1000, counterparty_iban: 'SE9550000000054910000003' }),
    )

    expect(result).not.toBeNull()
    expect(result!.counterLedgerAccount).toBe('1932')
    expect(result!.counterCurrency).toBe('EUR')
    expect(result!.pairTransactionId).toBe('tx-eur-leg')
  })

  it('returns pairTransactionId: null when the other leg has not been ingested yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'ca-eur',
        company_id: 'company-1',
        bank_connection_id: 'conn-eur',
        currency: 'EUR',
        ledger_account: '1932',
        iban: 'SE9550000000054910000003',
        is_primary: false,
        enabled: true,
        source: 'enable_banking',
      },
    })
    enqueue({ data: [] }) // pair not present yet

    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ counterparty_iban: 'SE9550000000054910000003' }),
    )
    expect(result).not.toBeNull()
    expect(result!.pairTransactionId).toBeNull()
    expect(result!.counterLedgerAccount).toBe('1932')
  })

  it('refuses to pair when the counter ledger code is outside the cash class (19xx)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'ca-bad',
        company_id: 'company-1',
        bank_connection_id: null,
        currency: 'SEK',
        ledger_account: '6991', // not a cash account
        iban: 'SE9550000000054910000003',
        is_primary: false,
        enabled: true,
        source: 'manual',
      },
    })
    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ counterparty_iban: 'SE9550000000054910000003' }),
    )
    expect(result).toBeNull()
  })

  it('does not fall back to amount-only heuristics when IBAN missing — null instead', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ counterparty_iban: '' }),
    )
    expect(result).toBeNull()
  })
})

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
    original_description: 'Överföring till EUR-konto',
    title_edited_at: null,
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
    cash_account_id: null,
    mcc_code: null,
    merchant_name: null,
    receipt_id: null,
    document_id: null,
    reconciliation_method: null,
    is_ignored: false,
    import_source: 'enable_banking',
    reference: null,
    counterparty_iban: 'SE9550000000054910000003',
    counterparty_account: null,
    notes: null,
    created_at: '2026-06-12T00:00:00Z',
    updated_at: '2026-06-12T00:00:00Z',
    ...overrides,
  } as Transaction
}

function makeCashRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ca-eur',
    company_id: 'company-1',
    bank_connection_id: 'conn-eur',
    currency: 'EUR',
    ledger_account: '1932',
    iban: 'SE9550000000054910000003',
    is_primary: false,
    enabled: true,
    source: 'enable_banking',
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
    enqueue({ data: [] }) // IBAN candidate lookup miss
    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ counterparty_iban: 'NORANDOMVALUE' }),
    )
    expect(result).toBeNull()
  })

  it('matches IBAN and returns counter ledger account when present', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [makeCashRow()] }) // IBAN candidate lookup hit
    enqueue({ data: [{ id: 'conn-eur', status: 'active' }] }) // revoked-connection check
    // pair candidate lookup: find the matching EUR-side leg
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
    enqueue({ data: [makeCashRow()] })
    enqueue({ data: [{ id: 'conn-eur', status: 'active' }] })
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
      data: [
        makeCashRow({
          id: 'ca-bad',
          bank_connection_id: null,
          currency: 'SEK',
          ledger_account: '6991', // not a cash account
          source: 'manual',
        }),
      ],
    })
    // No connection ids on the candidate → the revoked check short-circuits
    // without a query.
    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ counterparty_iban: 'SE9550000000054910000003' }),
    )
    expect(result).toBeNull()
  })

  it('does not fall back to amount-only heuristics when IBAN missing: null instead', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await detectOwnAccountTransfer(
      supabase as never,
      'company-1',
      makeTx({ counterparty_iban: '' }),
    )
    expect(result).toBeNull()
  })

  // Issue #1643: a broken reconnect leaves orphaned cash_accounts rows sharing
  // the live account's IBAN. Pairing with one proposed the orphaned ledger as
  // the booking dialog's counter-account, silently booking revenue onto a junk
  // balance-sheet account.
  describe('orphaned-row hardening (#1643)', () => {
    it('never pairs with the transaction\'s OWN cash account (self-transfer)', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      // The bank stamps the account's own IBAN as counterparty (interest); the
      // only row carrying it is the transaction's own.
      enqueue({ data: [makeCashRow({ id: 'ca-own', ledger_account: '1931', currency: 'SEK' })] })
      enqueue({ data: [{ id: 'conn-eur', status: 'active' }] })

      const result = await detectOwnAccountTransfer(
        supabase as never,
        'company-1',
        makeTx({ amount: 217.04, cash_account_id: 'ca-own' }),
      )
      expect(result).toBeNull()
    })

    it('never pairs an own-IBAN counterparty with the live twin when the transaction sits on the orphan row', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      // The issue's population: +217,04 interest stranded on the demoted 1931
      // row, the live claim on the same IBAN sits on 1940, and the bank stamps
      // the account's own IBAN as counterparty. 1940 is the SAME account.
      enqueue({
        data: [
          makeCashRow({ id: 'ca-orphan', bank_connection_id: null, ledger_account: '1931', currency: 'SEK' }),
          makeCashRow({ id: 'ca-live', bank_connection_id: 'conn-new', ledger_account: '1940', currency: 'SEK' }),
        ],
      })
      enqueue({ data: [{ id: 'conn-new', status: 'active' }] })

      const result = await detectOwnAccountTransfer(
        supabase as never,
        'company-1',
        makeTx({ amount: 217.04, cash_account_id: 'ca-orphan', currency: 'SEK' }),
      )
      expect(result).toBeNull()
    })

    it('never pairs a transaction on the live row with a demoted-manual twin sharing its IBAN', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({
        data: [
          makeCashRow({ id: 'ca-live', bank_connection_id: 'conn-new', ledger_account: '1940', currency: 'SEK' }),
          makeCashRow({ id: 'ca-orphan', bank_connection_id: null, ledger_account: '1931', currency: 'SEK' }),
        ],
      })
      enqueue({ data: [{ id: 'conn-new', status: 'active' }] })

      const result = await detectOwnAccountTransfer(
        supabase as never,
        'company-1',
        makeTx({ amount: 217.04, cash_account_id: 'ca-live', currency: 'SEK' }),
      )
      expect(result).toBeNull()
    })

    it('never pairs an own-IBAN counterparty when two ACTIVE same-currency rows share the IBAN', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({
        data: [
          makeCashRow({ id: 'ca-1930', bank_connection_id: 'conn-new', ledger_account: '1930', currency: 'SEK' }),
          makeCashRow({ id: 'ca-1931', bank_connection_id: 'conn-new', ledger_account: '1931', currency: 'SEK' }),
        ],
      })
      enqueue({ data: [{ id: 'conn-new', status: 'active' }] })

      const result = await detectOwnAccountTransfer(
        supabase as never,
        'company-1',
        makeTx({ amount: 217.04, cash_account_id: 'ca-1930', currency: 'SEK' }),
      )
      expect(result).toBeNull()
    })

    it('never pairs with a row held by a REVOKED connection', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({
        data: [makeCashRow({ id: 'ca-orphan', bank_connection_id: 'conn-old', ledger_account: '1931', currency: 'SEK' })],
      })
      enqueue({ data: [{ id: 'conn-old', status: 'revoked' }] })

      const result = await detectOwnAccountTransfer(
        supabase as never,
        'company-1',
        makeTx({ amount: 217.04 }),
      )
      expect(result).toBeNull()
    })

    it('never pairs with a disabled row', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [makeCashRow({ id: 'ca-disabled', enabled: false })] })
      enqueue({ data: [{ id: 'conn-eur', status: 'active' }] })

      const result = await detectOwnAccountTransfer(
        supabase as never,
        'company-1',
        makeTx(),
      )
      expect(result).toBeNull()
    })

    it('picks the actively connected row when an orphan shares the IBAN', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      // Two rows on one IBAN: the orphan (revoked connection, 1931) and the
      // live account (active connection, 1940). The old maybeSingle lookup
      // errored on this shape and disabled detection entirely.
      enqueue({
        data: [
          makeCashRow({ id: 'ca-orphan', bank_connection_id: 'conn-old', ledger_account: '1931', currency: 'SEK' }),
          makeCashRow({ id: 'ca-live', bank_connection_id: 'conn-new', ledger_account: '1940', currency: 'SEK' }),
        ],
      })
      enqueue({
        data: [
          { id: 'conn-old', status: 'revoked' },
          { id: 'conn-new', status: 'active' },
        ],
      })
      enqueue({ data: [] }) // pair leg not ingested

      const result = await detectOwnAccountTransfer(
        supabase as never,
        'company-1',
        makeTx({ amount: -500 }),
      )
      expect(result).not.toBeNull()
      expect(result!.counterLedgerAccount).toBe('1940')
    })
  })
})

import type { RawTransaction } from '@/types'

/**
 * A bank row with every RawTransaction field set to a distinct, storable
 * value: the guard against a source field being dropped on its way to the
 * database. `Required<RawTransaction>` makes a new field fail the type check
 * until it is added here; two tests then follow it the whole way:
 *
 * - src/lib/transactions/__tests__/ingest.test.ts: ingest puts every field in
 *   the insert payload, on the bank RPC path and the plain insert path.
 * - tests/pg/bank-ingest-route.pg.test.ts: insert_bank_transaction stores
 *   every field of that payload and returns it.
 *
 * Every key is the transactions column of the same name, except `description`,
 * which ingest also keeps as original_description. The row is a SEK account's
 * card purchase in EUR: on a SEK account exchange_rate is the bank's rate
 * (see RawTransaction.exchange_rate), so the payload carries it unchanged.
 */
export function fullRawTransaction(overrides: Partial<RawTransaction> = {}): Required<RawTransaction> {
  const full: Required<RawTransaction> = {
    date: '2026-01-02',
    description: 'Faktura 1001 Kund AB',
    amount: -25,
    currency: 'SEK',
    external_id: `full-raw-${Math.random().toString(36).slice(2, 10)}`,
    mcc_code: 5411,
    merchant_name: 'Kund AB',
    reference: '1001000000017',
    bank_connection_id: 'connection',
    import_source: 'enable_banking',
    counterparty_iban: 'SE4550000000058398257466',
    counterparty_account: '5050-1055',
    transaction_method: 'card',
    bank_transaction_code: 'PMNT-CCRD-POSD',
    proprietary_bank_transaction_code: 'KORT',
    value_date: '2026-01-03',
    end_to_end_id: 'E2E-FULL-1',
    provider_transaction_id: 'ENTRY-FULL-1',
    raw_document_id: '00000000-0000-4000-8000-000000000001',
    counterparty_org_number: '5560160680',
    instructed_amount: -2.22,
    instructed_currency: 'EUR',
    exchange_rate: 11.26,
    balance_after: 12345.67,
    is_enriched: true,
    // Not a transactions column: the Bankgirot split goes to
    // bank_transaction_parts (storeTransactionParts), and only an Open
    // Payments row carries one. Both full-row tests leave it out of the
    // column comparison.
    parts: null,
  }
  return { ...full, ...overrides }
}

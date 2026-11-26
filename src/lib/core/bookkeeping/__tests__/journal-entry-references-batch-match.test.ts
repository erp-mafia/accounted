/**
 * getJournalEntryUnderlagReferences for a batch-match verifikat.
 *
 * A batch match books one bank row against up to MAX_BANK_ROW_SPLIT (499)
 * invoices on one verifikat, one payment row per invoice. The resolver then
 * reads those invoices by id with `.in()`, and supabase-js puts the ids in the
 * GET query string: 499 uuids are about 19.5 KB, past both gateways' limits,
 * so the read was refused and the verifikat showed no underlag. The fake
 * gateway (tests/gateway-supabase.ts) refuses a URL past a self-hosted Kong's
 * 8 KB, the stricter of the two limits.
 */
import { describe, expect, it } from 'vitest'
import { getJournalEntryUnderlagReferences } from '../journal-entry-references'
import { MAX_BANK_ROW_SPLIT } from '@/lib/reconciliation/limits'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const ENTRY = 'eeeeeeee-0000-4000-8000-000000000001'

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)

/** The books of one verifikat that pays `customers` customer and `suppliers` supplier invoices. */
function batchVerifikat(customers: number, suppliers: number) {
  return {
    invoices: range(customers).map((n) => ({
      id: uuid(n, '11111111'),
      company_id: COMPANY,
      invoice_number: String(20000 + n),
      status: 'paid',
      journal_entry_id: null,
    })),
    invoice_payments: range(customers).map((n) => ({
      id: uuid(n, 'aaaaaaaa'),
      company_id: COMPANY,
      invoice_id: uuid(n, '11111111'),
      journal_entry_id: ENTRY,
    })),
    supplier_invoices: range(suppliers).map((n) => ({
      id: uuid(n, '22222222'),
      company_id: COMPANY,
      supplier_invoice_number: `LF-${n}`,
      registration_journal_entry_id: null,
      payment_journal_entry_id: null,
      document_id: null,
      document: null,
    })),
    supplier_invoice_payments: range(suppliers).map((n) => ({
      id: uuid(n, 'bbbbbbbb'),
      company_id: COMPANY,
      supplier_invoice_id: uuid(n, '22222222'),
      journal_entry_id: ENTRY,
    })),
    journal_entries: [{ id: ENTRY, company_id: COMPANY, source_type: 'bank_transaction', source_id: null }],
  }
}

describe('getJournalEntryUnderlagReferences: a batch-match verifikat', () => {
  it('names every invoice of a full batch of customer payments, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(batchVerifikat(MAX_BANK_ROW_SPLIT, 0))

    const references = await getJournalEntryUnderlagReferences(supabase, COMPANY, ENTRY)

    expect(references.filter((r) => r.type === 'invoice')).toHaveLength(MAX_BANK_ROW_SPLIT)
    expect(references).toContainEqual({ type: 'invoice', id: uuid(MAX_BANK_ROW_SPLIT, '11111111'), number: String(20000 + MAX_BANK_ROW_SPLIT) })
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    // The direct-link read names no ids; the by-id reads come 100 at a time.
    expect(requestsTo('invoices').map((r) => inListOf(r, 'id').length)).toEqual([0, 100, 100, 100, 100, 99])
    expect(unmodelled).toEqual([])
  })

  it('names every supplier invoice of a full batch of supplier payments, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(batchVerifikat(0, MAX_BANK_ROW_SPLIT))

    const references = await getJournalEntryUnderlagReferences(supabase, COMPANY, ENTRY)

    expect(references.filter((r) => r.type === 'supplier_invoice')).toHaveLength(MAX_BANK_ROW_SPLIT)
    expect(references).toContainEqual({ type: 'supplier_invoice', id: uuid(1, '22222222'), number: 'LF-1' })
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('supplier_invoices').map((r) => inListOf(r, 'id').length)).toEqual([0, 0, 100, 100, 100, 100, 99])
    expect(unmodelled).toEqual([])
  })

  it('reads a verifikat of one payment in one by-id request, as before', async () => {
    const { supabase, requestsTo } = createGatewaySupabase(batchVerifikat(1, 1))

    const references = await getJournalEntryUnderlagReferences(supabase, COMPANY, ENTRY)

    expect(references.map((r) => r.type)).toEqual(['invoice', 'supplier_invoice'])
    expect(requestsTo('invoices').map((r) => inListOf(r, 'id').length)).toEqual([0, 1])
    expect(requestsTo('supplier_invoices').map((r) => inListOf(r, 'id').length)).toEqual([0, 0, 1])
  })
})

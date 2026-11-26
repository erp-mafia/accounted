/**
 * readTransactionParts for a split of many parts.
 *
 * A BgMax deposit or an Autogiro settle day is one bank row with one part per
 * payment, and ingest suggests an open invoice for each part. The read names
 * those invoices by id with `.in()`, and supabase-js puts the ids in the GET
 * query string: 250 uuids are about 10 KB, past a self-hosted Kong's 8 KB, so
 * the read was refused and the parts doors answered an error. The fake
 * gateway (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { readTransactionParts } from '../parts-read'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const TX = '7d1e2f30-0000-4000-8000-000000000001'
const PARTS = 250

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)

function part(seq: number, suggested: { invoice?: string; supplierInvoice?: string }) {
  return {
    id: uuid(seq, 'cccccccc'),
    company_id: COMPANY,
    transaction_id: TX,
    seq,
    amount: suggested.supplierInvoice ? -(100 + seq) : 100 + seq,
    currency: 'SEK',
    counterparty_name: `Betalare ${seq}`,
    counterparty_org_number: null,
    counterparty_account: null,
    reference: null,
    invoice_numbers: [],
    message: null,
    provider_part_id: null,
    suggested_invoice_id: suggested.invoice ?? null,
    suggested_supplier_invoice_id: suggested.supplierInvoice ?? null,
    suggestion_reason: 'ocr_exact',
  }
}

describe('readTransactionParts: a split of many parts', () => {
  it('names the suggested invoice of every part of a large deposit, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase({
      bank_transaction_parts: range(PARTS).map((n) => part(n, { invoice: uuid(n, '11111111') })),
      invoices: range(PARTS).map((n) => ({
        id: uuid(n, '11111111'),
        company_id: COMPANY,
        invoice_number: String(30000 + n),
        remaining_amount: 100 + n,
        currency: 'SEK',
        // The last one was paid since ingest: it is no longer offered.
        status: n === PARTS ? 'paid' : 'sent',
        customer: { name: `Kund ${n}` },
      })),
    })

    const parts = await readTransactionParts(supabase, COMPANY, TX)

    expect(parts).toHaveLength(PARTS)
    expect(parts.filter((p) => p.suggested_invoice !== null)).toHaveLength(PARTS - 1)
    expect(parts[PARTS - 2]!.suggested_invoice).toEqual({
      kind: 'customer_invoice',
      invoice_id: uuid(PARTS - 1, '11111111'),
      invoice_number: String(30000 + PARTS - 1),
      counterparty_name: `Kund ${PARTS - 1}`,
      remaining_amount: 100 + PARTS - 1,
      currency: 'SEK',
    })
    expect(parts[PARTS - 1]!.suggested_invoice).toBeNull()
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('invoices').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 50])
    expect(unmodelled).toEqual([])
  })

  it('names the suggested supplier invoice of every part of a large payout, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase({
      bank_transaction_parts: range(PARTS).map((n) => part(n, { supplierInvoice: uuid(n, '22222222') })),
      supplier_invoices: range(PARTS).map((n) => ({
        id: uuid(n, '22222222'),
        company_id: COMPANY,
        supplier_invoice_number: null,
        arrival_number: n,
        remaining_amount: 100 + n,
        currency: 'SEK',
        status: 'approved',
        supplier: { name: `Leverantör ${n}` },
      })),
    })

    const parts = await readTransactionParts(supabase, COMPANY, TX)

    expect(parts.map((p) => p.suggested_invoice?.invoice_number)).toEqual(range(PARTS).map((n) => `LF-${n}`))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('supplier_invoices').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 50])
    expect(unmodelled).toEqual([])
  })
})

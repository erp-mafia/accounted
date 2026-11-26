/**
 * loadCounterpartyBalance for a counterparty with a full side of open items.
 *
 * The balance reads up to OPEN_ITEM_LIMIT (500) open invoices per side, then
 * asks by id with `.in()` which invoices have an open collection case and
 * which supplier invoices a bank payment may still pay. supabase-js puts the
 * ids in the GET query string, about 39 characters a uuid, so a counterparty
 * with a few hundred open invoices passed a self-hosted Kong's 8 KB, the reads
 * were refused and the balance failed. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { loadCounterpartyBalance } from '../open-items'
import { paymentInFlightSupplierInvoiceIds } from '../state'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const PARTY = '0a1b2c3d-0000-4000-8000-000000000001'
const CUSTOMER = '0a1b2c3d-0000-4000-8000-000000000002'
const SUPPLIER = '0a1b2c3d-0000-4000-8000-000000000003'
/** OPEN_ITEM_LIMIT in ../open-items.ts: the most rows read per side. */
const SIDE = 500

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
const invoiceId = (n: number) => uuid(n, '11111111')
const supplierInvoiceId = (n: number) => uuid(n, '22222222')

function books() {
  return {
    parties: [
      { id: PARTY, company_id: COMPANY, merged_into: null, display_name: 'Grannbolaget', legal_name: 'Grannbolaget AB', org_number: '5560000001' },
    ],
    customers: [{ id: CUSTOMER, company_id: COMPANY, name: 'Grannbolaget AB', party_id: PARTY, created_at: '2026-01-02T08:00:00Z' }],
    suppliers: [{ id: SUPPLIER, company_id: COMPANY, name: 'Grannbolaget AB', party_id: PARTY, created_at: '2026-01-02T08:00:00Z' }],
    invoices: range(SIDE).map((n) => ({
      id: invoiceId(n),
      company_id: COMPANY,
      invoice_number: String(50000 + n),
      external_invoice_number: null,
      status: 'sent',
      document_type: 'invoice',
      credited_invoice_id: null,
      currency: 'SEK',
      total: 1000,
      remaining_amount: 1000,
      paid_amount: 0,
      deduction_total: 0,
      invoice_date: '2026-10-01',
      due_date: '2026-10-31',
      journal_entry_id: uuid(n, 'eeeeeeee'),
      customer_id: CUSTOMER,
    })),
    supplier_invoices: range(SIDE).map((n) => ({
      id: supplierInvoiceId(n),
      company_id: COMPANY,
      supplier_invoice_number: `LF-${n}`,
      arrival_number: n,
      status: 'approved',
      is_credit_note: false,
      currency: 'SEK',
      total: 400,
      remaining_amount: 400,
      paid_amount: 0,
      invoice_date: '2026-10-01',
      due_date: '2026-10-31',
      registration_journal_entry_id: uuid(n, 'ffffffff'),
      bank_entered_at: null,
      supplier_id: SUPPLIER,
    })),
    // Open cases in the first, third and last slice of ids; a closed one counts for nothing.
    collection_cases: [
      ...[50, 250, 500].map((n) => ({ id: uuid(n, 'cccccccc'), company_id: COMPANY, invoice_id: invoiceId(n), is_open: true })),
      { id: uuid(400, 'cccccccc'), company_id: COMPANY, invoice_id: invoiceId(400), is_open: false },
    ],
    payment_orders: [
      { id: uuid(150, 'aaaaaaaa'), company_id: COMPANY, supplier_invoice_id: supplierInvoiceId(150), status: 'approved', supplier_invoice_payment_id: null },
      // Executed and matched to its payment: no longer in flight.
      { id: uuid(350, 'aaaaaaaa'), company_id: COMPANY, supplier_invoice_id: supplierInvoiceId(350), status: 'executed', supplier_invoice_payment_id: uuid(350, 'bbbbbbbb') },
      // Executed, its debit not matched yet: still in flight.
      { id: uuid(450, 'aaaaaaaa'), company_id: COMPANY, supplier_invoice_id: supplierInvoiceId(450), status: 'executed', supplier_invoice_payment_id: null },
    ],
    supplier_payment_batch_items: [
      { id: uuid(499, 'dddddddd'), company_id: COMPANY, supplier_invoice_id: supplierInvoiceId(499), batch: { status: 'created' } },
      { id: uuid(300, 'dddddddd'), company_id: COMPANY, supplier_invoice_id: supplierInvoiceId(300), batch: { status: 'cancelled' } },
    ],
  }
}

describe('loadCounterpartyBalance: a full side of open items', () => {
  it('marks every open case and every payment in flight, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(books())

    const balance = await loadCounterpartyBalance(supabase, COMPANY, { partyId: PARTY })

    expect(balance!.receivables).toHaveLength(SIDE)
    expect(balance!.payables).toHaveLength(SIDE)
    const ineligibleReceivables = balance!.receivables.filter((r) => !r.setoff_eligible)
    expect(ineligibleReceivables.map((r) => [r.invoice_id, r.ineligible_reason])).toEqual(
      [50, 250, 500].map((n) => [invoiceId(n), 'collection_open']),
    )
    const ineligiblePayables = balance!.payables.filter((p) => !p.setoff_eligible)
    expect(ineligiblePayables.map((p) => [p.supplier_invoice_id, p.ineligible_reason])).toEqual(
      [150, 450, 499].map((n) => [supplierInvoiceId(n), 'payment_in_flight']),
    )
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    const slices = [100, 100, 100, 100, 100]
    expect(requestsTo('collection_cases').map((r) => inListOf(r, 'invoice_id').length)).toEqual(slices)
    expect(requestsTo('payment_orders').map((r) => inListOf(r, 'supplier_invoice_id').length)).toEqual(slices)
    expect(requestsTo('supplier_payment_batch_items').map((r) => inListOf(r, 'supplier_invoice_id').length)).toEqual(slices)
    expect(unmodelled).toEqual([])
  })
})

describe('paymentInFlightSupplierInvoiceIds: an invoice with many settled payment orders', () => {
  it('still sees an open order the settled ones would push past the 1000-row cap', async () => {
    const settledMany = supplierInvoiceId(1)
    const payingNow = supplierInvoiceId(2)
    // A thousand settled orders of one invoice first, then the open order of another.
    const settled = Array.from({ length: 1000 }, (_, i) => ({
      id: uuid(i + 1, '33333333'), company_id: COMPANY, supplier_invoice_id: settledMany, status: 'executed',
      supplier_invoice_payment_id: uuid(i + 1, '44444444'),
    }))
    const open = { id: uuid(1, '55555555'), company_id: COMPANY, supplier_invoice_id: payingNow, status: 'approved', supplier_invoice_payment_id: null }
    const { supabase, unmodelled } = createGatewaySupabase({ payment_orders: [...settled, open] })

    const inFlight = await paymentInFlightSupplierInvoiceIds(supabase, COMPANY, [
      { id: settledMany, bank_entered_at: null },
      { id: payingNow, bank_entered_at: null },
    ])

    expect([...inFlight]).toEqual([payingNow])
    expect(unmodelled).toEqual([])
  })
})

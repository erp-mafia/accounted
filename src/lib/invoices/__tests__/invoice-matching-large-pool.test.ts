/**
 * loadInvoiceMatchPool for a company with many open invoices.
 *
 * The status-leak guard reads invoice_payments by invoice id with `.in()`,
 * and supabase-js puts those ids in the GET query string. Sent as one list of
 * every open invoice, the request ran past the gateway's URL limit, the
 * gateway refused it before PostgREST saw it, and no bank row of that company
 * got an invoice match. The fake gateway (tests/gateway-supabase.ts) refuses a
 * URL past a self-hosted Kong's 8 KB, the stricter of the two limits (hosted
 * Supabase's is about 16 KB). Behind it, every response is capped at
 * PostgREST's 1000 rows.
 */
import { describe, expect, it } from 'vitest'
import { loadInvoiceMatchPool } from '../invoice-matching'
import { makeCustomer, makeInvoice, POSTGREST_MAX_ROWS as MAX_ROWS } from '@/tests/helpers'
import { createGatewaySupabase, GATEWAY_URL_LIMIT as URL_LIMIT, type GatewayRequest as Request } from '@/tests/gateway-supabase'

type Row = Record<string, unknown>

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'

const uuid = (n: number, prefix = '00000000') => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`

const gatewaySupabase = (tables: Record<string, Row[]>, refuse?: (request: Request) => boolean) =>
  createGatewaySupabase(tables, { refuse })

const customer = makeCustomer({ id: uuid(1, 'cccccccc'), company_id: COMPANY, name: 'Nordviken Bygg AB' })

function openInvoices(count: number, status: 'sent' | 'overdue' | 'partially_paid' = 'sent'): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    ...makeInvoice({
      id: uuid(i + 1),
      company_id: COMPANY,
      invoice_number: String(10001 + i),
      status,
      currency: 'SEK',
      total: 1250,
      remaining_amount: 1250,
    }),
    customer,
    credit_notes: [],
  }))
}

/** A booked payment of the invoice: the status leak the guard exists for. */
const bookedPayment = (n: number, invoiceId: string): Row => ({
  id: uuid(n, 'aaaaaaaa'),
  company_id: COMPANY,
  invoice_id: invoiceId,
  journal_entry_id: uuid(n, 'eeeeeeee'),
})

const paymentReads = (requests: Request[]) => requests.filter((r) => r.table === 'invoice_payments')

describe('loadInvoiceMatchPool: a company with many open invoices', () => {
  it('reads the payment vouchers of 900 open invoices in requests the gateway takes', async () => {
    const invoices = openInvoices(900)
    // The leaked invoice sits in the ninth slice: only a read of every slice finds its voucher.
    const leaked = invoices[849].id as string
    const { supabase, requests } = gatewaySupabase({
      invoices,
      invoice_payments: [bookedPayment(1, leaked)],
    })

    const pool = await loadInvoiceMatchPool(supabase, COMPANY)

    expect(pool.invoices).toHaveLength(899)
    expect(pool.invoices.some((inv) => inv.id === leaked)).toBe(false)
    expect(requests.every((r) => r.url.length <= URL_LIMIT)).toBe(true)
    expect(paymentReads(requests).map((r) => r.inValues)).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100])
  })

  it('reads no payment vouchers when no invoice is sent or overdue', async () => {
    const { supabase, requests } = gatewaySupabase({ invoices: openInvoices(3, 'partially_paid'), invoice_payments: [] })

    const pool = await loadInvoiceMatchPool(supabase, COMPANY)

    expect(pool.invoices).toHaveLength(3)
    expect(paymentReads(requests)).toEqual([])
  })

  it('reads exactly one slice in one request', async () => {
    const { supabase, requests } = gatewaySupabase({ invoices: openInvoices(100), invoice_payments: [] })

    const pool = await loadInvoiceMatchPool(supabase, COMPANY)

    expect(pool.invoices).toHaveLength(100)
    expect(paymentReads(requests).map((r) => r.inValues)).toEqual([100])
  })

  it('reads one invoice over a slice in a second request, and still sees its voucher', async () => {
    const invoices = openInvoices(101)
    const last = invoices[100].id as string
    const { supabase, requests } = gatewaySupabase({ invoices, invoice_payments: [bookedPayment(1, last)] })

    const pool = await loadInvoiceMatchPool(supabase, COMPANY)

    expect(paymentReads(requests).map((r) => r.inValues)).toEqual([100, 1])
    expect(pool.invoices).toHaveLength(100)
    expect(pool.invoices.some((inv) => inv.id === last)).toBe(false)
  })

  it('pages a slice whose vouchers pass 1000 rows, so a voucher on the second page still counts', async () => {
    const invoices = openInvoices(100)
    // 1000 booked rows of the first invoice fill the slice's first page; the
    // leaked invoice's own voucher sorts after them and comes on page two.
    const filler = Array.from({ length: MAX_ROWS }, (_, i) => bookedPayment(i + 1, invoices[0].id as string))
    const leaked = invoices[99].id as string
    const { supabase, requests } = gatewaySupabase({
      invoices,
      invoice_payments: [...filler, bookedPayment(MAX_ROWS + 1, leaked)],
    })

    const pool = await loadInvoiceMatchPool(supabase, COMPANY)

    expect(paymentReads(requests)).toHaveLength(2)
    expect(pool.invoices.map((inv) => inv.id)).not.toContain(leaked)
    expect(pool.invoices.map((inv) => inv.id)).not.toContain(invoices[0].id)
    expect(pool.invoices).toHaveLength(98)
  })

  it('throws when one slice cannot be read, so no paid invoice is offered again', async () => {
    let paymentRead = 0
    const { supabase } = gatewaySupabase(
      { invoices: openInvoices(250), invoice_payments: [] },
      (request) => request.table === 'invoice_payments' && ++paymentRead === 2,
    )

    await expect(loadInvoiceMatchPool(supabase, COMPANY)).rejects.toMatchObject({ code: '57014' })
  })
})

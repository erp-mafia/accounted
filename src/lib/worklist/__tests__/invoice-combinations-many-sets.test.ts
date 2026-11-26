/**
 * listInvoiceCombinationSuggestions when the proposed sets name many invoices.
 *
 * The status-leak guard reads the payment vouchers of every invoice of a
 * proposed set by id with `.in()`, and supabase-js puts the ids in the GET
 * query string. The sets of 200 bank rows can name every invoice of a pool of
 * up to 499: 250 uuids are about 9.8 KB, past a self-hosted Kong's 8 KB, so
 * the guard read was refused and Att göra offered no set at all. The fake
 * gateway (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it, vi } from 'vitest'
import { listInvoiceCombinationSuggestions } from '../categories'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf, type GatewayRequest } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'

/** Customers that each paid their two open invoices in one transfer. */
const CUSTOMERS = 125
/** The customer one of whose invoices already has a payment voucher, its status never moved on. */
const LEAKED = 120

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
const customer = (k: number) => uuid(k, 'c0c0c0c0')
const firstInvoice = (k: number) => uuid(k, '11111111')
const secondInvoice = (k: number) => uuid(k, '22222222')
const receipt = (k: number) => uuid(k, '33333333')

function openInvoice(id: string, k: number, remaining: number) {
  return {
    id,
    company_id: COMPANY,
    customer_id: customer(k),
    invoice_number: id === firstInvoice(k) ? `${1000 + k}` : `${5000 + k}`,
    remaining_amount: remaining,
    total: remaining,
    currency: 'SEK',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    status: 'sent',
    document_type: 'invoice',
    credited_invoice_id: null,
    customer: { name: `Kund ${k}` },
  }
}

/**
 * Customer k owes 1000 + k and 1500 + k kronor and paid 2500 + 2k: every
 * pair adds up to its own amount, and no single invoice reaches any of them,
 * so each transfer has exactly one explanation.
 */
function books() {
  return {
    invoices: range(CUSTOMERS).flatMap((k) => [openInvoice(firstInvoice(k), k, 1000 + k), openInvoice(secondInvoice(k), k, 1500 + k)]),
    transactions: range(CUSTOMERS).map((k) => ({
      id: receipt(k),
      company_id: COMPANY,
      date: '2026-10-20',
      description: `Inbetalning ${k}`,
      amount: 2500 + 2 * k,
      currency: 'SEK',
      potential_match_method: null,
      is_business: null,
      is_ignored: false,
      journal_entry_id: null,
    })),
    invoice_payments: [
      { id: uuid(1, '44444444'), company_id: COMPANY, invoice_id: secondInvoice(LEAKED), journal_entry_id: uuid(1, '55555555') },
    ],
  }
}

describe('listInvoiceCombinationSuggestions: the sets of many bank rows', () => {
  it('offers every set whose invoices have no payment voucher, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(books())

    const matches = await listInvoiceCombinationSuggestions(supabase, COMPANY, 200)

    // The leaked invoice is in the last slice of the guard read: its set is held back.
    expect(matches.map((m) => m.transaction_id).sort()).toEqual(
      range(CUSTOMERS).filter((k) => k !== LEAKED).map(receipt).sort(),
    )
    expect(matches.find((m) => m.transaction_id === receipt(1))?.allocations).toEqual([
      { kind: 'customer_invoice', invoice_id: firstInvoice(1), amount: 1001 },
      { kind: 'customer_invoice', invoice_id: secondInvoice(1), amount: 1501 },
    ])
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(requestsTo('invoice_payments').map((r) => inListOf(r, 'invoice_id').length)).toEqual([100, 100, 50])
    expect(unmodelled).toEqual([])
  })

  it('soft-fails to [] and logs when a later slice of the guard cannot be read', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const guardReads: GatewayRequest[] = []
    const { supabase, requestsTo } = createGatewaySupabase(books(), {
      refuse: (request) => request.table === 'invoice_payments' && guardReads.push(request) === 2,
    })

    await expect(listInvoiceCombinationSuggestions(supabase, COMPANY, 200)).resolves.toEqual([])

    // The second slice failed: the third is never read, and nothing is offered.
    expect(requestsTo('invoice_payments').map((r) => inListOf(r, 'invoice_id').length)).toEqual([100, 100])
    const logged = consoleError.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(logged).toContain('guard failed')
    expect(logged).toContain(COMPANY)
    consoleError.mockRestore()
  })
})

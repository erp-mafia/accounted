/**
 * inbox.bulk-book's capture for a large selection of inbox items.
 *
 * "Fråga assistenten" sends the checked items, and a shift-click range checks
 * hundreds at once: the only bound is the 20 000 characters the invoke route
 * allows the intent arguments, 512 ids. Capture read them by id with one
 * `.in()`, and supabase-js puts the ids in the GET query string: 512 uuids
 * are about 20 KB, past both gateways' limits, so the read was refused, the
 * error went unread, and the agent was told that no item could be read. The
 * fake gateway (tests/gateway-supabase.ts) refuses a URL past a self-hosted
 * Kong's 8 KB, the stricter of the two.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inboxBulkBook } from '../inbox-bulk-book'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf, type GatewayRequest } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'

/** The invoke route's bound on the intent arguments (MAX_USER_MESSAGE_LEN in app/api/agent/invoke/route.ts). */
const INTENT_ARGS_MAX = 20_000

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
const item = (n: number) => uuid(n, '11111111')
const bankRow = (n: number) => uuid(n, '22222222')

/** The largest selection whose ids the route takes as intent arguments. */
const SELECTION_MAX = (() => {
  let n = 0
  while (JSON.stringify({ item_ids: range(n + 1).map(item) }).length <= INTENT_ARGS_MAX) n++
  return n
})()

/** `count` checked items, each matched to its own bank row and not yet booked. */
function inbox(count: number) {
  return {
    invoice_inbox_items: range(count).map((n) => ({
      id: item(n),
      company_id: COMPANY,
      matched_transaction_id: bankRow(n),
      created_journal_entry_id: null,
      created_supplier_invoice_id: null,
      extracted_data: { supplier: { name: `Leverantör ${n}` }, totals: { total: n, vatAmount: null } },
    })),
    transactions: range(count).map((n) => ({
      id: bankRow(n),
      company_id: COMPANY,
      date: '2026-11-03',
      amount: -n,
      currency: 'SEK',
      amount_sek: null,
      exchange_rate: null,
      description: `Kortköp ${n}`,
    })),
  }
}

function capture(supabase: SupabaseClient, count: number) {
  return inboxBulkBook.capture({ item_ids: range(count).map(item) }, { supabase, userId: 'user-1', companyId: COMPANY })
}

describe('inbox.bulk-book capture: a large selection', () => {
  it('captures every item of the largest selection with its bank row, in requests the gateway takes', async () => {
    expect(SELECTION_MAX).toBe(512)
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(inbox(SELECTION_MAX))

    const captured = await capture(supabase, SELECTION_MAX)

    expect(captured.bookable_count).toBe(SELECTION_MAX)
    expect(captured.items.map((it) => it.item_id).sort()).toEqual(range(SELECTION_MAX).map(item).sort())
    expect(captured.items.find((it) => it.item_id === item(SELECTION_MAX))).toMatchObject({
      status: 'bookable',
      merchant_name: `Leverantör ${SELECTION_MAX}`,
      tx_amount: SELECTION_MAX,
      tx_currency: 'SEK',
      tx_date: '2026-11-03',
    })
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    const slices = [100, 100, 100, 100, 100, 12]
    expect(requestsTo('invoice_inbox_items').map((r) => inListOf(r, 'id').length)).toEqual(slices)
    expect(requestsTo('transactions').map((r) => inListOf(r, 'id').length)).toEqual(slices)
    expect(unmodelled).toEqual([])
  })

  it('reads a selection of 100 in one request and one of 101 in two, every item once', async () => {
    for (const [count, slices] of [[100, [100]], [101, [100, 1]]] as const) {
      const { supabase, requestsTo } = createGatewaySupabase(inbox(count))

      const captured = await capture(supabase, count)

      expect(captured.items).toHaveLength(count)
      expect(captured.items.every((it) => it.tx_amount !== null)).toBe(true)
      expect(requestsTo('invoice_inbox_items').map((r) => inListOf(r, 'id').length)).toEqual(slices)
      expect(requestsTo('transactions').map((r) => inListOf(r, 'id').length)).toEqual(slices)
    }
  })

  it('reads a repeated id once', async () => {
    const { supabase, requestsTo } = createGatewaySupabase(inbox(101))

    const captured = await inboxBulkBook.capture(
      { item_ids: [...range(101).map(item), item(1), item(101)] },
      { supabase, userId: 'user-1', companyId: COMPANY },
    )

    expect(captured.items).toHaveLength(101)
    expect(requestsTo('invoice_inbox_items').map((r) => inListOf(r, 'id').length)).toEqual([100, 1])
  })

  it('throws when a slice of the items or of their bank rows cannot be read', async () => {
    for (const table of ['invoice_inbox_items', 'transactions']) {
      const seen: GatewayRequest[] = []
      const { supabase } = createGatewaySupabase(inbox(101), {
        refuse: (request) => request.table === table && seen.push(request) === 2,
      })

      await expect(capture(supabase, 101), table).rejects.toMatchObject({ code: '57014' })
    }
  })
})

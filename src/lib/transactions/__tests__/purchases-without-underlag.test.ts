/**
 * What counts as a purchase still missing its underlag.
 *
 * A bank transaction can be booked three ways, and only one of them sets
 * `journal_entry_id`: bulk-booking many transactions onto one verifikat records
 * it in transaction_voucher_links, and a payment split across invoices records
 * it in the payment tables. Both leave the column null, so the list reads
 * public.open_bank_rows: the database decides what is open, and
 * tests/pg/bank-row-open-read.pg.test.ts proves it for every booked shape. What
 * is left to pin here is what the list asks of the view.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { fetchPurchasesWithoutUnderlag } from '../purchases-without-underlag'

function tx(over: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    company_id: 'company-1',
    date: '2026-08-04',
    description: 'Elgiganten',
    merchant_name: 'Elgiganten',
    amount: -21639,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    journal_entry_id: null,
    ...over,
  }
}

describe('fetchPurchasesWithoutUnderlag', () => {
  it('is what open_bank_rows answers', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [tx({ id: 'a' }), tx({ id: 'b' })] })
    const out = await fetchPurchasesWithoutUnderlag(supabase as never, 'company-1')
    expect(out.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('asks the view for the company\'s outflows with no document, newest first, and reads nothing else', async () => {
    const { supabase, enqueue, calls, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const out = await fetchPurchasesWithoutUnderlag(supabase as never, 'company-1')
    expect(out).toEqual([])
    expect([...new Set(calls.map((c) => c.table))]).toEqual(['open_bank_rows'])
    expect(findCall('open_bank_rows', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCalls('open_bank_rows', 'is')).toEqual([['document_id', null]])
    expect(findCall('open_bank_rows', 'lt')).toEqual(['amount', 0])
    expect(findCall('open_bank_rows', 'order')).toEqual(['date', { ascending: false }])
  })
})

/**
 * What counts as a purchase still missing its underlag.
 *
 * The interesting cases are the ones the column filter cannot see. A bank
 * transaction can be booked three ways, and only one of them sets
 * `journal_entry_id`: bulk-booking many transactions onto one verifikat records
 * it in transaction_voucher_links, and a payment split across invoices records
 * it in the payment tables. Both leave the column null.
 *
 * The receipt hunt tolerates those false candidates because the worst case is a
 * proposal nobody accepts. This list is shown to a person, where the same rows
 * would sit under "saknar underlag" forever, already booked, with nothing the
 * user could do to clear them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchPurchasesWithoutUnderlag } from '../purchases-without-underlag'

const rows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: async () => rows(),
}))

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

/** Supabase double whose link tables answer per table name. */
function db(links: { voucher?: string[]; invoice?: string[]; supplier?: string[] } = {}) {
  const calls: string[] = []
  return {
    calls,
    from(table: string) {
      calls.push(table)
      const ids =
        table === 'transaction_voucher_links'
          ? links.voucher
          : table === 'invoice_payments'
            ? links.invoice
            : links.supplier
      const data = (ids ?? []).map((id) => ({ transaction_id: id }))
      const chain = { select: () => chain, in: async () => ({ data }) }
      return chain
    },
  } as never
}

beforeEach(() => vi.clearAllMocks())

describe('fetchPurchasesWithoutUnderlag', () => {
  it('returns purchases nothing has booked', async () => {
    rows.mockReturnValue([tx()])
    const out = await fetchPurchasesWithoutUnderlag(db(), 'company-1')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('tx-1')
  })

  it('skips the link-table lookups when there is nothing to check', async () => {
    rows.mockReturnValue([])
    const supabase = db()
    const out = await fetchPurchasesWithoutUnderlag(supabase, 'company-1')
    expect(out).toEqual([])
    expect((supabase as unknown as { calls: string[] }).calls).toEqual([])
  })

  it('excludes a transaction bulk-booked through a voucher link', async () => {
    // Many transactions, one verifikat: journal_entry_id stays null on every
    // one of them, so the column filter lets them all through.
    rows.mockReturnValue([tx({ id: 'tx-bulk' })])
    const out = await fetchPurchasesWithoutUnderlag(db({ voucher: ['tx-bulk'] }), 'company-1')
    expect(out).toEqual([])
  })

  it('excludes a transaction that paid a customer invoice', async () => {
    rows.mockReturnValue([tx({ id: 'tx-pay' })])
    const out = await fetchPurchasesWithoutUnderlag(db({ invoice: ['tx-pay'] }), 'company-1')
    expect(out).toEqual([])
  })

  it('excludes a transaction that paid a supplier invoice', async () => {
    rows.mockReturnValue([tx({ id: 'tx-sup' })])
    const out = await fetchPurchasesWithoutUnderlag(db({ supplier: ['tx-sup'] }), 'company-1')
    expect(out).toEqual([])
  })

  it('keeps the unbooked ones when only some of a batch are booked', async () => {
    rows.mockReturnValue([tx({ id: 'a' }), tx({ id: 'b' }), tx({ id: 'c' })])
    const out = await fetchPurchasesWithoutUnderlag(db({ voucher: ['b'] }), 'company-1')
    expect(out.map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('excludes a row that already carries a journal entry', async () => {
    // Belt and braces: the query filters this out, but the predicate is what
    // the page trusts and it must agree.
    rows.mockReturnValue([tx({ journal_entry_id: 'je-1' })])
    const out = await fetchPurchasesWithoutUnderlag(db(), 'company-1')
    expect(out).toEqual([])
  })
})

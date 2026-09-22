import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getJournalEntryLinkedTransactions } from '../journal-entry-transactions'

/**
 * The resolver issues its queries in a fixed `.from()` order, one queued
 * result per call:
 *   1. transactions               (journal_entry_id pointer)
 *   2. transaction_voucher_links  (junction: split / bulk-book)
 *   3. invoice_payments           (payment rows carrying a transaction_id)
 *   4. supplier_invoice_payments  (same, supplier side)
 *   5. transactions               (by id: only when 2-4 found new ids)
 *   6. skattekonto_transactions   (journal_entry_id pointer)
 */
describe('getJournalEntryLinkedTransactions', () => {
  const run = (results: { data: unknown }[]) => {
    const { supabase, enqueueMany, calls } = createQueuedMockSupabase()
    enqueueMany(results)
    return getJournalEntryLinkedTransactions(
      supabase as unknown as SupabaseClient,
      'company-1',
      'je-1',
    ).then((refs) => ({ refs, calls }))
  }

  const bankRow = (id: string, date: string, amount: number, description = 'BGGIRERING') => ({
    id,
    date,
    description,
    amount,
    currency: 'SEK',
  })

  it('returns the 1:1 pointer as a bank händelse', async () => {
    const { refs } = await run([
      { data: [bankRow('tx-1', '2026-09-05', 123)] }, // 1. transactions
      { data: [] }, // 2. junction
      { data: [] }, // 3. invoice_payments
      { data: [] }, // 4. supplier_invoice_payments
      { data: [] }, // 6. skattekonto (5 skipped: nothing indirect)
    ])

    expect(refs).toEqual([
      { kind: 'bank', id: 'tx-1', date: '2026-09-05', description: 'BGGIRERING', amount: 123, currency: 'SEK' },
    ])
  })

  it('follows the junction and payment rows and resolves them once, company-scoped', async () => {
    const { refs, calls } = await run([
      { data: [] }, // 1. transactions: pointer NULL on a split
      { data: [{ id: 'l-1', transaction_id: 'tx-a' }] }, // 2. junction
      { data: [{ id: 'p-1', transaction_id: 'tx-a' }, { id: 'p-2', transaction_id: 'tx-b' }] }, // 3. invoice_payments
      { data: [{ id: 'sp-1', transaction_id: 'tx-c' }] }, // 4. supplier_invoice_payments
      {
        data: [
          bankRow('tx-a', '2026-09-01', 500),
          bankRow('tx-b', '2026-09-03', -200, 'Faktura 1001'),
          bankRow('tx-c', '2026-09-02', -300, 'Leverantör'),
        ],
      }, // 5. transactions by id
      { data: [] }, // 6. skattekonto
    ])

    // tx-a appears in two anchors but is fetched and listed once.
    const byIdCall = calls.find((c) => c.table === 'transactions' && c.method === 'in')
    expect(byIdCall?.args).toEqual(['id', ['tx-a', 'tx-b', 'tx-c']])
    expect(calls.filter((c) => c.table === 'transactions' && c.method === 'eq' && c.args[0] === 'company_id')).toHaveLength(2)
    expect(refs.map((r) => r.id)).toEqual(['tx-b', 'tx-c', 'tx-a'])
  })

  it('returns a skattekonto row with its Skatteverket columns mapped', async () => {
    const { refs } = await run([
      { data: [] }, // 1
      { data: [] }, // 2
      { data: [] }, // 3
      { data: [] }, // 4
      {
        data: [
          { id: 'skv-1', transaktionsdatum: '2026-09-05', transaktionstext: 'Intäktsränta', belopp_skatteverket: '123.00' },
        ],
      }, // 6
    ])

    expect(refs).toEqual([
      { kind: 'skattekonto', id: 'skv-1', date: '2026-09-05', description: 'Intäktsränta', amount: 123, currency: null },
    ])
  })

  it('sorts bank and skattekonto rows together, newest first', async () => {
    const { refs } = await run([
      { data: [bankRow('tx-old', '2026-08-30', 10), bankRow('tx-new', '2026-09-10', 20)] },
      { data: [] },
      { data: [] },
      { data: [] },
      { data: [{ id: 'skv-mid', transaktionsdatum: '2026-09-05', transaktionstext: 'Inbetalning', belopp_skatteverket: 5 }] },
    ])

    expect(refs.map((r) => r.id)).toEqual(['tx-new', 'skv-mid', 'tx-old'])
  })

  it('resolves to nothing for an entry with no händelse', async () => {
    const { refs } = await run([{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }])
    expect(refs).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getJournalEntryUnderlagReferences } from '../journal-entry-references'

/**
 * The resolver issues its queries in a fixed `.from()` order, and the queued
 * mock consumes one enqueued result per `.from()` call:
 *   1. invoices                  (direct journal_entry_id link)
 *   2. invoice_payments          (payment rows → invoice_id)
 *   3. invoices                  (by id: only when step 2 found new ids)
 *   4. supplier_invoices         (registration_journal_entry_id)
 *   5. supplier_invoices         (payment_journal_entry_id)
 *   6. supplier_invoice_payments (payment rows → supplier_invoice_id)
 *   7. supplier_invoices         (by id: only when step 6 found new ids)
 */
describe('getJournalEntryUnderlagReferences', () => {
  const run = (results: { data: unknown }[]) => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany(results)
    return getJournalEntryUnderlagReferences(
      supabase as unknown as SupabaseClient,
      'company-1',
      'je-1',
    )
  }

  it('surfaces a customer invoice linked only via a cash-method payment row', async () => {
    // The reported gap: debit 1930 / credit 3001, invoice linked through
    // invoice_payments, no document attached and no direct invoice link.
    const refs = await run([
      { data: [] }, // 1. invoices direct: none
      { data: [{ invoice_id: 'inv-x' }] }, // 2. invoice_payments
      { data: [{ id: 'inv-x', invoice_number: '003' }] }, // 3. invoices by id
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{ type: 'invoice', id: 'inv-x', number: '003' }])
  })

  it('surfaces a supplier invoice linked via its registration booking', async () => {
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments (empty → step 3 skipped)
      { data: [{ id: 'si-1', supplier_invoice_number: 'LF-001' }] }, // 4. registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{ type: 'supplier_invoice', id: 'si-1', number: 'LF-001' }])
  })

  it('returns nothing when no invoice is linked (warning legitimately stays)', async () => {
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([])
  })

  it('deduplicates an invoice reachable via both the direct link and a payment row', async () => {
    const refs = await run([
      { data: [{ id: 'inv-x', invoice_number: '003' }] }, // 1. invoices direct
      { data: [{ invoice_id: 'inv-x' }] }, // 2. invoice_payments (already known → step 3 skipped)
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{ type: 'invoice', id: 'inv-x', number: '003' }])
  })

  it('returns both a customer and a supplier invoice, customer first', async () => {
    const refs = await run([
      { data: [{ id: 'inv-a', invoice_number: 'A1' }] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments (empty → step 3 skipped)
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [{ supplier_invoice_id: 'si-2' }] }, // 6. supplier_invoice_payments
      { data: [{ id: 'si-2', supplier_invoice_number: 'LF-2' }] }, // 7. supplier by id
    ])

    expect(refs).toEqual([
      { type: 'invoice', id: 'inv-a', number: 'A1' },
      { type: 'supplier_invoice', id: 'si-2', number: 'LF-2' },
    ])
  })
})

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  getInvoiceReferencesForJournalEntries,
  getJournalEntryUnderlagReferences,
} from '../journal-entry-references'

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

  it('surfaces the retained PDF through a supplier payment reference', async () => {
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments
      { data: [] }, // 4. supplier registration
      { data: [{
        id: 'si-1',
        supplier_invoice_number: 'LF-001',
        document_id: 'doc-1',
        document: { journal_entry_id: 'je-9' },
      }] }, // 5. supplier payment
      { data: [{ supplier_invoice_id: 'si-1' }] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{
      type: 'supplier_invoice',
      id: 'si-1',
      number: 'LF-001',
      document_id: 'doc-1',
    }])
  })

  it('withholds a FLOATING supplier-invoice document but keeps the reference', async () => {
    // An unanchored document (journal_entry_id IS NULL) sits outside the WORM
    // deletion guards, so every missing-underlag surface refuses to count it.
    // Handing it out here is what made the verifikat view show an underlag
    // while the list warned "Underlag saknas" on the same row.
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments
      { data: [] }, // 4. supplier registration
      { data: [{
        id: 'si-1',
        supplier_invoice_number: 'LF-001',
        document_id: 'doc-1',
        document: { journal_entry_id: null },
      }] }, // 5. supplier payment
      { data: [{ supplier_invoice_id: 'si-1' }] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{ type: 'supplier_invoice', id: 'si-1', number: 'LF-001' }])
  })

  it('accepts the embedded document row in PostgREST array form', async () => {
    const refs = await run([
      { data: [] }, // 1. invoices direct
      { data: [] }, // 2. invoice_payments
      { data: [{
        id: 'si-1',
        supplier_invoice_number: 'LF-001',
        document_id: 'doc-1',
        document: [{ journal_entry_id: 'je-9' }],
      }] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])

    expect(refs).toEqual([{
      type: 'supplier_invoice',
      id: 'si-1',
      number: 'LF-001',
      document_id: 'doc-1',
    }])
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

  it('asks only for ISSUED customer invoices: a draft or cancelled one is no underlag (#2298)', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: [] }, // 1. invoices direct
      { data: [{ invoice_id: 'inv-x' }] }, // 2. invoice_payments
      { data: [] }, // 3. invoices by id: the cancelled invoice is filtered out server-side
      { data: [] }, // 4. supplier registration
      { data: [] }, // 5. supplier payment
      { data: [] }, // 6. supplier_invoice_payments
    ])
    const refs = await getJournalEntryUnderlagReferences(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      'je-1',
    )
    expect(refs).toEqual([])
    const notCalls = mock.findCalls('invoices', 'not')
    expect(notCalls).toHaveLength(2)
    for (const call of notCalls) expect(call).toEqual(['status', 'in', '("draft","cancelled")'])
  })
})

/**
 * Batch resolver behind every TS mirror of the RPC's customer-invoice arm
 * (#2298). Fixed `.from()` order: invoices (by journal_entry_id), then
 * invoice_payments (by journal_entry_id).
 */
describe('getInvoiceReferencesForJournalEntries', () => {
  const setup = (results: { data: unknown }[]) => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany(results)
    return mock
  }

  it('returns nothing, without a round trip, for an empty id list', async () => {
    const mock = setup([])
    const refs = await getInvoiceReferencesForJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      [],
    )
    expect(refs.size).toBe(0)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('maps the registration link and payment rows onto their entries, deduplicated', async () => {
    const mock = setup([
      { data: [{ id: 'inv-reg', journal_entry_id: 'je-1' }] },
      {
        data: [
          // The reported case: a SIE-imported voucher matched to an invoice.
          { id: 'pay-a', invoice_id: 'inv-imp', journal_entry_id: 'je-2' },
          // Same invoice already reached through the direct link: once.
          { id: 'pay-b', invoice_id: 'inv-reg', journal_entry_id: 'je-1' },
          // One deposit settling two invoices: both are references.
          { id: 'pay-c', invoice_id: 'inv-other', journal_entry_id: 'je-2' },
          // Defensive: a row without an invoice id is not a reference.
          { id: 'pay-d', invoice_id: null, journal_entry_id: 'je-3' },
        ],
      },
    ])
    const refs = await getInvoiceReferencesForJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      ['je-1', 'je-2', 'je-3'],
    )
    expect(Array.from(refs.entries())).toEqual([
      ['je-1', ['inv-reg']],
      ['je-2', ['inv-imp', 'inv-other']],
    ])
  })

  it('scopes both lookups to the company and the given ids', async () => {
    const mock = setup([{ data: [] }, { data: [] }])
    await getInvoiceReferencesForJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      ['je-1', 'je-2'],
    )
    expect(mock.findCalls('invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(mock.findCalls('invoices', 'in')).toContainEqual(['journal_entry_id', ['je-1', 'je-2']])
    expect(mock.findCalls('invoice_payments', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(mock.findCalls('invoice_payments', 'in')).toContainEqual([
      'journal_entry_id',
      ['je-1', 'je-2'],
    ])
  })

  it('asks only for ISSUED invoices on both links, mirroring the RPC status guard', async () => {
    const mock = setup([{ data: [] }, { data: [] }])
    await getInvoiceReferencesForJournalEntries(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      ['je-1'],
    )
    expect(mock.findCalls('invoices', 'not')).toContainEqual(['status', 'in', '("draft","cancelled")'])
    // The payment query carries the invoice status as an inner embed and
    // filters on it, so a non-issued invoice's payment row never comes back.
    expect(mock.findCall('invoice_payments', 'select')).toEqual([
      'id, invoice_id, journal_entry_id, invoices!inner(status)',
    ])
    expect(mock.findCalls('invoice_payments', 'not')).toContainEqual([
      'invoices.status',
      'in',
      '("draft","cancelled")',
    ])
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { anchorCustomerInvoiceDocument } from '../customer-invoice-underlag'

/**
 * anchorCustomerInvoiceDocument issues its queries in a fixed `.from()` order,
 * and the queued mock consumes one enqueued result per `.from()` call:
 *   1. invoices              (the invoice + its registration verifikat)
 *   2. invoice_deliveries    (the newest archived send)
 *   3. document_attachments  (the archived PDF, anchor check)
 *   4. invoice_payments      (payment verifikat candidates, oldest first)
 *   5. journal_entries       (status + period of every candidate)
 *   6. document_attachments  (the anchoring UPDATE)
 * Steps 3-6 are skipped when there is nothing to anchor.
 */
describe('anchorCustomerInvoiceDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const openPeriod = { is_closed: false, locked_at: null }
  const sb = (supabase: unknown) => supabase as unknown as SupabaseClient

  it('anchors the archived PDF to the linked payment verifikat under kontantmetoden', async () => {
    // The reported case: no registration verifikat, the invoice was linked to
    // the bank verifikat that booked the payment, and the verifikat showed no
    // underlag although the sent PDF was archived.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: { document_attachment_id: 'doc-1' } },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: [{ id: 'doc-1' }] },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1')).toBe('je-pay')
    expect(supabase.from).toHaveBeenCalledTimes(6)
    expect(supabase.from).toHaveBeenNthCalledWith(6, 'document_attachments')
  })

  it('prefers the registration verifikat when the invoice has one', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: 'je-reg' } },
      { data: { document_attachment_id: 'doc-1' } },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      {
        data: [
          { id: 'je-pay', status: 'posted', fiscal_period: openPeriod },
          { id: 'je-reg', status: 'posted', fiscal_period: openPeriod },
        ],
      },
      { data: [{ id: 'doc-1' }] },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1')).toBe('je-reg')
  })

  it('is idempotent: an already-anchored PDF is never moved and no duplicate is made', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: { document_attachment_id: 'doc-1' } },
      { data: { id: 'doc-1', journal_entry_id: 'je-pay', is_current_version: true } },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1')).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  it('does nothing when the invoice has no archived PDF (never renders a substitute)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'inv-1', journal_entry_id: null } }, { data: null }])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1')).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('does nothing for an invoice outside the company', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: null }])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-x')).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('leaves a superseded PDF version alone', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: { document_attachment_id: 'doc-1' } },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: false } },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1')).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  it('skips reversed verifikat and verifikat in locked or closed periods', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: { document_attachment_id: 'doc-1' } },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-a' }, { journal_entry_id: 'je-b' }, { journal_entry_id: 'je-c' }] },
      {
        data: [
          { id: 'je-a', status: 'reversed', fiscal_period: openPeriod },
          { id: 'je-b', status: 'posted', fiscal_period: { is_closed: false, locked_at: '2026-08-01' } },
          { id: 'je-c', status: 'posted', fiscal_period: { is_closed: true, locked_at: null } },
        ],
      },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1')).toBeNull()
    // No UPDATE was attempted.
    expect(supabase.from).toHaveBeenCalledTimes(5)
  })

  it('reports null when the guarded update matched no rows (a concurrent writer won)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: { document_attachment_id: 'doc-1' } },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: [] },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1')).toBeNull()
  })

  it('never throws: an update error is logged and reported as null', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: { document_attachment_id: 'doc-1' } },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: null, error: { message: 'period is locked' } },
    ])

    await expect(anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1')).resolves.toBeNull()
  })
})

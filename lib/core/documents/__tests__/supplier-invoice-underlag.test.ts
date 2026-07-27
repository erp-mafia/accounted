import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  anchorSupplierInvoiceDocument,
  reanchorOrphanedSupplierInvoiceDocuments,
} from '../supplier-invoice-underlag'

/**
 * anchorSupplierInvoiceDocument issues its queries in a fixed `.from()` order,
 * and the queued mock consumes one enqueued result per `.from()` call:
 *   1. supplier_invoices          (the invoice + its FK verifikat)
 *   2. document_attachments       (the retained document, anchor check)
 *   3. supplier_invoice_payments  (partial-payment verifikat candidates)
 *   4. journal_entries            (status + period of every candidate)
 *   5. document_attachments       (the anchoring UPDATE)
 * Steps 3-5 are skipped when the document needs no anchoring.
 */
describe('anchorSupplierInvoiceDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const openPeriod = { is_closed: false, locked_at: null }

  it('anchors a floating document to the payment verifikat when registration was reversed', async () => {
    // The reported case: the invoice PDF was orphaned when the rättelse it had
    // been relinked onto was deleted, leaving the posted payment verifikat
    // warning "Underlag saknas" while the verifikat view showed the PDF.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'si-1',
          document_id: 'doc-1',
          registration_journal_entry_id: 'je-reg',
          payment_journal_entry_id: 'je-pay',
        },
      },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [] },
      {
        data: [
          { id: 'je-reg', status: 'reversed', fiscal_period: openPeriod },
          { id: 'je-pay', status: 'posted', fiscal_period: openPeriod },
        ],
      },
      { data: null },
    ])

    const anchored = await anchorSupplierInvoiceDocument(
      supabase as unknown as SupabaseClient,
      'company-1',
      'si-1',
    )

    expect(anchored).toBe('je-pay')
    expect(supabase.from).toHaveBeenCalledTimes(5)
  })

  it('prefers the registration verifikat: it is the primary booking', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'si-1',
          document_id: 'doc-1',
          registration_journal_entry_id: 'je-reg',
          payment_journal_entry_id: 'je-pay',
        },
      },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [] },
      {
        data: [
          { id: 'je-reg', status: 'posted', fiscal_period: openPeriod },
          { id: 'je-pay', status: 'posted', fiscal_period: openPeriod },
        ],
      },
      { data: null },
    ])

    expect(
      await anchorSupplierInvoiceDocument(
        supabase as unknown as SupabaseClient,
        'company-1',
        'si-1',
      ),
    ).toBe('je-reg')
  })

  it('falls back to a partial-payment verifikat, oldest first', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'si-1',
          document_id: 'doc-1',
          registration_journal_entry_id: null,
          payment_journal_entry_id: null,
        },
      },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-p1' }, { journal_entry_id: 'je-p2' }] },
      {
        data: [
          { id: 'je-p1', status: 'posted', fiscal_period: openPeriod },
          { id: 'je-p2', status: 'posted', fiscal_period: openPeriod },
        ],
      },
      { data: null },
    ])

    expect(
      await anchorSupplierInvoiceDocument(
        supabase as unknown as SupabaseClient,
        'company-1',
        'si-1',
      ),
    ).toBe('je-p1')
  })

  it('never moves a document that is already anchored', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'si-1',
          document_id: 'doc-1',
          registration_journal_entry_id: 'je-reg',
          payment_journal_entry_id: 'je-pay',
        },
      },
      { data: { id: 'doc-1', journal_entry_id: 'je-reg', is_current_version: true } },
    ])

    expect(
      await anchorSupplierInvoiceDocument(
        supabase as unknown as SupabaseClient,
        'company-1',
        'si-1',
      ),
    ).toBeNull()
    // Stopped before the candidate lookup: no UPDATE was attempted.
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('leaves a superseded document alone', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'si-1',
          document_id: 'doc-1',
          registration_journal_entry_id: 'je-reg',
          payment_journal_entry_id: null,
        },
      },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: false } },
    ])

    expect(
      await anchorSupplierInvoiceDocument(
        supabase as unknown as SupabaseClient,
        'company-1',
        'si-1',
      ),
    ).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('skips a candidate whose period is locked (the trigger would reject the write)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'si-1',
          document_id: 'doc-1',
          registration_journal_entry_id: 'je-reg',
          payment_journal_entry_id: null,
        },
      },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [] },
      {
        data: [
          {
            id: 'je-reg',
            status: 'posted',
            fiscal_period: { is_closed: false, locked_at: '2026-07-01T00:00:00Z' },
          },
        ],
      },
    ])

    expect(
      await anchorSupplierInvoiceDocument(
        supabase as unknown as SupabaseClient,
        'company-1',
        'si-1',
      ),
    ).toBeNull()
    // Candidates were resolved, but no UPDATE followed.
    expect(supabase.from).toHaveBeenCalledTimes(4)
  })

  it('does nothing when the invoice has no retained document', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'si-1',
          document_id: null,
          registration_journal_entry_id: 'je-reg',
          payment_journal_entry_id: null,
        },
      },
    ])

    expect(
      await anchorSupplierInvoiceDocument(
        supabase as unknown as SupabaseClient,
        'company-1',
        'si-1',
      ),
    ).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('reports failure as null instead of throwing at the caller', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'si-1',
          document_id: 'doc-1',
          registration_journal_entry_id: 'je-reg',
          payment_journal_entry_id: null,
        },
      },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [] },
      { data: [{ id: 'je-reg', status: 'posted', fiscal_period: openPeriod }] },
      { error: { message: 'period locked' } },
    ])

    await expect(
      anchorSupplierInvoiceDocument(supabase as unknown as SupabaseClient, 'company-1', 'si-1'),
    ).resolves.toBeNull()
  })
})

describe('reanchorOrphanedSupplierInvoiceDocuments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-anchors the supplier invoice whose document a deleted voucher orphaned', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'si-1' }] }, // supplier_invoices by document_id
      {
        data: {
          id: 'si-1',
          document_id: 'doc-1',
          registration_journal_entry_id: null,
          payment_journal_entry_id: 'je-pay',
        },
      },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [] },
      {
        data: [{ id: 'je-pay', status: 'posted', fiscal_period: { is_closed: false, locked_at: null } }],
      },
      { data: null },
    ])

    expect(
      await reanchorOrphanedSupplierInvoiceDocuments(
        supabase as unknown as SupabaseClient,
        'company-1',
        ['doc-1'],
      ),
    ).toBe(1)
  })

  it('leaves a plain receipt floating so it returns to the unlinked pool', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }]) // no supplier invoice owns this document

    expect(
      await reanchorOrphanedSupplierInvoiceDocuments(
        supabase as unknown as SupabaseClient,
        'company-1',
        ['doc-9'],
      ),
    ).toBe(0)
  })

  it('short-circuits when the deleted voucher had no documents', async () => {
    const { supabase } = createQueuedMockSupabase()

    expect(
      await reanchorOrphanedSupplierInvoiceDocuments(
        supabase as unknown as SupabaseClient,
        'company-1',
        [],
      ),
    ).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

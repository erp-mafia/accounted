import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  anchorSupplierInvoiceDocument,
  reanchorOrphanedSupplierInvoiceDocuments,
  sweepFloatingSupplierInvoiceDocuments,
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
      { data: [{ id: 'doc-1' }] },
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
      { data: [{ id: 'doc-1' }] },
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
      { data: [{ id: 'doc-1' }] },
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

  it('reports a zero-row update as null: a write that never happened is not an anchor', async () => {
    // Prod case 2026-08-28 (faktura 118776): every static condition passed yet
    // the document stayed floating. The guarded update can match nothing (a
    // concurrent writer, or RLS filtering the row); claiming success then hides
    // the miss from both callers and the reconcile cron.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
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
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: [] }, // UPDATE matched no rows
    ])

    await expect(
      anchorSupplierInvoiceDocument(supabase as unknown as SupabaseClient, 'company-1', 'si-1'),
    ).resolves.toBeNull()
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

describe('sweepFloatingSupplierInvoiceDocuments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const openPeriod = { is_closed: false, locked_at: null }

  it('anchors every floating retained document it finds, across companies', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      // Candidate scan: two invoices with floating current-version documents.
      {
        data: [
          { id: 'si-1', company_id: 'company-1', document: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
          { id: 'si-2', company_id: 'company-2', document: { id: 'doc-2', journal_entry_id: null, is_current_version: true } },
        ],
      },
      // anchorSupplierInvoiceDocument for si-1 (5 queries)
      { data: { id: 'si-1', document_id: 'doc-1', registration_journal_entry_id: null, payment_journal_entry_id: 'je-1' } },
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [] },
      { data: [{ id: 'je-1', status: 'posted', fiscal_period: openPeriod }] },
      { data: [{ id: 'doc-1' }] },
      // anchorSupplierInvoiceDocument for si-2: its only verifikat is locked.
      { data: { id: 'si-2', document_id: 'doc-2', registration_journal_entry_id: null, payment_journal_entry_id: 'je-2' } },
      { data: { id: 'doc-2', journal_entry_id: null, is_current_version: true } },
      { data: [] },
      { data: [{ id: 'je-2', status: 'posted', fiscal_period: { is_closed: true, locked_at: null } }] },
    ])

    const result = await sweepFloatingSupplierInvoiceDocuments(
      supabase as unknown as SupabaseClient,
    )
    expect(result).toEqual({ candidates: 2, anchored: 1 })
  })

  it('returns zeros and touches nothing when no document is floating', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [] }])

    const result = await sweepFloatingSupplierInvoiceDocuments(
      supabase as unknown as SupabaseClient,
    )
    expect(result).toEqual({ candidates: 0, anchored: 0 })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('survives a failed candidate scan without throwing', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ error: { message: 'relation walk failed' } }])

    await expect(
      sweepFloatingSupplierInvoiceDocuments(supabase as unknown as SupabaseClient),
    ).resolves.toEqual({ candidates: 0, anchored: 0 })
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
      { data: [{ id: 'doc-1' }] },
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

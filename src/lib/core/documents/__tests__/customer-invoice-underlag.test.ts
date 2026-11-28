import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The warn level is recorded and passed on to the real logger: a history the
// anchor cannot read must say so.
const logWarn = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => {
      const real = actual.createLogger(module, base)
      return {
        ...real,
        warn: (message: string, ...args: unknown[]) => {
          logWarn(message, ...args)
          real.warn(message, ...args)
        },
      }
    },
  }
})

import { anchorCustomerInvoiceDocument } from '../customer-invoice-underlag'

/**
 * anchorCustomerInvoiceDocument issues its queries in a fixed order, and the
 * queued mock consumes one enqueued result per `.from()` or `.rpc()` call:
 *   1. invoices              (the invoice + its registration verifikat)
 *   2. rpc list_invoice_delivery_summaries (the delivery history; on 42501
 *      list_invoice_delivery_summaries_for_service takes the next result)
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
  // The delivery history as the masked readers return it, newest first.
  const sentWith = (documentId: string) => ({
    data: [
      { id: 'del-1', status: 'sent', document_attachment_id: documentId, sent_at: '2026-10-26T15:37:49Z' },
    ],
  })

  it('anchors the archived PDF to the linked payment verifikat under kontantmetoden', async () => {
    // The reported case: no registration verifikat, the invoice was linked to
    // the bank verifikat that booked the payment, and the verifikat showed no
    // underlag although the sent PDF was archived.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      sentWith('doc-1'),
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: [{ id: 'doc-1' }] },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBe('je-pay')
    expect(supabase.from).toHaveBeenCalledTimes(5)
    expect(supabase.from).toHaveBeenNthCalledWith(5, 'document_attachments')
  })

  it("anchors the PDF a colleague emailed: it reads the company's delivery history, not invoice_deliveries", async () => {
    // invoice_deliveries' SELECT policy shows a member only the deliveries
    // they sent, so when someone other than the sender linked the payment, a
    // read of the table found nothing and the PDF stayed off the verifikat.
    // The masked history serves every member, whoever sent the invoice.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      sentWith('doc-1'),
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: [{ id: 'doc-1' }] },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'colleague-1')).toBe('je-pay')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('list_invoice_delivery_summaries', {
      p_company_id: 'company-1',
      p_invoice_id: 'inv-1',
    })
    expect(supabase.from).not.toHaveBeenCalledWith('invoice_deliveries')
  })

  it("reads the history in the acting member's name on the service role (MCP, v1, grants)", async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: null, error: { code: '42501', message: 'not authorized to list invoice delivery summaries' } },
      sentWith('doc-1'),
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: [{ id: 'doc-1' }] },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBe('je-pay')
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'list_invoice_delivery_summaries_for_service', {
      p_company_id: 'company-1',
      p_user_id: 'user-1',
      p_invoice_id: 'inv-1',
    })
  })

  it('leaves the PDF floating, and says so, when the delivery history cannot be read', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: null, error: { code: '42501', message: 'not authorized to list invoice delivery summaries' } },
      { data: null, error: { code: '42501', message: 'invoice delivery reader is not a company member' } },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBeNull()
    // Nothing past the history: no document read, no UPDATE.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith(
      'could not read the delivery history; customer invoice document left floating',
      expect.objectContaining({ invoiceId: 'inv-1', code: '42501', sessionReadCode: '42501' }),
    )
  })

  it('does not ask the service reader when the session read fails for another reason', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith(
      'could not read the delivery history; customer invoice document left floating',
      expect.not.objectContaining({ sessionReadCode: expect.anything() }),
    )
  })

  it('prefers the registration verifikat when the invoice has one', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: 'je-reg' } },
      sentWith('doc-1'),
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

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBe('je-reg')
  })

  it('is idempotent: an already-anchored PDF is never moved and no duplicate is made', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      sentWith('doc-1'),
      { data: { id: 'doc-1', journal_entry_id: 'je-pay', is_current_version: true } },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the invoice has no archived PDF (never renders a substitute)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      { data: [{ id: 'del-1', status: 'marked_sent', document_attachment_id: null, sent_at: '2026-10-26T15:37:49Z' }] },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an invoice outside the company', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: null }])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-x', 'user-1')).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('leaves a superseded PDF version alone', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      sentWith('doc-1'),
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: false } },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('skips reversed verifikat and verifikat in locked or closed periods', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      sentWith('doc-1'),
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

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBeNull()
    // No UPDATE was attempted.
    expect(supabase.from).toHaveBeenCalledTimes(4)
  })

  it('reports null when the guarded update matched no rows (a concurrent writer won)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      sentWith('doc-1'),
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: [] },
    ])

    expect(await anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).toBeNull()
  })

  it('never throws: an update error is logged and reported as null', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'inv-1', journal_entry_id: null } },
      sentWith('doc-1'),
      { data: { id: 'doc-1', journal_entry_id: null, is_current_version: true } },
      { data: [{ journal_entry_id: 'je-pay' }] },
      { data: [{ id: 'je-pay', status: 'posted', fiscal_period: openPeriod }] },
      { data: null, error: { message: 'period is locked' } },
    ])

    await expect(anchorCustomerInvoiceDocument(sb(supabase), 'company-1', 'inv-1', 'user-1')).resolves.toBeNull()
  })
})

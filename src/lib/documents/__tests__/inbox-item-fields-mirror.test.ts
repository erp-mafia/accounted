/**
 * updateInboxItemFields mirrors the corrected reading onto the document row
 * (document_attachments.extracted_data), best effort: the edit stands
 * whatever the mirror answers, a dry run, a frozen item and a conflict write
 * nothing to the document.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mirror = vi.fn()
vi.mock('@/lib/documents/reading-correction', () => ({
  mirrorCorrectedReadingToDocument: (...args: unknown[]) => mirror(...args),
}))

import { updateInboxItemFields } from '../inbox-item-actions'
import type { OperationContext } from '@/lib/operations/types'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const ctx = { supabase, companyId: 'co-1', userId: 'user-1', log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } as unknown as OperationContext

const reading = { supplier: { name: 'Telia' }, invoice: { currency: 'SEK' }, totals: { total: 500 }, lineItems: [], vatBreakdown: [], confidence: 0.9 }
const item = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  document_id: 'doc-1',
  extracted_data: reading,
  created_supplier_invoice_id: null,
  updated_at: '2026-10-01T08:00:00.000Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mirror.mockResolvedValue('mirrored')
})

describe('updateInboxItemFields: the document follows the correction', () => {
  it('mirrors the saved reading onto the item\'s document', async () => {
    enqueue({ data: item() })
    const saved = { ...reading, totals: { total: 450 }, totalSource: null }
    enqueue({ data: { id: 'item-1', extracted_data: saved } })

    const outcome = await updateInboxItemFields(ctx, 'item-1', { totals: { total: 450 } })

    expect(outcome).toEqual({ ok: true, data: { id: 'item-1', extracted_data: saved } })
    expect(findCall('invoice_inbox_items', 'select')?.[0]).toContain('document_id')
    expect(mirror).toHaveBeenCalledWith({ documentId: 'doc-1', companyId: 'co-1', reading: saved })
  })

  it.each(['locked', 'failed', 'no_document'])('keeps the edit when the mirror answers %s', async (answer) => {
    mirror.mockResolvedValue(answer)
    enqueue({ data: item() })
    enqueue({ data: { id: 'item-1', extracted_data: reading } })

    const outcome = await updateInboxItemFields(ctx, 'item-1', { supplier: { name: 'Telia Sverige AB' } })

    expect(outcome.ok).toBe(true)
  })

  it('writes nothing to the document on a dry run', async () => {
    enqueue({ data: item() })
    const outcome = await updateInboxItemFields(ctx, 'item-1', { totals: { total: 450 } }, { dryRun: true })
    expect(outcome.ok).toBe(true)
    expect(mirror).not.toHaveBeenCalled()
  })

  it('writes nothing to the document for a frozen item, a conflict or a missing item', async () => {
    enqueue({ data: item({ created_supplier_invoice_id: 'si-1' }) })
    expect(await updateInboxItemFields(ctx, 'item-1', { totals: { total: 450 } })).toMatchObject({ ok: false, code: 'INBOX_ITEM_EDIT_LOCKED' })

    enqueue({ data: item() })
    enqueue({ data: null })
    expect(await updateInboxItemFields(ctx, 'item-1', { totals: { total: 450 } })).toMatchObject({ ok: false, code: 'INBOX_ITEM_EDIT_CONFLICT' })

    enqueue({ data: null })
    expect(await updateInboxItemFields(ctx, 'item-1', { totals: { total: 450 } })).toMatchObject({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' })

    expect(mirror).not.toHaveBeenCalled()
  })
})

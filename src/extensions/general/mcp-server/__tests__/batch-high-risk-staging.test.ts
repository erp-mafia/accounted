/**
 * The staging helper refuses a high-risk operation inside a
 * gnubok_stage_across_companies batch, on the tier the row would carry.
 * Before, only a hand-kept list of tool names was refused, and a high-tier
 * staging tool missing from it (gnubok_book_invoice, gnubok_redate_entry,
 * gnubok_send_invoice_peppol, ...) was staged under the batch.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { runWithStagingBatch } from '@/lib/pending-operations/batch-context'
import { tools } from '../server'

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const deleteDraft = () => tools.find((t) => t.name === 'gnubok_delete_draft_invoice')!

const draftInvoice = { id: INVOICE_ID, invoice_number: null, status: 'draft', total: 100, currency: 'SEK', customer: { name: 'Kund AB' } }

describe('stagePendingOperation inside a batch', () => {
  it('refuses a high-risk operation before anything is staged', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice })
    enqueue({ data: { id: 'op-1' } })

    await expect(
      runWithStagingBatch('batch-1', () =>
        deleteDraft().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/never staged in batch/) })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('stages the same operation outside a batch', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice })
    enqueue({ data: { id: 'op-1' } })

    const result = await deleteDraft().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never)
    expect(result).toMatchObject({ staged: true, risk_level: 'high' })
  })
})

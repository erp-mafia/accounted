import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { downloadPaymentBatchFile } from '@/lib/payments/batch-operations'
import { batchFileBytes } from '@/lib/payments/batch-service'
import { fileResponse } from '@/lib/api/file-response'

/**
 * Download the payment file for a batch.
 *
 * The file regenerates deterministically from the stored batch + item rows:
 * msg_id and created_at were fixed at creation, so every download is
 * byte-identical and the bank's duplicate detection (keyed on MsgId) stays
 * meaningful. requireWrite because the download stamps file_generated_at and
 * bumps download_count (the tax payment-file route sets the precedent).
 *
 * Per BFL the generated file is räkenskapsinformation (underlag) for the
 * payments it initiates; the batch rows it derives from are retained.
 * Rules in lib/payments/batch-operations.ts (shared with v1).
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payment_batch.file',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const outcome = await downloadPaymentBatchFile({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: a read has no dry run')

    // pain.001 as UTF-8, an LB file as the ISO 8859-1 bytes Bankgirot reads.
    return fileResponse(batchFileBytes(outcome.data), { filename: outcome.data.filename, contentType: outcome.data.contentType })
  },
  { requireWrite: true },
)

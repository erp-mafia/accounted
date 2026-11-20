import { z } from 'zod'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ATTEST_BATCH_MAX_INVOICES } from '@/lib/supplier-invoices/attest-batches'
import { decideAttestBatch, withAttestBatchToken } from '@/lib/supplier-invoices/attest-batch-route'
import { attestLinkJson } from '@/lib/supplier-invoices/attest-link-route'
import { ATTEST_COMMENT_MAX } from '@/lib/supplier-invoices/attest-policy'

// Up to 100 invoices, each decided on its own through the attest service.
export const maxDuration = 300

const DecisionsBody = z
  .object({
    decisions: z
      .array(
        z
          .object({
            invoice_id: z.string().uuid(),
            decision: z.enum(['approve', 'reject']),
            comment: z.string().max(ATTEST_COMMENT_MAX).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(ATTEST_BATCH_MAX_INVOICES),
  })
  .strict()

/**
 * POST /api/attest/lista/:token/decisions: the attester's answer from the
 * batched mail's page, without a login: Godkänn or Neka (with a comment) per
 * invoice the mail listed. Each runs the same attest service as the
 * dashboard, as the attester the link names (source 'email_link'); one that
 * is refused or fails leaves the others recorded, and the answer says how
 * each went. The registrant gets one mail for the whole answer.
 */
export const POST = withAttestBatchToken<{ token: string }>('attest_batch.decide', async (request, ctx) => {
  const { log, requestId } = ctx
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    log.warn('attest batch answer is not JSON', { message: error instanceof Error ? error.message : String(error) })
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { reason: 'invalid_json' } })
  }
  const parsed = DecisionsBody.safeParse(body)
  if (!parsed.success) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { issues: parsed.error.issues.map((i) => i.path.join('.')) } })
  }
  return attestLinkJson(await decideAttestBatch(ctx, parsed.data.decisions))
})

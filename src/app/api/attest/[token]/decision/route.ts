import { z } from 'zod'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ATTEST_COMMENT_MAX } from '@/lib/supplier-invoices/attest-policy'
import { consumeAttestLink } from '@/lib/supplier-invoices/attest-links'
import { attestLinkJson, withAttestLinkToken } from '@/lib/supplier-invoices/attest-link-route'
import { approveSupplierInvoice, rejectSupplierInvoice } from '@/lib/supplier-invoices/attest-service'

const DecisionBody = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().max(ATTEST_COMMENT_MAX).nullish(),
  })
  .strict()

/**
 * POST /api/attest/:token/decision: the attester's Godkänn or Neka from the
 * mail's link, without a login. Runs the same attest service as the
 * dashboard as the attester the link names (source 'email_link'), and
 * consumes the link once the decision is recorded. A refusal (not allowed,
 * already given, no longer waiting) leaves the link as it was.
 */
export const POST = withAttestLinkToken<{ token: string }>('attest_link.decide', async (request, { link, service, op, log, requestId }) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { reason: 'invalid_json' } })
  }
  const parsed = DecisionBody.safeParse(body)
  if (!parsed.success) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { issues: parsed.error.issues.map((i) => i.path.join('.')) } })
  }
  const { decision, comment } = parsed.data

  if (decision === 'approve') {
    const outcome = await approveSupplierInvoice(op, { invoiceId: link.supplier_invoice_id, source: 'email_link', writer: service })
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId, details: outcome.details })
    if (outcome.dryRun) return attestLinkJson(outcome.preview)
    await consumeAttestLink(service, link.id)
    const { approved, attest, invoice } = outcome.data
    return attestLinkJson({
      decision: 'approved',
      attested: approved || !!invoice.approved_at,
      remaining_count: attest.remaining.length,
    })
  }

  const outcome = await rejectSupplierInvoice(op, { invoiceId: link.supplier_invoice_id, comment: comment ?? null, source: 'email_link', writer: service })
  if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId, details: outcome.details })
  if (outcome.dryRun) return attestLinkJson(outcome.preview)
  // The rejection already consumed every open link of the invoice, this one included.
  return attestLinkJson({ decision: 'rejected', attested: false, remaining_count: 0 })
})

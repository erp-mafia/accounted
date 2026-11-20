/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/approve
 *
 * Attests a `registered` or `overdue` supplier invoice as the API key's user.
 * No journal entry is involved in this transition: the registration JE has
 * already been posted (under accrual) or is deferred to :mark-paid (under
 * cash). Idempotent (mandatory Idempotency-Key). Dry-runnable.
 *
 * The company's attest policy decides who may attest
 * (lib/supplier-invoices/attest-service.ts, shared with the dashboard and the
 * approved agent operation): with it on, only its attesters, not the
 * registrant unless the policy allows it, and in mode 'all' the invoice is
 * attested only when every attester has approved. Until then the answer
 * keeps status `registered` (or `overdue`) and `attest.remaining` names who
 * is left.
 *
 * The resulting status is `approved`, or `overdue` when the invoice is still
 * past its due date: 'overdue' is derived state the daily cron owns, and
 * attesting a late payable does not make it on time (#1206).
 *
 * Strict-mode: the database's attest_supplier_invoice locks the invoice and
 * re-reads its state under the lock, so concurrent calls (or a same-key
 * replay racing the first) yield a clean refusal rather than a silent no-op.
 *
 * Levels (#135): an attester may have a limit, and the policy may ask for
 * two attesters from an amount. Through an API key with levels on, the
 * attest is capped by the lower of the key user's limit and the key's
 * unattended ceiling (403 ATTEST_LIMIT_EXCEEDED, reason key_limit).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { approveSupplierInvoice } from '@/lib/supplier-invoices/attest-service'

const SI_RESPONSE_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, status, approved_at, approved_by, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, is_credit_note, registration_journal_entry_id, payment_journal_entry_id, created_at, updated_at'

const SupplierInvoiceApproved = z.object({
  id: z.string().uuid(),
  // 'overdue' when the attested invoice is still past its due date;
  // 'registered' while an attest policy in mode 'all' waits for more attesters.
  status: z.enum(['approved', 'overdue', 'registered']),
  arrival_number: z.number().int(),
  supplier_invoice_number: z.string().nullable(),
  approved_at: z.string().nullable(),
  attest: z.object({
    approved: z.boolean().describe('True when this call attested the invoice (set approved_at).'),
    required: z.boolean().describe('The company\'s attest policy governs this invoice.'),
    remaining_user_ids: z.array(z.string().uuid()).describe('Attesters whose approval is still missing.'),
  }),
})

registerEndpoint({
  operation: 'supplier-invoices.approve',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/approve',
  summary: 'Approve a registered or overdue supplier invoice.',
  description:
    'Attests a supplier invoice that has not been approved yet (status `registered` or `overdue`) as the API key\'s user. With the company\'s attest policy on (GET /supplier-invoices/attest-policy) only its attesters may attest, the registrant not unless the policy allows it, and in mode `all` the invoice is attested only when every attester has approved: until then the status stays and `attest.remaining_user_ids` names who is left. The resulting status is `approved`, or `overdue` when the invoice is still past its due date. No journal entry is posted here: the registration JE was already booked at :create under accrual (or, under defer_invoice_booking, is posted by POST /supplier-invoices/{id}/book), or is deferred to :mark-paid under cash. Idempotent. Dry-runnable.',
  useWhen:
    'A registered SI has been reviewed and you want to mark it ready for payment. With the attest policy on, payments leave an unattested invoice out (attest_required).',
  doNotUseFor:
    'Posting a journal entry (already done at :create under accrual). Paying the SI (use :mark-paid). Re-approving an already-approved SI (returns 400 SI_APPROVE_NOT_REGISTERED).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Returns 400 SI_APPROVE_NOT_REGISTERED when the invoice is already approved (approved_at set) or sits in a settled status. Use the detail endpoint to inspect status first if unsure.',
    'Returns 403 ATTEST_NOT_ALLOWED when the attest policy does not let this user attest the invoice (not an attester, or the registrant), and 409 ATTEST_ALREADY_GIVEN when the user already attested it in this round.',
    'Returns 403 ATTEST_LIMIT_EXCEEDED when the user\'s attest limit does not cover the invoice and their approval cannot count (details.reason limit), or, with attest levels on, when the lower of the user\'s limit and the key\'s unattended ceiling does not cover it (details.reason key_limit). details.limit_sek and details.amount_sek say by how much.',
    'From the policy\'s two_step_from_sek two different attesters must approve: the first approval keeps the status and attest.remaining_user_ids names who may give the second.',
    'A still-past-due invoice comes back with status "overdue", not "approved": approved_at is the attest marker, the status is derived from the due date.',
  ],
  example: {
    response: {
      data: {
        id: '0e9c…',
        status: 'approved',
        arrival_number: 42,
        supplier_invoice_number: '2026-1234',
        approved_at: '2026-10-14T09:00:00.000Z',
        attest: { approved: true, required: true, remaining_user_ids: [] },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(SupplierInvoiceApproved) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'supplier-invoices.approve',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier-invoice id must be a UUID.' },
      })
    }

    const outcome = await approveSupplierInvoice(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
      {
        invoiceId: idParse.data,
        source: 'api',
        dryRun: ctx.dryRun,
        select: SI_RESPONSE_COLUMNS,
        writer: ctx.supabase,
      },
    )
    if (!outcome.ok) {
      if (outcome.error) return v1ErrorResponse(outcome.error, ctx.log, { requestId: ctx.requestId })
      return v1ErrorResponseFromCode(outcome.code, ctx.log, { requestId: ctx.requestId, details: outcome.details })
    }
    if (outcome.dryRun) {
      return dryRunPreview(outcome.preview, { requestId: ctx.requestId, log: ctx.log })
    }
    const { invoice, approved, attest } = outcome.data
    return ok(
      { ...invoice, attest: { approved, required: attest.required, remaining_user_ids: attest.remaining } },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)

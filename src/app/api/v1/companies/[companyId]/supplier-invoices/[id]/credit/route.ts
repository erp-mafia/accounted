/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/credit
 *
 * Issues a credit note (kreditfaktura) for an existing supplier invoice. The
 * rules live in lib/supplier-invoices/credit.ts, shared with the dashboard
 * route and gnubok_credit_supplier_invoice: a credit note row mirroring the
 * whole original, the reversing verifikat on the credit note's date, the
 * original flipped to `credited`, periodisering stopped. Any failure before
 * the original flips rolls the credit note back.
 *
 * The body is optional. With inbox_item_id (a supplier's credit note in the
 * inbox, issue #2980) the credit takes that document's date, number and file
 * and is refused unless the credit note is for the whole invoice.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { CreditSupplierInvoiceInputSchema, creditSupplierInvoice } from '@/lib/supplier-invoices/credit'

const SupplierInvoiceCredited = z.object({
  credit_note_id: z.string().uuid(),
  original_id: z.string().uuid(),
  arrival_number: z.number().int(),
  supplier_invoice_number: z.string(),
  invoice_date: z.string(),
  registration_journal_entry_id: z.string().uuid().nullable(),
  document_id: z.string().uuid().nullable(),
  inbox_item_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'supplier-invoices.credit',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/credit',
  summary: 'Issue a credit note for a supplier invoice.',
  description:
    'Creates a kreditfaktura that reverses the whole original supplier invoice. When the original reached the ledger the reversing JE is posted on the credit note\'s date (Debit 2440 / Credit expense + Credit 2641). The original status flips to `credited`; periodisering schedules on it stop. With inbox_item_id (a supplier\'s credit note in the inbox) the credit note carries that document\'s date, number and file as underlag, and the item is marked handled. Idempotent. Dry-runnable.',
  useWhen:
    'The supplier sent a credit note for a whole registered, approved, partially_paid or paid invoice (pass inbox_item_id when it is in the inbox), or you need to nullify such an invoice (a returned shipment, a vendor dispute resolution). Use dry-run to confirm the totals first.',
  doNotUseFor:
    'A credit note for PART of an invoice (400 SI_CREDIT_PARTIAL: this always reverses the whole invoice). Editing line items on an unchanged invoice (use PATCH on `registered` SIs). Crediting an already-credited SI (409 SI_CREDIT_ALREADY_CREDITED); undo a credit with POST /supplier-invoices/{id}/uncredit.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'The credit note is dated credit_date, else the inbox item\'s credit note date, else today (Stockholm). That date must fall in an open fiscal period: a locked one returns 400 SI_CREDIT_PERIOD_LOCKED and is never re-dated for you.',
    'With inbox_item_id the credit note must be from the invoice\'s supplier and for its whole total in its currency: otherwise 400 SI_CREDIT_PARTIAL or SI_CREDIT_DOCUMENT_MISMATCH (details carry both totals). A credit_date or document date before the invoice date is a 400 VALIDATION_ERROR.',
    'Cash basis (kontantmetoden): an unpaid original gets no reversing JE; recognition waits for the refund. The credit-note row is still created so the AP audit trail stays consistent.',
    'The original SI is flipped to `credited` regardless of how much of it was already paid; reconcile the bank refund via the transactions endpoints.',
  ],
  example: {
    request: { inbox_item_id: '1b2c…' },
    response: {
      data: {
        credit_note_id: '4d2a…',
        original_id: '0e9c…',
        arrival_number: 43,
        supplier_invoice_number: 'K-10045',
        invoice_date: '2026-09-18',
        registration_journal_entry_id: '9c2f…',
        document_id: '4f1c…',
        inbox_item_id: '1b2c…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: CreditSupplierInvoiceInputSchema },
  response: { success: dataEnvelope(SupplierInvoiceCredited) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'supplier-invoices.credit',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier-invoice id must be a UUID.' },
      })
    }

    // Body is optional: an empty POST credits with today's date.
    let rawBody: unknown = {}
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = CreditSupplierInvoiceInputSchema.safeParse(rawBody ?? {})
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const outcome = await creditSupplierInvoice(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
      idParse.data,
      parsed.data,
      { dryRun: ctx.dryRun },
    )
    if (!outcome.ok) {
      if (outcome.error) return v1ErrorResponse(outcome.error, ctx.log, { requestId: ctx.requestId })
      return v1ErrorResponseFromCode(outcome.code, ctx.log, {
        requestId: ctx.requestId,
        details: outcome.messageSv ? { ...(outcome.details ?? {}), reason: outcome.messageSv } : outcome.details,
      })
    }
    if (outcome.dryRun) return dryRunPreview(outcome.preview, { requestId: ctx.requestId, log: ctx.log })

    const creditNote = outcome.data.credit_note
    return ok(
      {
        credit_note_id: creditNote.id,
        original_id: outcome.data.original_id,
        arrival_number: creditNote.arrival_number,
        supplier_invoice_number: creditNote.supplier_invoice_number,
        invoice_date: creditNote.invoice_date,
        registration_journal_entry_id: outcome.data.journal_entry_id,
        document_id: outcome.data.document_id,
        inbox_item_id: outcome.data.inbox_item_id,
      },
      {
        requestId: ctx.requestId,
        ...(outcome.warnings && outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      },
    )
  },
  { requireIdempotencyKey: true },
)

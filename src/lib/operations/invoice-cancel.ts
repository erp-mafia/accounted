/**
 * invoices.cancel: makulera a quote (offert) or a proforma invoice from v1
 * and MCP (accounted#20). Before this operation the step was dashboard-only
 * (POST /api/invoices/[id]/cancel), so an API customer or an agent could
 * create, send and decide a quote but never withdraw it.
 *
 * The rule lives in lib/invoices/cancel-quote-or-proforma.ts, shared with
 * the dashboard route: only a quote or a proforma, the row stays with status
 * 'cancelled', nothing is booked or reversed, and invoice.cancelled records
 * who did it.
 */
import { z } from 'zod'
import { cancelQuoteOrProforma } from '@/lib/invoices/cancel-quote-or-proforma'
import { dbError } from '@/lib/errors/db-error'
import type { Invoice } from '@/types'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const CancelledDocument = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  document_type: z.enum(['quote', 'proforma']),
  status: z.literal('cancelled'),
  /** The customer's decision on a quote, kept as it was; null for a proforma. */
  quote_status: z.enum(['open', 'accepted', 'declined']).nullable(),
  /** True when the document was already cancelled: nothing was written. */
  already_cancelled: z.boolean(),
})

/** What the approver sees: "Makulera offert OF-007". Parts the preview lacks are left out. */
export function cancelQuoteOrProformaTitle(preview?: Record<string, unknown>): string {
  const noun = preview?.document_type === 'proforma' ? 'proformafaktura' : 'offert'
  const number = typeof preview?.invoice_number === 'string' && preview.invoice_number.trim()
    ? ` ${preview.invoice_number.trim()}`
    : ''
  return `Makulera ${noun}${number}`
}

export const invoicesCancel = defineOperation({
  id: 'invoices.cancel',
  kind: 'write',
  scope: 'invoices:write',
  // Nothing reaches the ledger: a quote or proforma carries no verifikat,
  // and the row survives as cancelled. Same tier as cancel_draft_entry.
  risk: 'low',
  // No call un-cancels a document.
  reversible: false,
  docs: {
    summary: 'Cancel (makulera) a quote or a proforma invoice.',
    description:
      'Sets status cancelled on a quote (document_type=quote) or a proforma (document_type=proforma). The document stays, with its number; neither carries a verifikat, so nothing is booked or reversed. The invoice.cancelled event records who cancelled it. A sales invoice is refused: delete a draft (DELETE /invoices/{id}) and credit an issued one (POST /invoices/{id}/credit). Cancelling an already cancelled document answers it unchanged with already_cancelled=true. Idempotent. Dry-runnable.',
    useWhen:
      'A quote will not go ahead (withdrawn, replaced by a new quote) or a proforma will never become an invoice, and the user wants it out of the open documents.',
    doNotUseFor:
      'Recording that the customer declined a quote (POST /invoices/{id}/quote-status with declined keeps it as a decided quote), deleting a draft invoice, or crediting an issued invoice.',
    pitfalls: [
      'Only quotes and proformas: any other document answers 400 INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA with details.documentType.',
      'A quote with live invoices converted from it can still be cancelled: those invoices stay as they are (credit them separately if needed), and a part not yet invoiced can no longer be invoiced from the quote (converting a cancelled quote answers INVOICE_CONVERT_SOURCE_CANCELLED).',
      'A cancelled quote cannot be decided again (quote-status answers INVOICE_QUOTE_NOT_DECIDABLE): create a new quote instead.',
      'A dry run of an already cancelled document answers 409 INVOICE_ALREADY_CANCELLED: there is nothing left to stage.',
      '409 INVOICE_CANCEL_RACE means the document changed between the read and the write (a conversion or another cancel): re-read it before retrying.',
    ],
    example: {
      response: {
        data: {
          id: '0e9c…',
          invoice_number: 'OF-007',
          document_type: 'quote',
          status: 'cancelled',
          quote_status: 'open',
          already_cancelled: false,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    invoice_id: z.string().uuid().describe('The quote or proforma id, from GET /invoices.'),
  }),
  output: CancelledDocument,
  errorCodes: [
    'INVOICE_NOT_FOUND',
    'INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA',
    'INVOICE_ALREADY_CANCELLED',
    'INVOICE_CANCEL_RACE',
    'INTERNAL_ERROR',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/invoices/:id/cancel',
    pathParams: { id: 'invoice_id' },
  },
  mcp: {
    name: 'gnubok_cancel_quote_or_proforma',
    title: 'Cancel Quote or Proforma',
    description:
      'Stage cancelling (makulera) a quote or a proforma invoice: the document stays with status cancelled and nothing is booked. Invoices already converted from a quote stay as they are. Sales invoices are refused: delete a draft, credit an issued one.',
    keywords: ['makulera offert', 'makulera proforma', 'avbryt offert', 'dra tillbaka offert', 'proformafaktura', 'cancel quote', 'void quote'],
    stage: {
      pendingType: 'cancel_quote_or_proforma',
      title: (_input, preview) => cancelQuoteOrProformaTitle(preview),
    },
  },
  run: async (ctx, { invoice_id }, { dryRun }) => {
    const result = await cancelQuoteOrProforma({
      supabase: ctx.supabase,
      companyId: ctx.companyId,
      userId: ctx.userId,
      invoiceId: invoice_id,
      dryRun,
    })
    if (!result.ok) {
      switch (result.code) {
        case 'DB_ERROR':
          return { ok: false, code: 'INTERNAL_ERROR', error: dbError(result.cause) }
        case 'INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA':
          return { ok: false, code: result.code, details: { documentType: result.documentType } }
        default:
          return { ok: false, code: result.code }
      }
    }
    const invoice = result.invoice as Invoice
    if (dryRun) {
      // The dry run is the staging preview: a document that is already
      // cancelled has nothing left to stage.
      if (result.alreadyCancelled) {
        return { ok: false, code: 'INVOICE_ALREADY_CANCELLED', details: { invoice_id } }
      }
      return {
        ok: true,
        dryRun: true,
        preview: {
          invoice_id,
          invoice_number: invoice.invoice_number ?? null,
          document_type: invoice.document_type,
          current_status: invoice.status,
          status: 'cancelled',
          quote_status: invoice.quote_status ?? null,
          invoice_date: invoice.invoice_date,
          total: invoice.total,
          currency: invoice.currency,
        },
      }
    }
    return {
      ok: true,
      data: {
        id: invoice.id,
        invoice_number: invoice.invoice_number ?? null,
        document_type: invoice.document_type as 'quote' | 'proforma',
        status: 'cancelled' as const,
        quote_status: invoice.quote_status ?? null,
        already_cancelled: result.alreadyCancelled,
      },
    }
  },
})

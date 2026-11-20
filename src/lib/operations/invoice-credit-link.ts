/**
 * invoices.link-credit-note: say afterwards which invoice an existing credit
 * note credits (crm#1852). Before this operation no door could: Kreditera
 * always creates a new credit note, so a kreditfaktura that arrived without
 * its reference (imported at a system change) left its original open and
 * overdue in the kundreskontra for good.
 *
 * The rule lives in lib/invoices/link-credit-note.ts: the kundreskontra side
 * of an ordinary credit and nothing else, never a verifikat, and a refusal
 * for every pair an ordinary credit would have booked.
 */
import { z } from 'zod'
import { dbError } from '@/lib/errors/db-error'
import { linkCreditNoteToInvoice } from '@/lib/invoices/link-credit-note'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const LinkedCreditNote = z.object({
  invoice: z.object({
    id: z.string().uuid(),
    invoice_number: z.string().nullable(),
    status: z.literal('credited'),
  }),
  credit_note: z.object({
    id: z.string().uuid(),
    invoice_number: z.string().nullable(),
    status: z.literal('sent'),
    credited_invoice_id: z.string().uuid(),
  }),
  /** The credit note's amount, positive, in the documents' currency. */
  credited_amount: z.number(),
  currency: z.string(),
  /** Always null: the link never books. */
  journal_entry_id: z.null(),
})

const numberOf = (row: Record<string, unknown>): string | null =>
  typeof row.invoice_number === 'string' && row.invoice_number.trim() ? row.invoice_number.trim() : null

/** What the approver sees: "Koppla kreditfaktura 208 till faktura 207". Parts the preview lacks are left out. */
export function linkCreditNoteTitle(preview?: Record<string, unknown>): string {
  const part = (value: unknown) => (typeof value === 'string' && value.trim() ? ` ${value.trim()}` : '')
  return `Koppla kreditfaktura${part(preview?.credit_note_number)} till faktura${part(preview?.invoice_number)}`
}

export const invoicesLinkCreditNote = defineOperation({
  id: 'invoices.link-credit-note',
  kind: 'write',
  scope: 'invoices:write',
  // Nothing reaches the ledger, but the kundreskontra changes: the invoice
  // stops being a claim on the customer.
  risk: 'medium',
  // No call unlinks a credit note.
  reversible: false,
  docs: {
    summary: 'Link an existing credit note to the existing invoice it credits.',
    description:
      'For a credit note (kreditfaktura) that exists without a link to its original, typically one imported at a system change whose reference was only free text: sets the credit note\'s credited_invoice_id, leaves it at status sent (where an issued credit note rests) and moves the invoice to status credited, exactly what POST /invoices/{id}/credit leaves behind in the kundreskontra. The two then net there and the invoice is no longer open or overdue. It never books a verifikat and creates no document. Allowed only where an ordinary credit would not have booked either: kontantmetoden, the invoice issued and unpaid with no verifikat, the credit note with no verifikat, the same customer, the same currency (and rate), and the credit note crediting the whole open amount. Everything else is refused with a code that names the reason. Idempotency: a second call answers 409 INVOICE_CREDIT_LINK_ALREADY_LINKED. Dry-runnable. Emits credit_note.created.',
    useWhen:
      'A fully credited invoice still shows as open or overdue in the kundreskontra because its credit note already exists as a separate document with no link to it (credited_invoice_id is null), and neither document has a verifikat.',
    doNotUseFor:
      'Crediting an invoice that has no credit note yet (POST /invoices/{id}/credit creates and books it), recording a payment, or settling booked invoices against each other.',
    pitfalls: [
      'Never use POST /invoices/{id}/credit for this: it creates a second credit note next to the existing one.',
      '409 INVOICE_CREDIT_LINK_BOOKING_REQUIRED (details.reason) means an ordinary credit would have booked a verifikat that does not exist: accrual_method (faktureringsmetoden), original_paid_or_booked, credit_note_booked, rot_rut or customer_loss_decision. Nothing is booked for you: the entries have to be made in the bookkeeping first, and the link is then not needed for the ledger.',
      '400 INVOICE_CREDIT_LINK_AMOUNT_MISMATCH: details.reason exceeds_open_amount (the credit is larger than what the invoice still asks for) or partial_credit (it is smaller; a partial credit cannot be linked yet). details carries credit_amount and open_amount.',
      '409 INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN: the invoice is a draft, cancelled, already credited (details.status), itself a credit note, or already has a credit note (details.reason).',
      '400 INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE: credit_note_id is not an issued document with a total below zero and nothing refunded on it.',
      'The invoice and the credit note must belong to the same customer and carry the same currency: 400 INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH and INVOICE_CREDIT_LINK_CURRENCY_MISMATCH.',
      '409 INVOICE_CREDIT_LINK_RACE means one of the two changed between the read and the write: re-read both before retrying.',
    ],
    example: {
      request: { credit_note_id: '7b1d…' },
      response: {
        data: {
          invoice: { id: '0e9c…', invoice_number: '207', status: 'credited' },
          credit_note: { id: '7b1d…', invoice_number: '208', status: 'sent', credited_invoice_id: '0e9c…' },
          credited_amount: 12500,
          currency: 'SEK',
          journal_entry_id: null,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    invoice_id: z.string().uuid().describe('The original invoice the credit note credits, from GET /invoices.'),
    credit_note_id: z
      .string()
      .uuid()
      .describe('The existing credit note (a document with a total below zero and no credited_invoice_id).'),
  }),
  output: LinkedCreditNote,
  errorCodes: [
    'INVOICE_NOT_FOUND',
    'INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE',
    'INVOICE_CREDIT_LINK_ALREADY_LINKED',
    'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN',
    'INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH',
    'INVOICE_CREDIT_LINK_CURRENCY_MISMATCH',
    'INVOICE_CREDIT_LINK_BOOKING_REQUIRED',
    'INVOICE_CREDIT_LINK_AMOUNT_MISMATCH',
    'INVOICE_CREDIT_LINK_RACE',
    'INTERNAL_ERROR',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/invoices/:id/link-credit-note',
    pathParams: { id: 'invoice_id' },
  },
  mcp: {
    name: 'gnubok_link_credit_note_to_invoice',
    title: 'Link Credit Note to Invoice',
    description:
      'Stage linking an EXISTING credit note to the EXISTING invoice it credits (one imported without its reference): the invoice becomes credited and leaves the open kundreskontra. Books nothing; refused where an ordinary credit would have booked. Not for creating a credit note.',
    keywords: [
      'koppla kreditfaktura',
      'matcha kreditfaktura',
      'kreditfaktura mot faktura',
      'krediterad faktura förfallen',
      'kundreskontra kreditfaktura',
      'link credit note',
      'apply credit note',
      'match credit note to invoice',
    ],
    stage: {
      pendingType: 'link_credit_note_to_invoice',
      title: (_input, preview) => linkCreditNoteTitle(preview),
    },
  },
  run: async (ctx, { invoice_id, credit_note_id }, { dryRun }) => {
    const result = await linkCreditNoteToInvoice({
      supabase: ctx.supabase,
      companyId: ctx.companyId,
      userId: ctx.userId,
      creditNoteId: credit_note_id,
      invoiceId: invoice_id,
      log: ctx.log,
      dryRun,
    })
    if (!result.ok) {
      if (result.code === 'DB_ERROR') return { ok: false, code: 'INTERNAL_ERROR', error: dbError(result.cause) }
      return { ok: false, code: result.code, details: 'details' in result ? result.details : undefined }
    }
    const { creditNote, original, creditAmount, currency } = result
    if (result.dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          invoice_id,
          invoice_number: numberOf(original),
          invoice_current_status: original.status,
          invoice_status: 'credited',
          credit_note_id,
          credit_note_number: numberOf(creditNote),
          credit_note_current_status: creditNote.status,
          credit_note_status: 'sent',
          credited_amount: creditAmount,
          currency,
          journal_entry: null,
        },
      }
    }
    return {
      ok: true,
      data: {
        invoice: { id: invoice_id, invoice_number: numberOf(original), status: 'credited' as const },
        credit_note: {
          id: credit_note_id,
          invoice_number: numberOf(creditNote),
          status: 'sent' as const,
          credited_invoice_id: invoice_id,
        },
        credited_amount: creditAmount,
        currency,
        journal_entry_id: null,
      },
    }
  },
})

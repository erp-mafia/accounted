/**
 * Underlag behind a customer invoice (accounted#42, phase 1): list, attach
 * and detach archived documents the invoice rests on, such as the
 * wholesaler invoices behind material a contractor invoices onward. The
 * rules live in lib/invoices/invoice-underlag.ts, which the invoice page's
 * session routes call too.
 *
 * A link is a reference: the document keeps its own verifikat link, the
 * link can change in any state of the invoice, and nothing here goes out
 * with the invoice. The files sent with the invoice are its Bilagor
 * (attachment_document_ids on the send endpoints).
 */
import { z } from 'zod'
import {
  MAX_UNDERLAG_PER_CALL,
  attachInvoiceUnderlag,
  detachInvoiceUnderlag,
  listInvoiceUnderlag,
} from '@/lib/invoices/invoice-underlag'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const INVOICE_ID = z.string().uuid().describe('The customer invoice id.')
const DOCUMENT_ID = z.string().uuid().describe('An archived document id (document_id from GET /documents or an upload).')

const UnderlagOut = z.object({
  document_id: z.string().uuid(),
  file_name: z.string(),
  mime_type: z.string().nullable(),
  file_size_bytes: z.number().nullable(),
  journal_entry_id: z
    .string()
    .uuid()
    .nullable()
    .describe('The verifikat the document is underlag of in its own right (a supplier invoice\'s), or null. The link never changes it.'),
  voucher: z.string().nullable().describe('That verifikat\'s number, e.g. "A12".'),
  document_created_at: z.string().nullable().describe('When the document reached the archive.'),
  attached_at: z.string().describe('When it was linked to this invoice.'),
})

const EXAMPLE_UNDERLAG = {
  document_id: '4f1c…',
  file_name: 'dahl-faktura-88412.pdf',
  mime_type: 'application/pdf',
  file_size_bytes: 61204,
  journal_entry_id: '9a7e…',
  voucher: 'B14',
  document_created_at: '2026-10-02T08:12:44Z',
  attached_at: '2026-11-06T13:05:10Z',
}

const SENT_NOTE =
  'Underlag is internal: it is never sent with the invoice. Files that go out with the invoice are its Bilagor (attachment_document_ids on the send endpoints).'

/** The attach body every door takes (the invoice id comes from the path). */
export const AttachInvoiceUnderlagBody = z.object({
  document_ids: z.array(DOCUMENT_ID).min(1).max(MAX_UNDERLAG_PER_CALL).describe('The documents to link, in the order to list them.'),
})

export const invoicesUnderlagList = defineOperation({
  id: 'invoices.underlag.list',
  kind: 'read',
  scope: 'invoices:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the archived documents a customer invoice rests on (its underlag), oldest link first.',
    description: `Each row names the document, its own verifikat (journal_entry_id, voucher) when it has one, and when it was linked. ${SENT_NOTE}`,
    useWhen: 'The end customer asks what an invoiced line rests on, or you need the documents filed behind an invoice.',
    doNotUseFor: 'The files emailed with the invoice (attachment_document_ids on POST /invoices/{id}/send) or a verifikat\'s own underlag (GET /documents?journal_entry_id=).',
    pitfalls: ['Works in every state of the invoice, drafts included.'],
    example: { response: { data: { invoice_id: '1d2e…', underlag: [EXAMPLE_UNDERLAG] }, meta: META } },
  },
  input: z.object({ invoice_id: INVOICE_ID }),
  output: z.object({ invoice_id: z.string().uuid(), underlag: z.array(UnderlagOut) }),
  errorCodes: ['INVOICE_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/invoices/:id/underlag',
    pathParams: { id: 'invoice_id' },
  },
  mcp: {
    name: 'gnubok_list_invoice_underlag',
    title: 'List Invoice Underlag',
    description: 'List the archived documents a customer invoice rests on (e.g. wholesaler invoices behind invoiced material), with each one\'s own verifikat.',
    visibility: 'search',
    keywords: ['underlag till faktura', 'fakturaunderlag', 'materialunderlag', 'grossistfaktura', 'bilagor kundfaktura'],
  },
  run: (ctx, { invoice_id }) => listInvoiceUnderlag(ctx, invoice_id),
})

export const invoicesUnderlagAttach = defineOperation({
  id: 'invoices.underlag.attach',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Link archived documents to a customer invoice as its underlag.',
    description: `Links each document by reference, in any state of the invoice (sent and paid included). The document keeps its own verifikat link: a supplier invoice's underlag stays on the supplier invoice's verifikat. A document already linked stays linked once, so a repeat is harmless. Answers the invoice's whole underlag list. ${SENT_NOTE} Dry-runnable.`,
    useWhen: 'An invoice rests on documents already in the archive: the wholesaler invoices behind invoiced material, a time report, a delivery note. Upload a new file first (POST /documents) and link its id.',
    doNotUseFor: 'Sending files with the invoice (attachment_document_ids on the send endpoints) or making a document a verifikat\'s underlag (POST /documents/{id}/link).',
    pitfalls: [
      'Every document must be a current version in the same company: anything else is 404 INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND with the ids in details.document_ids, and nothing is linked.',
      `At most ${MAX_UNDERLAG_PER_CALL} documents per call and 100 per invoice (400 INVOICE_UNDERLAG_TOO_MANY).`,
    ],
    example: {
      request: { document_ids: ['4f1c…'] },
      response: {
        data: { invoice_id: '1d2e…', attached_document_ids: ['4f1c…'], underlag: [EXAMPLE_UNDERLAG] },
        meta: META,
      },
    },
  },
  input: AttachInvoiceUnderlagBody.extend({ invoice_id: INVOICE_ID }),
  output: z.object({
    invoice_id: z.string().uuid(),
    attached_document_ids: z.array(z.string().uuid()).describe('The documents this call linked; already linked ones are left out.'),
    underlag: z.array(UnderlagOut),
  }),
  errorCodes: ['INVOICE_NOT_FOUND', 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND', 'INVOICE_UNDERLAG_TOO_MANY', 'INVOICE_UNDERLAG_UNAVAILABLE'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/invoices/:id/underlag',
    pathParams: { id: 'invoice_id' },
  },
  mcp: {
    name: 'gnubok_attach_invoice_underlag',
    title: 'Attach Invoice Underlag',
    description:
      'Stage linking archived documents to a customer invoice as its underlag (e.g. wholesaler invoices behind invoiced material). Any invoice state; the documents keep their own verifikat and are not sent to the customer.',
    keywords: ['underlag till faktura', 'koppla underlag faktura', 'materialunderlag', 'grossistfaktura', 'bifoga till kundfaktura'],
    hints: { idempotent: true },
    stage: {
      pendingType: 'attach_invoice_underlag',
      title: (input, preview = {}) => {
        const count = Array.isArray(input.document_ids) ? input.document_ids.length : 0
        const invoice = typeof preview.invoice_number === 'string' ? `faktura ${preview.invoice_number}` : 'fakturautkast'
        return `Lägg till ${count === 1 ? 'underlag' : `${count} underlag`} på ${invoice}`
      },
      extras: (input) => ({
        next: {
          description: 'Once approved, list the invoice\'s underlag to confirm.',
          tool: 'gnubok_list_invoice_underlag',
          args: { invoice_id: input.invoice_id },
        },
      }),
    },
  },
  run: (ctx, input, { dryRun }) => attachInvoiceUnderlag(ctx, input, { dryRun }),
})

export const invoicesUnderlagDetach = defineOperation({
  id: 'invoices.underlag.detach',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Remove one document from a customer invoice\'s underlag.',
    description:
      'Removes only the link, in any state of the invoice: the document stays in the archive and keeps its own verifikat link. Dry-runnable.',
    useWhen: 'A document was linked to the wrong invoice.',
    doNotUseFor: 'Deleting the document (DELETE /documents/{id}) or removing a file the invoice was sent with (fixed once sent).',
    pitfalls: ['A document that is not underlag of the invoice is 404 INVOICE_UNDERLAG_NOT_FOUND.'],
    example: { response: { data: { invoice_id: '1d2e…', document_id: '4f1c…', detached: true }, meta: META } },
  },
  input: z.object({ invoice_id: INVOICE_ID, document_id: DOCUMENT_ID }),
  output: z.object({ invoice_id: z.string().uuid(), document_id: z.string().uuid(), detached: z.literal(true) }),
  errorCodes: ['INVOICE_NOT_FOUND', 'INVOICE_UNDERLAG_NOT_FOUND', 'INVOICE_UNDERLAG_UNAVAILABLE'],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/invoices/:id/underlag/:documentId',
    pathParams: { id: 'invoice_id', documentId: 'document_id' },
  },
  mcp: {
    name: 'gnubok_detach_invoice_underlag',
    title: 'Detach Invoice Underlag',
    description:
      'Stage removing one document from a customer invoice\'s underlag. Only the link goes: the document stays in the archive with its own verifikat.',
    keywords: ['ta bort underlag från faktura', 'koppla bort underlag faktura', 'fel underlag'],
    stage: {
      pendingType: 'detach_invoice_underlag',
      title: (_input, preview = {}) => {
        const file = typeof preview.file_name === 'string' ? `${preview.file_name} ` : ''
        const invoice = typeof preview.invoice_number === 'string' ? `faktura ${preview.invoice_number}` : 'fakturautkast'
        return `Ta bort underlag ${file}från ${invoice}`
      },
    },
  },
  run: (ctx, input, { dryRun }) => detachInvoiceUnderlag(ctx, input, { dryRun }),
})

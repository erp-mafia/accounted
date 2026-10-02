import {
  buildInvoiceWritePayload,
  type DeductionItemFields,
  type SelfBillingCarrierFields,
} from '@/lib/invoices/editor-payload'

/**
 * The request bodies of the editor's live previews (POST
 * /api/invoices/preview-pdf and preview-email), built from the same form
 * values and through the same body builder as the write path, so what the
 * preview prints is what the saved invoice prints. The preview schemas strip
 * the keys they do not render (article links, accounts, dimensions).
 */

export interface QuoteValidityFields {
  document_type: string
  due_date: string
  valid_until?: string
}

/**
 * A quote's "Giltig till" is its own field; the shared schemas still want a
 * due_date, so the wire body mirrors valid_until into it. Other document
 * types never send valid_until (undefined disappears in JSON).
 */
export function withQuoteValidity<T extends QuoteValidityFields>(data: T): T {
  if (data.document_type !== 'quote') return { ...data, valid_until: undefined }
  const validUntil = data.valid_until || data.due_date
  return { ...data, due_date: validUntil, valid_until: validUntil }
}

export interface EditorPreviewOptions {
  /** Öresavrundning (component state, not a form field). */
  oreRounding: boolean
  /** Invoice-level default dimensions. */
  defaultDims: Record<string, string>
  /** The number to print: the predicted next number, or the draft's own. */
  invoiceNumber: string | null
}

export function buildEditorPreviewRequest<
  TItem extends DeductionItemFields & { dimensions?: Record<string, string> | null },
  TForm extends SelfBillingCarrierFields & QuoteValidityFields & {
    items: TItem[]
    payment_cash_account_id?: string
  },
>(values: TForm, options: EditorPreviewOptions) {
  return {
    ...buildInvoiceWritePayload(withQuoteValidity(values), {
      oreRounding: options.oreRounding,
      defaultDims: options.defaultDims,
    }),
    // '' is "the company default" in the form; the preview reads null so.
    payment_cash_account_id: values.payment_cash_account_id || null,
    invoice_number: options.invoiceNumber,
  }
}

/** What the preview-pdf response headers say about the render. */
export interface PdfPreviewMeta {
  pageCount: number | null
  /** X-Invoice-Qr: bank_app, swish, payment_link, or none:<reason>. */
  qr: string | null
  /** X-Invoice-Missing: customer, rows, payee. */
  missing: string[]
  /** X-Invoice-Exchange-Rate on a foreign currency (preliminary on a draft). */
  exchangeRate: number | null
}

export function readPdfPreviewMeta(headers: { get(name: string): string | null }): PdfPreviewMeta {
  const pages = Number(headers.get('X-Invoice-Page-Count'))
  const rate = Number(headers.get('X-Invoice-Exchange-Rate'))
  const missing = headers.get('X-Invoice-Missing')
  return {
    pageCount: Number.isInteger(pages) && pages > 0 ? pages : null,
    qr: headers.get('X-Invoice-Qr'),
    missing: missing ? missing.split(',').map((m) => m.trim()).filter(Boolean) : [],
    exchangeRate: Number.isFinite(rate) && rate > 0 ? rate : null,
  }
}

/**
 * Render a stored invoice as its PDF: the one loader behind the v1 download
 * (GET /api/v1/companies/{companyId}/invoices/{id}/pdf) and the agent's
 * gnubok_get_invoice_pdf (crm#1593). It reads the invoice with its customer
 * and items, the company settings and a credit note's original number, and
 * renders through renderInvoicePdfBuffer, so both surfaces print the same
 * document as the dashboard download.
 *
 * A fresh render reads today's rows. For an invoice Accounted emailed, the
 * file the customer received is the archived delivery
 * (lib/invoices/invoice-pdf-source.ts); callers that can serve that copy do
 * so first and come here only for a re-render.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/cash-accounts/invoice-payment-accounts'
import { INVOICE_PDF_COLUMNS } from '@/lib/api/v1/invoice-columns'
import { invoiceLacksCustomer } from '@/lib/invoices/invoice-customer'
import type { Logger } from '@/lib/logger'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

// The ciphertext is fetched here, for the render only: the template derives
// the masked personnummer (YYYYMMDD-XXXX) in the deduction box from it. It is
// deliberately not part of INVOICE_PDF_COLUMNS, which pins what the API
// projects; nothing that calls this echoes the row.
const PDF_FETCH_SELECT = `
  ${INVOICE_PDF_COLUMNS},
  deduction_personnummer_encrypted,
  customer:customers(*),
  items:invoice_items(*)
`

export type StoredInvoicePdfRefusal =
  | 'NOT_FOUND'
  | 'INVOICE_CUSTOMER_MISSING'
  | 'INVOICE_SEND_COMPANY_SETTINGS_MISSING'
  | 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING'
  | 'INVOICE_PDF_RENDER_FAILED'

export type StoredInvoicePdfResult =
  | { ok: true; buffer: Buffer; filename: string; invoice: Invoice }
  | { ok: false; code: StoredInvoicePdfRefusal; details?: Record<string, unknown> }
  /** The invoice read itself failed: the caller maps the database error. */
  | { ok: false; code: 'DB_ERROR'; error: unknown }

export async function renderStoredInvoicePdf(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  log: Logger,
): Promise<StoredInvoicePdfResult> {
  const { data: invoice, error: fetchErr } = await supabase
    .from('invoices')
    .select(PDF_FETCH_SELECT)
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (fetchErr) return { ok: false, code: 'DB_ERROR', error: fetchErr }
  if (!invoice) {
    log.warn('invoice pdf: not found', { invoiceId, companyId })
    return { ok: false, code: 'NOT_FOUND', details: { resource: 'invoice' } }
  }

  const typed = invoice as unknown as Invoice & {
    customer?: Customer
    items?: InvoiceItem[]
  }

  // No buyer to print (customer deleted, crm#263): refuse instead of a
  // render that throws on the missing customer.
  if (invoiceLacksCustomer(typed)) return { ok: false, code: 'INVOICE_CUSTOMER_MISSING' }

  // company_settings is required by the PDF template (header, bank info,
  // entity-type-driven layout). Select * is intentional: see the rationale
  // in the v1 :send route. Same flat owner-facing config object, no
  // sensitive columns.
  const { data: company, error: companyErr } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle()

  if (companyErr || !company) {
    log.warn('invoice pdf: company settings missing', { invoiceId, companyId })
    return { ok: false, code: 'INVOICE_SEND_COMPANY_SETTINGS_MISSING' }
  }

  if (!hasRequiredInvoicePaymentAccount(company as CompanySettings, typed)) {
    return { ok: false, code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', details: { currency: typed.currency } }
  }

  const items = (typed.items ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)

  // Credit-note back-reference per ML 17 kap 22-23§. Best-effort: if the
  // original invoice was somehow deleted, the PDF template tolerates an
  // undefined value (the back-reference field is omitted from the layout).
  let originalInvoiceNumber: string | undefined
  if (typed.credited_invoice_id) {
    const { data: orig } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('id', typed.credited_invoice_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (orig) {
      originalInvoiceNumber = (orig as { invoice_number?: string }).invoice_number ?? undefined
    }
  }

  let buffer: Buffer
  try {
    // Same render path, so the same QR code, as the dashboard download and
    // the sent file.
    buffer = (
      await renderInvoicePdfBuffer({
        invoice: typed as Invoice,
        customer: typed.customer as Customer,
        items,
        company: company as CompanySettings,
        originalInvoiceNumber,
        paymentAccountRequired: invoiceRequiresPaymentAccount(typed),
      })
    ).buffer
  } catch (err) {
    log.error('invoice pdf: render failed', err as Error, { invoiceId, companyId })
    return { ok: false, code: 'INVOICE_PDF_RENDER_FAILED' }
  }

  const filename = invoicePdfFilename({
    companyName: (company as CompanySettings).company_name,
    customerName: typed.customer?.name,
    invoiceNumber: typed.invoice_number,
    invoiceId,
    invoiceDate: typed.invoice_date,
    documentType: typed.document_type,
    isCreditNote: !!typed.credited_invoice_id,
  })

  return { ok: true, buffer, filename, invoice: typed as Invoice }
}

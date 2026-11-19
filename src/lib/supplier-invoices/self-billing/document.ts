import type { SupabaseClient } from '@supabase/supabase-js'
import type { SelfBillingPdfItem } from './pdf-template'
import { renderSelfBillingPdfBuffer, selfBillingPdfFilename } from './render'
import { readSelfBillingSnapshot } from './snapshot'
import { loadSelfBillingBranding } from './branding'

export type SelfBillingPdfOutcome =
  | { ok: true; buffer: Buffer; filename: string }
  | { ok: false; code: 'SI_NOT_FOUND' | 'SI_SELF_BILL_NOT_SELF_BILLED' | 'SI_SELF_BILL_DOCUMENT_UNAVAILABLE' }

/**
 * The document of a self-billing invoice (or its credit note), rendered from
 * the stored row and its frozen snapshot, so the parties, the agreement and
 * the clause read as they did when it was issued, whatever has changed on the
 * supplier card or in the settings since. The archived copy (the underlag)
 * stays in the document archive. One read behind the dashboard and the v1
 * download (crm#1367).
 */
export async function renderStoredSelfBillingPdf(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceId: string,
): Promise<SelfBillingPdfOutcome> {
  const { data: row, error } = await supabase
    .from('supplier_invoices')
    .select(
      'id, supplier_invoice_number, invoice_date, due_date, delivery_date, currency, subtotal, vat_amount, total, is_credit_note, is_self_billed, self_billing_snapshot, items:supplier_invoice_items(sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount)',
    )
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !row) return { ok: false, code: 'SI_NOT_FOUND' }
  const invoice = row as unknown as {
    supplier_invoice_number: string | null
    invoice_date: string
    due_date: string
    delivery_date: string | null
    currency: string
    subtotal: number
    vat_amount: number
    total: number
    is_credit_note: boolean
    is_self_billed: boolean | null
    self_billing_snapshot: unknown
    items: SelfBillingPdfItem[] | null
  }
  if (!invoice.is_self_billed) return { ok: false, code: 'SI_SELF_BILL_NOT_SELF_BILLED' }
  const snapshot = readSelfBillingSnapshot(invoice.self_billing_snapshot)
  if (!snapshot) return { ok: false, code: 'SI_SELF_BILL_DOCUMENT_UNAVAILABLE' }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('invoice_primary_color, invoice_accent_color, logo_url, invoice_show_logo')
    .eq('company_id', companyId)
    .maybeSingle()

  const buffer = await renderSelfBillingPdfBuffer({
    invoice: {
      supplier_invoice_number: invoice.supplier_invoice_number,
      invoice_date: invoice.invoice_date,
      due_date: invoice.due_date,
      delivery_date: invoice.delivery_date,
      currency: invoice.currency,
      subtotal: Number(invoice.subtotal),
      vat_amount: Number(invoice.vat_amount),
      total: Number(invoice.total),
      is_credit_note: invoice.is_credit_note === true,
    },
    items: (invoice.items ?? []).map((item) => ({
      ...item,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
      line_total: Number(item.line_total),
      vat_rate: Number(item.vat_rate),
      vat_amount: Number(item.vat_amount),
    })),
    snapshot,
    branding: await loadSelfBillingBranding(settings),
  })
  return {
    ok: true,
    buffer,
    filename: selfBillingPdfFilename({
      number: invoice.supplier_invoice_number,
      isCreditNote: invoice.is_credit_note === true,
      sellerName: snapshot.seller.name,
    }),
  }
}

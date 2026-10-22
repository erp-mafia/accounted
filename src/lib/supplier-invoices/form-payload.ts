/**
 * Pure payload builders for the supplier-invoice editor
 * (components/supplier-invoices/NewSupplierInvoiceForm.tsx).
 *
 * Shared with the form component so the wire contract against
 * POST /api/supplier-invoices and the invoice-inbox convert endpoint (both
 * validating CreateSupplierInvoiceSchema) is pinned by unit tests. Selected
 * invoice rounding travels as an ordinary zero-VAT adjustment item.
 */

import { isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { isPersonPayer, type PayerChoice } from '@/lib/expenses/payer'
import { supplierInvoiceEditorAmounts } from './editor-amounts'
import type { StatedRateVat } from '@/lib/vat/document-vat'
import type { SupplierInvoiceReverseChargeKind, VatTreatment } from '@/types'

export interface SupplierInvoiceLineItem {
  description: string
  amount: number
  account_number: string
  vat_rate: number
  // Self-assessed VAT rate for omvänd skattskyldighet (0.25/0.12/0.06). Only
  // meaningful when reverse_charge is on; the line's vat_rate is then 0.
  reverse_charge_rate?: number
  // Periodisering (förutbetald kostnad): both dates + 17xx interim account.
  // Present only while the row's periodisering panel is active.
  accrual_period_start?: string
  accrual_period_end?: string
  accrual_balance_account?: string
  // Per-item dimensions bag ({sie_dim_no: code}, dimensions PR7). Defined
  // (possibly empty) while the row's dimensions panel is open; the server
  // merges it over the invoice's default_dimensions at booking time.
  dimensions?: Record<string, string>
  // Särskild löneskatt på pensionskostnader: booking injects a self-balancing
  // 7533 D / 2514 K pair at 24.26 % of the line amount. Only offered on 741x
  // pension-premium accounts; never changes the invoice total.
  apply_slp?: boolean
}

export interface SupplierInvoiceFormData {
  supplier_id: string
  supplier_invoice_number: string
  invoice_date: string
  due_date: string
  delivery_date: string
  currency: string
  exchange_rate: string
  reverse_charge: boolean
  /**
   * Goods or services, asked only under reverse charge from an EU supplier.
   * Empty until answered: there is no silent default (crm#1323).
   */
  reverse_charge_kind: SupplierInvoiceReverseChargeKind | ''
  payment_reference: string
  notes: string
  /** Vem betalade? Decides the endpoint, the primary action and the credit account. */
  payer: PayerChoice
  /** The owner's name for payer 'owner'; empty means the shared fallback label. */
  claimant_name: string
  /** employees.id for payer 'employee'. */
  employee_id: string
  /**
   * Självfaktura (crm#1367): the company issues the invoice in the
   * supplier's name; the number comes from the company's series, so
   * supplier_invoice_number is not sent. Optional: older callers omit it.
   */
  is_self_billed?: boolean
  items: SupplierInvoiceLineItem[]
}

/**
 * An EU supplier's reverse-charge invoice still waits for goods or services.
 * One predicate for the editor's next-step line and its submit check, so
 * the two always agree.
 */
export function reverseChargeKindMissing(
  data: Pick<SupplierInvoiceFormData, 'reverse_charge' | 'reverse_charge_kind'>,
  euSupplier: boolean,
): boolean {
  return data.reverse_charge && euSupplier && !data.reverse_charge_kind
}

export function inferVatTreatment(
  items: ReadonlyArray<Pick<SupplierInvoiceLineItem, 'vat_rate'>>,
  reverseCharge: boolean,
): VatTreatment {
  if (reverseCharge) return 'reverse_charge'

  const rates = new Set(items.map((i) => i.vat_rate))
  if (rates.size === 1) {
    const rate = rates.values().next().value!
    if (rate === 0.25) return 'standard_25'
    if (rate === 0.12) return 'reduced_12'
    if (rate === 0.06) return 'reduced_6'
    if (rate === 0) return 'exempt'
  }

  return 'standard_25'
}

// AI returns VAT as integer percent (25, 12, 6, 0). The form stores decimals.
export function vatRateFromAi(rate: number | null | undefined): number {
  if (rate == null) return 0.25
  if (rate === 25) return 0.25
  if (rate === 12) return 0.12
  if (rate === 6) return 0.06
  return 0
}

export function rateToPctString(rate: number): string {
  const pct = Math.round(rate * 10000) / 100
  return Number.isFinite(pct) ? String(pct) : ''
}

export interface BuildSupplierInvoicePayloadOptions {
  /** Inbox item being converted; when set the convert endpoint links the document itself. */
  inboxItemId: string | null
  /** Uploaded document to attach on the plain create path (non-inbox only). */
  uploadedDocumentId: string | undefined
  /** Include the invoice's whole-krona rounding as a zero-VAT 3740 item. */
  oreRounding: boolean
  /** Invoice-level default dimensions bag; only sent when non-empty. */
  defaultDims: Record<string, string>
  /** Whether the flow supports periodisering (accrual method, not privately paid, not RC). */
  canUseAccrual: boolean
  /** The supplier is in another EU country: its reverse charge says goods or services. */
  euSupplier: boolean
  /**
   * The invoice's own moms (the Moms field) as its VAT per rate
   * (statedVatFromInvoiceField). Sent as vat_breakdown when the lines take
   * it, so the registration books the moms the invoice states (crm#1367).
   */
  statedVat?: StatedRateVat[] | null
}

/**
 * The Moms field as the invoice's VAT per rate: only when every line that
 * charges moms charges the same rate, so the one figure belongs to one rate.
 * Null under reverse charge (no moms is invoiced) and without a figure.
 */
export function statedVatFromInvoiceField(
  items: ReadonlyArray<Pick<SupplierInvoiceLineItem, 'vat_rate' | 'amount'>>,
  vat: number | null,
  reverseCharge: boolean,
): StatedRateVat[] | null {
  if (reverseCharge || vat == null) return null
  const rates = new Set(items.filter((item) => (item.amount || 0) !== 0 && item.vat_rate > 0).map((item) => item.vat_rate))
  if (rates.size !== 1) return null
  return [{ rate: rates.values().next().value!, vatAmount: vat }]
}

export function buildSupplierInvoicePayload(
  data: SupplierInvoiceFormData,
  opts: BuildSupplierInvoicePayloadOptions,
) {
  const { inboxItemId, uploadedDocumentId, oreRounding, defaultDims, canUseAccrual, euSupplier } = opts
  const vatTreatment = inferVatTreatment(data.items, data.reverse_charge)
  const statedVat = data.reverse_charge ? null : opts.statedVat ?? null
  const { roundingItem, statedVatAccepted } = supplierInvoiceEditorAmounts(
    data.items, data.currency, data.reverse_charge, oreRounding, statedVat,
  )
  const items: SupplierInvoiceLineItem[] = roundingItem ? [...data.items, roundingItem] : data.items
  const paidByPerson = isPersonPayer(data.payer)
  // When paid privately, due_date is irrelevant: but the API still requires
  // a YYYY-MM-DD value. Default to invoice_date so the field passes validation.
  const dueDate = paidByPerson && !data.due_date
    ? data.invoice_date
    : data.due_date
  const selfBilled = data.is_self_billed === true
  return {
    supplier_id: data.supplier_id,
    // A self-billing invoice is our own document: no upload, and its number
    // is drawn from the company's series at registration.
    ...(!inboxItemId && uploadedDocumentId && !selfBilled ? { document_id: uploadedDocumentId } : {}),
    ...(selfBilled ? { is_self_billed: true as const } : { supplier_invoice_number: data.supplier_invoice_number }),
    invoice_date: data.invoice_date,
    // Empty: the server takes invoice_date + the supplier's payment terms.
    due_date: dueDate || undefined,
    delivery_date: data.delivery_date || undefined,
    currency: data.currency,
    exchange_rate: data.exchange_rate ? parseFloat(data.exchange_rate) : undefined,
    vat_treatment: vatTreatment,
    reverse_charge: data.reverse_charge,
    // Goods (ruta 20) or services (ruta 21): only an EU supplier's reverse
    // charge has the choice, and the API refuses it anywhere else.
    ...(data.reverse_charge && euSupplier && data.reverse_charge_kind ? { reverse_charge_kind: data.reverse_charge_kind } : {}),
    payment_reference: data.payment_reference || undefined,
    notes: data.notes || undefined,
    paid_with_private_funds: paidByPerson,
    // Who paid, for the utlägg path: the employee by id, or the owner by the
    // typed name (omitted when blank: the route applies the shared fallback).
    ...(data.payer === 'employee' && data.employee_id ? { employee_id: data.employee_id } : {}),
    ...(data.payer === 'owner' && data.claimant_name.trim() ? { claimant_name: data.claimant_name.trim() } : {}),
    // A privately paid inbox document goes to the core route, which takes the
    // document from the item and settles it (the convert endpoint registers
    // on 2440 only): see supplierInvoiceCreateUrl.
    ...(paidByPerson && inboxItemId ? { inbox_item_id: inboxItemId } : {}),
    ore_rounding: oreRounding,
    // Invoice-level default dimensions (kostnadsställe/projekt): only sent
    // when the user actually picked something.
    ...(Object.keys(defaultDims).length > 0 ? { default_dimensions: defaultDims } : {}),
    // The moms the invoice states, when the lines take it (the editor showed
    // it as the booked moms); otherwise the server books the VAT on the sum.
    ...(statedVat && statedVatAccepted
      ? { vat_breakdown: statedVat.map((entry) => ({ vat_rate: entry.rate, vat_amount: entry.vatAmount })) }
      : {}),
    items: items.map((item) => ({
      description: item.description,
      amount: item.amount,
      account_number: item.account_number,
      // Reverse charge: the supplier charges no VAT, so the line rate is 0 and
      // the self-assessed rate travels on reverse_charge_rate (25% default).
      vat_rate: data.reverse_charge ? 0 : item.vat_rate,
      reverse_charge_rate: data.reverse_charge ? (item.reverse_charge_rate ?? 0.25) : undefined,
      // Periodisering: only sent when the row has a complete period AND the
      // flow supports it (kontantmetod/eget utlägg would be rejected by the
      // API: an AI prefill must never block those submits).
      ...(canUseAccrual && item.accrual_period_start && item.accrual_period_end
        ? {
            accrual_period_start: item.accrual_period_start,
            accrual_period_end: item.accrual_period_end,
            accrual_balance_account: item.accrual_balance_account || undefined,
          }
        : {}),
      // Per-item dimensions override: only when the bag carries values
      // (an open-but-empty panel means "inherit the invoice default").
      ...(item.dimensions && Object.keys(item.dimensions).length > 0
        ? { dimensions: item.dimensions }
        : {}),
      // Särskild löneskatt (SLP): only sent when the opt-in is valid for
      // the row (741x account, no periodisering): a stale flag must never
      // 400 the submit.
      ...(item.apply_slp &&
      isSlpPensionAccount(item.account_number) &&
      !(canUseAccrual && item.accrual_period_start && item.accrual_period_end)
        ? { apply_slp: true }
        : {}),
    })),
  }
}

/**
 * Where the editor posts: the inbox convert endpoint when the invoice came
 * from an inbox item and the company pays or has paid; the core route when a
 * person paid, because only it books an utlägg (the convert endpoint
 * registers on 2440 regardless of who paid).
 */
export function supplierInvoiceCreateUrl(payer: PayerChoice, inboxItemId: string | null): string {
  return inboxItemId && !isPersonPayer(payer)
    ? `/api/extensions/ext/invoice-inbox/items/${inboxItemId}/convert`
    : '/api/supplier-invoices'
}

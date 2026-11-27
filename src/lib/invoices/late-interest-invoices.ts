import type { SupabaseClient } from '@supabase/supabase-js'
import type { Currency, Customer, Invoice } from '@/types'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import { consumerInvoiceTerms } from '@/lib/invoices/consumer-credit'
import { loadInvoiceTerms } from '@/lib/invoices/due-date'
import { isLateInterestChargeable } from '@/lib/invoices/late-interest-chargeable'
import {
  getLatePaymentInterestReport,
  type LatePaidInvoice,
  type LatePaymentInterestReport,
} from '@/lib/invoices/late-payment-interest-report'
import { formatPdfCurrency } from '@/lib/invoices/pdf/format'
import { yourReferenceForNewInvoice } from '@/lib/customers/invoice-reference'
import { invoiceMarkingForNewInvoice } from '@/lib/customers/invoice-marking'
import { invoiceDueDate, todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'

/**
 * Skapa räntefaktura (the Dröjsmålsränta page): one unnumbered invoice draft
 * per customer and currency, charging the dröjsmålsränta of the invoices it
 * names. Nothing is numbered, sent or booked here: the person reviews each
 * draft and sends it like any invoice, and the verifikat is the invoice's own
 * (debit 1510, credit 8313).
 *
 * Only an invoice the report says may be charged (isLateInterestChargeable):
 * paid in full, so its interest is final, and not charged by a räntefaktura
 * already. The interest is the report's, computed today. Each line books
 * 8313 (Ränteintäkter från kortfristiga fordringar) under the outside_scope
 * treatment: dröjsmålsränta is compensation for a late payment, not
 * consideration for a supply, so it carries no VAT and reaches no ruta
 * (ML 8 kap. 2-3 §§). A seller outside the VAT register states no treatment
 * at all; its lines are momsfri like every other line it writes.
 *
 * The draft is marked is_late_interest_invoice, so it earns no dröjsmålsränta
 * of its own and prints no late-payment terms. Each invoice it charges gets
 * late_interest_invoice_id, set only where no räntefaktura holds it (a
 * cancelled one releases it): two clicks at once cannot charge one late
 * payment twice. The loser's draft is deleted, which leaves no gap: it has
 * no number. Deleting a draft frees its invoices (ON DELETE SET NULL).
 */

/** The account the interest is booked on: Ränteintäkter från kortfristiga fordringar. */
export const LATE_INTEREST_ACCOUNT = '8313'

export interface CreatedLateInterestInvoice {
  /** The räntefaktura draft. */
  invoice_id: string
  customer_id: string
  customer_name: string | null
  currency: string
  total: number
  /** The late-paid invoices whose interest it charges. */
  invoice_ids: string[]
}

export interface FailedLateInterestInvoice {
  customer_id: string
  customer_name: string | null
  currency: string
  invoice_ids: string[]
  code: string
  details?: Record<string, unknown>
}

export type CreateLateInterestInvoicesResult =
  | { ok: true; created: CreatedLateInterestInvoice[]; failed: FailedLateInterestInvoice[] }
  | { ok: false; code: string; details?: Record<string, unknown> }
  | { ok: false; dbError: unknown }

type PdfLang = 'sv' | 'en'

/** One line per charged invoice, in the customer's language, so the customer can check the interest. */
export function lateInterestLineText(row: LatePaidInvoice, lang: PdfLang): string {
  const amount = formatPdfCurrency(row.paid_late_amount, row.currency, lang)
  return lang === 'en'
    ? `Late payment interest, invoice ${row.invoice_number} (due ${row.due_date}): ${amount} paid late, last payment ${row.last_payment_date}`
    : `Dröjsmålsränta faktura ${row.invoice_number} (förfallodag ${row.due_date}): ${amount} betalt för sent, sista betalning ${row.last_payment_date}`
}

/** The draft's message: how the interest was computed. */
export function lateInterestNotes(report: Pick<LatePaymentInterestReport, 'rate_is_override'>, lang: PdfLang): string {
  if (lang === 'en') {
    return report.rate_is_override
      ? 'Late payment interest at the agreed rate, from the due date to the payment date of each amount paid late.'
      : "Late payment interest under the Swedish Interest Act (räntelagen): the Riksbank's reference rate plus eight percentage points a year, from the due date to the payment date of each amount paid late."
  }
  return report.rate_is_override
    ? 'Dröjsmålsränta enligt avtalad räntesats, från förfallodagen till betalningsdagen för varje belopp som betalats för sent.'
    : 'Dröjsmålsränta enligt räntelagen: Riksbankens referensränta plus åtta procentenheter per år, från förfallodagen till betalningsdagen för varje belopp som betalats för sent.'
}

export async function createLateInterestInvoices(
  supabase: SupabaseClient,
  params: { companyId: string; userId: string; invoiceIds: string[] },
): Promise<CreateLateInterestInvoicesResult> {
  const { companyId, userId } = params
  const requested = [...new Set(params.invoiceIds)]
  const today = todayIsoStockholm()

  let report: LatePaymentInterestReport
  try {
    report = await getLatePaymentInterestReport(supabase, companyId, today)
  } catch (error) {
    return { ok: false, dbError: error }
  }

  // Exactly what the page offered: every named invoice must still be one the
  // report lets a räntefaktura charge, or nothing is created.
  const rows = new Map(report.paid_late.map((row) => [row.invoice_id, row]))
  const refused = requested.filter((id) => {
    const row = rows.get(id)
    return !row || !row.customer_id || !isLateInterestChargeable(row)
  })
  if (requested.length === 0 || refused.length > 0) {
    return { ok: false, code: 'LATE_INTEREST_NOT_CHARGEABLE', details: { invoice_ids: refused } }
  }

  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('vat_registered')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) return { ok: false, dbError: settingsError }
  const vatRegistered = (settings as { vat_registered?: boolean | null } | null)?.vat_registered !== false

  // One draft per customer and currency: an invoice has one currency.
  const groups = new Map<string, LatePaidInvoice[]>()
  for (const id of requested) {
    const row = rows.get(id) as LatePaidInvoice
    const key = `${row.customer_id}\u0000${row.currency}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const created: CreatedLateInterestInvoice[] = []
  const failed: FailedLateInterestInvoice[] = []
  for (const groupRows of groups.values()) {
    const outcome = await createOneDraft(supabase, { companyId, userId, today, vatRegistered, report, rows: groupRows })
    if ('dbError' in outcome) return { ok: false, dbError: outcome.dbError }
    if (outcome.ok) created.push(outcome.created)
    else {
      failed.push({
        customer_id: groupRows[0].customer_id as string,
        customer_name: groupRows[0].customer_name,
        currency: groupRows[0].currency,
        invoice_ids: groupRows.map((row) => row.invoice_id),
        code: outcome.code,
        ...(outcome.details ? { details: outcome.details } : {}),
      })
    }
  }
  return { ok: true, created, failed }
}

type DraftOutcome =
  | { ok: true; created: CreatedLateInterestInvoice }
  | { ok: false; code: string; details?: Record<string, unknown> }
  | { ok: false; dbError: unknown }

async function createOneDraft(
  supabase: SupabaseClient,
  ctx: {
    companyId: string
    userId: string
    today: string
    vatRegistered: boolean
    report: LatePaymentInterestReport
    rows: LatePaidInvoice[]
  },
): Promise<DraftOutcome> {
  const { companyId, userId, today, rows } = ctx
  const customerId = rows[0].customer_id as string
  const currency = rows[0].currency

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle<Customer>()
  if (customerError) return { ok: false, dbError: customerError }
  if (!customer) return { ok: false, code: 'INVOICE_CUSTOMER_NOT_FOUND', details: { customerId } }

  const lang: PdfLang = customer.language === 'en' ? 'en' : 'sv'
  let dueDate: string
  try {
    const terms = await loadInvoiceTerms(supabase, companyId, customer.default_payment_terms)
    dueDate = invoiceDueDate(today, consumerInvoiceTerms(terms, customer.customer_type, today))
  } catch (error) {
    return { ok: false, dbError: error }
  }

  const items: InvoiceWriteInput['items'] = rows.map((row) => ({
    line_type: 'product',
    description: lateInterestLineText(row, lang),
    quantity: 1,
    unit: 'st',
    unit_price: row.interest,
    vat_rate: 0,
    revenue_account: LATE_INTEREST_ACCOUNT,
  }))

  const build = await buildInvoiceWriteData({
    supabase,
    companyId,
    customer,
    documentType: 'invoice',
    input: {
      customer_id: customer.id,
      invoice_date: today,
      due_date: dueDate,
      currency: currency as Currency,
      your_reference: yourReferenceForNewInvoice(null, customer) ?? undefined,
      invoice_marking: invoiceMarkingForNewInvoice(null, customer) ?? undefined,
      notes: lateInterestNotes(ctx.report, lang),
      ...(ctx.vatRegistered ? { vat_treatment: 'outside_scope' as const, delivery_country: null } : {}),
      items,
    },
  })
  if (!build.ok) {
    if ('dbError' in build) return { ok: false, dbError: build.dbError }
    return { ok: false, code: build.code, ...(build.details ? { details: build.details } : {}) }
  }
  // Never book a foreign amount 1:1 as kronor (as convertToInvoice and the
  // order path): the builder leaves the rate null when Riksbanken has none.
  if (currency !== 'SEK' && build.invoiceFields.exchange_rate == null) {
    return { ok: false, code: 'LATE_INTEREST_FX_RATE_UNAVAILABLE', details: { currency } }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_number: null,
      status: 'draft',
      is_late_interest_invoice: true,
      ...build.invoiceFields,
    })
    .select('id, total')
    .single<Pick<Invoice, 'id' | 'total'>>()
  if (invoiceError || !invoice) return { ok: false, dbError: invoiceError ?? new Error('invoice insert returned no row') }

  const discard = async () => {
    // Unnumbered draft: deleting it leaves no gap in the series, and
    // ON DELETE SET NULL releases any invoice it had claimed.
    await supabase.from('invoice_items').delete().eq('invoice_id', invoice.id)
    await supabase.from('invoices').delete().eq('id', invoice.id).eq('company_id', companyId).eq('status', 'draft')
  }

  const { error: itemsError } = await supabase
    .from('invoice_items')
    .insert(build.items.map((item) => ({ ...item, invoice_id: invoice.id })))
  if (itemsError) {
    await discard()
    return { ok: false, dbError: itemsError }
  }

  // Claim the charged invoices, only where no räntefaktura holds them: a
  // link to a cancelled one is released, any other link means someone else
  // charged it first.
  const ids = rows.map((row) => row.invoice_id)
  const { data: links, error: linksError } = await supabase
    .from('invoices')
    .select('id, late_interest_invoice_id')
    .eq('company_id', companyId)
    .in('id', ids)
  if (linksError) {
    await discard()
    return { ok: false, dbError: linksError }
  }
  const linked = [
    ...new Set(
      ((links ?? []) as Array<{ late_interest_invoice_id: string | null }>)
        .map((link) => link.late_interest_invoice_id)
        .filter((id): id is string => !!id),
    ),
  ]
  // A stored link is released only by a cancelled räntefaktura. A link to
  // any other (a draft another click made since the report was read) is a
  // claim that stands, so the update below matches fewer rows and this
  // draft goes.
  let released: string[] = []
  if (linked.length > 0) {
    const { data: targets, error: targetsError } = await supabase
      .from('invoices')
      .select('id, status')
      .eq('company_id', companyId)
      .in('id', linked)
    if (targetsError) {
      await discard()
      return { ok: false, dbError: targetsError }
    }
    released = ((targets ?? []) as Array<{ id: string; status: string }>)
      .filter((target) => target.status === 'cancelled')
      .map((target) => target.id)
  }
  let claim = supabase
    .from('invoices')
    .update({ late_interest_invoice_id: invoice.id })
    .eq('company_id', companyId)
    .in('id', ids)
  claim = released.length > 0
    ? claim.or(`late_interest_invoice_id.is.null,late_interest_invoice_id.in.(${released.join(',')})`)
    : claim.is('late_interest_invoice_id', null)
  const { data: claimed, error: claimError } = await claim.select('id')
  if (claimError || (claimed ?? []).length !== ids.length) {
    await discard()
    if (claimError) return { ok: false, dbError: claimError }
    return { ok: false, code: 'LATE_INTEREST_ALREADY_CHARGED', details: { invoice_ids: ids } }
  }

  return {
    ok: true,
    created: {
      invoice_id: invoice.id,
      customer_id: customer.id,
      customer_name: customer.name ?? null,
      currency,
      total: roundOre(Number(invoice.total)),
      invoice_ids: ids,
    },
  }
}

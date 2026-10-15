import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { ensureInvoiceNumber, InvoiceNumberSeriesBehindError } from '@/lib/invoices/ensure-invoice-number'
import { convertToSEK, fetchExchangeRate } from '@/lib/currency/riksbanken'
import {
  buildQuotePartLines,
  quotePartNote,
  quotePartTotals,
  resolveQuotePart,
  type QuoteConversion,
  type QuoteInvoicePart,
  type QuoteSourceLine,
} from '@/lib/invoices/quote-partial-invoice'
import type { Invoice } from '@/types'

/**
 * Convert a proforma or a quote (offert) into a real invoice.
 *
 * ONE implementation for every caller (the dashboard route, the MCP staged
 * commit, v1): the proforma conversion used to exist twice and had drifted
 * (one copy dropped per-line VAT and revenue accounts, the other dropped
 * discounts and fakturamarkning). Both now flow through here.
 *
 * Source handling differs by document type:
 *   - proforma: the source is marked cancelled (it was a pre-invoice for the
 *     same sale) and its due_date is carried over.
 *   - quote: the source stays, flips to quote_status = 'accepted', and the
 *     invoice links back via converted_from_id. A quote has no due date, so
 *     the invoice gets invoice_date + the customer's payment terms (falling
 *     back to company_settings.invoice_default_days, then 30). A quote can
 *     be invoiced in parts (crm#1196, lib/invoices/quote-partial-invoice.ts):
 *     `part` bills a percent or a net amount of it, and without `part` the
 *     conversion bills everything not yet invoiced (the whole quote, copied
 *     line for line, the first time). A conversion is refused once the live
 *     invoices from the quote cover it, or while a live kundorder was
 *     created from the quote (invoice from the order instead); a declined
 *     quote must be re-accepted first.
 *
 * Ordering: ensureInvoiceNumber() is the LAST side effect. The F-series
 * counter only advances after items are inserted and the source is updated,
 * so a partial failure in any earlier step rolls back the orphan row without
 * leaking a number (ML 17 kap 24 paragraph: gap-free lopnummer).
 */

export type ConvertToInvoiceFailureCode =
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_CONVERT_NOT_CONVERTIBLE'
  | 'INVOICE_CONVERT_SOURCE_CANCELLED'
  | 'INVOICE_CONVERT_SOURCE_CHANGED'
  | 'INVOICE_CONVERT_QUOTE_DECLINED'
  | 'INVOICE_QUOTE_ALREADY_INVOICED'
  | 'INVOICE_QUOTE_ALREADY_ORDERED'
  | 'INVOICE_QUOTE_PART_OUT_OF_RANGE'
  | 'INVOICE_CONVERT_PART_QUOTE_ONLY'

export type ConvertToInvoiceResult =
  | { ok: true; invoice: Invoice }
  /** details: the quote's progress when a part does not fit (quote_subtotal, invoiced, remaining, requested). */
  | { ok: false; code: ConvertToInvoiceFailureCode; details?: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_CONVERT_FAILED'; cause: Error | { message: string } }
  /** The series already has a higher number: nothing was used up, the source is restored. */
  | {
      ok: false
      code: 'INVOICE_NUMBER_SERIES_BEHIND'
      messageSv: string
      messageEn: string
      details: Record<string, unknown>
    }

type SourceItem = QuoteSourceLine

type SourceRow = Invoice & {
  items?: SourceItem[] | null
  customer?: { default_payment_terms?: number | null; language?: string | null } | null
}

const DEFAULT_PAYMENT_TERMS_DAYS = 30

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return isoDate(d)
}

export async function convertToInvoice(params: {
  supabase: SupabaseClient
  userId: string
  companyId: string
  sourceId: string
  /** Quotes only: the part to invoice. Absent: everything not yet invoiced. */
  part?: QuoteInvoicePart | null
}): Promise<ConvertToInvoiceResult> {
  const { supabase, userId, companyId, sourceId, part } = params

  const { data: sourceRaw, error: sourceError } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*), customer:customers(default_payment_terms, language)')
    .eq('id', sourceId)
    .eq('company_id', companyId)
    .single()

  if (sourceError || !sourceRaw) {
    return { ok: false, code: 'INVOICE_NOT_FOUND' }
  }
  const source = sourceRaw as SourceRow
  const isQuote = source.document_type === 'quote'

  if (source.document_type !== 'proforma' && !isQuote) {
    return { ok: false, code: 'INVOICE_CONVERT_NOT_CONVERTIBLE' }
  }
  // A proforma is the invoice-to-be for the whole sale and is cancelled by
  // its conversion: there is nothing left to bill a second part from.
  if (part && !isQuote) {
    return { ok: false, code: 'INVOICE_CONVERT_PART_QUOTE_ONLY' }
  }
  if (source.status === 'cancelled') {
    return { ok: false, code: 'INVOICE_CONVERT_SOURCE_CANCELLED' }
  }

  const today = isoDate(new Date())
  let dueDate: string = source.due_date
  let conversions: QuoteConversion[] = []
  let quotePart: { amount: number; rest: boolean; invoicedBefore: number } | null = null

  if (isQuote) {
    if (source.quote_status === 'declined') {
      return { ok: false, code: 'INVOICE_CONVERT_QUOTE_DECLINED' }
    }

    // What the live invoices from this quote already bill (crm#1196). A
    // cancelled converted invoice counts for nothing and frees its part.
    const { data: conversionRows, error: conversionsError } = await supabase
      .from('invoices')
      .select('id, status, subtotal, items:invoice_items(line_type, line_total, vat_rate, revenue_account, article_id, dimensions)')
      .eq('company_id', companyId)
      .eq('converted_from_id', sourceId)
      .neq('status', 'cancelled')
    if (conversionsError) {
      return { ok: false, code: 'INVOICE_CONVERT_FAILED', cause: conversionsError }
    }
    conversions = (conversionRows ?? []) as QuoteConversion[]
    const resolved = resolveQuotePart(source, conversions, part)
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.code,
        details: {
          quote_subtotal: resolved.progress.quoteSubtotal,
          invoiced: resolved.progress.invoiced,
          remaining: resolved.progress.remaining,
          ...(resolved.code === 'INVOICE_QUOTE_PART_OUT_OF_RANGE' ? { requested: resolved.requested } : {}),
        },
      }
    }
    // The first conversion of the whole quote copies it line for line, as it
    // always has; anything else is a part invoice.
    if (!(resolved.rest && resolved.progress.invoiceCount === 0)) {
      quotePart = { amount: resolved.amount, rest: resolved.rest, invoicedBefore: resolved.progress.invoiced }
    }

    // A quote that became a kundorder is invoiced from the order (full or
    // partial deliveries), never a second time from the quote. A cancelled
    // order frees the quote again. Mirror of convertToSalesOrder's guard.
    const { count: liveOrders, error: ordersError } = await supabase
      .from('sales_orders')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('source_invoice_id', sourceId)
      .neq('status', 'cancelled')
    if (ordersError) {
      return { ok: false, code: 'INVOICE_CONVERT_FAILED', cause: ordersError }
    }
    if ((liveOrders ?? 0) > 0) {
      return { ok: false, code: 'INVOICE_QUOTE_ALREADY_ORDERED' }
    }

    // 0 days is a real term (due on receipt); only a missing value falls
    // through to the company default and then to 30.
    let termsDays: number | null = source.customer?.default_payment_terms ?? null
    if (termsDays == null) {
      const { data: settings, error: settingsError } = await supabase
        .from('company_settings')
        .select('invoice_default_days')
        .eq('company_id', companyId)
        .maybeSingle()
      // A failed read must not silently become "30 days": that would date
      // the receivable wrong. Only a successful empty result falls back.
      if (settingsError) {
        return { ok: false, code: 'INVOICE_CONVERT_FAILED', cause: settingsError }
      }
      termsDays = (settings as { invoice_default_days?: number | null } | null)?.invoice_default_days ?? null
    }
    dueDate = addDays(today, termsDays ?? DEFAULT_PAYMENT_TERMS_DAYS)
  }

  // What the invoice bills: the source line for line, or a part of the
  // quote (its lines each billing their share, crm#1196). The note on a part
  // says which quote and how much of it, on the PDF and in Peppol alike.
  const partLines = quotePart
    ? buildQuotePartLines({
        lines: source.items ?? [],
        amount: quotePart.amount,
        rest: quotePart.rest,
        conversions,
      })
    : null
  const amounts = partLines
    ? quotePartTotals(partLines)
    : { subtotal: source.subtotal, vat_amount: source.vat_amount, total: source.total }
  const notes = quotePart
    ? [
        quotePartNote({
          language: source.customer?.language === 'en' ? 'en' : 'sv',
          quoteNumber: source.invoice_number ?? null,
          quoteSubtotal: source.subtotal,
          amount: amounts.subtotal,
          invoicedBefore: quotePart.invoicedBefore,
          currency: source.currency,
        }),
        source.notes,
      ]
        .filter(Boolean)
        .join('\n\n')
    : source.notes

  // The invoice is a new taxable event dated today (ML 8 kap 21-23 §): a
  // quote can sit for weeks, so the SEK twins must use today's rate, not
  // the one stamped when the offer was written. Fail closed if no rate can
  // be had (the create paths refuse a NULL rate for the same reason).
  let exchangeRate = source.exchange_rate
  let exchangeRateDate = source.exchange_rate_date
  // A SEK part carries its own amounts as the SEK twins, as the invoice
  // builder stores them; a whole copy keeps the source's.
  let subtotalSek = partLines ? amounts.subtotal : source.subtotal_sek
  let vatAmountSek = partLines ? amounts.vat_amount : source.vat_amount_sek
  let totalSek = partLines ? amounts.total : source.total_sek
  if (source.currency !== 'SEK') {
    const rate = await fetchExchangeRate(source.currency, new Date(`${today}T00:00:00Z`), supabase)
    if (!rate) {
      return {
        ok: false,
        code: 'INVOICE_CONVERT_FAILED',
        cause: { message: `Exchange rate for ${source.currency} unavailable; try again later` },
      }
    }
    exchangeRate = rate.rate
    exchangeRateDate = rate.date
    subtotalSek = convertToSEK(amounts.subtotal, rate.rate)
    vatAmountSek = convertToSEK(amounts.vat_amount, rate.rate)
    totalSek = convertToSEK(amounts.total, rate.rate)
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: source.customer_id,
      invoice_number: null,
      invoice_date: today,
      due_date: dueDate,
      currency: source.currency,
      exchange_rate: exchangeRate,
      exchange_rate_date: exchangeRateDate,
      subtotal: amounts.subtotal,
      subtotal_sek: subtotalSek,
      vat_amount: amounts.vat_amount,
      vat_amount_sek: vatAmountSek,
      total: amounts.total,
      total_sek: totalSek,
      // The converted invoice is a fresh unpaid receivable: proformas and
      // quotes carry no ROT/RUT deduction, so the customer owes the full
      // total. Omitting this left the NOT NULL DEFAULT 0, which every payment
      // surface reads as "nothing open".
      remaining_amount: amounts.total,
      paid_amount: 0,
      vat_treatment: source.vat_treatment,
      vat_rate: source.vat_rate,
      moms_ruta: source.moms_ruta,
      reverse_charge_text: source.reverse_charge_text,
      // What the source stated about its own supply (#2906) travels with the
      // header it produced, so the draft's re-derivations keep it.
      vat_treatment_override: source.vat_treatment_override ?? null,
      delivery_country: source.delivery_country ?? null,
      your_reference: source.your_reference,
      our_reference: source.our_reference,
      // Buyer routing survives conversion (Peppol BT-10 may rely on it alone).
      invoice_marking: source.invoice_marking ?? null,
      notes,
      document_type: 'invoice',
      converted_from_id: sourceId,
      // Quote-only columns must not travel: the CHECK pairs quote_status
      // with document_type = 'quote'.
      valid_until: null,
      quote_status: null,
      quote_decided_at: null,
      // Dimensions PR7: the converted invoice books with the source's bag.
      default_dimensions: source.default_dimensions ?? {},
    })
    .select()
    .single()

  if (invoiceError) {
    // invoices_converted_source_guard (migration 20261015120000) serializes
    // conversions on the source row and refuses what a concurrent one made
    // impossible: a second invoice from a proforma, a part past what remains
    // of a quote, or any invoice while a kundorder from the quote is live.
    // 23505 is the unique index the guard replaced, for a deploy that runs
    // ahead of the migration.
    const message = String((invoiceError as { message?: string }).message ?? '')
    for (const code of [
      'INVOICE_QUOTE_ALREADY_ORDERED',
      'INVOICE_QUOTE_ALREADY_INVOICED',
      'INVOICE_QUOTE_PART_OUT_OF_RANGE',
      'INVOICE_CONVERT_SOURCE_CHANGED',
    ] as const) {
      if (message.includes(code)) return { ok: false, code }
    }
    if ((invoiceError as { code?: string }).code === '23505') {
      return { ok: false, code: isQuote ? 'INVOICE_QUOTE_ALREADY_INVOICED' : 'INVOICE_CONVERT_SOURCE_CHANGED' }
    }
    return { ok: false, code: 'INVOICE_CONVERT_FAILED', cause: invoiceError }
  }

  const items = (partLines ?? source.items ?? []).map((item) => ({
    invoice_id: invoice.id,
    sort_order: item.sort_order,
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    // The stored line_total is net of this; dropping it would make the
    // converted invoice fail the Peppol line check and lose the rebate on
    // the next builder pass.
    discount_percent: item.discount_percent ?? 0,
    line_total: item.line_total,
    // Per-line VAT and any article / revenue-account override travel too, so
    // the invoice books exactly as the source showed (mixed rates and
    // per-article accounts both rely on these).
    vat_rate: item.vat_rate ?? 0,
    vat_amount: item.vat_amount ?? 0,
    revenue_account: item.revenue_account ?? null,
    article_id: item.article_id ?? null,
    // The article number the source printed, frozen on its line (crm#1084).
    article_number: item.article_number ?? null,
    // A kundorder link on a proforma line moves to the invoice, so the order
    // keeps counting the quantity as invoiced once the proforma is cancelled.
    sales_order_item_id: item.sales_order_item_id ?? null,
    dimensions: item.dimensions ?? {},
  }))

  if (items.length > 0) {
    const { error: itemsError } = await supabase.from('invoice_items').insert(items)
    if (itemsError) {
      await supabase.from('invoices').delete().eq('id', invoice.id)
      return { ok: false, code: 'INVOICE_CONVERT_FAILED', cause: itemsError }
    }
  }

  // Update the source. If this fails, the new (still unnumbered) invoice is
  // an orphan: delete it so the user can retry without ending up with two
  // active invoices for the same source. invoice_items cascade.
  const previousSource = {
    status: source.status,
    quote_status: source.quote_status ?? null,
    quote_decided_at: source.quote_decided_at ?? null,
  }
  // Literal payloads on purpose: the phantom-column schema guard
  // (tests/schema/no-phantom-columns.test.ts) can only check object literals.
  // Compare-and-set on the state read above: a concurrent cancel, a
  // concurrent proforma-to-order conversion (which cancels the proforma) or
  // a concurrent decision on the quote turns this into a 0-row update, and
  // the orphan invoice is removed instead of a second document for the
  // same sale surviving.
  const { data: sourceRows, error: sourceUpdateError } = isQuote
    ? await supabase
        .from('invoices')
        .update({
          quote_status: 'accepted',
          quote_decided_at: source.quote_decided_at ?? new Date().toISOString(),
        })
        .eq('id', sourceId)
        .eq('quote_status', source.quote_status)
        .neq('status', 'cancelled')
        .select('id')
    : await supabase
        .from('invoices')
        .update({ status: 'cancelled' })
        .eq('id', sourceId)
        .neq('status', 'cancelled')
        .select('id')

  if (sourceUpdateError) {
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return { ok: false, code: 'INVOICE_CONVERT_FAILED', cause: sourceUpdateError }
  }
  if (!sourceRows || sourceRows.length === 0) {
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return { ok: false, code: 'INVOICE_CONVERT_SOURCE_CHANGED' }
  }

  // Allocate the F-series number last. If allocation fails, restore the
  // source and delete the orphan invoice. The F-counter is unaffected because
  // generate_invoice_number only commits on success.
  try {
    await ensureInvoiceNumber(supabase, companyId, invoice as Invoice)
  } catch (err) {
    if (isQuote) {
      await supabase
        .from('invoices')
        .update({
          quote_status: previousSource.quote_status,
          quote_decided_at: previousSource.quote_decided_at,
        })
        .eq('id', sourceId)
    } else {
      await supabase
        .from('invoices')
        .update({ status: previousSource.status })
        .eq('id', sourceId)
    }
    await supabase.from('invoices').delete().eq('id', invoice.id)
    if (err instanceof InvoiceNumberSeriesBehindError) {
      return {
        ok: false,
        code: err.code,
        messageSv: err.message,
        messageEn: err.messageEn,
        details: { ...err.details },
      }
    }
    return {
      ok: false,
      code: 'INVOICE_CONVERT_FAILED',
      cause: err instanceof Error ? err : { message: 'Failed to assign invoice number' },
    }
  }

  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .single()

  const result = (completeInvoice ?? invoice) as Invoice

  if (completeInvoice) {
    await eventBus.emit({
      type: 'invoice.created',
      payload: { invoice: result, companyId, userId },
    })
  }

  return { ok: true, invoice: result }
}

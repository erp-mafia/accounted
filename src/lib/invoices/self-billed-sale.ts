/**
 * Received self-billing invoice (mottagen självfaktura, ML 17 kap 15§).
 *
 * A self-billing invoice we RECEIVE is a SALE for us: the customer issued the
 * document on our behalf, so for our books it is an ordinary customer invoice
 * (Debit 1510, Credit 30xx + 26xx) and the output VAT lands in our
 * momsdeklaration. It differs from a normal customer invoice in two ways:
 *   - We never assign a number from our own series (BFL 5 kap 6§): the
 *     counterparty's number lives in external_invoice_number and our own
 *     invoice_number stays null (enforced by invoices_self_billed_numbering).
 *   - There is no send step: under faktureringsmetoden it is booked on
 *     registration; under kontantmetoden it stays unbooked until payment.
 *
 * Shared by the dashboard, v1 invoice creation and approval of MCP proposals.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { getVatRules, getPermittedVatRates } from '@/lib/invoices/vat-rules'
import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { eventBus } from '@/lib/events'
import { selfBilledSaleAmounts } from '@/lib/invoices/self-billed-amounts'
import type { DocumentVatMismatch } from '@/lib/vat/document-vat'
import { createLogger } from '@/lib/logger'
import { linkBasisColumns } from '@/lib/links/stamp'
import type { Invoice } from '@/types'
import { requireAccountingMethod } from '@/lib/company/accounting-method'

const log = createLogger('self-billed-sale')

export interface SelfBilledSaleItemInput {
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate?: number
}

export interface SelfBilledSaleInput {
  customer_id: string
  external_invoice_number: string
  self_billing_agreement_ref?: string | null
  invoice_date: string
  received_date: string
  due_date: string
  currency: string
  notes?: string | null
  items: SelfBilledSaleItemInput[]
  /**
   * The VAT per rate the customer's document states, rates in percent like
   * the items. Omitted: the VAT on the summed base per rate.
   */
  vat_breakdown?: Array<{ vat_rate: number; vat_amount: number }> | null
}

interface SelfBilledSaleReview {
  totalSek: number
  postsOnApproval: boolean
}

export type SelfBilledSaleFailure =
  | { code: 'duplicate' }
  | { code: 'review_changed' }
  | { code: 'customer_not_found'; customerId: string }
  | { code: 'vat_rule_violation'; attemptedRate: number; allowedRates: number[]; customerType: string }
  | { code: 'fx_rate_unavailable'; currency: string; invoiceDate: string }
  | { code: 'insert_failed'; stage?: string; pgCode?: string; pgMessage?: string }
  | { code: 'items_failed'; pgCode?: string; pgMessage?: string }
  | { code: 'no_fiscal_period' }
  | { code: 'vat_breakdown_mismatch'; details: DocumentVatMismatch['details'] }

interface SelfBilledCustomer {
  id: string
  name: string
  customer_type: string
  vat_number_validated: boolean | null
  /** ISO 3166-1 alpha-2; gates reverse charge together with the two above. */
  country?: string | null
}

export interface SelfBilledSaleComputedItem {
  sort_order: number
  description: string
  quantity: number
  unit: string
  unit_price: number
  line_total: number
  vat_rate: number
  vat_amount: number
}

export interface SelfBilledSaleDraft {
  customer: SelfBilledCustomer
  items: SelfBilledSaleComputedItem[]
  subtotal: number
  vatAmount: number
  total: number
  subtotalSek: number | null
  vatAmountSek: number | null
  totalSek: number | null
  exchangeRate: number | null
  exchangeRateDate: string | null
  currency: string
  vatTreatment: string
  momsRuta: string | null
  reverseChargeText: string | null
  vatRate: number | null
}

/**
 * Validate + cost a received self-billing invoice. No writes, no number
 * consumption. Used for the dry-run preview and by createSelfBilledSaleInvoice.
 */
export async function resolveSelfBilledSaleDraft(
  supabase: SupabaseClient,
  companyId: string,
  input: SelfBilledSaleInput,
): Promise<{ ok: true; draft: SelfBilledSaleDraft } | { ok: false; failure: SelfBilledSaleFailure }> {
  // The issuer of a self-billing invoice is, in our books, the customer we sold
  // to. Require an existing customer so VAT rules + reporting work. Project only
  // the fields used (data minimisation).
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, name, customer_type, vat_number_validated, country')
    .eq('id', input.customer_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (customerError || !customer) {
    return { ok: false, failure: { code: 'customer_not_found', customerId: input.customer_id } }
  }
  const c = customer as SelfBilledCustomer

  // VAT treatment is driven by who the customer is (domestic / EU reverse charge
  // / export), exactly like an own-issued invoice.
  const vatRules = getVatRules(
    c.customer_type as Parameters<typeof getVatRules>[0],
    c.vat_number_validated ?? undefined,
    c.country,
  )
  // Gate on the PERMITTED set, not the picker default, exactly like
  // buildInvoiceWriteData: the ML 6 kap. supplies taxed where they are performed
  // (hotel/restaurang 12%, persontransport and event admission 6%,
  // fastighetstjänst and korttidsuthyrning 25%) carry Swedish VAT even to a
  // foreign business customer, and a self-bill transcribes what the customer
  // actually invoiced in our name. The default is still 0% (vatRules.rate is the
  // fallback below), so a Swedish rate only lands here when the line carried it.
  const permittedRates = getPermittedVatRates(
    c.customer_type as Parameters<typeof getPermittedVatRates>[0],
    c.vat_number_validated ?? undefined,
    c.country,
  )
  const allowedRates = new Set(permittedRates.map((r) => r.rate))

  for (const item of input.items) {
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    if (!allowedRates.has(itemRate)) {
      return {
        ok: false,
        failure: {
          code: 'vat_rule_violation',
          attemptedRate: itemRate,
          allowedRates: Array.from(allowedRates),
          customerType: c.customer_type,
        },
      }
    }
  }

  // Whole-öre line nets, and the customer's document's VAT per rate: on the
  // summed base, or the figure the document states (vat_breakdown), spread
  // over the lines. Per-line rounding left the receivable an öre or more off
  // the document on every multi-line self-bill (crm#1367). The editor's
  // Summering computes the same figures (lib/invoices/self-billed-amounts.ts).
  const amounts = selfBilledSaleAmounts(input.items, vatRules.rate, input.vat_breakdown)
  if (!amounts.ok) {
    return { ok: false, failure: { code: 'vat_breakdown_mismatch', details: amounts.details } }
  }
  const items: SelfBilledSaleComputedItem[] = input.items.map((item, i) => ({
    sort_order: i,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    ...amounts.lines[i],
  }))
  const { subtotal, vatAmount, total } = amounts

  const uniqueRates = new Set(input.items.map((item) => item.vat_rate ?? vatRules.rate))
  const isMixedRate = uniqueRates.size > 1
  const vatRate = isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate)

  // Foreign currency: convert using the rate on the INVOICE date (ML 7 kap 7§),
  // not today's rate. Refuse rather than fall through to a silent 1:1 booking.
  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null
  let subtotalSek: number | null = null
  let vatAmountSek: number | null = null
  let totalSek: number | null = null
  if (input.currency !== 'SEK') {
    const rateData = await fetchExchangeRate(
      input.currency as Parameters<typeof fetchExchangeRate>[0],
      new Date(input.invoice_date),
    )
    if (!rateData) {
      return { ok: false, failure: { code: 'fx_rate_unavailable', currency: input.currency, invoiceDate: input.invoice_date } }
    }
    exchangeRate = rateData.rate
    exchangeRateDate = rateData.date
    subtotalSek = sekOfForeign(subtotal, exchangeRate)
    vatAmountSek = sekOfForeign(vatAmount, exchangeRate)
    totalSek = sekOfForeign(total, exchangeRate)
  }

  return {
    ok: true,
    draft: {
      customer: c,
      items,
      subtotal,
      vatAmount,
      total,
      subtotalSek,
      vatAmountSek,
      totalSek,
      exchangeRate,
      exchangeRateDate,
      currency: input.currency,
      vatTreatment: vatRules.treatment,
      momsRuta: vatRules.momsRuta,
      reverseChargeText: vatRules.reverseChargeText || null,
      vatRate,
    },
  }
}

/**
 * Register a received self-billing invoice: insert the row, its items, and
 * (under faktureringsmetoden) book the registration entry. Rolls back on any
 * failure. Returns the created invoice or a structured failure. Re-throws an
 * unexpected booking error (e.g. a period-lock trigger) after rolling back so
 * the caller can map it to its structured envelope.
 */
export async function createSelfBilledSaleInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: SelfBilledSaleInput,
  review?: SelfBilledSaleReview,
): Promise<{ ok: true; invoice: Invoice } | { ok: false; failure: SelfBilledSaleFailure }> {
  const resolved = await resolveSelfBilledSaleDraft(supabase, companyId, input)
  if (!resolved.ok) return resolved
  const { draft } = resolved

  // The approval gate priced the preview. Check the exact amount that this
  // draft will store, before any writes, so a fresh FX rate cannot change it.
  if (review && (draft.totalSek ?? draft.total) !== review.totalSek) {
    return { ok: false, failure: { code: 'review_changed' } }
  }

  const settingsRead = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const accountingMethod = requireAccountingMethod(settingsRead)
  if (review && (accountingMethod === 'accrual') !== review.postsOnApproval) {
    return { ok: false, failure: { code: 'review_changed' } }
  }
  const entityType = await resolveCompanyEntityType(supabase, companyId, settingsRead.data?.entity_type)

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      customer_id: input.customer_id,
      // No own number: the counterparty's number lives in external_invoice_number.
      invoice_number: null,
      is_self_billed: true,
      external_invoice_number: input.external_invoice_number,
      self_billing_agreement_ref: input.self_billing_agreement_ref ?? null,
      received_date: input.received_date,
      invoice_date: input.invoice_date,
      due_date: input.due_date,
      // Booked + awaiting/with payment: never a draft.
      status: 'sent',
      currency: input.currency,
      exchange_rate: draft.exchangeRate,
      exchange_rate_date: draft.exchangeRateDate,
      subtotal: draft.subtotal,
      subtotal_sek: draft.subtotalSek,
      vat_amount: draft.vatAmount,
      vat_amount_sek: draft.vatAmountSek,
      total: draft.total,
      total_sek: draft.totalSek,
      remaining_amount: draft.total,
      vat_treatment: draft.vatTreatment,
      vat_rate: draft.vatRate,
      moms_ruta: draft.momsRuta,
      reverse_charge_text: draft.reverseChargeText,
      notes: input.notes,
      document_type: 'invoice',
    })
    .select()
    .single()

  if (invoiceError || !invoice) {
    if (invoiceError?.code === '23505' && invoiceError.message.includes('idx_invoices_self_billed_number')) {
      return { ok: false, failure: { code: 'duplicate' } }
    }
    log.error('self-billed invoice insert failed', invoiceError as Error)
    return {
      ok: false,
      failure: { code: 'insert_failed', pgCode: invoiceError?.code, pgMessage: invoiceError?.message },
    }
  }

  const itemRows = draft.items.map((item) => ({
    invoice_id: invoice.id,
    sort_order: item.sort_order,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: item.line_total,
    vat_rate: item.vat_rate,
    vat_amount: item.vat_amount,
  }))

  const { error: itemsError } = await supabase.from('invoice_items').insert(itemRows)
  if (itemsError) {
    // Items insert failed: remove the orphaned invoice header.
    await supabase.from('invoices').delete().eq('id', invoice.id)
    log.error('self-billed invoice items insert failed; rolled back', itemsError, { invoiceId: invoice.id })
    return { ok: false, failure: { code: 'items_failed', pgCode: itemsError.code, pgMessage: itemsError.message } }
  }

  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .maybeSingle()

  // Faktureringsmetoden: book the registration entry now (Debit 1510, Credit
  // 30xx + 26xx). Kontantmetoden: leave unbooked until payment.
  if (accountingMethod === 'accrual') {
    if (!completeInvoice) {
      await supabase.from('invoices').delete().eq('id', invoice.id)
      log.error('self-billed invoice re-fetch returned no row before booking; rolled back', undefined, {
        invoiceId: invoice.id,
      })
      return { ok: false, failure: { code: 'insert_failed', stage: 'refetch_before_booking' } }
    }
    try {
      const journalEntry = await createInvoiceJournalEntry(
        supabase,
        companyId,
        userId,
        completeInvoice as Invoice,
        entityType,
        draft.customer.name,
        {
          descriptionPrefix: 'Självfaktura',
          numberOverride: input.external_invoice_number,
          // The posting port's event, while POSTING_EVENTS is on: the person
          // (or the API client) registered the received självfaktura.
          posting: () => ({ linkBasis: linkBasisColumns('user_created') }),
        },
      )
      if (!journalEntry) {
        // No open fiscal period: roll back so we never leave an unbooked sale.
        await supabase.from('invoices').delete().eq('id', invoice.id)
        return { ok: false, failure: { code: 'no_fiscal_period' } }
      }
      const { error: linkError } = await supabase
        .from('invoices')
        .update({ journal_entry_id: journalEntry.id })
        .eq('id', invoice.id)
        .eq('company_id', companyId)
      if (linkError) {
        // The verifikat is committed (immutable): don't roll it back over a
        // failed convenience link. Log loudly.
        log.error('self-billed invoice booked but journal_entry_id link failed', linkError, {
          invoiceId: invoice.id,
          journalEntryId: journalEntry.id,
        })
      }
    } catch (err) {
      await supabase.from('invoices').delete().eq('id', invoice.id)
      log.error('failed to book self-billed invoice; rolled back', err as Error, { invoiceId: invoice.id })
      throw err
    }
  }

  const { data: finalInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .maybeSingle()

  const responseInvoice = (finalInvoice ?? completeInvoice ?? invoice) as Invoice

  await eventBus.emit({
    type: 'invoice.created',
    payload: { invoice: responseInvoice, companyId, userId },
  })

  return { ok: true, invoice: responseInvoice }
}

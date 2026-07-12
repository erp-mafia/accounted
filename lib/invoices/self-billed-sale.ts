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
 * This is the single implementation behind both the internal dashboard route
 * (/api/invoices/self-billed) and the public v1 invoice create endpoint (which
 * accepts an optional is_self_billed flag), so the two can never drift.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { eventBus } from '@/lib/events'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'
import type { EntityType, Invoice } from '@/types'

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
}

export type SelfBilledSaleFailure =
  | { code: 'customer_not_found'; customerId: string }
  | { code: 'vat_rule_violation'; attemptedRate: number; allowedRates: number[]; customerType: string }
  | { code: 'fx_rate_unavailable'; currency: string; invoiceDate: string }
  | { code: 'insert_failed'; stage?: string; pgCode?: string; pgMessage?: string }
  | { code: 'items_failed'; pgCode?: string; pgMessage?: string }
  | { code: 'no_fiscal_period' }

interface SelfBilledCustomer {
  id: string
  name: string
  customer_type: string
  vat_number_validated: boolean | null
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
    .select('id, name, customer_type, vat_number_validated')
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
  )
  const availableRates = getAvailableVatRates(
    c.customer_type as Parameters<typeof getAvailableVatRates>[0],
    c.vat_number_validated ?? undefined,
  )
  const allowedRates = new Set(availableRates.map((r) => r.rate))

  const items: SelfBilledSaleComputedItem[] = []
  let vatAmount = 0
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i]
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
    const lineTotal = item.quantity * item.unit_price
    const lineVat = roundOre((lineTotal * itemRate) / 100)
    vatAmount += lineVat
    items.push({
      sort_order: i,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: lineVat,
    })
  }

  const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
  const total = roundOre(subtotal + vatAmount)

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
    subtotalSek = convertToSEK(subtotal, exchangeRate)
    vatAmountSek = convertToSEK(vatAmount, exchangeRate)
    totalSek = convertToSEK(total, exchangeRate)
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
): Promise<{ ok: true; invoice: Invoice } | { ok: false; failure: SelfBilledSaleFailure }> {
  const resolved = await resolveSelfBilledSaleDraft(supabase, companyId, input)
  if (!resolved.ok) return resolved
  const { draft } = resolved

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

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const accountingMethod = settings?.accounting_method || 'accrual'
  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

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
        { descriptionPrefix: 'Självfaktura', numberOverride: input.external_invoice_number },
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

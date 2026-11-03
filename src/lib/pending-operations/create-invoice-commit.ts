/**
 * The write of a staged create_invoice: the shared build (buildStagedInvoice,
 * so buildInvoiceWriteData with every rule the web and v1 doors apply), the
 * payee choice, the invoice and item rows, and invoice.created.
 *
 * Lifted out of commit.ts so a second staged door that ends in a draft
 * invoice (time-entries.invoice) writes through this one function instead of
 * a copy: commitPendingOperation's create_invoice case calls it unchanged.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { resolveInvoicePayeeChoice } from '@/lib/invoices/invoice-payee'
import { roundOre } from '@/lib/money'
import { buildStagedInvoice } from '@/lib/pending-operations/build-staged-invoice'
import type { Customer, Invoice } from '@/types'

/** Same shape as commit.ts ExecutorResult, which this result is returned as. */
export type CreateInvoiceCommitResult = {
  data?: Record<string, unknown>
  error?: string
  errorCode?: string
  status?: number
}

export async function createInvoiceFromStagedParams(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>
): Promise<CreateInvoiceCommitResult> {
  const customerId = typeof params.customer_id === 'string' ? params.customer_id : ''
  const { data: customer, error: customerError } = await supabase
    .from('customers').select('*').eq('id', customerId).eq('company_id', companyId).single()

  if (customerError || !customer) {
    return { error: 'Customer not found: they may have been deleted.', status: 404 }
  }

  // The same build the staging preview ran (buildStagedInvoice): the shared
  // buildInvoiceWriteData with every rule the web and v1 doors apply (VAT
  // gate, balance-sheet account on a VAT line, ROT/RUT, accrual, articles,
  // currency), so what the approver saw is what gets written.
  const staged = await buildStagedInvoice({ supabase, companyId, customer: customer as Customer, params })
  if (!staged.ok) {
    if ('validation' in staged) {
      const issue = staged.validation.issues[0]
      return {
        error: `Invalid ${issue?.path?.join('.') || 'params'}: ${issue?.message ?? 'validation failed'}`,
        status: 400,
      }
    }
    if ('dbError' in staged) {
      const message = (staged.dbError as { message?: string } | null)?.message
      return { error: message ?? 'Database error', status: 500 }
    }
    const entry = getErrorEntry(staged.code)
    return {
      error: entry?.message_sv ?? staged.code,
      errorCode: staged.code,
      status: entry?.httpStatus ?? 400,
      data: staged.details as Record<string, unknown> | undefined,
    }
  }
  const { isQuote, build } = staged
  const { invoiceFields } = build

  // Refuse at the approval boundary rather than store exchange_rate NULL:
  // createInvoiceJournalEntry() refuses such an invoice with
  // INVOICE_FX_RATE_MISSING anyway, by which point the invoice row (and its
  // F-series number, once sent) exists and the approver has moved on. A NULL
  // rate is booked 1:1 otherwise: 1000 EUR to 3001 as 1000 kr, understating
  // ruta 05 and ruta 10 by the whole FX difference.
  if (
    invoiceFields.currency !== 'SEK' &&
    !(typeof invoiceFields.exchange_rate === 'number' && Number.isFinite(invoiceFields.exchange_rate) && invoiceFields.exchange_rate > 0)
  ) {
    return {
      error:
        getErrorEntry('INVOICE_FX_RATE_MISSING')?.message_sv ??
        'Fakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs.',
      status: 400,
    }
  }

  // Quotes are numbered at insert from their own OF-series (see
  // generate_quote_number); ensureInvoiceNumber must never run on one.
  let quoteNumber: string | null = null
  if (isQuote) {
    const { data: allocated, error: quoteNumberError } = await supabase.rpc('generate_quote_number', {
      p_company_id: companyId,
    })
    if (quoteNumberError || !allocated) {
      return {
        error:
          getErrorEntry('INVOICE_CREATE_NUMBER_ASSIGN_FAILED')?.message_sv ??
          'Offertnumret kunde inte tilldelas.',
        errorCode: 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED',
        status: 500,
      }
    }
    quoteNumber = allocated as string
  }

  // Which bank account the customer pays to; validated against the
  // company's payee accounts (same rule as the web and v1 routes).
  const payeeChoice = await resolveInvoicePayeeChoice(
    supabase,
    companyId,
    invoiceFields.currency,
    staged.params.payment_cash_account_id ?? null,
  )
  if (!payeeChoice.ok) {
    const entry = getErrorEntry(payeeChoice.code)
    return { error: entry?.message_sv ?? payeeChoice.code, status: 400, data: payeeChoice.details }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_number: quoteNumber,
      ...invoiceFields,
      // This door has always stored the SEK twins rounded to whole öre.
      subtotal_sek: invoiceFields.subtotal_sek === null ? null : roundOre(invoiceFields.subtotal_sek),
      vat_amount_sek: invoiceFields.vat_amount_sek === null ? null : roundOre(invoiceFields.vat_amount_sek),
      total_sek: invoiceFields.total_sek === null ? null : roundOre(invoiceFields.total_sek),
      // Explicit keys, not a conditional spread: the phantom-column guard
      // only reads literal payloads. NULL on non-quotes satisfies the pairing CHECK.
      quote_status: isQuote ? 'open' : null,
      paid_amount: 0,
      payment_cash_account_id: payeeChoice.fields.payment_cash_account_id,
      payment_details: payeeChoice.fields.payment_details,
    })
    .select()
    .single()

  if (invoiceError) return { error: invoiceError.message, status: 500 }

  const { error: itemsError } = await supabase
    .from('invoice_items')
    .insert(build.items.map((row) => ({ ...row, invoice_id: invoice.id })))

  if (itemsError) {
    await supabase.from('invoices').delete().eq('id', invoice.id)
    return { error: itemsError.message, status: 500 }
  }

  // invoice.created is for real invoices only: a quote is an offer, not a
  // claim, and has no downstream consumer obligation (v1 route parity).
  if (!isQuote) {
    const { data: completeInvoice } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice.id)
      .single()

    if (completeInvoice) {
      await eventBus.emit({
        type: 'invoice.created',
        payload: { invoice: completeInvoice as Invoice, userId, companyId },
      })
    }
  }

  return {
    data: {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number ?? quoteNumber,
      // Why the treatment is what it is (#2749, #2558): echoed so an agent
      // that auto-approved still sees what preview.vat_warnings said.
      ...(build.warnings.length > 0 ? { vat_warnings: build.warnings } : {}),
    },
  }
}

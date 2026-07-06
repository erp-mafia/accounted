import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { CreateSelfBillingInvoiceSchema } from '@/lib/api/schemas'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { roundOre } from '@/lib/money'
import type { EntityType, Invoice } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/self-billed
 *
 * Register a self-billing invoice we RECEIVED (mottagen självfaktura, ML 17 kap
 * 15§). The customer issued the invoice on our behalf; for us it is a sale, so
 * it books exactly like a customer invoice (Debit 1510, Credit 30xx + 26xx) and
 * the output VAT lands in our momsdeklaration.
 *
 * It differs from a normal customer invoice in two ways:
 *   - We do NOT assign a number from our own series: the counterparty's number
 *     is stored in external_invoice_number and our invoice_number stays null
 *     (BFL 5 kap 6§). Enforced by the invoices_self_billed_numbering constraint.
 *   - There is no send step. Under faktureringsmetoden (accrual) we book the
 *     registration entry here. Under kontantmetoden (cash) we leave it unbooked
 *     until payment (identical to a normal invoice) and the existing mark-paid
 *     flow books the cash entry then.
 *
 * Payment is handled by the existing flows: the row is created with status
 * 'sent', so "Markera som betald" / bank matching work unchanged.
 */
export const POST = withRouteContext(
  'invoice.self_billed.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', type: 'validation_error' },
        { status: 400 },
      )
    }

    const parsed = CreateSelfBillingInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) {
      log.warn('self-billed invoice validation failed', { issueCount: parsed.error.issues.length })
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message, code: i.code })),
        },
        { status: 400 },
      )
    }
    const input = parsed.data

    // The issuer of a self-billing invoice is, in our books, the customer we
    // sold to. Require an existing customer row so VAT rules + reporting work.
    // Project only the fields used below (data minimisation, GDPR Art. 25 /
    // SOC 2 CC6.3): VAT treatment derivation and the verifikat description.
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id, name, customer_type, vat_number_validated')
      .eq('id', input.customer_id)
      .eq('company_id', companyId!)
      .single()

    if (customerError || !customer) {
      return errorResponseFromCode('INVOICE_CUSTOMER_NOT_FOUND', log, {
        requestId,
        details: { customerId: input.customer_id },
      })
    }

    // VAT treatment is driven by who the customer is (domestic / EU reverse
    // charge / export), exactly like an own-issued invoice.
    const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
    const availableRates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
    const allowedRates = new Set(availableRates.map((r) => r.rate))

    let vatAmount = 0
    for (const item of input.items) {
      const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
      if (!allowedRates.has(itemRate)) {
        return errorResponseFromCode('INVOICE_CREATE_VAT_RULE_VIOLATION', log, {
          requestId,
          details: {
            attemptedRate: itemRate,
            allowedRates: Array.from(allowedRates),
            customerType: customer.customer_type,
          },
        })
      }
      const lineTotal = item.quantity * item.unit_price
      vatAmount += roundOre((lineTotal * itemRate) / 100)
    }

    const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
    const total = roundOre(subtotal + vatAmount)

    const uniqueRates = new Set(input.items.map((item) => item.vat_rate ?? vatRules.rate))
    const isMixedRate = uniqueRates.size > 1

    // Foreign currency: convert using the rate on the INVOICE date (ML 7 kap 7§),
    // not today's rate.
    let exchangeRate: number | null = null
    let exchangeRateDate: string | null = null
    let subtotalSek: number | null = null
    let vatAmountSek: number | null = null
    let totalSek: number | null = null
    if (input.currency !== 'SEK') {
      const rateData = await fetchExchangeRate(input.currency, new Date(input.invoice_date))
      if (!rateData) {
        // No FX rate for the invoice date: refuse rather than letting the
        // booking fall through to resolveSekAmount's legacy 1:1 fallback, which
        // would treat e.g. 1 000 USD as 1 000 SEK and commit a balanced but
        // silently wrong-magnitude verifikat. ML 7 kap 7§ requires the
        // invoice-date rate; we never substitute today's. The user can retry
        // once the rate is published.
        log.warn('self-billed invoice rejected: no FX rate for invoice date', {
          currency: input.currency,
          invoiceDate: input.invoice_date,
        })
        return NextResponse.json(
          {
            error: `Kunde inte hämta växelkurs för ${input.currency} på fakturadatumet (${input.invoice_date}). Försök igen senare.`,
            type: 'validation_error',
          },
          { status: 400 },
        )
      }
      exchangeRate = rateData.rate
      exchangeRateDate = rateData.date
      subtotalSek = convertToSEK(subtotal, exchangeRate)
      vatAmountSek = convertToSEK(vatAmount, exchangeRate)
      totalSek = convertToSEK(total, exchangeRate)
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .insert({
        user_id: user.id,
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
        // Booked + awaiting/with payment: never a draft, so it shows in the AR
        // ledger and is payable via the existing mark-paid / matching flows.
        status: 'sent',
        currency: input.currency,
        exchange_rate: exchangeRate,
        exchange_rate_date: exchangeRateDate,
        subtotal,
        subtotal_sek: subtotalSek,
        vat_amount: vatAmount,
        vat_amount_sek: vatAmountSek,
        total,
        total_sek: totalSek,
        remaining_amount: total,
        vat_treatment: vatRules.treatment,
        vat_rate: isMixedRate ? null : (uniqueRates.values().next().value ?? vatRules.rate),
        moms_ruta: vatRules.momsRuta,
        reverse_charge_text: vatRules.reverseChargeText || null,
        notes: input.notes,
        document_type: 'invoice',
      })
      .select()
      .single()

    if (invoiceError || !invoice) {
      log.error('self-billed invoice insert failed', invoiceError)
      return errorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', log, {
        requestId,
        details: { pgCode: invoiceError?.code, pgMessage: invoiceError?.message },
      })
    }

    const items = input.items.map((item, index) => {
      const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
      const lineTotal = item.quantity * item.unit_price
      return {
        invoice_id: invoice.id,
        sort_order: index,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        line_total: lineTotal,
        vat_rate: itemRate,
        vat_amount: roundOre((lineTotal * itemRate) / 100),
      }
    })

    const { error: itemsError } = await supabase.from('invoice_items').insert(items)
    if (itemsError) {
      // The item insert failed, so nothing was written there: just remove the
      // orphaned invoice header.
      await supabase.from('invoices').delete().eq('id', invoice.id)
      log.error('self-billed invoice items insert failed; rolled back', itemsError, { invoiceId: invoice.id })
      return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', log, {
        requestId,
        details: { pgCode: itemsError.code, pgMessage: itemsError.message },
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId!)
      .single()
    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    const { data: completeInvoice } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice.id)
      .single()

    // Faktureringsmetoden: book the registration entry now (Debit 1510, Credit
    // 30xx + 26xx). Kontantmetoden: leave unbooked until payment, exactly like a
    // normal invoice: the mark-paid flow books the cash entry then.
    if (accountingMethod === 'accrual') {
      if (!completeInvoice) {
        // The row was inserted but the re-fetch came back empty (transient DB
        // issue). Roll back rather than crash on a null cast inside the engine,
        // and surface it as a fetch failure, not an opaque booking error.
        await supabase.from('invoices').delete().eq('id', invoice.id)
        log.error('self-billed invoice re-fetch returned no row before booking; rolled back', undefined, {
          invoiceId: invoice.id,
        })
        return errorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', log, {
          requestId,
          details: { stage: 'refetch_before_booking' },
        })
      }
      try {
        const journalEntry = await createInvoiceJournalEntry(
          supabase,
          companyId!,
          user.id,
          completeInvoice as Invoice,
          entityType,
          customer.name,
          { descriptionPrefix: 'Självfaktura', numberOverride: input.external_invoice_number },
        )
        if (!journalEntry) {
          // No open fiscal period for the invoice date: roll the row back so we
          // never leave an unbooked self-billing sale sitting as 'sent'.
          await supabase.from('invoices').delete().eq('id', invoice.id)
          return NextResponse.json(
            { error: 'Ingen öppen bokföringsperiod för fakturadatumet', type: 'validation_error' },
            { status: 400 },
          )
        }
        const { error: linkError } = await supabase
          .from('invoices')
          .update({ journal_entry_id: journalEntry.id })
          .eq('id', invoice.id)
          .eq('company_id', companyId!)
        if (linkError) {
          // The verifikat is already committed (immutable): don't roll it back
          // over a failed convenience link. Log loudly: this is the exact write
          // that silently no-ops if the journal_entry_id column is ever missing
          // again (it was absent in prod for months before 20260613100000).
          log.error('self-billed invoice booked but journal_entry_id link failed', linkError, {
            invoiceId: invoice.id,
            journalEntryId: journalEntry.id,
          })
        }
      } catch (err) {
        await supabase.from('invoices').delete().eq('id', invoice.id)
        log.error('failed to book self-billed invoice; rolled back', err as Error, { invoiceId: invoice.id })
        return errorResponse(err, log, { requestId })
      }
    }

    const { data: finalInvoice } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice.id)
      .single()

    // The invoice is committed (and, under accrual, booked) by this point. If the
    // final re-fetch comes back empty under transient load, fall back to the
    // shapes we already hold so the 200 always carries a usable id; otherwise
    // the client's redirect to /invoices/{id} would throw on a null result.
    const responseInvoice = (finalInvoice ?? completeInvoice ?? invoice) as Invoice

    await eventBus.emit({
      type: 'invoice.created',
      payload: { invoice: responseInvoice, companyId: companyId!, userId: user.id },
    })

    return NextResponse.json({ data: responseInvoice })
  },
  { requireWrite: true },
)

/**
 * Registering a supplier invoice (leverantörsfaktura): the one implementation
 * behind every door that creates one from a request body, i.e. the dashboard
 * route (POST /api/supplier-invoices) and the v1 REST route
 * (POST /api/v1/companies/:companyId/supplier-invoices).
 *
 * The two routes used to carry a copy each, and the copies drifted: the v1
 * copy validated `document_id`, `inbox_item_id`, `paid_with_private_funds`,
 * `employee_id`, `payment_date`, `ore_rounding` and the periodisering fields
 * through the shared schema and then dropped them, so an API caller's
 * underlag never reached the invoice, while the dashboard copy lacked the
 * v1 guards (reverse charge and exempt treatments carrying moms, the
 * structured period-lock answer, archived suppliers). One function now owns
 * every rule; a door only translates the result into its own envelope.
 *
 * Returns a result instead of an HTTP response so the doors can keep their
 * own error envelopes (the dashboard's `{ error }` shape, v1's
 * `{ error: { code, ... } }`) while sharing the codes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import { eventBus } from '@/lib/events'
import {
  createSupplierInvoiceRegistrationEntry,
  buildSupplierInvoicePrivatelyPaidLines,
  largestExpenseAccount,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { buildSupplierDescription } from '@/lib/bookkeeping/supplier-invoice-description'
import { registerExpenseClaim } from '@/lib/expenses/expense-claims-service'
import { ownerFallbackName, resolveExpenseLiabilityAccount } from '@/lib/expenses/payer'
import { createSchedulesForSupplierInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { suggestBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import type { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'
import { roundOre } from '@/lib/money'
import {
  defaultVatRateForTreatment,
  treatmentDeductsInputVat,
} from '@/lib/vat/supplier-invoice-line-checks'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { parseEntityType } from '@/lib/company/entity-type'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  backfillSupplierPaymentDetails,
  type SupplierPaymentDetails,
} from '@/lib/supplier-invoices/payment-details-backfill'
import type { Logger } from '@/lib/logger'
import type { Currency, EntityType, SupplierInvoice, SupplierInvoiceItem } from '@/types'

export type CreateSupplierInvoiceInput = z.infer<typeof CreateSupplierInvoiceSchema>

export interface CreateSupplierInvoiceContext {
  supabase: SupabaseClient
  companyId: string
  userId: string
  log: Logger
}

/** A non-blocking warning about a registration that went through. */
export interface SupplierInvoiceWarning {
  code: string
  message_sv: string
  message_en: string
}

/** One computed row of supplier_invoice_items, before the parent id is known. */
export interface ComputedSupplierInvoiceItem {
  sort_order: number
  description: string
  quantity: number
  unit: string
  unit_price: number
  line_total: number
  account_number: string
  vat_code: string | null
  vat_rate: number
  vat_amount: number
  reverse_charge_rate: number | null
  accrual_period_start: string | null
  accrual_period_end: string | null
  accrual_balance_account: string | null
  dimensions: Record<string, string>
  apply_slp: boolean
}

export interface CreateSupplierInvoiceFailure {
  ok: false
  /** A code from lib/errors/structured-errors.ts. */
  code: string
  details?: Record<string, unknown>
  /** Set when a BookkeepingError should reach the caller verbatim. */
  error?: unknown
}

export interface CreateSupplierInvoicePreview {
  supplier_id: string
  supplier_invoice_number: string
  invoice_date: string
  due_date: string
  delivery_date: string | null
  status: 'registered' | 'paid'
  currency: string
  exchange_rate: number | null
  exchange_rate_date: string | null
  vat_treatment: string
  reverse_charge: boolean
  subtotal: number
  subtotal_sek: number | null
  vat_amount: number
  vat_amount_sek: number | null
  total: number
  total_sek: number | null
  remaining_amount: number
  is_credit_note: false
  paid_with_private_funds: boolean
  document_id: string | null
  notes: string | null
  default_dimensions: Record<string, string>
  items: ComputedSupplierInvoiceItem[]
  would_create_registration_journal_entry: boolean
}

export interface CreatedSupplierInvoice {
  ok: true
  dryRun: false
  /** The inserted supplier_invoices row (all columns). */
  invoice: SupplierInvoice & Record<string, unknown>
  /** The item rows as inserted, carrying supplier_invoice_id. */
  items: Array<ComputedSupplierInvoiceItem & { supplier_invoice_id: string }>
  registrationJournalEntryId: string | null
  paymentJournalEntryId: string | null
  expenseClaim: { id: string; claimant_name: string; liability_account: string } | null
  warnings: SupplierInvoiceWarning[]
}

export type CreateSupplierInvoiceResult =
  | { ok: true; dryRun: true; preview: CreateSupplierInvoicePreview }
  | CreatedSupplierInvoice
  | CreateSupplierInvoiceFailure

function invalid(reason: string): CreateSupplierInvoiceFailure {
  return { ok: false, code: 'SI_CREATE_INVALID_INPUT', details: { reason } }
}

/**
 * Register a supplier invoice. With `dryRun` every check runs and the result
 * is the row that would be written, but no ankomstnummer is drawn and nothing
 * is written.
 */
export async function createSupplierInvoice(
  ctx: CreateSupplierInvoiceContext,
  body: CreateSupplierInvoiceInput,
  options: { dryRun?: boolean } = {},
): Promise<CreateSupplierInvoiceResult> {
  const { supabase, companyId, userId, log } = ctx
  const dryRun = options.dryRun === true
  const paidPrivately = body.paid_with_private_funds === true

  // Särskild löneskatt (SLP): the 7533/2514 pair is only lawful on pension
  // premiums, so the flag is rejected on any non-741x account, and rejected
  // together with periodisering on the same row (the pair is computed on
  // the full line amount at registration and cannot be deferred).
  if (body.items.some((item) => item.apply_slp && !isSlpPensionAccount(item.account_number))) {
    return { ok: false, code: 'SI_CREATE_SLP_INVALID_ACCOUNT' }
  }
  if (
    body.items.some(
      (item) =>
        item.apply_slp &&
        (item.accrual_period_start || item.accrual_period_end || item.accrual_balance_account),
    )
  ) {
    return { ok: false, code: 'SI_CREATE_SLP_ACCRUAL' }
  }

  // A privately paid inbox document: the item's document is the underlag
  // and the item is settled here (registerExpenseClaim stamps
  // created_journal_entry_id; this function adds created_supplier_invoice_id).
  // The inbox extension's convert endpoint registers on 2440 only, so routing
  // the person-paid case through it would silently drop who paid.
  let inboxItem: { id: string; document_id: string | null; extracted_data: Record<string, unknown> | null } | null = null
  if (body.inbox_item_id) {
    if (!paidPrivately) {
      return invalid('inbox_item_id is only accepted with paid_with_private_funds')
    }
    const { data: item, error: itemError } = await supabase
      .from('invoice_inbox_items')
      .select('id, document_id, created_supplier_invoice_id, created_journal_entry_id, extracted_data')
      .eq('id', body.inbox_item_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (itemError || !item) {
      return invalid('inbox_item_id is missing or belongs to another company')
    }
    if (item.created_supplier_invoice_id || item.created_journal_entry_id) {
      return invalid('inbox item is already booked')
    }
    inboxItem = {
      id: item.id as string,
      document_id: (item.document_id as string | null) ?? null,
      extracted_data: (item.extracted_data as Record<string, unknown> | null) ?? null,
    }
  }
  const documentId = inboxItem ? inboxItem.document_id : body.document_id ?? null

  if (documentId) {
    const { data: document, error: documentError } = await supabase
      .from('document_attachments')
      .select('id, journal_entry_id')
      .eq('id', documentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (documentError || !document || document.journal_entry_id) {
      return invalid('document_id is missing, belongs to another company, or is already linked')
    }

    const { data: existingDocumentUse, error: existingDocumentUseError } = await supabase
      .from('supplier_invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('document_id', documentId)
      .limit(1)
      .maybeSingle()
    if (existingDocumentUseError) {
      log.error('supplier invoice document usage lookup failed', existingDocumentUseError)
      return { ok: false, code: 'SI_CREATE_FAILED', details: { step: 'document_lookup' } }
    }
    if (existingDocumentUse) {
      return invalid('document_id is already used by a supplier invoice')
    }
  }

  // Supplier, scoped to the company; an archived supplier takes no new
  // invoices (the dashboard picker hides them, the API refused them).
  const { data: supplier, error: supplierError } = await supabase
    .from('suppliers')
    .select('*')
    .eq('id', body.supplier_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (supplierError || !supplier || supplier.archived_at) {
    return { ok: false, code: 'SUPPLIER_NOT_FOUND' }
  }

  // The treatment is a booking contract, not metadata: the engine reads
  // `reverse_charge` for the fiktiv-moms route and `vat_treatment` for
  // whether any ingående moms may be deducted at all (#2553), and it decides
  // the rate a line that omits vat_rate falls back to. An EU or non-EU
  // supplier defaults to reverse charge when the caller does not say, and
  // `vat_treatment` is forced to follow the resolved flag so the two can
  // never disagree (the engine books on one, the momsdeklaration reads the
  // other).
  const foreignSupplier =
    supplier.supplier_type === 'eu_business' || supplier.supplier_type === 'non_eu_business'
  const reverseCharge = body.reverse_charge ?? foreignSupplier
  const vatTreatment = reverseCharge ? 'reverse_charge' : (body.vat_treatment ?? 'standard_25')

  if (paidPrivately && reverseCharge) {
    // RC invoices come from registered businesses with formal invoices and
    // go through normal AP. "Privately paid" only makes sense for
    // out-of-pocket kvitton.
    return invalid('paid_with_private_funds is not supported with reverse_charge')
  }

  const hasAccrualItems = body.items.some(
    (item) => item.accrual_period_start && item.accrual_period_end,
  )
  if (hasAccrualItems && reverseCharge) {
    // Omvänd skattskyldighet: the expense line IS the VAT base for rutor
    // 20-32: deferring the net to a 17xx interim account would corrupt the
    // momsdeklaration. Mirrors the customer-side reverse-charge guard.
    return { ok: false, code: 'SI_CREATE_ACCRUAL_REVERSE_CHARGE' }
  }
  if (hasAccrualItems && paidPrivately) {
    // Eget utlägg books the expense in one verifikat at registration:
    // there is no interim-account flow to defer.
    return invalid('periodisering is not supported with paid_with_private_funds')
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking, vat_registered')
    .eq('company_id', companyId)
    .maybeSingle()
  const companySettings = settings as
    | { accounting_method?: string | null; defer_invoice_booking?: boolean | null; vat_registered?: boolean | null }
    | null

  if (hasAccrualItems && (companySettings?.accounting_method || 'accrual') !== 'accrual') {
    // Kontantmetoden recognises the cost at payment; periodisering only
    // exists under faktureringsmetoden. Reject loudly instead of silently
    // dropping the periods.
    return invalid('periodisering requires faktureringsmetoden (accrual)')
  }

  // Icke momsregistrerad verksamhet has no deduction right for input VAT
  // (avdragsrätt, 13 kap. ML 2023:200): a line carrying moms would book
  // 2641 the company can never reclaim. Reverse charge stays allowed:
  // self-assessment is a separate obligation from deduction.
  const vatRegistered = companySettings?.vat_registered !== false
  if (
    !vatRegistered &&
    !reverseCharge &&
    body.items.some((item) => (item.vat_rate ?? 0) > 0 || (item.vat_amount ?? 0) > 0)
  ) {
    return invalid('company is not VAT-registered; supplier invoice lines cannot carry moms')
  }

  const items: ComputedSupplierInvoiceItem[] = body.items.map((item, index) => {
    // An omitted rate follows the invoice's vat_treatment, and only for
    // VAT-registered companies; icke momsregistrerade book the gross amount
    // with no moms line (#2553).
    const vatRate = item.vat_rate ?? (vatRegistered ? defaultVatRateForTreatment(vatTreatment) : 0)
    const lineTotal = item.amount != null
      ? roundOre(item.amount)
      : roundOre((item.quantity ?? 1) * (item.unit_price ?? 0))
    // A manual VAT override (partial deduction, foreign-currency rounding,
    // supplier-side POS rounding) wins over line_total × rate.
    const vatAmount = item.vat_amount != null ? roundOre(item.vat_amount) : roundOre(lineTotal * vatRate)
    const hasAccrual = Boolean(item.accrual_period_start && item.accrual_period_end)
    return {
      sort_order: index,
      description: item.description,
      quantity: item.amount != null ? 1 : (item.quantity ?? 1),
      unit: item.amount != null ? 'st' : (item.unit || 'st'),
      unit_price: item.amount != null ? lineTotal : (item.unit_price ?? 0),
      line_total: lineTotal,
      account_number: item.account_number,
      vat_code: item.vat_code || null,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      // Self-assessed RC rate (0.06/0.12/0.25) or null. For reverse charge the
      // supplier charges no VAT (vat_rate stays 0); the engine self-assesses
      // at this rate, defaulting to 25 % huvudregeln when null.
      reverse_charge_rate: reverseCharge ? (item.reverse_charge_rate ?? null) : null,
      // Periodisering: frozen onto the line at create time. The balance
      // account defaults from the cost account's BAS convention.
      accrual_period_start: hasAccrual ? (item.accrual_period_start ?? null) : null,
      accrual_period_end: hasAccrual ? (item.accrual_period_end ?? null) : null,
      accrual_balance_account: hasAccrual
        ? (item.accrual_balance_account ?? suggestBalanceAccount('expense', item.account_number))
        : null,
      // Per-item dimensions bag, merged over default_dimensions on the
      // expense line at booking.
      dimensions: item.dimensions ?? {},
      apply_slp: item.apply_slp === true,
    }
  })

  // Reverse charge: the Swedish supplier charges no VAT, the buyer
  // self-assesses (ML 1 kap 2 § p.4b, 16 kap 6 § and 13 §). A line rate
  // other than 0 would book a phantom ingående moms in rutor 30 / 48.
  if (reverseCharge) {
    const offending = items.findIndex((it) => it.vat_rate !== 0)
    if (offending !== -1) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: {
          field: `items[${offending}].vat_rate`,
          message:
            'reverse_charge invoices must have vat_rate=0 on every line item: the buyer self-assesses VAT.',
          attempted_rate: items[offending].vat_rate,
          reverse_charge: true,
        },
      }
    }
  }

  // Exempt (ML 10 kap) and export purchases carry no Swedish moms, so there
  // is no debiterad ingående moms to deduct: a line claiming a rate or an
  // amount contradicts the treatment (#2553).
  if (!treatmentDeductsInputVat(vatTreatment)) {
    const offending = items.findIndex((it) => it.vat_rate !== 0 || it.vat_amount !== 0)
    if (offending !== -1) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: {
          field: `items[${offending}].vat_rate`,
          message:
            `vat_treatment '${vatTreatment}' invoices must have vat_rate=0 and vat_amount=0 on every line item: the supplier charges no Swedish VAT, so there is no input VAT to deduct.`,
          attempted_rate: items[offending].vat_rate,
          vat_treatment: vatTreatment,
        },
      }
    }
  }

  const subtotal = roundOre(items.reduce((sum, i) => sum + i.line_total, 0))
  const vatAmount = roundOre(items.reduce((sum, i) => sum + i.vat_amount, 0))
  // Reverse charge: the supplier never invoices VAT, so the payable total
  // equals the net. VAT is still tracked (vat_amount) for the declaration.
  const total = roundOre(subtotal + (reverseCharge ? 0 : vatAmount))

  // A verifikat dated invoice_date is posted now when the company books at
  // registration or a person paid (the utlägg verifikat). Answer a locked
  // date with a structured PERIOD_LOCKED instead of the trigger's generic
  // error. The triggers stay authoritative; this is for the caller.
  const booksOnRegistration = booksInvoicesOnIssue(companySettings)
  if (booksOnRegistration || paidPrivately) {
    const lockVerdict = await checkPeriodLock(supabase, companyId, body.invoice_date)
    if (lockVerdict.locked) {
      return {
        ok: false,
        code: 'PERIOD_LOCKED',
        details: { reason: lockVerdict.reason, fiscal_period_id: lockVerdict.fiscal_period_id },
      }
    }
  }

  // Entity type drives the credit account for privately-paid invoices:
  // AB → 2893 (skuld till aktieägare), EF → 2018 (egen insättning).
  let entityType: EntityType | null = null
  if (paidPrivately) {
    const { data: company } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()
    if (!company?.entity_type) {
      return {
        ok: false,
        code: 'SI_CREATE_FAILED',
        details: { reason: 'company entity_type missing, cannot pick owner account' },
      }
    }
    entityType = parseEntityType(company.entity_type)
    if (body.employee_id) {
      // Checked before the arrival-number sequence is touched: a claim the
      // service would refuse must not burn an ankomstnummer.
      const { data: employee } = await supabase
        .from('employees')
        .select('id')
        .eq('id', body.employee_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!employee) return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
    }
  }

  // Resolve the exchange rate BEFORE the arrival-number sequence is touched:
  // a foreign invoice we cannot translate must not burn an ankomstnummer, and
  // a dry run surfaces the same refusal a live commit would.
  const fx = await resolveSupplierInvoiceExchangeRate(supabase, {
    currency: body.currency,
    invoiceDate: body.invoice_date,
    suppliedRate: body.exchange_rate,
  })
  if (!fx.ok) {
    return {
      ok: false,
      code: 'SI_FX_RATE_MISSING',
      details: { currency: fx.currency, invoice_date: fx.invoiceDate },
    }
  }
  // SEK resolves to rate 1, so total_sek === total instead of NULL.
  const {
    subtotal_sek: subtotalSek,
    vat_amount_sek: vatAmountSek,
    total_sek: totalSek,
  } = supplierInvoiceSekAmounts(fx.rate, { subtotal, vatAmount, total })

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_id: body.supplier_id,
        supplier_invoice_number: body.supplier_invoice_number,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        delivery_date: body.delivery_date ?? null,
        status: paidPrivately ? 'paid' : 'registered',
        currency: fx.rate.currency,
        exchange_rate: fx.rate.exchangeRate,
        exchange_rate_date: fx.rate.exchangeRateDate,
        vat_treatment: vatTreatment,
        reverse_charge: reverseCharge,
        subtotal,
        subtotal_sek: subtotalSek,
        vat_amount: vatAmount,
        vat_amount_sek: vatAmountSek,
        total,
        total_sek: totalSek,
        remaining_amount: paidPrivately ? 0 : total,
        is_credit_note: false,
        paid_with_private_funds: paidPrivately,
        document_id: documentId,
        notes: body.notes ?? null,
        default_dimensions: body.default_dimensions ?? {},
        items,
        would_create_registration_journal_entry: booksOnRegistration || paidPrivately,
      },
    }
  }

  // The scan read the supplier's giro or IBAN along with everything else;
  // a supplier that lacks them takes them now, so the invoice can go into
  // a betalfil without a detour to the supplier card.
  const scannedSupplier = (inboxItem?.extracted_data as { supplier?: SupplierPaymentDetails } | null)?.supplier
  if (scannedSupplier) {
    const written = await backfillSupplierPaymentDetails(supabase, companyId, supplier.id as string, scannedSupplier)
    if (Object.keys(written).length > 0) {
      log.info('supplier payment details filled from the scanned invoice', {
        supplierId: supplier.id,
        fields: Object.keys(written),
      })
    }
  }

  const { data: arrivalNum, error: arrivalError } = await supabase
    .rpc('get_next_arrival_number', { p_company_id: companyId })
  if (arrivalError || arrivalNum == null) {
    log.error('arrival number generation failed', (arrivalError as Error) ?? new Error('null arrival_number'))
    return {
      ok: false,
      code: 'SI_CREATE_FAILED',
      details: {
        reason: arrivalError ? getUserErrorMessage(arrivalError) : 'no arrival number',
        step: 'arrival_number',
      },
    }
  }

  // Representation (BAS 6070-6079): ingående moms is only deductible up to
  // 300 SEK base/person per ML 8 kap. 1 §, and the income-tax deduction was
  // abolished in 2017 (IL 16 kap. 2 §). The engine debits 2641 for the full
  // VAT; a non-blocking warning lets the user adjust. Every registration
  // path books that VAT, so every path warns.
  const warnings: SupplierInvoiceWarning[] = []
  if (!reverseCharge && items.some((i) => /^607\d$/.test(i.account_number) && i.vat_amount > 0)) {
    warnings.push({
      code: 'REPRESENTATION_VAT_CAP',
      message_sv:
        'Representation (konto 6070-6079): ingående moms är endast avdragsgill ' +
        'upp till 300 kr/person (ML 8 kap. 1 §) och kostnaden är inte ' +
        'inkomstskattemässigt avdragsgill (IL 16 kap. 2 §). Justera bokföringen ' +
        'manuellt om beloppet överstiger gränsen.',
      message_en:
        'Representation (accounts 6070-6079): input VAT is only deductible up to ' +
        'SEK 300 per person (ML 8 kap. 1 §) and the cost is not deductible for ' +
        'income tax (IL 16 kap. 2 §). Adjust the booking by hand if the amount ' +
        'exceeds the cap.',
    })
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('supplier_invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      supplier_id: body.supplier_id,
      document_id: documentId,
      arrival_number: arrivalNum,
      supplier_invoice_number: body.supplier_invoice_number,
      invoice_date: body.invoice_date,
      due_date: body.due_date,
      delivery_date: body.delivery_date || null,
      status: paidPrivately ? 'paid' : 'registered',
      currency: fx.rate.currency,
      exchange_rate: fx.rate.exchangeRate,
      // Which day's kurs the SEK amounts were translated at: the audit trail
      // that makes them verifiable (BFL 5 kap).
      exchange_rate_date: fx.rate.exchangeRateDate,
      vat_treatment: vatTreatment,
      reverse_charge: reverseCharge,
      payment_reference: body.payment_reference || null,
      paid_with_private_funds: paidPrivately,
      subtotal,
      subtotal_sek: subtotalSek,
      vat_amount: vatAmount,
      vat_amount_sek: vatAmountSek,
      total,
      total_sek: totalSek,
      paid_amount: paidPrivately ? total : 0,
      remaining_amount: paidPrivately ? 0 : total,
      // The out-of-pocket date, else the invoice date: the same date the
      // utlägg verifikat and the payment row carry (one affärshändelse).
      paid_at: paidPrivately ? `${body.payment_date ?? body.invoice_date}T12:00:00.000Z` : null,
      notes: body.notes || null,
      // Display-only öresavrundning override; null = off.
      ore_rounding: body.ore_rounding ?? null,
      // Invoice-level dimensions bag; generators apply it to every line.
      default_dimensions: body.default_dimensions ?? {},
    })
    .select()
    .single()

  if (invoiceError || !invoice) {
    return duplicateOrInsertFailure(ctx, body, invoiceError)
  }

  const invoiceId = invoice.id as string
  const itemInserts = items.map((item) => ({ supplier_invoice_id: invoiceId, ...item }))
  const { data: insertedItems, error: itemsError } = await supabase
    .from('supplier_invoice_items')
    .insert(itemInserts)
    .select('id, sort_order')
  if (itemsError) {
    // Nothing is booked yet: remove the parent instead of leaving an orphan.
    await hardDeleteSupplierInvoice(supabase, companyId, invoiceId, log, 'items_insert')
    return {
      ok: false,
      code: 'SI_CREATE_FAILED',
      details: { reason: getUserErrorMessage(itemsError), step: 'items_insert' },
    }
  }

  let registrationJournalEntryId: string | null = null
  let paymentJournalEntryId: string | null = null
  let expenseClaim: CreatedSupplierInvoice['expenseClaim'] = null

  if (paidPrivately && entityType) {
    // The invoice IS an utlägg registration with the supplier invoice as its
    // underlag: the same writer as the Underlag pane posts the verifikat and
    // the expense_claims row, with the invoice's full kontering as the
    // lines, regardless of accounting_method. The person then shows up under
    // "Betala ut utlägg" and the bank matcher closes the debt.
    const payer = body.employee_id ? 'employee' : 'owner'
    const liabilityAccount = resolveExpenseLiabilityAccount(entityType, payer)
    const claimDescription = buildSupplierDescription(
      'Faktura',
      invoice.supplier_invoice_number as string,
      supplier.name as string,
      `(ankomstnr ${invoice.arrival_number})`,
    )
    let claimResult: Awaited<ReturnType<typeof registerExpenseClaim>>
    try {
      claimResult = await registerExpenseClaim(supabase, companyId, userId, {
        description: claimDescription,
        expense_date: invoice.invoice_date as string,
        amount: total,
        vat_amount: vatAmount,
        currency: fx.rate.currency as Currency,
        exchange_rate: fx.rate.exchangeRate ?? undefined,
        expense_account: largestExpenseAccount(items as unknown as SupplierInvoiceItem[]),
        employee_id: body.employee_id ?? undefined,
        claimant_name: payer === 'owner' ? body.claimant_name?.trim() || ownerFallbackName(entityType) : undefined,
        document_id: documentId ?? undefined,
        inbox_item_id: inboxItem?.id,
        lines: buildSupplierInvoicePrivatelyPaidLines(
          invoice as SupplierInvoice,
          items as unknown as SupplierInvoiceItem[],
          liabilityAccount,
          claimDescription,
        ),
      })
    } catch (err) {
      // The claims service removes its own claim row before rethrowing; the
      // invoice row is ours to remove.
      await hardDeleteSupplierInvoice(supabase, companyId, invoiceId, log, 'expense_claim')
      if (isBookkeepingError(err)) return { ok: false, code: 'SI_CREATE_FAILED', error: err }
      log.error('failed to book privately paid supplier invoice as utlägg', err as Error, { invoiceId })
      return {
        ok: false,
        code: 'SI_CREATE_FAILED',
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown', step: 'expense_claim' },
      }
    }

    if (!claimResult.ok) {
      if (claimResult.code === 'LINK_WRITE_FAILED') {
        // The verifikat is posted and immutable: deleting the invoice now
        // would orphan it. Keep both rows and surface the desync loudly.
        log.error('expense claim posted but could not be linked', new Error(claimResult.detail ?? claimResult.code), {
          invoiceId,
        })
        return {
          ok: false,
          code: 'SI_CREATE_FAILED',
          details: { reason: claimResult.detail ?? claimResult.code, step: 'expense_claim_link' },
        }
      }
      await hardDeleteSupplierInvoice(supabase, companyId, invoiceId, log, 'expense_claim')
      if (claimResult.code === 'FISCAL_PERIOD_NOT_FOUND') {
        return { ok: false, code: 'SI_CREATE_NO_FISCAL_PERIOD', details: { invoice_date: body.invoice_date } }
      }
      if (claimResult.code === 'EMPLOYEE_NOT_FOUND') return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
      if (claimResult.code === 'INVALID_LINES') {
        return invalid(`expense claim lines: ${claimResult.detail ?? 'invalid'}`)
      }
      log.error('expense claim registration failed', new Error(claimResult.detail ?? claimResult.code), { invoiceId })
      return { ok: false, code: 'SI_CREATE_FAILED', details: { reason: claimResult.code, step: 'expense_claim' } }
    }

    const claim = claimResult.claim
    expenseClaim = { id: claim.id, claimant_name: claim.claimant_name, liability_account: claim.liability_account }
    if (claim.journal_entry_id) {
      paymentJournalEntryId = claim.journal_entry_id
      await supabase
        .from('supplier_invoices')
        .update({ payment_journal_entry_id: claim.journal_entry_id })
        .eq('id', invoiceId)
        .eq('company_id', companyId)
      // Mirror the payment in supplier_invoice_payments so AR/AP and
      // payment-history queries stay consistent with the mark-paid path.
      await supabase.from('supplier_invoice_payments').insert({
        user_id: userId,
        company_id: companyId,
        supplier_invoice_id: invoiceId,
        // The out-of-pocket date may differ from the receipt date.
        payment_date: body.payment_date ?? invoice.invoice_date,
        amount: total,
        currency: invoice.currency,
        exchange_rate_difference: 0,
        journal_entry_id: claim.journal_entry_id,
        notes: `Utlägg, betalat privat av ${claim.claimant_name}`,
      })
    }
    if (inboxItem) {
      // registerExpenseClaim stamped created_journal_entry_id (which marks
      // the item processed); the invoice link is ours.
      await supabase
        .from('invoice_inbox_items')
        .update({ created_supplier_invoice_id: invoiceId })
        .eq('id', inboxItem.id)
        .eq('company_id', companyId)
    }
  } else if (booksOnRegistration) {
    // Faktureringsmetoden: the registration verifikat (debit expense +
    // 2641 / credit 2440) is posted with the row. Kontantmetoden books at
    // payment and defer_invoice_booking (#967) books through the explicit
    // Bokför step, so neither posts here.
    let entryId: string | null = null
    try {
      const journalEntry = await createSupplierInvoiceRegistrationEntry(
        supabase,
        companyId,
        userId,
        invoice as SupplierInvoice,
        itemInserts as unknown as SupplierInvoiceItem[],
        supplier.supplier_type as string,
        supplier.name as string,
      )
      if (!journalEntry) {
        // Returned null ONLY when no fiscal period covers invoice_date, before
        // anything was posted. A row without its registration verifikat
        // would understate 2440 and 2641, so remove it.
        await hardDeleteSupplierInvoice(supabase, companyId, invoiceId, log, 'no_fiscal_period')
        return { ok: false, code: 'SI_CREATE_NO_FISCAL_PERIOD', details: { invoice_date: body.invoice_date } }
      }
      entryId = journalEntry.id
    } catch (err) {
      await undoFailedRegistration(ctx, invoiceId, body.invoice_date, 'registration_journal_entry')
      if (isBookkeepingError(err)) return { ok: false, code: 'SI_CREATE_FAILED', error: err }
      log.error('failed to create registration journal entry', err as Error, { invoiceId })
      return {
        ok: false,
        code: 'SI_CREATE_FAILED',
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown', step: 'registration_journal_entry' },
      }
    }

    const { error: linkError } = await supabase
      .from('supplier_invoices')
      .update({ registration_journal_entry_id: entryId })
      .eq('id', invoiceId)
      .eq('company_id', companyId)
    if (linkError) {
      // The verifikat is posted but the invoice does not point at it. Storno
      // it and retire the row, so the books never carry a registration the
      // invoice cannot see.
      log.error('registration entry posted but the invoice could not be linked', linkError, {
        invoiceId,
        journalEntryId: entryId,
      })
      await undoFailedRegistration(ctx, invoiceId, body.invoice_date, 'registration_journal_entry_link', entryId)
      return { ok: false, code: 'SI_CREATE_FAILED', details: { step: 'registration_journal_entry_link' } }
    }
    registrationJournalEntryId = entryId

    if (hasAccrualItems) {
      // The registration entry is committed (immutable): a schedule failure
      // must not roll the invoice back. Warn and let the user retry from
      // the periodiseringar page.
      const idBySortOrder = new Map(
        ((insertedItems ?? []) as Array<{ id: string; sort_order: number }>).map((row) => [row.sort_order, row.id]),
      )
      const itemsWithIds = items.map((item) => ({ ...item, id: idBySortOrder.get(item.sort_order) ?? null }))
      const scheduleResult = await createSchedulesForSupplierInvoice(
        supabase,
        companyId,
        userId,
        invoice as SupplierInvoice,
        itemsWithIds as unknown as SupplierInvoiceItem[],
        entryId,
      )
      if (scheduleResult.failed > 0) {
        warnings.push({
          code: 'ACCRUAL_SCHEDULE_FAILED',
          message_sv:
            'Fakturan bokfördes, men en eller flera periodiseringar kunde inte ' +
            'skapas. Kontrollera under Bokföring → Periodiseringar.',
          message_en:
            'The invoice was booked, but one or more accrual schedules could not ' +
            'be created. Check Bookkeeping → Accruals.',
        })
      }
    }
  }

  // The utlägg path links the document inside registerExpenseClaim.
  const primaryJournalEntryId = paymentJournalEntryId || registrationJournalEntryId
  if (documentId && primaryJournalEntryId && !paidPrivately) {
    try {
      await linkToJournalEntry(supabase, companyId, documentId, primaryJournalEntryId)
    } catch (err) {
      log.warn('supplier invoice document could not be linked to journal entry', {
        documentId,
        journalEntryId: primaryJournalEntryId,
        error: err instanceof Error ? err.message : String(err),
      })
      warnings.push({
        code: 'DOCUMENT_LINK_FAILED',
        message_sv: 'Fakturan registrerades, men underlaget kunde inte kopplas till verifikationen.',
        message_en: 'The invoice was registered, but the document could not be linked to the voucher.',
      })
    }
  }

  const registered = {
    ...invoice,
    registration_journal_entry_id: registrationJournalEntryId,
    payment_journal_entry_id: paymentJournalEntryId ?? invoice.payment_journal_entry_id ?? null,
  } as SupplierInvoice & Record<string, unknown>

  try {
    await eventBus.emit({
      type: 'supplier_invoice.registered',
      payload: { supplierInvoice: registered, companyId, userId },
    })
    if (paidPrivately) {
      await eventBus.emit({
        type: 'supplier_invoice.paid',
        payload: { supplierInvoice: registered, paymentAmount: total, companyId, userId },
      })
    }
  } catch (err) {
    log.warn('supplier_invoice.registered event emission failed', err as Error)
  }

  return {
    ok: true,
    dryRun: false,
    invoice: registered,
    items: itemInserts,
    registrationJournalEntryId,
    paymentJournalEntryId,
    expenseClaim,
    warnings,
  }
}

/**
 * The insert failed. The unique index on (company_id, supplier_id,
 * supplier_invoice_number) gets its own code with the existing row, and its
 * credit note when it was credited, so the dashboard can offer "undo
 * crediting" and an agent can fetch the original.
 */
async function duplicateOrInsertFailure(
  ctx: CreateSupplierInvoiceContext,
  body: CreateSupplierInvoiceInput,
  invoiceError: unknown,
): Promise<CreateSupplierInvoiceFailure> {
  const { supabase, companyId, log } = ctx
  const pgErr = invoiceError as { code?: string; message?: string } | null
  const isDuplicateNumber =
    pgErr?.code === '23505' && (pgErr.message || '').includes('idx_supplier_invoices_company_supplier_number')

  if (!isDuplicateNumber) {
    log.error('supplier invoice insert failed', invoiceError as Error, { pgCode: pgErr?.code })
    return {
      ok: false,
      code: 'SI_CREATE_FAILED',
      details: { reason: getUserErrorMessage(invoiceError) || 'unknown', pg_code: pgErr?.code },
    }
  }

  const { data: existing } = await supabase
    .from('supplier_invoices')
    .select('id, supplier_invoice_number, status')
    .eq('company_id', companyId)
    .eq('supplier_id', body.supplier_id)
    .eq('supplier_invoice_number', body.supplier_invoice_number)
    .maybeSingle()

  let creditNoteId: string | null = null
  if (existing?.status === 'credited') {
    const { data: creditNote } = await supabase
      .from('supplier_invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('credited_invoice_id', existing.id)
      .eq('is_credit_note', true)
      .maybeSingle()
    creditNoteId = (creditNote?.id as string | undefined) ?? null
  }

  return {
    ok: false,
    code: 'SI_CREATE_DUPLICATE_INVOICE_NUMBER',
    details: {
      supplier_id: body.supplier_id,
      supplier_invoice_number: body.supplier_invoice_number,
      existing: existing
        ? {
            id: existing.id,
            supplier_invoice_number: existing.supplier_invoice_number,
            status: existing.status,
            credit_note_id: creditNoteId,
          }
        : null,
    },
  }
}

/** Remove an invoice that never reached the books (no verifikat exists). */
async function hardDeleteSupplierInvoice(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  log: Logger,
  reason: string,
): Promise<void> {
  await supabase.from('supplier_invoice_items').delete().eq('supplier_invoice_id', invoiceId)
  const { error } = await supabase
    .from('supplier_invoices')
    .delete()
    .eq('id', invoiceId)
    .eq('company_id', companyId)
  if (error) {
    log.error('supplier invoice rollback failed, orphan row', error, { invoiceId, rollbackReason: reason })
  } else {
    log.warn('supplier invoice rolled back (nothing was booked)', { invoiceId, rollbackReason: reason })
  }
}

/**
 * Undo a registration whose booking step failed. What is right depends on
 * whether the verifikat reached the books, so ask the books instead of
 * guessing: a posted registration entry is stornoed and the invoice is kept
 * as `reversed` (BFL 5 kap 5 §: the pair stays visible), otherwise nothing
 * was booked and the row is removed. The earlier copies guessed in opposite
 * directions: one always deleted (orphaning a posted verifikat), the other
 * always soft-marked without a storno (leaving a live verifikat behind a
 * `reversed` invoice).
 */
async function undoFailedRegistration(
  ctx: CreateSupplierInvoiceContext,
  invoiceId: string,
  invoiceDate: string,
  reason: string,
  knownEntryId?: string,
): Promise<void> {
  const { supabase, companyId, userId, log } = ctx
  let entryId = knownEntryId ?? null
  if (!entryId) {
    const { data: posted } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('source_type', 'supplier_invoice_registered')
      .eq('source_id', invoiceId)
      .eq('status', 'posted')
      .limit(1)
      .maybeSingle()
    entryId = (posted?.id as string | undefined) ?? null
  }

  if (!entryId) {
    await hardDeleteSupplierInvoice(supabase, companyId, invoiceId, log, reason)
    return
  }

  try {
    await reverseEntry(supabase, companyId, userId, entryId, invoiceDate)
  } catch (err) {
    // The verifikat is still live. Marking the invoice `reversed` now would
    // hide a booked registration behind a retired invoice, so the invoice
    // stays as it is and points at its verifikat for whoever reconciles it.
    log.error('storno of the registration entry failed, manual reconciliation required', err as Error, {
      invoiceId,
      journalEntryId: entryId,
    })
    await supabase
      .from('supplier_invoices')
      .update({ registration_journal_entry_id: entryId })
      .eq('id', invoiceId)
      .eq('company_id', companyId)
    return
  }
  const { error } = await supabase
    .from('supplier_invoices')
    .update({ status: 'reversed', reversed_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
  if (error) {
    log.error('supplier invoice soft-rollback failed, manual reconciliation required', error, {
      invoiceId,
      rollbackReason: reason,
    })
  } else {
    log.warn('supplier invoice rolled back (status=reversed)', { invoiceId, rollbackReason: reason })
  }
}

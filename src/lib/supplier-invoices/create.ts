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
  buildSupplierInvoiceRegistrationEntryInput,
  buildSupplierInvoicePrivatelyPaidLines,
  largestExpenseAccount,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { buildSupplierDescription } from '@/lib/bookkeeping/supplier-invoice-description'
import {
  planExpenseClaim,
  registerExpenseClaim,
  type RegisterExpenseClaimFailure,
  type RegisterExpenseClaimInput,
} from '@/lib/expenses/expense-claims-service'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import { ownerFallbackName, resolveExpenseLiabilityAccount } from '@/lib/expenses/payer'
import {
  ACCRUAL_RELEASE_FAILED_WARNING,
  createSchedulesForSupplierInvoice,
} from '@/lib/bookkeeping/accruals/from-invoices'
import { assertAccruedCostLinesBookable } from '@/lib/bookkeeping/accruals/accrued-cost-guard'
import { suggestExpenseBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { supplierInvoiceBooksOnRegistration, supplierInvoiceRegistrationDate } from '@/lib/bookkeeping/booking-mode'
import { sellerVatIsCost } from '@/lib/bookkeeping/vat-registration'
import { supplierInvoiceStornoBusinessEvent } from '@/lib/bookkeeping/supplier-invoice-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { postingPort } from '@/lib/posting/port'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import type { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { roundOre, sumOre } from '@/lib/money'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import {
  defaultVatRateForTreatment,
  treatmentDeductsInputVat,
} from '@/lib/vat/supplier-invoice-line-checks'
import { allocateDocumentVat, type DocumentRateVat } from '@/lib/vat/document-vat'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { parseEntityType } from '@/lib/company/entity-type'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { SiCreateInvalidInputReason } from '@/lib/errors/structured-errors'
import { INBOX_ITEM_DOCUMENT_HOLD, itemStage, withDocumentHold, type DocumentHoldRow } from '@/lib/documents/inbox-item-state'
import {
  backfillSupplierPaymentDetails,
  inboxStatedPaymentDetails,
} from '@/lib/supplier-invoices/payment-details-backfill'
import { assessRegisteredPayee, payeeAlertWarning } from '@/lib/payments/payee-registration'
import type { Logger } from '@/lib/logger'
import { rejectSupersededInboxConversions } from '@/lib/pending-operations/supersede'
import { checkAccountingMethod } from '@/lib/company/accounting-method'
import type {
  CreateJournalEntryLineInput,
  Currency,
  EntityType,
  SupplierInvoice,
  SupplierInvoiceItem,
  SupplierInvoiceReverseChargeKind,
} from '@/types'
import { loadEntryLines, recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'
import { passed, warned, type DecisionCheck } from '@/lib/suggestion-log/checks'
import { resultAccounts } from '@/lib/suggestion-log/inbox-classify'
import { recordSupplierInvoicePaymentRow } from '@/lib/invoices/supplier-invoice-payment-row'
import { linkBasisColumns } from '@/lib/links/stamp'
import { refuseWhenPairBooked } from '@/lib/operations/inbox-pair-guard'
import { resolveSupplierInvoiceDueDate } from '@/lib/supplier-invoices/due-date'
import { invoiceDefaultDimensions } from '@/lib/suppliers/default-dimensions'
import { buildSelfBillingSnapshot, type SelfBillingSnapshot } from '@/lib/supplier-invoices/self-billing/snapshot'
import {
  archiveSelfBillingDocument,
  SELF_BILL_DOCUMENT_ARCHIVE_FAILED_WARNING,
} from '@/lib/supplier-invoices/self-billing/archive'

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
  /** The supplier's number; null on a self-billing invoice, whose number the series assigns at registration. */
  supplier_invoice_number: string | null
  is_self_billed: boolean
  /** Always null in a preview: assigned from the series when the invoice is registered. */
  self_billing_number: null
  self_billing_agreement_ref: string | null
  invoice_date: string
  due_date: string
  delivery_date: string | null
  status: 'registered' | 'paid'
  currency: string
  exchange_rate: number | null
  exchange_rate_date: string | null
  vat_treatment: string
  reverse_charge: boolean
  reverse_charge_kind: SupplierInvoiceReverseChargeKind | null
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
  /** VAT per rate as booked: the document's own figure or the VAT on the summed base. */
  vat_by_rate: DocumentRateVat[]
  would_create_registration_journal_entry: boolean
  /**
   * The verifikat the registration would post, built by the commit's own
   * builders (crm#1536): the registration verifikat, or the utlägg verifikat
   * when a person paid. Null when the registration posts none (kontantmetoden,
   * defer_invoice_booking).
   */
  verifikat: SupplierInvoicePreviewVerifikat | null
}

export interface SupplierInvoicePreviewVerifikat {
  entry_date: string
  lines: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    dimensions?: Record<string, string>
  }>
  total_debit: number
  total_credit: number
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

/** A refusal with its stable reason; the error registry holds the sentence for each. */
function invalid(reason: SiCreateInvalidInputReason, extra: Record<string, unknown> = {}): CreateSupplierInvoiceFailure {
  return { ok: false, code: 'SI_CREATE_INVALID_INPUT', details: { reason, ...extra } }
}

// ── The reverse-charge rules of a supplier invoice ──────────────────────
// Shared by every door that registers one: this module, the inbox convert
// (lib/operations/inbox-convert.ts), and the MCP inbox staging with its commit
// executor (lib/pending-operations/commit.ts). The convert used to carry a
// copy without the reverse-charge leg, so a reverse-charge invoice converted
// from the inbox registered net + 25 % as the payable while the registration
// verifikat credited 2440 with the net. The MCP door defaulted every invoice
// to standard_25, so a foreign supplier's invoice posted no fiktiv moms (accounted#58).

/**
 * The invoice's reverse-charge flag and vat_treatment. The treatment is a
 * booking contract, not metadata: the engine reads `reverse_charge` for the
 * fiktiv-moms route and `vat_treatment` for whether any ingående moms may be
 * deducted at all (#2553), and it decides the rate a line that omits vat_rate
 * falls back to. When the caller sets no flag, an EU or non-EU supplier
 * defaults to reverse charge (omvänd skattskyldighet, ML 16 kap 6 §;
 * swedish-vat skill 2.1-2.3) and so does a stated treatment of
 * reverse_charge, and `vat_treatment` is forced to follow the resolved flag
 * so the two can never disagree (the engine books on one, the momsdeklaration
 * reads the other).
 */
export function resolveSupplierInvoiceReverseCharge(
  supplierType: string | null | undefined,
  body: { reverse_charge?: boolean; vat_treatment?: string },
): { reverseCharge: boolean; vatTreatment: string } {
  const foreignSupplier = supplierType === 'eu_business' || supplierType === 'non_eu_business'
  const reverseCharge = body.reverse_charge ?? (foreignSupplier || body.vat_treatment === 'reverse_charge')
  return { reverseCharge, vatTreatment: reverseCharge ? 'reverse_charge' : (body.vat_treatment ?? 'standard_25') }
}

/**
 * Goods or services under an EU supplier's reverse charge
 * (supplier_invoices.reverse_charge_kind, crm#1323): eu_goods books the basis
 * on 4515-4517 (ruta 20), eu_services or none on 4535-4537 (ruta 21). Only an
 * EU supplier's reverse-charge invoice has the choice: a non-EU supplier's
 * goods are import VAT and its services ruta 22, a Swedish supplier's
 * omvänd skattskyldighet is ruta 24, so a kind there is refused rather than
 * silently ignored.
 */
export function resolveSupplierInvoiceReverseChargeKind(
  supplierType: string | null | undefined,
  reverseCharge: boolean,
  kind: SupplierInvoiceReverseChargeKind | null | undefined,
): { ok: true; kind: SupplierInvoiceReverseChargeKind | null } | CreateSupplierInvoiceFailure {
  if (kind == null) return { ok: true, kind: null }
  if (!reverseCharge) return invalid('reverse_charge_kind_without_reverse_charge')
  if (supplierType !== 'eu_business') {
    return invalid('reverse_charge_kind_not_eu_supplier')
  }
  return { ok: true, kind }
}

/**
 * Reverse charge: the supplier charges no Swedish VAT, the buyer
 * self-assesses (ML 1 kap 2 § p.4b, 16 kap 6 § and 13 §). A line rate other
 * than 0 would book a phantom ingående moms in rutor 30 / 48. Null when every
 * line carries 0 or the invoice is not reverse charge.
 */
export function reverseChargeLineRateRefusal(
  reverseCharge: boolean,
  items: ReadonlyArray<{ vat_rate: number }>,
): CreateSupplierInvoiceFailure | null {
  if (!reverseCharge) return null
  const offending = items.findIndex((it) => it.vat_rate !== 0)
  if (offending === -1) return null
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

/**
 * What the company owes the supplier. Reverse charge: the supplier never
 * invoices VAT, so the payable equals the net; the VAT is still tracked
 * (vat_amount) for the declaration.
 */
export function supplierInvoicePayableTotal(subtotal: number, vatAmount: number, reverseCharge: boolean): number {
  return roundOre(subtotal + (reverseCharge ? 0 : vatAmount))
}

/**
 * Why a self-billing invoice cannot be issued from this body, or null. What
 * the document cannot lawfully carry yet is refused rather than half-made:
 * reverse charge (the buyer's momsreg.nr and the notation, ML 17 kap 24 §
 * p.4 and 14), another currency (the VAT in SEK, 17 kap 29 §), a treatment
 * without Swedish VAT (an exemption reference, p.13), and an underlag or a
 * private payment (a self-billing invoice is our document and a payable).
 */
export function selfBillingUnsupportedReason(
  body: Pick<CreateSupplierInvoiceInput, 'currency' | 'document_id' | 'inbox_item_id' | 'paid_with_private_funds'>,
  reverseCharge: boolean,
  vatTreatment: string,
): 'reverse_charge' | 'currency' | 'vat_treatment' | 'document_id' | 'inbox_item_id' | 'paid_with_private_funds' | null {
  if (reverseCharge) return 'reverse_charge'
  if (body.currency && !isLedgerCurrency(body.currency)) return 'currency'
  if (!treatmentDeductsInputVat(vatTreatment)) return 'vat_treatment'
  if (body.document_id) return 'document_id'
  if (body.inbox_item_id) return 'inbox_item_id'
  if (body.paid_with_private_funds) return 'paid_with_private_funds'
  return null
}

/**
 * Register a supplier invoice. With `dryRun` every check runs and the result
 * is the row that would be written, but no ankomstnummer is drawn and nothing
 * is written.
 */
/** The refusal a register-only caller (suppliers:register) gets for a registration that posts or issues something. */
function registerOnlyRefusal(reason: 'posts_verifikat' | 'paid_privately' | 'self_billed'): CreateSupplierInvoiceFailure {
  return {
    ok: false,
    code: 'INSUFFICIENT_SCOPE',
    details: {
      required_scope: 'suppliers:write',
      reason,
      message:
        reason === 'self_billed'
          ? 'A self-billing invoice is issued with its SF number at registration: it needs suppliers:write.'
          : 'This registration posts a verifikat (faktureringsmetoden without deferred booking, or paid with private funds): it needs suppliers:write.',
    },
  }
}

export async function createSupplierInvoice(
  ctx: CreateSupplierInvoiceContext,
  body: CreateSupplierInvoiceInput,
  /**
   * registerOnly: the caller may only register what posts nothing
   * (suppliers:register, crm#1548). A registration that would post a
   * verifikat, a private payment or a självfaktura is refused before any
   * write, sequence number or document link.
   */
  options: { dryRun?: boolean; registerOnly?: boolean } = {},
): Promise<CreateSupplierInvoiceResult> {
  const { supabase, companyId, userId, log } = ctx
  const dryRun = options.dryRun === true
  const paidPrivately = body.paid_with_private_funds === true
  if (options.registerOnly) {
    if (body.is_self_billed) return registerOnlyRefusal('self_billed')
    if (paidPrivately) return registerOnlyRefusal('paid_privately')
  }

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

  // A självfaktura is our own document and a payable: refused with an
  // underlag, an inbox item or a private payment before any of them is read
  // (the treatment rules follow once the supplier is known).
  if (body.is_self_billed) {
    const early = selfBillingUnsupportedReason(body, false, 'standard_25')
    if (early) return { ok: false, code: 'SI_SELF_BILL_UNSUPPORTED', details: { reason: early } }
  }

  // A privately paid inbox document: the item's document is the underlag
  // and the item is settled here (registerExpenseClaim stamps
  // created_journal_entry_id; this function adds created_supplier_invoice_id).
  // The inbox extension's convert endpoint registers on 2440 only, so routing
  // the person-paid case through it would silently drop who paid.
  let inboxItem: { id: string; document_id: string | null; extracted_data: Record<string, unknown> | null } | null = null
  if (body.inbox_item_id) {
    if (!paidPrivately) {
      return invalid('inbox_item_requires_private_payment')
    }
    const { data: item, error: itemError } = await supabase
      .from('invoice_inbox_items')
      .select(`id, document_id, created_supplier_invoice_id, created_journal_entry_id, extracted_data, ${INBOX_ITEM_DOCUMENT_HOLD}`)
      .eq('id', body.inbox_item_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (itemError || !item) {
      return invalid('inbox_item_not_found')
    }
    if (itemStage(withDocumentHold(item as DocumentHoldRow)) === 'booked') {
      return invalid('inbox_item_already_booked')
    }
    // The other half of this purchase is booked already: an utlägg of this one books it twice.
    const pairBooked = await refuseWhenPairBooked(supabase, companyId, item.id as string)
    if (pairBooked) return { ok: false, code: pairBooked.code, details: { ...pairBooked.details, reason: pairBooked.messageSv } }
    inboxItem = {
      id: item.id as string,
      document_id: (item.document_id as string | null) ?? null,
      extracted_data: (item.extracted_data as Record<string, unknown> | null) ?? null,
    }
  }
  const documentId = inboxItem ? inboxItem.document_id : body.document_id ?? null
  // The model's original reading of the inbox underlag, before anything is written.
  const extractionSnapshot = inboxItem && !dryRun ? await snapshotInboxExtraction(supabase, companyId, inboxItem) : null

  if (documentId) {
    const { data: document, error: documentError } = await supabase
      .from('document_attachments')
      .select('id, journal_entry_id')
      .eq('id', documentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (documentError || !document || document.journal_entry_id) {
      return invalid('document_unavailable')
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
      return invalid('document_already_used')
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
  // The bag the request sent ({} included), else the supplier's default
  // (accounted#144); generators apply it to every line.
  const defaultDimensions = invoiceDefaultDimensions(body.default_dimensions, supplier)

  // A foreign supplier defaults to reverse charge; the treatment follows the
  // flag (resolveSupplierInvoiceReverseCharge).
  const { reverseCharge, vatTreatment } = resolveSupplierInvoiceReverseCharge(supplier.supplier_type, body)
  const reverseChargeKind = resolveSupplierInvoiceReverseChargeKind(
    supplier.supplier_type, reverseCharge, body.reverse_charge_kind,
  )
  if (!reverseChargeKind.ok) return reverseChargeKind

  // Självfaktura (crm#1367): we issue the document, so it can only be one we
  // can make lawfully today. The agreement it is issued under comes from the
  // body or the supplier card; without one there is no self-billing (ML
  // 2023:200 17 kap 15 § p.1).
  const selfBilled = body.is_self_billed === true
  let selfBillingAgreementRef: string | null = null
  if (selfBilled) {
    const unsupported = selfBillingUnsupportedReason(body, reverseCharge, vatTreatment)
    if (unsupported) return { ok: false, code: 'SI_SELF_BILL_UNSUPPORTED', details: { reason: unsupported } }
    selfBillingAgreementRef =
      body.self_billing_agreement_ref?.trim() || (supplier.self_billing_agreement_ref as string | null)?.trim() || null
    if (!selfBillingAgreementRef) {
      return { ok: false, code: 'SI_SELF_BILL_AGREEMENT_MISSING', details: { supplier_id: body.supplier_id } }
    }
  }
  const dueDate = resolveSupplierInvoiceDueDate(body.due_date, body.invoice_date, supplier.default_payment_terms)

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
    return invalid('accrual_with_private_payment')
  }

  const settingsRead = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking, vat_registered')
    .eq('company_id', companyId)
    .maybeSingle()
  // Fail closed (accounted#58): the method decides whether the registration
  // books now, and vat_registered whether 2641 may be booked. A failed read
  // used to mean "accrual, VAT-registered": a kontantmetod company's
  // invoice was booked at registration with moms it may not deduct.
  const method = checkAccountingMethod(settingsRead)
  if (!method.ok) {
    log.error('supplier invoice create refused: accounting method unavailable', method.error)
    return { ok: false, code: method.code, details: method.details }
  }
  const companySettings = settingsRead.data as
    | { accounting_method?: string | null; defer_invoice_booking?: boolean | null; vat_registered?: boolean | null }
    | null

  if (hasAccrualItems && method.accountingMethod !== 'accrual') {
    // Kontantmetoden recognises the cost at payment; periodisering only
    // exists under faktureringsmetoden. Reject loudly instead of silently
    // dropping the periods.
    return invalid('accrual_requires_accrual_method')
  }

  // Icke momsregistrerad verksamhet has no deduction right for input VAT
  // (avdragsrätt, 13 kap. ML 2023:200): a line carrying moms would book
  // 2641 the company can never reclaim. Reverse charge stays allowed:
  // self-assessment is a separate obligation from deduction. The inbox paths
  // fold the underlag's moms into the cost under the same rule
  // (sellerVatIsCost); a caller registering by hand sends the gross.
  const vatRegistered = companySettings?.vat_registered !== false
  if (
    sellerVatIsCost(companySettings?.vat_registered, reverseCharge) &&
    body.items.some((item) => (item.vat_rate ?? 0) > 0 || (item.vat_amount ?? 0) > 0)
  ) {
    return invalid('vat_on_non_vat_registered')
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
    // supplier-side POS rounding) wins; the other lines get their share of
    // the document's VAT per rate below (allocateDocumentVat).
    const vatAmount = item.vat_amount != null ? roundOre(item.vat_amount) : netVat(lineTotal, vatRate)
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
      // Periodisering: frozen onto the line at create time. An omitted
      // balance account takes the form's suggestion (accounted#113): 2990
      // (2960 for 84xx) for months before the invoice month, else the 17xx
      // account the cost account's BAS convention gives.
      accrual_period_start: hasAccrual ? (item.accrual_period_start ?? null) : null,
      accrual_period_end: hasAccrual ? (item.accrual_period_end ?? null) : null,
      accrual_balance_account: hasAccrual
        ? (item.accrual_balance_account ??
          suggestExpenseBalanceAccount(item.account_number, item.accrual_period_end, body.invoice_date))
        : null,
      // Per-item dimensions bag, merged over default_dimensions on the
      // expense line at booking.
      dimensions: item.dimensions ?? {},
      apply_slp: item.apply_slp === true,
    }
  })

  const reverseChargeRefusal = reverseChargeLineRateRefusal(reverseCharge, items)
  if (reverseChargeRefusal) return reverseChargeRefusal

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

  // VAT per rate as the document has it: the VAT on the summed base, or the
  // figure the caller read off the document (vat_breakdown), spread back onto
  // the lines so they sum to it. Per-line rounding drifted an öre or more from
  // the document on multi-line invoices (crm#1367).
  const documentVat = allocateDocumentVat(
    items.map((item, index) => ({
      lineTotal: item.line_total,
      rate: item.vat_rate,
      overrideVat: body.items[index].vat_amount ?? null,
    })),
    body.vat_breakdown?.map((entry) => ({ rate: entry.vat_rate, vatAmount: entry.vat_amount })) ?? null,
  )
  if (!documentVat.ok) {
    return { ok: false, code: documentVat.code, details: documentVat.details }
  }
  documentVat.lineVat.forEach((lineVat, index) => {
    items[index].vat_amount = lineVat
  })

  const subtotal = roundOre(items.reduce((sum, i) => sum + i.line_total, 0))
  const vatAmount = roundOre(items.reduce((sum, i) => sum + i.vat_amount, 0))
  const total = supplierInvoicePayableTotal(subtotal, vatAmount, reverseCharge)

  // The parties as they are today, frozen on the row; checked before an
  // ankomstnummer or a self-billing number is drawn.
  let selfBillingSnapshot: SelfBillingSnapshot | null = null
  if (selfBilled && selfBillingAgreementRef) {
    const { data: buyer, error: buyerError } = await supabase
      .from('company_settings')
      .select('company_name, org_number, vat_number, address_line1, address_line2, postal_code, city, country, self_billing_acceptance_text')
      .eq('company_id', companyId)
      .maybeSingle()
    if (buyerError || !buyer) {
      log.error('self-billing: company settings read failed', (buyerError as Error | null) ?? new Error('no settings row'))
      return { ok: false, code: 'SI_CREATE_FAILED', details: { step: 'self_billing_company' } }
    }
    const built = buildSelfBillingSnapshot({
      supplier: supplier as Parameters<typeof buildSelfBillingSnapshot>[0]['supplier'],
      company: buyer as Parameters<typeof buildSelfBillingSnapshot>[0]['company'],
      agreementRef: selfBillingAgreementRef,
      chargesVat: items.some((item) => item.vat_rate > 0 || item.vat_amount !== 0),
    })
    if (!built.ok) return { ok: false, code: 'SI_SELF_BILL_PARTY_INCOMPLETE', details: { missing: built.missing } }
    selfBillingSnapshot = built.snapshot
  }

  // A verifikat is posted now when the invoice books at registration
  // (faktureringsmetoden, or an EU goods acquisition under kontantmetoden:
  // supplierInvoiceBooksOnRegistration), dated by
  // supplierInvoiceRegistrationDate, or a person paid (the utlägg verifikat,
  // dated invoice_date). Answer a locked date with a structured PERIOD_LOCKED
  // instead of the trigger's generic error. The triggers stay authoritative;
  // this is for the caller.
  const booksOnRegistration = supplierInvoiceBooksOnRegistration(
    companySettings,
    { reverse_charge: reverseCharge, reverse_charge_kind: reverseChargeKind.kind },
    supplier.supplier_type as string | null,
  )
  const registrationDate = supplierInvoiceRegistrationDate(
    {
      invoice_date: body.invoice_date,
      delivery_date: body.delivery_date || null,
      reverse_charge: reverseCharge,
      reverse_charge_kind: reverseChargeKind.kind,
    },
    supplier.supplier_type as string | null,
  )
  if (options.registerOnly && booksOnRegistration) return registerOnlyRefusal('posts_verifikat')
  if (booksOnRegistration || paidPrivately) {
    const lockVerdict = await checkPeriodLock(supabase, companyId, paidPrivately ? body.invoice_date : registrationDate)
    if (lockVerdict.locked) {
      return {
        ok: false,
        code: 'PERIOD_LOCKED',
        details: { reason: lockVerdict.reason, fiscal_period_id: lockVerdict.fiscal_period_id },
      }
    }
  }
  // An upplupen kostnad (29xx line) books its months right after the
  // registration: its month-ends are checked now, before an ankomstnummer is
  // drawn (the registration builder checks them again for every door).
  if (booksOnRegistration && hasAccrualItems) {
    try {
      await assertAccruedCostLinesBookable(supabase, companyId, body.invoice_date, items)
    } catch (err) {
      if (isBookkeepingError(err)) return { ok: false, code: 'SI_CREATE_FAILED', error: err }
      throw err
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
    // The verifikat the commit would post, from the commit's own builders,
    // with its accounts judged as the engine judges them when it posts: the
    // dry run used to answer 200 for a deactivated or non-BAS account the
    // commit refuses (crm#1536).
    const verifikat = await previewRegistrationVerifikat(ctx, {
      header: {
        id: '',
        // Drawn at registration; the builders read it only for line text.
        arrival_number: null,
        supplier_invoice_number: selfBilled ? null : (body.supplier_invoice_number ?? null),
        is_self_billed: selfBilled,
        invoice_date: body.invoice_date,
        delivery_date: body.delivery_date || null,
        currency: fx.rate.currency,
        exchange_rate: fx.rate.exchangeRate,
        vat_treatment: vatTreatment,
        reverse_charge: reverseCharge,
        reverse_charge_kind: reverseChargeKind.kind,
        default_dimensions: defaultDimensions,
        total,
      } as unknown as SupplierInvoice,
      items,
      supplierType: supplier.supplier_type as string,
      supplierName: supplier.name as string,
      entityType,
      body,
      booksOnRegistration,
      paidPrivately,
      total,
      vatAmount,
      exchangeRate: fx.rate.exchangeRate,
      documentId,
      inboxItemId: inboxItem?.id,
    })
    if (!verifikat.ok) return verifikat
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_id: body.supplier_id,
        supplier_invoice_number: selfBilled ? null : (body.supplier_invoice_number ?? null),
        is_self_billed: selfBilled,
        self_billing_number: null,
        self_billing_agreement_ref: selfBillingAgreementRef,
        invoice_date: body.invoice_date,
        due_date: dueDate,
        delivery_date: body.delivery_date ?? null,
        status: paidPrivately ? 'paid' : 'registered',
        currency: fx.rate.currency,
        exchange_rate: fx.rate.exchangeRate,
        exchange_rate_date: fx.rate.exchangeRateDate,
        vat_treatment: vatTreatment,
        reverse_charge: reverseCharge,
        reverse_charge_kind: reverseChargeKind.kind,
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
        default_dimensions: defaultDimensions,
        items,
        vat_by_rate: documentVat.byRate,
        would_create_registration_journal_entry: booksOnRegistration || paidPrivately,
        verifikat: verifikat.verifikat,
      },
    }
  }

  // The scan read the supplier's giro or IBAN along with everything else;
  // a supplier that lacks them takes them now, so the invoice can go into
  // a betalfil without a detour to the supplier card. Compared with the card
  // first: an account the card does not have is an alert, and the card stays
  // as it is until a person approves the new one (lib/payments/payee-alerts.ts).
  const scannedSupplier = inboxStatedPaymentDetails(inboxItem?.extracted_data)
  const payeeAssessment = await assessRegisteredPayee(supabase, companyId, supplier.id as string, scannedSupplier)
  const statedPayee = payeeAssessment.stated
  if (payeeAssessment.alert) {
    log.info('supplier invoice states bank details the supplier card lacks', { supplierId: supplier.id, alert: payeeAssessment.alert })
  }
  if (scannedSupplier && payeeAssessment.backfill) {
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

  // Representation (BAS 6070-6079): ingående moms is deductible on a base of
  // at most 300 SEK excl. moms per person and occasion (ML 2023:200 13 kap.
  // 24-25 §§; 300 is the base, not the deduction), and a meal lost its
  // income-tax deduction in 2017 (IL 16 kap. 2 §). The engine debits 2641 for
  // the full VAT; a non-blocking warning lets the user adjust. Every
  // registration path books that VAT, so every path warns.
  const warnings: SupplierInvoiceWarning[] = []
  // Only an invoice someone will pay: a privately paid one is settled here.
  if (payeeAssessment.alert && !paidPrivately) warnings.push(payeeAlertWarning(payeeAssessment.alert))
  if (!reverseCharge && items.some((i) => /^607\d$/.test(i.account_number) && i.vat_amount > 0)) {
    warnings.push({
      code: 'REPRESENTATION_VAT_CAP',
      message_sv:
        'Representation (konto 6070-6079): ingående moms är avdragsgill på ett ' +
        'underlag om högst 300 kr exkl. moms per person och tillfälle ' +
        '(ML 13 kap. 24-25 §§), och en måltid är inte avdragsgill vid ' +
        'inkomstbeskattningen (IL 16 kap. 2 §). Justera momsraden manuellt om ' +
        'underlaget överstiger gränsen.',
      message_en:
        'Representation (accounts 6070-6079): input VAT is deductible on a base ' +
        'of at most SEK 300 excl. VAT per person and occasion (ML 13 kap. ' +
        '24-25 §§), and a meal is not deductible for income tax (IL 16 kap. 2 §). ' +
        'Adjust the VAT line by hand if the base exceeds the cap.',
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
      // A self-billing invoice's number is drawn from the series by the
      // insert trigger (assign_self_billing_number), never supplied.
      supplier_invoice_number: selfBilled ? null : body.supplier_invoice_number,
      is_self_billed: selfBilled,
      self_billing_agreement_ref: selfBillingAgreementRef,
      self_billing_snapshot: selfBillingSnapshot,
      invoice_date: body.invoice_date,
      due_date: dueDate,
      delivery_date: body.delivery_date || null,
      status: paidPrivately ? 'paid' : 'registered',
      currency: fx.rate.currency,
      exchange_rate: fx.rate.exchangeRate,
      // Which day's kurs the SEK amounts were translated at: the audit trail
      // that makes them verifiable (BFL 5 kap).
      exchange_rate_date: fx.rate.exchangeRateDate,
      vat_treatment: vatTreatment,
      reverse_charge: reverseCharge,
      reverse_charge_kind: reverseChargeKind.kind,
      payment_reference: body.payment_reference || null,
      // What the document itself says to pay to, validated. Kept on the
      // invoice even when the supplier card already has a different giro:
      // a payment compares the two instead of trusting either blindly.
      payee_bankgiro: statedPayee.payee_bankgiro,
      payee_plusgiro: statedPayee.payee_plusgiro,
      payee_iban: statedPayee.payee_iban,
      payee_bic: statedPayee.payee_bic,
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
      default_dimensions: defaultDimensions,
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
    let claimResult: Awaited<ReturnType<typeof registerExpenseClaim>>
    try {
      claimResult = await registerExpenseClaim(
        supabase,
        companyId,
        userId,
        await privatelyPaidClaimInput(supabase, companyId, {
          header: invoice as SupplierInvoice,
          items,
          supplierType: supplier.supplier_type as string,
          entityType,
          body,
          description: buildSupplierDescription(
            'Faktura',
            invoice.supplier_invoice_number as string,
            supplier.name as string,
            `(ankomstnr ${invoice.arrival_number})`,
          ),
          expenseDate: invoice.invoice_date as string,
          currency: fx.rate.currency,
          exchangeRate: fx.rate.exchangeRate,
          reverseCharge,
          total,
          vatAmount,
          documentId,
          inboxItemId: inboxItem?.id,
        }),
      )
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
      const failure = privatelyPaidClaimFailure(claimResult, body.invoice_date)
      if (failure.code === 'SI_CREATE_FAILED') {
        log.error('expense claim registration failed', new Error(claimResult.detail ?? claimResult.code), { invoiceId })
      }
      return failure
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
      const recorded = await recordSupplierInvoicePaymentRow(supabase, {
        userId,
        companyId,
        invoice: { id: invoiceId, currency: invoice.currency, paid_amount: 0 },
        // The out-of-pocket date may differ from the receipt date.
        paymentDate: body.payment_date ?? invoice.invoice_date,
        newPaidAmount: total,
        journalEntryId: claim.journal_entry_id,
        notes: `Utlägg, betalat privat av ${claim.claimant_name}`,
        // Registered as paid privately in the same act that booked the claim.
        linkBasis: { basis: 'user_created' },
      })
      if (!recorded.ok) {
        // The claim's verifikat is the payment and it stands; the row is what
        // the reversal and the kontantmetod cut-off read, so it must be seen.
        log.error('privately paid invoice: payment row not written', new Error(recorded.error), { invoiceId })
      }
    }
    if (inboxItem) {
      // registerExpenseClaim stamped created_journal_entry_id (which marks
      // the item processed); the invoice link is ours.
      await supabase
        .from('invoice_inbox_items')
        .update({ created_supplier_invoice_id: invoiceId })
        .eq('id', inboxItem.id)
        .eq('company_id', companyId)
      await rejectSupersededInboxConversions(supabase, companyId, inboxItem.id, invoiceId)
    }
  } else if (booksOnRegistration) {
    // Faktureringsmetoden: the registration verifikat (debit expense +
    // 2641 / credit 2440) is posted with the row. Kontantmetoden books at
    // payment and defer_invoice_booking (#967) books through the explicit
    // Bokför step, so neither posts here; an EU goods acquisition under
    // kontantmetoden does (ML 7 kap. 26 §, supplierInvoiceBookingMoment).
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
        // The posting port's event, while POSTING_EVENTS is on: the person
        // (or the approved operation) registered the invoice.
        () => ({ linkBasis: linkBasisColumns('user_created') }),
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
      await undoFailedRegistration(ctx, invoiceId, registrationDate, 'registration_journal_entry')
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
      await undoFailedRegistration(ctx, invoiceId, registrationDate, 'registration_journal_entry_link', entryId)
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
      if ((scheduleResult.releasesFailed ?? 0) > 0) warnings.push({ ...ACCRUAL_RELEASE_FAILED_WARNING })
    }
  }

  // The utlägg path links the document inside registerExpenseClaim.
  const primaryJournalEntryId = paymentJournalEntryId || registrationJournalEntryId
  if (documentId && primaryJournalEntryId && !paidPrivately) {
    try {
      // The verifikat was booked from this document.
      await linkToJournalEntry(supabase, companyId, documentId, primaryJournalEntryId, linkBasisColumns('user_created'))
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

  // The self-billing invoice's document: made from the stored row (its
  // number came from the insert) and archived as the verifikat's underlag.
  let selfBillingDocumentId: string | null = null
  if (selfBilled && selfBillingSnapshot) {
    selfBillingDocumentId = await archiveSelfBillingDocument(ctx, {
      supplierInvoiceId: invoiceId,
      invoice: {
        supplier_invoice_number: invoice.supplier_invoice_number as string | null,
        invoice_date: invoice.invoice_date as string,
        due_date: invoice.due_date as string,
        delivery_date: (invoice.delivery_date as string | null) ?? null,
        currency: invoice.currency as string,
        subtotal,
        vat_amount: vatAmount,
        total,
        is_credit_note: false,
      },
      items,
      snapshot: selfBillingSnapshot,
      journalEntryId: registrationJournalEntryId,
    })
    if (!selfBillingDocumentId) warnings.push({ ...SELF_BILL_DOCUMENT_ARCHIVE_FAILED_WARNING })
  }

  const registered = {
    ...invoice,
    registration_journal_entry_id: registrationJournalEntryId,
    payment_journal_entry_id: paymentJournalEntryId ?? invoice.payment_journal_entry_id ?? null,
    ...(selfBillingDocumentId ? { document_id: selfBillingDocumentId } : {}),
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

  if (extractionSnapshot) {
    // The guards this registration ran: the underlag unbooked and its document
    // free, the period open when a verifikat was posted now, the payee
    // compared with the supplier card, and the representation VAT cap.
    const payeeWarning = warnings.find((w) => w.code === 'SUPPLIER_PAYEE_CHANGED' || w.code === 'SUPPLIER_PAYEE_NEW')
    const checks: DecisionCheck[] = [
      passed('already_booked'),
      ...(documentId ? [passed('document_reuse')] : []),
      ...(booksOnRegistration || paidPrivately ? [passed('period_lock')] : []),
      payeeWarning ? warned('payee_alert', payeeWarning.code) : passed('payee_alert'),
      ...(warnings.some((w) => w.code === 'REPRESENTATION_VAT_CAP') ? [warned('representation_vat_cap', 'REPRESENTATION_VAT_CAP')] : []),
    ]
    await recordInboxDecision(supabase, extractionSnapshot, {
      supplier_invoice_id: invoiceId,
      journal_entry_id: primaryJournalEntryId,
      fields: {
        supplier_name: (supplier.name as string | null) ?? null,
        supplier_org_number: (supplier.org_number as string | null) ?? null,
        invoice_number: body.supplier_invoice_number ?? null,
        invoice_date: body.invoice_date,
        due_date: dueDate,
        payment_reference: body.payment_reference ?? null,
        currency: (invoice.currency as string | null) ?? null,
        total,
        vat_amount: vatAmount,
        accounts: resultAccounts(items.map((line) => line.account_number)),
      },
      lines: await loadEntryLines(supabase, companyId, primaryJournalEntryId),
    }, userId, checks)
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
 * What the utlägg writer gets for an invoice a person paid: the commit hands
 * it to registerExpenseClaim and the dry run to planExpenseClaim, so the
 * preview is the kontering the commit posts. `header` is the inserted row on
 * the commit and the would-be row in a dry run.
 */
async function privatelyPaidClaimInput(
  supabase: SupabaseClient,
  companyId: string,
  args: {
    header: SupplierInvoice
    items: ComputedSupplierInvoiceItem[]
    supplierType: string
    entityType: EntityType
    body: CreateSupplierInvoiceInput
    description: string
    expenseDate: string
    currency: string
    exchangeRate: number | null
    reverseCharge: boolean
    total: number
    vatAmount: number
    documentId: string | null
    inboxItemId: string | undefined
  },
): Promise<RegisterExpenseClaimInput> {
  const payer = args.body.employee_id ? 'employee' : 'owner'
  const liabilityAccount = resolveExpenseLiabilityAccount(args.entityType, payer)
  const items = args.items as unknown as SupplierInvoiceItem[]
  return {
    description: args.description,
    expense_date: args.expenseDate,
    amount: args.total,
    vat_amount: args.vatAmount,
    currency: args.currency as Currency,
    exchange_rate: args.exchangeRate ?? undefined,
    expense_account: largestExpenseAccount(items),
    employee_id: args.body.employee_id ?? undefined,
    claimant_name:
      payer === 'owner' ? args.body.claimant_name?.trim() || ownerFallbackName(args.entityType) : undefined,
    document_id: args.documentId ?? undefined,
    inbox_item_id: args.inboxItemId,
    // A reverse-charge invoice paid by a person (an EU SaaS on the owner's
    // card, crm#1377) books the same fiktiv moms and basis pair as its
    // registration verifikat would: who paid does not change who reports
    // the moms.
    lines: buildSupplierInvoicePrivatelyPaidLines(args.header, items, liabilityAccount, args.description, {
      supplierType: args.supplierType,
      chartVatTreatments: args.reverseCharge ? await fetchChartVatTreatments(supabase, companyId) : undefined,
    }),
  }
}

/** The claims writer's refusal as this service answers it, on the commit and in a dry run. */
function privatelyPaidClaimFailure(
  failure: RegisterExpenseClaimFailure,
  invoiceDate: string,
): CreateSupplierInvoiceFailure {
  if (failure.code === 'FISCAL_PERIOD_NOT_FOUND') {
    return { ok: false, code: 'SI_CREATE_NO_FISCAL_PERIOD', details: { invoice_date: invoiceDate } }
  }
  if (failure.code === 'EMPLOYEE_NOT_FOUND') return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  // The pair guard in the claims writer: the other half of this purchase is booked already.
  if (failure.code === 'INBOX_ITEM_PAIR_BOOKED') {
    return { ok: false, code: 'INBOX_ITEM_PAIR_ALREADY_BOOKED', details: { reason: failure.detail ?? failure.code } }
  }
  if (failure.code === 'INVALID_LINES') {
    return invalid('expense_claim_lines_invalid', { detail: failure.detail ?? null })
  }
  return { ok: false, code: 'SI_CREATE_FAILED', details: { reason: failure.code, step: 'expense_claim' } }
}

/**
 * The verifikat a registration would post, without posting it (crm#1536).
 * Built by what the commit posts through: the utlägg plan when a person paid
 * (planExpenseClaim, the read-only half of registerExpenseClaim), else the
 * registration builder when the invoice books now. Its accounts are then
 * judged as the engine judges them when it posts (findUnresolvableAccounts):
 * a BAS 2026 account merely absent from the chart passes, because the engine
 * adds it; a deactivated account or a number outside BAS refuses with the
 * AccountsNotInChartError the commit answers. Every refusal is the commit's
 * own. Null when the registration posts no verifikat (kontantmetoden,
 * defer_invoice_booking): the accounts are judged when the invoice is booked.
 */
async function previewRegistrationVerifikat(
  ctx: CreateSupplierInvoiceContext,
  args: {
    header: SupplierInvoice
    items: ComputedSupplierInvoiceItem[]
    supplierType: string
    supplierName: string
    entityType: EntityType | null
    body: CreateSupplierInvoiceInput
    booksOnRegistration: boolean
    paidPrivately: boolean
    total: number
    vatAmount: number
    exchangeRate: number | null
    documentId: string | null
    inboxItemId: string | undefined
  },
): Promise<{ ok: true; verifikat: SupplierInvoicePreviewVerifikat | null } | CreateSupplierInvoiceFailure> {
  const { supabase, companyId } = ctx
  let entryDate: string
  let lines: CreateJournalEntryLineInput[]
  const step = args.paidPrivately ? 'expense_claim' : 'registration_journal_entry'
  try {
    if (args.paidPrivately && args.entityType) {
      const input = await privatelyPaidClaimInput(supabase, companyId, {
        header: args.header,
        items: args.items,
        supplierType: args.supplierType,
        entityType: args.entityType,
        body: args.body,
        description: buildSupplierDescription('Faktura', args.header.supplier_invoice_number, args.supplierName),
        expenseDate: args.header.invoice_date,
        currency: args.header.currency,
        exchangeRate: args.exchangeRate,
        reverseCharge: args.header.reverse_charge === true,
        total: args.total,
        vatAmount: args.vatAmount,
        documentId: args.documentId,
        inboxItemId: args.inboxItemId,
      })
      const planned = await planExpenseClaim(supabase, companyId, input, { dryRun: true })
      if (!planned.ok) return privatelyPaidClaimFailure(planned, args.body.invoice_date)
      entryDate = input.expense_date
      lines = planned.plan.lines
    } else if (args.booksOnRegistration) {
      const input = await buildSupplierInvoiceRegistrationEntryInput(
        supabase,
        companyId,
        args.header,
        args.items as unknown as SupplierInvoiceItem[],
        args.supplierType,
        args.supplierName,
      )
      if (!input) {
        return { ok: false, code: 'SI_CREATE_NO_FISCAL_PERIOD', details: { invoice_date: args.body.invoice_date } }
      }
      entryDate = input.entry_date
      lines = input.lines
    } else {
      return { ok: true, verifikat: null }
    }
  } catch (err) {
    if (isBookkeepingError(err)) return { ok: false, code: 'SI_CREATE_FAILED', error: err }
    ctx.log.error('supplier invoice dry run could not build the verifikat', err as Error)
    return {
      ok: false,
      code: 'SI_CREATE_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown', step },
    }
  }

  const unresolvable = await findUnresolvableAccounts(supabase, companyId, lines.map((l) => l.account_number))
  if (unresolvable.length > 0) {
    return { ok: false, code: 'SI_CREATE_FAILED', error: new AccountsNotInChartError(unresolvable) }
  }

  return {
    ok: true,
    verifikat: {
      entry_date: entryDate,
      lines: lines.map((l) => ({
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        // The approver sees the tags the verifikat will carry.
        ...(l.dimensions && Object.keys(l.dimensions).length > 0 ? { dimensions: l.dimensions } : {}),
      })),
      total_debit: sumOre(lines.map((l) => l.debit_amount)),
      total_credit: sumOre(lines.map((l) => l.credit_amount)),
    },
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

  // A self-billing invoice brings no number of its own: a clash on the
  // series-assigned one is a failure, not a duplicate of the caller's.
  if (!isDuplicateNumber || !body.supplier_invoice_number) {
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
  /** The registration verifikat's own date: the storno is dated on it. */
  registrationDate: string,
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
    // Through the posting port: while POSTING_EVENTS is on, the storno
    // records ledger.storno of the invoice (system_derived: no one chose it).
    await postingPort.reverseJournalEntry({
      supabase,
      companyId,
      userId,
      entryId,
      reversalDate: registrationDate,
      event: () => supplierInvoiceStornoBusinessEvent(invoiceId, todayIsoStockholm(), linkBasisColumns('system_derived')),
      role: 'reversal',
    })
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

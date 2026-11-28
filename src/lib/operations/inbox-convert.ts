/**
 * Turn an invoice-inbox item into a registered supplier invoice (the
 * "Skapa leverantörsfaktura" of the Underlag inbox). One implementation
 * behind the invoice-inbox extension route
 * (POST /api/extensions/ext/invoice-inbox/items/:id/convert), the v1
 * operation inbox-items.convert-to-supplier-invoice
 * (lib/operations/inbox-items.ts) and the approval of a staged conversion
 * (gnubok_create_supplier_invoice_from_inbox, stagedConversion below), so
 * all three apply the same rules, keep the same notes and emit the same
 * events:
 *
 *   - the item and the supplier must belong to the company; an item already
 *     converted is refused, and so is one a live verifikat books already,
 *     when the conversion would post a verifikat of its own: the second
 *     booking of the purchase (lib/documents/inbox-item-claim.ts). An item
 *     whose invoice was credited, or whose verifikat books nothing any more,
 *     is released: it is registered again, the new invoice takes its
 *     pointer, and a document the old verifikat keeps goes onto the new
 *     registration as a byte-identical copy
 *     (lib/supplier-invoices/released-underlag.ts). A
 *     conversion that posts nothing passes: a company fills its reskontra that
 *     way and settles the invoice against the verifikat. The next step reads
 *     no hold, so a deferring company's Bokför, or a bank match the duplicate
 *     check lets through, can still book the purchase a second time;
 *   - a credit note, or a total below zero, is refused (issue #2980): it
 *     credits the invoice it references (lib/supplier-invoices/credit.ts), it
 *     is never a payable of its own, and the refusal says which invoice that is;
 *   - särskild löneskatt only on 741x pension lines and never with
 *     periodisering; periodisering never with reverse charge and only under
 *     faktureringsmetoden;
 *   - reverse charge follows createSupplierInvoice's rules, imported from
 *     lib/supplier-invoices/create.ts: a foreign supplier defaults to it,
 *     vat_treatment follows the flag, every line carries rate 0 and the
 *     payable is the net (omvänd skattskyldighet, ML 16 kap 6-16 §§);
 *   - a non-SEK invoice gets Riksbanken's rate for the invoice date unless a
 *     rate is given, and is refused when none can be had (never a NULL rate);
 *   - a company that is not VAT-registered books each line's VAT as part of
 *     its cost: 0 % on the line, nothing on 2641, the full total on 2440;
 *   - the item's document becomes the supplier invoice's underlag, and the
 *     registration verifikat's when one is booked (BFL 5 kap 6 §);
 *   - the invoice's default_dimensions (else the supplier's) and each line's
 *     dimensions are stored on the invoice and its items, the same columns the MCP door
 *     (create_supplier_invoice_from_inbox) writes, so the registration
 *     verifikat, its periodisering and the later payment carry the tags;
 *   - a company that books on issue gets the registration verifikat through
 *     the engine at once; if that fails the invoice is removed again, so the
 *     item is never marked converted against an unbooked invoice;
 *   - a duplicate supplier invoice number answers the existing invoice.
 *
 * A dry run resolves the item, the supplier, the rules and the rate, and
 * computes the invoice (withVerifikat: and the registration verifikat the
 * commit would post); it allocates no ankomstnummer and writes no invoice,
 * verifikat or supplier payment details. A refusal writes none of them either.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { resolveSupplierInvoiceDueDate } from '@/lib/supplier-invoices/due-date'
import type { z } from 'zod'
import type { CoreEvent } from '@/lib/events/types'
import { eventBus } from '@/lib/events'
import { backfillSupplierPaymentDetails, inboxStatedPaymentDetails } from '@/lib/supplier-invoices/payment-details-backfill'
import { assessRegisteredPayee, payeeAlertWarning } from '@/lib/payments/payee-registration'
import { isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'
import { defaultVatRateForTreatment, normalizeVatRateToDecimal, treatmentDeductsInputVat } from '@/lib/vat/supplier-invoice-line-checks'
import { allocateDocumentVat } from '@/lib/vat/document-vat'
import { rateForStoredRowVat } from '@/lib/bookkeeping/supplier-invoice-registration-lines'
import { suggestExpenseBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { roundOre } from '@/lib/money'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import { booksInvoicesOnIssue, supplierInvoiceBooksOnRegistration } from '@/lib/bookkeeping/booking-mode'
import { foldSellerVatIntoCost, sellerVatAsCostNote, sellerVatIsCost } from '@/lib/bookkeeping/vat-registration'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import {
  ACCRUAL_RELEASE_FAILED_WARNING,
  createSchedulesForSupplierInvoice,
} from '@/lib/bookkeeping/accruals/from-invoices'
import { assertAccruedCostLinesBookable } from '@/lib/bookkeeping/accruals/accrued-cost-guard'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { resolveInboxKind } from '@/lib/documents/inbox-kind'
import { resolveInboxCreditTarget } from '@/lib/supplier-invoices/credit-target'
import { readDuplicateNumberHolder } from '@/lib/supplier-invoices/duplicate-lookup'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import { invoiceDefaultDimensions } from '@/lib/suppliers/default-dimensions'
import { rejectSupersededInboxConversions } from '@/lib/pending-operations/supersede'
import {
  previewRegistrationVerifikat,
  resolveSupplierInvoiceReverseCharge,
  resolveSupplierInvoiceReverseChargeKind,
  reverseChargeAccountRefusal,
  reverseChargeLineRateRefusal,
  supplierInvoicePayableTotal,
  type ComputedSupplierInvoiceItem,
} from '@/lib/supplier-invoices/create'
import { loadEntryLines, recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'
import { passed, warned } from '@/lib/suggestion-log/checks'
import { resultAccounts } from '@/lib/suggestion-log/inbox-classify'
import type { InboxChannelContext, InvoiceInboxItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { linkBasisColumns } from '@/lib/links/stamp'
import { refuseWhenPairBooked } from './inbox-pair-guard'
import { checkAccountingMethod } from '@/lib/company/accounting-method'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { bookingStateOfItem } from '@/lib/documents/inbox-item-claim'
import { INBOX_ITEM_DOCUMENT_HOLD, type DocumentHoldRow } from '@/lib/documents/inbox-item-state'
import {
  RELEASED_UNDERLAG_COPY_FAILED_WARNING,
  copyReleasedUnderlag,
  releasedForRegistration,
} from '@/lib/supplier-invoices/released-underlag'
import {
  exceedsSupplierInvoiceTotalsTolerance,
  supplierInvoiceLinesInclVat,
  supplierInvoiceTotalsGap,
} from '@/lib/bookkeeping/supplier-invoice-line-totals'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { SUPPLIER_INVOICE_REVERSE_CHARGE_KINDS } from '@/types'

export type ConvertInboxItemInput = z.infer<typeof CreateSupplierInvoiceSchema>

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export interface ConvertInboxItemResult {
  invoice: SupplierInvoice
  items: Array<Record<string, unknown>>
  registration_journal_entry_id: string | null
  inbox_item_id: string
}

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

/** A staged conversion as the service takes it, or why it cannot be. */
export type StagedConversion =
  | { ok: true; inboxItemId: string; body: ConvertInboxItemInput; approvedTotal: number }
  /** `error` is said in the door's own words when there is no registered code, or the code's text says too little. */
  | { ok: false; code?: string; error?: string }

const finite = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null)

/**
 * What gnubok_create_supplier_invoice_from_inbox staged, as the input of the
 * one conversion. Staging read the document and priced the lines, and those
 * lines are what the approver saw, so they go in as they are: each with its
 * own VAT, and with its quantity and price when they make up its amount. A
 * stale or tampered op is refused here, before an ankomstnummer is drawn: a
 * field missing, an amount that is no number, a line with no account. Where
 * the staged treatment carries no seller VAT its lines carry none either,
 * whatever an op staged before the rule still says.
 */
export function stagedConversion(params: Record<string, unknown>): StagedConversion {
  const inboxItemId = params.inbox_item_id as string
  const supplierId = params.supplier_id as string
  const supplierInvoiceNumber = params.supplier_invoice_number
  const invoiceDate = params.invoice_date as string
  const dueDate = params.due_date as string | null | undefined
  const rawItems = (params.items as Array<Record<string, unknown>> | undefined) ?? []
  if (
    !inboxItemId ||
    !supplierId ||
    typeof supplierInvoiceNumber !== 'string' ||
    !supplierInvoiceNumber.trim() ||
    !invoiceDate ||
    !dueDate ||
    rawItems.length === 0
  ) {
    return {
      ok: false,
      code: 'SI_CREATE_INVALID_INPUT',
      error: 'inbox_item_id, supplier_id, supplier_invoice_number, invoice_date, due_date, and items are required',
    }
  }

  const total = finite(params.total)
  if (finite(params.subtotal) === null || finite(params.vat_amount) === null || total === null) {
    return { ok: false, error: 'subtotal, vat_amount, and total must be finite numbers' }
  }
  const stagedRate = params.exchange_rate ?? null
  if (stagedRate !== null && finite(stagedRate) === null) {
    return { ok: false, error: 'exchange_rate must be a finite number when provided' }
  }
  if (rawItems.some((item) => typeof item.account_number !== 'string' || !ACCOUNT_NUMBER_RE.test(item.account_number))) {
    return { ok: false, code: 'SI_CREATE_ITEM_ACCOUNT_MISSING' }
  }

  const kind = params.reverse_charge_kind ?? null
  if (kind !== null && !(SUPPLIER_INVOICE_REVERSE_CHARGE_KINDS as readonly unknown[]).includes(kind)) {
    return { ok: false, code: 'SI_CREATE_INVALID_INPUT', error: 'reverse_charge_kind must be eu_goods or eu_services' }
  }

  // The staged treatment is what the approver saw and the caller's word, as an
  // explicit reverse_charge flag is on the other doors, so the flag follows it.
  // An op without one gets the supplier's default.
  const treatment = typeof params.vat_treatment === 'string' && params.vat_treatment ? params.vat_treatment : undefined
  const reverseCharge = treatment === 'reverse_charge'
  const noSellerVat = reverseCharge || !treatmentDeductsInputVat(treatment)

  const items = rawItems.map((item, index) => {
    const lineTotal = finite(item.line_total) ?? 0
    const quantity = finite(item.quantity) ?? 1
    const unitPrice = finite(item.unit_price) ?? 0
    const reverseChargeRate = Number(item.reverse_charge_rate)
    return {
      description: String(item.description || `Position ${index + 1}`),
      ...(roundOre(quantity * unitPrice) === roundOre(lineTotal)
        ? { quantity, unit: (item.unit as string | undefined) ?? 'st', unit_price: unitPrice }
        : { amount: lineTotal }),
      account_number: item.account_number as string,
      // Percent-shaped rates (25) are snapped to the statutory set: rows staged
      // before issue #310 carry them, and one books 2500 % VAT downstream.
      vat_rate: noSellerVat || typeof item.vat_rate !== 'number' ? 0 : normalizeVatRateToDecimal(item.vat_rate),
      vat_amount: noSellerVat ? 0 : (finite(item.vat_amount) ?? 0),
      ...(reverseCharge && [0.06, 0.12, 0.25].includes(reverseChargeRate) ? { reverse_charge_rate: reverseChargeRate } : {}),
      apply_slp: item.apply_slp === true,
      dimensions: item.dimensions,
    }
  }) as ConvertInboxItemInput['items']

  return {
    ok: true,
    inboxItemId,
    approvedTotal: total,
    body: {
      supplier_id: supplierId,
      supplier_invoice_number: supplierInvoiceNumber,
      invoice_date: invoiceDate,
      due_date: dueDate,
      currency: ((params.currency as string) || 'SEK') as ConvertInboxItemInput['currency'],
      exchange_rate: stagedRate === null ? undefined : (stagedRate as number),
      ...(treatment ? { vat_treatment: treatment as ConvertInboxItemInput['vat_treatment'], reverse_charge: reverseCharge } : {}),
      reverse_charge_kind: kind === null ? undefined : (kind as ConvertInboxItemInput['reverse_charge_kind']),
      payment_reference: typeof params.payment_reference === 'string' ? params.payment_reference.trim() || undefined : undefined,
      // Null is no notes staged: the item's channel context goes in, as on every door.
      notes: typeof params.notes === 'string' ? params.notes : undefined,
      // Resolved at staging; a bag that does not parse any more is none. Not
      // omitted: an omitted bag takes the supplier's default, and the approver
      // saw none.
      default_dimensions: (coerceDimensionsBag(params.default_dimensions) ?? {}) as ConvertInboxItemInput['default_dimensions'],
      items,
    },
  }
}

export async function convertInboxItemToSupplierInvoice(
  ctx: OperationContext,
  inboxItemId: string,
  body: ConvertInboxItemInput,
  options: {
    dryRun?: boolean
    emit?: (event: CoreEvent) => Promise<void>
    /**
     * The total the approver of a staged conversion was shown. The header is
     * the lines' on every door; this only stops an approval whose lines do
     * not add up to what was approved.
     */
    approvedTotal?: number
    /**
     * With dryRun: the dry run also answers the registration verifikat the
     * commit would post (preview.verifikat, null when it posts none now), or
     * the commit's refusal of it, such as no open fiscal year.
     */
    withVerifikat?: boolean
  } = {},
): Promise<OperationOutcome<ConvertInboxItemResult>> {
  const { supabase, companyId, userId, log } = ctx
  const emit = options.emit ?? ((event: CoreEvent) => eventBus.emit(event))

  // A självfaktura is our own document (crm#1367): it is registered through
  // POST /supplier-invoices, never converted from a supplier's underlag.
  if (body.is_self_billed) {
    return { ok: false, code: 'SI_SELF_BILL_UNSUPPORTED', details: { reason: 'inbox_item_id' } }
  }

  const { data: stored, error: fetchError } = await supabase
    .from('invoice_inbox_items')
    .select(`*, ${INBOX_ITEM_DOCUMENT_HOLD}`)
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .single()
  if (fetchError || !stored) return { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }
  // A credited (or reversed) invoice no longer holds the item, nor does the
  // verifikat its document sits on once that books nothing: the underlag can
  // be registered again (released-underlag.ts). Fails closed on a read error.
  const released = await releasedForRegistration(supabase, companyId, stored as unknown as InvoiceInboxItem & DocumentHoldRow)
    .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
  if (released instanceof Error) return failed(released)
  const { item, release } = released
  if (item.created_supplier_invoice_id) {
    return { ok: false, code: 'INBOX_ITEM_ALREADY_CONVERTED', details: { supplier_invoice_id: item.created_supplier_invoice_id } }
  }
  const creditNoteRefusal = async (): Promise<Failure> => ({
    ok: false,
    code: 'INBOX_ITEM_IS_CREDIT_NOTE',
    details: { credit_target: await resolveInboxCreditTarget(supabase, companyId, item, { supplierId: body.supplier_id }) },
  })
  if (resolveInboxKind(item) === 'credit_note') return creditNoteRefusal()
  // The other half of this purchase is booked already: registering it would book the purchase twice.
  const pairBooked = await refuseWhenPairBooked(supabase, companyId, inboxItemId)
  if (pairBooked) return { ok: false, code: pairBooked.code, details: pairBooked.details, messageSv: pairBooked.messageSv }

  const { data: supplier, error: supplierError } = await supabase
    .from('suppliers')
    .select('*')
    .eq('id', body.supplier_id)
    .eq('company_id', companyId)
    .single()
  if (supplierError || !supplier) return { ok: false, code: 'SUPPLIER_NOT_FOUND' }
  // No förfallodatum given: the invoice date plus the supplier's terms.
  const dueDate = resolveSupplierInvoiceDueDate(body.due_date, body.invoice_date, supplier.default_payment_terms)

  // The stored treatment decides what a line that omits vat_rate falls back
  // to (#2553). A foreign supplier defaults to reverse charge and the
  // treatment follows the flag: the same resolution as POST /supplier-invoices.
  const { reverseCharge, vatTreatment } = resolveSupplierInvoiceReverseCharge(
    supplier.supplier_type as string | null,
    body,
  )
  const reverseChargeKind = resolveSupplierInvoiceReverseChargeKind(
    supplier.supplier_type as string | null, reverseCharge, body.reverse_charge_kind,
  )
  if (!reverseChargeKind.ok) return reverseChargeKind

  // Särskild löneskatt (SLP): the 7533/2514 pair is only lawful on 741x
  // pension premiums and cannot be combined with periodisering on the row.
  if (body.items.some((line) => line.apply_slp && !isSlpPensionAccount(line.account_number))) {
    return { ok: false, code: 'SI_CREATE_SLP_INVALID_ACCOUNT' }
  }
  if (
    body.items.some(
      (line) =>
        line.apply_slp && (line.accrual_period_start || line.accrual_period_end || line.accrual_balance_account),
    )
  ) {
    return { ok: false, code: 'SI_CREATE_SLP_ACCRUAL' }
  }

  // Periodisering requires faktureringsmetoden, and never rides a reverse
  // charge invoice: the expense line carries the VAT base for rutor 20-32,
  // so moving the net to a 17xx/29xx account would corrupt the momsdeklaration.
  const hasAccrualItems = body.items.some((line) => line.accrual_period_start && line.accrual_period_end)
  if (hasAccrualItems && reverseCharge) {
    return { ok: false, code: 'SI_CREATE_ACCRUAL_REVERSE_CHARGE' }
  }
  // The accounting method (periodisering, booking on issue) and the VAT
  // registration the lines depend on, read once. Fail closed (accounted#58):
  // an unreadable row used to mean "accrual, VAT-registered".
  const settingsRead = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking, vat_registered')
    .eq('company_id', companyId)
    .single()
  const method = checkAccountingMethod(settingsRead)
  if (!method.ok) return { ok: false, code: method.code, details: method.details }
  const settings = settingsRead.data
  if (hasAccrualItems && method.accountingMethod !== 'accrual') {
    return {
      ok: false,
      code: 'SI_CREATE_INVALID_INPUT',
      details: { reason: 'accrual_requires_accrual_method' },
    }
  }

  // Same currency policy as POST /api/supplier-invoices and the v1 create:
  // inbox items are AI-extracted, the currency comes off the PDF and the rate
  // never does, so a missing rate is fetched and an unresolvable one refused.
  // Resolved before the arrival number so a refusal burns no ankomstnummer.
  const fx = await resolveSupplierInvoiceExchangeRate(supabase, {
    currency: body.currency,
    invoiceDate: body.invoice_date,
    suppliedRate: body.exchange_rate,
  })
  if (!fx.ok) {
    return {
      ok: false,
      code: 'SI_FX_RATE_MISSING',
      details: { currency: fx.currency, invoice_date: fx.invoiceDate, ...(fx.temporary ? { temporary: true } : {}) },
    }
  }

  // Kostnadsställe/projekt (dimensions PR7): the invoice-level bag lands on
  // every generated line, a line's own bag merges over it on the expense
  // line that item books to. The bag sent ({} included), else the
  // supplier's default (accounted#144). Normalized through the same gate the
  // MCP door uses; the registry itself is checked when the verifikat is booked.
  const defaultDimensions = invoiceDefaultDimensions(body.default_dimensions, supplier)

  // Typed as the create path's computed row: a supplier_invoice_items field
  // that path writes (dimensions among them) cannot be left out here again.
  const pricedItems: ComputedSupplierInvoiceItem[] = body.items.map((line, index) => {
    const vatRate = line.vat_rate ?? defaultVatRateForTreatment(vatTreatment)
    const lineTotal = line.amount != null
      ? roundOre(line.amount)
      : roundOre((line.quantity ?? 1) * (line.unit_price ?? 0))
    // A line's own VAT (items[].vat_amount) is kept as given; the others get
    // their share of the document's VAT per rate below.
    const vatAmount = line.vat_amount != null ? roundOre(line.vat_amount) : netVat(lineTotal, vatRate)
    const accrues = Boolean(line.accrual_period_start && line.accrual_period_end)
    return {
      sort_order: index,
      description: line.description,
      quantity: line.amount != null ? 1 : (line.quantity ?? 1),
      unit: line.amount != null ? 'st' : (line.unit || 'st'),
      unit_price: line.amount != null ? lineTotal : (line.unit_price ?? 0),
      line_total: lineTotal,
      account_number: line.account_number,
      vat_code: line.vat_code || null,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      // Self-assessed RC rate or null: the engine defaults to 25 % huvudregeln.
      reverse_charge_rate: reverseCharge ? (line.reverse_charge_rate ?? null) : null,
      // Periodisering frozen onto the line; an omitted balance account takes
      // the form's suggestion (suggestExpenseBalanceAccount, accounted#113).
      accrual_period_start: accrues ? (line.accrual_period_start ?? null) : null,
      accrual_period_end: accrues ? (line.accrual_period_end ?? null) : null,
      accrual_balance_account: accrues
        ? (line.accrual_balance_account ??
          suggestExpenseBalanceAccount(line.account_number, line.accrual_period_end, body.invoice_date))
        : null,
      dimensions: coerceDimensionsBag(line.dimensions) ?? {},
      apply_slp: line.apply_slp === true,
    }
  })
  // Reverse charge: the seller charged no Swedish moms, so no line may carry a rate.
  const reverseChargeRefusal = reverseChargeLineRateRefusal(reverseCharge, pricedItems)
  if (reverseChargeRefusal) return reverseChargeRefusal
  // Nor may a line sit on an account that declares the purchase in a box of
  // its own: the basis pair would declare it twice.
  const accountRefusal = reverseChargeAccountRefusal(
    reverseCharge, pricedItems, reverseCharge ? await fetchChartVatTreatments(supabase, companyId) : null,
  )
  if (accountRefusal) return accountRefusal

  // VAT per rate as the document has it, the same rule as createSupplierInvoice:
  // the VAT on the summed base or the stated vat_breakdown, spread onto the
  // lines so they sum to it (crm#1367). Before the seller-VAT fold, so a
  // company without avdragsrätt folds the document's VAT into the cost.
  const documentVat = allocateDocumentVat(
    pricedItems.map((line, index) => ({
      lineTotal: line.line_total,
      rate: line.vat_rate,
      overrideVat: body.items[index].vat_amount ?? null,
    })),
    body.vat_breakdown?.map((entry) => ({ rate: entry.vat_rate, vatAmount: entry.vat_amount })) ?? null,
  )
  if (!documentVat.ok) return { ok: false, code: documentVat.code, details: documentVat.details }
  documentVat.lineVat.forEach((lineVat, index) => {
    pricedItems[index].vat_amount = lineVat
    pricedItems[index].vat_rate = rateForStoredRowVat(pricedItems[index].line_total, pricedItems[index].vat_rate, lineVat)
  })

  // Icke momsregistrerad (feedback seq 708521): amounts arrive excluding VAT
  // with the seller's rate, and a company with no avdragsrätt owes the
  // seller the VAT as part of the cost. The editor folds it before it
  // submits; any other caller is folded here, so a line never books 2641 the
  // company can never reclaim (lib/bookkeeping/vat-registration.ts).
  const sellerVatFold = sellerVatIsCost(settings?.vat_registered, reverseCharge)
    ? foldSellerVatIntoCost(pricedItems)
    : null
  const items = sellerVatFold ? sellerVatFold.lines : pricedItems

  // An upplupen kostnad (29xx line) books its months right after the
  // registration: refuse a month that cannot take its entry before an
  // ankomstnummer is drawn (the registration builder checks again).
  if (hasAccrualItems && booksInvoicesOnIssue(settings)) {
    try {
      await assertAccruedCostLinesBookable(supabase, companyId, body.invoice_date, items)
    } catch (err) {
      if (isBookkeepingError(err)) return { ok: false, code: 'SI_CREATE_FAILED', error: err }
      throw err
    }
  }

  const subtotal = items.reduce((sum, i) => sum + i.line_total, 0)
  const totalVat = items.reduce((sum, i) => sum + i.vat_amount, 0)
  // `total` and `total_sek` must round identically or a SEK invoice ends up
  // one öre apart. Reverse charge: the payable is the net.
  const total = supplierInvoicePayableTotal(subtotal, totalVat, reverseCharge)
  const {
    subtotal_sek: subtotalSek,
    vat_amount_sek: vatAmountSek,
    total_sek: totalSek,
  } = supplierInvoiceSekAmounts(fx.rate, { subtotal, vatAmount: totalVat, total })

  // WhatsApp-sourced items: when the request carries NO notes field at all,
  // default to the rendered chat context (representation deltagare + syfte).
  // Presence decides, not truthiness: `notes: ""` is an explicit clear.
  const notes =
    body.notes === undefined
      ? renderChannelContextNotes((item as { channel_context?: InboxChannelContext | null }).channel_context)
      : body.notes.trim() || null

  // Below zero it credits something, however the document was read: a credit
  // note is never a payable of its own (issue #2980).
  if (total < 0 || subtotal < 0 || (options.approvedTotal ?? 0) < 0) return creditNoteRefusal()

  // Whether confirming posts the registration verifikat: the dry run says
  // what the commit below does.
  const booksOnRegistration = supplierInvoiceBooksOnRegistration(
    settings,
    { reverse_charge: reverseCharge, reverse_charge_kind: reverseChargeKind.kind },
    supplier.supplier_type as string | null,
  )

  // The item is booked already, by its stamp or by the verifikat its document
  // sits on: a verifikat of its own here books the purchase a second time.
  if (booksOnRegistration) {
    const booking = await bookingStateOfItem(supabase, companyId, item)
    if (booking.state === 'error') return failed(booking.error)
    if (booking.state === 'booked') {
      return { ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED', details: { inbox_item_id: inboxItemId, journal_entry_id: booking.journal_entry_id } }
    }
  }

  // An approval: the registration credits 2440 with the lines plus their VAT,
  // so a total the approver saw that they do not reach stops here, before an
  // ankomstnummer is drawn. Where nothing is deductible, or the company has no
  // avdragsrätt, the lines are the payable by rule and nothing can disagree.
  const payableIsTheLines = reverseCharge || !!sellerVatFold || !treatmentDeductsInputVat(vatTreatment)
  if (options.approvedTotal !== undefined && !payableIsTheLines) {
    const gap = supplierInvoiceTotalsGap(options.approvedTotal, items)
    if (exceedsSupplierInvoiceTotalsTolerance(gap, items.length)) {
      log.warn('refused a staged inbox supplier invoice whose lines do not add up to its total', { inboxItemId, gap })
      return {
        ok: false,
        code: 'SI_CREATE_TOTALS_MISMATCH',
        details: { gap },
        messageSv:
          `${getErrorEntry('SI_CREATE_TOTALS_MISMATCH')?.message_sv} `
          + `Raderna inklusive moms: ${supplierInvoiceLinesInclVat(items)}, totalbelopp: ${roundOre(options.approvedTotal)}.`,
      }
    }
  }

  // The invoice as the commit below inserts it, less what only the commit
  // draws (the ankomstnummer) or reads (the payee the document states): the
  // dry run builds its verifikat over this same row.
  const invoiceRow = {
    supplier_id: body.supplier_id,
    supplier_invoice_number: body.supplier_invoice_number,
    invoice_date: body.invoice_date,
    due_date: dueDate,
    delivery_date: body.delivery_date || null,
    status: 'registered' as const,
    currency: fx.rate.currency,
    exchange_rate: fx.rate.exchangeRate,
    // Which day's kurs the SEK amounts were translated at (BFL 5 kap).
    exchange_rate_date: fx.rate.exchangeRateDate,
    vat_treatment: vatTreatment,
    reverse_charge: reverseCharge,
    reverse_charge_kind: reverseChargeKind.kind,
    payment_reference: body.payment_reference || null,
    subtotal: roundOre(subtotal),
    subtotal_sek: subtotalSek,
    vat_amount: roundOre(totalVat),
    vat_amount_sek: vatAmountSek,
    total,
    total_sek: totalSek,
    remaining_amount: total,
    document_id: item.document_id || null,
    notes,
    // Invoice-level bag; the registration, periodisering and payment
    // generators apply it to every line they book.
    default_dimensions: defaultDimensions,
  }

  if (options.dryRun) {
    // The registration verifikat as the commit posts it: the same builder
    // over the same row and lines, its accounts judged as the engine judges
    // them. The ankomstnummer, drawn at the commit, only names its text.
    const registration = options.withVerifikat
      ? await previewRegistrationVerifikat(ctx, {
          header: { ...invoiceRow, id: '', arrival_number: null, is_self_billed: false } as unknown as SupplierInvoice,
          items,
          supplierType: supplier.supplier_type as string,
          supplierName: supplier.name as string,
          entityType: null,
          body,
          booksOnRegistration,
          paidPrivately: false,
          total,
          vatAmount: totalVat,
          exchangeRate: fx.rate.exchangeRate,
          documentId: invoiceRow.document_id,
          inboxItemId,
        })
      : null
    if (registration && !registration.ok) return registration
    return {
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: inboxItemId,
        supplier_id: body.supplier_id,
        supplier_name: (supplier.name as string | null) ?? null,
        supplier_invoice_number: body.supplier_invoice_number,
        invoice_date: body.invoice_date,
        due_date: dueDate,
        currency: fx.rate.currency,
        exchange_rate: fx.rate.exchangeRate,
        exchange_rate_date: fx.rate.exchangeRateDate,
        vat_treatment: vatTreatment,
        reverse_charge: reverseCharge,
        reverse_charge_kind: reverseChargeKind.kind,
        subtotal: roundOre(subtotal),
        vat_amount: roundOre(totalVat),
        total,
        total_sek: totalSek,
        document_id: item.document_id || null,
        notes,
        default_dimensions: defaultDimensions,
        items,
        vat_by_rate: documentVat.byRate,
        ...(sellerVatFold
          ? {
              vat_registration: {
                vat_registered: false,
                seller_vat_added_to_cost: sellerVatFold.sellerVat,
                note: sellerVatAsCostNote(sellerVatFold.sellerVat, total),
              },
            }
          : {}),
        would_create_registration_journal_entry: booksOnRegistration,
        ...(registration ? { verifikat: registration.verifikat } : {}),
        // Registered again after a credit: the invoice that held the item,
        // and whether the new registration gets its own copy of the document.
        ...(release.supplier_invoice_id || release.copy_from_document_id
          ? {
              registers_again: {
                released_supplier_invoice_id: release.supplier_invoice_id,
                copies_document: release.copy_from_document_id !== null,
              },
            }
          : {}),
      },
    }
  }

  // The model's original reading of the underlag, taken before anything is written.
  const extractionSnapshot = await snapshotInboxExtraction(supabase, companyId, item)

  // The scan (or Peppol's PaymentMeans) read the supplier's giro or IBAN with
  // everything else. The invoice keeps what it states (payee_*), compared
  // with the supplier card before the card is touched (the backfill below).
  const scannedSupplier = inboxStatedPaymentDetails(item.extracted_data)
  const payeeAssessment = await assessRegisteredPayee(supabase, companyId, supplier.id as string, scannedSupplier)
  if (payeeAssessment.alert) {
    log.info('inbox invoice states bank details the supplier card lacks', { supplierId: supplier.id, alert: payeeAssessment.alert })
  }

  const { data: arrivalNum, error: arrivalError } = await supabase.rpc('get_next_arrival_number', {
    p_company_id: companyId,
  })
  if (arrivalError) {
    log.error('inbox convert: arrival number allocation failed', arrivalError as unknown as Error)
    return { ok: false, code: 'SI_CREATE_FAILED', details: { step: 'arrival_number' } }
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('supplier_invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      arrival_number: arrivalNum,
      ...invoiceRow,
      // What the document itself says to pay to, validated: a payment
      // compares it with the supplier card instead of trusting either.
      payee_bankgiro: payeeAssessment.stated.payee_bankgiro,
      payee_plusgiro: payeeAssessment.stated.payee_plusgiro,
      payee_iban: payeeAssessment.stated.payee_iban,
      payee_bic: payeeAssessment.stated.payee_bic,
    })
    .select()
    .single()

  if (invoiceError || !invoice) {
    // A unique-index hit on (company_id, supplier_id, supplier_invoice_number)
    // is a recoverable conflict: the invoice is already registered (often by
    // hand, then converted from the same inbox document). Answer the existing
    // row, read under the company filter, and only server-authoritative
    // fields (never the request body echoed back).
    const pgErr = invoiceError as { code?: string; message?: string } | null
    const isDuplicateNumber =
      pgErr?.code === '23505' && (pgErr.message || '').includes('idx_supplier_invoices_company_supplier_number')
    if (isDuplicateNumber) {
      return {
        ok: false,
        code: 'SI_CREATE_DUPLICATE_INVOICE_NUMBER',
        details: {
          existing: await readDuplicateNumberHolder(supabase, companyId, body.supplier_id, body.supplier_invoice_number),
        },
      }
    }
    return failed(invoiceError ?? new Error('Failed to create invoice'))
  }

  // Taken out again when the invoice cannot stand: its items go with it
  // (ON DELETE CASCADE), and the item is never marked converted against it.
  const removeInvoice = async () => {
    const { error } = await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
    if (error) log.error('inbox convert: invoice left behind after a failed registration', error, { supplierInvoiceId: invoice.id })
  }

  const itemInserts = items.map((line) => ({ supplier_invoice_id: invoice.id, ...line }))
  const { data: insertedItems, error: itemsError } = await supabase
    .from('supplier_invoice_items')
    .insert(itemInserts)
    .select('id, sort_order')
  if (itemsError) {
    await removeInvoice()
    return failed(itemsError)
  }

  let registrationJournalEntryId: string | null = null
  // A periodisering month that could not be posted after the registration.
  let releaseFailed = false
  // The released underlag got no copy: the invoice keeps the original, and
  // the person is told (the verifikat is posted and stands).
  let copyFailed = false

  // #967: deferred companies register WITHOUT booking; ekonomi books later.
  // Kontantmetoden books at payment, except an EU goods acquisition (ML
  // 7 kap. 26 §, supplierInvoiceBookingMoment).
  if (booksOnRegistration) {
    try {
      const journalEntry = await createSupplierInvoiceRegistrationEntry(
        supabase,
        companyId,
        userId,
        invoice as SupplierInvoice,
        items as SupplierInvoiceItem[],
        supplier.supplier_type,
        supplier.name,
        // The posting port's event, while POSTING_EVENTS is on: registered
        // from this inbox item by the person (or the approved operation).
        () => ({ linkBasis: linkBasisColumns('user_created'), inboxItemId }),
      )
      if (journalEntry) {
        registrationJournalEntryId = journalEntry.id
        ;(invoice as SupplierInvoice).registration_journal_entry_id = journalEntry.id
        await supabase
          .from('supplier_invoices')
          .update({ registration_journal_entry_id: journalEntry.id })
          .eq('id', invoice.id)

        // The verifikat has its underlag (BFL 5 kap 6 §). It was booked from
        // this document. A failed link fails nothing: the verifikat is posted
        // and immutable, and the invoice stays usable. A document that stays
        // on the verifikat of a credited registration goes on as a copy.
        if (item.document_id) {
          try {
            if (release.copy_from_document_id) {
              await copyReleasedUnderlag(supabase, companyId, userId, {
                sourceDocumentId: release.copy_from_document_id,
                supplierInvoiceId: invoice.id as string,
                journalEntryId: journalEntry.id,
              })
            } else {
              await linkToJournalEntry(supabase, companyId, item.document_id, journalEntry.id, linkBasisColumns('user_created'))
            }
          } catch (linkError) {
            // Told to the person only for the copy: a plain link that fails
            // has always been logged and anchored later by the nightly sweep.
            if (release.copy_from_document_id) copyFailed = true
            log.warn('inbox convert: document not linked to the registration verifikat', {
              documentId: item.document_id,
              journalEntryId: journalEntry.id,
              error: linkError instanceof Error ? linkError.message : String(linkError),
            })
          }
        }

        if (hasAccrualItems) {
          // Schedules + catch-up dissolutions for deferred lines. Never
          // fatal: the registration entry is committed; failures surface on
          // the periodiseringar page.
          const idBySortOrder = new Map(
            ((insertedItems ?? []) as Array<{ id: string; sort_order: number }>).map((row) => [row.sort_order, row.id]),
          )
          const itemsWithIds = items.map((line) => ({ ...line, id: idBySortOrder.get(line.sort_order) ?? null }))
          const scheduleResult = await createSchedulesForSupplierInvoice(
            supabase,
            companyId,
            userId,
            invoice as SupplierInvoice,
            itemsWithIds as unknown as SupplierInvoiceItem[],
            journalEntry.id,
          )
          if (scheduleResult.failed > 0) {
            log.error('accrual schedule creation failed on inbox convert', {
              supplierInvoiceId: invoice.id,
              failed: scheduleResult.failed,
            })
          }
          if ((scheduleResult.releasesFailed ?? 0) > 0) releaseFailed = true
        }
      } else {
        // null means no fiscal period covers invoice_date (every other
        // failure throws). Roll back so the item is never marked converted
        // against an unbooked invoice (an orphan understating 2440/2641).
        await removeInvoice()
        return {
          ok: false,
          code: 'SI_CREATE_NO_FISCAL_PERIOD',
          details: { invoiceDate: (invoice as SupplierInvoice).invoice_date },
        }
      }
    } catch (err) {
      // The engine threw (period lock, unbalanced entry, ...): roll back the
      // invoice for the same reason, then surface the engine's error.
      await removeInvoice()
      if (isBookkeepingError(err)) return { ok: false, code: 'SI_CREATE_FAILED', error: err }
      return {
        ok: false,
        code: 'SI_CREATE_FAILED',
        details: { reason: err instanceof Error ? err.message : 'unknown', step: 'registration_journal_entry' },
      }
    }
  } else if (release.copy_from_document_id) {
    // Registered again with no verifikat now: the invoice gets its own copy
    // of the underlag, which its booking anchors later.
    try {
      await copyReleasedUnderlag(supabase, companyId, userId, {
        sourceDocumentId: release.copy_from_document_id,
        supplierInvoiceId: invoice.id as string,
        journalEntryId: null,
      })
    } catch (copyError) {
      copyFailed = true
      log.warn('inbox convert: no copy of the released underlag for the invoice', {
        documentId: release.copy_from_document_id,
        supplierInvoiceId: invoice.id,
        error: copyError instanceof Error ? copyError.message : String(copyError),
      })
    }
  }

  // The item names its invoice. Registered again after a credit, the new
  // invoice takes the pointer over from the credited one.
  const { error: stampError } = await supabase
    .from('invoice_inbox_items')
    .update({ created_supplier_invoice_id: invoice.id })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
  if (stampError) {
    log.warn('inbox convert: item not marked converted (the invoice stands)', { inboxItemId, supplierInvoiceId: invoice.id, error: stampError.message })
  }
  // An agent's staged registration of the same item is now moot (crm#1074).
  await rejectSupersededInboxConversions(supabase, companyId, inboxItemId, invoice.id as string)

  // What the document states goes onto the card now the invoice exists, and
  // only what the card lacks, so the invoice can go into a betalfil without a
  // detour to the supplier card; an account the card does not have waits for
  // a person (lib/payments/payee-alerts.ts). Never throws.
  if (scannedSupplier && payeeAssessment.backfill) {
    await backfillSupplierPaymentDetails(supabase, companyId, supplier.id as string, scannedSupplier)
  }

  await recordInboxDecision(supabase, extractionSnapshot, {
    supplier_invoice_id: invoice.id as string,
    journal_entry_id: registrationJournalEntryId,
    fields: {
      supplier_name: supplier.name ?? null,
      supplier_org_number: supplier.org_number ?? null,
      invoice_number: body.supplier_invoice_number,
      invoice_date: body.invoice_date,
      due_date: dueDate,
      payment_reference: body.payment_reference ?? null,
      currency: fx.rate.currency,
      total,
      vat_amount: roundOre(totalVat),
      accounts: resultAccounts(items.map((line) => line.account_number)),
    },
    lines: await loadEntryLines(supabase, companyId, registrationJournalEntryId),
  }, userId, [
    // The item was not converted yet, and the payee was compared with the supplier card.
    passed('already_booked'),
    payeeAssessment.alert ? warned('payee_alert', payeeAlertWarning(payeeAssessment.alert).code) : passed('payee_alert'),
  ])

  // After every write: the detectors behind these count this registration too.
  try {
    await emit({
      type: 'supplier_invoice.registered',
      payload: { supplierInvoice: invoice as SupplierInvoice, companyId, userId },
    })
  } catch {
    /* non-blocking */
  }
  try {
    await emit({
      type: 'supplier_invoice.confirmed',
      payload: {
        inboxItem: { ...item, created_supplier_invoice_id: invoice.id } as InvoiceInboxItem,
        supplierInvoice: invoice as SupplierInvoice,
        userId,
        companyId,
      },
    })
  } catch {
    /* non-blocking */
  }

  return {
    ok: true,
    created: true,
    data: {
      invoice: invoice as SupplierInvoice,
      items: itemInserts,
      registration_journal_entry_id: registrationJournalEntryId,
      inbox_item_id: inboxItemId,
    },
    ...(payeeAssessment.alert || releaseFailed || copyFailed
      ? {
          warnings: [
            ...(payeeAssessment.alert ? [payeeAlertWarning(payeeAssessment.alert)] : []),
            ...(releaseFailed ? [{ ...ACCRUAL_RELEASE_FAILED_WARNING }] : []),
            ...(copyFailed ? [{ ...RELEASED_UNDERLAG_COPY_FAILED_WARNING }] : []),
          ],
        }
      : {}),
  }
}

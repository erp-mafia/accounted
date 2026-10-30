/**
 * One click books the purchase: for an inbox item waiting for its first
 * decision, what the primary answer books, worked out from what is already
 * known, so pressing it creates everything (the supplier, the booking, the
 * VAT, the underlag and the bank link) with no form in between. When
 * something only a person can say is missing, the plan says what to ask
 * instead of guessing.
 *
 * The rules (docs/decisions/2026-10/2026-10-20-*):
 *
 *   Form. Paid at purchase is ONE verifikat against the bank row's
 *   settlement account, no 2440 and no supplier invoice (BFL 5 kap 4 §: a
 *   sidoordnad reskontra is not obligatory; BFN's allmänna råd 1.9 kommentar:
 *   a card payment is not kontant): a receipt; an invoice its receipt from
 *   the same arrival says is paid; an invoice whose bank row is at most
 *   seven days after its date (the card's settlement lag); an item already
 *   linked to its bank row. An invoice paid later than that is registered at
 *   its date and settled against the row in the same click while
 *   Leverantörsfakturor is on, and booked like a receipt while it is off. An
 *   unpaid invoice is registered (faktureringsmetoden, package on); without
 *   its number or due date the form opens prefilled. Kontantmetoden and the
 *   package off keep their own answers for an unpaid invoice.
 *
 *   Date. Faktureringsmetoden: the document's purchase date (the invoice
 *   date, else the receipt's) when it lies within 31 days before and 3 days
 *   after the bank date, else the bank date (BFL 5 kap 7 §; ML 7 kap 31 §).
 *   Kontantmetoden: the bank date (ML 7 kap 33 §). A registration takes the
 *   invoice date, its payment the bank date. The date is never moved out of
 *   a locked period: the booking is refused and the editor opens.
 *
 *   Account. The cost account of the purchase's category (a person's choice,
 *   else the supplier's instruction, else the proposal): the counterparty's
 *   booked account when it belongs to the category, else the supplier's
 *   default account when it does, else the category's usual account. No
 *   category: ask for one.
 *
 *   VAT. A seller in Sweden: input VAT from the document, per rate (refused
 *   to the editor when it exceeds 25 % of the net or mixes rates without a
 *   breakdown); none when the document has none. Representation, meals, a
 *   hired car, gifts and wellness go to the editor: their deduction turns on
 *   who was there and which car (ML 13 kap 21-25 §§), and so does
 *   construction work with no VAT on it, which may be the buyer's to
 *   self-assess (ML 16 kap 13 §). A seller abroad, no VAT on
 *   the document, buying a service: omvänd betalningsskyldighet on the
 *   kronor amount (ruta 21 from the EU, 22 from outside), 25 % unless said
 *   otherwise (ML 6 kap 33 §). Goods, the exceptions (ML 6 kap 38, 39, 46,
 *   48 and 52 §§), an unclear category, VAT charged by a foreign seller (not
 *   deductible here) or a company that is not VAT-registered: the editor,
 *   prefilled. A seller whose country nothing names, on a document with no
 *   VAT that looks foreign: ask where the seller is.
 *
 *   No periodisering: a one-click purchase is below K2's 7 000 kr per post
 *   (BFNAR 2025:2) or a person decides in the editor; accruals are
 *   bokslutstransaktioner (BFL 5 kap 3 §). Equipment above half a
 *   prisbasbelopp is an inventarie to capitalise (IL 18 kap 4 §): the editor.
 *
 *   Supplier. A register path names the matched supplier, else creates one
 *   from the reading (name, numbers, address, the country and type the VAT
 *   rule used). A direct booking names the matched supplier only.
 *
 *   Review. The company's one-click switch, a counterpart rule set to
 *   always ask and a booking review rule that matches the plan
 *   (lib/transactions/direct-booking.ts askedForReview, the same decision
 *   the bank rows read) open the editor, prefilled with the whole plan,
 *   instead of booking it (accounted#130).
 *
 * Pure: the loader (./inkorg-one-click-read.ts) reads, this decides, the book door
 * (./inkorg-book.ts) writes through the shared internals.
 */
import type { InvoiceExtractionResult } from '@/types'
import type { InboxDocumentKind } from '@/lib/documents/inbox-kind'
import type { PurchaseCategoryCode } from '@/lib/categories/purchase-categories'
import { SE_PURCHASE_CATEGORY_PACK } from '@/lib/bookkeeping/bas-data/purchase-category-accounts'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import {
  generateReverseChargePurchaseLines,
  resolveReverseChargeRate,
  type ReverseChargeKind,
} from '@/lib/bookkeeping/vat-entries'
import { isNotVatRegistered, type VatRegistration } from '@/lib/bookkeeping/vat-registration'
import { getCapitalizationThreshold } from '@/lib/bookkeeping/mapping-engine'
import {
  CAPITALISABLE_CATEGORIES,
  DOMESTIC_REVERSE_CHARGE_CATEGORIES,
  deductionLimited,
  purchaseVatNature,
} from '@/lib/vat/purchase-category-vat-nature'
import {
  looksForeign,
  sellerCountry,
  supplierTypeForRegion,
  type SellerRegion,
  type SupplierTypeForRegion,
} from '@/lib/vat/seller-country'
import { addDaysIso } from '@/lib/dates/iso'
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { ORE_ROUNDING_SETTLEMENT_MAX, roundOre, sumOre } from '@/lib/money'
import { askedForReview, DIRECT_BOOKING_ON, type DirectBookingSettings } from '@/lib/transactions/direct-booking'
import { factsFromLines, matchBookingReviewRules, type BookingReviewRule } from '@/lib/booking-review/match'

/** Whether a booking review rule matches the plan's lines and its bank row (or supplier). */
function planBlocked(lines: readonly OneClickLine[], review: OneClickInput['bookingReview']): boolean {
  if (!review || review.rules.length === 0) return false
  const facts = factsFromLines(lines, [
    { counterpartyKey: review.counterpartyKey, amountSek: review.amountSek === null ? Number.POSITIVE_INFINITY : Math.abs(review.amountSek) },
  ])
  return matchBookingReviewRules(review.rules, facts).length > 0
}

export type OneClickForm = 'direct' | 'register' | 'register_and_settle'

export type OneClickAsk = 'category' | 'seller_country' | 'editor'

export type OneClickReason =
  // A form, nothing asked.
  | 'receipt'
  | 'linked'
  | 'paid_by_receipt'
  | 'paid_at_purchase'
  | 'paid_later'
  | 'paid_package_off'
  | 'unpaid'
  // Something asked.
  | 'no_category'
  | 'seller_country_unknown'
  | 'goods_abroad'
  | 'exception_abroad'
  | 'unknown_nature_abroad'
  | 'foreign_vat'
  | 'foreign_vat_unknown_country'
  | 'not_vat_registered_abroad'
  | 'vat_exceeds_rate'
  | 'mixed_rates'
  | 'vat_rate_unknown'
  | 'foreign_currency_vat'
  | 'amount_mismatch'
  | 'no_amount'
  | 'no_kronor_amount'
  | 'not_money_out'
  | 'fx_rate_missing'
  | 'missing_invoice_number'
  | 'missing_invoice_date'
  | 'missing_due_date'
  | 'missing_supplier_name'
  | 'supplier_type_mismatch'
  | 'limited_deduction'
  | 'possible_asset'
  | 'possible_domestic_reverse_charge'
  // The company switched one click off, or the counterpart's rule always asks.
  | 'review_required'
  // No one-click answer for this item.
  | 'no_bank_row'
  | 'credit_note'
  | 'not_read'
  | 'cash_method_unpaid'
  | 'package_off_unpaid'

/** The bank row the purchase was paid by. */
export interface OneClickBankRow {
  transactionId: string
  /** The bank's date: the day the money moved. */
  date: string
  /** Signed kronor (a payment is below zero); null for a foreign row with no kronor value. */
  amountSek: number | null
  /** The ledger account it settles on (resolveSettlementAccount): a card account books against its own. */
  settlementAccount: string
  /** matched: the item is linked to the row already; proposal: the row match on arrival found. */
  source: 'matched' | 'proposal'
}

/** The supplier card the item is matched to, by the item or by its identity. */
export interface OneClickSupplier {
  id: string
  supplierType: string | null
  defaultExpenseAccount: string | null
  paymentTermsDays: number | null
}

export interface OneClickInput {
  kind: InboxDocumentKind | null
  reading: InvoiceExtractionResult | null
  /** An invoice its receipt from the same arrival says is paid (lib/inkorg/decision.ts paidByReceipt). */
  paidByReceipt: boolean
  /** That receipt's date, the purchase date when the invoice has none. */
  receiptDate: string | null
  bank: OneClickBankRow | null
  company: {
    /** company_settings.vat_registered as stored; only false changes anything. */
    vatRegistered: VatRegistration
    /** Kontantmetoden. */
    cashMethod: boolean
    /** Leverantörsfakturor och betalningar is on. */
    supplierInvoices: boolean
  }
  /** What was bought: a person's answer, else the item's category as it reads (choice, instruction, proposal). */
  category: PurchaseCategoryCode | null
  supplier: OneClickSupplier | null
  /** The account the company has booked this counterparty on (templatePurchaseAccount). */
  counterpartyAccount: string | null
  /** The counterpart's rule asks for a review on every booking (categorization_templates.always_review). */
  counterpartyAlwaysReview?: boolean
  /** The company's one-click switch (company_settings.direct_booking_enabled); absent, on. */
  directBooking?: DirectBookingSettings
  /**
   * The company's booking review rules (accounted#130 step 2) and what they
   * judge besides the plan's lines: the counterparty of the bank row (else
   * of the supplier the document names) and the bank row's kronor amount
   * (null when unknown, which meets any amount criterion). A match opens
   * the editor.
   */
  bookingReview?: { rules: BookingReviewRule[]; counterpartyKey: string; amountSek: number | null }
  /** Where the seller is, as the person answered; read only when the document names no country. */
  sellerRegionAnswer: SellerRegion | null
  /** SEK per unit of the invoice's currency on its date (a register path in a foreign currency). */
  invoiceRate: number | null
}

export interface OneClickLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

export type OneClickVat =
  | { kind: 'none' }
  /** Ingående moms from the document. */
  | { kind: 'input'; amount: number; rates: number[] }
  /** Not VAT-registered: the seller's VAT is part of the cost. */
  | { kind: 'cost'; amount: number }
  | { kind: 'reverse_charge'; rcKind: ReverseChargeKind; rate: number }

/** A supplier card created from the reading, in CreateSupplierSchema's words. */
export interface OneClickSupplierCreate {
  name: string
  supplier_type: SupplierTypeForRegion
  org_number?: string
  vat_number?: string
  address_line1?: string
  country?: string
  iban?: string
  bic?: string
  bankgiro?: string
  plusgiro?: string
}

/** One supplier-invoice line as POST /items/:id/convert takes it. */
export interface OneClickInvoiceItem {
  description: string
  amount: number
  account_number: string
  vat_rate: number
  reverse_charge_rate?: number
}

/** The supplier invoice a register path registers: the convert body without its supplier. */
export interface OneClickInvoiceBody {
  supplier_invoice_number: string
  invoice_date: string
  due_date: string
  currency: string
  exchange_rate?: number
  reverse_charge: boolean
  reverse_charge_kind?: 'eu_services'
  vat_treatment?: 'reverse_charge'
  payment_reference?: string
  /** The document's VAT per rate, booked as stated (lib/vat/document-vat.ts). */
  vat_breakdown?: Array<{ vat_rate: number; vat_amount: number }>
  items: OneClickInvoiceItem[]
}

export interface OneClickPlan {
  form: OneClickForm | null
  /** The date of `lines`: the one verifikat, or the registration. */
  entryDate: string | null
  /** register_and_settle: the day the payment is booked, the bank row's. */
  paymentDate: string | null
  /** Balanced, in kronor; empty when nothing can be proposed (no category, no amount). */
  lines: OneClickLine[]
  transactionId: string | null
  supplier: { id: string } | { create: OneClickSupplierCreate } | null
  vat: OneClickVat
  ask: OneClickAsk | null
  reason: OneClickReason
  category: PurchaseCategoryCode | null
  costAccount: string | null
  seller: { country: string | null; region: SellerRegion | null }
  /** register and register_and_settle: the supplier invoice, as built here. */
  invoice: OneClickInvoiceBody | null
}

/** Card settlement lag: a bank row this many days after the invoice date is a payment at purchase. */
export const CARD_LAG_DAYS = 7
/** How far before the bank date the document's date may lie and still be the booking date. */
export const DOCUMENT_DATE_BEFORE_DAYS = 31
/** How far after the bank date it may lie (a receipt dated the next morning). */
export const DOCUMENT_DATE_AFTER_DAYS = 3

const STATUTORY_RATES = [0.25, 0.12, 0.06] as const

const INPUT_VAT_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'input_vat')
const PAYABLE_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable')

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function isoOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && ISO_DATE_RE.test(value) ? value : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A rate as the reading writes it (25, or 0.25), as a fraction. */
function fraction(rate: number): number {
  return Math.round((rate > 1 ? rate / 100 : rate) * 10_000) / 10_000
}

function statutory(rate: number): boolean {
  return (STATUTORY_RATES as readonly number[]).includes(rate)
}

/** The VAT the document states, per rate. */
interface DocumentVat {
  total: number
  groups: Array<{ rate: number; base: number | null; amount: number }>
  /** Lines at more than one rate and no breakdown saying how much at each. */
  mixedWithoutBreakdown: boolean
  /** A rate that is not 25, 12 or 6 %, or none that can be told. */
  unknownRate: boolean
}

function documentVat(reading: InvoiceExtractionResult): DocumentVat {
  const breakdown = (reading.vatBreakdown ?? []).flatMap((entry) => {
    const rate = finite(entry?.rate)
    const amount = finite(entry?.amount)
    if (rate === null || amount === null) return []
    return [{ rate: fraction(rate), base: finite(entry?.base), amount: roundOre(amount) }]
  })
  const charged = breakdown.filter((group) => group.amount > 0)
  if (charged.length > 0) {
    return {
      total: sumOre(charged.map((group) => group.amount)),
      groups: charged,
      mixedWithoutBreakdown: false,
      unknownRate: charged.some((group) => !statutory(group.rate)),
    }
  }

  const vat = roundOre(Math.max(0, finite(reading.totals?.vatAmount) ?? 0))
  const lineRates = new Set(
    (reading.lineItems ?? []).flatMap((line) => {
      const rate = finite(line?.vatRate)
      return rate === null || finite(line?.lineTotal) === 0 ? [] : [fraction(rate)]
    }),
  )
  if (vat === 0) return { total: 0, groups: [], mixedWithoutBreakdown: false, unknownRate: false }
  const charging = [...lineRates].filter((rate) => rate > 0)
  if (charging.length > 1 || (charging.length === 1 && lineRates.size > 1)) {
    return { total: vat, groups: [], mixedWithoutBreakdown: true, unknownRate: false }
  }
  const total = finite(reading.totals?.total)
  const net = finite(reading.totals?.subtotal) ?? (total !== null ? roundOre(total - vat) : null)
  let rate: number | null = charging[0] ?? null
  if (rate === null && net !== null && net > 0) {
    const implied = vat / net
    rate = STATUTORY_RATES.find((candidate) => Math.abs(candidate - implied) < 0.005) ?? null
  }
  return {
    total: vat,
    groups: [{ rate: rate ?? 0, base: net, amount: vat }],
    mixedWithoutBreakdown: false,
    unknownRate: rate === null || !statutory(rate),
  }
}

/**
 * The cost account of the category: the counterparty's booked account when
 * the category lists it, else the supplier's default account when it does,
 * else the category's usual account. Null for a category with no account in
 * the chart.
 */
export function costAccountFor(
  category: PurchaseCategoryCode,
  counterpartyAccount: string | null,
  supplierDefaultAccount: string | null,
): string | null {
  const belongs = (account: string | null): account is string =>
    !!account && SE_PURCHASE_CATEGORY_PACK.categoriesFor(account).includes(category)
  if (belongs(counterpartyAccount)) return counterpartyAccount
  if (belongs(supplierDefaultAccount)) return supplierDefaultAccount
  return SE_PURCHASE_CATEGORY_PACK.accountsFor(category)[0] ?? null
}

/** R4: the booking date of a purchase paid by `bankDate`. */
export function purchaseEntryDate(documentDate: string | null, bankDate: string, cashMethod: boolean): string {
  if (cashMethod || !documentDate) return bankDate
  const offset = daysBetween(documentDate, bankDate)
  return offset <= DOCUMENT_DATE_BEFORE_DAYS && offset >= -DOCUMENT_DATE_AFTER_DAYS ? documentDate : bankDate
}

function line(account: string, debit: number, credit: number, description: string): OneClickLine {
  return { account_number: account, debit_amount: roundOre(debit), credit_amount: roundOre(credit), description }
}

function reverseChargeLines(base: number, rate: number, kind: ReverseChargeKind, description: string): OneClickLine[] {
  return generateReverseChargePurchaseLines({ base, rate, kind }).map((l) =>
    line(l.account_number, l.debit_amount ?? 0, l.credit_amount ?? 0, description),
  )
}

function emptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function supplierToCreate(reading: InvoiceExtractionResult, region: SellerRegion, country: string | null): OneClickSupplierCreate | null {
  const supplier = reading.supplier
  const name = emptyString(supplier?.name)
  if (!name) return null
  return {
    name,
    supplier_type: supplierTypeForRegion(region),
    org_number: emptyString(supplier?.orgNumber),
    vat_number: emptyString(supplier?.vatNumber),
    address_line1: emptyString(supplier?.address)?.slice(0, 255),
    country: country ?? (region === 'se' ? 'SE' : undefined),
    iban: emptyString(supplier?.iban),
    bic: emptyString(supplier?.bic),
    bankgiro: emptyString(supplier?.bankgiro),
    plusgiro: emptyString(supplier?.plusgiro),
  }
}

type Situation =
  | { form: OneClickForm; reason: OneClickReason }
  | { form: null; reason: OneClickReason }

function situation(input: OneClickInput): Situation {
  const { kind, bank, reading } = input
  if (kind === 'credit_note') return { form: null, reason: 'credit_note' }
  if (!reading) return { form: null, reason: 'not_read' }
  if (bank) {
    if (bank.source === 'matched') return { form: 'direct', reason: 'linked' }
    if (kind !== 'supplier_invoice') return { form: 'direct', reason: 'receipt' }
    if (input.paidByReceipt) return { form: 'direct', reason: 'paid_by_receipt' }
    const invoiceDate = isoOrNull(reading.invoice?.invoiceDate)
    if (invoiceDate && daysBetween(invoiceDate, bank.date) > CARD_LAG_DAYS) {
      return input.company.supplierInvoices ? { form: 'register_and_settle', reason: 'paid_later' } : { form: 'direct', reason: 'paid_package_off' }
    }
    return { form: 'direct', reason: 'paid_at_purchase' }
  }
  if (kind === 'supplier_invoice' && !input.paidByReceipt) {
    if (!input.company.supplierInvoices) return { form: null, reason: 'package_off_unpaid' }
    if (input.company.cashMethod) return { form: null, reason: 'cash_method_unpaid' }
    return { form: 'register', reason: 'unpaid' }
  }
  return { form: null, reason: 'no_bank_row' }
}

type Vat =
  | { ok: true; vat: OneClickVat; groups: DocumentVat['groups'] }
  /** prefill: the VAT the editor opens with, when the document's own VAT is the person's starting point. */
  | { ok: false; ask: OneClickAsk; reason: OneClickReason; prefill?: OneClickVat }

/** R6: how the purchase's VAT is booked, or what to ask instead. */
function vatOf(input: OneClickInput, reading: InvoiceExtractionResult, category: PurchaseCategoryCode, region: SellerRegion): Vat {
  const doc = documentVat(reading)
  if (region === 'se') {
    const booked = swedishVat(input, reading, doc)
    // Representation, meals, a hired car, gifts: the deduction is the person's to work out,
    // starting from the document's VAT.
    if (deductionLimited(category)) {
      return { ok: false, ask: 'editor', reason: 'limited_deduction', ...(booked.ok ? { prefill: booked.vat } : {}) }
    }
    // Construction work with no VAT on it may be the buyer's to self-assess (ML 16 kap 13 §).
    if (booked.ok && booked.vat.kind === 'none' && DOMESTIC_REVERSE_CHARGE_CATEGORIES.has(category)) {
      return { ok: false, ask: 'editor', reason: 'possible_domestic_reverse_charge' }
    }
    return booked
  }
  return foreignVat(input, doc, category, region)
}

/** A Swedish seller's VAT as the document states it. */
function swedishVat(input: OneClickInput, reading: InvoiceExtractionResult, doc: DocumentVat): Vat {
  if (doc.total === 0) return { ok: true, vat: { kind: 'none' }, groups: [] }
  if (doc.mixedWithoutBreakdown) return { ok: false, ask: 'editor', reason: 'mixed_rates' }
  const total = finite(reading.totals?.total)
  const net = finite(reading.totals?.subtotal) ?? (total !== null ? roundOre(total - doc.total) : null)
  if (net !== null && doc.total > roundOre(net * 0.25) + 0.01) return { ok: false, ask: 'editor', reason: 'vat_exceeds_rate' }
  if (doc.unknownRate) return { ok: false, ask: 'editor', reason: 'vat_rate_unknown' }
  if (!isKronorCurrency(reading.invoice?.currency)) return { ok: false, ask: 'editor', reason: 'foreign_currency_vat' }
  if (isNotVatRegistered(input.company.vatRegistered)) return { ok: true, vat: { kind: 'cost', amount: doc.total }, groups: doc.groups }
  return { ok: true, vat: { kind: 'input', amount: doc.total, rates: doc.groups.map((g) => g.rate) }, groups: doc.groups }
}

/** A seller abroad: omvänd betalningsskyldighet for a service, else the editor. */
function foreignVat(input: OneClickInput, doc: DocumentVat, category: PurchaseCategoryCode, region: SellerRegion): Vat {
  // Abroad: Swedish VAT is never deducted from a foreign seller's invoice.
  if (doc.total > 0) return { ok: false, ask: 'editor', reason: 'foreign_vat' }
  const nature = purchaseVatNature(category)
  if (nature === 'goods') return { ok: false, ask: 'editor', reason: 'goods_abroad' }
  if (nature === 'exception') return { ok: false, ask: 'editor', reason: 'exception_abroad' }
  if (nature === 'unknown') return { ok: false, ask: 'editor', reason: 'unknown_nature_abroad' }
  if (isNotVatRegistered(input.company.vatRegistered)) return { ok: false, ask: 'editor', reason: 'not_vat_registered_abroad' }
  const rcKind: ReverseChargeKind = region === 'eu' ? 'eu_services' : 'non_eu_services'
  return { ok: true, vat: { kind: 'reverse_charge', rcKind, rate: resolveReverseChargeRate({}) }, groups: [] }
}

/** The one verifikat of a purchase paid from the bank row: cost, VAT, the bank's account. */
function paidLines(gross: number, vat: OneClickVat, costAccount: string, settlementAccount: string, description: string): OneClickLine[] {
  if (vat.kind === 'input') {
    return [
      line(costAccount, gross - vat.amount, 0, description),
      line(INPUT_VAT_ACCOUNT, vat.amount, 0, description),
      line(settlementAccount, 0, gross, description),
    ]
  }
  const lines = [line(costAccount, gross, 0, description), line(settlementAccount, 0, gross, description)]
  if (vat.kind === 'reverse_charge') lines.push(...reverseChargeLines(gross, vat.rate, vat.rcKind, description))
  return lines
}

/** The kronor value of an amount in the invoice's currency. */
function inKronor(amount: number, rate: number): number {
  return roundOre(amount * rate)
}

type InvoiceBuild = { ok: true; invoice: OneClickInvoiceBody; lines: OneClickLine[] } | { ok: false; reason: OneClickReason }

/**
 * The supplier invoice a register path registers, and its registration
 * verifikat (cost, VAT, 2440) in kronor. One line per VAT rate the document
 * states; under omvänd betalningsskyldighet one line at 0 % with the
 * self-assessed rate. The amounts must add up to the document's total, to
 * the öre: anything else is the form's to settle.
 */
function invoiceOf(
  input: OneClickInput,
  form: 'register' | 'register_and_settle',
  reading: InvoiceExtractionResult,
  vat: OneClickVat,
  groups: DocumentVat['groups'],
  costAccount: string,
  description: string,
): InvoiceBuild {
  const invoiceNumber = emptyString(reading.invoice?.invoiceNumber)
  const invoiceDate = isoOrNull(reading.invoice?.invoiceDate)
  if (!invoiceDate) return { ok: false, reason: 'missing_invoice_date' }
  if (!invoiceNumber) return { ok: false, reason: 'missing_invoice_number' }
  let dueDate = isoOrNull(reading.invoice?.dueDate)
  if (!dueDate) {
    // Unpaid, the due date is the person's to read off the invoice (R3).
    // Paid already, it is moot: the supplier's terms, as every inbox door
    // defaults it (the MCP door's rule).
    if (form === 'register') return { ok: false, reason: 'missing_due_date' }
    dueDate = addDaysIso(invoiceDate, input.supplier?.paymentTermsDays ?? 30)
  }
  const currency = (reading.invoice?.currency || '').trim().toUpperCase() || 'SEK'
  const foreign = !isKronorCurrency(currency)
  if (foreign && !(input.invoiceRate && input.invoiceRate > 0)) return { ok: false, reason: 'fx_rate_missing' }
  const rate = foreign ? (input.invoiceRate as number) : 1

  const total = finite(reading.totals?.total)
  const items: OneClickInvoiceItem[] = []
  // The VAT of each item: the document's own figure for its rate (one item
  // per rate), else net x rate.
  const itemVat: number[] = []
  if (vat.kind === 'reverse_charge') {
    if (total === null || !(total > 0)) return { ok: false, reason: 'no_amount' }
    items.push({ description, amount: roundOre(total), account_number: costAccount, vat_rate: 0, reverse_charge_rate: vat.rate })
  } else if (vat.kind === 'none') {
    if (total === null || !(total > 0)) return { ok: false, reason: 'no_amount' }
    items.push({ description, amount: roundOre(total), account_number: costAccount, vat_rate: 0 })
  } else {
    for (const group of groups) {
      const base = group.base ?? (total !== null ? roundOre(total - group.amount) : null)
      if (base === null || !(base > 0)) return { ok: false, reason: 'no_amount' }
      // The registration books the document's VAT for the rate (vat_breakdown),
      // which must be the net x rate within the öre a seller's rounding allows.
      if (Math.abs(roundOre(base * group.rate) - group.amount) > 0.01) return { ok: false, reason: 'amount_mismatch' }
      items.push({ description, amount: roundOre(base), account_number: costAccount, vat_rate: group.rate })
      itemVat.push(group.amount)
    }
  }
  const vatOf = (index: number) => itemVat[index] ?? roundOre(items[index].amount * items[index].vat_rate)
  const registeredTotal = sumOre(items.map((item, index) => item.amount + (vat.kind === 'reverse_charge' ? 0 : vatOf(index))))
  if (total !== null && Math.abs(registeredTotal - total) > 0.01) return { ok: false, reason: 'amount_mismatch' }

  const invoice: OneClickInvoiceBody = {
    supplier_invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    due_date: dueDate,
    currency,
    ...(foreign ? { exchange_rate: rate } : {}),
    reverse_charge: vat.kind === 'reverse_charge',
    ...(vat.kind === 'reverse_charge' ? { vat_treatment: 'reverse_charge' as const } : {}),
    ...(vat.kind === 'reverse_charge' && vat.rcKind === 'eu_services' ? { reverse_charge_kind: 'eu_services' as const } : {}),
    ...(emptyString(reading.invoice?.paymentReference) ? { payment_reference: emptyString(reading.invoice?.paymentReference) } : {}),
    ...(itemVat.length > 0
      ? { vat_breakdown: items.map((item, index) => ({ vat_rate: item.vat_rate, vat_amount: itemVat[index] })) }
      : {}),
    items,
  }

  // The registration verifikat, in kronor.
  const net = sumOre(items.map((item) => inKronor(item.amount, rate)))
  const vatSek = vat.kind === 'input' || vat.kind === 'cost' ? sumOre(items.map((_item, index) => inKronor(vatOf(index), rate))) : 0
  const lines: OneClickLine[] =
    vat.kind === 'input'
      ? [line(costAccount, net, 0, description), line(INPUT_VAT_ACCOUNT, vatSek, 0, description), line(PAYABLE_ACCOUNT, 0, net + vatSek, description)]
      : [line(costAccount, net + vatSek, 0, description), line(PAYABLE_ACCOUNT, 0, net + vatSek, description)]
  if (vat.kind === 'reverse_charge') lines.push(...reverseChargeLines(net, vat.rate, vat.rcKind, description))
  return { ok: true, invoice, lines }
}

/**
 * What one plan came to, in codes only: never an amount, a name or a
 * document's text. One log line per read of the plan, so how often the
 * page's one click books, asks or opens the editor, and why, can be counted.
 */
export interface OneClickOutcome {
  /** The plan books with nothing asked. */
  oneClick: boolean
  form: OneClickForm | null
  ask: OneClickAsk | null
  reason: OneClickReason
  vat: OneClickVat['kind']
  category: PurchaseCategoryCode | null
  region: SellerRegion | null
  bank: OneClickBankRow['source'] | 'none'
  kind: InboxDocumentKind | null
  /** What the person had answered on the page when this plan was read. */
  answered: { category: boolean; seller: boolean }
}

export function oneClickOutcome(
  input: OneClickInput,
  plan: OneClickPlan,
  answered: { category: boolean; seller: boolean },
): OneClickOutcome {
  return {
    oneClick: plan.form !== null && plan.ask === null,
    form: plan.form,
    ask: plan.ask,
    reason: plan.reason,
    vat: plan.vat.kind,
    category: plan.category,
    region: plan.seller.region,
    bank: input.bank?.source ?? 'none',
    kind: input.kind,
    answered,
  }
}

export function planOneClick(input: OneClickInput): OneClickPlan {
  const at = situation(input)
  const reading = input.reading
  const transactionId = input.bank?.transactionId ?? null
  const plan: OneClickPlan = {
    form: at.form,
    entryDate: null,
    paymentDate: null,
    lines: [],
    transactionId: at.form === 'register' ? null : transactionId,
    supplier: input.supplier ? { id: input.supplier.id } : null,
    vat: { kind: 'none' },
    ask: null,
    reason: at.reason,
    category: input.category,
    costAccount: null,
    seller: { country: null, region: null },
    invoice: null,
  }
  if (!at.form || !reading) return plan
  const ask = (what: OneClickAsk, reason: OneClickReason): OneClickPlan => Object.assign(plan, { ask: what, reason })
  const description = reading.supplier?.name?.trim() ?? ''
  const bank = input.bank

  // The money: a purchase paid from the bank is the row's kronor, out.
  let gross: number | null = null
  if (at.form !== 'register' && bank) {
    if (bank.amountSek === null) return ask('editor', 'no_kronor_amount')
    if (!(bank.amountSek < 0)) return ask('editor', 'not_money_out')
    gross = roundOre(Math.abs(bank.amountSek))
  }

  // Dates (R4).
  const invoiceDate = isoOrNull(reading.invoice?.invoiceDate)
  if (at.form === 'direct' && bank) {
    plan.entryDate = purchaseEntryDate(invoiceDate ?? isoOrNull(input.receiptDate), bank.date, input.company.cashMethod)
  } else if (at.form === 'register_and_settle' && bank) {
    plan.entryDate = input.company.cashMethod ? bank.date : invoiceDate
    plan.paymentDate = bank.date
  } else if (at.form === 'register') {
    plan.entryDate = invoiceDate
  }

  // What was bought, and so the account (R5).
  if (!input.category) return ask('category', 'no_category')
  const costAccount = costAccountFor(input.category, input.counterpartyAccount, input.supplier?.defaultExpenseAccount ?? null)
  if (!costAccount) return ask('editor', 'no_category')
  plan.costAccount = costAccount
  // Until the VAT is settled, the editor opens with the cost and the bank's account.
  if (gross !== null && bank) {
    plan.lines = [line(costAccount, gross, 0, description), line(bank.settlementAccount, 0, gross, description)]
  }

  // Where the seller is (R6).
  const read = sellerCountry(reading.supplier)
  let region = read.region
  if (!region) {
    const vatOnDocument = documentVat(reading).total > 0
    const foreign = looksForeign({ currency: reading.invoice?.currency, address: reading.supplier?.address })
    if (foreign) {
      if (vatOnDocument) return ask('editor', 'foreign_vat_unknown_country')
      region = input.sellerRegionAnswer
      if (!region) return ask('seller_country', 'seller_country_unknown')
    } else {
      region = 'se'
    }
  }
  plan.seller = { country: read.country, region }

  const vat = vatOf(input, reading, input.category, region)
  if (!vat.ok) {
    if (vat.prefill && gross !== null && bank) {
      plan.vat = vat.prefill
      plan.lines = paidLines(gross, vat.prefill, costAccount, bank.settlementAccount, description)
    }
    return ask(vat.ask, vat.reason)
  }
  plan.vat = vat.vat

  // Equipment above half a prisbasbelopp is an inventarie to capitalise, not a cost (IL 18 kap. 4 §).
  // A register path in a foreign currency is judged once its kronor are known (the fx re-plan).
  if (CAPITALISABLE_CATEGORIES.has(input.category)) {
    const total = finite(reading.totals?.total)
    const kronor =
      gross ?? (total === null ? null : isKronorCurrency(reading.invoice?.currency) ? total : input.invoiceRate ? total * input.invoiceRate : null)
    const year = Number((plan.entryDate ?? bank?.date ?? '').slice(0, 4))
    if (kronor !== null && kronor > getCapitalizationThreshold(year)) return ask('editor', 'possible_asset')
  }

  // A paid purchase whose document is in kronor must be what the bank paid (an öresavrundning aside).
  if (gross !== null && isKronorCurrency(reading.invoice?.currency)) {
    const total = finite(reading.totals?.total)
    if (total !== null && Math.abs(total - gross) > ORE_ROUNDING_SETTLEMENT_MAX) return ask('editor', 'amount_mismatch')
  }

  // The supplier a register path needs (R8): matched, else created from the reading. A
  // registration's VAT follows its supplier's type, so a card typed for another country
  // than the document's is the person's to settle in the form.
  if (at.form !== 'direct' && input.supplier && input.supplier.supplierType !== supplierTypeForRegion(region)) {
    return ask('editor', 'supplier_type_mismatch')
  }
  if (at.form !== 'direct' && !input.supplier) {
    const create = supplierToCreate(reading, region, read.country)
    if (!create) return ask('editor', 'missing_supplier_name')
    plan.supplier = { create }
  }

  if (at.form === 'direct' || (at.form === 'register_and_settle' && input.company.cashMethod)) {
    if (gross === null || !bank) return ask('editor', 'no_amount')
    plan.lines = paidLines(gross, vat.vat, costAccount, bank.settlementAccount, description)
  }
  if (at.form !== 'direct') {
    const built = invoiceOf(input, at.form, reading, vat.vat, vat.groups, costAccount, description)
    if (!built.ok) return ask('editor', built.reason)
    plan.invoice = built.invoice
    if (!(at.form === 'register_and_settle' && input.company.cashMethod)) plan.lines = built.lines
    // A paid invoice in kronor must be what the bank paid, to the öre: the settlement clears it whole.
    if (at.form === 'register_and_settle' && gross !== null && isKronorCurrency(built.invoice.currency)) {
      const payable = sumOre(
        built.invoice.items.map((item) => item.amount + (built.invoice.reverse_charge ? 0 : roundOre(item.amount * item.vat_rate))),
      )
      if (Math.abs(payable - gross) > 0.01) return ask('editor', 'amount_mismatch')
    }
  }
  // The company's and the rule's say, last: the editor opens on the whole plan.
  if (askedForReview({ rule_always_review: input.counterpartyAlwaysReview, review_blocked: planBlocked(plan.lines, input.bookingReview) }, input.directBooking ?? DIRECT_BOOKING_ON)) {
    return ask('editor', 'review_required')
  }
  return plan
}

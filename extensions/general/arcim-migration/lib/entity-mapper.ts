/**
 * Maps Arcim Sync canonical DTOs to Accounted internal types.
 *
 * These mappers transform the normalized data from any Swedish accounting
 * provider into the exact shapes Accounted expects for database insertion.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { encryptCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { normalizeVatRateToFraction } from '@/lib/vat/vat-rate-unit'
import type { Currency, CustomerType, ExchangeRate, SupplierType, VatTreatment } from '@/types'
import type {
  CustomerDto,
  SupplierDto,
  SalesInvoiceDto,
  SalesInvoiceLineDto,
  SupplierInvoiceDto,
  SupplierInvoiceLineDto,
  CompanyInformationDto,
  PostalAddress,
  PartyDto,
} from '@/lib/providers/dto'

// ── Helpers ─────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function formatAddress(addr?: PostalAddress): {
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string | null
} {
  if (!addr) {
    return { address_line1: null, address_line2: null, postal_code: null, city: null, country: null }
  }
  const line1 = [addr.streetName, addr.buildingNumber].filter(Boolean).join(' ') || null
  return {
    address_line1: line1,
    address_line2: addr.additionalStreetName || null,
    postal_code: addr.postalZone || null,
    city: addr.cityName || null,
    country: addr.countryCode || null,
  }
}

function getOrgNumber(party: PartyDto): string | null {
  // Look for SE:ORGNR scheme first, then companyId in legalEntity
  const seOrg = party.identifications?.find(i => i.schemeId === 'SE:ORGNR')
  if (seOrg) return seOrg.id
  return party.legalEntity?.companyId || null
}

const EU_COUNTRIES = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SI', 'SK']

/**
 * Check if a string looks like a Swedish org number (XXXXXX-XXXX or 10 digits).
 * Swedish org numbers are 10 digits where the third digit is >= 2 (to distinguish
 * from personal numbers where month 01-12 appears in positions 3-4).
 */
function looksLikeSwedishOrgNumber(orgNumber: string | null | undefined): boolean {
  if (!orgNumber) return false
  const digits = orgNumber.replace(/[-\s]/g, '')
  if (digits.length !== 10 || !/^\d+$/.test(digits)) return false
  // Third digit >= 2 distinguishes org numbers from personal numbers
  const thirdDigit = parseInt(digits[2], 10)
  return thirdDigit >= 2
}

/**
 * Check if a string looks like a Swedish identity number: an organisation
 * number or personnummer in 10-digit form, or a personnummer in the 12-digit
 * century-prefixed form (19xx / 20xx). Used to avoid misclassifying a domestic
 * party as foreign just because its number isn't exactly 10 digits: a 12-digit
 * personnummer like 19700616-7113 is Swedish, not an unknown foreign org number.
 */
function looksLikeSwedishIdNumber(orgNumber: string | null | undefined): boolean {
  if (!orgNumber) return false
  const digits = orgNumber.replace(/[-+\s]/g, '')
  if (!/^\d+$/.test(digits)) return false
  if (digits.length === 10) return true
  return digits.length === 12 && /^(19|20)/.test(digits)
}

/**
 * Company name suffixes that indicate a foreign (non-Swedish) entity.
 * These override the default swedish_business assumption when no other
 * signals (VAT, country code, org number) are available.
 */
const FOREIGN_SUFFIXES: { suffix: string; region: 'eu' | 'non_eu' }[] = [
  // German
  { suffix: 'gmbh', region: 'eu' },
  { suffix: 'ag', region: 'eu' },
  { suffix: 'e.v.', region: 'eu' },
  { suffix: 'ohg', region: 'eu' },
  { suffix: 'kg', region: 'eu' },
  { suffix: 'ug', region: 'eu' },
  // French
  { suffix: 'sarl', region: 'eu' },
  { suffix: 's.a.r.l.', region: 'eu' },
  { suffix: 'sas', region: 'eu' },
  // Dutch/Belgian
  { suffix: 'b.v.', region: 'eu' },
  { suffix: 'n.v.', region: 'eu' },
  { suffix: 'bv', region: 'eu' },
  { suffix: 'nv', region: 'eu' },
  // Spanish/Italian
  { suffix: 's.l.', region: 'eu' },
  { suffix: 's.r.l.', region: 'eu' },
  // Finnish
  { suffix: 'oy', region: 'eu' },
  { suffix: 'oyj', region: 'eu' },
  // Danish/Norwegian
  { suffix: 'a/s', region: 'eu' },
  { suffix: 'aps', region: 'eu' },
  // Anglo (could be UK, US, etc.: treat as non-EU since UK left)
  { suffix: 'ltd', region: 'non_eu' },
  { suffix: 'limited', region: 'non_eu' },
  { suffix: 'llc', region: 'non_eu' },
  { suffix: 'inc', region: 'non_eu' },
  { suffix: 'corp', region: 'non_eu' },
  { suffix: 'plc', region: 'non_eu' },
  // Irish (EU)
  { suffix: 'dac', region: 'eu' },
]

function inferRegionFromName(name: string | undefined): 'eu' | 'non_eu' | null {
  if (!name) return null
  const lower = name.toLowerCase().trim()
  for (const { suffix, region } of FOREIGN_SUFFIXES) {
    // Match as a word boundary at the end: "Acme GmbH" but not "Gmbhsson"
    if (lower.endsWith(suffix) || lower.endsWith(suffix + '.')) {
      // Check that there's a space or start before the suffix
      const pos = lower.lastIndexOf(suffix)
      if (pos === 0 || lower[pos - 1] === ' ') {
        return region
      }
    }
  }
  return null
}

function inferTypeFromVatOrCountry(
  vatNumber: string | undefined,
  countryCode: string | undefined,
  orgNumber?: string | null,
  companyName?: string
): 'swedish_business' | 'eu_business' | 'non_eu_business' {
  // 1. VAT number prefix is the strongest signal
  if (vatNumber) {
    const prefix = vatNumber.substring(0, 2).toUpperCase()
    if (prefix === 'SE') return 'swedish_business'
    if (EU_COUNTRIES.includes(prefix)) return 'eu_business'
    return 'non_eu_business'
  }

  // 2. Explicit country code
  const country = countryCode?.toUpperCase()
  if (country === 'SE') return 'swedish_business'
  if (country && EU_COUNTRIES.includes(country)) return 'eu_business'
  if (country) return 'non_eu_business'

  // 3. Swedish-format org number is strong evidence of domestic entity
  if (looksLikeSwedishOrgNumber(orgNumber)) return 'swedish_business'

  // 4. A number that isn't a Swedish-format identity number → foreign entity.
  //    Accepts both 10-digit and 12-digit (century-prefixed) Swedish numbers so
  //    a domestic personnummer like 19700616-7113 isn't treated as foreign.
  if (orgNumber) {
    const digits = orgNumber.replace(/[-+\s]/g, '')
    if (digits.length > 0 && !looksLikeSwedishIdNumber(orgNumber)) {
      // Not a Swedish number: use name heuristic or default to non_eu
      const nameRegion = inferRegionFromName(companyName)
      if (nameRegion === 'eu') return 'eu_business'
      return 'non_eu_business'
    }
  }

  // 5. Company name suffix heuristic (GmbH, Ltd, etc.)
  const nameRegion = inferRegionFromName(companyName)
  if (nameRegion === 'eu') return 'eu_business'
  if (nameRegion === 'non_eu') return 'non_eu_business'

  // 6. No signal at all: default to swedish_business (most common in Swedish systems)
  return 'swedish_business'
}

function inferCustomerType(dto: CustomerDto): CustomerType {
  if (dto.type === 'private') return 'individual'
  return inferTypeFromVatOrCountry(
    dto.vatNumber,
    dto.party.postalAddress?.countryCode,
    getOrgNumber(dto.party),
    dto.party.name
  )
}

function inferSupplierType(dto: SupplierDto): SupplierType {
  return inferTypeFromVatOrCountry(
    dto.vatNumber,
    dto.party.postalAddress?.countryCode,
    getOrgNumber(dto.party),
    dto.party.name
  )
}

/**
 * Infer customer/supplier type from a PartyDto (used by orchestrator for
 * minimal entity creation from invoice data).
 */
export function inferTypeFromParty(
  party: PartyDto,
  vatNumber?: string
): 'swedish_business' | 'eu_business' | 'non_eu_business' {
  return inferTypeFromVatOrCountry(
    vatNumber,
    party.postalAddress?.countryCode,
    getOrgNumber(party),
    party.name
  )
}

function inferVatTreatment(taxPercent?: number, currencyCode?: string): VatTreatment {
  if (taxPercent === 25) return 'standard_25'
  if (taxPercent === 12) return 'reduced_12'
  if (taxPercent === 6) return 'reduced_6'
  if (taxPercent === 0 && currencyCode && currencyCode !== 'SEK') return 'export'
  return 'standard_25'
}

function inferVatRate(taxPercent?: number): number {
  if (taxPercent === 25 || taxPercent === 12 || taxPercent === 6) return taxPercent
  if (taxPercent === 0) return 0
  return 25 // Default to standard rate
}

// ── Currency conversion ─────────────────────────────────────────────
//
// The provider DTOs (lib/providers/dto.ts) carry NO exchange rate and NO SEK
// amount: an invoice exposes only `currencyCode` plus amounts already expressed
// in that currency. So for a foreign-currency document the SEK value has to be
// established here, at import, from the rate that was valid on the document's
// OWN date. An imported invoice is räkenskapsinformation (BFL 7 kap): its SEK
// value is part of the record, and stamping it with today's rate, or with a
// fabricated 1:1, would misstate it.
//
// Same pattern as lib/transactions/ingest.ts: pre-resolve the unique
// (currency, date) pairs once through fetchExchangeRate WITH the supabase
// client (so the shared `exchange_rates` cache absorbs repeat dates) and WITH
// the document date, then map synchronously against that index.

/**
 * Currencies Riksbanken publishes a series for (SERIES_IDS in
 * lib/currency/riksbanken.ts). A document in any other currency has no rate
 * source at all, so it is reported rather than written with a silent null.
 */
const CONVERTIBLE_CURRENCIES: readonly Currency[] = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']

/** Riksbanken fan-out bound, mirroring ingest.ts: a wide historical backfill
 *  used to fire every pair at once and get the whole batch rate-limited. */
const FX_FETCH_CONCURRENCY = 4

function asConvertibleCurrency(code: string | undefined | null): Currency | null {
  if (!code) return null
  const upper = code.toUpperCase() as Currency
  return CONVERTIBLE_CURRENCIES.includes(upper) ? upper : null
}

/** Normalize a DTO date to a plain ISO day, or null when it isn't one. */
function isoDay(value: string | undefined | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null
  return value.slice(0, 10)
}

/** Pre-resolved rates, keyed by `${CURRENCY}|${YYYY-MM-DD}`. */
export type FxRateIndex = Map<string, ExchangeRate>

export function fxRateKey(currencyCode: string, isoDate: string): string {
  return `${currencyCode.toUpperCase()}|${isoDate}`
}

/** Why a foreign-currency document could not be converted to SEK. */
export type FxUnresolvedReason =
  /** Currency outside Riksbanken's published series: no rate source exists. */
  | 'unsupported_currency'
  /** Rate source exists but no observation could be obtained for that date. */
  | 'rate_unavailable'

export interface FxUnresolved {
  currency: string
  /** The document's own date, i.e. the date a rate was needed for. */
  date: string
  reason: FxUnresolvedReason
}

interface FxResolution {
  /** null for SEK documents (no rate applies) and for unconvertible ones. */
  rate: number | null
  /** Riksbanken observation date behind `rate`; null when there is no rate. */
  rateDate: string | null
  /** Factor to reach SEK: 1 for SEK documents, `rate` otherwise, null when
   *  the conversion could not be established at all. */
  sekFactor: number | null
  /** Set ONLY when a foreign document could not be converted. */
  unresolved: FxUnresolved | null
}

/**
 * Fetch the rate valid on each document's own date, once per unique
 * (currency, date) pair. SEK documents need no rate and are skipped.
 *
 * A pair that cannot be fetched is simply absent from the index; the mapper
 * then reports that document as unresolved rather than inventing a number.
 */
export async function buildFxRateIndex(
  supabase: SupabaseClient,
  documents: { currencyCode?: string; issueDate?: string }[],
): Promise<FxRateIndex> {
  const index: FxRateIndex = new Map()

  const pairs = new Map<string, { currency: Currency; date: string }>()
  for (const doc of documents) {
    const currency = asConvertibleCurrency(doc.currencyCode)
    if (!currency || currency === 'SEK') continue
    const date = isoDay(doc.issueDate)
    if (!date) continue
    const key = fxRateKey(currency, date)
    if (!pairs.has(key)) pairs.set(key, { currency, date })
  }
  if (pairs.size === 0) return index

  const entries = [...pairs.entries()]
  for (let i = 0; i < entries.length; i += FX_FETCH_CONCURRENCY) {
    const slice = entries.slice(i, i + FX_FETCH_CONCURRENCY)
    const settled = await Promise.allSettled(
      slice.map(([, { currency, date }]) => fetchExchangeRate(currency, new Date(date), supabase)),
    )
    for (let j = 0; j < slice.length; j++) {
      const outcome = settled[j]
      if (outcome.status === 'fulfilled' && outcome.value && outcome.value.rate > 0) {
        index.set(slice[j][0], outcome.value)
      }
      // A miss deliberately leaves the key unset: never a made-up rate.
    }
  }

  return index
}

/**
 * Resolve the SEK conversion for one document.
 *
 * `rates` is optional so existing callers keep compiling; when it is omitted a
 * foreign document resolves to `rate_unavailable` (reported), never to a
 * silent 1:1. Only an actually-fetched positive rate produces a conversion.
 */
function resolveFx(
  currencyCode: string | undefined,
  issueDate: string | undefined,
  rates?: FxRateIndex,
): FxResolution {
  const code = (currencyCode || 'SEK').toUpperCase()

  if (code === 'SEK') {
    // Domestic document: the ledger currency IS SEK, so there is no exchange
    // rate to record. A plain null, not a conversion we failed to make. The
    // SEK amount columns still get filled, via sekFactor 1.
    return { rate: null, rateDate: null, sekFactor: 1, unresolved: null }
  }

  const currency = asConvertibleCurrency(code)
  if (!currency) {
    return {
      rate: null, rateDate: null, sekFactor: null,
      unresolved: { currency: code, date: isoDay(issueDate) ?? '', reason: 'unsupported_currency' },
    }
  }

  const date = isoDay(issueDate)
  if (!date) {
    return {
      rate: null, rateDate: null, sekFactor: null,
      unresolved: { currency: code, date: issueDate ?? '', reason: 'rate_unavailable' },
    }
  }

  const hit = rates?.get(fxRateKey(currency, date))
  if (!hit || !(hit.rate > 0)) {
    return {
      rate: null, rateDate: null, sekFactor: null,
      unresolved: { currency: code, date, reason: 'rate_unavailable' },
    }
  }

  return { rate: hit.rate, rateDate: hit.date, sekFactor: hit.rate, unresolved: null }
}

/** Convert to SEK, or null when no conversion could be established. */
function toSek(amount: number, sekFactor: number | null): number | null {
  return sekFactor === null ? null : round2(amount * sekFactor)
}

/**
 * A mapped invoice plus the FX verdict for it. `fxUnresolved` is non-null only
 * for a FOREIGN document whose SEK value could not be established: the caller
 * must surface those as needing attention instead of letting them pass as
 * ordinary imports. They are still imported (dropping them would lose
 * räkenskapsinformation) but carry exchange_rate = null, so every booking path
 * refuses them loudly (SupplierInvoiceFxRateMissingError /
 * InvoiceBookingRateMissingError) rather than posting at a fabricated 1:1.
 */
export interface MappedInvoice {
  invoice: Record<string, unknown>
  items: Record<string, unknown>[]
  fxUnresolved: FxUnresolved | null
}

// ── Public mappers ──────────────────────────────────────────────────

export function mapCustomer(dto: CustomerDto, userId: string, companyId: string): Record<string, unknown> {
  const addr = formatAddress(dto.party.postalAddress)
  const customerType = inferCustomerType(dto)
  const number = getOrgNumber(dto.party)
  // The provider exposes a single identity-number field, but Accounted stores a
  // personnummer in `personal_number` (individuals) and an org number in
  // `org_number` (businesses). Route it to the column the type expects: else a
  // Privatperson's personnummer lands in org_number and is hidden by the
  // individual customer form, which renders personal_number for individuals.
  const isIndividual = customerType === 'individual'
  // personal_number is an encrypted column: customers_personal_number_check
  // (migration 20260726110000) accepts AES-256-GCM hex and nothing else, so
  // writing the identity number in plaintext here aborts the whole import with
  // 23514 the moment a Privatperson appears in the source data.
  return {
    user_id: userId,
    company_id: companyId,
    name: dto.party.name,
    customer_type: customerType,
    email: dto.party.contact?.email || null,
    phone: dto.party.contact?.telephone || null,
    ...addr,
    org_number: isIndividual ? null : number,
    personal_number: isIndividual ? encryptCustomerPersonalNumber(number) : null,
    vat_number: dto.vatNumber || null,
    vat_number_validated: false,
    default_payment_terms: dto.defaultPaymentTermsDays || 30,
    notes: dto.note || null,
  }
}

export function mapSupplier(dto: SupplierDto, userId: string, companyId: string): Record<string, unknown> {
  const addr = formatAddress(dto.party.postalAddress)
  return {
    user_id: userId,
    company_id: companyId,
    name: dto.party.name,
    supplier_type: inferSupplierType(dto),
    email: dto.party.contact?.email || null,
    phone: dto.party.contact?.telephone || null,
    ...addr,
    org_number: getOrgNumber(dto.party),
    vat_number: dto.vatNumber || null,
    bankgiro: dto.bankGiro || null,
    plusgiro: dto.plusGiro || null,
    bank_account: dto.bankAccount || null,
    // SupplierDto carries bankAccount/bankGiro/plusGiro only: it has no IBAN,
    // BIC or default expense account, so these are honest nulls, not dropped
    // data. The user fills them in when a foreign payment first needs them.
    iban: null,
    bic: null,
    default_expense_account: null,
    default_payment_terms: dto.defaultPaymentTermsDays || 30,
    default_currency: 'SEK',
    notes: dto.note || null,
  }
}

export function mapSalesInvoice(
  dto: SalesInvoiceDto,
  userId: string,
  companyId: string,
  customerId: string,
  fxRates?: FxRateIndex
): MappedInvoice {
  const subtotal = round2(dto.legalMonetaryTotal.lineExtensionAmount.value)
  const total = round2(dto.legalMonetaryTotal.payableAmount.value)
  const vatAmount = round2(dto.taxTotal?.taxAmount.value ?? (total - subtotal))

  // Determine primary VAT treatment from first line with tax
  const primaryTaxPercent = dto.lines.find(l => l.taxPercent != null)?.taxPercent
  const vatTreatment = inferVatTreatment(primaryTaxPercent, dto.currencyCode)

  // Map Arcim status to Accounted status
  const statusMap: Record<string, string> = {
    draft: 'draft',
    sent: 'sent',
    booked: 'sent', // Accounted has no 'booked' status: treat as sent
    paid: 'paid',
    overdue: 'overdue',
    cancelled: 'cancelled',
    credited: 'credited',
  }

  const isCreditNote = dto.invoiceTypeCode === '381'

  // SEK value of a foreign invoice, at the rate valid on its own issue date.
  const fx = resolveFx(dto.currencyCode, dto.issueDate, fxRates)

  const invoice: Record<string, unknown> = {
    user_id: userId,
    company_id: companyId,
    customer_id: customerId,
    invoice_number: dto.invoiceNumber,
    invoice_date: dto.issueDate,
    due_date: dto.dueDate || dto.issueDate,
    status: statusMap[dto.status] || 'sent',
    currency: dto.currencyCode || 'SEK',
    // null for a SEK invoice (no rate applies) and for a foreign invoice whose
    // rate could not be established: that case is reported via fxUnresolved.
    exchange_rate: fx.rate,
    exchange_rate_date: fx.rateDate,
    subtotal,
    subtotal_sek: toSek(subtotal, fx.sekFactor),
    vat_amount: vatAmount,
    vat_amount_sek: toSek(vatAmount, fx.sekFactor),
    total,
    total_sek: toSek(total, fx.sekFactor),
    vat_treatment: vatTreatment,
    vat_rate: inferVatRate(primaryTaxPercent),
    your_reference: null,
    our_reference: null,
    notes: dto.note || null,
    document_type: isCreditNote ? 'credit_note' : 'invoice',
    paid_at: dto.paymentStatus.paid ? dto.paymentStatus.lastPaymentDate || dto.issueDate : null,
    paid_amount: dto.paymentStatus.paid ? total : round2(total - dto.paymentStatus.balance.value),
  }

  const items = dto.lines.map((line, idx) => mapSalesInvoiceLine(line, idx))

  return { invoice, items, fxUnresolved: fx.unresolved }
}

function mapSalesInvoiceLine(line: SalesInvoiceLineDto, index: number): Record<string, unknown> {
  return {
    sort_order: index + 1,
    description: line.description || line.itemName || '',
    quantity: line.quantity || 1,
    unit: line.unitCode || 'st',
    unit_price: round2(line.unitPrice?.value ?? line.lineExtensionAmount.value),
    line_total: round2(line.lineExtensionAmount.value),
    vat_rate: inferVatRate(line.taxPercent),
    vat_amount: round2(line.taxAmount?.value ?? 0),
  }
}

export function mapSupplierInvoice(
  dto: SupplierInvoiceDto,
  userId: string,
  companyId: string,
  supplierId: string,
  fxRates?: FxRateIndex
): MappedInvoice {
  const subtotal = round2(dto.legalMonetaryTotal.lineExtensionAmount.value)
  const total = round2(dto.legalMonetaryTotal.payableAmount.value)
  const vatAmount = round2(dto.taxTotal?.taxAmount.value ?? (total - subtotal))

  const primaryTaxPercent = dto.lines.find(l => l.taxPercent != null)?.taxPercent
  const vatTreatment = inferVatTreatment(primaryTaxPercent, dto.currencyCode)

  const statusMap: Record<string, string> = {
    draft: 'registered',
    sent: 'registered',
    booked: 'registered',
    paid: 'paid',
    overdue: 'overdue',
    cancelled: 'credited',
    credited: 'credited',
  }

  const isCreditNote = dto.invoiceTypeCode === '381'

  // Payment-derived amounts. Treat Balance numerically (never strict === 0) so
  // floating drift or a residual öre resolves cleanly to paid/unpaid.
  const balance = round2(dto.paymentStatus.balance.value)
  const paidAmount = dto.paymentStatus.paid ? total : round2(total - balance)

  // Status MUST stay consistent with the payment amounts. The provider's
  // lifecycle status (dto.status) and its payment status are computed
  // independently upstream and can contradict each other (e.g. a Fortnox
  // invoice that is "booked" but fully paid). Payment state wins:
  //   fully paid           -> 'paid'
  //   0 < paid < total     -> 'partially_paid'
  //   otherwise            -> the mapped lifecycle status
  const mappedStatus = statusMap[dto.status] || 'registered'
  let resolvedStatus: string
  if (isCreditNote) {
    // A kreditfaktura is never an open or "paid" payable. Force a credit-note
    // terminal status regardless of the provider's lifecycle status: the
    // arcim gateway is the only source of invoiceTypeCode and is NOT guaranteed
    // to also send status='credited', so trusting dto.status here could persist
    // a credit note as 'registered'/'paid' (contradicting its amounts).
    resolvedStatus = mappedStatus === 'reversed' ? 'reversed' : 'credited'
  } else if (mappedStatus === 'credited' || mappedStatus === 'reversed') {
    // Terminal states from the provider: never flipped by payment.
    resolvedStatus = mappedStatus
  } else if (dto.paymentStatus.paid || balance <= 0) {
    resolvedStatus = 'paid'
  } else if (paidAmount > 0 && paidAmount < total) {
    resolvedStatus = 'partially_paid'
  } else {
    resolvedStatus = mappedStatus
  }

  // SEK value of a foreign invoice, at the rate valid on its own issue date.
  const fx = resolveFx(dto.currencyCode, dto.issueDate, fxRates)

  const invoice: Record<string, unknown> = {
    user_id: userId,
    company_id: companyId,
    supplier_id: supplierId,
    supplier_invoice_number: dto.invoiceNumber,
    invoice_date: dto.issueDate,
    due_date: dto.dueDate || dto.issueDate,
    received_date: dto.issueDate,
    delivery_date: dto.deliveryDate || null,
    status: resolvedStatus,
    currency: dto.currencyCode || 'SEK',
    // null for a SEK invoice (no rate applies) and for a foreign invoice whose
    // rate could not be established: that case is reported via fxUnresolved.
    exchange_rate: fx.rate,
    exchange_rate_date: fx.rateDate,
    subtotal,
    subtotal_sek: toSek(subtotal, fx.sekFactor),
    vat_amount: vatAmount,
    vat_amount_sek: toSek(vatAmount, fx.sekFactor),
    total,
    total_sek: toSek(total, fx.sekFactor),
    vat_treatment: vatTreatment,
    reverse_charge: vatTreatment === 'reverse_charge',
    payment_reference: dto.ocrNumber || null,
    paid_at: resolvedStatus === 'paid' || resolvedStatus === 'partially_paid'
      ? dto.paymentStatus.lastPaymentDate || dto.issueDate
      : null,
    paid_amount: resolvedStatus === 'paid' ? total : Math.max(0, paidAmount),
    remaining_amount: resolvedStatus === 'paid' ? 0 : Math.max(0, balance),
    is_credit_note: isCreditNote,
    notes: dto.note || null,
  }

  const items = dto.lines.map((line, idx) => mapSupplierInvoiceLine(line, idx))

  return { invoice, items, fxUnresolved: fx.unresolved }
}

function mapSupplierInvoiceLine(line: SupplierInvoiceLineDto, index: number): Record<string, unknown> {
  return {
    sort_order: index + 1,
    description: line.description || line.itemName || '',
    quantity: line.quantity || 1,
    unit: line.unitCode || 'st',
    unit_price: round2(line.unitPrice?.value ?? line.lineExtensionAmount.value),
    line_total: round2(line.lineExtensionAmount.value),
    account_number: line.accountNumber || '4000', // Default to purchases
    // supplier_invoice_items stores decimal fractions (0.25 = 25 %), unlike
    // customer invoice_items which store percent; foreign rates (19 % DE)
    // must survive as 0.19 rather than be coerced to a Swedish rate.
    vat_rate: normalizeVatRateToFraction(line.taxPercent ?? 25),
    vat_amount: round2(line.taxAmount?.value ?? 0),
  }
}

export function mapCompanyInfo(dto: CompanyInformationDto): {
  company_name: string | null
  org_number: string | null
  vat_number: string | null
  fiscal_year_start_month: number
  address_line1: string | null
  postal_code: string | null
  city: string | null
  phone: string | null
  email: string | null
} {
  const addr = formatAddress(dto.address)
  // Parse fiscal year start month from "MM-DD" format
  let fiscalYearStartMonth = 1
  if (dto.fiscalYearStart) {
    const month = parseInt(dto.fiscalYearStart.split('-')[0], 10)
    if (month >= 1 && month <= 12) fiscalYearStartMonth = month
  }

  return {
    company_name: dto.companyName || null,
    org_number: dto.organizationNumber || null,
    vat_number: dto.vatNumber || null,
    fiscal_year_start_month: fiscalYearStartMonth,
    address_line1: addr.address_line1,
    postal_code: addr.postal_code,
    city: addr.city,
    phone: dto.contact?.telephone || null,
    email: dto.contact?.email || null,
  }
}

import type { CollectionsFeatures } from '@accounted/connect-contract'
import { roundOre } from '@/lib/money'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { getAmountToPay } from '@/lib/bookkeeping/invoice-rounding'
import { normalizeCountryCode } from '@/lib/vat/country-codes'
import { ADULT_AGE, type DebtorPersonalNumber } from './personal-number'

/**
 * Whether an invoice may be handed over to the collections provider, and
 * what the handover dialog has to show: the claim, the checklist, the
 * attestations a person must give, and the debtor's data. Pure: the readers
 * in readiness.ts load the facts; this decides. Shown as a checklist, never
 * as a silently disabled button.
 *
 * Overdue is computed from the due date (Europe/Stockholm), never from
 * status 'overdue', which only provider importers write. The claim is the
 * customer's share as printed ("Att betala": öresavrundning, then the
 * ROT/RUT deduction); Skatteverket's share is never the customer's.
 */

export interface EligibilityInvoice {
  id: string
  status: string
  document_type: string | null
  credited_invoice_id: string | null
  is_self_billed: boolean | null
  currency: string
  invoice_number: string | null
  invoice_date: string
  due_date: string
  total: number
  vat_amount: number
  /** What the customer has paid so far (invoice currency, the customer's share). */
  paid_amount: number | null
  remaining_amount: number
  deduction_total: number | null
  deduction_reclaimed_total: number | null
  ore_rounding: boolean | null
}

export interface EligibilityCustomer {
  id: string
  name: string
  customer_type: string
  country: string | null
  address_line1: string | null
  postal_code: string | null
  city: string | null
  org_number: string | null
  personalNumber: DebtorPersonalNumber
  /** customers.collections_excluded: "Skicka aldrig till inkasso" (build spec 3.4 rule 6). */
  collections_excluded?: boolean
}

export type DeliveryEvidence =
  /** An email that left and did not bounce, a recorded manual send, or a Peppol delivery the network took. */
  | 'delivered'
  /** Sends were attempted but none is known to have reached the customer. */
  | 'not_delivered'
  /** No delivery history at all: an imported invoice, or one from before delivery records existed. */
  | 'no_history'

export interface EligibilityFacts {
  invoice: EligibilityInvoice
  customer: EligibilityCustomer | null
  /** Today in Europe/Stockholm (YYYY-MM-DD). */
  today: string
  /** company_settings.ore_rounding (null = the default, on). */
  companyOreRounding: boolean | null
  connection: {
    minimum_amount: number
    reminder_fee_terms_since: string | null
  }
  /** The provider's features from the catalogue; null when it cannot be read (v1 rules apply). */
  features: Pick<CollectionsFeatures, 'currencies' | 'debtorCountries' | 'privateDebtors' | 'minimumAmount'> | null
  /** An open case on the invoice, if any. */
  openCase: { id: string; stage: string } | null
  /**
   * The invoice's latest registered case was closed by the provider as paid.
   * Until the collected payment is booked the invoice still reads as owed in
   * the books, but the provider has the money: a new handover would claim it
   * twice.
   */
  latestCaseClosedPaid?: boolean
  /** Credit notes against the invoice that are not cancelled. */
  creditNotes: ReadonlyArray<{ status: string }>
  delivery: DeliveryEvidence
  /** The invoice came from another system (a provider migration). */
  imported: boolean
  /** The customer answered one of our reminders. */
  reminderResponse: 'disputed' | 'marked_paid' | null
}

/** A check that stops the handover. The code is the i18n key (collections namespace). */
export type EligibilityBlockCode =
  | 'elig_not_invoice'
  | 'elig_credit_note'
  | 'elig_credit_draft'
  | 'elig_credited'
  | 'elig_not_sent'
  | 'elig_paid'
  | 'elig_not_overdue'
  | 'elig_currency'
  | 'elig_foreign'
  | 'elig_private_unsupported'
  | 'elig_below_minimum'
  | 'elig_open_case'
  | 'elig_collected_unbooked'
  | 'elig_time_barred'
  | 'elig_rot_rut_reclaimed'
  | 'elig_minor'
  | 'debtor_missing_customer'
  | 'debtor_missing_address'
  | 'debtor_missing_org_number'
  | 'debtor_invalid_org_number'
  | 'debtor_excluded'

export interface EligibilityBlock {
  code: EligibilityBlockCode
  /** Values the sentence needs (amount, fields). */
  params?: Record<string, string | number>
}

/** Things the dialog shows without stopping the handover. */
export type EligibilityHintCode = 'debtor_missing_personal_number' | 'debtor_invalid_personal_number'

/** The attestation a person must give in the web dialog before the handover. */
export type DeliveryAttestation = 'not_delivered' | 'imported'

export interface Eligibility {
  claim: {
    /** What the customer was asked to pay, as printed. */
    amount: number
    /** The VAT inside `amount`, pro rata. */
    vatAmount: number
    /** The customer's share still unpaid, never above `amount`. */
    remaining: number
  }
  /** Whole days past the due date (0 when not yet overdue). */
  overdueDays: number
  debtorKind: 'business' | 'private'
  blocks: EligibilityBlock[]
  hints: EligibilityHintCode[]
  /** null when the invoice is known to have reached the customer. */
  deliveryAttestation: DeliveryAttestation | null
  /** The customer's answer to one of our reminders, which a person must have handled. */
  responseAttestation: 'disputed' | 'marked_paid' | null
  /** A reminder fee agreed for THIS invoice: issued in Accounted on or after the date the company's terms state one. */
  reminderFeeAgreed: boolean
  reminderFeeSince: string | null
  /** No blocking check failed (attestations are separate). */
  eligible: boolean
}

/** Preskriptionslag (1981:130) 2 §: three years for a consumer claim, ten otherwise. */
export const TIME_BAR_YEARS = { private: 3, business: 10 } as const

/** v1 when the catalogue cannot be read: SEK and Swedish customers only. */
const DEFAULT_FEATURES = { currencies: ['SEK'], debtorCountries: ['SE'], privateDebtors: true, minimumAmount: 0 }

export function isoDayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
}

function yearsBefore(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(y - years, m - 1, d))
  return shifted.toISOString().slice(0, 10)
}

/** The debtor's kind as the contract knows it. */
export function debtorKindOf(customerType: string | null | undefined): 'business' | 'private' {
  return customerType === 'individual' ? 'private' : 'business'
}

/**
 * The customer's country as the ISO 3166-1 alpha-2 code the provider's
 * debtor countries and the debtor address use: a name ("Sverige", "Sweden",
 * any case), a code with spaces around it and the alpha-3 "SWE" all read as
 * SE (normalizeCountryCode, which leaves alpha-3 codes out on purpose). A
 * value nothing maps stays as written in upper case, so it still reads as
 * foreign. Empty for no country.
 */
export function debtorCountryCode(country: string | null | undefined): string {
  const raw = country?.trim() ?? ''
  if (!raw) return ''
  return normalizeCountryCode(raw) ?? (raw.toUpperCase() === 'SWE' ? 'SE' : raw.toUpperCase())
}

/** The postal address fields a handover needs that the customer lacks (i18n keys). */
export function missingAddressFields(customer: Pick<EligibilityCustomer, 'address_line1' | 'postal_code' | 'city' | 'country'>): string[] {
  const missing: string[] = []
  if (!customer.address_line1?.trim()) missing.push('address_line1')
  if (!customer.postal_code?.trim() || customer.postal_code.replace(/\s/g, '').length < 3) missing.push('postal_code')
  if (!customer.city?.trim()) missing.push('city')
  if (!customer.country?.trim()) missing.push('country')
  return missing
}

/**
 * The claim the provider is given: the printed amount due, its VAT pro rata,
 * and what is still unpaid of it. `remaining` is the printed amount less what
 * the customer has paid, the same arithmetic the provider applies to the
 * amount and the payments it is told about, so the two never disagree by the
 * öresavrundning; it is never above the amount.
 */
export function collectionClaim(
  invoice: Pick<EligibilityInvoice, 'total' | 'vat_amount' | 'currency' | 'paid_amount' | 'deduction_total' | 'credited_invoice_id' | 'ore_rounding'>,
  companyOreRounding: boolean | null,
): Eligibility['claim'] {
  const amount = roundOre(getAmountToPay(invoice, { ore_rounding: companyOreRounding ?? true }).toPay)
  const vatAmount = invoice.total > 0 ? roundOre((invoice.vat_amount * amount) / invoice.total) : 0
  const remaining = roundOre(Math.max(0, Math.min(amount, amount - (invoice.paid_amount ?? 0))))
  return { amount, vatAmount: Math.max(0, Math.min(vatAmount, amount)), remaining }
}

export function evaluateEligibility(facts: EligibilityFacts): Eligibility {
  const { invoice, customer, today } = facts
  const features = facts.features ?? DEFAULT_FEATURES
  const blocks: EligibilityBlock[] = []
  const hints: EligibilityHintCode[] = []
  const block = (code: EligibilityBlockCode, params?: EligibilityBlock['params']) => blocks.push(params ? { code, params } : { code })

  // 1. A customer invoice of our own, not a credit note, quote, proforma or delivery note.
  const isCreditNote = !!invoice.credited_invoice_id
  if (isCreditNote) block('elig_credit_note')
  else if ((invoice.document_type ?? 'invoice') !== 'invoice' || invoice.is_self_billed) block('elig_not_invoice')
  if (facts.creditNotes.some((c) => c.status === 'draft')) block('elig_credit_draft')
  else if (facts.creditNotes.length > 0) block('elig_credited')

  // 2. Issued and still owed.
  const claim = collectionClaim(invoice, facts.companyOreRounding)
  if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
    block(invoice.status === 'paid' ? 'elig_paid' : 'elig_not_sent')
  } else if (claim.remaining <= 0 || invoice.remaining_amount <= 0) {
    block('elig_paid')
  }

  // 3. Overdue from the due date, never from status.
  const overdueDays = Math.max(0, isoDayNumber(today) - isoDayNumber(invoice.due_date))
  if (overdueDays === 0) block('elig_not_overdue')

  // 4. Currency and the customer's country, per the provider's features.
  const debtorKind = debtorKindOf(customer?.customer_type)
  if (!features.currencies.includes(invoice.currency)) block('elig_currency')
  const country = debtorCountryCode(customer?.country)
  const foreignType = customer?.customer_type === 'eu_business' || customer?.customer_type === 'non_eu_business'
  if (customer && (foreignType || (country && !features.debtorCountries.includes(country)))) block('elig_foreign')
  if (customer && debtorKind === 'private' && !features.privateDebtors) block('elig_private_unsupported')

  // 5. At least the company's minimum (and the provider's).
  const minimum = Math.max(facts.connection.minimum_amount, features.minimumAmount ?? 0)
  if (claim.remaining > 0 && claim.remaining < minimum) block('elig_below_minimum', { amount: minimum })

  // 6. Not already with the provider, not already collected by it, and the
  // customer not marked "Skicka aldrig till inkasso".
  if (facts.openCase) block('elig_open_case')
  else if (facts.latestCaseClosedPaid && !blocks.some((b) => b.code === 'elig_paid')) block('elig_collected_unbooked')
  if (customer?.collections_excluded === true) block('debtor_excluded')

  // 7. The debtor's data.
  if (customer) {
    const missing = missingAddressFields(customer)
    if (missing.length > 0) block('debtor_missing_address', { fields: missing.join(',') })
    if (debtorKind === 'business' && country === 'SE') {
      if (!customer.org_number?.trim()) block('debtor_missing_org_number')
      else if (!normalizeOrgNumber(customer.org_number)) block('debtor_invalid_org_number')
    }
    if (debtorKind === 'private') {
      if (customer.personalNumber.status === 'none') hints.push('debtor_missing_personal_number')
      else if (customer.personalNumber.status === 'invalid') hints.push('debtor_invalid_personal_number')
      else if (customer.personalNumber.age < ADULT_AGE) block('elig_minor')
    }
  } else {
    block('debtor_missing_customer')
  }

  // 10. Possibly time-barred: refused in this version (no avbrott attestation).
  const barYears = debtorKind === 'private' ? TIME_BAR_YEARS.private : TIME_BAR_YEARS.business
  if (invoice.due_date < yearsBefore(today, barYears)) block('elig_time_barred')

  // 11. No ROT/RUT share refused by Skatteverket.
  if ((invoice.deduction_reclaimed_total ?? 0) > 0) block('elig_rot_rut_reclaimed')

  // 8 and 9: attestations, not blocks.
  const deliveryAttestation: DeliveryAttestation | null = facts.imported || facts.delivery === 'no_history'
    ? 'imported'
    : facts.delivery === 'not_delivered'
      ? 'not_delivered'
      : null

  // Lag (1981:739) 2 §: a reminder fee only if agreed no later than when the
  // debt arose. Per invoice: issued in Accounted on or after the date the
  // company's terms state one; an imported invoice never carries one.
  const since = facts.connection.reminder_fee_terms_since
  const reminderFeeAgreed = !!since && invoice.invoice_date >= since && deliveryAttestation !== 'imported'

  return {
    claim,
    overdueDays,
    debtorKind,
    blocks,
    hints,
    deliveryAttestation,
    responseAttestation: facts.reminderResponse,
    reminderFeeAgreed,
    reminderFeeSince: since,
    eligible: blocks.length === 0,
  }
}


import type { BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { vatTreatmentForRegistration } from '@/lib/bookkeeping/vat-registration'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'
import { roundOre } from '@/lib/money'
import type { InvoiceExtractionResult, VatTreatment } from '@/types'

/**
 * What a person needs off an underlag to book its transaction: who, when,
 * how much, how much of it is moms and at which rate. Read from an
 * extraction (the inbox's, or the document's own), tolerating the shapes
 * older extractions have.
 */
export interface UnderlagFacts {
  supplier: string | null
  date: string | null
  total: number | null
  subtotal: number | null
  vat_amount: number | null
  /**
   * The one Swedish rate (25, 12 or 6) the underlag charges moms at; null
   * when it charges none, several, or a rate that is not Swedish.
   */
  vat_rate: number | null
  currency: string | null
  kind: string | null
}

/** The Swedish moms rates, in the percent form the extraction writes. */
const SWEDISH_VAT_RATES: ReadonlySet<number> = new Set([25, 12, 6])

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** A positive rate as a percent: the extraction writes 25, an older one may say 0.25. */
function percent(v: unknown): number | null {
  const n = num(v)
  if (n == null || n <= 0) return null
  return roundOre(n < 1 ? n * 100 : n)
}

/**
 * The single rate the underlag charges moms at. The VAT breakdown says it
 * outright (its rows that carry an amount); without one the line rates do,
 * but only when the document charges moms at all, so a reverse-charge
 * invoice whose lines name a rate is not read as charging it.
 */
function statedVatRate(e: Partial<InvoiceExtractionResult>, vatAmount: number | null): number | null {
  const breakdown = Array.isArray(e.vatBreakdown) ? e.vatBreakdown : []
  const lines = Array.isArray(e.lineItems) ? e.lineItems : []
  const charged = breakdown.filter((row) => (num(row?.amount) ?? 0) !== 0)
  const rates =
    charged.length > 0
      ? charged.map((row) => percent(row?.rate))
      : vatAmount != null && vatAmount > 0
        ? lines.map((line) => percent(line?.vatRate))
        : []
  const distinct = new Set(rates.filter((r): r is number => r != null))
  if (distinct.size !== 1) return null
  const [rate] = distinct
  return SWEDISH_VAT_RATES.has(rate) ? rate : null
}

export function readUnderlagFacts(extracted: unknown): UnderlagFacts | null {
  if (!extracted || typeof extracted !== 'object') return null
  const e = extracted as Partial<InvoiceExtractionResult>
  const vatAmount = num(e.totals?.vatAmount)
  const facts: UnderlagFacts = {
    supplier: e.supplier?.name ?? null,
    date: e.invoice?.invoiceDate ?? null,
    total: num(e.totals?.total),
    subtotal: num(e.totals?.subtotal),
    vat_amount: vatAmount,
    vat_rate: statedVatRate(e, vatAmount),
    currency: e.invoice?.currency ?? null,
    kind: e.documentKind ?? null,
  }
  return Object.values(facts).every((v) => v == null) ? null : facts
}

/**
 * The moms a review books after the person changes its account by hand.
 *
 * A balance-sheet (2xxx) account carries none. Otherwise the rate the
 * underlag charges replaces the domestic treatment the booking carried so
 * far, which was a default and never a reading of the document: a
 * template's rate (Friskvård carries gym's 6 %) or the no-moms of the
 * liability account it came from. The 25 % printed on the invoice is what
 * gets booked (PostHog PH 118). Everything else keeps the carry-over: a
 * rate the person picked by hand, a cross-border treatment (reverse charge,
 * export), an underlag without one Swedish rate, and a company that is not
 * VAT-registered, which books no moms line (lib/bookkeeping/vat-registration.ts).
 */
export function vatTreatmentAfterAccountChange(input: {
  account: string
  /** The treatment the booking carries before the change. */
  current: VatTreatment
  /** UnderlagFacts.vat_rate of the underlag behind the booking, if any. */
  underlagRate: number | null | undefined
  /** The person set the moms themselves in this review. */
  chosenByHand?: boolean
  vatRegistered?: boolean | null
}): VatTreatment {
  const { account, current, underlagRate } = input
  if (account.startsWith('2')) return 'exempt'
  if (input.chosenByHand || input.vatRegistered === false) return current
  if (current === 'reverse_charge' || current === 'export') return current
  if (underlagRate == null || !SWEDISH_VAT_RATES.has(underlagRate)) return current
  return getVatTreatmentForRate(underlagRate)
}

/**
 * The two rates to name when the review's catalog template books moms at
 * another rate than the one its underlag states: a massage invoice at 25 %
 * through Friskvård, which books gym's 6 % (PostHog PH 118). The review
 * only says so; the booked moms stays as it is and the person decides.
 *
 * Null, and no warning, unless both sides are one plain Swedish rate and
 * they differ: no template (an account or counterpart booking), a template
 * that books no moms line at a rate as buildMappingResultFromTemplate books
 * it (reverse charge, export, exempt, none, a private or non-deductible
 * template, a company that is not VAT-registered), and an underlag without
 * one Swedish rate say nothing.
 */
export function templateVatMismatch(input: {
  template: Pick<BookingTemplate, 'vat_treatment' | 'deductibility' | 'default_private'> | null | undefined
  /** UnderlagFacts.vat_rate of the underlag behind the review, if any. */
  underlagRate: number | null | undefined
  vatRegistered?: boolean | null
}): { underlag: number; template: number } | null {
  const { template, underlagRate } = input
  if (!template || underlagRate == null || !SWEDISH_VAT_RATES.has(underlagRate)) return null
  if (template.default_private || template.deductibility === 'non_deductible') return null
  const treatment = vatTreatmentForRegistration(template.vat_treatment, input.vatRegistered)
  const templateRate = [...SWEDISH_VAT_RATES].find((rate) => getVatTreatmentForRate(rate) === treatment)
  if (templateRate == null || templateRate === underlagRate) return null
  return { underlag: underlagRate, template: templateRate }
}

/** What GET /api/transactions/[id]/underlag returns: the document from either door, and its facts. */
export interface TransactionUnderlag {
  source: 'pinned' | 'matched' | null
  document: { id: string; file_name: string | null; mime_type: string | null } | null
  inbox_item_id: string | null
  facts: UnderlagFacts | null
}

/**
 * Below this a receipt is still required by law, but asking for it before
 * every coffee is what makes people stop booking. Above it the review asks
 * the person to fetch the underlag before booking without one.
 */
export const UNDERLAG_PROMPT_THRESHOLD_SEK = 500

export function needsUnderlagPrompt(amountSek: number | null | undefined): boolean {
  return amountSek != null && Number.isFinite(amountSek) && Math.abs(amountSek) >= UNDERLAG_PROMPT_THRESHOLD_SEK
}

/** The document's moms and the proposed moms disagree by more than rounding. */
export function vatDisagrees(
  documentVat: number | null | undefined,
  proposedVat: number | null | undefined,
  toleranceSek = 1,
): boolean {
  if (documentVat == null || proposedVat == null) return false
  return Math.abs(documentVat - proposedVat) > toleranceSek
}

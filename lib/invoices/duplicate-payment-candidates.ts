import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  escapeLikePattern,
  normalizeOcrReference,
} from './duplicate-payment-guard'
import {
  invoiceAmountSek,
  magnitudesWithinTolerance,
  normalizeCurrencyCode,
  planAmountSweeps,
  type ComparableAmount,
} from './duplicate-guard-currency'
import { resolveTransactionAmountSek } from '@/lib/transactions/booking-duplicate-detection'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/duplicate-payment-candidates')

export type DuplicatePaymentMatchReason =
  | 'ocr_exact'
  | 'name_amount_fuzzy'
  | 'amount_only'

export interface DuplicatePaymentCandidate {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  reference: string | null
  match_reason: DuplicatePaymentMatchReason
  match_confidence: number
}

const MATCH_REASON_RANK: Record<DuplicatePaymentMatchReason, number> = {
  ocr_exact: 0,
  name_amount_fuzzy: 1,
  amount_only: 2,
}

const MATCH_REASON_CONFIDENCE: Record<DuplicatePaymentMatchReason, number> = {
  ocr_exact: 0.99,
  name_amount_fuzzy: 0.7,
  amount_only: 0.5,
}

interface CustomerInvoice {
  invoice_number: string | null
  customer_name: string | null | undefined
  /**
   * `invoices.currency`; null means SEK (the column default). REQUIRED rather
   * than optional on purpose: an optional field silently reads as SEK for any
   * caller that forgets it, which is exactly how a 1 000 EUR payment came to be
   * banded against a kronor column. TypeScript now refuses the call instead.
   */
  currency: string | null
  /** `invoices.total`, in `currency`. Pro-rates `total_sek` down to the payment. */
  total: number | null
  /** `invoices.total_sek`: the stored SEK view of `total`. */
  total_sek: number | null
  /** `invoices.exchange_rate`: SEK per unit of `currency`. */
  exchange_rate: number | null
}

type Row = {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  reference: string | null
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
}

/**
 * Scan unlinked positive (inbound) business bank transactions that could be
 * the payment for this customer invoice. Used by the mark-paid duplicate
 * guard: callers route the user to "link existing" instead of double-booking.
 *
 * Customer-side adaptations vs the supplier guard:
 *  - amount > 0 (inbound) instead of < 0
 *  - matches BOTH `merchant_name` AND `description` (banks often describe an
 *    inbound payment by payer name without populating merchant_name)
 *  - per-candidate scoring with OCR (invoice_number normalized) as the
 *    strongest signal
 *
 * Units: `paymentAmount` is denominated in the INVOICE's currency (that is what
 * `invoices.remaining_amount` and `total` are stored in), while
 * `transactions.amount` is denominated in the bank row's own currency. The
 * plus-minus tolerance band is therefore planned per currency by
 * `planAmountSweeps` and re-checked per row by `magnitudesWithinTolerance`:
 * band and column always share a unit, and a candidate that cannot be brought
 * into a shared unit is excluded rather than compared as a raw number. A SEK
 * invoice produces exactly one sweep with the same band as before.
 *
 * The merchant_name and description searches are issued as two separate
 * parameterised `.ilike()` queries and deduplicated by id. We deliberately
 * avoid `.or('merchant_name.ilike.%X%,description.ilike.%X%')` because that
 * interpolates the customer name into PostgREST's filter-DSL string, where
 * `escapeLikePattern` only neutralises the LIKE wildcards (`%_\\`) and not
 * the DSL chars (`,`, `.`, `(`, `)`). A name like `Acme,fake.eq.true` would
 * otherwise inject a synthetic filter clause.
 */
export async function findDuplicatePaymentCandidatesForInvoice(
  supabase: SupabaseClient,
  params: {
    companyId: string
    invoice: CustomerInvoice
    /** The payment being booked, in `invoice.currency`. */
    paymentAmount: number
    paymentDate: string
  },
): Promise<DuplicatePaymentCandidate[]> {
  const { companyId, invoice, paymentAmount, paymentDate } = params
  const customerName = invoice.customer_name
  if (!customerName) return []

  const paymentCurrency = normalizeCurrencyCode(invoice.currency)
  const reference: ComparableAmount = {
    amount: paymentAmount,
    currency: paymentCurrency,
    sek: invoiceAmountSek({
      amount: paymentAmount,
      currency: paymentCurrency,
      total: invoice.total,
      totalSek: invoice.total_sek,
      exchangeRate: invoice.exchange_rate,
    }),
  }
  const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
    reference,
    DUPLICATE_AMOUNT_TOLERANCE_PCT,
  )
  if (sweeps.length === 0) return []
  if (crossCurrencyUnverifiable) {
    // A foreign invoice with neither a usable total_sek nor an exchange_rate
    // cannot be stated in kronor, so kronor bank rows are excluded rather than
    // compared raw (a raw compare reads 1 000 kr as 1 000 EUR). Same-currency
    // rows are still swept. Logged for the same reason the supplier-side twin
    // logs it: an unevaluated candidate set is not a clean "no duplicate", and
    // the gap must be visible in behandlingshistorik (BFNAR 2013:2 p. 9.16)
    // rather than pass silently.
    log.warn('duplicate-payment guard: cross-currency candidates not evaluated', {
      reason: 'invoice_missing_sek_value',
      companyId,
      currency: paymentCurrency,
      invoiceNumber: invoice.invoice_number,
    })
  }

  const dateMs = new Date(paymentDate).getTime()
  const dateLow = new Date(dateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]
  const dateHigh = new Date(dateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]
  const pattern = `%${escapeLikePattern(customerName)}%`

  const base = (sweepIndex: number) => {
    const sweep = sweeps[sweepIndex]
    return supabase
      .from('transactions')
      .select(
        'id, date, amount, description, merchant_name, reference, currency, amount_sek, exchange_rate',
      )
      .eq('company_id', companyId)
      .eq('is_business', true)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      .gt('amount', 0)
      .or(sweep.currencyFilter)
      .gte('amount', sweep.low)
      .lte('amount', sweep.high)
      .gte('date', dateLow)
      .lte('date', dateHigh)
  }

  const responses = await Promise.all(
    sweeps.flatMap((_sweep, i) => [
      base(i).ilike('merchant_name', pattern).order('date', { ascending: false }).limit(5),
      base(i).ilike('description', pattern).order('date', { ascending: false }).limit(5),
    ]),
  )

  const merged = new Map<string, Row>()
  for (const res of responses) {
    for (const row of (res.data ?? []) as Row[]) {
      if (!merged.has(row.id)) merged.set(row.id, row)
    }
  }

  const data = Array.from(merged.values())
    .filter((row) =>
      magnitudesWithinTolerance(reference, rowAmount(row), DUPLICATE_AMOUNT_TOLERANCE_PCT),
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 5)

  if (data.length === 0) return []

  const invoiceOcr = normalizeOcrReference(invoice.invoice_number)
  const searchTerms = customerName
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2)

  const candidates: DuplicatePaymentCandidate[] = data.map((row) => {
    const reason = scoreCandidate({
      row,
      invoiceOcr,
      searchTerms,
    })
    return {
      id: row.id,
      date: row.date,
      amount: row.amount,
      description: row.description,
      merchant_name: row.merchant_name,
      reference: row.reference,
      match_reason: reason,
      match_confidence: MATCH_REASON_CONFIDENCE[reason],
    }
  })

  candidates.sort((a, b) => MATCH_REASON_RANK[a.match_reason] - MATCH_REASON_RANK[b.match_reason])
  return candidates
}

/**
 * A bank row as a comparable amount. `resolveTransactionAmountSek` is the one
 * definition of "this bank line in kronor" (shared with the booking-time
 * duplicate guard) and returns null rather than falling back to the raw foreign
 * number.
 */
function rowAmount(row: Row): ComparableAmount {
  return {
    amount: Number(row.amount),
    currency: normalizeCurrencyCode(row.currency),
    sek: resolveTransactionAmountSek({
      amount: row.amount,
      currency: row.currency,
      amount_sek: row.amount_sek,
      exchange_rate: row.exchange_rate,
    }),
  }
}

function scoreCandidate(args: {
  row: { reference: string | null; description: string | null; merchant_name: string | null }
  invoiceOcr: string
  searchTerms: string[]
}): DuplicatePaymentMatchReason {
  const { row, invoiceOcr, searchTerms } = args
  if (invoiceOcr && row.reference) {
    if (normalizeOcrReference(row.reference) === invoiceOcr) {
      return 'ocr_exact'
    }
  }
  if (searchTerms.length > 0) {
    const haystack = `${row.description ?? ''} ${row.merchant_name ?? ''}`.toLowerCase()
    if (searchTerms.some((term) => haystack.includes(term))) {
      return 'name_amount_fuzzy'
    }
  }
  return 'amount_only'
}

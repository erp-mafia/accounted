import type { SupabaseClient } from '@supabase/supabase-js'
import {
  COUNTERPARTY_NEEDLE_SHAPE,
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  counterpartyNeedle,
  counterpartySearchTerms,
  counterpartySweepLogic,
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
import { findExactCoveringSet } from '@/lib/reconciliation/covering-set'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/duplicate-payment-candidates')

export type DuplicatePaymentMatchReason =
  | 'ocr_exact'
  | 'name_amount_fuzzy'
  | 'amount_only'
  /**
   * The bank row is larger than this payment and the difference is exactly
   * (to the öre) the remaining amount of one to three OTHER open invoices:
   * a Bankgirot daily aggregate that settled this invoice together with
   * them. No counterparty text is consulted; such rows carry none.
   */
  | 'aggregate_exact'
  /**
   * The bank row already carries a posted verifikat (`journal_entry_id` set)
   * but was never linked to this invoice: the money was booked straight from
   * the bank side, as an expense or an income. Marking the invoice paid now
   * books the same movement a second time (the 2026-09-04 case doubled both
   * 6212 and 1930). The remedy is a rättelse, not a link: reverse one of the
   * two vouchers with a storno entry and attach the underlag to the remaining one.
   */
  | 'already_booked'

export interface DuplicatePaymentCandidate {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  reference: string | null
  /** The verifikat the row is already booked on; set iff `match_reason` is `already_booked`. */
  journal_entry_id: string | null
  match_reason: DuplicatePaymentMatchReason
  match_confidence: number
  /** For aggregate_exact: the other open invoices the row also covers. */
  aggregate_invoice_numbers?: string[]
}

const MATCH_REASON_RANK: Record<DuplicatePaymentMatchReason, number> = {
  already_booked: 0,
  ocr_exact: 1,
  aggregate_exact: 2,
  name_amount_fuzzy: 3,
  amount_only: 4,
}

const MATCH_REASON_CONFIDENCE: Record<DuplicatePaymentMatchReason, number> = {
  already_booked: 0.85,
  ocr_exact: 0.99,
  aggregate_exact: 0.9,
  name_amount_fuzzy: 0.7,
  amount_only: 0.5,
}

/**
 * Fewer digits than this is not an OCR / invoice number, it is a coincidence:
 * a supplier invoice numbered "7" must not read every bank reference with a 7
 * in it as an exact match.
 */
const MIN_OCR_DIGITS = 4

/** ± days around the payment date an aggregate row is looked for: a Bankgirot
 *  aggregate lands on the payment day, so the wide name-sweep window would only
 *  add coincidental sums. */
const AGGREGATE_DATE_WINDOW_DAYS = 7
/** Other open invoices an aggregate row may cover besides this one. */
const AGGREGATE_MAX_OTHER_INVOICES = 3
const AGGREGATE_MAX_ROWS = 40
const AGGREGATE_MAX_OPEN_INVOICES = 200

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

/**
 * The supplier-side twin of `CustomerInvoice`. Same currency contract; the
 * name is the supplier's, and the OCR signal is the invoice's payment
 * reference (or its number) rather than our own invoice number.
 */
interface SupplierInvoiceForGuard {
  supplier_invoice_number: string | null
  /** The OCR / payment reference printed on the supplier's invoice, if captured. */
  payment_reference?: string | null
  supplier_name: string | null | undefined
  /** `supplier_invoices.currency` (NOT NULL DEFAULT 'SEK'; null tolerated). */
  currency: string | null
  total: number | null
  total_sek: number | null
  exchange_rate: number | null
}

type Row = {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  reference: string | null
  journal_entry_id: string | null
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
}

const ROW_COLUMNS =
  'id, date, amount, description, merchant_name, reference, journal_entry_id, currency, amount_sek, exchange_rate'

/**
 * Scan unlinked positive (inbound) business bank transactions that could be
 * the payment for this customer invoice. Used by the mark-paid duplicate
 * guard: callers route the user to "link existing" instead of double-booking.
 *
 * Customer-side adaptations vs the supplier twin below:
 *  - amount > 0 (inbound) instead of < 0
 *  - OCR signal is OUR invoice number (the payer quotes it as reference)
 *  - falls through to the Bankgirot aggregate sweep when nothing 1:1 turns up
 *
 * Both sides share `sweepByCounterparty` and `scoreCandidate`, so the
 * prefilter (first distinctive token of the name against merchant_name OR
 * description), the currency banding and the ranking cannot drift apart
 * again: the supplier side used to carry its own copy that probed
 * merchant_name only, with the full legal name as needle, and missed the
 * abbreviated bank text the feed actually writes (issue #2299).
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
  const paymentCurrency = normalizeCurrencyCode(invoice.currency)
  const aggregate = () =>
    paymentCurrency === 'SEK'
      ? runAggregateSweep(supabase, { companyId, invoice, paymentAmount, paymentDate })
      : Promise.resolve([] as DuplicatePaymentCandidate[])

  // The name sweep needs a payer to look for; the aggregate sweep does not
  // (a Bankgirot row names nobody), so a nameless invoice skips straight to it.
  const needle = counterpartyNeedle(invoice.customer_name)
  if (!needle) return aggregate()

  const rows = await sweepByCounterparty(supabase, {
    companyId,
    direction: 'inbound',
    needle,
    reference: {
      amount: paymentAmount,
      currency: paymentCurrency,
      sek: invoiceAmountSek({
        amount: paymentAmount,
        currency: paymentCurrency,
        total: invoice.total,
        totalSek: invoice.total_sek,
        exchangeRate: invoice.exchange_rate,
      }),
    },
    paymentDate,
    logContext: { companyId, invoiceNumber: invoice.invoice_number },
  })

  // Nothing of this invoice's own size: look for the row that paid it TOGETHER
  // with other invoices. One warning is enough, so the sweep only runs when
  // the name sweep came back empty. Kronor only: the sum is taken over
  // remaining amounts stored in invoice currency.
  if (rows.length === 0) return aggregate()

  return rankCandidates(rows, {
    invoiceOcrs: ocrKeys([invoice.invoice_number]),
    searchTerms: counterpartySearchTerms(invoice.customer_name),
  })
}

/**
 * Supplier-side twin: unlinked NEGATIVE (outbound) business bank rows that
 * could be the payment of this supplier invoice. Same sweep, same scorer,
 * same reasons as the customer side; the OCR signal is the supplier's payment
 * reference (or the invoice number) as the payer typed it into the bank
 * transfer. No aggregate sweep: a Bankgirot daily aggregate is an inbound
 * shape, and our own outbound batches (betalfil) link every row explicitly.
 *
 * A candidate with `match_reason: 'already_booked'` is the case the issue
 * names third: the bank row was booked straight as an expense, and the
 * invoice then registered on top of it. Paying it would double 6212 and 1930.
 */
export async function findDuplicatePaymentCandidatesForSupplierInvoice(
  supabase: SupabaseClient,
  params: {
    companyId: string
    invoice: SupplierInvoiceForGuard
    /** The payment being booked, in `invoice.currency`. */
    paymentAmount: number
    paymentDate: string
  },
): Promise<DuplicatePaymentCandidate[]> {
  const { companyId, invoice, paymentAmount, paymentDate } = params
  const needle = counterpartyNeedle(invoice.supplier_name)
  if (!needle) {
    // An invoice without a usable supplier name is arguably HIGHER risk for
    // duplicate booking, not lower (BFL 5 kap 7 §: motpart should be
    // identifiable). Log the skip so the gap is visible in audit.
    log.warn('duplicate-payment guard skipped', {
      reason: invoice.supplier_name ? 'unusable_supplier_name' : 'missing_supplier_name',
      companyId,
      supplierInvoiceNumber: invoice.supplier_invoice_number,
    })
    return []
  }
  const paymentCurrency = normalizeCurrencyCode(invoice.currency)

  const rows = await sweepByCounterparty(supabase, {
    companyId,
    direction: 'outbound',
    needle,
    reference: {
      amount: paymentAmount,
      currency: paymentCurrency,
      sek: invoiceAmountSek({
        amount: paymentAmount,
        currency: paymentCurrency,
        total: invoice.total,
        totalSek: invoice.total_sek,
        exchangeRate: invoice.exchange_rate,
      }),
    },
    paymentDate,
    logContext: { companyId, supplierInvoiceNumber: invoice.supplier_invoice_number },
  })
  if (rows.length === 0) return []

  return rankCandidates(rows, {
    invoiceOcrs: ocrKeys([invoice.payment_reference, invoice.supplier_invoice_number]),
    searchTerms: counterpartySearchTerms(invoice.supplier_name),
  })
}

/**
 * The one counterparty sweep both sides run.
 *
 * Units: `reference.amount` is denominated in the INVOICE's currency (that is
 * what `remaining_amount` and `total` are stored in), while
 * `transactions.amount` is denominated in the bank row's own currency. The
 * plus-minus tolerance band is therefore planned per currency by
 * `planAmountSweeps` and re-checked per row by `magnitudesWithinTolerance`:
 * band and column always share a unit, and a candidate that cannot be brought
 * into a shared unit is excluded rather than compared as a raw number. A SEK
 * invoice produces exactly one query.
 *
 * Each currency sweep is ONE query with ONE `.or()`: the currency predicate
 * and the name probe are nested into a single logic expression by
 * `counterpartySweepLogic`, so the guard never depends on how PostgREST
 * treats a repeated `or=` key. Interpolating the needle into that DSL string
 * is only safe because `counterpartyNeedle` reduces the name to letters and
 * digits (`COUNTERPARTY_NEEDLE_SHAPE`): no `,` `.` `(` `)` to inject a clause,
 * no LIKE wildcard to widen the match. The shape is re-checked here so a
 * future needle builder cannot silently reopen that hole.
 */
async function sweepByCounterparty(
  supabase: SupabaseClient,
  args: {
    companyId: string
    /** inbound = customer payment (amount > 0); outbound = supplier payment (amount < 0). */
    direction: 'inbound' | 'outbound'
    needle: string
    reference: ComparableAmount
    paymentDate: string
    logContext: Record<string, unknown>
  },
): Promise<Row[]> {
  const { companyId, direction, needle, reference, paymentDate, logContext } = args
  if (!COUNTERPARTY_NEEDLE_SHAPE.test(needle)) {
    log.warn('duplicate-payment guard skipped', { reason: 'unsafe_needle', ...logContext })
    return []
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
    // rows are still swept. Logged because an unevaluated candidate set is not
    // a clean "no duplicate": the gap must be visible in behandlingshistorik
    // (BFNAR 2013:2 p. 9.16) rather than pass silently.
    log.warn('duplicate-payment guard: cross-currency candidates not evaluated', {
      reason: 'invoice_missing_sek_value',
      currency: reference.currency,
      ...logContext,
    })
  }

  const dateMs = new Date(paymentDate).getTime()
  const dayMs = 24 * 3600 * 1000
  const dateLow = new Date(dateMs - DUPLICATE_DATE_WINDOW_DAYS * dayMs).toISOString().split('T')[0]
  const dateHigh = new Date(dateMs + DUPLICATE_DATE_WINDOW_DAYS * dayMs).toISOString().split('T')[0]

  const responses = await Promise.all(
    sweeps.map((sweep) => {
      const base = supabase
        .from('transactions')
        .select(ROW_COLUMNS)
        .eq('company_id', companyId)
        .eq('is_business', true)
        .is('invoice_id', null)
        .is('supplier_invoice_id', null)
      const banded =
        direction === 'inbound'
          ? base.gt('amount', 0).gte('amount', sweep.low).lte('amount', sweep.high)
          : base.lt('amount', 0).gte('amount', -sweep.high).lte('amount', -sweep.low)
      return banded
        .gte('date', dateLow)
        .lte('date', dateHigh)
        .or(counterpartySweepLogic(sweep.currencyFilter, needle))
        .order('date', { ascending: false })
        .limit(5)
    }),
  )

  const merged = new Map<string, Row>()
  for (const res of responses) {
    for (const row of (Array.isArray(res.data) ? res.data : []) as Row[]) {
      if (!merged.has(row.id)) merged.set(row.id, row)
    }
  }

  return Array.from(merged.values())
    .filter((row) =>
      magnitudesWithinTolerance(reference, rowAmount(row), DUPLICATE_AMOUNT_TOLERANCE_PCT),
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 5)
}

/** Normalised OCR keys worth comparing: digits only, at least MIN_OCR_DIGITS, deduplicated. */
function ocrKeys(values: Array<string | null | undefined>): string[] {
  const keys = values.map(normalizeOcrReference).filter((key) => key.length >= MIN_OCR_DIGITS)
  return Array.from(new Set(keys))
}

function rankCandidates(
  rows: Row[],
  args: { invoiceOcrs: string[]; searchTerms: string[] },
): DuplicatePaymentCandidate[] {
  const candidates: DuplicatePaymentCandidate[] = rows.map((row) => {
    const reason = scoreCandidate({ row, ...args })
    return {
      id: row.id,
      date: row.date,
      amount: row.amount,
      description: row.description,
      merchant_name: row.merchant_name,
      reference: row.reference,
      journal_entry_id: row.journal_entry_id ?? null,
      match_reason: reason,
      match_confidence: MATCH_REASON_CONFIDENCE[reason],
    }
  })
  candidates.sort((a, b) => MATCH_REASON_RANK[a.match_reason] - MATCH_REASON_RANK[b.match_reason])
  return candidates
}

async function runAggregateSweep(
  supabase: SupabaseClient,
  params: {
    companyId: string
    invoice: Pick<CustomerInvoice, 'invoice_number'>
    paymentAmount: number
    paymentDate: string
  },
): Promise<DuplicatePaymentCandidate[]> {
  const { companyId, invoice, paymentAmount, paymentDate } = params
  try {
    return await findAggregateCandidates(supabase, {
      companyId,
      invoiceNumber: invoice.invoice_number,
      paymentAmount,
      paymentDate,
    })
  } catch (err) {
    // Advisory guard: a failed sweep must never block "Markera som betald".
    // Logged so the blind spot is visible rather than passing silently.
    log.warn('duplicate-payment guard: aggregate sweep failed', {
      companyId,
      invoiceNumber: invoice.invoice_number,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

type OpenInvoiceRow = {
  id: string
  invoice_number: string | null
  remaining_amount: number | string | null
  total: number | string | null
  due_date: string | null
}

type AggregateRow = Pick<Row, 'id' | 'date' | 'amount' | 'description' | 'merchant_name' | 'reference'>

/**
 * Unlinked inbound kronor rows around the payment date that are LARGER than
 * the payment, where the excess is exactly the remaining amount of one to
 * three other open invoices. That is what a Bankgirot daily aggregate looks
 * like from the invoice side: "BGGIRERING", no payer, one sum for two
 * customers' invoices. Same exact-sum search the bank-side guard uses
 * (lib/reconciliation/covering-set.ts), so the two doors agree on what
 * "already paid" means. The remedy is the split under Transaktioner, which
 * books ONE samlingsverifikation and links the row; marking the invoices
 * paid one by one is what books the money twice.
 */
async function findAggregateCandidates(
  supabase: SupabaseClient,
  params: {
    companyId: string
    invoiceNumber: string | null
    paymentAmount: number
    paymentDate: string
  },
): Promise<DuplicatePaymentCandidate[]> {
  const { companyId, invoiceNumber, paymentAmount, paymentDate } = params
  const payment = roundOre(paymentAmount)
  if (!(payment > 0)) return []
  const dateMs = new Date(paymentDate).getTime()
  if (Number.isNaN(dateMs)) return []
  const dayMs = 24 * 3600 * 1000
  const dateLow = new Date(dateMs - AGGREGATE_DATE_WINDOW_DAYS * dayMs).toISOString().split('T')[0]
  const dateHigh = new Date(dateMs + AGGREGATE_DATE_WINDOW_DAYS * dayMs).toISOString().split('T')[0]

  const { data: rowsData } = await supabase
    .from('transactions')
    .select('id, date, amount, description, merchant_name, reference')
    .eq('company_id', companyId)
    .eq('is_business', true)
    .is('invoice_id', null)
    .is('supplier_invoice_id', null)
    .is('journal_entry_id', null)
    .or('currency.is.null,currency.eq.SEK')
    .gt('amount', payment)
    .gte('date', dateLow)
    .lte('date', dateHigh)
    .order('date', { ascending: false })
    .limit(AGGREGATE_MAX_ROWS)
  // Defensive shape check: a client that answers a list query with a single
  // object (older test doubles do) must read as "no rows", not throw.
  const rows = (Array.isArray(rowsData) ? rowsData : []) as AggregateRow[]
  if (rows.length === 0) return []

  let othersQuery = supabase
    .from('invoices')
    .select('id, invoice_number, remaining_amount, total, due_date')
    .eq('company_id', companyId)
    .eq('document_type', 'invoice')
    .is('credited_invoice_id', null)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .gt('remaining_amount', 0)
    .or('currency.is.null,currency.eq.SEK')
  if (invoiceNumber) othersQuery = othersQuery.neq('invoice_number', invoiceNumber)
  const { data: othersData } = await othersQuery
    .order('due_date', { ascending: true })
    .limit(AGGREGATE_MAX_OPEN_INVOICES)
  const others = ((Array.isArray(othersData) ? othersData : []) as OpenInvoiceRow[]).filter(
    (inv) => inv.invoice_number && Number(inv.remaining_amount ?? inv.total ?? 0) > 0,
  )
  if (others.length === 0) return []

  const candidates: DuplicatePaymentCandidate[] = []
  for (const row of rows) {
    const residual = roundOre(Number(row.amount) - payment)
    if (!(residual > 0)) continue
    const rowMs = new Date(row.date).getTime()
    const set = findExactCoveringSet(
      residual,
      others.map((inv) => ({
        id: inv.id,
        amount: Number(inv.remaining_amount ?? inv.total ?? 0),
        dateDistanceDays:
          inv.due_date && !Number.isNaN(rowMs)
            ? Math.round(Math.abs(new Date(inv.due_date).getTime() - rowMs) / dayMs)
            : AGGREGATE_DATE_WINDOW_DAYS,
        invoiceNumber: inv.invoice_number as string,
      })),
      { maxSize: AGGREGATE_MAX_OTHER_INVOICES },
    )
    if (!set) continue
    candidates.push({
      id: row.id,
      date: row.date,
      amount: Number(row.amount),
      description: row.description,
      merchant_name: row.merchant_name,
      reference: row.reference,
      journal_entry_id: null,
      match_reason: 'aggregate_exact',
      match_confidence: MATCH_REASON_CONFIDENCE.aggregate_exact,
      aggregate_invoice_numbers: set.map((s) => s.invoiceNumber),
    })
    if (candidates.length >= 5) break
  }
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
  row: {
    reference: string | null
    description: string | null
    merchant_name: string | null
    journal_entry_id?: string | null
  }
  invoiceOcrs: string[]
  searchTerms: string[]
}): DuplicatePaymentMatchReason {
  const { row, invoiceOcrs, searchTerms } = args
  // Booked-ness decides the REMEDY, so it outranks every match-strength signal:
  // a row that is already a verifikat must never be offered as "link it".
  if (row.journal_entry_id) return 'already_booked'
  if (invoiceOcrs.length > 0 && row.reference) {
    const rowOcr = normalizeOcrReference(row.reference)
    if (rowOcr && invoiceOcrs.includes(rowOcr)) return 'ocr_exact'
  }
  if (searchTerms.length > 0) {
    const haystack = `${row.description ?? ''} ${row.merchant_name ?? ''}`.toLowerCase()
    if (searchTerms.some((term) => haystack.includes(term))) {
      return 'name_amount_fuzzy'
    }
  }
  return 'amount_only'
}

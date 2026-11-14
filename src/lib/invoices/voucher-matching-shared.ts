/**
 * The one voucher-link matcher behind the customer-side (voucher-matching.ts)
 * and supplier-side (supplier-voucher-matching.ts) "link an existing verifikat
 * as the payment" flows: row shapes, tolerances, the candidate search
 * (collectSettlementVouchers), the SEK-booked settlement gate, the period-lock
 * flags and the scorer. Only the settlement side (customer: 151x credit, or
 * 19xx debit on kontantmetoden; supplier: 244x debit, or 19xx credit on
 * kontantmetoden), which payment rows already use a voucher, and the invoice's
 * own references differ, and each side passes those in.
 */
import { roundOre } from '@/lib/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isLedgerCurrency, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { fxDeviationTooLarge } from '@/lib/bookkeeping/fx-settlement'
import { documentCurrency, ledgerLineSideAmountIn } from '@/lib/bookkeeping/ledger-line-amount'
import { voucherLinkKursdifferensBusinessEvent } from '@/lib/bookkeeping/sql-posting-business-events'
import type { ScopeFreeLinkBasis } from '@/lib/links/link-basis'
import { linkBasisColumns } from '@/lib/links/stamp'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { Logger } from '@/lib/logger'
import { formatAmount as formatNumber } from '@/lib/utils'
import type { VoucherNumber } from './voucher-label'
import {
  CONFIDENCE,
  amountsMatchExact,
  amountsMatchFuzzy,
  customerNameMatches,
  descriptionMentionsReference,
} from './invoice-matching'

/** ±90 days from the invoice's due_date as the default search window. */
export const DEFAULT_DATE_WINDOW_DAYS = 90

/** Tolerance for floating-point comparisons on monetary amounts (0.5 öre). */
export const AMOUNT_TOLERANCE = 0.005

/** Date-proximity bump applied when entry_date is within ±7 days of due_date. */
export const DATE_PROXIMITY_BUMP = 0.05

/**
 * What an invoice still owes when a verifikat is linked to it, read the way
 * link_invoice_to_voucher and link_supplier_invoice_to_voucher read it: the
 * stored remaining_amount whenever there is one, a legitimate 0 included.
 * Falling through to `total - paid_amount` on a 0 made a paid ROT invoice owe
 * Skatteverket's share and leaked rounding drift past the fully-paid refusal.
 */
export function storedRemaining(invoice: {
  total: number
  paid_amount?: number | null
  remaining_amount?: number | null
}): number {
  if (typeof invoice.remaining_amount === 'number') return Math.max(0, invoice.remaining_amount)
  return Math.max(0, roundOre(invoice.total - (invoice.paid_amount ?? 0)))
}

/**
 * The payment event of a voucher link, for the kursdifferens verifikat the RPC
 * posts when a foreign-currency invoice is settled by a plain-kronor verifikat
 * at another rate. None for an invoice in the ledger currency (the RPC posts
 * nothing of its own), for a link that states its share (the RPC settles a
 * share without that fallback) or when the invoice or verifikat is not there
 * (the RPC refuses as before). A read error throws: the port logs it under
 * shadow and stops the link under strict.
 */
export async function voucherLinkEvents(
  supabase: SupabaseClient,
  companyId: string,
  link: {
    side: 'customer' | 'supplier'
    invoiceId: string
    journalEntryId: string
    amount?: number | null
    /** Why the pair is linked, on a door no person chose it on. */
    linkBasis?: ScopeFreeLinkBasis
  },
): Promise<BusinessEventDraft[]> {
  if (link.amount != null) return []
  const { data: invoice, error: invoiceError } =
    link.side === 'customer'
      ? await supabase
          .from('invoices')
          .select('id, customer_id, currency, total, paid_amount, remaining_amount')
          .eq('id', link.invoiceId)
          .eq('company_id', companyId)
          .maybeSingle()
      : await supabase
          .from('supplier_invoices')
          .select('id, supplier_id, currency, total, paid_amount, remaining_amount')
          .eq('id', link.invoiceId)
          .eq('company_id', companyId)
          .maybeSingle()
  if (invoiceError) throw invoiceError
  const row = invoice as {
    id: string
    customer_id?: string
    supplier_id?: string
    currency: string
    total: number
    paid_amount?: number | null
    remaining_amount?: number | null
  } | null
  if (!row || isLedgerCurrency(row.currency)) return []
  const { data: voucher, error: voucherError } = await supabase
    .from('journal_entries')
    .select('entry_date')
    .eq('id', link.journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (voucherError) throw voucherError
  if (!voucher) return []
  return [
    voucherLinkKursdifferensBusinessEvent(
      {
        side: link.side,
        invoiceId: row.id,
        partyId: (link.side === 'customer' ? row.customer_id : row.supplier_id) as string,
        currency: row.currency,
        remaining: storedRemaining(row),
        voucherDate: (voucher as { entry_date: string }).entry_date,
      },
      linkBasisColumns(link.linkBasis ?? 'user_confirmed'),
    ),
  ]
}

export interface VoucherMatchLineRow {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number | null
  credit_amount: number | null
  /** Labels the DOCUMENT, NOT the unit of debit_amount/credit_amount. */
  currency: string | null
  /** The line's amount in `currency`: the only non-SEK figure on the row. */
  amount_in_currency: number | string | null
}

export interface VoucherRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  status: string
  source_type: string | null
  fiscal_period_id: string
}

/** `fiscal_periods` has no `status` column: open/locked/closed is derived from
 *  `is_closed` + `locked_at`, exactly as the `enforce_period_lock` trigger
 *  (migration 017) and `resolvePeriodStatusForDate()` do it. */
export interface FiscalPeriodRow {
  id: string
  is_closed: boolean | null
  locked_at: string | null
}

/** SQL-side filter for posted, non-storno, non-opening entries. */
export const EXCLUDED_SOURCE_TYPES = ['opening_balance', 'storno']

/**
 * The amount band a bank-side (19xx) candidate search is pre-filtered to. On
 * kontantmetoden every receipt (customer) or payout (supplier) moves 19xx, so
 * the unfiltered set is the company's whole bank history in the window. The
 * band is a superset of every single-line case the scorers accept: exact
 * remaining, exact total, and fuzzy (±1% capped at 500). Both inputs are in the
 * INVOICE's currency; the caller applies the band to the column quoted in it.
 */
export function candidateAmountBand(
  remainingAmount: number,
  invoiceTotal: number,
): { floor: number; ceil: number } {
  const hi = Math.max(remainingAmount, invoiceTotal)
  const lo = Math.min(remainingAmount, invoiceTotal)
  const pad = Math.min(hi * 0.01, 500) + 0.02
  return { floor: Math.max(0, lo - pad), ceil: hi + pad }
}

export function isDateWithinDays(a: string, b: string, days: number): boolean {
  const ad = new Date(a).getTime()
  const bd = new Date(b).getTime()
  if (Number.isNaN(ad) || Number.isNaN(bd)) return false
  return Math.abs(ad - bd) <= days * 24 * 3600 * 1000
}

/** A settlement-side line as the SEK-booked fallback reads it. */
export interface SettlementSideLine {
  currency: string | null
  amount_in_currency: number | string | null
  /** The SEK ledger amount on the settlement side of the line. */
  sideSek: number
}

export type SekBookedSettlement =
  | { eligible: true; sekTotal: number; bookedSek: number }
  | { eligible: false; reason: 'not_eligible' }
  | { eligible: false; reason: 'fx_deviation_too_large'; sekTotal: number; bookedSek: number }

/**
 * The RPCs' SEK-booked settlement gate (migration 20260830140000, both
 * link_invoice_to_voucher and link_supplier_invoice_to_voucher) for a
 * foreign-currency invoice, as ONE predicate for both link validators and the
 * candidate search, so the search never offers a voucher the link refuses and
 * never hides one it accepts (feedback seq 930807: a USD invoice paid by an
 * SIE-imported voucher with its 2440 debit in SEK linked fine by hand, yet no
 * candidate was ever proposed).
 *
 * Counted per LINE exactly as the RPC does: zero lines readable in the
 * invoice's currency (a line labelled with it whose amount_in_currency is 0
 * still counts as readable, because its real SEK movement is not in the SEK
 * total), zero lines labelled with a third currency, a positive SEK total, a
 * sane exchange_rate, and that SEK total within 10 % of remaining x rate.
 */
export function sekBookedSettlement(
  sideLines: readonly SettlementSideLine[],
  invoiceCurrency: string,
  exchangeRate: unknown,
  remainingAmount: number,
): SekBookedSettlement {
  let readableCount = 0
  let sekSideTotal = 0
  let foreignLabelCount = 0
  for (const line of sideLines) {
    if (!(line.sideSek > 0)) continue
    if (line.currency === invoiceCurrency && line.amount_in_currency != null) {
      readableCount += 1
    } else if ((line.currency ?? 'SEK') === 'SEK') {
      sekSideTotal += line.sideSek
    } else {
      foreignLabelCount += 1
    }
  }
  const rate = Number(exchangeRate)
  const eligible =
    invoiceCurrency !== 'SEK' &&
    readableCount === 0 &&
    foreignLabelCount === 0 &&
    sekSideTotal > 0 &&
    Number.isFinite(rate) &&
    rate > 0 &&
    rate < 100000
  if (!eligible) return { eligible: false, reason: 'not_eligible' }
  const sekTotal = roundOre(sekSideTotal)
  const bookedSek = sekOfForeign(remainingAmount, rate)
  if (fxDeviationTooLarge(sekTotal, bookedSek)) {
    return { eligible: false, reason: 'fx_deviation_too_large', sekTotal, bookedSek }
  }
  return { eligible: true, sekTotal, bookedSek }
}

/** Which line of a voucher settles the invoice. */
export interface SettlementSearchSide {
  /** Account prefix of the settlement line: 151, 244 or 19. */
  accountPrefix: string
  /**
   * Whole account numbers that settle besides the prefix: 2013 (the owner's
   * private funds) on the customer 19xx side (settlesOnAccount, crm#1580),
   * 2018 and 2893 on the supplier 19xx side (crm#1817).
   */
  alsoAccounts?: readonly string[]
  /** The side of that line that settles the invoice. */
  entrySide: 'debit' | 'credit'
  /**
   * The 19xx side. Every receipt or payout moves it, so the unfiltered set is
   * the company's whole bank history in the window: a SEK search is banded
   * around the invoice (candidateAmountBand) and a foreign one reads only the
   * lines labelled with the invoice's currency, the only ones expressible in
   * it. A 151x credit or 244x debit is rare enough to read unbanded.
   */
  bankSide: boolean
}

/** One voucher that carries the settlement side, summed in the invoice's currency. */
export interface SettlementVoucher {
  entry: VoucherRow
  /** The settlement side over the whole voucher, in the invoice's currency. */
  amount: number
  /** Currency of the first readable settlement line; null on the SEK-booked fallback. */
  lineCurrency: string | null
  /** Set when the voucher settles through the SEK-booked fallback. */
  sekBooked?: { sekTotal: number }
  /**
   * Set when lines on SettlementSearchSide.alsoAccounts are part of `amount`:
   * how much of it they carry, in the invoice's currency (all of it on the
   * SEK-booked fallback). The supplier side counts those lines only on a
   * verifikat that books a purchase (crm#1817).
   */
  beyondPrefix?: { amount: number }
}

export interface SettlementVoucherSearch {
  supabase: SupabaseClient
  companyId: string
  invoice: { currency: string | null; exchange_rate?: unknown; total: number; due_date: string }
  remainingAmount: number
  side: SettlementSearchSide
  windowDays: number
  /** False where the link refuses the SEK-booked fallback for this invoice. */
  sekBookedAllowed: boolean
  /**
   * A voucher a person named by its number in the picker's search. It is
   * read at any date, since a verifikat that clears an invoice can be booked
   * long after the due date (a konstaterad kundförlust at the year end, crm#1434),
   * and its settlement side is read in full, without the 19xx amount band.
   */
  voucher?: VoucherNumber
  log: Logger
  logContext: Record<string, unknown>
}

/**
 * Every posted voucher inside +-windowDays of the due date that carries the
 * invoice's settlement side, summed per voucher in the invoice's currency
 * (a samlingsverifikation can carry several settlement lines). A voucher whose
 * settlement side the invoice's currency cannot read is kept only through the
 * SEK-booked fallback, valued at the invoice's rate, exactly as the link
 * validator and the RPC judge it.
 *
 * Driven from journal_entries (fetchEntryLines) and read in full: no row cap.
 * A cap on an unordered query drops vouchers before scoring ever sees them,
 * and the exact-amount one is as likely to go as any other. A failed read
 * answers no vouchers, logged, rather than breaking the dialog.
 */
export async function collectSettlementVouchers(
  search: SettlementVoucherSearch,
): Promise<Map<string, SettlementVoucher>> {
  const { invoice, side, remainingAmount } = search
  const byEntry = new Map<string, SettlementVoucher>()

  const dueDate = new Date(invoice.due_date)
  const dateFrom = new Date(dueDate)
  dateFrom.setDate(dateFrom.getDate() - search.windowDays)
  const dateTo = new Date(dueDate)
  dateTo.setDate(dateTo.getDate() + search.windowDays)

  // `documentCurrency()` and not `invoice.currency` directly: a NULL code
  // would test `!== 'SEK'` and send a plain domestic invoice down the FX path
  // where nothing is convertible. The label guard in the scorer still compares
  // the RAW `invoice.currency`, so such a row behaves as it always did.
  const invoiceCurrency = documentCurrency(invoice.currency)
  const isForeignInvoice = invoiceCurrency !== 'SEK'
  const amountColumn = side.entrySide === 'credit' ? 'credit_amount' : 'debit_amount'

  // `amount_in_currency` is in the column list on purpose: on a foreign
  // invoice it is the ONLY column quoted in the invoice's currency (debit and
  // credit are always SEK). Without it every FX line would be unconvertible.
  let lines: Array<VoucherMatchLineRow & { journal_entries: VoucherRow }>
  try {
    lines = await fetchEntryLines({
      supabase: search.supabase,
      entryColumns:
        'id, voucher_series, voucher_number, entry_date, description, status, source_type, fiscal_period_id, company_id',
      lineColumns:
        'id, journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency',
      filterEntries: (q: EntryLinesQuery) => {
        const posted = q.eq('company_id', search.companyId).eq('status', 'posted')
        const named = search.voucher
        if (named) {
          const byNumber = posted.eq('voucher_number', named.number)
          return named.series === null ? byNumber : byNumber.eq('voucher_series', named.series)
        }
        return posted
          .gte('entry_date', dateFrom.toISOString().slice(0, 10))
          .lte('entry_date', dateTo.toISOString().slice(0, 10))
      },
      filterLines: (q: EntryLinesQuery) => {
        const onSide = side.alsoAccounts?.length
          ? q.or([`account_number.like.${side.accountPrefix}%`, ...side.alsoAccounts.map((a) => `account_number.eq.${a}`)].join(','))
          : q.like('account_number', `${side.accountPrefix}%`)
        const scoped = onSide.gt(amountColumn, 0)
        if (!side.bankSide || search.voucher) return scoped
        if (isForeignInvoice) return scoped.eq('currency', invoiceCurrency)
        const band = candidateAmountBand(remainingAmount, invoice.total)
        return scoped.gte(amountColumn, band.floor).lte(amountColumn, band.ceil)
      },
    })
  } catch (error) {
    search.log.warn('voucher candidate query failed', {
      ...search.logContext,
      message: error instanceof Error ? error.message : String(error),
    })
    return byEntry
  }

  const pending = new Map<
    string,
    {
      entry: VoucherRow
      amount: number
      lineCurrency: string | null
      sideLines: SettlementSideLine[]
      unconvertible: boolean
      beyondPrefix: number | null
    }
  >()
  for (const line of lines) {
    const entry = line.journal_entries
    if (!entry) continue
    if (EXCLUDED_SOURCE_TYPES.includes(entry.source_type ?? '')) continue
    const rawSide = Number(side.entrySide === 'credit' ? line.credit_amount : line.debit_amount) || 0
    if (rawSide <= 0) continue
    let voucher = pending.get(entry.id)
    if (!voucher) {
      voucher = { entry, amount: 0, lineCurrency: null, sideLines: [], unconvertible: false, beyondPrefix: null }
      pending.set(entry.id, voucher)
    }
    const beyondPrefix = !!line.account_number && !line.account_number.startsWith(side.accountPrefix)
    if (beyondPrefix) voucher.beyondPrefix ??= 0
    voucher.sideLines.push({ currency: line.currency, amount_in_currency: line.amount_in_currency, sideSek: rawSide })
    // The settlement side quoted in the INVOICE's currency: the SEK column on
    // a SEK invoice, amount_in_currency on a foreign one, null for a line that
    // carries no figure in that currency.
    const amount = ledgerLineSideAmountIn(line, invoiceCurrency, side.entrySide)
    if (amount === null) {
      voucher.unconvertible = true
      continue
    }
    if (amount <= 0) continue
    if (voucher.amount === 0) voucher.lineCurrency = line.currency
    voucher.amount += amount
    if (beyondPrefix) voucher.beyondPrefix = (voucher.beyondPrefix ?? 0) + amount
  }

  const fxRate = Number(invoice.exchange_rate)
  for (const [entryId, voucher] of pending) {
    if (voucher.unconvertible) {
      const fallback = search.sekBookedAllowed
        ? sekBookedSettlement(voucher.sideLines, invoiceCurrency, invoice.exchange_rate, remainingAmount)
        : null
      if (!fallback?.eligible) continue
      const amount = roundOre(fallback.sekTotal / fxRate)
      byEntry.set(entryId, {
        entry: voucher.entry,
        amount,
        lineCurrency: null,
        sekBooked: { sekTotal: fallback.sekTotal },
        ...(voucher.beyondPrefix === null ? {} : { beyondPrefix: { amount } }),
      })
    } else if (voucher.amount > 0) {
      byEntry.set(entryId, {
        entry: voucher.entry,
        amount: voucher.amount,
        lineCurrency: voucher.lineCurrency,
        ...(voucher.beyondPrefix === null ? {} : { beyondPrefix: { amount: voucher.beyondPrefix } }),
      })
    }
  }
  return byEntry
}

/** A payment row that already points at a candidate voucher, on either side
 *  (invoice_payments or supplier_invoice_payments), keyed by its invoice. */
export interface VoucherPaymentUse {
  invoiceId: string
  amount: number | string | null
  currency: string | null
}

/**
 * What a candidate voucher can still settle for `invoiceId`, as the link RPCs
 * count it on both sides (20261011153000 supplier, 20261026007000 customer):
 * its settlement side less every payment row that points at it for ANOTHER
 * invoice. Null when it is no candidate at all: already linked to this
 * invoice, carrying a row in another currency (the used part is unreadable),
 * read through the SEK-booked fallback while another invoice has a row on it
 * (that fallback reads the voucher as this invoice's whole remainder), or
 * nothing left.
 */
export function voucherCapacity(
  voucher: Pick<SettlementVoucher, 'amount' | 'sekBooked'>,
  rows: readonly VoucherPaymentUse[],
  invoiceId: string,
  invoiceCurrency: string,
): { left: number; used: number } | null {
  if (rows.some((r) => r.invoiceId === invoiceId)) return null
  if (voucher.sekBooked && rows.length > 0) return null
  if (rows.some((r) => (r.currency ?? 'SEK') !== invoiceCurrency)) return null
  const used = roundOre(rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0))
  const left = roundOre(voucher.amount - used)
  return left > AMOUNT_TOLERANCE ? { left, used } : null
}

/** What a candidate tells the picker about the share a link may state. */
export interface VoucherShareFields {
  /** Set when the voucher has MORE left than the invoice needs: the share to
   *  state as `amount` on the link (the invoice's remainder). Such a voucher
   *  is refused without a stated share, since it settles other debts too. */
  link_amount?: number
  /** Set when payment rows for other invoices already use part of the
   *  voucher: the candidate's amount is what is left after them. */
  already_linked?: number
  /** Set on the SEK-booked fallback: the link settles the invoice's whole
   *  remainder and refuses a stated share (the kursdifferens would be a guess). */
  whole_remainder?: true
}

export function voucherShareFields(
  left: number,
  used: number,
  remainingAmount: number,
  sekBooked: boolean,
): VoucherShareFields {
  if (sekBooked) return { whole_remainder: true }
  return {
    ...(left > remainingAmount + AMOUNT_TOLERANCE ? { link_amount: roundOre(remainingAmount) } : {}),
    ...(used > AMOUNT_TOLERANCE ? { already_linked: used } : {}),
  }
}

/**
 * The fiscal periods among `periodIds` that are closed (`is_closed`) or
 * locked (`locked_at`): `fiscal_periods` has no status column. Linking is
 * allowed in a locked period (no journal entry is mutated), so the flag is
 * advisory, and it fails CLOSED: when the state cannot be read every period
 * counts as locked, since an over-cautious badge costs nothing while a
 * wrongly absent one tells the user a period is writable.
 */
export async function lockedPeriodIds(
  supabase: SupabaseClient,
  periodIds: string[],
  log: Logger,
  logContext: Record<string, unknown>,
): Promise<Set<string>> {
  if (periodIds.length === 0) return new Set()
  const { data: periods, error } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at')
    .in('id', periodIds)
  if (error || !periods) {
    log.warn('fiscal period lock state unavailable, flagging candidates as locked', {
      ...logContext,
      reason: error?.message,
    })
    return new Set(periodIds)
  }
  return new Set(
    (periods as FiscalPeriodRow[])
      .filter((p) => p.is_closed === true || p.locked_at != null)
      .map((p) => p.id),
  )
}

/** A reference the invoice can be named by in a voucher text. */
export interface VoucherReference {
  /** How the reason names it: 'Fakturanummer', 'Ankomstnummer'. */
  label: string
  value: string | number | null | undefined
  /**
   * Whether the reference alone, with an amount that does not settle the
   * invoice, is still a strong hint (0.90). True for an invoice number; false
   * for our own ankomstnummer (1, 2, 3, ...), which no bank or source system
   * writes on a payment, so it counts only with a settling amount (desk crm#64).
   */
  countsWithoutAmount: boolean
}

export interface VoucherScoreContext {
  /** The invoice's own currency code, raw: the label guard compares it. */
  currency: string
  remainingAmount: number
  total: number
  dueDate: string
  windowDays: number
  references: VoucherReference[]
  counterparty: { name: string | undefined; label: 'kundnamn' | 'leverantörsnamn' }
  /**
   * Offer a voucher with more left than the invoice needs although nothing
   * else ties it to the invoice: a payment of several debts, linkable with a
   * stated share. Only the supplier side's person-facing surfaces set it.
   */
  includeShared: boolean
}

/**
 * Confidence of a voucher offered only because it has more left than the
 * invoice needs (a payment of several debts). The amount says nothing about
 * WHICH debts, so it ranks under every amount match and far under the
 * unattended auto-link bar; the counterparty's name in the voucher text lifts
 * it one step, still a "weak match" to the picker.
 *
 * Within the class the date is the only thing that tells the vouchers apart,
 * and a company that pays its suppliers every week has a dozen larger payment
 * runs inside the window. So the closer to the due date, the higher: up to
 * SHARED_VOUCHER_PROXIMITY_SPAN at the due date, nothing at the window's edge.
 * The ceiling, with the name and the 7-day bump, is 0.64: still under "likely
 * match" (0.7).
 */
const SHARED_VOUCHER_CONFIDENCE = 0.4
const SHARED_VOUCHER_COUNTERPARTY_CONFIDENCE = 0.5
const SHARED_VOUCHER_PROXIMITY_SPAN = 0.09

/** 1 at the due date, 0 at the edge of the window or when a date is unreadable. */
function dueDateCloseness(entryDate: string, dueDate: string, windowDays: number): number {
  const days = Math.abs(new Date(entryDate).getTime() - new Date(dueDate).getTime()) / (24 * 3600 * 1000)
  if (!Number.isFinite(days) || windowDays <= 0) return 0
  return Math.max(0, 1 - days / windowDays)
}

/**
 * Score one voucher against the invoice, or null when it is no candidate.
 *
 * A reference in the voucher text (descriptionMentionsReference: a whole
 * number, never "14" inside "(1814)") earns 0.99 only with an amount that
 * settles the invoice (its remainder or its total); an invoice number with
 * another amount stays a 0.90 hint for a person, since a text naming the
 * invoice can still be a partial payment. Then the amount ladder: exact
 * remainder, exact total, fuzzy remainder (+-1 % capped at 500), each lifted
 * by the counterparty's name, plus a bump within 7 days of the due date.
 *
 * `shareable` is false where the voucher cannot take a share (the SEK-booked
 * fallback: the kursdifferens would be a guess).
 */
export function scoreVoucherCandidate(
  entry: VoucherRow,
  amount: number,
  lineCurrency: string | null,
  ctx: VoucherScoreContext,
  shareable = true,
): { confidence: number; match_reason: string } | null {
  const settlesInvoice =
    amountsMatchExact(amount, ctx.remainingAmount) || amountsMatchExact(amount, ctx.total)
  const hits = ctx.references.filter((ref) => descriptionMentionsReference(entry.description, ref.value))
  if (settlesInvoice && hits.length > 0) {
    return {
      confidence: CONFIDENCE.OCR_REFERENCE_MATCH,
      match_reason: `${hits[0].label} ${hits[0].value} omnämnt i verifikatets beskrivning och beloppet stämmer`,
    }
  }
  const hint = hits.find((ref) => ref.countsWithoutAmount)
  if (hint) {
    return {
      confidence: CONFIDENCE.REFERENCE_AMOUNT_MISMATCH,
      match_reason: `${hint.label} ${hint.value} omnämnt i verifikatets beskrivning, men beloppet (${formatNumber(amount)} ${ctx.currency}) avviker från fakturans`,
    }
  }

  // Label guard. It is not what makes the amounts comparable (`amount`
  // already arrives in the invoice's currency, and a line that could not be
  // expressed there was dropped or went through the SEK-booked fallback); it
  // is a counterparty discriminator: a settlement line stamped with another
  // document's currency belongs to another invoice.
  if ((lineCurrency ?? ctx.currency) !== ctx.currency) return null

  const exactRemaining = amountsMatchExact(amount, ctx.remainingAmount)
  const exactTotal = !exactRemaining && amountsMatchExact(amount, ctx.total)
  const fuzzyRemaining = !exactRemaining && !exactTotal && amountsMatchFuzzy(amount, ctx.remainingAmount)
  const nameMatch = customerNameMatches(ctx.counterparty.name, entry.description, null)
  const name = ctx.counterparty.label

  let confidence: number
  let reason: string
  if (exactRemaining && nameMatch) {
    confidence = CONFIDENCE.EXACT_AMOUNT_CUSTOMER
    reason = `Exakt belopp (${formatNumber(amount)} ${ctx.currency}) och ${name} matchar`
  } else if (exactRemaining) {
    confidence = CONFIDENCE.EXACT_AMOUNT_ONLY
    reason = `Exakt belopp (${formatNumber(amount)} ${ctx.currency})`
  } else if (exactTotal && nameMatch) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_CUSTOMER
    reason = `Fakturans totalbelopp och ${name} matchar`
  } else if (exactTotal) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_ONLY + 0.05
    reason = `Fakturans totalbelopp matchar`
  } else if (fuzzyRemaining && nameMatch) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_CUSTOMER
    reason = `Belopp nära (±1%) och ${name} matchar`
  } else if (fuzzyRemaining) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_ONLY
    reason = `Belopp nära (±1%)`
  } else if (ctx.includeShared && shareable && amount > ctx.remainingAmount + AMOUNT_TOLERANCE) {
    // A payment of several debts: the voucher has more left than this invoice
    // needs, and nothing but the person picking says it is this invoice's.
    const base = nameMatch ? SHARED_VOUCHER_COUNTERPARTY_CONFIDENCE : SHARED_VOUCHER_CONFIDENCE
    const closeness = dueDateCloseness(entry.entry_date, ctx.dueDate, ctx.windowDays)
    confidence = Math.round((base + SHARED_VOUCHER_PROXIMITY_SPAN * closeness) * 1000) / 1000
    reason = `Verifikationen har ${formatNumber(amount)} ${ctx.currency} kvar, mer än fakturans belopp: betalar den flera skulder länkas fakturans del${nameMatch ? `; ${name} matchar` : ''}`
  } else {
    return null
  }

  if (isDateWithinDays(entry.entry_date, ctx.dueDate, 7)) {
    confidence = Math.min(CONFIDENCE.OCR_REFERENCE_MATCH - 0.001, confidence + DATE_PROXIMITY_BUMP)
  }
  return { confidence, match_reason: reason }
}

/** Confidence of a voucher offered only because a person named it by its
 *  number: nothing else ties it to the invoice, so it is a "weak match". */
const NAMED_VOUCHER_CONFIDENCE = 0.5

/**
 * Score a voucher a person named by its number (SettlementVoucherSearch.voucher).
 * The ordinary scorer decides first; a voucher it would drop on the amount
 * alone (a part payment, or a share without includeShared) is still offered,
 * because the person asked for that very voucher and the link validator makes
 * the final call. The label guard still holds: a settlement line stamped with
 * another document's currency belongs to another invoice.
 */
export function scoreNamedVoucherCandidate(
  entry: VoucherRow,
  amount: number,
  lineCurrency: string | null,
  ctx: VoucherScoreContext,
  shareable = true,
): { confidence: number; match_reason: string } | null {
  const scored = scoreVoucherCandidate(entry, amount, lineCurrency, ctx, shareable)
  if (scored) return scored
  if ((lineCurrency ?? ctx.currency) !== ctx.currency) return null
  return {
    confidence: NAMED_VOUCHER_CONFIDENCE,
    match_reason: `Sökt på verifikationsnumret; verifikationen har ${formatNumber(amount)} ${ctx.currency} kvar att koppla`,
  }
}

/** The reason suffix of a voucher that settles through the SEK-booked fallback. */
export function sekBookedReason(reason: string, sekTotal: number): string {
  return `${reason}; betalningen är bokförd i SEK (${formatNumber(sekTotal)} kr) och omräknad med fakturans kurs`
}

/** Highest confidence first, then the earliest voucher; at most `limit`. */
export function rankVoucherCandidates<T extends { confidence: number; entry_date: string }>(
  candidates: T[],
  limit: number,
): T[] {
  return [...candidates]
    .sort((a, b) => b.confidence - a.confidence || a.entry_date.localeCompare(b.entry_date))
    .slice(0, limit)
}

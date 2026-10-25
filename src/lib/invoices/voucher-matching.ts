/**
 * Link an existing posted verifikat to a customer invoice as its payment row.
 *
 * The matched side follows the INVOICE's own booking, read from
 * invoice_settlement_side() (./invoice-settlement-side.ts), the same function
 * the link_invoice_to_voucher RPC reads:
 *   • the 151x credit (ar_credit) for an invoice that sits on kundfordringar:
 *     faktureringsmetoden, an invoice booked at issue before a switch to
 *     kontantmetoden, and a kontantmetod invoice carried over the year end
 *     (#3440). E.g. a SIE-imported payment voucher or a manually-entered
 *     receipt that clears the receivable;
 *   • the 19xx debit (bank_debit) for a kontantmetod invoice that was never
 *     booked: revenue is recognised at payment (debit 19xx / credit
 *     30xx+26xx), so the verifikat that DEBITS a liquid-funds account (BAS
 *     class 19: 1910/1920/1930/1940…) IS the payment the user already booked;
 *     linking just marks the invoice paid without a duplicate entry.
 *
 * No payment entry is created in either case. Only an invoice_payments row
 * is inserted pointing at the existing journal_entry_id, plus the invoice's
 * paid_amount/remaining_amount/status are advanced. The one exception is the
 * sale of an invoice a deferring company (defer_invoice_booking) has not
 * booked yet: the Bokför step books it first, on its invoice date, so the
 * linked voucher's 151x credit clears a receivable the ledger carries
 * (./sale-first.ts).
 *
 * Both the web API route and the MCP commit handler call into the same
 * `linkInvoiceToVoucher()` function (→ link_invoice_to_voucher RPC) so
 * behaviour stays in lockstep.
 *
 * One verifikat may settle several invoices (a bankgiro bundle, or a
 * kundförlust booked for several invoices in one verifikat), never for more
 * than its settlement side holds: payment rows that already point at it for
 * other invoices have used part of it (migration 20261026007000, crm#1434,
 * the mirror of the supplier side's 20261011153000). A link may state
 * `amount`: this invoice's share of the verifikat, in the invoice's currency,
 * bounded by the invoice's remainder and by what the verifikat has left.
 * Without a stated share nothing is split on a guess: what the verifikat has
 * left must fit inside the invoice's remainder
 * (LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING otherwise).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { createLogger } from '@/lib/logger'
import { autoReconcileTransactionForLinkedVoucher } from '@/lib/reconciliation/bank-reconciliation'
import { clearSettledInvoiceSuggestions } from './clear-settled-invoice-suggestions'
import { anchorCustomerInvoiceDocument } from '@/lib/core/documents/customer-invoice-underlag'
import { releaseDoubtfulReserveAfterChange } from '@/lib/customer-loss/doubtful'
import { documentCurrency, ledgerLineSideAmountIn } from '@/lib/bookkeeping/ledger-line-amount'
import type { SqlBusinessEventLink } from '@/lib/bookkeeping/business-event-link'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { voucherLinkKursdifferensBusinessEvent } from '@/lib/bookkeeping/sql-posting-business-events'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { Invoice, Customer } from '@/types'
import {
  AMOUNT_TOLERANCE,
  DEFAULT_DATE_WINDOW_DAYS,
  EXCLUDED_SOURCE_TYPES,
  collectSettlementVouchers,
  lockedPeriodIds,
  rankVoucherCandidates,
  scoreVoucherCandidate,
  sekBookedReason,
  sekBookedSettlement,
  type SettlementSideLine,
  type VoucherRow,
  type VoucherScoreContext,
} from './voucher-matching-shared'
import { roundOre } from '@/lib/money'
import { scheduleCollectionForwardDrain } from '@/lib/collections/forward-hook'
import { resolveInvoiceSettlementSide } from './invoice-settlement-side'
import {
  bookSaleBeforeSettlement,
  planSaleBeforeSettlementById,
  saleFirstRefusalCode,
  type SaleFirstRefusal,
} from './sale-first'

const log = createLogger('voucher-matching')

export interface VoucherCandidate {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  /** Matched amount on this voucher, always positive: the AR credit (151x),
   *  or the liquid-funds debit (19xx) for a never-booked kontantmetod invoice
   *  (invoice_settlement_side).
   *  Expressed in `currency` below (the INVOICE's currency), never in the raw
   *  SEK ledger column: see ledgerLineSideAmountIn.
   *  Kept under this name for API/UI back-compat across both methods. */
  ar_credit_amount: number
  /** The unit `ar_credit_amount` is quoted in: always the invoice's currency. */
  currency: string
  /** Currency of the matched line; nullable when the line stores SEK only. */
  ar_line_currency: string | null
  /** True when the voucher's fiscal period is closed or locked. */
  period_locked: boolean
  /** Confidence score 0..1 (or 0.99 for OCR match). */
  confidence: number
  /** Localized reason in Swedish (mirrors invoice-matching.ts conventions). */
  match_reason: string
}

/**
 * Find posted journal entries that could plausibly be the payment for this
 * invoice and return up to `limit` ranked candidates: vouchers crediting an
 * AR account (151x), or debiting a liquid-funds account (19xx) for a
 * kontantmetod invoice that was never booked: see the module header.
 *
 * The search and the ranking are the shared voucher-link matcher
 * (voucher-matching-shared.ts), the same one the supplier side runs: every
 * voucher in the window is read (no row cap), a foreign invoice paid by a
 * voucher booked in kronor only is offered through the SEK-booked fallback the
 * link itself accepts, and the validator makes the final call at commit time.
 */
export async function findMatchingVouchersForInvoice(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Invoice & { customer?: Customer },
  options: { limit?: number; dateWindowDays?: number } = {}
): Promise<VoucherCandidate[]> {
  const limit = options.limit ?? 10
  const windowDays = options.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS

  const remainingAmount = computeRemaining(invoice)
  if (remainingAmount <= AMOUNT_TOLERANCE) return []

  // The bank/cash DEBIT (19xx) for a never-booked kontantmetod invoice, the
  // AR CREDIT (151x) for every other one: the RPC's own rule, by invoice id.
  const settlement = await resolveInvoiceSettlementSide(supabase, companyId, invoice.id)
  const logContext = { companyId, invoiceId: invoice.id }
  const byEntry = await collectSettlementVouchers({
    supabase,
    companyId,
    invoice,
    remainingAmount,
    side: {
      accountPrefix: settlement.accountPrefix,
      entrySide: settlement.entrySide,
      bankSide: settlement.side === 'bank_debit',
    },
    windowDays,
    // As the validator and the RPC: both sides settle in kronor. The 151x
    // side books the kursdifferens, the 19xx side has no receivable to book
    // one against (20261018131110).
    sekBookedAllowed: true,
    log,
    logContext,
  })
  if (byEntry.size === 0) return []

  // Drop vouchers already linked to *this* invoice.
  const { data: existingLinks } = await supabase
    .from('invoice_payments')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .eq('invoice_id', invoice.id)
    .in('journal_entry_id', Array.from(byEntry.keys()))
  for (const row of existingLinks ?? []) {
    const id = (row as { journal_entry_id: string | null }).journal_entry_id
    if (id) byEntry.delete(id)
  }
  if (byEntry.size === 0) return []

  const lockedPeriods = await lockedPeriodIds(
    supabase,
    Array.from(new Set(Array.from(byEntry.values()).map((v) => v.entry.fiscal_period_id))),
    log,
    logContext,
  )

  const scoreContext: VoucherScoreContext = {
    currency: invoice.currency,
    remainingAmount,
    total: invoice.total,
    dueDate: invoice.due_date,
    windowDays,
    references: [{ label: 'Fakturanummer', value: invoice.invoice_number, countsWithoutAmount: true }],
    counterparty: { name: invoice.customer?.name, label: 'kundnamn' },
    includeShared: false,
  }
  const candidates: VoucherCandidate[] = []
  for (const { entry, amount, lineCurrency, sekBooked } of byEntry.values()) {
    const scored = scoreVoucherCandidate(entry, amount, lineCurrency, scoreContext, !sekBooked)
    if (!scored) continue
    candidates.push({
      journal_entry_id: entry.id,
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      description: entry.description,
      ar_credit_amount: roundOre(amount),
      currency: invoice.currency,
      ar_line_currency: lineCurrency,
      period_locked: lockedPeriods.has(entry.fiscal_period_id),
      confidence: scored.confidence,
      match_reason: sekBooked ? sekBookedReason(scored.match_reason, sekBooked.sekTotal) : scored.match_reason,
    })
  }
  return rankVoucherCandidates(candidates, limit)
}

export type ValidateResult =
  | {
      ok: true
      arCreditAmount: number
      arLineCurrency: string | null
      voucher: VoucherRow
      remainingAfter: number
      isFullyPaid: boolean
      paymentAmount: number
      /** What the voucher keeps for other invoices after this link. */
      voucherRemainingAfter: number
    }
  | {
      ok: false
      code: VoucherLinkErrorCode
      details?: Record<string, unknown>
    }

export type VoucherLinkErrorCode =
  | 'LINK_VOUCHER_INVOICE_NOT_FOUND'
  | 'LINK_VOUCHER_VOUCHER_NOT_FOUND'
  | 'LINK_VOUCHER_NOT_POSTED'
  | 'LINK_VOUCHER_NO_AR_CREDIT'
  | 'LINK_VOUCHER_ALREADY_LINKED'
  | 'LINK_VOUCHER_FULLY_ALLOCATED'
  | 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING'
  | 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER'
  | 'LINK_VOUCHER_AMOUNT_INVALID'
  | 'LINK_VOUCHER_CURRENCY_MISMATCH'
  | 'LINK_VOUCHER_INVOICE_FULLY_PAID'
  | 'LINK_VOUCHER_DB_ERROR'

/** A payment row that already points at the voucher, whichever invoice it
 *  belongs to: what it used of the settlement side. */
interface VoucherPaymentRow {
  invoice_id: string
  amount: number | string | null
  currency: string | null
}

/**
 * Validate that a journal entry can be linked as payment for an invoice,
 * with the RPC's guards in the RPC's order. Used by both the staging path
 * (MCP tool) and the commit path (web route + MCP commit handler) so the
 * guards stay identical; the RPC stays the authority.
 *
 * `amount` is the stated share of the voucher that is this invoice's, in the
 * invoice's currency (see the module header); omitted, what the voucher has
 * left must fit inside the invoice's remainder.
 */
export async function validateVoucherForInvoiceLink(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Invoice & { customer?: Customer },
  journalEntryId: string,
  amount?: number | null,
): Promise<ValidateResult> {
  // A stated share is a positive amount to the öre, judged first as in the RPC.
  const statedAmount = amount == null ? null : roundOre(amount)
  if (statedAmount !== null && !(Number.isFinite(statedAmount) && statedAmount > 0)) {
    return { ok: false, code: 'LINK_VOUCHER_AMOUNT_INVALID', details: { amount } }
  }

  const remainingAmount = computeRemaining(invoice)
  if (remainingAmount <= AMOUNT_TOLERANCE) {
    return { ok: false, code: 'LINK_VOUCHER_INVOICE_FULLY_PAID' }
  }

  // Match the bank/cash debit or the AR credit, as invoice_settlement_side()
  // decides for THIS invoice: see the header.
  const settlement = await resolveInvoiceSettlementSide(supabase, companyId, invoice.id)
  const accountPrefix = settlement.accountPrefix

  const { data: voucher, error: voucherError } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number, entry_date, description, status, source_type, fiscal_period_id, company_id')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (voucherError || !voucher) {
    return { ok: false, code: 'LINK_VOUCHER_VOUCHER_NOT_FOUND' }
  }

  const v = voucher as VoucherRow & { company_id: string }
  if (v.status !== 'posted') {
    return { ok: false, code: 'LINK_VOUCHER_NOT_POSTED', details: { status: v.status } }
  }
  if (EXCLUDED_SOURCE_TYPES.includes(v.source_type ?? '')) {
    return { ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT', details: { source_type: v.source_type } }
  }

  // `amount_in_currency` is not optional here: on a foreign invoice it is the
  // ONLY column quoted in the invoice's currency. Omitting it from the column
  // list would leave every FX line unconvertible and this guard would reject
  // vouchers it should accept.
  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, currency, amount_in_currency')
    .eq('journal_entry_id', journalEntryId)
  if (linesError || !lines || lines.length === 0) {
    return { ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' }
  }

  // Nullable column, non-null type: see documentCurrency(). The label guard
  // below still compares the RAW invoice.currency, so a NULL row is rejected
  // exactly as it was before, rather than newly failing as "unconvertible".
  const invoiceCurrency = documentCurrency(invoice.currency)
  const matchedSide: 'debit' | 'credit' = settlement.entrySide
  let arCreditTotal = 0
  let lineCurrency: string | null = null
  // A matched-side line on the right account that carries no amount in the
  // invoice's currency. Fail CLOSED on it, UNLESS the whole matched side is
  // genuinely SEK-booked: then the fallback below is the RPC's FX residual
  // settlement gate (sekBookedSettlement, migration 20260830140000).
  let unconvertibleLineCurrency: string | null | undefined
  const sideLines: SettlementSideLine[] = []
  for (const raw of lines) {
    const line = raw as {
      account_number: string
      debit_amount: number | null
      credit_amount: number | null
      currency: string | null
      amount_in_currency: number | string | null
    }
    if (!line.account_number?.startsWith(accountPrefix)) continue
    // Only a line that actually moves on the matched side counts as evidence
    // of a settlement; the opposite leg is irrelevant.
    const rawSide = Number(matchedSide === 'debit' ? line.debit_amount : line.credit_amount) || 0
    if (rawSide > 0) {
      sideLines.push({ currency: line.currency, amount_in_currency: line.amount_in_currency, sideSek: rawSide })
    }
    const matched = ledgerLineSideAmountIn(line, invoiceCurrency, matchedSide)
    if (matched === null) {
      if (rawSide > 0 && unconvertibleLineCurrency === undefined) {
        unconvertibleLineCurrency = line.currency
      }
      continue
    }
    if (matched <= 0) continue
    arCreditTotal += matched
    if (!lineCurrency) lineCurrency = line.currency
  }
  arCreditTotal = roundOre(arCreditTotal)

  if (unconvertibleLineCurrency !== undefined && statedAmount !== null) {
    // A stated share needs the voucher's side in the invoice's currency. The
    // fallback below reads a kronor voucher as the settlement of the
    // invoice's WHOLE remainder and the RPC books the kursdifferens from
    // that; the kronor behind a part of it are not in the books, so a share
    // would book a kursdifferens on a guess. Answered before the fallback, as
    // in the RPC.
    return {
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: {
        invoice_currency: invoice.currency,
        line_currency: unconvertibleLineCurrency,
        reason: 'amount_needs_invoice_currency',
      },
    }
  }
  if (unconvertibleLineCurrency !== undefined) {
    // SEK-booked settlement fallback, the RPC gate itself (sekBookedSettlement,
    // shared with the supplier side and the candidate search): zero readable
    // lines, every unreadable line SEK-booked, a sane invoice exchange_rate,
    // and the voucher's SEK total within 10% of remaining * rate. The RPC
    // settles the full remaining. On the 151x side it also books the FX
    // residual to 7960/3960: the invoice holds a 1510 balance at the invoice
    // rate (faktureringsmetoden, or a kontantmetod carry, #3440). On the 19xx
    // side there is no receivable and so no residual, only an invoice to mark
    // paid against the verifikat that holds the money. Since the side follows
    // the invoice's own booking (20261018131110), both sides are eligible;
    // the old "kontantmetoden AND booked" refusal is gone, because such an
    // invoice now reads the 151x side.
    const fallback = sekBookedSettlement(sideLines, invoiceCurrency, invoice.exchange_rate, remainingAmount)
    if (!fallback.eligible) {
      return {
        ok: false,
        code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
        details:
          fallback.reason === 'fx_deviation_too_large'
            ? {
                invoice_currency: invoice.currency,
                line_currency: unconvertibleLineCurrency,
                reason: 'fx_deviation_too_large',
                expected_sek: fallback.bookedSek,
                voucher_sek: fallback.sekTotal,
              }
            : { invoice_currency: invoice.currency, line_currency: unconvertibleLineCurrency },
      }
    }
    // Full-remaining settlement, exactly as the RPC computes it. lineCurrency
    // is null here (no readable line), so the label guard below passes and the
    // exceeds-remaining guard sees an equal amount.
    arCreditTotal = roundOre(remainingAmount)
  }
  const sekFallback = unconvertibleLineCurrency !== undefined

  if (arCreditTotal <= 0) {
    return { ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' }
  }

  // Label guard, unchanged. This is NOT a unit check any more (the amount above
  // is already in the invoice's currency); it is a counterparty discriminator:
  // a matched line stamped with a different document currency belongs to some
  // other invoice. On a foreign invoice it always passes, because only
  // same-labelled lines could be converted at all.
  const lineCurrencyEffective = lineCurrency ?? invoice.currency
  if (lineCurrencyEffective !== invoice.currency) {
    return {
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: invoice.currency, line_currency: lineCurrencyEffective },
    }
  }

  // Capacity of the settlement side, on both sides as in the RPC: rows for
  // OTHER invoices have used part of it; this invoice's own row is the
  // already-linked guard's.
  const sideKey = settlement.side === 'bank_debit' ? 'bank_debit' : 'ar_credit'
  const { data: paymentRows } = await supabase
    .from('invoice_payments')
    .select('invoice_id, amount, currency')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
  const otherRows = ((paymentRows ?? []) as VoucherPaymentRow[]).filter((r) => r.invoice_id !== invoice.id)
  if (sekFallback && otherRows.length > 0) {
    return { ok: false, code: 'LINK_VOUCHER_FULLY_ALLOCATED', details: { linked_rows: otherRows.length } }
  }
  if (otherRows.some((r) => (r.currency ?? 'SEK') !== invoiceCurrency)) {
    return {
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: invoice.currency, reason: 'voucher_settles_other_currency' },
    }
  }
  const used = roundOre(otherRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0))
  const sideTotal = arCreditTotal
  if (arCreditTotal - used <= AMOUNT_TOLERANCE) {
    return {
      ok: false,
      code: 'LINK_VOUCHER_FULLY_ALLOCATED',
      details: { [sideKey]: sideTotal, already_linked: used },
    }
  }
  // From here on arCreditTotal is what the voucher has LEFT.
  arCreditTotal = roundOre(arCreditTotal - used)

  if (statedAmount === null) {
    // No stated share: nothing is split on a guess. What the voucher has left
    // must fit inside the invoice's remainder.
    if (arCreditTotal > remainingAmount + AMOUNT_TOLERANCE) {
      return {
        ok: false,
        code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        details: { ar_credit: arCreditTotal, remaining: roundOre(remainingAmount) },
      }
    }
  } else {
    // A stated share: bounded by the invoice's remainder and by what the
    // voucher has left. The rest of the voucher stays available.
    if (statedAmount > remainingAmount + AMOUNT_TOLERANCE) {
      return {
        ok: false,
        code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        details: { amount: statedAmount, remaining: roundOre(remainingAmount) },
      }
    }
    if (statedAmount > arCreditTotal + AMOUNT_TOLERANCE) {
      return {
        ok: false,
        code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
        details: { amount: statedAmount, available: arCreditTotal, [sideKey]: sideTotal, already_linked: used },
      }
    }
  }

  // Already linked to this invoice? (Final, authoritative check: the DB
  // partial unique index is the last line of defence at insert time.)
  const { data: existingLinks } = await supabase
    .from('invoice_payments')
    .select('id')
    .eq('company_id', companyId)
    .eq('invoice_id', invoice.id)
    .eq('journal_entry_id', journalEntryId)
    .limit(1)
  if (existingLinks && existingLinks.length > 0) {
    return { ok: false, code: 'LINK_VOUCHER_ALREADY_LINKED' }
  }

  const paymentAmount = Math.min(statedAmount ?? arCreditTotal, arCreditTotal, roundOre(remainingAmount))
  const remainingAfter = Math.max(0, roundOre(remainingAmount - paymentAmount))
  const isFullyPaid = remainingAfter <= AMOUNT_TOLERANCE

  return {
    ok: true,
    arCreditAmount: arCreditTotal,
    arLineCurrency: lineCurrency,
    voucher: v,
    remainingAfter,
    isFullyPaid,
    paymentAmount,
    voucherRemainingAfter: roundOre(arCreditTotal - paymentAmount),
  }
}

export interface LinkInvoiceToVoucherParams {
  invoiceId: string
  journalEntryId: string
  notes?: string
  /** The share of the verifikat that is this invoice's, in the invoice's
   *  currency, when the verifikat settles several invoices. */
  amount?: number
}

export interface LinkInvoiceToVoucherResult {
  paymentId: string
  invoiceStatus: 'paid' | 'partially_paid'
  paidAmount: number
  remainingAmount: number
  paymentAmount: number
  journalEntryId: string
  /** Bank transaction auto-reconciled to the linked voucher, if exactly one
   *  unbooked line matched it; null when nothing was safely linkable. Lets the
   *  inbox row leave the Transactions list: the gap this whole flow fixes. */
  reconciledTransactionId: string | null
  /** The sale verifikat this link booked first (defer_invoice_booking), else null. */
  saleJournalEntryId: string | null
  /** What the verifikat keeps for other invoices after this link; null from
   *  a database without migration 20261026007000. */
  voucherRemaining: number | null
}

/** jsonb payload returned by the link_invoice_to_voucher RPC on success. */
interface RpcLinkInvoiceOk {
  ok: true
  payment_id: string
  invoice_status: 'paid' | 'partially_paid'
  paid_amount: number
  remaining_amount: number
  payment_amount: number
  journal_entry_id: string
  currency: string
  payment_date: string
  voucher_remaining?: number | null
}

/** jsonb payload returned by the link_invoice_to_voucher RPC on guard failure. */
interface RpcLinkInvoiceErr {
  ok: false
  code: VoucherLinkErrorCode
  details?: Record<string, unknown>
}

/**
 * Atomically link an existing posted verifikat to an invoice. Inserts an
 * invoice_payments row, advances the invoice's paid_amount/remaining_amount,
 * and emits invoice.paid when the link settles the invoice in full.
 *
 * Re-validates inside the same call to defend against stage→commit drift:
 * voucher reversed, invoice paid by another flow, etc. Any structured
 * rejection is returned as { ok: false, code } so callers can map it to a
 * stable HTTP status + auto-reject the pending op.
 */
export async function linkInvoiceToVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: LinkInvoiceToVoucherParams
): Promise<
  | { ok: true; result: LinkInvoiceToVoucherResult }
  // A link refusal, or the Bokför step's code when the sale the link books
  // first was refused (details.sale_first).
  | { ok: false; code: VoucherLinkErrorCode | SaleFirstRefusal['code']; details?: Record<string, unknown> }
> {
  // Faktureringsmetoden with defer_invoice_booking: an invoice sent without
  // its verifikat gets its sale booked first by the Bokför step, so the linked
  // voucher's 151x credit clears a receivable the ledger carries
  // (./sale-first.ts). The link is validated first, so neither refusal leaves
  // the sale booked.
  const sale = await bookSaleBeforeVoucherLink(supabase, userId, companyId, params)
  if (!sale.ok) return sale

  // All validation + writes happen inside link_invoice_to_voucher (PL/pgSQL).
  // The function locks the invoice row FOR UPDATE, re-validates the voucher,
  // and applies the invoices UPDATE + invoice_payments INSERT in a single PG
  // transaction, so concurrent linkers serialize and a failure on either write
  // rolls back automatically. The previous TS implementation did
  // UPDATE-then-INSERT with a manual rollback that restored from a STALE
  // pre-link snapshot: under concurrent linking it could clobber a sibling's
  // successful write while leaving its payment row in place (audit C2; mirrors
  // the supplier-side link_supplier_invoice_to_voucher fix from PR #602).
  // The posting port (its SQL step): a foreign-currency invoice can get a
  // kursdifferens verifikat from the RPC, so its payment event is recorded
  // first and the RPC links it to that draft before the number is drawn
  // (when the link posts none, the event stays unlinked). Off: nothing is
  // read or built and the RPC is called as before.
  let businessEvents: SqlBusinessEventLink | undefined
  try {
    businessEvents = await postingPort.recordEventsForSql({
      supabase,
      companyId,
      events: () => customerVoucherLinkEvents(supabase, companyId, params),
    })
  } catch (err) {
    // strict: an event that could not be recorded stops the link before any number.
    log.error('link_invoice_to_voucher business event not recorded (strict)', err, { companyId, invoiceId: params.invoiceId })
    return { ok: false, code: 'LINK_VOUCHER_DB_ERROR', details: { reason: err instanceof Error ? err.message : String(err) } }
  }

  // Through the engine door (commitInvoiceVoucherLink, reached through the
  // posting port), which announces the kursdifferens verifikat the RPC posts
  // for a foreign-currency invoice with journal_entry.committed.
  const { data: rpcData, error: rpcError } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'link_invoice_to_voucher',
    args: [
      {
        invoiceId: params.invoiceId,
        journalEntryId: params.journalEntryId,
        notes: params.notes ?? null,
        amount: params.amount ?? null,
        ...(businessEvents ? { businessEvents } : {}),
      },
    ],
  })

  if (rpcError) {
    log.error('link_invoice_to_voucher RPC error', {
      companyId,
      userId,
      invoiceId: params.invoiceId,
      journalEntryId: params.journalEntryId,
      message: rpcError.message,
    })
    return { ok: false, code: 'LINK_VOUCHER_DB_ERROR', details: { reason: rpcError.message } }
  }

  const rpc = rpcData as RpcLinkInvoiceOk | RpcLinkInvoiceErr | null
  if (!rpc) {
    return { ok: false, code: 'LINK_VOUCHER_DB_ERROR', details: { reason: 'empty RPC response' } }
  }
  if (!rpc.ok) {
    return { ok: false, code: rpc.code, details: rpc.details }
  }
  // The payment row the RPC wrote waits in the collections forwarding outbox
  // when the invoice is under collection; report it once this request answers.
  scheduleCollectionForwardDrain(companyId)

  // Fetch the now-updated invoice (with customer) for event emission: the RPC
  // committed before this read, so the row reflects post-link state. Mirrors
  // the supplier-side wrapper.
  const { data: invoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*)')
    .eq('id', params.invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  // invoice.paid only when this link settled the invoice in full: a partial
  // link leaves money owed. The RPC locks the row and refuses an invoice that
  // is not open, so its 'paid' is this call's transition. Best-effort.
  if (invoice) {
    await emitInvoicePaidIfSettled({
      newStatus: rpc.invoice_status,
      invoice: invoice as Invoice,
      paymentAmount: rpc.payment_amount,
      paymentDate: rpc.payment_date,
      userId,
      companyId,
    })
  }

  // The invoice's archived PDF is the underlag for the linked booking. Under
  // kontantmetoden nothing else ever anchors it (there is no registration
  // verifikat), so without this the user re-uploads a file Accounted already
  // holds. Idempotent and never throws: the link has already committed.
  await anchorCustomerInvoiceDocument(supabase, companyId, params.invoiceId)

  // A befarad kundförlust reserve the payment made unnecessary comes back
  // (Dr 1519 / Cr 6352), as on every other payment path. Never throws.
  await releaseDoubtfulReserveAfterChange(supabase, companyId, userId, {
    invoiceId: params.invoiceId,
    entryDate: rpc.payment_date,
    trigger: 'payment',
  })

  // Close the loop on the bank feed: the invoice→voucher link above only
  // advanced the invoice, so the bank transaction that paid it kept sitting in
  // the Transactions inbox (journal_entry_id still null). Reconcile it to the
  // same verifikat when it can be done unambiguously. Best-effort: the invoice
  // link has already committed, so a failure here must not fail the whole call.
  let reconciledTransactionId: string | null = null
  try {
    const recon = await autoReconcileTransactionForLinkedVoucher(
      supabase,
      companyId,
      userId,
      params.journalEntryId,
      { invoiceId: params.invoiceId },
    )
    reconciledTransactionId = recon?.linkedTransactionId ?? null
  } catch (err) {
    log.warn('auto-reconcile of bank transaction after voucher link failed (non-blocking)', {
      companyId,
      invoiceId: params.invoiceId,
      journalEntryId: params.journalEntryId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  // The invoice is settled, so every transaction still carrying a suggestion
  // pointer at it is dead: retire them (issue #1259). No exceptTransactionId:
  // the reconciled row (if any) has already had its own hint cleared by the
  // auto-reconcile tag update, so nothing here needs preserving.
  if (rpc.invoice_status === 'paid') {
    await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', params.invoiceId)
  }

  return {
    ok: true,
    result: {
      paymentId: rpc.payment_id,
      invoiceStatus: rpc.invoice_status,
      paidAmount: rpc.paid_amount,
      remainingAmount: rpc.remaining_amount,
      paymentAmount: rpc.payment_amount,
      journalEntryId: params.journalEntryId,
      reconciledTransactionId,
      saleJournalEntryId: sale.journalEntryId,
      voucherRemaining: rpc.voucher_remaining ?? null,
    },
  }
}

/**
 * The sale-first step of a voucher link. Plans by invoice id (the company
 * setting first, so a company that books at issue pays one read); when the
 * invoice must be booked first, validates the link (the RPC re-checks it) and
 * runs the Bokför step. A no-op otherwise.
 */
async function bookSaleBeforeVoucherLink(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: LinkInvoiceToVoucherParams,
): Promise<{ ok: true; journalEntryId: string | null } | { ok: false; code: string; details?: Record<string, unknown> }> {
  const opCtx = { supabase, companyId, userId, log }
  const plan = await planSaleBeforeSettlementById(opCtx, params.invoiceId)
  if (!plan.ok) return { ok: false, code: saleFirstRefusalCode(plan), details: plan.details }
  if (!plan.required) return { ok: true, journalEntryId: null }

  const { data: row, error } = await supabase
    .from('invoices')
    .select(
      'id, invoice_number, status, document_type, credited_invoice_id, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, journal_entry_id, customer_id, customer:customers(id, name)',
    )
    .eq('id', params.invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { ok: false, code: 'LINK_VOUCHER_DB_ERROR', details: { reason: error.message } }
  // A missing invoice is the RPC's own refusal (LINK_VOUCHER_INVOICE_NOT_FOUND).
  if (!row) return { ok: true, journalEntryId: null }

  const invoice = row as unknown as Invoice & { customer?: Customer }
  const validation = await validateVoucherForInvoiceLink(supabase, companyId, invoice, params.journalEntryId, params.amount)
  if (!validation.ok) return { ok: false, code: validation.code, details: validation.details }

  const booked = await bookSaleBeforeSettlement(opCtx, plan)
  if (!booked.ok) return { ok: false, code: saleFirstRefusalCode(booked), details: booked.details }
  return { ok: true, journalEntryId: booked.bookedHere ? booked.journalEntryId : null }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * The payment event of a voucher link, for the kursdifferens verifikat the
 * RPC posts when a foreign-currency invoice is settled by a plain-kronor
 * verifikat at another rate. None for an invoice in the ledger currency
 * (the RPC posts nothing of its own), for a link that states its share (the
 * RPC settles a share without that fallback, so it posts nothing of its own)
 * or when the invoice or verifikat is not there (the RPC refuses as before).
 * A read error throws: the port logs it under shadow and stops the link
 * under strict.
 */
async function customerVoucherLinkEvents(
  supabase: SupabaseClient,
  companyId: string,
  params: LinkInvoiceToVoucherParams,
): Promise<BusinessEventDraft[]> {
  if (params.amount != null) return []
  const { data: invoiceRow, error: invoiceError } = await supabase
    .from('invoices')
    .select('id, customer_id, currency, total, paid_amount, remaining_amount')
    .eq('id', params.invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (invoiceError) throw invoiceError
  const invoice = invoiceRow as Pick<Invoice, 'id' | 'customer_id' | 'currency' | 'total' | 'paid_amount' | 'remaining_amount'> | null
  if (!invoice || isLedgerCurrency(invoice.currency)) return []
  const { data: voucher, error: voucherError } = await supabase
    .from('journal_entries')
    .select('entry_date')
    .eq('id', params.journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (voucherError) throw voucherError
  if (!voucher) return []
  return [
    voucherLinkKursdifferensBusinessEvent(
      {
        side: 'customer',
        invoiceId: invoice.id,
        partyId: invoice.customer_id,
        currency: invoice.currency,
        remaining: computeRemaining(invoice as Invoice),
        voucherDate: (voucher as { entry_date: string }).entry_date,
      },
      linkBasisColumns('user_confirmed'),
    ),
  ]
}

function computeRemaining(invoice: Invoice): number {
  if (typeof invoice.remaining_amount === 'number' && invoice.remaining_amount > 0) {
    return invoice.remaining_amount
  }
  const paid = invoice.paid_amount ?? 0
  return Math.max(0, roundOre(invoice.total - paid))
}

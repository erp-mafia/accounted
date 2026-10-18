/**
 * Link an existing posted verifikat to a supplier invoice as its payment row.
 *
 * Used when the GL already contains the verifikat that paid the invoice: an
 * SIE-imported payment voucher, a manually entered bank-transfer voucher, a
 * bank row booked before the invoice was registered. No new journal entry is
 * created. Only a supplier_invoice_payments row is inserted pointing at the
 * existing journal_entry_id, plus the invoice's paid_amount / remaining_amount
 * / status are advanced.
 *
 * WHICH line of the voucher settles the invoice is not decided here: see
 * supplier-settlement-side.ts. It is the 244x debit (`ap_debit`), or, for a
 * kontantmetod company's invoice with no registration verifikat, the 19xx
 * credit (`bank_credit`): there Dr cost, Dr 2641 / Cr 1930 IS the payment of
 * the invoice, and refusing it left mark-paid, which books the cost and the
 * moms a second time, as the only way to close the invoice (issue #2854).
 *
 * A voucher without the settlement side is rejected with
 * LINK_SI_VOUCHER_NO_AP_DEBIT / LINK_SI_VOUCHER_NO_BANK_CREDIT.
 *
 * ONE VERIFIKAT MAY PAY SEVERAL DEBTS (GitHub issue 3490). A bank payment that
 * covers several leverantörsskulder is one verifikat, and some of those debts
 * may have no invoice here at all (a company that came in by SIE carries them
 * as part of the 2440 opening balance). What a voucher can settle is therefore
 * its settlement side less the payment rows that already point at it for other
 * invoices, on both sides, and a link may state `amount`: this invoice's share
 * of it, in the invoice's currency. The share is bounded by the invoice's
 * remainder and by what the voucher has left; the rest stays available.
 * Without a stated share nothing is split on a guess: what the voucher has
 * left must fit inside the invoice's remainder
 * (LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING otherwise).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitSupplierInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { createLogger } from '@/lib/logger'
import { autoReconcileTransactionForLinkedVoucher } from '@/lib/reconciliation/bank-reconciliation'
import { clearSettledInvoiceSuggestions } from './clear-settled-invoice-suggestions'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { documentCurrency, ledgerLineSideAmountIn } from '@/lib/bookkeeping/ledger-line-amount'
import type { SqlBusinessEventLink } from '@/lib/bookkeeping/business-event-link'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { voucherLinkKursdifferensBusinessEvent } from '@/lib/bookkeeping/sql-posting-business-events'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { SupplierInvoice, Supplier } from '@/types'
import {
  resolveSupplierSettlementSide,
  type SupplierSettlementSide,
  type SupplierSettlementSideName,
} from './supplier-settlement-side'
import {
  AMOUNT_TOLERANCE,
  DEFAULT_DATE_WINDOW_DAYS,
  EXCLUDED_SOURCE_TYPES,
  collectSettlementVouchers,
  lockedPeriodIds,
  rankVoucherCandidates,
  round2,
  scoreVoucherCandidate,
  sekBookedReason,
  sekBookedSettlement,
  type SettlementSideLine,
  type VoucherRow,
  type VoucherScoreContext,
} from './voucher-matching-shared'

const log = createLogger('supplier-voucher-matching')

/** Ids per `.in()` when reading the payment rows of candidate vouchers. */
const PAYMENT_ROW_CHUNK = 100

/** Payment rows that already point at a voucher for ANOTHER invoice have used
 *  part of its settlement side, the 244x debit as much as the 19xx credit.
 *  Mirrors the capacity block of link_supplier_invoice_to_voucher
 *  (20261011153000; 19xx only before that). */
interface VoucherPaymentRow {
  journal_entry_id: string | null
  supplier_invoice_id: string
  amount: number | string | null
  currency: string | null
}

export interface SupplierVoucherCandidate {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  /** What this voucher can settle, always positive: the 244x debit
   *  (`ap_debit`) or the 19xx credit (`bank_credit`), less what payment rows
   *  for other invoices have already used of it. Expressed in `currency` below
   *  (the INVOICE's currency), never in the raw SEK ledger column: see
   *  ledgerLineSideAmountIn. Kept under this name for API/UI back-compat
   *  across both sides, as `ar_credit_amount` is on the customer side. */
  ap_debit_amount: number
  /** Which side of the voucher `ap_debit_amount` was read from. */
  settlement_side: SupplierSettlementSideName
  /** The unit `ap_debit_amount` is quoted in: always the invoice's currency. */
  currency: string
  /** Currency of the settlement line; nullable when the line stores SEK only. */
  ap_line_currency: string | null
  /** True when the voucher's fiscal period is closed (`is_closed`) or locked
   *  (`locked_at`), and also when that state could not be read: the flag never
   *  reports "open" on a failed lookup. */
  period_locked: boolean
  /** Confidence score 0..1 (or 0.99 for OCR match). */
  confidence: number
  /** Localized reason in Swedish. */
  match_reason: string
  /** Set when the voucher has MORE left than the invoice needs: the share to
   *  state as `amount` on the link (the invoice's remainder). Such a voucher
   *  is refused without a stated share, since it pays other debts too. */
  link_amount?: number
}

/**
 * Find posted journal entries that carry the invoice's settlement side (244x
 * debit, or 19xx credit: see the module header) and could plausibly be the
 * payment for this supplier invoice. Ranking mirrors the customer side: exact
 * amount + supplier match wins, then exact, then fuzzy (±1% capped at 500 SEK),
 * with a small bump for date proximity to due_date.
 *
 * `options.settlementSide` lets a caller that already resolved the side (to
 * show it) pass it in instead of paying for a second lookup.
 *
 * `options.includeShared` also offers vouchers that have MORE left than the
 * invoice needs and that nothing else ties to it: a payment of several debts,
 * linkable with a stated share (`link_amount`). Only the surfaces where a
 * person picks set it; the unattended reconcile pass keeps the amount matches.
 */
export async function findMatchingVouchersForSupplierInvoice(
  supabase: SupabaseClient,
  companyId: string,
  invoice: SupplierInvoice & { supplier?: Supplier },
  options: {
    limit?: number
    dateWindowDays?: number
    settlementSide?: SupplierSettlementSide
    includeShared?: boolean
  } = {},
): Promise<SupplierVoucherCandidate[]> {
  const limit = options.limit ?? 10
  const windowDays = options.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS

  const remainingAmount = computeRemaining(invoice)
  if (remainingAmount <= AMOUNT_TOLERANCE) return []

  const settlement =
    options.settlementSide ??
    (await resolveSupplierSettlementSide(supabase, companyId, invoice.id))
  const invoiceCurrency = documentCurrency(invoice.currency)
  const logContext = { companyId, supplierInvoiceId: invoice.id }

  // The shared voucher-link matcher (voucher-matching-shared.ts), the same
  // search the customer side runs. A foreign invoice on the 244x side reads
  // every AP debit in the window, whatever its label: a payment voucher that
  // carries its 2440 debit in SEK only (an SIE import, a manual verifikat)
  // settles the invoice through the SEK-booked fallback, which the link
  // validator accepts too (feedback seq 930807).
  const byEntry = await collectSettlementVouchers({
    supabase,
    companyId,
    invoice,
    remainingAmount,
    side: {
      accountPrefix: settlement.accountPrefix,
      entrySide: settlement.entrySide,
      bankSide: settlement.side === 'bank_credit',
    },
    windowDays,
    sekBookedAllowed: true,
    log,
    logContext,
  })
  if (byEntry.size === 0) return []

  // Every payment row on a voucher counts, whichever invoice it belongs to,
  // and the candidate is scored on what the voucher has LEFT, as the RPC
  // settles it. On the 19xx side that is what keeps last month's payment of a
  // recurring invoice off this month's (a 19xx credit says "money left the
  // bank", not "this supplier was paid"); on the 244x side it is what lets one
  // verifikat pay several invoices without paying any of them twice. A voucher
  // already linked to this invoice, or with nothing left, is not a candidate.
  const rows = await fetchVoucherPaymentRows(supabase, companyId, Array.from(byEntry.keys()))
  for (const [entryId, voucher] of byEntry) {
    const voucherRows = rows.filter((r) => r.journal_entry_id === entryId)
    // The SEK-booked fallback reads the kronor voucher as the payment of this
    // invoice's whole remainder: it cannot also carry another invoice's row.
    const capacity =
      voucher.sekBooked && voucherRows.some((r) => r.supplier_invoice_id !== invoice.id)
        ? null
        : voucherCapacity(voucher.amount, voucherRows, invoice.id, invoiceCurrency)
    if (capacity === null) byEntry.delete(entryId)
    else voucher.amount = capacity
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
    // The ankomstnummer is Accounted's own sequence (1, 2, 3, ...): no bank or
    // source system writes it on a payment, so it counts only when the amount
    // corroborates it. All 31 arrival-number auto-links in prod on 2026-09-16
    // were of the kind "14" inside "(1814)" with an unrelated amount (desk crm#64).
    references: [
      { label: 'Fakturanummer', value: invoice.supplier_invoice_number, countsWithoutAmount: true },
      { label: 'Ankomstnummer', value: invoice.arrival_number, countsWithoutAmount: false },
    ],
    counterparty: { name: invoice.supplier?.name, label: 'leverantörsnamn' },
    includeShared: options.includeShared === true,
  }
  const candidates: SupplierVoucherCandidate[] = []
  for (const { entry, amount, lineCurrency, sekBooked } of byEntry.values()) {
    // A share is not on offer through the SEK-booked fallback: the validator
    // and the RPC refuse one there (the kursdifferens would be a guess).
    const scored = scoreVoucherCandidate(entry, amount, lineCurrency, scoreContext, !sekBooked)
    if (!scored) continue
    const hasMoreThanNeeded = !sekBooked && amount > remainingAmount + AMOUNT_TOLERANCE
    candidates.push({
      journal_entry_id: entry.id,
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      description: entry.description,
      ap_debit_amount: round2(amount),
      settlement_side: settlement.side,
      currency: invoice.currency,
      ap_line_currency: lineCurrency,
      period_locked: lockedPeriods.has(entry.fiscal_period_id),
      confidence: scored.confidence,
      match_reason: sekBooked ? sekBookedReason(scored.match_reason, sekBooked.sekTotal) : scored.match_reason,
      ...(hasMoreThanNeeded ? { link_amount: round2(remainingAmount) } : {}),
    })
  }
  return rankVoucherCandidates(candidates, limit)
}

export type SupplierVoucherLinkErrorCode =
  | 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND'
  | 'LINK_SI_VOUCHER_VOUCHER_NOT_FOUND'
  | 'LINK_SI_VOUCHER_NOT_POSTED'
  | 'LINK_SI_VOUCHER_NO_AP_DEBIT'
  | 'LINK_SI_VOUCHER_NO_BANK_CREDIT'
  | 'LINK_SI_VOUCHER_FULLY_ALLOCATED'
  | 'LINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED'
  | 'LINK_SI_VOUCHER_ALREADY_LINKED'
  | 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING'
  | 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER'
  | 'LINK_SI_VOUCHER_AMOUNT_INVALID'
  | 'LINK_SI_VOUCHER_CURRENCY_MISMATCH'
  | 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID'
  | 'LINK_SI_VOUCHER_DB_ERROR'

export type ValidateSupplierVoucherResult =
  | {
      ok: true
      /** What the voucher settles, on either side: see
       *  SupplierVoucherCandidate.ap_debit_amount. */
      apDebitAmount: number
      settlementSide: SupplierSettlementSideName
      apLineCurrency: string | null
      voucher: VoucherRow
      remainingAfter: number
      isFullyPaid: boolean
      paymentAmount: number
      /** What the voucher has left after this link, in the invoice's
       *  currency: for other invoices, or for a debt with no invoice here. */
      voucherRemainingAfter: number
    }
  | {
      ok: false
      code: SupplierVoucherLinkErrorCode
      details?: Record<string, unknown>
    }

/**
 * Validate that a journal entry can be linked as payment for a supplier
 * invoice, with the RPC's guards in the RPC's order, so a staged link (MCP) is
 * judged before approval the way the commit will judge it. The RPC stays the
 * authority: one guard is NOT mirrored here, the posted kontantmetod cut-off
 * (LINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED), which surfaces at commit.
 *
 * `amount` is the stated share of the voucher that is this invoice's, in the
 * invoice's currency (see the module header); omitted, what the voucher has
 * left must fit inside the invoice's remainder.
 */
export async function validateVoucherForSupplierInvoiceLink(
  supabase: SupabaseClient,
  companyId: string,
  invoice: SupplierInvoice & { supplier?: Supplier },
  journalEntryId: string,
  amount?: number | null,
): Promise<ValidateSupplierVoucherResult> {
  // A stated share is a positive amount to the öre, judged first as in the RPC.
  const statedAmount = amount == null ? null : round2(amount)
  if (statedAmount !== null && !(Number.isFinite(statedAmount) && statedAmount > 0)) {
    return { ok: false, code: 'LINK_SI_VOUCHER_AMOUNT_INVALID', details: { amount } }
  }

  const remainingAmount = computeRemaining(invoice)
  if (remainingAmount <= AMOUNT_TOLERANCE) {
    return { ok: false, code: 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID' }
  }

  const { data: voucher, error: voucherError } = await supabase
    .from('journal_entries')
    .select(
      'id, voucher_series, voucher_number, entry_date, description, status, source_type, fiscal_period_id, company_id',
    )
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (voucherError || !voucher) {
    return { ok: false, code: 'LINK_SI_VOUCHER_VOUCHER_NOT_FOUND' }
  }

  const v = voucher as VoucherRow & { company_id: string }
  if (v.status !== 'posted') {
    return { ok: false, code: 'LINK_SI_VOUCHER_NOT_POSTED', details: { status: v.status } }
  }

  const settlement = await resolveSupplierSettlementSide(supabase, companyId, invoice.id)
  const onBankCredit = settlement.side === 'bank_credit'
  const noSideCode: SupplierVoucherLinkErrorCode = onBankCredit
    ? 'LINK_SI_VOUCHER_NO_BANK_CREDIT'
    : 'LINK_SI_VOUCHER_NO_AP_DEBIT'

  if (EXCLUDED_SOURCE_TYPES.includes(v.source_type ?? '')) {
    return {
      ok: false,
      code: noSideCode,
      details: { source_type: v.source_type },
    }
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
    return { ok: false, code: noSideCode }
  }

  // Nullable column, non-null type: see documentCurrency(). The label guard
  // below still compares the RAW invoice.currency, so a NULL row is rejected
  // exactly as before rather than newly failing as "unconvertible".
  const invoiceCurrency = documentCurrency(invoice.currency)
  let apDebitTotal = 0
  let lineCurrency: string | null = null
  // A settlement-side line that carries no amount in the invoice's currency.
  // Fail CLOSED on it, UNLESS the whole matched side is genuinely SEK-booked:
  // then the fallback below mirrors the RPC's SEK-booked settlement gate
  // (migration 20260830140000), through the predicate the candidate finder
  // shares (sekBookedSettlement).
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
    if (!line.account_number?.startsWith(settlement.accountPrefix)) continue
    const rawDebit =
      Number(settlement.entrySide === 'credit' ? line.credit_amount : line.debit_amount) || 0
    sideLines.push({ currency: line.currency, amount_in_currency: line.amount_in_currency, sideSek: rawDebit })
    const debit = ledgerLineSideAmountIn(line, invoiceCurrency, settlement.entrySide)
    if (debit === null) {
      if (rawDebit > 0 && unconvertibleLineCurrency === undefined) {
        unconvertibleLineCurrency = line.currency
      }
      continue
    }
    if (debit <= 0) continue
    apDebitTotal += debit
    if (!lineCurrency) lineCurrency = line.currency
  }
  apDebitTotal = round2(apDebitTotal)

  if (unconvertibleLineCurrency !== undefined && statedAmount !== null) {
    // A stated share needs the voucher's side in the invoice's currency. The
    // fallback below reads a kronor voucher as the payment of the invoice's
    // WHOLE remainder and the RPC books the kursdifferens from that; the
    // kronor behind a part of it are not in the books, so a share would book
    // a kursdifferens on a guess. Answered before the fallback, as in the RPC.
    return {
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: {
        invoice_currency: invoice.currency,
        line_currency: unconvertibleLineCurrency,
        reason: 'amount_needs_invoice_currency',
      },
    }
  }
  if (unconvertibleLineCurrency !== undefined) {
    // SEK-booked settlement fallback, mirroring the RPC gate byte-for-byte
    // (sekBookedSettlement). The RPC settles the FULL remaining; on ap_debit
    // it also books the FX residual to 3960/7960 as its own verifikat, on
    // bank_credit it books nothing (no skuld was carried at the invoice
    // rate). The validation outcome only has to agree.
    const fallback = sekBookedSettlement(sideLines, invoiceCurrency, invoice.exchange_rate, remainingAmount)
    if (!fallback.eligible) {
      return {
        ok: false,
        code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
        details:
          fallback.reason === 'fx_deviation_too_large'
            ? {
                invoice_currency: invoice.currency,
                line_currency: unconvertibleLineCurrency,
                reason: 'fx_deviation_too_large',
                expected_sek: fallback.bookedSek,
                voucher_sek: fallback.sekTotal,
              }
            : {
                invoice_currency: invoice.currency,
                line_currency: unconvertibleLineCurrency,
              },
      }
    }
    // Full-remaining settlement, exactly as the RPC computes it. lineCurrency
    // is null here (no readable line), so the label guard below passes and the
    // exceeds-remaining guard sees an equal amount.
    apDebitTotal = round2(remainingAmount)
  }
  const sekFallback = unconvertibleLineCurrency !== undefined

  if (apDebitTotal <= 0) {
    return { ok: false, code: noSideCode }
  }

  // Label guard, unchanged: a counterparty discriminator, not a unit check
  // (see scoreCandidate). Always passes on a foreign invoice, because only
  // same-labelled lines could be converted at all.
  const lineCurrencyEffective = lineCurrency ?? invoice.currency
  if (lineCurrencyEffective !== invoice.currency) {
    return {
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: {
        invoice_currency: invoice.currency,
        line_currency: lineCurrencyEffective,
      },
    }
  }

  // Capacity of the settlement side, on both sides as in the RPC: rows for
  // OTHER invoices have used part of it; this invoice's own row is the
  // already-linked guard's.
  const sideKey = onBankCredit ? 'bank_credit' : 'ap_debit'
  const rows = (await fetchVoucherPaymentRows(supabase, companyId, [journalEntryId])).filter(
    (r) => r.supplier_invoice_id !== invoice.id,
  )
  if (sekFallback && rows.length > 0) {
    return {
      ok: false,
      code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
      details: { linked_rows: rows.length },
    }
  }
  if (rows.some((r) => (r.currency ?? 'SEK') !== invoiceCurrency)) {
    return {
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: {
        invoice_currency: invoice.currency,
        reason: 'voucher_settles_other_currency',
      },
    }
  }
  const used = round2(rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0))
  const sideTotal = apDebitTotal
  if (apDebitTotal - used <= AMOUNT_TOLERANCE) {
    return {
      ok: false,
      code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
      details: { [sideKey]: sideTotal, already_linked: used },
    }
  }
  // From here on apDebitTotal is what the voucher has LEFT.
  apDebitTotal = round2(apDebitTotal - used)

  if (statedAmount === null) {
    // No stated share: nothing is split on a guess. What the voucher has left
    // must fit inside the invoice's remainder.
    if (apDebitTotal > remainingAmount + AMOUNT_TOLERANCE) {
      return {
        ok: false,
        code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        details: { [sideKey]: apDebitTotal, remaining: round2(remainingAmount) },
      }
    }
  } else {
    // A stated share: bounded by the invoice's remainder and by what the
    // voucher has left. The rest of the voucher stays available.
    if (statedAmount > remainingAmount + AMOUNT_TOLERANCE) {
      return {
        ok: false,
        code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        details: { amount: statedAmount, remaining: round2(remainingAmount) },
      }
    }
    if (statedAmount > apDebitTotal + AMOUNT_TOLERANCE) {
      return {
        ok: false,
        code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
        details: {
          amount: statedAmount,
          available: apDebitTotal,
          [sideKey]: sideTotal,
          already_linked: used,
        },
      }
    }
  }

  const { data: existingLinks } = await supabase
    .from('supplier_invoice_payments')
    .select('id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', invoice.id)
    .eq('journal_entry_id', journalEntryId)
    .limit(1)
  if (existingLinks && existingLinks.length > 0) {
    return { ok: false, code: 'LINK_SI_VOUCHER_ALREADY_LINKED' }
  }

  const paymentAmount = Math.min(statedAmount ?? apDebitTotal, apDebitTotal, round2(remainingAmount))
  const remainingAfter = Math.max(0, round2(remainingAmount - paymentAmount))
  const isFullyPaid = remainingAfter <= AMOUNT_TOLERANCE

  return {
    ok: true,
    apDebitAmount: apDebitTotal,
    settlementSide: settlement.side,
    apLineCurrency: lineCurrency,
    voucher: v,
    remainingAfter,
    isFullyPaid,
    paymentAmount,
    voucherRemainingAfter: round2(apDebitTotal - paymentAmount),
  }
}

export interface LinkSupplierInvoiceToVoucherParams {
  supplierInvoiceId: string
  journalEntryId: string
  notes?: string
  /** The share of the voucher that is this invoice's, in the invoice's
   *  currency. Omitted: what the voucher has left must fit inside the
   *  invoice's remainder (see the module header). */
  amount?: number
}

export interface LinkSupplierInvoiceToVoucherResult {
  paymentId: string
  invoiceStatus: 'paid' | 'partially_paid'
  paidAmount: number
  remainingAmount: number
  paymentAmount: number
  journalEntryId: string
  /** What the voucher has left after this link, in the invoice's currency;
   *  null from a database that predates migration 20261011153000. */
  voucherRemaining: number | null
  /** Bank transaction auto-reconciled to the linked voucher, if exactly one
   *  unbooked line matched it; null when nothing was safely linkable. */
  reconciledTransactionId: string | null
}

/**
 * Atomically link an existing posted verifikat as payment for a supplier
 * invoice. Inserts a supplier_invoice_payments row pointing at the JE, advances
 * the invoice's paid_amount / remaining_amount, and emits supplier_invoice.paid
 * when the link settles the invoice in full.
 *
 * Re-validates inside the same call to defend against stage→commit drift.
 */
interface RpcLinkOk {
  ok: true
  payment_id: string
  invoice_status: 'paid' | 'partially_paid'
  paid_amount: number
  remaining_amount: number
  payment_amount: number
  journal_entry_id: string
  currency: string
  voucher_remaining?: number | null
}

interface RpcLinkErr {
  ok: false
  code: SupplierVoucherLinkErrorCode
  details?: Record<string, unknown>
}

export async function linkSupplierInvoiceToVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: LinkSupplierInvoiceToVoucherParams,
): Promise<
  | { ok: true; result: LinkSupplierInvoiceToVoucherResult }
  | { ok: false; code: SupplierVoucherLinkErrorCode; details?: Record<string, unknown> }
> {
  // All validation + writes happen inside link_supplier_invoice_to_voucher
  // (PL/pgSQL). The function locks the invoice row, validates the voucher,
  // and applies UPDATE + INSERT in a single PG transaction so a failure on
  // either rolls back automatically. The previous TS implementation did
  // UPDATE-then-INSERT with a manual rollback that could overwrite a
  // concurrent sibling's successful write: PR #602 review fix.
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
      events: () => supplierVoucherLinkEvents(supabase, companyId, params),
    })
  } catch (err) {
    // strict: an event that could not be recorded stops the link before any number.
    log.error('link_supplier_invoice_to_voucher business event not recorded (strict)', err, {
      companyId,
      supplierInvoiceId: params.supplierInvoiceId,
    })
    return { ok: false, code: 'LINK_SI_VOUCHER_DB_ERROR', details: { reason: err instanceof Error ? err.message : String(err) } }
  }

  // Through the engine door (commitSupplierInvoiceVoucherLink, reached
  // through the posting port), which announces the kursdifferens verifikat the
  // RPC posts for a foreign-currency invoice with journal_entry.committed.
  const { data, error } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'link_supplier_invoice_to_voucher',
    args: [
      {
        supplierInvoiceId: params.supplierInvoiceId,
        journalEntryId: params.journalEntryId,
        notes: params.notes ?? null,
        amount: params.amount ?? null,
        ...(businessEvents ? { businessEvents } : {}),
      },
    ],
  })

  if (error) {
    log.error('link_supplier_invoice_to_voucher RPC error', {
      companyId,
      userId,
      supplierInvoiceId: params.supplierInvoiceId,
      journalEntryId: params.journalEntryId,
      message: error.message,
    })
    return {
      ok: false,
      code: 'LINK_SI_VOUCHER_DB_ERROR',
      details: { reason: error.message },
    }
  }

  const result = data as RpcLinkOk | RpcLinkErr | null
  if (!result) {
    return { ok: false, code: 'LINK_SI_VOUCHER_DB_ERROR', details: { reason: 'empty RPC response' } }
  }
  if (!result.ok) {
    return { ok: false, code: result.code, details: result.details }
  }

  // Fetch the now-updated invoice for event emission. Lightweight; the RPC
  // committed before this read so the row reflects post-link state.
  // select('*') is intentional: the supplier_invoice.paid event payload is
  // typed as `supplierInvoice: SupplierInvoice` in lib/events/types.ts, so
  // narrowing here would either break the subscriber contract or require a
  // separate event payload type. The event stays in-process (eventBus is a
  // module-level singleton) and any consumer subscribing to this event
  // legitimately needs the full invoice context for downstream reminders
  // and audit-log routing. PR #602 compliance review note documented.
  const { data: invoice } = await supabase
    .from('supplier_invoices')
    .select('*')
    .eq('id', params.supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  // supplier_invoice.paid only when this link settled the invoice in full: a
  // partial link leaves money owed. The RPC locks the row and refuses an
  // invoice that is not open, so its 'paid' is this call's transition.
  // Best-effort: an emit failure is logged by the helper (ISO 27001:2022
  // A.8.15 / OWASP V16) and never blocks the committed link.
  if (invoice) {
    await emitSupplierInvoicePaidIfSettled({
      newStatus: result.invoice_status,
      supplierInvoice: invoice as SupplierInvoice,
      paymentAmount: result.payment_amount,
      userId,
      companyId,
    })
  }

  // Anchor the invoice's retained document to its verifikat when it is still
  // floating (kontantmetoden with no registration verifikat), exactly as the
  // mark-paid and match routes do. Otherwise it waited for the daily sweep.
  // Idempotent and never throws: the link has already committed.
  await anchorSupplierInvoiceDocument(supabase, companyId, params.supplierInvoiceId)

  // Close the loop on the bank feed: the link above only advanced the supplier
  // invoice, leaving the bank transaction that paid it in the Transactions
  // inbox. Reconcile it to the same verifikat when unambiguous. Best-effort:
  // the link RPC has already committed.
  let reconciledTransactionId: string | null = null
  try {
    const recon = await autoReconcileTransactionForLinkedVoucher(
      supabase,
      companyId,
      userId,
      params.journalEntryId,
      { supplierInvoiceId: params.supplierInvoiceId },
    )
    reconciledTransactionId = recon?.linkedTransactionId ?? null
  } catch (err) {
    log.warn('auto-reconcile of bank transaction after supplier voucher link failed (non-blocking)', {
      companyId,
      supplierInvoiceId: params.supplierInvoiceId,
      journalEntryId: params.journalEntryId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  // The invoice is settled, so every transaction still carrying a suggestion
  // pointer at it is dead: retire them (issue #1259). No exceptTransactionId:
  // the reconciled row (if any) has already had its own hint cleared by the
  // auto-reconcile tag update, so nothing here needs preserving.
  if (result.invoice_status === 'paid') {
    await clearSettledInvoiceSuggestions(
      supabase,
      companyId,
      'supplier_invoice',
      params.supplierInvoiceId,
    )
  }

  return {
    ok: true,
    result: {
      paymentId: result.payment_id,
      invoiceStatus: result.invoice_status,
      paidAmount: result.paid_amount,
      remainingAmount: result.remaining_amount,
      paymentAmount: result.payment_amount,
      journalEntryId: result.journal_entry_id,
      voucherRemaining: result.voucher_remaining ?? null,
      reconciledTransactionId,
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** Every payment row pointing at the given vouchers, whichever invoice it
 *  belongs to. Chunked: a candidate list can outgrow one request URL. */
async function fetchVoucherPaymentRows(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: string[],
): Promise<VoucherPaymentRow[]> {
  const rows: VoucherPaymentRow[] = []
  for (let i = 0; i < journalEntryIds.length; i += PAYMENT_ROW_CHUNK) {
    const { data } = await supabase
      .from('supplier_invoice_payments')
      .select('journal_entry_id, supplier_invoice_id, amount, currency')
      .eq('company_id', companyId)
      .in('journal_entry_id', journalEntryIds.slice(i, i + PAYMENT_ROW_CHUNK))
    rows.push(...((data ?? []) as VoucherPaymentRow[]))
  }
  return rows
}

/**
 * What a voucher's settlement side (244x debit or 19xx credit) can still
 * settle for `invoiceId`, or null when it is not a candidate at all: already
 * linked to this invoice, carrying rows in another currency (the used part is
 * unreadable), or nothing left.
 */
function voucherCapacity(
  sideTotal: number,
  voucherRows: VoucherPaymentRow[],
  invoiceId: string,
  invoiceCurrency: string,
): number | null {
  if (voucherRows.some((r) => r.supplier_invoice_id === invoiceId)) return null
  if (voucherRows.some((r) => (r.currency ?? 'SEK') !== invoiceCurrency)) return null
  const used = round2(voucherRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0))
  const left = round2(sideTotal - used)
  return left > AMOUNT_TOLERANCE ? left : null
}

/**
 * The payment event of a voucher link, for the kursdifferens verifikat the
 * RPC posts when a foreign-currency invoice is paid by a plain-kronor
 * verifikat at another rate. None for an invoice in the ledger currency, for
 * a link that states its share (the RPC settles a share without that
 * fallback, so it posts nothing of its own) or when the invoice or verifikat
 * is not there (the RPC refuses as before). A read error throws: the port
 * logs it under shadow and stops the link under strict.
 */
async function supplierVoucherLinkEvents(
  supabase: SupabaseClient,
  companyId: string,
  params: LinkSupplierInvoiceToVoucherParams,
): Promise<BusinessEventDraft[]> {
  if (params.amount != null) return []
  const { data: invoiceRow, error: invoiceError } = await supabase
    .from('supplier_invoices')
    .select('id, supplier_id, currency, total, paid_amount, remaining_amount')
    .eq('id', params.supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (invoiceError) throw invoiceError
  const invoice = invoiceRow as Pick<SupplierInvoice, 'id' | 'supplier_id' | 'currency' | 'total' | 'paid_amount' | 'remaining_amount'> | null
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
        side: 'supplier',
        invoiceId: invoice.id,
        partyId: invoice.supplier_id,
        currency: invoice.currency,
        remaining: computeRemaining(invoice as SupplierInvoice),
        voucherDate: (voucher as { entry_date: string }).entry_date,
      },
      linkBasisColumns('user_confirmed'),
    ),
  ]
}

function computeRemaining(invoice: SupplierInvoice): number {
  // Trust the stored value whenever present, including the legitimate 0 for
  // a fully-paid invoice. Falling through to `total - paid_amount` for the
  // 0 case can leak rounding drift across multiple payments and return a
  // tiny positive number, slipping a fully-paid invoice past
  // LINK_SI_VOUCHER_INVOICE_FULLY_PAID. PR #602 review fix.
  if (typeof invoice.remaining_amount === 'number') {
    return Math.max(0, invoice.remaining_amount)
  }
  const paid = invoice.paid_amount ?? 0
  return Math.max(0, round2(invoice.total - paid))
}

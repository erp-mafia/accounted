/**
 * Link an existing posted verifikat to a supplier invoice as its payment row.
 *
 * Mirror of voucher-matching.ts but targets 2440 (Leverantörsskulder) debits
 * instead of 151x credits. Used when the GL already contains a verifikat that
 * pays down AP, e.g. an SIE-imported payment voucher, a manually entered
 * bank-transfer voucher, or any flow where the bookkeeping landed without
 * supplier-invoice linkage. No new journal entry is created. Only a
 * supplier_invoice_payments row is inserted pointing at the existing
 * journal_entry_id, plus the invoice's paid_amount / remaining_amount /
 * status are advanced.
 *
 * Vouchers that book the supplier expense directly without going through 2440
 * (e.g. Dr 4010 / Cr 1930 for a non-invoiced purchase) are rejected with
 * LINK_SI_VOUCHER_NO_AP_DEBIT. The proper fix for those is a storno+correction
 * via gnubok_correct_entry: out of scope for V1.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import {
  CONFIDENCE,
  amountsMatchExact,
  amountsMatchFuzzy,
  customerNameMatches,
} from './invoice-matching'
import { autoReconcileTransactionForLinkedVoucher } from '@/lib/reconciliation/bank-reconciliation'
import { clearSettledInvoiceSuggestions } from './clear-settled-invoice-suggestions'
import { documentCurrency, ledgerLineSideAmountIn } from '@/lib/bookkeeping/ledger-line-amount'
import type { SupplierInvoice, Supplier } from '@/types'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import {
  AMOUNT_TOLERANCE,
  DATE_PROXIMITY_BUMP,
  DEFAULT_DATE_WINDOW_DAYS,
  EXCLUDED_SOURCE_TYPES,
  isDateWithinDays,
  round2,
  type FiscalPeriodRow,
  type VoucherMatchLineRow as JournalEntryLine,
  type VoucherRow,
} from './voucher-matching-shared'
import { formatAmount as formatNumber } from '@/lib/utils'

const log = createLogger('supplier-voucher-matching')

/** AP account class. BAS 2026 reserves 2440-2449 for Leverantörsskulder
 *  (2440 SEK, 2441 utländsk valuta, 2443 Skuldfakturor, 2448 övriga). The
 *  supplier sub-ledger lives in the supplier_invoices table, not in per-
 *  supplier accounts. A samlingsverifikat that pays mixed SEK + EUR
 *  suppliers will legitimately debit both 2440 and 2441: summing across
 *  the 244x range catches that. PR #602 Swedish-compliance fix. */
const AP_ACCOUNT_PREFIX = '244'

export interface SupplierVoucherCandidate {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  /** Total debit on the AP account (2440) on this voucher, always positive.
   *  Expressed in `currency` below (the INVOICE's currency), never in the raw
   *  SEK ledger column: see ledgerLineSideAmountIn. */
  ap_debit_amount: number
  /** The unit `ap_debit_amount` is quoted in: always the invoice's currency. */
  currency: string
  /** Currency of the AP-debit line; nullable when the line stores SEK only. */
  ap_line_currency: string | null
  /** True when the voucher's fiscal period is closed (`is_closed`) or locked
   *  (`locked_at`), and also when that state could not be read: the flag never
   *  reports "open" on a failed lookup. */
  period_locked: boolean
  /** Confidence score 0..1 (or 0.99 for OCR match). */
  confidence: number
  /** Localized reason in Swedish. */
  match_reason: string
}

interface CandidateContext {
  invoice: SupplierInvoice & { supplier?: Supplier }
  remainingAmount: number
}

/**
 * Find posted journal entries whose lines debit 2440 and could plausibly be
 * the payment for this supplier invoice. Ranking mirrors the customer side:
 * exact amount + supplier match wins, then exact, then fuzzy (±1% capped at
 * 500 SEK), with a small bump for date proximity to due_date.
 */
export async function findMatchingVouchersForSupplierInvoice(
  supabase: SupabaseClient,
  companyId: string,
  invoice: SupplierInvoice & { supplier?: Supplier },
  options: { limit?: number; dateWindowDays?: number } = {},
): Promise<SupplierVoucherCandidate[]> {
  const limit = options.limit ?? 10
  const windowDays = options.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS

  const remainingAmount = computeRemaining(invoice)
  if (remainingAmount <= AMOUNT_TOLERANCE) return []

  const dueDate = new Date(invoice.due_date)
  const dateFrom = new Date(dueDate)
  dateFrom.setDate(dateFrom.getDate() - windowDays)
  const dateTo = new Date(dueDate)
  dateTo.setDate(dateTo.getDate() + windowDays)

  // Driven from the journal_entries side (lib/bookkeeping/entry-lines.ts):
  // the scope filters used to sit on a `journal_entries!inner` embed, which
  // PostgREST compiles into a correlated LATERAL join that walks the ENTIRE
  // journal_entry_lines table across all tenants. The old `.limit(limit * 10)`
  // went with the embed: the match set is one company's AP debits inside a
  // date window around the due date, and an arbitrary cap could drop the
  // exact-amount voucher the ranking below is looking for.
  // `amount_in_currency` is part of the column list on purpose: on a foreign
  // invoice it is the ONLY column quoted in the invoice's currency (debit_amount
  // is always SEK). Dropping it here would make every FX line unconvertible and
  // this matcher would silently return no candidates.
  // `documentCurrency()` and not `invoice.currency` directly: a NULL code would
  // test `!== 'SEK'` and send a plain domestic invoice down the FX path where
  // nothing is convertible. The label guard in scoreCandidate still compares
  // the RAW `invoice.currency`, so such a row behaves as it did before.
  const invoiceCurrency = documentCurrency(invoice.currency)
  const isForeignInvoice = invoiceCurrency !== 'SEK'
  let lines: Array<JournalEntryLine & { journal_entries: VoucherRow }>
  try {
    lines = await fetchEntryLines({
      supabase,
      entryColumns:
        'id, voucher_series, voucher_number, entry_date, description, status, source_type, fiscal_period_id, company_id',
      lineColumns:
        'id, journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .eq('status', 'posted')
          .gte('entry_date', dateFrom.toISOString().slice(0, 10))
          .lte('entry_date', dateTo.toISOString().slice(0, 10)),
      filterLines: (q: EntryLinesQuery) => {
        const scoped = q.like('account_number', `${AP_ACCOUNT_PREFIX}%`).gt('debit_amount', 0)
        // Only lines actually labelled with the invoice's currency can be
        // expressed in it at all; everything else is unscoreable, so this is a
        // strict superset of what survives scoring and keeps the FX candidate
        // set small. No-op on a SEK invoice.
        return isForeignInvoice ? scoped.eq('currency', invoiceCurrency) : scoped
      },
    })
  } catch {
    // Unchanged posture: a candidate-search failure returns no candidates
    // rather than breaking the reconciliation screen.
    return []
  }

  // Sum the AP debit per voucher across multiple 2440 lines (a samlings-
  // verifikation paying several supplier invoices in one shot will have one
  // 2440 row per supplier).
  const byEntry = new Map<
    string,
    { entry: VoucherRow; apDebitTotal: number; lineCurrency: string | null }
  >()

  for (const line of lines) {
    const entry = line.journal_entries
    if (!entry) continue
    if (EXCLUDED_SOURCE_TYPES.includes(entry.source_type ?? '')) continue

    // The AP debit quoted in the INVOICE's currency. On SEK this reads
    // debit_amount exactly as before; on a foreign invoice it reads
    // amount_in_currency and returns null for a line that carries no figure
    // in that currency.
    const debit = ledgerLineSideAmountIn(line, invoiceCurrency, 'debit')
    if (debit === null || debit <= 0) continue

    const existing = byEntry.get(entry.id)
    if (existing) {
      existing.apDebitTotal += debit
    } else {
      byEntry.set(entry.id, {
        entry,
        apDebitTotal: debit,
        lineCurrency: line.currency,
      })
    }
  }

  if (byEntry.size === 0) return []

  // Drop entries already fully linked to *this* supplier invoice.
  const candidateEntryIds = Array.from(byEntry.keys())
  const { data: existingLinks } = await supabase
    .from('supplier_invoice_payments')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', invoice.id)
    .in('journal_entry_id', candidateEntryIds)

  const alreadyLinked = new Set(
    (existingLinks ?? [])
      .map((row) => (row as { journal_entry_id: string | null }).journal_entry_id)
      .filter((id): id is string => !!id),
  )
  for (const id of alreadyLinked) byEntry.delete(id)
  if (byEntry.size === 0) return []

  // Period-lock flags (informational, linking is allowed in locked periods
  // because no JE is mutated).
  const periodIds = Array.from(
    new Set(Array.from(byEntry.values()).map((v) => v.entry.fiscal_period_id)),
  )
  const { data: periods, error: periodsError } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at')
    .in('id', periodIds)

  // Fail closed when the period state cannot be read: the flag is advisory
  // (linking mutates no journal entry), so over-flagging costs a badge, while
  // claiming "open" would tell the user a period is writable right before the
  // enforce_period_lock trigger refuses the write.
  const periodStateUnknown = !!periodsError || !periods
  if (periodStateUnknown) {
    log.warn('fiscal period lock state unavailable, flagging candidates as locked', {
      companyId,
      supplierInvoiceId: invoice.id,
      reason: periodsError?.message,
    })
  }
  const lockedPeriods = new Set(
    periodStateUnknown
      ? periodIds
      : (periods as FiscalPeriodRow[])
          .filter((p) => Boolean(p.is_closed) || Boolean(p.locked_at))
          .map((p) => p.id),
  )

  const ctx: CandidateContext = { invoice, remainingAmount }
  const candidates: SupplierVoucherCandidate[] = []
  for (const { entry, apDebitTotal, lineCurrency } of byEntry.values()) {
    const scored = scoreCandidate(entry, apDebitTotal, lineCurrency, ctx)
    if (!scored) continue
    candidates.push({
      journal_entry_id: entry.id,
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      description: entry.description,
      ap_debit_amount: round2(apDebitTotal),
      currency: invoice.currency,
      ap_line_currency: lineCurrency,
      period_locked: lockedPeriods.has(entry.fiscal_period_id),
      confidence: scored.confidence,
      match_reason: scored.match_reason,
    })
  }

  candidates.sort(
    (a, b) => b.confidence - a.confidence || a.entry_date.localeCompare(b.entry_date),
  )
  return candidates.slice(0, limit)
}

function scoreCandidate(
  entry: VoucherRow,
  apDebitTotal: number,
  lineCurrency: string | null,
  ctx: CandidateContext,
): { confidence: number; match_reason: string } | null {
  // OCR-style: invoice number or arrival number appears in the entry description.
  const invoiceNumberHit =
    ctx.invoice.supplier_invoice_number &&
    descriptionMentionsToken(entry.description, ctx.invoice.supplier_invoice_number)
  const arrivalHit =
    ctx.invoice.arrival_number != null &&
    descriptionMentionsToken(entry.description, String(ctx.invoice.arrival_number))
  if (invoiceNumberHit || arrivalHit) {
    return {
      confidence: CONFIDENCE.OCR_REFERENCE_MATCH,
      match_reason: invoiceNumberHit
        ? `Fakturanummer ${ctx.invoice.supplier_invoice_number} omnämnt i verifikatets beskrivning`
        : `Ankomstnummer ${ctx.invoice.arrival_number} omnämnt i verifikatets beskrivning`,
    }
  }

  // Label guard, unchanged in shape. It is no longer what makes the amounts
  // comparable (that used to be the bug: `lineCurrency ?? invoice.currency`
  // passes on exactly the FX rows it existed to catch, and the SEK
  // debit_amount was then compared against a foreign remainder).
  // `apDebitTotal` already arrives expressed in ctx.invoice.currency, and any
  // line that could not be expressed there was dropped before summing. What
  // survives here is the counterparty discriminator: a 244x debit stamped with
  // another document's currency belongs to another supplier invoice.
  const lineCurrencyEffective = lineCurrency ?? ctx.invoice.currency
  if (lineCurrencyEffective !== ctx.invoice.currency) {
    return null
  }

  const exactRemaining = amountsMatchExact(apDebitTotal, ctx.remainingAmount)
  const exactTotal =
    !exactRemaining && amountsMatchExact(apDebitTotal, ctx.invoice.total)
  const fuzzyRemaining =
    !exactRemaining &&
    !exactTotal &&
    amountsMatchFuzzy(apDebitTotal, ctx.remainingAmount)

  // Supplier name in description: reuse customer-side helper since the logic
  // (significant tokens of the counterparty name appearing in free text) is
  // identical regardless of AR vs AP.
  const supplierMatch = customerNameMatches(
    ctx.invoice.supplier?.name,
    entry.description,
    null,
  )

  let confidence = 0
  let reason = ''
  if (exactRemaining && supplierMatch) {
    confidence = CONFIDENCE.EXACT_AMOUNT_CUSTOMER
    reason = `Exakt belopp (${formatNumber(apDebitTotal)} ${ctx.invoice.currency}) och leverantörsnamn matchar`
  } else if (exactRemaining) {
    confidence = CONFIDENCE.EXACT_AMOUNT_ONLY
    reason = `Exakt belopp (${formatNumber(apDebitTotal)} ${ctx.invoice.currency})`
  } else if (exactTotal && supplierMatch) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_CUSTOMER
    reason = `Fakturans totalbelopp och leverantörsnamn matchar`
  } else if (exactTotal) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_ONLY + 0.05
    reason = `Fakturans totalbelopp matchar`
  } else if (fuzzyRemaining && supplierMatch) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_CUSTOMER
    reason = `Belopp nära (±1%) och leverantörsnamn matchar`
  } else if (fuzzyRemaining) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_ONLY
    reason = `Belopp nära (±1%)`
  } else {
    return null
  }

  if (isDateWithinDays(entry.entry_date, ctx.invoice.due_date, 7)) {
    confidence = Math.min(CONFIDENCE.OCR_REFERENCE_MATCH - 0.001, confidence + DATE_PROXIMITY_BUMP)
  }

  return { confidence, match_reason: reason }
}

export type SupplierVoucherLinkErrorCode =
  | 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND'
  | 'LINK_SI_VOUCHER_VOUCHER_NOT_FOUND'
  | 'LINK_SI_VOUCHER_NOT_POSTED'
  | 'LINK_SI_VOUCHER_NO_AP_DEBIT'
  | 'LINK_SI_VOUCHER_ALREADY_LINKED'
  | 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING'
  | 'LINK_SI_VOUCHER_CURRENCY_MISMATCH'
  | 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID'
  | 'LINK_SI_VOUCHER_DB_ERROR'

export type ValidateSupplierVoucherResult =
  | {
      ok: true
      apDebitAmount: number
      apLineCurrency: string | null
      voucher: VoucherRow
      remainingAfter: number
      isFullyPaid: boolean
      paymentAmount: number
    }
  | {
      ok: false
      code: SupplierVoucherLinkErrorCode
      details?: Record<string, unknown>
    }

/**
 * Validate that a journal entry can be linked as payment for a supplier
 * invoice. Used by both the staging path (MCP tool, future) and the commit
 * path (web route + MCP commit handler, future) so the guards stay identical.
 */
export async function validateVoucherForSupplierInvoiceLink(
  supabase: SupabaseClient,
  companyId: string,
  invoice: SupplierInvoice & { supplier?: Supplier },
  journalEntryId: string,
): Promise<ValidateSupplierVoucherResult> {
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
  if (EXCLUDED_SOURCE_TYPES.includes(v.source_type ?? '')) {
    return {
      ok: false,
      code: 'LINK_SI_VOUCHER_NO_AP_DEBIT',
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
    return { ok: false, code: 'LINK_SI_VOUCHER_NO_AP_DEBIT' }
  }

  // Nullable column, non-null type: see documentCurrency(). The label guard
  // below still compares the RAW invoice.currency, so a NULL row is rejected
  // exactly as before rather than newly failing as "unconvertible".
  const invoiceCurrency = documentCurrency(invoice.currency)
  let apDebitTotal = 0
  let lineCurrency: string | null = null
  // A 244x debit line that carries no amount in the invoice's currency. Fail
  // CLOSED on it, UNLESS the whole matched side is genuinely SEK-booked: then
  // the fallback below mirrors the RPC's FX residual settlement gate
  // (migration 20260830140000).
  let unconvertibleLineCurrency: string | null | undefined
  // Fallback classification, counted per LINE exactly as the RPC does: a line
  // labelled with the invoice's currency whose amount_in_currency is 0 is
  // still a readable LINE and must keep the fallback disabled, because its
  // real SEK ledger movement is excluded from sekSideTotal.
  let readableCount = 0
  let sekSideTotal = 0
  let foreignLabelCount = 0
  for (const raw of lines) {
    const line = raw as {
      account_number: string
      debit_amount: number | null
      credit_amount: number | null
      currency: string | null
      amount_in_currency: number | string | null
    }
    if (!line.account_number?.startsWith(AP_ACCOUNT_PREFIX)) continue
    const rawDebit = Number(line.debit_amount) || 0
    if (invoiceCurrency !== 'SEK' && rawDebit > 0) {
      if (line.currency === invoiceCurrency && line.amount_in_currency != null) {
        readableCount += 1
      } else if ((line.currency ?? 'SEK') === 'SEK') {
        sekSideTotal += rawDebit
      } else {
        foreignLabelCount += 1
      }
    }
    const debit = ledgerLineSideAmountIn(line, invoiceCurrency, 'debit')
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

  if (unconvertibleLineCurrency !== undefined) {
    // SEK-booked settlement fallback, mirroring the RPC gate byte-for-byte
    // (the supplier side has no kontantmetoden branch): zero readable lines,
    // every unreadable line SEK-booked, a sane exchange_rate, and the
    // voucher's SEK total within 10% of remaining * rate. The RPC settles the
    // FULL remaining and books the FX residual to 3960/7960 as its own
    // verifikat; the validation outcome only has to agree.
    const exchangeRate = Number(invoice.exchange_rate)
    const fallbackEligible =
      readableCount === 0 &&
      foreignLabelCount === 0 &&
      sekSideTotal > 0 &&
      Number.isFinite(exchangeRate) &&
      exchangeRate > 0 &&
      exchangeRate < 100000
    if (!fallbackEligible) {
      return {
        ok: false,
        code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
        details: {
          invoice_currency: invoice.currency,
          line_currency: unconvertibleLineCurrency,
        },
      }
    }
    const sekTotal = round2(sekSideTotal)
    const bookedSek = round2(remainingAmount * exchangeRate)
    if (Math.abs(sekTotal - bookedSek) > bookedSek * 0.1) {
      return {
        ok: false,
        code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
        details: {
          invoice_currency: invoice.currency,
          line_currency: unconvertibleLineCurrency,
          reason: 'fx_deviation_too_large',
          expected_sek: bookedSek,
          voucher_sek: sekTotal,
        },
      }
    }
    // Full-remaining settlement, exactly as the RPC computes it. lineCurrency
    // is null here (no readable line), so the label guard below passes and the
    // exceeds-remaining guard sees an equal amount.
    apDebitTotal = round2(remainingAmount)
  }

  if (apDebitTotal <= 0) {
    return { ok: false, code: 'LINK_SI_VOUCHER_NO_AP_DEBIT' }
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

  if (apDebitTotal > remainingAmount + AMOUNT_TOLERANCE) {
    return {
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ap_debit: apDebitTotal, remaining: round2(remainingAmount) },
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

  const paymentAmount = Math.min(apDebitTotal, round2(remainingAmount))
  const remainingAfter = Math.max(0, round2(remainingAmount - paymentAmount))
  const isFullyPaid = remainingAfter <= AMOUNT_TOLERANCE

  return {
    ok: true,
    apDebitAmount: apDebitTotal,
    apLineCurrency: lineCurrency,
    voucher: v,
    remainingAfter,
    isFullyPaid,
    paymentAmount,
  }
}

export interface LinkSupplierInvoiceToVoucherParams {
  supplierInvoiceId: string
  journalEntryId: string
  notes?: string
}

export interface LinkSupplierInvoiceToVoucherResult {
  paymentId: string
  invoiceStatus: 'paid' | 'partially_paid'
  paidAmount: number
  remainingAmount: number
  paymentAmount: number
  journalEntryId: string
  /** Bank transaction auto-reconciled to the linked voucher, if exactly one
   *  unbooked line matched it; null when nothing was safely linkable. */
  reconciledTransactionId: string | null
}

/**
 * Atomically link an existing posted verifikat as payment for a supplier
 * invoice. Inserts a supplier_invoice_payments row pointing at the JE, advances
 * the invoice's paid_amount / remaining_amount, and emits supplier_invoice.paid
 * (reusing the existing event so reminder/automation subscribers fire without
 * a new channel).
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
  const { data, error } = await supabase.rpc('link_supplier_invoice_to_voucher', {
    p_supplier_invoice_id: params.supplierInvoiceId,
    p_journal_entry_id: params.journalEntryId,
    p_user_id: userId,
    p_company_id: companyId,
    p_notes: params.notes ?? null,
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

  if (invoice) {
    try {
      await eventBus.emit({
        type: 'supplier_invoice.paid',
        payload: {
          supplierInvoice: invoice as SupplierInvoice,
          paymentAmount: result.payment_amount,
          userId,
          companyId,
        },
      })
    } catch (err) {
      // Event emission failure must not block the response, but should leave
      // an audit trail (ISO 27001:2022 A.8.15 / OWASP V16). Logged at warn
      // because the link itself succeeded: the downstream reminder/audit
      // subscriber will need separate intervention.
      log.warn('supplier_invoice.paid event emission failed', {
        err,
        supplierInvoiceId: params.supplierInvoiceId,
        journalEntryId: params.journalEntryId,
      })
    }
  }

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
      reconciledTransactionId,
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────

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

function descriptionMentionsToken(description: string | null, token: string): boolean {
  if (!description || !token) return false
  const normalizedDesc = description.replace(/\s+/g, '').toLowerCase()
  const normalizedTok = token.replace(/\s+/g, '').toLowerCase()
  if (normalizedTok.length < 2) return false
  return normalizedDesc.includes(normalizedTok)
}

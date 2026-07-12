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
import type { SupplierInvoice, Supplier } from '@/types'

const log = createLogger('supplier-voucher-matching')

/** AP account class. BAS 2026 reserves 2440-2449 for Leverantörsskulder
 *  (2440 SEK, 2441 utländsk valuta, 2443 Skuldfakturor, 2448 övriga). The
 *  supplier sub-ledger lives in the supplier_invoices table, not in per-
 *  supplier accounts. A samlingsverifikat that pays mixed SEK + EUR
 *  suppliers will legitimately debit both 2440 and 2441: summing across
 *  the 244x range catches that. PR #602 Swedish-compliance fix. */
const AP_ACCOUNT_PREFIX = '244'

/** ±90 days from the invoice's due_date as the default search window. */
const DEFAULT_DATE_WINDOW_DAYS = 90

/** Tolerance for floating-point comparisons on monetary amounts (0.5 öre). */
const AMOUNT_TOLERANCE = 0.005

/** Date-proximity bump applied when entry_date is within ±7 days of due_date. */
const DATE_PROXIMITY_BUMP = 0.05

export interface SupplierVoucherCandidate {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  /** Total debit on the AP account (2440) on this voucher, always positive. */
  ap_debit_amount: number
  currency: string
  /** Currency of the AP-debit line; nullable when the line stores SEK only. */
  ap_line_currency: string | null
  /** True when the voucher's fiscal period is closed or locked. */
  period_locked: boolean
  /** Confidence score 0..1 (or 0.99 for OCR match). */
  confidence: number
  /** Localized reason in Swedish. */
  match_reason: string
}

interface JournalEntryLine {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number | null
  credit_amount: number | null
  currency: string | null
}

interface VoucherRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  status: string
  source_type: string | null
  fiscal_period_id: string
}

interface FiscalPeriodRow {
  id: string
  status: string
}

interface CandidateContext {
  invoice: SupplierInvoice & { supplier?: Supplier }
  remainingAmount: number
}

const EXCLUDED_SOURCE_TYPES = ['opening_balance', 'storno']

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

  const { data: lines, error } = await supabase
    .from('journal_entry_lines')
    .select(
      `
      id,
      journal_entry_id,
      account_number,
      debit_amount,
      credit_amount,
      currency,
      journal_entries!inner (
        id,
        voucher_series,
        voucher_number,
        entry_date,
        description,
        status,
        source_type,
        fiscal_period_id,
        company_id
      )
      `,
    )
    .eq('journal_entries.company_id', companyId)
    .eq('journal_entries.status', 'posted')
    .like('account_number', `${AP_ACCOUNT_PREFIX}%`)
    .gt('debit_amount', 0)
    .gte('journal_entries.entry_date', dateFrom.toISOString().slice(0, 10))
    .lte('journal_entries.entry_date', dateTo.toISOString().slice(0, 10))
    .limit(limit * 10)
  if (error || !lines) return []

  // Sum the AP debit per voucher across multiple 2440 lines (a samlings-
  // verifikation paying several supplier invoices in one shot will have one
  // 2440 row per supplier).
  const byEntry = new Map<
    string,
    { entry: VoucherRow; apDebitTotal: number; lineCurrency: string | null }
  >()

  for (const raw of lines) {
    const line = raw as unknown as JournalEntryLine & {
      journal_entries: VoucherRow
    }
    const entry = line.journal_entries
    if (!entry) continue
    if (EXCLUDED_SOURCE_TYPES.includes(entry.source_type ?? '')) continue

    const debit = Number(line.debit_amount ?? 0)
    if (debit <= 0) continue

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
  const { data: periods } = await supabase
    .from('fiscal_periods')
    .select('id, status')
    .in('id', periodIds)
  const lockedPeriods = new Set(
    (periods ?? [])
      .filter(
        (p) =>
          (p as FiscalPeriodRow).status === 'closed' ||
          (p as FiscalPeriodRow).status === 'locked',
      )
      .map((p) => (p as FiscalPeriodRow).id),
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

  // Currency check: 2440 line currency must match invoice currency (or be
  // unset, which we treat as the invoice currency).
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

  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, currency')
    .eq('journal_entry_id', journalEntryId)
  if (linesError || !lines || lines.length === 0) {
    return { ok: false, code: 'LINK_SI_VOUCHER_NO_AP_DEBIT' }
  }

  let apDebitTotal = 0
  let lineCurrency: string | null = null
  for (const raw of lines) {
    const line = raw as {
      account_number: string
      debit_amount: number | null
      credit_amount: number | null
      currency: string | null
    }
    if (!line.account_number?.startsWith(AP_ACCOUNT_PREFIX)) continue
    const debit = Number(line.debit_amount ?? 0)
    if (debit <= 0) continue
    apDebitTotal += debit
    if (!lineCurrency) lineCurrency = line.currency
  }
  apDebitTotal = round2(apDebitTotal)

  if (apDebitTotal <= 0) {
    return { ok: false, code: 'LINK_SI_VOUCHER_NO_AP_DEBIT' }
  }

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

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isDateWithinDays(a: string, b: string, days: number): boolean {
  const ad = new Date(a).getTime()
  const bd = new Date(b).getTime()
  if (Number.isNaN(ad) || Number.isNaN(bd)) return false
  return Math.abs(ad - bd) <= days * 24 * 3600 * 1000
}

function descriptionMentionsToken(description: string | null, token: string): boolean {
  if (!description || !token) return false
  const normalizedDesc = description.replace(/\s+/g, '').toLowerCase()
  const normalizedTok = token.replace(/\s+/g, '').toLowerCase()
  if (normalizedTok.length < 2) return false
  return normalizedDesc.includes(normalizedTok)
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

/**
 * Link an existing posted verifikat to a customer invoice as its payment row.
 *
 * The matching is accounting-method aware (company_settings.accounting_method):
 *   • Faktureringsmetoden (accrual): match verifikat that CREDIT an AR account
 *     (default 1510, covers 151x): e.g. a SIE-imported payment voucher or a
 *     manually-entered receipt that clears the receivable.
 *   • Kontantmetoden (cash): no 1510 is ever booked (revenue is recognised at
 *     payment: debit 19xx / credit 30xx+26xx), so instead match verifikat that
 *     DEBIT a liquid-funds account (BAS class 19: kassa/bank, covers
 *     1910/1920/1930/1940…). That voucher IS the payment the user already
 *     booked; linking just marks the invoice paid without a duplicate entry.
 *
 * No new journal entry is created in either case. Only an invoice_payments row
 * is inserted pointing at the existing journal_entry_id, plus the invoice's
 * paid_amount/remaining_amount/status are advanced.
 *
 * Both the web API route and the MCP commit handler call into the same
 * `linkInvoiceToVoucher()` function (→ link_invoice_to_voucher RPC) so
 * behaviour stays in lockstep.
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
import type { Invoice, Customer } from '@/types'

const log = createLogger('voucher-matching')

/** AR account range. Default 1510 (Kundfordringar): covers all 151x. Used on
 *  faktureringsmetoden, where the issuance verifikat books the receivable. */
const AR_ACCOUNT_PREFIX = '151'

/** Liquid-funds range (Kassa och bank, BAS class 19: 1910/1920/1930/1940…).
 *  Used on kontantmetoden, where the payment verifikat debits a bank/cash
 *  account instead of crediting 1510. */
const CASH_ACCOUNT_PREFIX = '19'

/**
 * Read the company's accounting method. Defaults to 'accrual' when the settings
 * row or column is absent: mirrors mark-paid / propose-payment-lines.
 */
async function resolveAccountingMethod(
  supabase: SupabaseClient,
  companyId: string
): Promise<'accrual' | 'cash'> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    // A transient failure here would silently flip a cash company to the
    // accrual (151x) search and render an empty candidate list: make the
    // fallback visible so an intermittent empty state is diagnosable.
    log.warn('accounting_method lookup failed; falling back to accrual', {
      companyId,
      message: error.message,
    })
  }
  return (data as { accounting_method?: string } | null)?.accounting_method === 'cash'
    ? 'cash'
    : 'accrual'
}

/** ±90 days from the invoice's due_date as the default search window. */
const DEFAULT_DATE_WINDOW_DAYS = 90

/** Tolerance for floating-point comparisons on monetary amounts (0.5 öre). */
const AMOUNT_TOLERANCE = 0.005

/** Date-proximity bump applied when entry_date is within ±7 days of due_date. */
const DATE_PROXIMITY_BUMP = 0.05

export interface VoucherCandidate {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  /** Matched amount on this voucher, always positive: the AR credit (151x) on
   *  faktureringsmetoden, or the liquid-funds debit (19xx) on kontantmetoden.
   *  Kept under this name for API/UI back-compat across both methods. */
  ar_credit_amount: number
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
  invoice: Invoice & { customer?: Customer }
  remainingAmount: number
}

/** Internal: SQL-side filter for posted, non-storno, non-opening entries. */
const EXCLUDED_SOURCE_TYPES = ['opening_balance', 'storno']

/**
 * Find posted journal entries that could plausibly be the payment for this
 * invoice and return up to `limit` ranked candidates. On faktureringsmetoden
 * those are vouchers crediting an AR account (151x); on kontantmetoden they are
 * vouchers debiting a liquid-funds account (19xx): see the module header.
 *
 * The query is intentionally generous on filtering: we let the validator
 * make the final call at commit time. Ranking mirrors
 * `findMatchingInvoices()`: exact amount + customer match wins, then exact,
 * then fuzzy (±1% capped at 500 SEK), with a small bump for date proximity
 * to the invoice's due_date.
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

  // Cash method: match the bank/cash DEBIT (19xx). Accrual: match the AR
  // CREDIT (151x). The account prefix + side both switch on the method.
  const isCash = (await resolveAccountingMethod(supabase, companyId)) === 'cash'
  const accountPrefix = isCash ? CASH_ACCOUNT_PREFIX : AR_ACCOUNT_PREFIX
  const amountColumn = isCash ? 'debit_amount' : 'credit_amount'

  const dueDate = new Date(invoice.due_date)
  const dateFrom = new Date(dueDate)
  dateFrom.setDate(dateFrom.getDate() - windowDays)
  const dateTo = new Date(dueDate)
  dateTo.setDate(dateTo.getDate() + windowDays)

  // Pre-filter the matched side to a band around the invoice amount before the
  // row cap applies. Without this, a cash company with many 19xx-debit lines
  // (every bank receipt) overflows the cap and the relevant voucher can be
  // dropped before it is ever scored. The band is a superset of every case
  // scoreCandidate accepts (exact remaining/total + fuzzy ±1% capped 500 SEK),
  // so it never hides a single-line match.
  const hiAmount = Math.max(remainingAmount, invoice.total)
  const loAmount = Math.min(remainingAmount, invoice.total)
  const amountPad = Math.min(hiAmount * 0.01, 500) + 0.02
  const amountFloor = Math.max(0, loAmount - amountPad)
  const amountCeil = hiAmount + amountPad

  // Drive the query from journal_entries, embedding the matched lines, NOT
  // from journal_entry_lines joined up to the entry. PostgREST executes the
  // FROM table first: driving from lines means scanning `account LIKE '19%'`
  // across ALL tenants and running the lines RLS policy (a per-row EXISTS via
  // current_active_company_id()) thousands of times: on a cash company every
  // bank receipt is a 19xx debit, and the query blows the authenticated
  // statement_timeout (8s). Driving from entries hits company+date+status
  // indexes first (a handful of rows), so the per-line RLS check only runs for
  // those entries' lines. Same result set, milliseconds instead of seconds.
  let query = supabase
    .from('journal_entries')
    .select(
      `
      id,
      voucher_series,
      voucher_number,
      entry_date,
      description,
      status,
      source_type,
      fiscal_period_id,
      company_id,
      journal_entry_lines!inner (
        id,
        account_number,
        debit_amount,
        credit_amount,
        currency
      )
      `
    )
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .gte('entry_date', dateFrom.toISOString().slice(0, 10))
    .lte('entry_date', dateTo.toISOString().slice(0, 10))
    .like('journal_entry_lines.account_number', `${accountPrefix}%`)
  query = isCash
    ? query.gt('journal_entry_lines.debit_amount', 0)
    : query.gt('journal_entry_lines.credit_amount', 0)
  const { data: entryRows, error } = await query
    .gte(`journal_entry_lines.${amountColumn}`, amountFloor)
    .lte(`journal_entry_lines.${amountColumn}`, amountCeil)
    .limit(limit * 10)
  if (error) {
    // Surface transient failures instead of silently rendering "no candidates":
    // a swallowed error looks like a match that intermittently vanishes.
    log.warn('voucher candidate query failed', {
      companyId,
      invoiceId: invoice.id,
      message: error.message,
    })
  }
  if (error || !entryRows) return []

  // Sum the matched side per voucher (the embed already contains only the
  // lines that passed the account/side/amount filters).
  const byEntry = new Map<
    string,
    { entry: VoucherRow; arCreditTotal: number; lineCurrency: string | null }
  >()

  for (const raw of entryRows) {
    const entry = raw as unknown as VoucherRow & {
      journal_entry_lines: Pick<
        JournalEntryLine,
        'id' | 'account_number' | 'debit_amount' | 'credit_amount' | 'currency'
      >[]
    }
    if (EXCLUDED_SOURCE_TYPES.includes(entry.source_type ?? '')) continue

    let matchedTotal = 0
    let lineCurrency: string | null = null
    for (const line of entry.journal_entry_lines ?? []) {
      // Matched amount = the bank/cash debit (cash) or AR credit (accrual).
      const matched = isCash ? Number(line.debit_amount ?? 0) : Number(line.credit_amount ?? 0)
      if (matched <= 0) continue
      matchedTotal += matched
      if (!lineCurrency) lineCurrency = line.currency
    }
    if (matchedTotal <= 0) continue

    byEntry.set(entry.id, { entry, arCreditTotal: matchedTotal, lineCurrency })
  }

  if (byEntry.size === 0) return []

  // Fetch the already-linked payments (for dedup) and the fiscal-period locks
  // (informational "låst period" badge) concurrently: both depend only on the
  // grouped entries, so there is no reason to pay two sequential round-trips.
  // Computing locks for entries that dedup later drops is harmless.
  const candidateEntryIds = Array.from(byEntry.keys())
  const periodIds = Array.from(
    new Set(Array.from(byEntry.values()).map((v) => v.entry.fiscal_period_id))
  )
  const [{ data: existingLinks }, { data: periods }] = await Promise.all([
    supabase
      .from('invoice_payments')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .eq('invoice_id', invoice.id)
      .in('journal_entry_id', candidateEntryIds),
    supabase
      .from('fiscal_periods')
      .select('id, status')
      .in('id', periodIds),
  ])

  // Drop entries already fully linked to *this* invoice.
  const alreadyLinked = new Set(
    (existingLinks ?? [])
      .map((row) => (row as { journal_entry_id: string | null }).journal_entry_id)
      .filter((id): id is string => !!id)
  )
  for (const id of alreadyLinked) byEntry.delete(id)
  if (byEntry.size === 0) return []

  // Linking is allowed in locked periods (no JE mutation): this flag is just
  // informational for the candidate preview.
  const lockedPeriods = new Set(
    (periods ?? [])
      .filter(
        (p) =>
          (p as FiscalPeriodRow).status === 'closed' ||
          (p as FiscalPeriodRow).status === 'locked'
      )
      .map((p) => (p as FiscalPeriodRow).id)
  )

  // Score and rank.
  const ctx: CandidateContext = { invoice, remainingAmount }
  const candidates: VoucherCandidate[] = []
  for (const { entry, arCreditTotal, lineCurrency } of byEntry.values()) {
    const scored = scoreCandidate(entry, arCreditTotal, lineCurrency, ctx)
    if (!scored) continue
    candidates.push({
      journal_entry_id: entry.id,
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      description: entry.description,
      ar_credit_amount: round2(arCreditTotal),
      currency: invoice.currency,
      ar_line_currency: lineCurrency,
      period_locked: lockedPeriods.has(entry.fiscal_period_id),
      confidence: scored.confidence,
      match_reason: scored.match_reason,
    })
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.entry_date.localeCompare(b.entry_date))
  return candidates.slice(0, limit)
}

function scoreCandidate(
  entry: VoucherRow,
  arCreditTotal: number,
  lineCurrency: string | null,
  ctx: CandidateContext
): { confidence: number; match_reason: string } | null {
  // OCR-style: invoice number appears in entry description.
  if (
    ctx.invoice.invoice_number &&
    descriptionMentionsInvoice(entry.description, ctx.invoice.invoice_number)
  ) {
    return {
      confidence: CONFIDENCE.OCR_REFERENCE_MATCH,
      match_reason: `Fakturanummer ${ctx.invoice.invoice_number} omnämnt i verifikatets beskrivning`,
    }
  }

  // Currency mismatch is a hard filter at validation time; candidate listing
  // still surfaces near-misses so the user sees them, but we only score them
  // for now if the line currency is absent (treated as invoice currency) or
  // matches the invoice currency.
  const lineCurrencyEffective = lineCurrency ?? ctx.invoice.currency
  if (lineCurrencyEffective !== ctx.invoice.currency) {
    return null
  }

  const exactRemaining = amountsMatchExact(arCreditTotal, ctx.remainingAmount)
  const exactTotal =
    !exactRemaining && amountsMatchExact(arCreditTotal, ctx.invoice.total)
  const fuzzyRemaining =
    !exactRemaining && !exactTotal && amountsMatchFuzzy(arCreditTotal, ctx.remainingAmount)

  const customerMatch = customerNameMatches(
    ctx.invoice.customer?.name,
    entry.description,
    null
  )

  let confidence = 0
  let reason = ''
  if (exactRemaining && customerMatch) {
    confidence = CONFIDENCE.EXACT_AMOUNT_CUSTOMER
    reason = `Exakt belopp (${formatNumber(arCreditTotal)} ${ctx.invoice.currency}) och kundnamn matchar`
  } else if (exactRemaining) {
    confidence = CONFIDENCE.EXACT_AMOUNT_ONLY
    reason = `Exakt belopp (${formatNumber(arCreditTotal)} ${ctx.invoice.currency})`
  } else if (exactTotal && customerMatch) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_CUSTOMER
    reason = `Fakturans totalbelopp och kundnamn matchar`
  } else if (exactTotal) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_ONLY + 0.05
    reason = `Fakturans totalbelopp matchar`
  } else if (fuzzyRemaining && customerMatch) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_CUSTOMER
    reason = `Belopp nära (±1%) och kundnamn matchar`
  } else if (fuzzyRemaining) {
    confidence = CONFIDENCE.FUZZY_AMOUNT_ONLY
    reason = `Belopp nära (±1%)`
  } else {
    return null
  }

  // Bump for date proximity to due_date.
  if (isDateWithinDays(entry.entry_date, ctx.invoice.due_date, 7)) {
    confidence = Math.min(CONFIDENCE.OCR_REFERENCE_MATCH - 0.001, confidence + DATE_PROXIMITY_BUMP)
  }

  return { confidence, match_reason: reason }
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
  | 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING'
  | 'LINK_VOUCHER_CURRENCY_MISMATCH'
  | 'LINK_VOUCHER_INVOICE_FULLY_PAID'
  | 'LINK_VOUCHER_DB_ERROR'

/**
 * Validate that a journal entry can be linked as payment for an invoice.
 * Used by both the staging path (MCP tool) and the commit path (web route +
 * MCP commit handler) so the guards stay identical.
 */
export async function validateVoucherForInvoiceLink(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Invoice & { customer?: Customer },
  journalEntryId: string
): Promise<ValidateResult> {
  const remainingAmount = computeRemaining(invoice)
  if (remainingAmount <= AMOUNT_TOLERANCE) {
    return { ok: false, code: 'LINK_VOUCHER_INVOICE_FULLY_PAID' }
  }

  // Match the bank/cash debit (cash) or the AR credit (accrual): see header.
  const isCash = (await resolveAccountingMethod(supabase, companyId)) === 'cash'
  const accountPrefix = isCash ? CASH_ACCOUNT_PREFIX : AR_ACCOUNT_PREFIX

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

  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, currency')
    .eq('journal_entry_id', journalEntryId)
  if (linesError || !lines || lines.length === 0) {
    return { ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' }
  }

  let arCreditTotal = 0
  let lineCurrency: string | null = null
  for (const raw of lines) {
    const line = raw as { account_number: string; debit_amount: number | null; credit_amount: number | null; currency: string | null }
    if (!line.account_number?.startsWith(accountPrefix)) continue
    const matched = isCash ? Number(line.debit_amount ?? 0) : Number(line.credit_amount ?? 0)
    if (matched <= 0) continue
    arCreditTotal += matched
    if (!lineCurrency) lineCurrency = line.currency
  }
  arCreditTotal = round2(arCreditTotal)

  if (arCreditTotal <= 0) {
    return { ok: false, code: 'LINK_VOUCHER_NO_AR_CREDIT' }
  }

  const lineCurrencyEffective = lineCurrency ?? invoice.currency
  if (lineCurrencyEffective !== invoice.currency) {
    return {
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: invoice.currency, line_currency: lineCurrencyEffective },
    }
  }

  if (arCreditTotal > remainingAmount + AMOUNT_TOLERANCE) {
    return {
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ar_credit: arCreditTotal, remaining: round2(remainingAmount) },
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

  const paymentAmount = Math.min(arCreditTotal, round2(remainingAmount))
  const remainingAfter = Math.max(0, round2(remainingAmount - paymentAmount))
  const isFullyPaid = remainingAfter <= AMOUNT_TOLERANCE

  return {
    ok: true,
    arCreditAmount: arCreditTotal,
    arLineCurrency: lineCurrency,
    voucher: v,
    remainingAfter,
    isFullyPaid,
    paymentAmount,
  }
}

export interface LinkInvoiceToVoucherParams {
  invoiceId: string
  journalEntryId: string
  notes?: string
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
 * and emits invoice.match_confirmed (reusing the existing event so reminder
 * cancellation + automations fire without a new event channel).
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
  | { ok: false; code: VoucherLinkErrorCode; details?: Record<string, unknown> }
> {
  // All validation + writes happen inside link_invoice_to_voucher (PL/pgSQL).
  // The function locks the invoice row FOR UPDATE, re-validates the voucher,
  // and applies the invoices UPDATE + invoice_payments INSERT in a single PG
  // transaction, so concurrent linkers serialize and a failure on either write
  // rolls back automatically. The previous TS implementation did
  // UPDATE-then-INSERT with a manual rollback that restored from a STALE
  // pre-link snapshot: under concurrent linking it could clobber a sibling's
  // successful write while leaving its payment row in place (audit C2; mirrors
  // the supplier-side link_supplier_invoice_to_voucher fix from PR #602).
  const { data: rpcData, error: rpcError } = await supabase.rpc('link_invoice_to_voucher', {
    p_invoice_id: params.invoiceId,
    p_journal_entry_id: params.journalEntryId,
    p_user_id: userId,
    p_company_id: companyId,
    p_notes: params.notes ?? null,
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

  // Fetch the now-updated invoice (with customer) for event emission: the RPC
  // committed before this read, so the row reflects post-link state. Mirrors
  // the supplier-side wrapper.
  const { data: invoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*)')
    .eq('id', params.invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (invoice) {
    try {
      await eventBus.emit({
        type: 'invoice.paid',
        payload: {
          invoice: invoice as Invoice,
          paymentAmount: rpc.payment_amount,
          paymentDate: rpc.payment_date,
          userId,
          companyId,
        },
      })
    } catch {
      /* non-critical */
    }
  }

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
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────

function computeRemaining(invoice: Invoice): number {
  if (typeof invoice.remaining_amount === 'number' && invoice.remaining_amount > 0) {
    return invoice.remaining_amount
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

function descriptionMentionsInvoice(description: string | null, invoiceNumber: string): boolean {
  if (!description || !invoiceNumber) return false
  const normalizedDesc = description.replace(/\s+/g, '').toLowerCase()
  const normalizedNum = invoiceNumber.replace(/\s+/g, '').toLowerCase()
  return normalizedDesc.includes(normalizedNum)
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

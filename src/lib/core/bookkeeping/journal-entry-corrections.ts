/**
 * Corrections of a POSTED verifikat, shared by the dashboard routes
 * (app/api/bookkeeping/journal-entries/[id]/{correct-metadata,strike-lines,
 * recordate,rattelse-log}), the v1 operations and their MCP tools
 * (lib/operations/journal-entries.ts).
 *
 * BFL 5 kap 5 § permits exactly two correction tracks, and nothing here adds
 * a third:
 *   - inline rättelse inside the same verifikat, only in an open, unlocked
 *     period: the correct_entry_metadata / correct_entry_lines_inline RPCs,
 *     which enforce every rule, write the immutable who/when row to
 *     journal_entry_rattelse_log and are the ONLY write the commit path makes;
 *   - storno + re-post (särskild rättelsepost): recordateEntry in
 *     storno-service, which moves a verifikat to another date/period.
 *
 * The dry run (the MCP staging preview and v1 ?dry_run=true) replays the
 * RPCs' and recordateEntry's rules as reads and answers the resulting lines.
 * It never calls an RPC, the engine or the account backfill, so it spends no
 * voucher number and writes no row. The RPC stays authoritative: it re-checks
 * everything at commit, so a rule the preview could not see (the exact bank
 * amount an anchored 19xx line must keep) still refuses the commit.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { recordateEntry } from '@/lib/core/bookkeeping/storno-service'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { correctionChainDepth, CORRECTION_CHAIN_GUARD_DEPTH } from '@/lib/core/bookkeeping/correction-chain'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { resolveUserLabelsFromProfiles } from '@/lib/reports/behandlingshistorik'
import {
  AccountsNotInChartError,
  CannotCorrectNonPostedError,
  CorrectionChainTooDeepError,
  JournalEntryNotFoundError,
  MeaninglessCorrectionError,
  NoOpenPeriodForDateError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
  isBookkeepingError,
} from '@/lib/bookkeeping/errors'
import type { JournalEntry } from '@/types'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** Entry types whose lines keep their dedicated flows (same list as the RPC). */
const LINE_RATTELSE_EXCLUDED_SOURCES = ['storno', 'year_end', 'vat_settlement'] as const
/** Entry types whose date carries structural meaning (same list as the RPC). */
const DATE_FIXED_SOURCES = ['opening_balance', 'year_end', 'vat_settlement'] as const

const STORNO_HINT = 'använd rättelseverifikat (storno).'

function refused(messageSv: string, details?: Record<string, unknown>): Failure {
  return { ok: false, code: 'JOURNAL_RATTELSE_REFUSED', messageSv, ...(details ? { details } : {}) }
}

function voucherLabel(entry: { voucher_series?: string | null; voucher_number?: number | null }): string | null {
  return entry.voucher_number ? `${entry.voucher_series ?? ''}${entry.voucher_number}` : null
}

/**
 * The RPCs report every rule violation as a plain RAISE EXCEPTION (P0001)
 * with a Swedish sentence, and the tenant guard as 42501. Map them to the
 * registry: the sentence rides along as messageSv so every door shows the
 * rule the database named.
 */
function rpcFailure(
  ctx: OperationContext,
  rpc: string,
  entryId: string,
  error: { code?: string; message?: string },
): Failure {
  if (error.code === 'P0001') {
    const messageSv = getErrorMessage(error)
    // The RPC's own not-found (wrong company or no such entry): a 404, not a
    // refused rule, so an API caller can tell a typo from a legal refusal.
    if ((error.message ?? '').startsWith('Verifikationen hittades inte')) {
      return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }
    }
    if (/stängd eller låst|Bokföringen är låst/.test(error.message ?? '')) {
      return { ok: false, code: 'JOURNAL_RATTELSE_PERIOD_LOCKED', messageSv }
    }
    return refused(messageSv)
  }
  if (error.code === '42501') {
    return { ok: false, code: 'FORBIDDEN', messageSv: getErrorMessage(error) }
  }
  // Defensive: the lines RPC pre-checks document links, but if the RESTRICT
  // FK still fires (a racing attachment), give the same guidance.
  if (error.code === '23503') {
    return refused(`En rad som ska strykas har ett kopplat underlag: ${STORNO_HINT}`)
  }
  ctx.log.error(`${rpc} failed`, new Error(error.message ?? rpc), { entryId })
  return { ok: false, code: 'JOURNAL_RATTELSE_FAILED' }
}

// ---------------------------------------------------------------------------
// Shared pre-reads for the inline rättelse previews
// ---------------------------------------------------------------------------

interface PostedEntryRow {
  id: string
  status: string
  description: string
  entry_date: string
  source_type: string
  fiscal_period_id: string
  voucher_series: string | null
  voucher_number: number | null
}

interface PeriodRow {
  is_closed: boolean | null
  locked_at: string | null
  period_start: string
  period_end: string
  opening_balance_entry_id: string | null
}

async function loadPostedEntry(
  ctx: OperationContext,
  entryId: string,
): Promise<{ ok: true; entry: PostedEntryRow } | Failure> {
  const { data, error } = await ctx.supabase
    .from('journal_entries')
    .select('id, status, description, entry_date, source_type, fiscal_period_id, voucher_series, voucher_number')
    .eq('id', entryId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) {
    ctx.log.error('failed to load journal entry for rättelse preview', new Error(error.message), { entryId })
    return { ok: false, code: 'JOURNAL_RATTELSE_FAILED' }
  }
  if (!data) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }
  const entry = data as PostedEntryRow
  if (entry.status !== 'posted') {
    return { ok: false, code: 'CANNOT_CORRECT_NON_POSTED', details: { current_status: entry.status } }
  }
  return { ok: true, entry }
}

/** Open, unlocked period and entry date after the company lock date (the RPCs' envelope). */
async function loadOpenPeriod(
  ctx: OperationContext,
  entry: PostedEntryRow,
  datesToCheck: string[],
): Promise<{ ok: true; period: PeriodRow } | Failure> {
  const { data: period, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('is_closed, locked_at, period_start, period_end, opening_balance_entry_id')
    .eq('id', entry.fiscal_period_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error || !period) {
    ctx.log.error('failed to load fiscal period for rättelse preview', error ? new Error(error.message) : undefined, {
      entryId: entry.id,
    })
    return { ok: false, code: 'JOURNAL_RATTELSE_FAILED' }
  }
  const row = period as PeriodRow
  if (row.is_closed || row.locked_at) {
    return {
      ok: false,
      code: 'JOURNAL_RATTELSE_PERIOD_LOCKED',
      details: { fiscal_period_id: entry.fiscal_period_id, reason: row.is_closed ? 'period_is_closed' : 'period_locked_at_set' },
    }
  }
  const { data: settings, error: settingsError } = await ctx.supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (settingsError) {
    // Unknown lock date: the entry could be behind it. Fail closed.
    ctx.log.error('failed to read the company lock date for rättelse preview', new Error(settingsError.message))
    return { ok: false, code: 'JOURNAL_RATTELSE_FAILED' }
  }
  const lockThrough = (settings?.bookkeeping_locked_through as string | null | undefined) ?? null
  if (lockThrough && datesToCheck.some((d) => d <= lockThrough)) {
    return {
      ok: false,
      code: 'JOURNAL_RATTELSE_PERIOD_LOCKED',
      messageSv: `Bokföringen är låst t.o.m. ${lockThrough}: ${STORNO_HINT}`,
      details: { reason: 'company_lock_date_covers', bookkeeping_locked_through: lockThrough },
    }
  }
  return { ok: true, period: row }
}

// ---------------------------------------------------------------------------
// Metadata rättelse: description and/or date inside the same period
// ---------------------------------------------------------------------------

export interface CorrectMetadataInput {
  description?: string
  entry_date?: string
}

export async function correctJournalEntryMetadata(
  ctx: OperationContext,
  entryId: string,
  input: CorrectMetadataInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<Record<string, unknown>>> {
  if (options.dryRun) return previewMetadataCorrection(ctx, entryId, input)

  const { data, error } = await ctx.supabase.rpc('correct_entry_metadata', {
    p_company_id: ctx.companyId,
    p_entry_id: entryId,
    p_description: input.description ?? null,
    p_entry_date: input.entry_date ?? null,
    p_user_id: ctx.userId,
  })
  if (error) return rpcFailure(ctx, 'correct_entry_metadata', entryId, error)
  return { ok: true, data: (data ?? {}) as Record<string, unknown> }
}

async function previewMetadataCorrection(
  ctx: OperationContext,
  entryId: string,
  input: CorrectMetadataInput,
): Promise<OperationOutcome<Record<string, unknown>>> {
  const loaded = await loadPostedEntry(ctx, entryId)
  if (!loaded.ok) return loaded
  const { entry } = loaded

  const trimmed = input.description?.trim()
  const newDescription = trimmed ? trimmed : entry.description
  const newDate = input.entry_date ?? entry.entry_date
  const dateMoves = newDate !== entry.entry_date

  if (entry.source_type === 'storno') {
    return refused('Stornoverifikat kan inte rättas: rätta eller återför originalverifikatet i stället.')
  }
  if (dateMoves && (DATE_FIXED_SOURCES as readonly string[]).includes(entry.source_type)) {
    return refused('Datumet på den här verifikationstypen kan inte ändras.', { source_type: entry.source_type })
  }

  const open = await loadOpenPeriod(ctx, entry, [entry.entry_date, newDate])
  if (!open.ok) return open
  const { period } = open
  if (dateMoves && (newDate < period.period_start || newDate > period.period_end)) {
    return refused(
      `Nytt datum måste ligga inom samma bokföringsperiod (${period.period_start} till ${period.period_end}). Använd "Flytta till annat datum" för att byta period.`,
      { period_start: period.period_start, period_end: period.period_end, use: 'POST /journal-entries/{id}/redate' },
    )
  }

  const changed = newDescription !== entry.description || dateMoves
  return {
    ok: true,
    dryRun: true,
    preview: {
      journal_entry_id: entry.id,
      voucher: voucherLabel(entry),
      changed,
      old_description: entry.description,
      new_description: newDescription,
      old_entry_date: entry.entry_date,
      new_entry_date: newDate,
      fiscal_period_id: entry.fiscal_period_id,
      will: changed
        ? 'correct the text/date inside the same verifikat and log the old and new values with who and when (BFL 5 kap 5 § and 9 §); no new verifikat, no voucher number'
        : 'change nothing: the values equal the current ones',
    },
  }
}

// ---------------------------------------------------------------------------
// Line rättelse: strike lines and add replacements inside the same verifikat
// ---------------------------------------------------------------------------

export interface InlineRattelseLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
  dimensions?: Record<string, string>
}

export interface StrikeLinesInput {
  strike_line_ids: string[]
  lines: InlineRattelseLine[]
}

export async function strikeJournalEntryLines(
  ctx: OperationContext,
  entryId: string,
  input: StrikeLinesInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<Record<string, unknown>>> {
  if (options.dryRun) return previewLineRattelse(ctx, entryId, input)

  // Seed standard BAS accounts the replacement lines reference but the
  // company chart lacks (same courtesy as the engine/storno flow); unknown
  // numbers stay missing and fail the RPC's chart check with a clear error.
  const accountNumbers = [...new Set(input.lines.map((l) => l.account_number))]
  if (accountNumbers.length > 0) {
    await backfillStandardBASAccounts(ctx.supabase, ctx.companyId, ctx.userId, accountNumbers)
  }

  const { data, error } = await ctx.supabase.rpc('correct_entry_lines_inline', {
    p_company_id: ctx.companyId,
    p_entry_id: entryId,
    p_strike_line_ids: input.strike_line_ids,
    p_new_lines: input.lines.map((l) => ({
      account_number: l.account_number,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      line_description: l.line_description ?? null,
      dimensions: l.dimensions ?? {},
    })),
    p_user_id: ctx.userId,
  })
  if (error) return rpcFailure(ctx, 'correct_entry_lines_inline', entryId, error)
  return { ok: true, data: (data ?? {}) as Record<string, unknown> }
}

interface LineRow {
  id: string
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  line_description: string | null
  currency: string | null
  dimensions: Record<string, string> | null
  sort_order: number
}

interface PreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  dimensions: Record<string, string>
}

/** Canonical key of a line, the same fields the RPC compares for "changes nothing". */
function lineKey(l: PreviewLine): string {
  const dims = Object.keys(l.dimensions)
    .sort()
    .map((k) => `${k}=${l.dimensions[k]}`)
    .join(',')
  return [l.account_number, roundOre(l.debit_amount), roundOre(l.credit_amount), l.line_description ?? '', dims].join('|')
}

function toPreviewLine(row: LineRow): PreviewLine & { id: string } {
  return {
    id: row.id,
    account_number: row.account_number,
    debit_amount: roundOre(Number(row.debit_amount) || 0),
    credit_amount: roundOre(Number(row.credit_amount) || 0),
    line_description: row.line_description,
    dimensions: row.dimensions ?? {},
  }
}

function sumSide(lines: PreviewLine[], side: 'debit_amount' | 'credit_amount'): number {
  return roundOre(lines.reduce((sum, l) => sum + l[side], 0))
}

async function previewLineRattelse(
  ctx: OperationContext,
  entryId: string,
  input: StrikeLinesInput,
): Promise<OperationOutcome<Record<string, unknown>>> {
  const { supabase, companyId } = ctx
  const loaded = await loadPostedEntry(ctx, entryId)
  if (!loaded.ok) return loaded
  const { entry } = loaded

  if ((LINE_RATTELSE_EXCLUDED_SOURCES as readonly string[]).includes(entry.source_type)) {
    return refused('Den här verifikationstypen kan inte rättas radvis: använd dess egen rättelsefunktion.', {
      source_type: entry.source_type,
    })
  }
  const isOpeningBalance = entry.source_type === 'opening_balance'

  const open = await loadOpenPeriod(ctx, entry, [entry.entry_date])
  if (!open.ok) return open

  if (isOpeningBalance) {
    if (open.period.opening_balance_entry_id !== entry.id) {
      return refused('Verifikationen är inte periodens aktuella ingående balans.')
    }
    const { data: yearEnd } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', entry.fiscal_period_id)
      .eq('source_type', 'year_end')
      .eq('status', 'posted')
      .limit(1)
    if ((yearEnd ?? []).length > 0) {
      return refused('Perioden har ett bokslut. Återför bokslutet innan ingående balanser kan rättas.')
    }
  }

  const { data: lineData, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select('id, account_number, debit_amount, credit_amount, line_description, currency, dimensions, sort_order')
    .eq('journal_entry_id', entry.id)
    .order('sort_order', { ascending: true })
  if (linesError) {
    ctx.log.error('failed to load journal lines for rättelse preview', new Error(linesError.message), { entryId })
    return { ok: false, code: 'JOURNAL_RATTELSE_FAILED' }
  }
  const lines = (lineData ?? []) as LineRow[]

  const strikeIds = [...new Set(input.strike_line_ids)]
  const byId = new Map(lines.map((l) => [l.id, l]))
  if (strikeIds.some((id) => !byId.has(id))) {
    return refused('En eller flera rader som ska strykas hör inte till verifikationen.')
  }
  const struckRows = strikeIds.map((id) => byId.get(id)!)
  if (struckRows.some((l) => l.currency && l.currency !== 'SEK')) {
    return refused(`Rader i utländsk valuta kan inte strykas: ${STORNO_HINT}`)
  }
  if (strikeIds.length > 0) {
    const { data: linkedDocs } = await supabase
      .from('document_attachments')
      .select('id')
      .eq('company_id', companyId)
      .in('journal_entry_line_id', strikeIds)
      .limit(1)
    if ((linkedDocs ?? []).length > 0) {
      return refused(`En rad som ska strykas har ett kopplat underlag: ${STORNO_HINT}`)
    }
  }

  // Replacement lines: the same shape rules the RPC applies, SEK only.
  const added: PreviewLine[] = []
  for (const l of input.lines) {
    const debit = roundOre(l.debit_amount || 0)
    const credit = roundOre(l.credit_amount || 0)
    if (isOpeningBalance && !['1', '2'].includes(l.account_number.charAt(0))) {
      return refused(`Resultatkonton (klass 3-8) kan inte användas i ingående balanser (konto ${l.account_number}).`)
    }
    if (debit === 0 && credit === 0) {
      return refused(`En rad måste ha ett belopp (konto ${l.account_number}).`)
    }
    added.push({
      account_number: l.account_number,
      debit_amount: debit,
      credit_amount: credit,
      line_description: l.line_description?.trim() ? l.line_description.trim() : null,
      dimensions: l.dimensions ?? {},
    })
  }

  // Chart check: the RPC requires the account to exist (active or not); a
  // standard BAS account with no row is seeded at commit, anything else fails.
  const newAccounts = [...new Set(added.map((l) => l.account_number))]
  let wouldSeed: string[] = []
  if (newAccounts.length > 0) {
    const { data: chartRows, error: chartError } = await supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .in('account_number', newAccounts)
    if (chartError) {
      ctx.log.error('failed to read the chart for rättelse preview', new Error(chartError.message), { entryId })
      return { ok: false, code: 'JOURNAL_RATTELSE_FAILED' }
    }
    const inChart = new Set((chartRows ?? []).map((r) => r.account_number as string))
    const missing = newAccounts.filter((n) => !inChart.has(n))
    const unknown = missing.filter((n) => !getBASReference(n))
    if (unknown.length > 0) {
      return { ok: false, code: 'ACCOUNTS_NOT_IN_CHART', error: new AccountsNotInChartError(unknown) }
    }
    wouldSeed = missing
  }

  // Effective post-state: remaining lines plus the added ones.
  const struckSet = new Set(strikeIds)
  const remaining = lines.filter((l) => !struckSet.has(l.id)).map(toPreviewLine)
  const struck = struckRows.map(toPreviewLine)
  const resulting: PreviewLine[] = [...remaining, ...added]
  const totalDebit = sumSide(resulting, 'debit_amount')
  const totalCredit = sumSide(resulting, 'credit_amount')

  if (resulting.length < 2) {
    return refused(
      'Verifikationen måste ha minst två rader efter rättelsen. Använd "Återför (storno)" för att makulera hela verifikationen.',
    )
  }
  if (totalDebit !== totalCredit) {
    return { ok: false, code: 'JOURNAL_ENTRY_NOT_BALANCED', details: { total_debit: totalDebit, total_credit: totalCredit } }
  }
  if (totalDebit === 0) {
    return refused('Rättelsen skulle nollställa verifikationen. Använd "Återför (storno)" i stället.')
  }
  const struckKeys = struck.map(lineKey).sort()
  const addedKeys = added.map(lineKey).sort()
  if (struckKeys.length === addedKeys.length && struckKeys.every((k, i) => k === addedKeys[i])) {
    return { ok: false, code: 'MEANINGLESS_CORRECTION', error: new MeaninglessCorrectionError('identical_to_original') }
  }

  // Reconciliation anchors. A reskontra side (15xx under a customer payment,
  // 24xx under a supplier payment) must keep its net: refused here as the RPC
  // does. A bank side may only change to the exact linked bank amount, which
  // the RPC computes at commit; the preview flags it instead of guessing.
  const netDelta = new Map<string, number>()
  for (const l of struck) netDelta.set(l.account_number, (netDelta.get(l.account_number) ?? 0) - (l.debit_amount - l.credit_amount))
  for (const l of added) netDelta.set(l.account_number, (netDelta.get(l.account_number) ?? 0) + (l.debit_amount - l.credit_amount))
  const changedAccounts = [...netDelta.entries()].filter(([, d]) => Math.abs(roundOre(d)) >= 0.005).map(([acc]) => acc)

  const anchors = await loadAnchors(supabase, companyId, entry.id)
  for (const acc of changedAccounts) {
    if ((anchors.customerPayment && acc.startsWith('15')) || (anchors.supplierPayment && acc.startsWith('24'))) {
      return refused(
        `Raden mot konto ${acc} kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).`,
      )
    }
  }
  const bankAccountsChanged = anchors.bank
    ? changedAccounts.filter((acc) => acc.startsWith('19') || anchors.cashLedgerAccounts.includes(acc))
    : []

  const struckDebit = sumSide(struck, 'debit_amount')
  const addedDebit = sumSide(added, 'debit_amount')

  return {
    ok: true,
    dryRun: true,
    preview: {
      journal_entry_id: entry.id,
      voucher: voucherLabel(entry),
      entry_date: entry.entry_date,
      description: entry.description,
      struck_lines: struck,
      added_lines: added,
      resulting_lines: resulting,
      total_debit: totalDebit,
      total_credit: totalCredit,
      struck_total_debit: struckDebit,
      added_total_debit: addedDebit,
      // The amount this rättelse moves: the larger of what is struck and
      // what is added. Read by the unattended-commit ceiling.
      changed_amount_sek: Math.max(struckDebit, addedDebit),
      would_seed_accounts: wouldSeed,
      anchored_to: {
        bank_transaction: anchors.bank,
        customer_payment: anchors.customerPayment,
        supplier_payment: anchors.supplierPayment,
      },
      ...(bankAccountsChanged.length > 0
        ? {
            bank_anchor_check: {
              accounts: bankAccountsChanged,
              note: 'The verifikat is linked to a bank transaction: at commit the net on these accounts must equal the linked bank amount, or the rättelse is refused and storno is the path.',
            },
          }
        : {}),
      will: `strike ${struck.length} line(s) and add ${added.length} line(s) inside the same verifikat, logging the struck originals with who and when (BFL 5 kap 5 §); no new verifikat, no voucher number`,
    },
  }
}

async function loadAnchors(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<{ bank: boolean; customerPayment: boolean; supplierPayment: boolean; cashLedgerAccounts: string[] }> {
  const [tx, links, invoicePayments, supplierPayments] = await Promise.all([
    supabase.from('transactions').select('id').eq('company_id', companyId).eq('journal_entry_id', entryId).limit(1),
    supabase.from('transaction_voucher_links').select('id').eq('company_id', companyId).eq('journal_entry_id', entryId).limit(1),
    supabase.from('invoice_payments').select('id').eq('journal_entry_id', entryId).limit(1),
    supabase.from('supplier_invoice_payments').select('id').eq('journal_entry_id', entryId).limit(1),
  ])
  const bank = (tx.data ?? []).length > 0 || (links.data ?? []).length > 0
  let cashLedgerAccounts: string[] = []
  if (bank) {
    const { data } = await supabase.from('cash_accounts').select('ledger_account').eq('company_id', companyId)
    cashLedgerAccounts = (data ?? []).map((r) => r.ledger_account as string).filter(Boolean)
  }
  return {
    bank,
    customerPayment: (invoicePayments.data ?? []).length > 0,
    supplierPayment: (supplierPayments.data ?? []).length > 0,
    cashLedgerAccounts,
  }
}

// ---------------------------------------------------------------------------
// Redate: storno + re-post on a new date (the recordate flow)
// ---------------------------------------------------------------------------

export interface RedateInput {
  new_entry_date: string
  allow_deep_chain?: boolean
}

export interface RedateResult {
  reversal: JournalEntry
  corrected: JournalEntry
}

function bookkeepingFailure(err: unknown): Failure {
  const code = (err as { code?: unknown }).code
  return { ok: false, code: typeof code === 'string' ? code : 'BOOKKEEPING_DATABASE_ERROR', error: err }
}

export async function redateJournalEntry(
  ctx: OperationContext,
  entryId: string,
  input: RedateInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<RedateResult>> {
  if (options.dryRun) return previewRedate(ctx, entryId, input)
  try {
    const result = await recordateEntry(ctx.supabase, ctx.companyId, ctx.userId, entryId, input.new_entry_date, {
      allowDeepChain: input.allow_deep_chain,
    })
    return { ok: true, data: result }
  } catch (err) {
    if (!isBookkeepingError(err)) {
      ctx.log.error('recordate failed', err instanceof Error ? err : new Error(String(err)), { entryId })
    }
    return bookkeepingFailure(err)
  }
}

interface FullLineRow {
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  line_description: string | null
  currency: string | null
  amount_in_currency: number | string | null
  dimensions: Record<string, string> | null
  sort_order: number
}

async function previewRedate(
  ctx: OperationContext,
  entryId: string,
  input: RedateInput,
): Promise<OperationOutcome<RedateResult>> {
  const { supabase, companyId } = ctx
  const { data, error } = await supabase
    .from('journal_entries')
    .select(
      'id, status, entry_date, description, fiscal_period_id, voucher_series, voucher_number, correction_of_id, reverses_id, lines:journal_entry_lines(account_number, debit_amount, credit_amount, line_description, currency, amount_in_currency, dimensions, sort_order)',
    )
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !data) {
    if (error) ctx.log.error('failed to load journal entry for redate preview', new Error(error.message), { entryId })
    return bookkeepingFailure(new JournalEntryNotFoundError())
  }
  const original = data as PostedEntryRow & {
    correction_of_id: string | null
    reverses_id: string | null
    lines: FullLineRow[] | null
  }
  if (original.status !== 'posted') return bookkeepingFailure(new CannotCorrectNonPostedError(original.status))
  if (input.new_entry_date === original.entry_date) {
    return bookkeepingFailure(new MeaninglessCorrectionError('no_date_change'))
  }

  // Target: the same two-layer classification recordateEntry runs.
  const target = await resolvePeriodStatusForDate(supabase, companyId, input.new_entry_date)
  if (target.status === 'closed') return bookkeepingFailure(new TargetPeriodClosedError(input.new_entry_date))
  if (target.status === 'locked') {
    return bookkeepingFailure(new TargetPeriodLockedError(input.new_entry_date, target.lock_date))
  }
  if (!target.period_id) return bookkeepingFailure(new NoOpenPeriodForDateError(input.new_entry_date))

  // Source: the storno lands on the ORIGINAL date and period, so that period
  // must still be writable (the lock triggers would refuse it at commit).
  const sourceLock = await checkPeriodLock(supabase, companyId, original.entry_date)
  if (sourceLock.locked) {
    return {
      ok: false,
      code: 'PERIOD_LOCKED',
      details: {
        reason: sourceLock.reason,
        fiscal_period_id: sourceLock.fiscal_period_id ?? original.fiscal_period_id,
        entry_date: original.entry_date,
      },
    }
  }

  let chainDepth = 0
  if (!input.allow_deep_chain) {
    const chain = await correctionChainDepth(supabase, companyId, original)
    chainDepth = chain.depth
    if (chain.depth >= CORRECTION_CHAIN_GUARD_DEPTH) {
      return bookkeepingFailure(new CorrectionChainTooDeepError(chain.depth, chain.rootVoucher))
    }
  }

  const lines = (original.lines ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
  const unresolvable = await findUnresolvableAccounts(
    supabase,
    companyId,
    lines.map((l) => l.account_number),
  )
  if (unresolvable.length > 0) return bookkeepingFailure(new AccountsNotInChartError(unresolvable))

  const copied = lines.map((l) => ({
    account_number: l.account_number,
    debit_amount: roundOre(Number(l.debit_amount) || 0),
    credit_amount: roundOre(Number(l.credit_amount) || 0),
    line_description: l.line_description,
    currency: l.currency ?? 'SEK',
    dimensions: l.dimensions ?? {},
  }))
  const storno = copied.map((l) => ({
    ...l,
    debit_amount: l.credit_amount,
    credit_amount: l.debit_amount,
    line_description: `Storno: ${l.line_description ?? ''}`,
  }))
  const totalDebit = roundOre(copied.reduce((s, l) => s + l.debit_amount, 0))
  const series = original.voucher_series || 'A'

  return {
    ok: true,
    dryRun: true,
    preview: {
      journal_entry_id: original.id,
      voucher: voucherLabel(original),
      old_entry_date: original.entry_date,
      new_entry_date: input.new_entry_date,
      source_fiscal_period_id: original.fiscal_period_id,
      target_fiscal_period_id: target.period_id,
      voucher_series: series,
      // What the approval posts: the whole verifikat twice (storno and the
      // re-posted copy). Read by the unattended-commit ceiling.
      total_debit: totalDebit,
      chain_depth: chainDepth,
      storno: {
        entry_date: original.entry_date,
        fiscal_period_id: original.fiscal_period_id,
        description: `Storno: ${original.description}`,
        lines: storno,
      },
      corrected: {
        entry_date: input.new_entry_date,
        fiscal_period_id: target.period_id,
        description: `Rättelse: ${original.description}`,
        lines: copied,
      },
      will: `post a storno of ${voucherLabel(original) ?? 'the verifikat'} on ${original.entry_date} and a copy with the same lines on ${input.new_entry_date}, mark the original reversed and move its underlag and bank links to the copy (BFL 5 kap 5 §); two new voucher numbers in series ${series}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Rättelse log (read)
// ---------------------------------------------------------------------------

export interface RattelseLogRow extends Record<string, unknown> {
  id: string
  rattelse_type: string
  actor: string | null
  actor_label: string | null
}

/**
 * The entry's inline rättelse history, newest first, each row with the
 * actor's profile label. `profilesClient` reads profiles, whose RLS is
 * self-only: the dashboard hands a service-role factory, the v1/MCP doors
 * already run on one. Best-effort: a failed label lookup leaves labels null.
 */
export async function getJournalEntryRattelseLog(
  ctx: OperationContext,
  entryId: string,
  profilesClient: () => Pick<SupabaseClient, 'from'> = () => ctx.supabase,
): Promise<OperationOutcome<RattelseLogRow[]>> {
  // Ownership gate: 404 for entries outside the caller's company, so the
  // empty-log response cannot be used to probe entry existence cross-tenant.
  const { data: entry, error: entryError } = await ctx.supabase
    .from('journal_entries')
    .select('id')
    .eq('id', entryId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (entryError) return { ok: false, code: 'JOURNAL_RATTELSE_LOG_FAILED' }
  if (!entry) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }

  const { data, error } = await ctx.supabase
    .from('journal_entry_rattelse_log')
    .select('id, rattelse_type, old_description, new_description, old_entry_date, new_entry_date, struck_lines, added_lines, actor, created_at, source, external_signature')
    .eq('company_id', ctx.companyId)
    .eq('journal_entry_id', entryId)
    .order('created_at', { ascending: false })
  if (error) return { ok: false, code: 'JOURNAL_RATTELSE_LOG_FAILED' }

  const rows = (data ?? []) as ({ actor: string | null } & Record<string, unknown>)[]
  const actorIds = Array.from(new Set(rows.map((r) => r.actor).filter((a): a is string => !!a)))
  let labels = new Map<string, string>()
  if (actorIds.length > 0) {
    try {
      labels = await resolveUserLabelsFromProfiles(profilesClient(), actorIds)
    } catch {
      labels = new Map()
    }
  }
  return {
    ok: true,
    data: rows.map((row) => ({
      ...row,
      id: row.id as string,
      rattelse_type: row.rattelse_type as string,
      actor: row.actor,
      actor_label: row.actor ? (labels.get(row.actor) ?? null) : null,
    })),
  }
}

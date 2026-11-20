/**
 * Ingående balanser (IB) for a year that has no closed prior year in
 * Accounted: a company that moved from another system without an SIE file
 * types or uploads its balances once, and corrects them later if they were
 * wrong. One implementation behind the dashboard routes
 * (/api/import/opening-balance/execute and /correct) and the operations
 * opening-balances.set-manual and opening-balances.correct
 * (lib/operations/opening-balances.ts), so every door applies the same rules:
 *
 *   - the year must be the company's, open and unlocked, and its start must
 *     be after the company lock date (the IB verifikat is dated on it);
 *   - set: the year must not already have an IB (findExistingOpeningBalance:
 *     the year's pointer, or a posted IB verifikat booked without one);
 *     correct: it must have one, and no bokslut may be posted on top;
 *   - lines: zero rows dropped, at least two left, no resultatkonto (class
 *     3-8), debit equals credit. The API doors additionally refuse class 0
 *     and 9 (balance sheet accounts only, as the roll-forward does);
 *   - BAS accounts the chart lacks are activated first;
 *   - the IB verifikat is posted through the engine (source_type
 *     opening_balance, series A) and linked to the year.
 *
 * Every verifikat here goes through the posting port: while POSTING_EVENTS is
 * shadow or strict the IB records ledger.opening_balance and each storno
 * ledger.storno, subject the year (lib/import/import-business-events.ts);
 * with it off the engine gets exactly the calls it always got.
 *
 * A correction never edits the posted IB (BFL 5 kap 5 §, hard rule 1): the
 * corrected IB is booked first, the year is relinked to it with the
 * replace_period_opening_balance_link RPC, and only then is the old one
 * stornoed with reverseEntry. If the relink or the storno fails, the year is
 * pointed back at the old IB and the new IB is stornoed again, so the year
 * keeps its old IB, linked and live. Owner or admin only, as the relink RPC
 * requires: refused up front at every door. With cascade the per-account
 * delta is carried into every later year's IB
 * (lib/import/opening-balance/cascade.ts).
 *
 * A dry run reads, checks and previews the verifikat and writes nothing
 * (it is also the MCP staging preview): no account activation, no entry, no
 * voucher number.
 */
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { toEntryPreview } from '@/lib/bookkeeping/entry-preview'
import { isMissingRpcSignature } from '@/lib/bookkeeping/actor-rpc'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { postingPort } from '@/lib/posting/port'
import type { CreateJournalEntryInput } from '@/types'
import { openingBalanceBusinessEvent, openingBalanceStornoBusinessEvent } from '../import-business-events'
import {
  cascadeOpeningBalanceCorrection,
  computeAccountDeltas,
  fetchEntryOpeningBalanceLines,
  type CascadeResult,
} from './cascade'
import { findExistingOpeningBalance, linkOpeningBalance } from './existing'
import {
  activateMissingAccounts,
  buildOpeningBalanceEntryLines,
  findMissingAccounts,
  validateOpeningBalanceLines,
  type OpeningBalanceLine,
} from './execute-helpers'
import { isLockDateRefusal } from '@/lib/errors/get-structured-error'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export interface OpeningBalanceOptions {
  dryRun?: boolean
  /**
   * Refuse class 0 and 9 accounts as well as class 3-8. The API doors set
   * it: an IB holds balance sheet accounts (class 1-2) only. The dashboard's
   * file import predates the rule and keeps its class 3-8 check.
   */
  balanceSheetOnly?: boolean
}

export interface SetOpeningBalancesInput {
  fiscal_period_id: string
  lines: OpeningBalanceLine[]
  /** The verifikat text. Defaults to "Ingående balanser". */
  description?: string
}

export interface SetOpeningBalancesResult {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  fiscal_period_id: string
  entry_date: string
  lines_created: number
  total_debit: number
  total_credit: number
}

export interface CorrectOpeningBalancesInput {
  fiscal_period_id: string
  lines: OpeningBalanceLine[]
  /** Carry the per-account delta into every later year's IB. */
  cascade?: boolean
}

export interface CorrectOpeningBalancesResult {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  reversed_entry_id: string
  fiscal_period_id: string
  lines_created: number
  total_debit: number
  total_credit: number
  cascade?: CascadeResult
}

interface PeriodRow {
  id: string
  period_start: string
  is_closed: boolean
  locked_at: string | null
  opening_balances_set: boolean | null
  opening_balance_entry_id: string | null
  opening_balance_entry?: { voucher_series?: string | null; voucher_number?: number | null } | null
}

/** Line validation as a failure outcome, with the details the dashboard reads. */
function validateLines(
  lines: OpeningBalanceLine[],
  options: OpeningBalanceOptions,
): { ok: true; validLines: OpeningBalanceLine[]; totalDebit: number; totalCredit: number } | Failure {
  const validation = validateOpeningBalanceLines(lines)
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      details:
        validation.code === 'OB_PNL_ACCOUNT'
          ? { accounts: validation.accounts }
          : validation.code === 'OB_UNBALANCED'
            ? { totalDebit: validation.totalDebit, totalCredit: validation.totalCredit, diff: validation.diff }
            : undefined,
    }
  }
  if (options.balanceSheetOnly) {
    const outside = validation.validLines
      .map((l) => l.account_number)
      .filter((num) => num.charAt(0) !== '1' && num.charAt(0) !== '2')
    if (outside.length > 0) {
      return { ok: false, code: 'OB_NON_BALANCE_SHEET_ACCOUNT', details: { accounts: outside.slice(0, 5) } }
    }
  }
  return validation
}

async function readLockDate(ctx: OperationContext): Promise<string | null> {
  const { data: settings } = await ctx.supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  return (settings?.bookkeeping_locked_through as string | null | undefined) ?? null
}

const NOT_FOUND: Failure = { ok: false, code: 'OB_PERIOD_NOT_FOUND' }

const CORRECT_ADMIN_MESSAGE = 'Endast ägare eller administratörer kan rätta ingående balanser.'

// ---------------------------------------------------------------------------
// Set (first IB of a year)
// ---------------------------------------------------------------------------

export async function setOpeningBalances(
  ctx: OperationContext,
  input: SetOpeningBalancesInput,
  options: OpeningBalanceOptions = {},
): Promise<OperationOutcome<SetOpeningBalancesResult>> {
  const { supabase, companyId, userId, log } = ctx
  const { fiscal_period_id } = input

  try {
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('id, period_start, is_closed, locked_at, opening_balances_set, opening_balance_entry_id')
      .eq('id', fiscal_period_id)
      .eq('company_id', companyId)
      .single()
    if (periodError || !period) return NOT_FOUND
    const row = period as PeriodRow

    if (row.is_closed) return { ok: false, code: 'OB_PERIOD_CLOSED' }
    if (row.locked_at) return { ok: false, code: 'OB_PERIOD_LOCKED' }
    // One IB per year, asked the way every IB writer asks it: the pointer
    // alone missed an IB booked as a voucher (no pointer), and this posted a
    // second one on top. A failed read throws into the catch below and
    // refuses (OB_EXECUTE_FAILED), never posts.
    const existing = await findExistingOpeningBalance(supabase, companyId, fiscal_period_id)
    if (existing) {
      return {
        ok: false,
        code: 'OB_PERIOD_ALREADY_HAS_BALANCES',
        details: { existingEntryId: existing.journal_entry_id },
      }
    }

    // The IB is dated on the year's first day: behind the company lock date
    // the enforce_company_lock_date trigger would refuse it with a generic
    // error, so say so up front (and in the dry run).
    const lockDate = await readLockDate(ctx)
    if (lockDate && row.period_start <= lockDate) {
      return { ok: false, code: 'OB_SET_COMPANY_LOCK_DATE', details: { lockDate, entryDate: row.period_start } }
    }

    const validation = validateLines(input.lines, options)
    if (!validation.ok) return validation
    const { validLines, totalDebit, totalCredit } = validation

    const accountNumbers = [...new Set(validLines.map((l) => l.account_number))]
    const entryInput: CreateJournalEntryInput = {
      fiscal_period_id,
      entry_date: row.period_start,
      description: input.description ?? 'Ingående balanser',
      source_type: 'opening_balance',
      voucher_series: 'A',
      lines: buildOpeningBalanceEntryLines(validLines),
    }

    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          fiscal_period_id,
          entry_date: row.period_start,
          total_debit: totalDebit,
          total_credit: totalCredit,
          accounts_to_activate: await findMissingAccounts(supabase, companyId, accountNumbers),
          journal_entry: toEntryPreview(entryInput),
        },
      }
    }

    const activation = await activateMissingAccounts(supabase, companyId, userId, accountNumbers)
    if (!activation.ok) {
      log.error('opening balance account activation failed', new Error(activation.reason))
      return { ok: false, code: 'OB_ACCOUNT_ACTIVATION_FAILED', details: { reason: activation.reason } }
    }

    const entry = await postingPort.postJournalEntry({
      supabase,
      companyId,
      userId,
      // Built only while the port is on: off, createJournalEntry gets the call it always did.
      event: () => openingBalanceBusinessEvent(fiscal_period_id, row.period_start, linkBasisColumns('user_created')),
      input: entryInput,
    })

    const linkError = await linkOpeningBalance(supabase, companyId, fiscal_period_id, entry.id)
    if (linkError) {
      // The IB is posted; only the year's pointer to it is missing. Loud,
      // because a year without the link cannot be corrected through
      // correctOpeningBalances (a second IB is still refused: the posted
      // entry itself counts).
      log.error('audit: opening balance posted but the period link failed', {
        audit: true,
        event: 'opening_balance.link_failed',
        companyId,
        fiscalPeriodId: fiscal_period_id,
        entryId: entry.id,
        reason: linkError.message,
      })
    }

    return {
      ok: true,
      created: true,
      data: {
        journal_entry_id: entry.id,
        voucher_series: entry.voucher_series ?? null,
        voucher_number: entry.voucher_number ?? null,
        fiscal_period_id,
        entry_date: row.period_start,
        lines_created: entryInput.lines.length,
        total_debit: totalDebit,
        total_credit: totalCredit,
      },
    }
  } catch (err) {
    // Bookkeeping errors keep their own envelope; everything else becomes
    // OB_EXECUTE_FAILED so the user gets a Swedish message.
    if (isBookkeepingError(err)) return { ok: false, code: 'OB_EXECUTE_FAILED', error: err }
    log.error('opening balance execute failed', err as Error)
    return {
      ok: false,
      code: 'OB_EXECUTE_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}

// ---------------------------------------------------------------------------
// Correct (storno + corrected IB + relink)
// ---------------------------------------------------------------------------

export async function correctOpeningBalances(
  ctx: OperationContext,
  input: CorrectOpeningBalancesInput,
  options: OpeningBalanceOptions = {},
): Promise<OperationOutcome<CorrectOpeningBalancesResult>> {
  const { supabase, companyId, userId, log } = ctx
  const { fiscal_period_id, cascade } = input

  try {
    // The embedded opening_balance_entry gives the original IB's voucher
    // label so the corrected entry can reference it (BFL 5 kap 5 §).
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select(
        'id, period_start, is_closed, locked_at, opening_balances_set, opening_balance_entry_id, opening_balance_entry:journal_entries!opening_balance_entry_id(voucher_series, voucher_number)',
      )
      .eq('id', fiscal_period_id)
      .eq('company_id', companyId)
      .single()
    if (periodError || !period) return NOT_FOUND
    const row = period as unknown as PeriodRow

    // Owner or admin only: the relink RPC refuses anyone else, and by then the
    // corrected IB is already booked. Asked here, before any write and on a
    // dry run too, so a member's v1 key, MCP stage or dashboard session is
    // refused with nothing booked, and an MCP approval checks the approver.
    const denied = await requireCompanyAdmin(ctx, CORRECT_ADMIN_MESSAGE)
    if (denied) return denied

    if (row.is_closed) return { ok: false, code: 'OB_PERIOD_CLOSED' }
    if (row.locked_at) return { ok: false, code: 'OB_PERIOD_LOCKED' }

    // The lock-date trigger blocks both the corrected IB and the storno of
    // the old one (each dated period_start) with a retryable-looking generic
    // error that invited blind retries: an actionable 409 instead.
    const lockDate = await readLockDate(ctx)
    if (lockDate && row.period_start <= lockDate) {
      return { ok: false, code: 'OB_COMPANY_LOCK_DATE', details: { lockDate, entryDate: row.period_start } }
    }

    if (!row.opening_balances_set || !row.opening_balance_entry_id) {
      return { ok: false, code: 'OB_CORRECT_NO_EXISTING' }
    }

    // A bokslut on top would leave the year (and the next year's carried IB)
    // inconsistent: it must be unwound first.
    const { count: yearEndCount } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscal_period_id)
      .eq('source_type', 'year_end')
      .eq('status', 'posted')
    if ((yearEndCount ?? 0) > 0) return { ok: false, code: 'OB_CORRECT_YEAR_END_EXISTS' }

    const oldEntryId = row.opening_balance_entry_id

    const validation = validateLines(input.lines, options)
    if (!validation.ok) return validation
    const { validLines, totalDebit, totalCredit } = validation

    const accountNumbers = [...new Set(validLines.map((l) => l.account_number))]
    const originalRef = row.opening_balance_entry
    const originalVoucherLabel =
      originalRef?.voucher_series && originalRef?.voucher_number
        ? formatVoucher(originalRef)
        : null
    // The description reference IS the linkage to the rättade verifikat:
    // CreateJournalEntryInput has no correction-linkage field for an IB.
    const entryInput: CreateJournalEntryInput = {
      fiscal_period_id,
      entry_date: row.period_start,
      description: originalVoucherLabel
        ? `Ingående balanser (korrigerade, rättelse av ${originalVoucherLabel})`
        : 'Ingående balanser (korrigerade)',
      source_type: 'opening_balance',
      voucher_series: 'A',
      lines: buildOpeningBalanceEntryLines(validLines),
    }

    if (options.dryRun) {
      const originalLines = await fetchEntryOpeningBalanceLines(supabase, companyId, oldEntryId)
      const deltas = computeAccountDeltas(originalLines, validLines)
      return {
        ok: true,
        dryRun: true,
        preview: {
          fiscal_period_id,
          method: 'storno',
          reverses_journal_entry_id: oldEntryId,
          reverses_voucher: originalVoucherLabel,
          total_debit: totalDebit,
          total_credit: totalCredit,
          account_changes: [...deltas.entries()].map(([account_number, delta]) => ({ account_number, delta })),
          cascade: cascade === true,
          accounts_to_activate: await findMissingAccounts(supabase, companyId, accountNumbers),
          journal_entry: toEntryPreview(entryInput),
        },
      }
    }

    const activation = await activateMissingAccounts(supabase, companyId, userId, accountNumbers)
    if (!activation.ok) {
      log.error('opening balance account activation failed', new Error(activation.reason))
      return { ok: false, code: 'OB_ACCOUNT_ACTIVATION_FAILED', details: { reason: activation.reason } }
    }

    // The cascade needs the ORIGINAL lines for the per-account delta, so
    // read them before the old entry is stornoed.
    const originalLines = cascade
      ? await fetchEntryOpeningBalanceLines(supabase, companyId, oldEntryId)
      : null

    // Book the corrected IB first, so a failure midway never leaves the year
    // without an IB.
    const newEntry = await postingPort.postJournalEntry({
      supabase,
      companyId,
      userId,
      event: () => openingBalanceBusinessEvent(fiscal_period_id, row.period_start, linkBasisColumns('user_created')),
      input: entryInput,
    })

    // Durable audit trail for a failed correction: the structured logger,
    // tagged audit, with both entry ids so an operator can reconcile by hand.
    const auditCorrectionFailure = (fields: Record<string, unknown>) => {
      log.error('audit: opening balance correction failed', {
        audit: true,
        event: 'opening_balance.correction_failed',
        companyId,
        userId,
        fiscalPeriodId: fiscal_period_id,
        newEntryId: newEntry.id,
        oldEntryId,
        ...fields,
      })
    }

    // The year's pointer, moved by the RPC (a plain UPDATE is refused by
    // enforce_opening_balance_immutability). p_user_id is the user this door
    // authenticated: the RPC honors it only from the service role (the v1 and
    // MCP doors, where auth.uid() is NULL) and checks that user is an owner or
    // admin. Until the migration that adds it is applied, the old signature
    // answers PGRST202: retried once without it (lib/bookkeeping/actor-rpc.ts
    // handles the same deploy window).
    const relinkYear = async (entryId: string) => {
      const args = { p_company_id: companyId, p_period_id: fiscal_period_id, p_new_entry_id: entryId }
      let answer = await supabase.rpc('replace_period_opening_balance_link', { ...args, p_user_id: userId })
      if (isMissingRpcSignature(answer.error)) answer = await supabase.rpc('replace_period_opening_balance_link', args)
      if (answer.error) throw new Error(`replace_period_opening_balance_link failed: ${answer.error.message}`)
    }

    // The relink and the storno are not atomic with the new IB, so the order
    // keeps the year with one live, linked IB at every failure point: relink
    // first, while the old IB is still posted, then storno the old IB (the
    // year no longer names it, so reverseEntry leaves the pointer alone). On
    // a failure the year is pointed back at the old IB and the NEW entry is
    // stornoed, so the year keeps its original IB and no second live one.
    let relinked = false
    try {
      await relinkYear(newEntry.id)
      relinked = true
      // The storno of the old IB is the person's correction (user_created).
      await postingPort.reverseJournalEntry({
        supabase,
        companyId,
        userId,
        entryId: oldEntryId,
        event: () => openingBalanceStornoBusinessEvent(fiscal_period_id, todayIsoStockholm(), linkBasisColumns('user_created')),
        role: 'reversal',
      })
    } catch (seqErr) {
      const reason = seqErr instanceof Error ? seqErr.message : 'unknown'
      auditCorrectionFailure({ phase: 'sequence_failed', reason, relinked })
      if (relinked) {
        // Back to the old IB before the new one is stornoed: a storno of the
        // IB the year names clears the year's pointer (reverseEntry). If this
        // fails the storno below still runs, so the books keep one live IB
        // (the old one, unlinked); the audit ids let an operator relink it.
        try {
          await relinkYear(oldEntryId)
        } catch (relinkBackErr) {
          auditCorrectionFailure({
            phase: 'relink_back_failed',
            reason,
            relinkBackError: relinkBackErr instanceof Error ? relinkBackErr.message : 'unknown',
          })
        }
      }
      try {
        // The compensation: no one chose this storno (system_derived).
        await postingPort.reverseJournalEntry({
          supabase,
          companyId,
          userId,
          entryId: newEntry.id,
          event: () => openingBalanceStornoBusinessEvent(fiscal_period_id, todayIsoStockholm(), linkBasisColumns('system_derived')),
          role: 'reversal',
        })
        auditCorrectionFailure({ phase: 'compensated', reason })
      } catch (compErr) {
        auditCorrectionFailure({
          phase: 'compensation_failed',
          reason,
          compensationError: compErr instanceof Error ? compErr.message : 'unknown',
        })
      }
      return {
        ok: false,
        code: 'OB_CORRECT_FAILED',
        details: { reason: getUserErrorMessage(seqErr), newEntryId: newEntry.id, oldEntryId },
      }
    }

    // The base correction is committed. The cascade is best-effort on top:
    // each later year is corrected independently and a failure there never
    // turns the request into an error.
    let cascadeResult: CascadeResult | null = null
    if (cascade && originalLines) {
      try {
        cascadeResult = await cascadeOpeningBalanceCorrection(supabase, companyId, userId, {
          basePeriodStart: row.period_start,
          deltas: computeAccountDeltas(originalLines, validLines),
          lockDate,
          log,
        })
      } catch (cascadeErr) {
        log.error('opening balance cascade failed', cascadeErr as Error)
        cascadeResult = { corrected: [], skipped: [], failed: true }
      }
    }

    return {
      ok: true,
      created: true,
      data: {
        journal_entry_id: newEntry.id,
        voucher_series: newEntry.voucher_series ?? null,
        voucher_number: newEntry.voucher_number ?? null,
        reversed_entry_id: oldEntryId,
        fiscal_period_id,
        lines_created: validLines.length,
        total_debit: totalDebit,
        total_credit: totalCredit,
        ...(cascadeResult ? { cascade: cascadeResult } : {}),
      },
    }
  } catch (err) {
    // The lock date moved between the pre-flight and the write: the same
    // actionable code instead of a generic retryable database error.
    if (isLockDateRefusal(err)) {
      return { ok: false, code: 'OB_COMPANY_LOCK_DATE', details: { reason: getUserErrorMessage(err) } }
    }
    if (isBookkeepingError(err)) return { ok: false, code: 'OB_CORRECT_FAILED', error: err }
    log.error('opening balance correct failed', err as Error)
    return {
      ok: false,
      code: 'OB_CORRECT_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}

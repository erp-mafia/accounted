import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { validatePeriodDuration } from '@/lib/bookkeeping/validate-period-duration'
import { fiscalYearName, nextFiscalYearRange, type FiscalYearRange } from '@/lib/bookkeeping/suggest-fiscal-period'
import { addDaysIso, hasEnded, todayIsoStockholm } from '@/lib/dates/iso'
import { countUnbookedBankTransactions } from '@/lib/transactions/unbooked'
import { assertNoUnfinishedSieImport, sieHoldRefusal } from './sie-import-hold'
import { codedRefusal } from '@/lib/errors/refusal'
import { userFacing } from '@/lib/errors/user-facing'
import type { FiscalPeriod } from '@/types'

const log = createLogger('period-service')

/**
 * The two ways a bank transaction can still owe the period a verifikation.
 *
 * Triage is the act of answering "is this an affärshändelse for the company?".
 * The three answers, and what each means for a period lock:
 *
 *   is_business IS NULL, is_ignored = false -> NOT TRIAGED. Nobody has looked
 *       at it. Counted as `untriaged`; blocks.
 *   is_business = true                      -> TRIAGED AS A BUSINESS EVENT. It
 *       owes a verifikation. Blocks unless it already has one (see below);
 *       counted as `businessUnbooked` when it does not.
 *   is_business = false                     -> TRIAGED AND EXCLUDED (privat
 *       uttag / not the company's affär). Never blocks: there is nothing to
 *       bokföra, and holding a lock hostage to a private coffee is over-
 *       blocking, not compliance.
 *   is_ignored = true                       -> TRIAGED AND EXCLUDED, the user's
 *       explicit "hide this, never going to book it" (migration
 *       20260529190000). Never blocks. The column is NOT NULL DEFAULT false,
 *       so `.eq('is_ignored', false)` cannot silently drop rows.
 *
 * "Already has a verifikation" is deliberately NOT `journal_entry_id IS NOT
 * NULL`. That column only covers the 1:1 case; bulk-booked (N tx -> 1 JE, via
 * transaction_voucher_links) and multi-allocated (invoice_payments /
 * supplier_invoice_payments) transactions stay NULL while being anchored to a
 * real verifikat. public.open_bank_rows holds all three, so the guard does not
 * block on already-booked rows.
 */
export interface UnbookedInPeriod {
  /** Never triaged: is_business IS NULL AND is_ignored = false. */
  untriaged: number
  /** Triaged as a business event but anchored to no verifikat at all. */
  businessUnbooked: number
}

/**
 * Count the bank transactions in [periodStart, periodEnd] that a period lock
 * would strand. Throws on any query failure so the caller can fail closed:
 * never return 0 for a check that did not actually run. The predicate lives in
 * lib/transactions/unbooked.ts, shared with the VAT close check, the
 * attention resource and the report data_status, so all of them agree.
 */
export async function countUnbookedInPeriod(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<UnbookedInPeriod> {
  const counts = await countUnbookedBankTransactions(supabase, companyId, {
    fromDate: periodStart,
    toDate: periodEnd,
  })
  return { untriaged: counts.untriaged, businessUnbooked: counts.business_unbooked }
}

/**
 * The company's earliest fiscal_periods.period_start (ISO date), or null when
 * no fiscal period exists yet (brand-new company before onboarding created
 * one). This is the company's "bookkeeping starts here" boundary: external
 * mirrors (e.g. the skattekonto sync) use it as a lower fetch bound, and
 * booking flows use it to tell "row predates the first rakenskapsar" apart
 * from an ordinary locked period.
 */
export async function getEarliestFiscalPeriodStart(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('company_id', companyId)
    .order('period_start', { ascending: true })
    .limit(1)

  if (error || !data || data.length === 0) return null
  const start = (data[0] as { period_start?: unknown }).period_start
  return typeof start === 'string' ? start : null
}

/**
 * Lock a fiscal period: prevents new journal entries from being posted.
 * Requires: period exists, belongs to company, not already locked/closed.
 */
export async function lockPeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<FiscalPeriod> {

  // Fetch period
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw codedRefusal('PERIOD_NOT_FOUND', 'Fiscal period not found')
  }

  if (period.is_closed) {
    throw codedRefusal('PERIOD_ALREADY_CLOSED', 'Period is already closed')
  }

  if (period.locked_at) {
    throw codedRefusal('PERIOD_LOCK_ALREADY_LOCKED', 'Period is already locked')
  }

  assertNoUnfinishedSieImport(period, 'lock')

  // Refuse to lock while the period still holds bank transactions that would be
  // stranded. BFL 5 kap 2 § requires every affärshändelse to be bokförd in the
  // period it belongs to; once locked_at is set the enforce_period_lock trigger
  // makes these rows unbookable in place, leaving affärshändelser that can only
  // be entered by unlocking again or via a rättelse.
  //
  // Hard block, not an advisory warning with a bypass. There is no legitimate
  // "lock anyway" case: locking is a voluntary internal control with no legal
  // deadline, while the affärshändelser it would strand do have one (BFL 5 kap
  // 2 §: kontant senast nästa arbetsdag, övrigt "så snart det kan ske").
  // Every escape hatch the user could want is already an exit from the
  // predicate and is named in the message: book it, mark it privat, or mark it
  // ignored. Locking first and unlocking later is strictly worse, because the
  // unlock lands in the immutable audit_log as a control override.
  let unbooked: UnbookedInPeriod
  try {
    unbooked = await countUnbookedInPeriod(
      supabase,
      companyId,
      period.period_start,
      period.period_end,
    )
  } catch (err) {
    // Fail closed. A guard that cannot run must not wave the lock through:
    // that is exactly how the previous dead predicate went unnoticed.
    log.error('unbooked-transaction guard failed, refusing to lock', {
      companyId,
      fiscalPeriodId,
      reason: err instanceof Error ? err.message : String(err),
    })
    throw new Error(
      'Kunde inte kontrollera obokförda banktransaktioner i perioden. Perioden lämnas olåst. Försök igen.'
    )
  }

  const blockingCount = unbooked.untriaged + unbooked.businessUnbooked
  if (blockingCount > 0) {
    // Coded, so every door answers PERIOD_HAS_UNBOOKED_TRANSACTIONS with this
    // sentence. The infra failure above carries no code on purpose: an
    // unreachable database must not send an agent off booking transactions.
    const breakdown = [
      unbooked.untriaged > 0 ? `${unbooked.untriaged} ej hanterade` : null,
      unbooked.businessUnbooked > 0
        ? `${unbooked.businessUnbooked} markerade som affärshändelse men utan verifikat`
        : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw userFacing(
      new Error(
        `Kan inte låsa period: ${blockingCount} banktransaktion(er) i perioden saknar bokföring ` +
          `(${breakdown}). Alla affärstransaktioner måste vara bokförda innan perioden låses. ` +
          `Gå till Transaktioner, bokför dem eller markera dem som privata eller ignorerade, och lås perioden därefter.`
      ),
      'PERIOD_HAS_UNBOOKED_TRANSACTIONS',
    )
  }

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({ locked_at: new Date().toISOString() })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError || !updated) {
    throw (
      sieHoldRefusal(updateError, period.name, 'lock') ??
      new Error(`Failed to lock period: ${updateError?.message}`)
    )
  }

  const result = updated as FiscalPeriod

  await eventBus.emit({
    type: 'period.locked',
    payload: { period: result, companyId, userId },
  })

  return result
}

/**
 * Unlock a fiscal period: clears `locked_at` so new entries can be posted.
 * Requires: period exists, belongs to company, is currently locked, not closed.
 */
export async function unlockPeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<FiscalPeriod> {
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw codedRefusal('PERIOD_NOT_FOUND', 'Fiscal period not found')
  }

  if (period.is_closed) {
    throw codedRefusal('PERIOD_UNLOCK_CLOSED', 'Cannot unlock a closed period')
  }

  if (!period.locked_at) {
    throw codedRefusal('PERIOD_UNLOCK_NOT_LOCKED', 'Period is not locked')
  }

  const priorLockedAt = period.locked_at

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({ locked_at: null })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to unlock period: ${updateError?.message}`)
  }

  const result = updated as FiscalPeriod

  // BFNAR 2013:2 p. 9.16 (behandlingshistorik): unlocking a locked period is a
  // sensitive control change. Persist it to the immutable audit_log (not just
  // event_log, which has 30-day TTL) so an auditor can reconstruct who
  // unlocked which period and when, even years later.
  await supabase.from('audit_log').insert({
    user_id: userId,
    company_id: companyId,
    action: 'UPDATE',
    table_name: 'fiscal_periods',
    record_id: fiscalPeriodId,
    description: `Period unlocked: ${result.name} (${result.period_start} to ${result.period_end})`,
    old_state: { locked_at: priorLockedAt },
    new_state: { locked_at: null },
  })

  await eventBus.emit({
    type: 'period.unlocked',
    payload: { period: result, companyId, userId },
  })

  return result
}

/**
 * Close a fiscal period: marks it as permanently closed.
 * Requires: period is locked AND closing_entry_id is set (year-end must run first).
 */
export async function closePeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<FiscalPeriod> {

  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw codedRefusal('PERIOD_NOT_FOUND', 'Fiscal period not found')
  }

  if (period.is_closed) {
    throw codedRefusal('PERIOD_ALREADY_CLOSED', 'Period is already closed')
  }

  if (!period.locked_at) {
    throw codedRefusal('PERIOD_NOT_LOCKED', 'Period must be locked before closing')
  }

  if (!period.closing_entry_id) {
    throw codedRefusal('YEAR_END_NOT_RUN', 'Year-end closing must be executed before closing the period')
  }

  assertNoUnfinishedSieImport(period, 'close')

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({
      is_closed: true,
      closed_at: new Date().toISOString(),
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError || !updated) {
    throw (
      sieHoldRefusal(updateError, period.name, 'close') ??
      new Error(`Failed to close period: ${updateError?.message}`)
    )
  }

  return updated as FiscalPeriod
}

/** Max journal_entry ids per `.in()` filter: keeps the request URL short. */
const RESULT_LINE_CHECK_CHUNK_SIZE = 100

interface PeriodLedgerShape {
  /** Number of journal entries dated inside the period, any source_type. */
  entryCount: number
  /** Whether any of their lines sits on a result account (BAS class 3-8). */
  hasResultLines: boolean
}

/**
 * How much bookkeeping the period holds and whether any of it sits on a
 * result account (BAS class 3-8), i.e. whether a bokslutsverifikat would
 * have anything to transfer. An existence check, not a fetch: entries are
 * read id-only, and lines are head-counted per id chunk with early exit, so
 * a natively bookkept year answers on its first chunk. Two-step by design;
 * see lib/bookkeeping/entry-lines.ts for why the `journal_entries!inner`
 * embed is avoided. Throws on any query error so the caller fails closed.
 */
async function inspectPeriodLedger(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<PeriodLedgerShape> {
  const entries = await fetchAllRows<{ id: string }>(
    ({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id')
        .eq('company_id', companyId)
        .gte('entry_date', periodStart)
        .lte('entry_date', periodEnd)
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (e) => e.id },
  )
  for (let i = 0; i < entries.length; i += RESULT_LINE_CHECK_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + RESULT_LINE_CHECK_CHUNK_SIZE).map((e) => e.id)
    const { count, error } = await supabase
      .from('journal_entry_lines')
      .select('id', { count: 'exact', head: true })
      .in('journal_entry_id', chunk)
      // Account numbers are strings, so these are text comparisons on the
      // BAS class digit: classes 3-8 sort at or above '3' and below '9';
      // classes 1-2 (balance sheet) sort below '3', class 9 (interna
      // poster, never transferred by a bokslut) at or above '9'.
      .gte('account_number', '3')
      .lt('account_number', '9')
    if (error) throw error
    if ((count ?? 0) > 0) return { entryCount: entries.length, hasResultLines: true }
  }
  return { entryCount: entries.length, hasResultLines: false }
}

/**
 * Every refusal markPeriodClosedExternally applies before it writes, run
 * against an already fetched period. Read-only, so the klarmarkera operation's
 * dry run (the MCP staging preview) answers exactly what the commit will.
 * Throws the same messages markPeriodClosedExternally always has.
 */
export async function assertPeriodExternallyClosable(
  supabase: SupabaseClient,
  companyId: string,
  period: FiscalPeriod
): Promise<void> {
  const fiscalPeriodId = period.id

  if (period.is_closed) {
    throw codedRefusal('FISCAL_PERIOD_CLOSE_EXTERNAL_ALREADY_CLOSED', 'Period is already closed')
  }

  if (period.closing_entry_id) {
    throw codedRefusal(
      'FISCAL_PERIOD_CLOSE_EXTERNAL_HAS_CLOSING_ENTRY',
      'Period has a closing entry in Accounted: use the normal year-end close instead',
    )
  }

  assertNoUnfinishedSieImport(period, 'mark_closed')

  if (!hasEnded(period.period_end, todayIsoStockholm())) {
    throw codedRefusal('FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED', 'Cannot mark a period that has not ended yet as closed')
  }

  // Klarmarkera exists for MIGRATED years. A period bookkept natively in
  // Accounted must go through the real year-end: closing it without a
  // bokslutsverifikat leaves 3xxx-8xxx untransferred and the next year
  // without IB (BFL 5-6 kap), with no clean way back once locked.
  // "Migrated" is read from the ledger itself. The period passes when it
  // contains SIE-imported verifikat (source_type='import'), or when it holds
  // no verifikat at all (year closed elsewhere, never imported here), or
  // when its native verifikat touch balance-sheet accounts only AND the
  // next period already carries its IB. That third leg is the migrated
  // first year whose SIE import failed and whose owner re-keyed the opening
  // voucher (1930/2081 aktiekapital) by hand: nothing for a bokslut to
  // transfer, the balances already continue into the next year, and the
  // normal year-end refuses on exactly that IB (NEXT_PERIOD_HAS_IB). Until
  // this leg existed the year could not be closed by any path. A native
  // balance-sheet-only year whose next period lacks IB stays refused: there
  // the normal year-end works and is what carries the balances forward.
  const { count: importedCount, error: importedError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('source_type', 'import')
    .gte('entry_date', period.period_start)
    .lte('entry_date', period.period_end)
  if (importedError) {
    throw userFacing(new Error('Kunde inte kontrollera periodens verifikat. Försök igen.'), 'FISCAL_PERIOD_CLOSE_EXTERNAL_CHECK_FAILED')
  }
  if ((importedCount ?? 0) === 0) {
    let ledger: PeriodLedgerShape
    try {
      ledger = await inspectPeriodLedger(
        supabase,
        companyId,
        period.period_start,
        period.period_end,
      )
    } catch {
      throw userFacing(new Error('Kunde inte kontrollera periodens verifikat. Försök igen.'), 'FISCAL_PERIOD_CLOSE_EXTERNAL_CHECK_FAILED')
    }
    if (ledger.hasResultLines) {
      throw userFacing(
        new Error(
          'Perioden innehåller resultatkonton (3000-8999) bokförda i Accounted och inga importerade verifikat. Använd det vanliga årsbokslutet i stället, så att årets resultat förs över.'
        ),
        'FISCAL_PERIOD_CLOSE_EXTERNAL_NATIVE_BOOKKEEPING',
      )
    }
    if (ledger.entryCount > 0) {
      const nextPeriod = await findNextPeriod(supabase, companyId, fiscalPeriodId)
      if (!nextPeriod?.opening_balance_entry_id) {
        throw userFacing(
          new Error(
            'Perioden innehåller bokföring skapad i Accounted och nästa räkenskapsår saknar ingående balanser. Använd det vanliga årsbokslutet i stället, så förs balanserna över.'
          ),
          'FISCAL_PERIOD_CLOSE_EXTERNAL_NATIVE_BOOKKEEPING',
        )
      }
    }
  }

  // Same stranding guard as lockPeriod: closing makes unbooked
  // affärshändelser in the period unbookable in place. Fail closed if the
  // guard cannot run.
  let unbooked: UnbookedInPeriod
  try {
    unbooked = await countUnbookedInPeriod(
      supabase,
      companyId,
      period.period_start,
      period.period_end,
    )
  } catch (err) {
    log.error('unbooked-transaction guard failed, refusing to close externally', {
      companyId,
      fiscalPeriodId,
      reason: err instanceof Error ? err.message : String(err),
    })
    throw userFacing(
      new Error('Kunde inte kontrollera obokförda banktransaktioner i perioden. Perioden lämnas öppen. Försök igen.'),
      'FISCAL_PERIOD_CLOSE_EXTERNAL_CHECK_FAILED',
    )
  }

  const blockingCount = unbooked.untriaged + unbooked.businessUnbooked
  if (blockingCount > 0) {
    const breakdown = [
      unbooked.untriaged > 0 ? `${unbooked.untriaged} ej hanterade` : null,
      unbooked.businessUnbooked > 0
        ? `${unbooked.businessUnbooked} markerade som affärshändelse men utan verifikat`
        : null,
    ]
      .filter(Boolean)
      .join(', ')
    throw userFacing(
      new Error(
        `Kan inte klarmarkera period: ${blockingCount} banktransaktion(er) i perioden saknar bokföring ` +
          `(${breakdown}). Alla affärstransaktioner måste vara bokförda innan perioden stängs. ` +
          `Gå till Transaktioner, bokför dem eller markera dem som privata eller ignorerade, och klarmarkera därefter.`
      ),
      'PERIOD_HAS_UNBOOKED_TRANSACTIONS',
    )
  }
}

/**
 * Mark a fiscal period as closed in a previous bookkeeping system
 * ("klarmarkera"). Imported historical years (SIE) arrive with
 * is_closed = false and no closing entry, so the year-end page lists them as
 * pending bokslut even though the bokslut was already done in the old
 * software.
 *
 * Deliberately bypasses closePeriod's locked_at/closing_entry_id
 * preconditions: the closing entry lives in the previous system. Everything
 * else stays strict:
 * - the period must have ended (a running year cannot be done elsewhere)
 * - a period with its own closing entry goes through the normal close
 * - already-closed periods are refused
 * - the same unbooked-bank-transactions guard as lockPeriod applies, because
 *   closing strands them exactly the way locking would (BFL 5 kap 2 §)
 *
 * Sets locked_at too (when missing) so the period carries the full
 * closed+locked state the enforcement triggers and readers expect, and writes
 * the immutable audit_log entry (BFNAR 2013:2 p. 9.16: this is a control
 * decision made by a person, not a year-end run).
 */
export async function markPeriodClosedExternally(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<FiscalPeriod> {
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw codedRefusal('PERIOD_NOT_FOUND', 'Fiscal period not found')
  }

  await assertPeriodExternallyClosable(supabase, companyId, period as FiscalPeriod)

  const now = new Date().toISOString()
  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({
      is_closed: true,
      closed_at: now,
      closed_externally: true,
      locked_at: period.locked_at ?? now,
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    // TOCTOU guard: a concurrent normal close between the fetch above and
    // this update must not be overwritten with closed_externally=true (and a
    // clobbered closed_at). The predicate makes that race a 0-row update,
    // which .single() surfaces as an error.
    .eq('is_closed', false)
    .select()
    .single()

  if (updateError || !updated) {
    throw (
      sieHoldRefusal(updateError, period.name, 'mark_closed') ??
      new Error(`Failed to mark period as externally closed: ${updateError?.message}`)
    )
  }

  const result = updated as FiscalPeriod

  await supabase.from('audit_log').insert({
    user_id: userId,
    company_id: companyId,
    action: 'UPDATE',
    table_name: 'fiscal_periods',
    record_id: fiscalPeriodId,
    description: `Period marked as closed in previous system: ${result.name} (${result.period_start} to ${result.period_end})`,
    old_state: { is_closed: false, closed_at: null, locked_at: period.locked_at },
    new_state: {
      is_closed: true,
      closed_at: result.closed_at,
      closed_externally: true,
      locked_at: result.locked_at,
    },
  })

  return result
}

/**
 * Undo "klarmarkera": reopen a period that markPeriodClosedExternally closed.
 *
 * The close was a person's control decision, not a year-end run, so undoing
 * it is the same kind of decision. It is allowed only while the closed state
 * still comes from klarmarkera: closed_externally is set and no closing entry
 * exists in Accounted. A period closed by closePeriod keeps its
 * bokslutsverifikat and is not reopened here. Clears locked_at as well: the
 * reason to reopen is to change the period's contents (replace a wrong
 * prior-year SIE import, add missing bokslutsdispositioner), and the user can
 * klarmarkera or lock again afterwards. Written to the immutable audit_log
 * (BFNAR 2013:2 kap. 8).
 *
 * Observed need 2026-08-27: an owner klarmarkerade five imported years, then
 * found the prior-year SIE file was wrong; replace was refused on the closed
 * year and unlock refused the closed state, with no way back.
 */
export async function reopenExternallyClosedPeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<FiscalPeriod> {
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    throw codedRefusal('PERIOD_NOT_FOUND', 'Fiscal period not found')
  }

  if (!period.is_closed) {
    throw codedRefusal('PERIOD_REOPEN_NOT_CLOSED', 'Period is not closed')
  }

  if (!period.closed_externally || period.closing_entry_id) {
    throw codedRefusal(
      'PERIOD_REOPEN_NOT_EXTERNAL',
      'Period was closed with a year-end run in Accounted and cannot be reopened here',
    )
  }

  const { data: updated, error: updateError } = await supabase
    .from('fiscal_periods')
    .update({
      is_closed: false,
      closed_at: null,
      closed_externally: false,
      locked_at: null,
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    // TOCTOU guard, mirror of markPeriodClosedExternally: only the klarmarkera
    // state is reversible, so a concurrent normal close (closing entry set)
    // makes this a 0-row update, which .single() surfaces as an error.
    .eq('is_closed', true)
    .eq('closed_externally', true)
    .is('closing_entry_id', null)
    .select()
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to reopen period: ${updateError?.message}`)
  }

  const result = updated as FiscalPeriod

  await supabase.from('audit_log').insert({
    user_id: userId,
    company_id: companyId,
    action: 'UPDATE',
    table_name: 'fiscal_periods',
    record_id: fiscalPeriodId,
    description: `Period reopened, previous-system close undone: ${result.name} (${result.period_start} to ${result.period_end})`,
    old_state: {
      is_closed: true,
      closed_at: period.closed_at,
      closed_externally: true,
      locked_at: period.locked_at,
    },
    new_state: {
      is_closed: false,
      closed_at: null,
      closed_externally: false,
      locked_at: null,
    },
  })

  // The lock is gone too, so downstream listeners see the same transition as
  // a plain unlock.
  await eventBus.emit({
    type: 'period.unlocked',
    payload: { period: result, companyId, userId },
  })

  return result
}

/**
 * Create the next fiscal period following the current one: the year
 * nextFiscalYearRange chains from it, with previous_period_id set for chain
 * validation.
 */
export async function createNextPeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  currentPeriodId: string
): Promise<FiscalPeriod> {

  const { data: current, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', currentPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !current) {
    throw codedRefusal('PERIOD_NOT_FOUND', 'Current fiscal period not found')
  }

  return insertFiscalYearAfter(supabase, companyId, userId, currentPeriodId, nextFiscalYearRange(current.period_end))
}

/** The earliest recorded year overlapping a range: what stops a year from being created there. */
export async function fiscalYearInTheWay(
  supabase: SupabaseClient,
  companyId: string,
  { start, end }: FiscalYearRange,
): Promise<{ period_start: string } | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('company_id', companyId)
    .lte('period_start', end)
    .gte('period_end', start)
    .order('period_start')
    .limit(1)
  if (error) throw new Error(`Failed to read fiscal periods: ${error.message}`)
  return (data as { period_start: string }[] | null)?.[0] ?? null
}

/**
 * Insert a räkenskapsår chained to the year before it (null for a company's
 * only year), which the doors that create a year on their own account share:
 * the year-end's next year and the bank door's missing ones. The fiscal_periods
 * triggers keep the law (BFL 3 kap.), also for a form bound to the calendar
 * year. Throws when the year cannot be created.
 */
export async function insertFiscalYearAfter(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  previousPeriodId: string | null,
  { start, end }: { start: string; end: string },
): Promise<FiscalPeriod> {
  // Validate period duration: subsequent periods always start on 1st of month
  const durationError = validatePeriodDuration(start, end, { isFirstPeriod: false })
  if (durationError) {
    throw new Error(durationError)
  }

  if (await fiscalYearInTheWay(supabase, companyId, { start, end })) {
    throw new Error('Next fiscal period already exists or overlaps with an existing period')
  }

  // Same Swedish name as every other door that creates a year ("Räkenskapsår
  // 2025", "Räkenskapsår 2024/2025"): the name prints in the årsredovisning's
  // header and flerårsöversikt.
  const name = fiscalYearName(start, end)

  const { data: newPeriod, error: insertError } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: companyId,
      user_id: userId,
      name,
      period_start: start,
      period_end: end,
      previous_period_id: previousPeriodId,
    })
    .select()
    .single()

  if (insertError || !newPeriod) {
    throw new Error(`Failed to create next period: ${insertError?.message}`)
  }

  // Heal the chain across the gap this period fills: the year starting the
  // day after it now follows it, whatever it was linked to before
  // (findNextPeriod explains how such links arise). The new period's own row
  // cannot match: it does not start the day after itself. Best-effort: the
  // period is created either way, and findNextPeriod no longer trusts a
  // non-adjacent link.
  const { data: mischained } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_start', addDaysIso(end, 1))
  if (mischained && mischained.length > 0) {
    const successorIds = mischained.map((row: { id: string }) => row.id)
    const { error: relinkError } = await supabase
      .from('fiscal_periods')
      .update({ previous_period_id: newPeriod.id })
      .in('id', successorIds)
      .eq('company_id', companyId)
    if (relinkError) {
      log.error('failed to relink successor onto the newly created period', relinkError, {
        companyId,
        newPeriodId: newPeriod.id,
        successorIds,
      })
    }
  }

  return newPeriod as FiscalPeriod
}

/**
 * Look up the next fiscal period after the given one without creating it.
 *
 * Used by year-end closing to handle the common case where the next period
 * was already created (e.g. by SIE import, manual creation, or a previous
 * partial year-end run). Returns null when no such period exists.
 *
 * Matches first on previous_period_id chain, then falls back to a
 * period_start = (current.period_end + 1 day) lookup so periods created
 * before the chain was wired up are still recognised.
 */
export async function findNextPeriod(
  supabase: SupabaseClient,
  companyId: string,
  currentPeriodId: string
): Promise<FiscalPeriod | null> {
  const { data: current, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', currentPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !current) {
    return null
  }

  const { data: chained } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .eq('previous_period_id', currentPeriodId)
    .maybeSingle()

  // UTC-only arithmetic: anchor the date string at UTC midnight, then
  // advance via setUTCDate. Using Date(string) + setDate/getDate causes an
  // off-by-one on servers in TZ+ when the day after period_end crosses a
  // DST spring-forward, because setDate(local) writes local-time fields
  // and toISOString() converts back through the shifted offset.
  const expectedStartStr = addDaysIso(current.period_end, 1)

  // The chain is only trusted when it is date-adjacent. SIE import used to
  // point previous_period_id at the NEAREST later period regardless of the
  // gap (40 such rows on prod as of 2026-08-24), and year-end then seeded a
  // whole missing year's opening balances into a period two years out
  // because this returned the chained row unchecked (feedback seq 249297).
  // A non-adjacent link means the true next period is missing or unlinked:
  // fall through to the date lookup and let the caller create it.
  if (chained) {
    const chainedPeriod = chained as FiscalPeriod
    if (chainedPeriod.period_start === expectedStartStr) {
      return chainedPeriod
    }
    log.warn('fiscal period chain is not date-adjacent: ignoring previous_period_id link', {
      companyId,
      currentPeriodId,
      chainedPeriodId: chainedPeriod.id,
      expectedStart: expectedStartStr,
      chainedStart: chainedPeriod.period_start,
    })
  }

  const { data: byDate } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .eq('period_start', expectedStartStr)
    .maybeSingle()

  return (byDate as FiscalPeriod | null) ?? null
}

/** What resolvePreviousFiscalPeriod needs of the period it looks back from. */
export interface PreviousPeriodAnchor {
  period_start: string
  previous_period_id?: string | null
}

/**
 * The räkenskapsår immediately before `current`, out of rows the caller
 * already holds: the period ending the day before `current` starts. The
 * previous_period_id link picks it when the link is date-adjacent; a link to
 * anything else is ignored, like findNextPeriod ignores one. Null when no
 * period ends that day: an earlier year across a gap is never the previous
 * year, because its UB is not this year's IB (IB = föregående års UB, ÅRL 2
 * kap. 4 § p. 7: .claude/skills/swedish-sie-import-export, and kontinuitet in
 * swedish-accounting-compliance references/bfl-bfnar.md).
 */
export function pickPreviousFiscalPeriod<P extends { id: string; period_end: string }>(
  current: PreviousPeriodAnchor,
  periods: readonly P[],
): P | null {
  const expectedEnd = addDaysIso(current.period_start, -1)
  if (current.previous_period_id) {
    const linked = periods.find((period) => period.id === current.previous_period_id)
    if (linked && linked.period_end === expectedEnd) return linked
  }
  return periods.find((period) => period.period_end === expectedEnd) ?? null
}

/**
 * pickPreviousFiscalPeriod against the database: the linked period when it
 * ends the day before `current` starts, else the company's period ending that
 * day, else null. `columns` must include id and period_end. Throws on a failed
 * read: a comparison year that silently disappears looks like a first year.
 */
export async function resolvePreviousFiscalPeriod<P extends { id: string; period_end: string }>(
  supabase: SupabaseClient,
  companyId: string,
  current: PreviousPeriodAnchor,
  columns: string,
): Promise<P | null> {
  const expectedEnd = addDaysIso(current.period_start, -1)
  if (current.previous_period_id) {
    const { data: linked, error } = await supabase
      .from('fiscal_periods')
      .select(columns)
      .eq('id', current.previous_period_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(`Failed to read the previous fiscal year: ${error.message}`)
    const row = linked as unknown as P | null
    if (row && row.period_end === expectedEnd) return row
  }
  const { data: byDate, error } = await supabase
    .from('fiscal_periods')
    .select(columns)
    .eq('company_id', companyId)
    .eq('period_end', expectedEnd)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to read the previous fiscal year: ${error.message}`)
  return (byDate as unknown as P | null) ?? null
}

export {
  resolvePeriodStatusForDate,
  resolvePeriodLockForDate,
  type PeriodStatusValue,
  type PeriodStatusForDate,
  type PeriodLockLayer,
} from './period-status'

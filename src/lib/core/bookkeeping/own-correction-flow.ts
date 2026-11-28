/**
 * A verifikat a register names, and when its rättelse goes through that
 * register's own flow instead of the generic one (correctEntry: a storno and
 * a corrected verifikat).
 *
 * Three registers name a verifikat by a pointer the database never moves:
 *
 *   - the year's opening balance (fiscal_periods.opening_balance_entry_id,
 *     source_type 'opening_balance'), which the year reads as its ingående
 *     balans;
 *   - a booked salary run (salary_runs.salary_entry_id, avgifter_entry_id,
 *     vacation_entry_id, pension_entry_id; the verifikat's source_id names the
 *     run, source_type 'salary_payment'), whose löneberäkning is the
 *     verifikat's underlag;
 *   - a planenlig avskrivning in the asset register
 *     (depreciation_schedules.journal_entry_id, source_type 'year_end'), the
 *     sidoordnad register of BFL 5 kap 4 §.
 *
 * A generic rättelse reverses the verifikat and books a correction the
 * register does not name, so the register keeps reading the struck one. Each
 * register's own flow keeps it in step, and the generic rättelse is refused
 * only while that flow can make the correction:
 *
 *   - Korrigera ingående balanser (lib/import/opening-balance/service.ts and
 *     the correct-inline route): refused in a closed or locked year, when the
 *     year's first day is on or before the company lock date, and once a
 *     year_end verifikat (a bokslut) is posted in the year;
 *   - Korrigera lönekörning (lib/salary/correct-run.ts): reverses every
 *     verifikat of the run on its own date with reverseEntry, so it cannot act
 *     while one of them is behind a lock;
 *   - the asset register: reverseEntry releases the register row of a
 *     reversed avskrivning (lib/bookkeeping/engine.ts) and the year's
 *     avskrivning is booked again from the register, both in the open year.
 *
 * Where the flow cannot act, the generic rättelse stays the way: above all a
 * verifikat whose own date takes no write (its year closed or locked, or the
 * date on or before the company lock date), whose storno and corrected
 * verifikat correctEntry dates in the first open period instead (`moved`). An
 * opening balance and a year_end verifikat never move (DATE_FIXED_SOURCE_TYPES):
 * assertStornoTarget refuses them there before this is asked.
 *
 * Reads only for those three source types; every other verifikat passes with
 * no read. The registers are read by table, as voucher-owner.ts reads them, so
 * the ledger imports no block.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BookkeepingDatabaseError,
  DepreciationCorrectionOwnFlowError,
  OpeningBalanceCorrectionOwnFlowError,
  SalaryRunCorrectionOwnFlowError,
} from '@/lib/bookkeeping/errors'
import { resolvePeriodLocksForDates, resolvePeriodStatusForDate } from './period-status'

/** Every read here fails as one operation: the register could not be read. */
const LOAD = 'load_correction_register'

/** The verifikat being corrected, as correctEntry and the correction doors read it. */
export interface OwnFlowOriginal {
  id: string
  entry_date: string
  source_type?: string | null
  source_id?: string | null
}

/**
 * Throws the register's refusal when the verifikat is one a register names
 * and that register's own flow can correct it now; returns otherwise.
 * `target` is where the storno lands (assertStornoTarget): moved, no
 * register's flow can act. A failed read throws BookkeepingDatabaseError:
 * unknown is never let through.
 */
export async function assertNoOwnCorrectionFlow(
  supabase: SupabaseClient,
  companyId: string,
  original: OwnFlowOriginal,
  target: { moved: boolean },
): Promise<void> {
  if (target.moved) return
  switch (original.source_type) {
    case 'opening_balance':
      return refuseOpeningBalance(supabase, companyId, original)
    case 'salary_payment':
      return refuseSalaryRun(supabase, companyId, original)
    case 'year_end':
      return refuseDepreciation(supabase, companyId, original)
    default:
      return
  }
}

/** The verifikat the year names as its opening balance, while Korrigera ingående balanser can correct it. */
async function refuseOpeningBalance(
  supabase: SupabaseClient,
  companyId: string,
  original: OwnFlowOriginal,
): Promise<void> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, opening_balances_set')
    .eq('company_id', companyId)
    .eq('opening_balance_entry_id', original.id)
    .limit(1)
    .maybeSingle()
  if (error) throw new BookkeepingDatabaseError(LOAD, error.message, error.code)
  const year = data as { id: string; period_start: string; opening_balances_set: boolean | null } | null
  // No year names it (an IB booked without the pointer, or one replaced):
  // Korrigera ingående balanser corrects the IB the year names, not this one.
  if (!year?.opening_balances_set) return

  // A bokslut posted in the year: Korrigera ingående balanser refuses until it is reversed.
  const { count, error: closingError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', year.id)
    .eq('source_type', 'year_end')
    .eq('status', 'posted')
  if (closingError) throw new BookkeepingDatabaseError(LOAD, closingError.message, closingError.code)
  if ((count ?? 0) > 0) return

  // The flow books on the year's first day. The verifikat's own date is open
  // (not moved); the first day is asked only when it is another day.
  if (year.period_start !== original.entry_date) {
    const firstDay = await resolvePeriodStatusForDate(supabase, companyId, year.period_start)
    if (firstDay.lookup_failed) throw new BookkeepingDatabaseError(LOAD, 'the lock of the year could not be read')
    if (firstDay.status !== 'open') return
  }
  throw new OpeningBalanceCorrectionOwnFlowError(year.id)
}

interface BookedRunRow {
  id: string
  status: string
  salary_entry_id: string | null
  avgifter_entry_id: string | null
  vacation_entry_id: string | null
  pension_entry_id: string | null
}

/**
 * A verifikat of a booked salary run, while Korrigera lönekörning can reverse
 * the run. The run is the one the verifikat's source_id names, and only when
 * it is booked and one of its pointers names the verifikat, as the run's
 * reversal hook reads it (lib/salary/run-verifikat-reversal.ts).
 */
async function refuseSalaryRun(
  supabase: SupabaseClient,
  companyId: string,
  original: OwnFlowOriginal,
): Promise<void> {
  if (!original.source_id) return
  const { data, error } = await supabase
    .from('salary_runs')
    .select('id, status, salary_entry_id, avgifter_entry_id, vacation_entry_id, pension_entry_id')
    .eq('company_id', companyId)
    .eq('id', original.source_id)
    .maybeSingle()
  if (error) throw new BookkeepingDatabaseError(LOAD, error.message, error.code)
  const run = data as BookedRunRow | null
  if (!run || run.status !== 'booked') return
  const runEntryIds = [run.salary_entry_id, run.avgifter_entry_id, run.vacation_entry_id, run.pension_entry_id].filter(
    (id): id is string => !!id,
  )
  if (!runEntryIds.includes(original.id)) return

  // Korrigera lönekörning reverses each posted verifikat of the run on its own
  // date: one behind a lock stops it. The run books them all on its payment
  // date, so normally there is no other date to ask.
  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('id, entry_date, status')
    .eq('company_id', companyId)
    .in('id', runEntryIds)
  if (entriesError) throw new BookkeepingDatabaseError(LOAD, entriesError.message, entriesError.code)
  const otherDates = ((entries ?? []) as Array<{ entry_date: string; status: string }>)
    .filter((entry) => entry.status === 'posted' && entry.entry_date !== original.entry_date)
    .map((entry) => entry.entry_date)
  if (otherDates.length > 0) {
    const verdicts = await resolvePeriodLocksForDates(supabase, companyId, otherDates)
    for (const { status } of verdicts.values()) {
      if (status.lookup_failed) throw new BookkeepingDatabaseError(LOAD, 'the lock of a run verifikat could not be read')
      if (status.status !== 'open') return
    }
  }
  throw new SalaryRunCorrectionOwnFlowError(run.id)
}

/** A planenlig avskrivning the asset register names: its year is open here, so Återför and a new booking from the register can act. */
async function refuseDepreciation(
  supabase: SupabaseClient,
  companyId: string,
  original: OwnFlowOriginal,
): Promise<void> {
  const { data, error } = await supabase
    .from('depreciation_schedules')
    .select('asset_id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', original.id)
    .limit(1)
    .maybeSingle()
  if (error) throw new BookkeepingDatabaseError(LOAD, error.message, error.code)
  const row = data as { asset_id: string } | null
  if (row) throw new DepreciationCorrectionOwnFlowError(row.asset_id)
}

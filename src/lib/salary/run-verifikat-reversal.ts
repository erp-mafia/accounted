/**
 * A storno of a booked salary run's verifikat (source_type salary_payment),
 * refused on its own.
 *
 * reverseEntry() (lib/bookkeeping/engine.ts) runs the check through the
 * reversal hook list (lib/composition/reversal-hooks.ts) before anything is
 * written. A booked run is corrected with Korrigera lönekörning
 * (correct-run.ts): it reverses every verifikat of the run together, marks
 * the run corrected and creates the correction run for the period. A storno
 * of one verifikat alone would leave the run booked, its payslips and AGI
 * standing, against pay the ledger no longer holds. The correction's own
 * stornos pass the salaryRunCorrection option and are let through by the
 * hook list.
 *
 * The run is the one the verifikat's source_id names (every run verifikat
 * carries the run id, salary-entries.ts), and only when the run is booked and
 * points at the verifikat: a voucher of an interrupted booking (the run still
 * paid) is reversed as the booking asks (SalaryRunPartiallyBookedError), and
 * the semesterår and semesterlöneskuld verifikat that share the source type
 * name no run.
 *
 * Kept free of engine imports so the engine can reach it through the
 * composition seam without a cycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { BookedSalaryRunStornoError } from '@/lib/bookkeeping/errors'

interface RunRow {
  id: string
  status: string
  salary_entry_id: string | null
  avgifter_entry_id: string | null
  vacation_entry_id: string | null
  pension_entry_id: string | null
}

/** Throws BookedSalaryRunStornoError when the verifikat is one of a booked run's. */
export async function assertSalaryRunVerifikatReversible(
  supabase: SupabaseClient,
  companyId: string,
  entry: { id: string; source_id?: string | null },
): Promise<void> {
  if (!entry.source_id) return
  const { data, error } = await supabase
    .from('salary_runs')
    .select('id, status, salary_entry_id, avgifter_entry_id, vacation_entry_id, pension_entry_id')
    .eq('company_id', companyId)
    .eq('id', entry.source_id)
    .maybeSingle()
  if (error) throw new Error(`salary run verifikat: run lookup failed: ${error.message}`)
  const run = data as RunRow | null
  if (!run || run.status !== 'booked') return
  const runEntries = [run.salary_entry_id, run.avgifter_entry_id, run.vacation_entry_id, run.pension_entry_id]
  if (runEntries.includes(entry.id)) throw new BookedSalaryRunStornoError(run.id)
}

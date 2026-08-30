/**
 * Shared draft-run header update: payment_date / voucher_series / notes.
 *
 * Single source of truth for the MCP staging tool (gnubok_update_salary_run)
 * and its commit executor. Mirrors the v1 PATCH semantics
 * (app/api/v1/companies/[companyId]/salary-runs/[id]): draft-only, with the
 * update optimistic-locked on status='draft' so a concurrent :calculate that
 * advances the run between pre-flight and write yields a clean
 * SALARY_RUN_PATCH_NOT_DRAFT instead of a silently-accepted update. The field
 * set is exactly what the v1 PATCH accepts; this module must not grow fields
 * the v1 surface does not have.
 *
 * payment_date is the date the booking entries will carry
 * (lib/salary/salary-entries.ts), which is why it freezes past draft.
 *
 * Result-object convention mirrors lib/salary/run-employees.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'

export type UpdateRunResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

/** The v1-PATCH-supported draft fields. Nothing else is updatable here. */
export interface SalaryRunHeaderPatch {
  payment_date?: string
  voucher_series?: string
  notes?: string | null
}

export interface SalaryRunHeaderValues {
  payment_date: string
  voucher_series: string
  notes: string | null
}

export interface UpdateSalaryRunData {
  salary_run_id: string
  period_year: number
  period_month: number
  status: string
  previous: SalaryRunHeaderValues
  /** Effective values after the patch (merged for dry-run, read back after a write). */
  payment_date: string
  voucher_series: string
  notes: string | null
  changes: SalaryRunHeaderPatch
}

const VOUCHER_SERIES_RE = /^[A-Z]$/
const NOTES_MAX = 2000

/** Same field rules as the v1 UpdateSalaryRunSchema (Zod). */
function validatePatch(patch: SalaryRunHeaderPatch): UpdateRunResult<SalaryRunHeaderPatch> {
  const changes: SalaryRunHeaderPatch = {}
  if (patch.payment_date !== undefined) {
    if (typeof patch.payment_date !== 'string' || !ISO_DATE_RE.test(patch.payment_date)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'payment_date', message: 'Expected YYYY-MM-DD date format' },
      }
    }
    changes.payment_date = patch.payment_date
  }
  if (patch.voucher_series !== undefined) {
    if (typeof patch.voucher_series !== 'string' || !VOUCHER_SERIES_RE.test(patch.voucher_series)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'voucher_series', message: 'Verifikationsserie måste vara en bokstav A-Z' },
      }
    }
    changes.voucher_series = patch.voucher_series
  }
  if (patch.notes !== undefined) {
    if (patch.notes !== null && (typeof patch.notes !== 'string' || patch.notes.length > NOTES_MAX)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'notes', message: `Max ${NOTES_MAX} tecken` },
      }
    }
    changes.notes = patch.notes
  }
  if (Object.keys(changes).length === 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: 'At least one of payment_date, voucher_series, notes is required' },
    }
  }
  return { ok: true, data: changes }
}

export async function updateDraftSalaryRun(
  supabase: SupabaseClient,
  args: {
    companyId: string
    salaryRunId: string
    patch: SalaryRunHeaderPatch
    /** Validate + resolve only; return the would-be merged row without writing. */
    dryRun?: boolean
  },
): Promise<UpdateRunResult<UpdateSalaryRunData>> {
  const validated = validatePatch(args.patch)
  if (!validated.ok) return validated
  const changes = validated.data

  const { data: run, error } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month, payment_date, voucher_series, notes')
    .eq('id', args.salaryRunId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  if (!run) {
    return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  }

  const row = run as {
    id: string
    status: string
    period_year: number
    period_month: number
    payment_date: string
    voucher_series: string
    notes: string | null
  }

  if (row.status !== 'draft') {
    return {
      ok: false,
      code: 'SALARY_RUN_PATCH_NOT_DRAFT',
      details: { current_status: row.status },
    }
  }

  // Kontantprincipen guard (SFL 26 kap): the AGI derives its
  // redovisningsperiod from period_year/period_month while the verifikat
  // books on payment_date. A payment date outside the run's period month
  // would post the entries in one month and declare them in another, so it
  // is refused; a payment truly landing in another month belongs to a run
  // for that period. Grandfather clause: creation does not (yet) enforce
  // this coupling, so a run whose CURRENT payment date already sits outside
  // the period month may still be day-adjusted within that same month
  // (otherwise a legal create state would be uncorrectable). No move can
  // introduce a NEW wrong month.
  if (changes.payment_date !== undefined) {
    const periodPrefix = `${row.period_year}-${String(row.period_month).padStart(2, '0')}`
    const newMonth = changes.payment_date.slice(0, 7)
    const currentMonth = row.payment_date.slice(0, 7)
    if (newMonth !== periodPrefix && newMonth !== currentMonth) {
      return {
        ok: false,
        code: 'SALARY_RUN_PAYMENT_DATE_OUTSIDE_PERIOD',
        details: { period: periodPrefix, payment_date: changes.payment_date },
      }
    }
  }

  const previous: SalaryRunHeaderValues = {
    payment_date: row.payment_date,
    voucher_series: row.voucher_series,
    notes: row.notes,
  }

  if (args.dryRun) {
    return {
      ok: true,
      data: {
        salary_run_id: row.id,
        period_year: row.period_year,
        period_month: row.period_month,
        status: row.status,
        previous,
        payment_date: changes.payment_date ?? previous.payment_date,
        voucher_series: changes.voucher_series ?? previous.voucher_series,
        notes: changes.notes !== undefined ? changes.notes : previous.notes,
        changes,
      },
    }
  }

  // Optimistic lock on status='draft': a concurrent :calculate flipping the
  // run to review between the read above and this write must fail the write,
  // not let a frozen field slip through (same guard as the v1 PATCH).
  const { data: updated, error: updError } = await supabase
    .from('salary_runs')
    .update(changes)
    .eq('id', args.salaryRunId)
    .eq('company_id', args.companyId)
    .eq('status', 'draft')
    .select('id, status, period_year, period_month, payment_date, voucher_series, notes')
    .maybeSingle()

  if (updError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: updError.message } }
  }
  if (!updated) {
    return {
      ok: false,
      code: 'SALARY_RUN_PATCH_NOT_DRAFT',
      details: { reason: 'race' },
    }
  }

  // A supplied payment_date invalidates any existing calculation:
  // skatteavdrag follows the payment date, so clearing calculation_breakdown
  // makes both book preflights refuse the roster until a recalculation has
  // run against the new date (same invariant as setRunEmployeeSalary in
  // lib/salary/run-employees.ts). Unlike the display-line refresh there,
  // this clear IS the compliance guard, so a failure surfaces as an error.
  // Gated on SUPPLIED, not on changed: after a partial failure (header
  // committed, clear failed) a retry re-reads the run and sees the new date
  // as current, so a changed-only gate would skip the clear forever and
  // leave a stale calculation bookable. Clearing on an equal date merely
  // forces a redundant recalculation, which is the safe direction.
  if (changes.payment_date !== undefined) {
    const { error: clearError } = await supabase
      .from('salary_run_employees')
      .update({ calculation_breakdown: null })
      .eq('salary_run_id', args.salaryRunId)
      .eq('company_id', args.companyId)
    if (clearError) {
      return { ok: false, code: 'INTERNAL_ERROR', details: { message: clearError.message } }
    }
  }

  const after = updated as typeof row
  return {
    ok: true,
    data: {
      salary_run_id: after.id,
      period_year: after.period_year,
      period_month: after.period_month,
      status: after.status,
      previous,
      payment_date: after.payment_date,
      voucher_series: after.voucher_series,
      notes: after.notes,
      changes,
    },
  }
}

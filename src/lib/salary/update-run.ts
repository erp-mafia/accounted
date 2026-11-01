/**
 * Shared draft-run header update: payment_date / voucher_series / notes.
 *
 * Single source of truth for both PATCH routes (the dashboard's
 * app/api/salary/runs/[id] and v1's app/api/v1/companies/[companyId]/
 * salary-runs/[id]), the MCP staging tool (gnubok_update_salary_run) and its
 * commit executor: draft-only, with the
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
import { invalidateRunCalculation } from './invalidate-calculation'

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
  /**
   * The run row in the caller's `columns` (merged with the patch for a dry
   * run, read back after a write), for a door that answers with the row.
   */
  row: Record<string, unknown>
}

const HEADER_COLUMNS = 'id, status, period_year, period_month, payment_date, voucher_series, notes'

function selectColumns(columns: string | undefined): string {
  if (!columns) return HEADER_COLUMNS
  return columns === '*' ? '*' : `${HEADER_COLUMNS}, ${columns}`
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
        details: {
          field: 'payment_date',
          message: 'Expected YYYY-MM-DD date format',
          message_sv: 'Ogiltigt datum (ÅÅÅÅ-MM-DD)',
        },
      }
    }
    changes.payment_date = patch.payment_date
  }
  if (patch.voucher_series !== undefined) {
    if (typeof patch.voucher_series !== 'string' || !VOUCHER_SERIES_RE.test(patch.voucher_series)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: {
          field: 'voucher_series',
          message: 'Verifikationsserie måste vara en bokstav A-Z',
          message_sv: 'Verifikationsserie måste vara en bokstav A-Z',
        },
      }
    }
    changes.voucher_series = patch.voucher_series
  }
  if (patch.notes !== undefined) {
    if (patch.notes !== null && (typeof patch.notes !== 'string' || patch.notes.length > NOTES_MAX)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: {
          field: 'notes',
          message: `Max ${NOTES_MAX} tecken`,
          message_sv: `Anteckningen får vara högst ${NOTES_MAX} tecken`,
        },
      }
    }
    changes.notes = patch.notes
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
    /** Extra salary_runs columns for `row` ('*' for all). */
    columns?: string
  },
): Promise<UpdateRunResult<UpdateSalaryRunData>> {
  const validated = validatePatch(args.patch)
  if (!validated.ok) return validated
  const changes = validated.data

  const { data: run, error } = await supabase
    .from('salary_runs')
    .select(selectColumns(args.columns))
    .eq('id', args.salaryRunId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  }
  if (!run) {
    return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  }

  const row = run as unknown as {
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

  // The payment date may leave the run's period month (lön i efterskott):
  // the AGI redovisningsperiod follows payment_date (kontantprincipen,
  // lib/salary/agi/reporting-period.ts), so the verifikat and the
  // declaration always land in the same month. The former in-period guard
  // (#2191) existed only because the AGI used to be keyed by period_*.

  const previous: SalaryRunHeaderValues = {
    payment_date: row.payment_date,
    voucher_series: row.voucher_series,
    notes: row.notes,
  }

  // Nothing to change (an empty PATCH): the run as it is, nothing written.
  // The v1 PATCH has always answered this way; the MCP tool refuses to stage
  // an empty patch before it gets here.
  if (args.dryRun || Object.keys(changes).length === 0) {
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
        row: { ...(run as unknown as Record<string, unknown>), ...changes },
      },
    }
  }

  // A supplied payment_date invalidates any existing calculation: skatteavdrag
  // follows the payment date, so a recalculation must run against the new
  // date before approval and booking accept the roster. Gated on SUPPLIED,
  // not on changed: clearing on an equal date merely forces a redundant
  // recalculation, which is the safe direction.
  if (changes.payment_date !== undefined) {
    const invalidated = await invalidateRunCalculation(supabase, args.companyId, { salaryRunId: args.salaryRunId })
    if (invalidated) return invalidated
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
    .select(selectColumns(args.columns))
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

  const after = updated as unknown as typeof row
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
      row: updated as unknown as Record<string, unknown>,
    },
  }
}

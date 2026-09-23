/**
 * Shared employee benefit (förmån) commands.
 *
 * Single source of truth for reading and writing employee_benefits rows,
 * consumed by the internal dashboard routes
 * (app/api/salary/employees/[id]/benefits) and the v1 REST routes
 * (app/api/v1/companies/[companyId]/employees/[id]/benefits), so the two
 * doors cannot drift on validation.
 *
 * A row is a standing monthly förmånsvärde. The calculation engine
 * (lib/salary/run-calculation.ts, step 8d) reads the active rows whose
 * validity window covers the run's payment_date and derives one taxable,
 * avgift-bearing payslip line per row; salary_line_items.source_benefit_id
 * is the provenance link back to the row.
 *
 * The bike benefit is the only type with server-side math: the caller sends
 * the annual market value and the row stores the derived monthly value plus
 * the calculation inputs in metadata (Skatteverket schablon, 3 000 kr/year
 * tax-free). Every other type, bilförmån included, is stored as the schablon
 * value the caller supplies.
 *
 * Deletion is a hard delete only while nothing derives from the row, and the
 * schema holds that, not this module: source_benefit_id is a NO ACTION
 * foreign key (migration 20260920190100), so once a payslip line references
 * the benefit Postgres refuses the delete (23503). A hard delete would sever
 * the chain from a possibly booked verifikat back to its förmån (BFL 5 kap
 * 6-7 §, #2695), so a referenced row is kept and switched off
 * (is_active=false) instead, the same outcome the recurring-lines register
 * gets from its NO ACTION key. The module still counts referencing lines
 * first, but only as a pre-check for a database that has not run that
 * migration yet; a line derived after the count is caught by the key (#2801).
 * Closing the window (valid_to) remains the clean way to stop a benefit that a
 * run has already consumed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  BENEFIT_PERIOD_ORDER_MESSAGE,
  EmployeeBenefitTypeSchema,
  type CreateEmployeeBenefitSchema,
  type UpdateEmployeeBenefitSchema,
} from '@/lib/api/schemas'
import { calculateBikeBenefit } from '@/lib/salary/benefits'

export type EmployeeBenefitResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

export type EmployeeBenefitType = z.infer<typeof EmployeeBenefitTypeSchema>

/** A stored row, as every read and write returns it. */
export interface EmployeeBenefitRow {
  id: string
  employee_id: string
  benefit_type: EmployeeBenefitType
  description: string
  monthly_value: number
  valid_from: string
  valid_to: string | null
  metadata: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

/** The would-be row a create dry-run echoes: no id or timestamps. */
export type EmployeeBenefitPreview = Omit<EmployeeBenefitRow, 'id' | 'created_at' | 'updated_at'>

export type EmployeeBenefitWriteOutcome<Preview> =
  | { committed: true; row: EmployeeBenefitRow }
  | { committed: false; preview: Preview }

export type EmployeeBenefitDeleteOutcome =
  /** `deactivated`: payslip lines already derive from the row, so it was kept and switched off instead of deleted. */
  | { committed: true; deleted: boolean; deactivated?: boolean }
  | { committed: false; preview: EmployeeBenefitRow }

export type CreateEmployeeBenefitInput = z.infer<typeof CreateEmployeeBenefitSchema>
export type UpdateEmployeeBenefitInput = z.infer<typeof UpdateEmployeeBenefitSchema>

/** Shared 400 copy for annual_market_value on a row that is not a bike benefit. */
export const ANNUAL_MARKET_VALUE_BIKE_ONLY_MESSAGE = 'annual_market_value gäller endast cykelförmån'

// Literal projection at every call site: tests/schema/no-phantom-columns can
// only check column names it can read statically, and the v1 rule is never
// SELECT *. company_id and user_id are tenancy scoping, not resource data.
const BENEFIT_COLUMNS =
  'id, employee_id, benefit_type, description, monthly_value, valid_from, valid_to, metadata, is_active, created_at, updated_at'

const NOT_FOUND_DETAILS: Record<string, unknown> = { resource: 'employee_benefit' }

async function assertEmployee(
  supabase: SupabaseClient,
  companyId: string,
  employeeId: string,
): Promise<EmployeeBenefitResult<{ id: string }>> {
  const { data, error } = await supabase
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(error) }
  }
  if (!data) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  }
  return { ok: true, data: data as { id: string } }
}

function dbDetails(error: { code?: string; message?: string }): Record<string, unknown> {
  return { message: error.message, pg_code: error.code }
}

/**
 * Map a Postgres error on employee_benefits to a result code.
 *
 * - PGRST116 (zero rows on a single-row write): the row is gone (NOT_FOUND).
 * - 42501: privilege/RLS denial, a server-side misconfiguration
 *   (DB_PERMISSION_DENIED), kept apart from INTERNAL_ERROR so it is diagnosable.
 * - 23514: CHECK violation. The schemas mirror every CHECK on the table
 *   (benefit_type, monthly_value >= 0, valid_to >= valid_from), so on insert
 *   this is only the backstop for non-schema callers and on update the one
 *   race left: a concurrent write that moved the other date after the merged
 *   check (VALIDATION_ERROR).
 * - everything else: INTERNAL_ERROR.
 *
 * `details.field` marks a message authored here for the user; without it,
 * `details.message` is raw Postgres text the caller must translate.
 */
function mapWriteError(
  error: { code?: string; message?: string },
  opts: { checkViolation?: { field: string; message: string } } = {},
): { code: string; details?: Record<string, unknown> } {
  if (error.code === 'PGRST116') {
    return { code: 'NOT_FOUND', details: NOT_FOUND_DETAILS }
  }
  if (error.code === '42501') {
    return { code: 'DB_PERMISSION_DENIED', details: dbDetails(error) }
  }
  if (error.code === '23514') {
    return {
      code: 'VALIDATION_ERROR',
      details: opts.checkViolation
        ? { ...opts.checkViolation, pg_code: error.code, pg_message: error.message }
        : dbDetails(error),
    }
  }
  return { code: 'INTERNAL_ERROR', details: dbDetails(error) }
}

/**
 * Exact mirror of the table CHECK (valid_to IS NULL OR valid_to >= valid_from).
 * Inclusive bound; a null valid_to (open-ended benefit) is always legal. ISO
 * YYYY-MM-DD strings order lexicographically the same as chronologically.
 */
export function isBenefitPeriodOrdered(validFrom: string | null, validTo: string | null): boolean {
  return validFrom === null || validTo === null || validTo >= validFrom
}

/**
 * Bike benefit: the derived monthly value and the calculation inputs stored
 * next to it, so a reader can see how the schablon was applied.
 */
function withBikeCalculation(
  base: Record<string, unknown>,
  annualMarketValue: number,
): { monthlyValue: number; metadata: Record<string, unknown> } {
  const calc = calculateBikeBenefit(annualMarketValue)
  return {
    monthlyValue: calc.monthlyValue,
    metadata: {
      ...base,
      annual_market_value: annualMarketValue,
      annual_taxable: calc.annualTaxable,
      tax_free_portion: calc.taxFreePortion,
    },
  }
}

/** The row a create would insert. Pure: shared by the write and the dry-run. */
export function buildEmployeeBenefitInsert(
  input: CreateEmployeeBenefitInput,
  employeeId: string,
): EmployeeBenefitPreview {
  let monthlyValue = input.monthly_value ?? 0
  let metadata: Record<string, unknown> = input.metadata ?? {}

  if (input.benefit_type === 'bike' && input.annual_market_value !== undefined) {
    ;({ monthlyValue, metadata } = withBikeCalculation(metadata, input.annual_market_value))
  }

  return {
    employee_id: employeeId,
    benefit_type: input.benefit_type,
    description: input.description,
    monthly_value: monthlyValue,
    valid_from: input.valid_from,
    valid_to: input.valid_to ?? null,
    metadata,
    is_active: input.is_active ?? true,
  }
}

export async function listEmployeeBenefits(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    /** true: only active rows; false: only inactive rows; omitted: both. */
    active?: boolean
  },
): Promise<EmployeeBenefitResult<EmployeeBenefitRow[]>> {
  const emp = await assertEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  let query = supabase
    .from('employee_benefits')
    .select('id, employee_id, benefit_type, description, monthly_value, valid_from, valid_to, metadata, is_active, created_at, updated_at')
    .eq('company_id', args.companyId)
    .eq('employee_id', args.employeeId)
    .order('valid_from', { ascending: false })
    .order('created_at', { ascending: false })

  if (args.active !== undefined) {
    query = query.eq('is_active', args.active)
  }

  const { data, error } = await query
  if (error) {
    return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(error) }
  }
  return { ok: true, data: (data ?? []) as unknown as EmployeeBenefitRow[] }
}

export async function createEmployeeBenefit(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    userId: string
    input: CreateEmployeeBenefitInput
    /** Validate and derive only; return the would-be row without writing. */
    dryRun?: boolean
  },
): Promise<EmployeeBenefitResult<EmployeeBenefitWriteOutcome<EmployeeBenefitPreview>>> {
  const emp = await assertEmployee(supabase, args.companyId, args.employeeId)
  if (!emp.ok) return emp

  const preview = buildEmployeeBenefitInsert(args.input, args.employeeId)

  if (args.dryRun) {
    return { ok: true, data: { committed: false, preview } }
  }

  // Object literal, not a spread: tests/schema/no-phantom-columns can only
  // check payload keys it can read statically.
  const { data, error } = await supabase
    .from('employee_benefits')
    .insert({
      employee_id: preview.employee_id,
      company_id: args.companyId,
      user_id: args.userId,
      benefit_type: preview.benefit_type,
      description: preview.description,
      monthly_value: preview.monthly_value,
      valid_from: preview.valid_from,
      valid_to: preview.valid_to,
      metadata: preview.metadata,
      is_active: preview.is_active,
    })
    .select('id, employee_id, benefit_type, description, monthly_value, valid_from, valid_to, metadata, is_active, created_at, updated_at')
    .single()

  if (error) {
    return { ok: false, ...mapWriteError(error) }
  }
  return { ok: true, data: { committed: true, row: data as unknown as EmployeeBenefitRow } }
}

export async function updateEmployeeBenefit(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    benefitId: string
    patch: UpdateEmployeeBenefitInput
    /** Validate against the stored row and return the merged row without writing. */
    dryRun?: boolean
  },
): Promise<EmployeeBenefitResult<EmployeeBenefitWriteOutcome<EmployeeBenefitRow>>> {
  // The lookup is scoped by employee and company, so it is the ownership
  // check as well: one round trip, no separate employee assertion.
  const { data: existingRaw, error: fetchError } = await supabase
    .from('employee_benefits')
    .select('id, employee_id, benefit_type, description, monthly_value, valid_from, valid_to, metadata, is_active, created_at, updated_at')
    .eq('id', args.benefitId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  // Only zero rows (PGRST116) means the benefit really is not there. A
  // transport/DB failure is not a missing record and must not be reported
  // as one.
  if (fetchError && fetchError.code !== 'PGRST116') {
    return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(fetchError) }
  }
  if (!existingRaw) {
    return { ok: false, code: 'NOT_FOUND', details: NOT_FOUND_DETAILS }
  }
  const existing = existingRaw as unknown as EmployeeBenefitRow

  // Validity period against the MERGED state. UpdateEmployeeBenefitSchema can
  // only compare the two dates when the body carries both; when one is
  // patched, the other half lives on the stored row. Without this the CHECK
  // fired in Postgres and used to surface as "Förmån hittades inte".
  const mergedValidFrom = args.patch.valid_from ?? existing.valid_from ?? null
  const mergedValidTo =
    args.patch.valid_to !== undefined ? args.patch.valid_to : existing.valid_to ?? null
  if (!isBenefitPeriodOrdered(mergedValidFrom, mergedValidTo)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'valid_to', message: BENEFIT_PERIOD_ORDER_MESSAGE },
    }
  }

  const updates: Record<string, unknown> = {}
  for (const key of [
    'description',
    'monthly_value',
    'valid_from',
    'valid_to',
    'metadata',
    'is_active',
  ] as const) {
    if (args.patch[key] !== undefined) updates[key] = args.patch[key]
  }

  if (args.patch.annual_market_value !== undefined) {
    if (existing.benefit_type !== 'bike') {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'annual_market_value', message: ANNUAL_MARKET_VALUE_BIKE_ONLY_MESSAGE },
      }
    }
    const calc = withBikeCalculation(
      { ...(existing.metadata ?? {}), ...(args.patch.metadata ?? {}) },
      args.patch.annual_market_value,
    )
    updates.monthly_value = calc.monthlyValue
    updates.metadata = calc.metadata
  }

  if (args.dryRun) {
    return {
      ok: true,
      data: { committed: false, preview: { ...existing, ...updates } as EmployeeBenefitRow },
    }
  }
  // Nothing to change: PostgREST performs no update for an empty object and
  // returns no row, which would read as NOT_FOUND. Answer with the stored row.
  if (Object.keys(updates).length === 0) {
    return { ok: true, data: { committed: true, row: existing } }
  }

  const { data, error } = await supabase
    .from('employee_benefits')
    // Literal keys so the phantom-column scanner can verify every column;
    // undefined values are dropped by supabase-js serialisation.
    .update({
      description: updates.description,
      monthly_value: updates.monthly_value,
      valid_from: updates.valid_from,
      valid_to: updates.valid_to,
      metadata: updates.metadata,
      is_active: updates.is_active,
    })
    .eq('id', args.benefitId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .select('id, employee_id, benefit_type, description, monthly_value, valid_from, valid_to, metadata, is_active, created_at, updated_at')
    .maybeSingle()

  if (error) {
    // The row's existence was established above, so a 23514 here is the
    // validity-period CHECK tripped by a concurrent write, not a lookup miss.
    return {
      ok: false,
      ...mapWriteError(error, {
        checkViolation: { field: 'valid_to', message: BENEFIT_PERIOD_ORDER_MESSAGE },
      }),
    }
  }
  if (!data) {
    // Deleted or moved out of the company between fetch and update.
    return { ok: false, code: 'NOT_FOUND', details: NOT_FOUND_DETAILS }
  }
  return { ok: true, data: { committed: true, row: data as unknown as EmployeeBenefitRow } }
}

export async function deleteEmployeeBenefit(
  supabase: SupabaseClient,
  args: {
    companyId: string
    employeeId: string
    benefitId: string
    /** Confirm the row exists and return it without deleting. */
    dryRun?: boolean
  },
): Promise<EmployeeBenefitResult<EmployeeBenefitDeleteOutcome>> {
  if (args.dryRun) {
    const { data, error } = await supabase
      .from('employee_benefits')
      .select('id, employee_id, benefit_type, description, monthly_value, valid_from, valid_to, metadata, is_active, created_at, updated_at')
      .eq('id', args.benefitId)
      .eq('employee_id', args.employeeId)
      .eq('company_id', args.companyId)
      .maybeSingle()

    if (error && error.code !== 'PGRST116') {
      return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(error) }
    }
    if (!data) {
      return { ok: false, code: 'NOT_FOUND', details: NOT_FOUND_DETAILS }
    }
    return { ok: true, data: { committed: false, preview: data as unknown as EmployeeBenefitRow } }
  }

  // Referenced: keep the row and switch it off, so the chain from a (possibly
  // booked) verifikat back to its förmån stays intact (BFL 5 kap 6-7 §,
  // #2695). The next recalculation drops the draft derived line by its
  // back-link and never re-derives an inactive benefit.
  const keepAndDeactivate = async (): Promise<EmployeeBenefitResult<EmployeeBenefitDeleteOutcome>> => {
    const { data: kept, error: keepError } = await supabase
      .from('employee_benefits')
      .update({ is_active: false })
      .eq('id', args.benefitId)
      .eq('employee_id', args.employeeId)
      .eq('company_id', args.companyId)
      .select('id')
    if (keepError) {
      return { ok: false, ...mapWriteError(keepError) }
    }
    const found = Array.isArray(kept) && kept.length > 0
    return { ok: true, data: { committed: true, deleted: false, deactivated: found } }
  }

  // Pre-check, NOT the invariant. The invariant is the NO ACTION foreign key
  // (migration 20260920190100) handled below. This count stays for one reason:
  // application code and migrations do not deploy atomically, and a
  // self-hosted image can run ahead of its migrations. On a database where
  // the key is still ON DELETE SET NULL, a delete with no pre-check would
  // orphan every line the benefit ever produced, deterministically. With the
  // key in place the count only saves a refused DELETE round trip.
  const { count: referencing, error: refError } = await supabase
    .from('salary_line_items')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', args.companyId)
    .eq('source_benefit_id', args.benefitId)
  if (refError) {
    return { ok: false, code: 'INTERNAL_ERROR', details: dbDetails(refError) }
  }
  if ((referencing ?? 0) > 0) {
    return keepAndDeactivate()
  }

  // Hard delete with RETURNING so the caller can tell a hit from a no-op: a
  // filtered DELETE reports no error when the id is unknown or belongs to
  // another company, and both routes answer that with 404.
  const { data, error } = await supabase
    .from('employee_benefits')
    .delete()
    .eq('id', args.benefitId)
    .eq('employee_id', args.employeeId)
    .eq('company_id', args.companyId)
    .select('id')

  // 23503: a recalculation derived a line between the count above and this
  // delete (#2801). The count could never close that gap; the foreign key
  // does, because the derived insert holds FOR KEY SHARE on the benefit row
  // and this delete waits for it. Same outcome as a line the count had seen.
  if (error?.code === '23503') {
    return keepAndDeactivate()
  }
  if (error) {
    return { ok: false, ...mapWriteError(error) }
  }
  return { ok: true, data: { committed: true, deleted: Array.isArray(data) && data.length > 0 } }
}

// ──────────────────────────────────────────────────────────────────
// v1 wire shape. Shared by the two v1 route files (list/create and
// update/delete) so the resource cannot drift between them.
// ──────────────────────────────────────────────────────────────────

export const EmployeeBenefitResourceSchema = z.object({
  employee_benefit_id: z.string().uuid(),
  benefit_type: EmployeeBenefitTypeSchema,
  description: z.string(),
  /** Monthly taxable förmånsvärde in SEK, the amount the engine derives per run. */
  monthly_value: z.number(),
  /** Bike only: the annual market value the monthly value was derived from. Null for other types. */
  annual_market_value: z.number().nullable(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  is_active: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
})

export type EmployeeBenefitResource = z.infer<typeof EmployeeBenefitResourceSchema>
export type EmployeeBenefitPreviewResource = Omit<
  EmployeeBenefitResource,
  'employee_benefit_id' | 'created_at' | 'updated_at'
>

function storedAnnualMarketValue(metadata: Record<string, unknown> | null | undefined): number | null {
  const value = metadata?.annual_market_value
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function toEmployeeBenefitPreviewResource(
  preview: EmployeeBenefitPreview,
): EmployeeBenefitPreviewResource {
  return {
    benefit_type: preview.benefit_type,
    description: preview.description,
    monthly_value: preview.monthly_value,
    annual_market_value: storedAnnualMarketValue(preview.metadata),
    valid_from: preview.valid_from,
    valid_to: preview.valid_to,
    is_active: preview.is_active,
    metadata: preview.metadata ?? {},
  }
}

export function toEmployeeBenefitResource(row: EmployeeBenefitRow): EmployeeBenefitResource {
  return {
    employee_benefit_id: row.id,
    ...toEmployeeBenefitPreviewResource(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

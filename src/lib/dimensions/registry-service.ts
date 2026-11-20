/**
 * The dimension registry (SIE #DIM: kostnadsställe, projekt and custom
 * dimensions): list, create, rename/archive/reorder, delete, and creating a
 * value (#OBJEKT) under a dimension. One implementation behind the dashboard
 * routes (/api/dimensions), the v1 routes and operations and the MCP tools,
 * so every door applies the same rules:
 *
 *   - numbers 1-19 carry SIE's standardized meanings (1 kostnadsställe,
 *     6 projekt, 7 anställd, ...) and 20+ are free; an omitted number takes
 *     the next free one from 20, an explicit one anywhere in 1-9999 must be
 *     unused;
 *   - a parent (#UNDERDIM) must be an existing dimension, never itself;
 *   - a system dimension (1, 6) is never renamed or deleted; archiving and
 *     reordering it is allowed;
 *   - a dimension tagged on any posted or reversed line cannot be deleted:
 *     the DB guard (enforce_dimension_registry_guards) is the single source
 *     of truth and its message, which names the dimension, is passed on;
 *   - a value is created under a dimension of the same company, may be
 *     created archived (is_active=false), carries start/end dates only on an
 *     accumulating dimension (resets_annually=false, e.g. projekt), and its
 *     code is unique within the dimension (the DB UNIQUE is the arbiter);
 *   - a value is renamed, archived or dated, never recoded (the code is on
 *     posted lines);
 *   - every value write emits its events (./value-events.ts, accounted#193).
 */
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { z } from 'zod'
import type {
  CreateDimensionSchema,
  CreateDimensionValueSchema,
  UpdateDimensionSchema,
  UpdateDimensionValueSchema,
} from '@/lib/api/schemas'
import { dimensionValueSnapshot, emitDimensionValueEvents, type DimensionValueRow } from './value-events'

export interface DimensionRow {
  id: string
  sie_dim_no: number
  name: string
  parent_sie_dim_no: number | null
  resets_annually: boolean
  is_system: boolean
  is_active: boolean
  sort_order: number
}

export interface DimensionValueEntry {
  id: string
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

export type DimensionWithValues = DimensionRow & { values: DimensionValueEntry[] }

/** The system dimensions ensure_company_dimensions seeds: Kostnadsställe, Projekt. */
export const SYSTEM_DIMENSION_NUMBERS = [1, 6] as const

/** First free custom number: SIE leaves 20 and up unreserved. */
export function nextFreeDimensionNumber(taken: ReadonlySet<number>, from = 20): number {
  let n = from
  while (taken.has(n)) n++
  return n
}

/** What a registry read needs: no acting user (the MCP resolve path has none to hand). */
type RegistryReadContext = Pick<OperationContext, 'supabase' | 'companyId' | 'log'>

async function ensureSystemDimensions(ctx: RegistryReadContext): Promise<OperationOutcome<never> | null> {
  const { error } = await ctx.supabase.rpc('ensure_company_dimensions', { p_company_id: ctx.companyId })
  if (error) {
    ctx.log.error('ensure_company_dimensions failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  return null
}

/**
 * The registry with every value nested, dimensions by sort_order then
 * number, values by code. Seeds the system dims first, so a writer's list is
 * never empty; for a read-only member the seed writes nothing and the list
 * is what exists (20261026209000). Values are paginated: an SIE history can mint thousands of codes,
 * past PostgREST's silent 1000-row cap. The MCP tools read the registry
 * through this function too (list_dimensions and the resolve step of every
 * dims-bag write), so no door can see a shorter registry than another.
 */
export async function listDimensions(
  ctx: RegistryReadContext,
): Promise<OperationOutcome<{ dimensions: DimensionWithValues[] }>> {
  const ensured = await ensureSystemDimensions(ctx)
  if (ensured) return ensured

  const { data: dims, error: dimsError } = await ctx.supabase
    .from('dimensions')
    .select('id, sie_dim_no, name, parent_sie_dim_no, resets_annually, is_system, is_active, sort_order')
    .eq('company_id', ctx.companyId)
    .order('sort_order', { ascending: true })
    .order('sie_dim_no', { ascending: true })
  if (dimsError) {
    ctx.log.error('dimension list failed', dimsError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: dimsError }
  }

  let values: Array<DimensionValueEntry & { dimension_id: string }>
  try {
    values = await fetchAllRows<DimensionValueEntry & { dimension_id: string }>(({ from, to }) =>
      ctx.supabase
        .from('dimension_values')
        .select('id, dimension_id, code, name, is_active, start_date, end_date')
        .eq('company_id', ctx.companyId)
        .order('code', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch (valuesError) {
    ctx.log.error('dimension value list failed', valuesError as Error)
    return { ok: false, code: 'UNKNOWN_ERROR', error: valuesError }
  }

  const byDimension = new Map<string, DimensionValueEntry[]>()
  for (const v of values) {
    const bucket = byDimension.get(v.dimension_id) ?? []
    bucket.push({
      id: v.id,
      code: v.code,
      name: v.name,
      is_active: v.is_active,
      start_date: v.start_date,
      end_date: v.end_date,
    })
    byDimension.set(v.dimension_id, bucket)
  }

  const dimensions = ((dims ?? []) as DimensionRow[]).map((d) => ({ ...d, values: byDimension.get(d.id) ?? [] }))
  return { ok: true, data: { dimensions } }
}

/** The request every door validates (CreateDimensionSchema). */
export type CreateDimensionInput = z.output<typeof CreateDimensionSchema>

export async function createDimension(
  ctx: OperationContext,
  input: CreateDimensionInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ dimension: DimensionRow }>> {
  const { supabase, companyId, log } = ctx
  // The system dims 1 and 6 are seeded lazily, and they are what make a
  // parent of 1 or 6 valid. A dry run writes nothing (it is also the MCP
  // staging preview), so it counts them as present instead of seeding them.
  if (!options.dryRun) {
    const ensured = await ensureSystemDimensions(ctx)
    if (ensured) return ensured
  }

  const { data: existing, error: existingError } = await supabase
    .from('dimensions')
    .select('sie_dim_no')
    .eq('company_id', companyId)
  if (existingError) {
    log.error('dimension number lookup failed', existingError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: existingError }
  }
  const taken = new Set(((existing ?? []) as { sie_dim_no: number }[]).map((d) => d.sie_dim_no))
  for (const systemDimension of SYSTEM_DIMENSION_NUMBERS) taken.add(systemDimension)

  const autoPicked = input.sie_dim_no === undefined
  let sieDimNo = input.sie_dim_no ?? nextFreeDimensionNumber(taken)
  if (!autoPicked && taken.has(sieDimNo)) {
    return {
      ok: false,
      code: 'DIMENSION_NUMBER_TAKEN',
      details: { sie_dim_no: sieDimNo },
      messageSv: `Dimension ${sieDimNo} finns redan i registret.`,
    }
  }

  if (input.parent_sie_dim_no != null) {
    if (input.parent_sie_dim_no === sieDimNo) {
      return {
        ok: false,
        code: 'DIMENSION_PARENT_INVALID',
        details: { parent_sie_dim_no: input.parent_sie_dim_no },
        messageSv: 'En dimension kan inte vara sin egen överordnade dimension.',
      }
    }
    if (!taken.has(input.parent_sie_dim_no)) {
      return {
        ok: false,
        code: 'DIMENSION_PARENT_INVALID',
        details: { parent_sie_dim_no: input.parent_sie_dim_no },
        messageSv: `Överordnad dimension ${input.parent_sie_dim_no} finns inte i registret.`,
      }
    }
  }

  const row = {
    company_id: companyId,
    name: input.name,
    parent_sie_dim_no: input.parent_sie_dim_no ?? null,
    resets_annually: input.resets_annually ?? true,
    is_system: false,
    is_active: true,
    // System dims 1/6 sit at sort_order 10/20; custom dims trail them.
    sort_order: 100,
  }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { ...row, sie_dim_no: sieDimNo, number_auto_picked: autoPicked } }
  }

  const insert = (dimNo: number) =>
    supabase
      .from('dimensions')
      .insert({
        company_id: companyId,
        sie_dim_no: dimNo,
        name: row.name,
        parent_sie_dim_no: row.parent_sie_dim_no,
        resets_annually: row.resets_annually,
        is_system: false,
        is_active: true,
        sort_order: row.sort_order,
      })
      .select('id, sie_dim_no, name, parent_sie_dim_no, resets_annually, is_system, is_active, sort_order').single()

  let { data: dimension, error: insertError } = await insert(sieDimNo)
  // An auto-picked number can race a concurrent create or SIE import between
  // the read and the insert. The UNIQUE is the arbiter: retry once past the
  // loser instead of refusing a number the caller never chose.
  if (insertError?.code === '23505' && autoPicked) {
    sieDimNo = nextFreeDimensionNumber(taken, sieDimNo + 1)
    ;({ data: dimension, error: insertError } = await insert(sieDimNo))
  }
  if (insertError) {
    if (insertError.code === '23505') {
      return {
        ok: false,
        code: 'DIMENSION_NUMBER_TAKEN',
        details: { sie_dim_no: sieDimNo },
        messageSv: `Dimension ${sieDimNo} finns redan i registret.`,
      }
    }
    log.error('dimension create failed', insertError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: insertError }
  }

  return { ok: true, data: { dimension: dimension as DimensionRow }, created: true }
}

/** The request every door validates (CreateDimensionValueSchema). */
export type CreateDimensionValueInput = z.output<typeof CreateDimensionValueSchema>

export type CreatedDimensionValue = DimensionValueEntry & { dimension_id: string; created_at: string | null }

/**
 * Create a value (SIE #OBJEKT) under a dimension. The input is already
 * shaped by the door's schema (strict Fortnox code, end_date not before
 * start_date); this function holds the rules that need the database: the
 * dimension must belong to the company, dates only on an accumulating
 * dimension, and the code must be free in the dimension. A dry run checks
 * the dimension and the date rule and writes nothing.
 */
export async function createDimensionValue(
  ctx: OperationContext,
  dimensionId: string,
  input: CreateDimensionValueInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<CreatedDimensionValue>> {
  const { supabase, companyId, log } = ctx
  const { data: dimension, error: dimError } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no, name, resets_annually')
    .eq('id', dimensionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (dimError) {
    log.error('dimension fetch failed', dimError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: dimError }
  }
  if (!dimension) return { ok: false, code: 'DIMENSION_NOT_FOUND', details: { dimension_id: dimensionId } }

  // Value dates only make sense on accumulating dimensions (projekt-style
  // ranges). An explicit null is a harmless no-op; an actual date is refused.
  if (dimension.resets_annually && (input.start_date != null || input.end_date != null)) {
    return { ok: false, code: 'DIMENSION_VALUE_DATES_NOT_ALLOWED', details: { dimension_id: dimensionId } }
  }

  const value = {
    dimension_id: dimensionId,
    code: input.code,
    name: input.name,
    is_active: input.is_active ?? true,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
  }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { id: null, ...value, created_at: null } }
  }

  const { data, error } = await supabase
    .from('dimension_values')
    // Keys spelled out, not spread: tests/schema/no-phantom-columns.test.ts
    // can only check the columns of a literal payload.
    .insert({
      company_id: companyId,
      dimension_id: value.dimension_id,
      code: value.code,
      name: value.name,
      is_active: value.is_active,
      start_date: value.start_date,
      end_date: value.end_date,
    })
    .select('id, dimension_id, code, name, is_active, start_date, end_date, created_at')
    .single()
  if (error) {
    if (error.code === '23505') {
      return { ok: false, code: 'DIMENSION_VALUE_DUPLICATE_CODE', details: { code: input.code } }
    }
    log.error('dimension value insert failed', error)
    return { ok: false, code: 'DIMENSION_VALUE_CREATE_FAILED', details: { reason: getUserErrorMessage(error) } }
  }
  const created = data as CreatedDimensionValue
  await emitDimensionValueEvents({
    companyId,
    userId: ctx.userId,
    before: null,
    after: dimensionValueSnapshot(created, dimension),
  })
  return { ok: true, data: created, created: true }
}

/** The request every door validates (UpdateDimensionValueSchema). */
export type UpdateDimensionValueInput = z.output<typeof UpdateDimensionValueSchema>

export type UpdatedDimensionValue = DimensionValueEntry & { dimension_id: string }

const VALUE_COLUMNS = 'id, dimension_id, code, name, is_active, start_date, end_date'

/**
 * Rename, archive or unarchive a value, or set its dates: a sparse update of
 * what the caller sent (the code is immutable: it is on posted lines). The
 * value must be the company's and the dimension's; dates only on an
 * accumulating dimension. A dry run answers the value as it would be and
 * writes nothing. The write emits its events (renamed, archived,
 * unarchived), so the dashboard and v1 cannot differ in what they announce.
 */
export async function updateDimensionValue(
  ctx: OperationContext,
  dimensionId: string,
  valueId: string,
  input: UpdateDimensionValueInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<UpdatedDimensionValue>> {
  const { supabase, companyId, log } = ctx
  const { data: current, error: fetchError } = await supabase
    .from('dimension_values')
    .select(`${VALUE_COLUMNS}, dimension:dimensions(sie_dim_no, name, resets_annually)`)
    .eq('id', valueId)
    .eq('dimension_id', dimensionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (fetchError) {
    log.error('dimension value fetch failed', fetchError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  }
  const row = current as (DimensionValueRow & { dimension: { sie_dim_no: number; name: string; resets_annually: boolean } | null }) | null
  if (!row || !row.dimension) return { ok: false, code: 'DIMENSION_VALUE_NOT_FOUND' }
  const { dimension, ...before } = row

  // Value dates only make sense on accumulating dimensions (projekt-style
  // ranges). An explicit null (clear) is always allowed.
  if (dimension.resets_annually && (input.start_date != null || input.end_date != null)) {
    return { ok: false, code: 'DIMENSION_VALUE_DATES_NOT_ALLOWED' }
  }

  // Sparse update: only the fields the caller actually sent.
  const changes: Record<string, unknown> = {}
  for (const key of ['name', 'is_active', 'start_date', 'end_date'] as const) {
    if (input[key] !== undefined) changes[key] = input[key]
  }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { ...before, ...changes } }
  }

  const { data, error } = await supabase
    .from('dimension_values')
    .update(changes)
    .eq('id', valueId)
    .eq('dimension_id', dimensionId)
    .eq('company_id', companyId)
    .select(VALUE_COLUMNS)
    .single()
  if (error) {
    // Gone between the read and the write.
    if (error.code === 'PGRST116') return { ok: false, code: 'DIMENSION_VALUE_NOT_FOUND' }
    log.error('dimension value update failed', error)
    return { ok: false, code: 'DIMENSION_VALUE_UPDATE_FAILED', details: { reason: getUserErrorMessage(error) } }
  }
  const updated = data as UpdatedDimensionValue
  await emitDimensionValueEvents({
    companyId,
    userId: ctx.userId,
    before,
    after: dimensionValueSnapshot(updated, dimension),
  })
  return { ok: true, data: updated }
}

/** The request every door validates (UpdateDimensionSchema). */
export type UpdateDimensionInput = z.output<typeof UpdateDimensionSchema>

export async function updateDimension(
  ctx: OperationContext,
  dimensionId: string,
  input: UpdateDimensionInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<DimensionRow>> {
  const { supabase, companyId, log } = ctx
  const { data: existing, error: fetchError } = await supabase
    .from('dimensions')
    .select('id, name, is_system')
    .eq('id', dimensionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (fetchError) {
    log.error('dimension fetch failed', fetchError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  }
  if (!existing) return { ok: false, code: 'DIMENSION_NOT_FOUND' }
  if (existing.is_system && input.name !== undefined && input.name !== existing.name) {
    return { ok: false, code: 'DIMENSION_SYSTEM_RENAME' }
  }

  // Sparse update: only the fields the caller sent. sie_dim_no and
  // is_system are immutable at the DB level and never accepted here.
  const changes: Record<string, unknown> = {}
  for (const key of ['name', 'is_active', 'sort_order'] as const) {
    if (input[key] !== undefined) changes[key] = input[key]
  }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { dimension_id: dimensionId, changes } }
  }

  const { data, error } = await supabase
    .from('dimensions')
    .update(changes)
    .eq('id', dimensionId)
    .eq('company_id', companyId)
    .select('id, sie_dim_no, name, parent_sie_dim_no, resets_annually, is_system, is_active, sort_order')
    .single()
  if (error) {
    log.error('dimension update failed', error)
    return { ok: false, code: 'DIMENSION_UPDATE_FAILED', details: { reason: getUserErrorMessage(error) } }
  }
  return { ok: true, data: data as DimensionRow }
}

export async function deleteDimension(
  ctx: OperationContext,
  dimensionId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ deleted: true; dimension_id: string }>> {
  const { supabase, companyId, log } = ctx
  const { data: existing, error: fetchError } = await supabase
    .from('dimensions')
    .select('id, name, sie_dim_no, is_system')
    .eq('id', dimensionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (fetchError) {
    log.error('dimension fetch failed', fetchError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: fetchError }
  }
  if (!existing) return { ok: false, code: 'DIMENSION_NOT_FOUND' }
  if (existing.is_system) return { ok: false, code: 'DIMENSION_SYSTEM_DELETE' }

  if (options.dryRun) {
    // Whether a posted line references the number is the DB guard's call at
    // delete time; the preview says what would be removed.
    return {
      ok: true,
      dryRun: true,
      preview: { dimension_id: dimensionId, sie_dim_no: existing.sie_dim_no, name: existing.name, values_cascade: true },
    }
  }

  const { data, error } = await supabase
    .from('dimensions')
    .delete()
    .eq('id', dimensionId)
    .eq('company_id', companyId)
    .select('id')
  if (error) {
    // P0001 = plpgsql RAISE EXCEPTION: the registry guard (or the value
    // retention trigger on the cascade) refusing the delete. Its Swedish
    // message names the dimension or code, so it is passed on verbatim.
    if (error.code === 'P0001') {
      return { ok: false, code: 'DIMENSION_REFERENCED', messageSv: error.message }
    }
    log.error('dimension delete failed', error)
    return { ok: false, code: 'DIMENSION_DELETE_FAILED', details: { reason: getUserErrorMessage(error) } }
  }
  if (!data || data.length === 0) return { ok: false, code: 'DIMENSION_NOT_FOUND' }
  return { ok: true, data: { deleted: true, dimension_id: dimensionId } }
}

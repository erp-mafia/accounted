/**
 * The dimension registry (SIE #DIM: kostnadsställe, projekt and custom
 * dimensions): list, create, rename/archive/reorder, delete. One
 * implementation behind the dashboard routes (/api/dimensions), the v1
 * operations and the MCP tools, so every door applies the same rules:
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
 *     of truth and its message, which names the dimension, is passed on.
 */
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

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

async function ensureSystemDimensions(ctx: OperationContext): Promise<OperationOutcome<never> | null> {
  const { error } = await ctx.supabase.rpc('ensure_company_dimensions', { p_company_id: ctx.companyId })
  if (error) {
    ctx.log.error('ensure_company_dimensions failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  return null
}

/**
 * The registry with every value nested, dimensions by sort_order then
 * number, values by code. Seeds the system dims first, so the list is never
 * empty. Values are paginated: an SIE history can mint thousands of codes,
 * past PostgREST's silent 1000-row cap.
 */
export async function listDimensions(
  ctx: OperationContext,
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

export interface CreateDimensionInput {
  name: string
  sie_dim_no?: number
  resets_annually?: boolean
  parent_sie_dim_no?: number | null
}

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

export interface UpdateDimensionInput {
  name?: string
  is_active?: boolean
  sort_order?: number
}

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

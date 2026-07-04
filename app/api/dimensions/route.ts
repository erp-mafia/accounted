/**
 * GET /api/dimensions: the dimension registry (kostnadsställe/projekt + custom
 * dims) with nested values, for the register page and pickers.
 *
 * Calls ensure_company_dimensions first so the system dims (1 = Kostnadsställe,
 * 6 = Projekt) always exist: lazy seeding keeps core zero-config for companies
 * that never touch dimensions (dev_docs/dimensions_implementation_plan.md §6).
 *
 * Response contract (PR2: the register UI builds against this exactly):
 *   200 { dimensions: [{ id, sie_dim_no, name, resets_annually, is_system,
 *         is_active, sort_order, values: [{ id, code, name, is_active,
 *         start_date, end_date }] }] }
 * Dimensions sorted by sort_order, values by code.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateDimensionSchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'

ensureInitialized()

interface DimensionValueRow {
  id: string
  dimension_id: string
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

interface DimensionRow {
  id: string
  sie_dim_no: number
  name: string
  parent_sie_dim_no: number | null
  resets_annually: boolean
  is_system: boolean
  is_active: boolean
  sort_order: number
}

export const GET = withRouteContext(
  'dimension.list',
  async (_request, ctx) => {
    // dimensions_enabled is deliberately NOT enforced here: it is a
    // UI-visibility flag only (dev_docs/dimensions_implementation_plan.md §2).
    // Agents/MCP and SIE import must operate on the registry regardless of the
    // toggle; the security boundary is company scoping (withRouteContext + RLS).
    const { supabase, companyId, log, requestId } = ctx

    const { error: ensureError } = await supabase.rpc('ensure_company_dimensions', {
      p_company_id: companyId,
    })
    if (ensureError) {
      log.error('ensure_company_dimensions failed', ensureError)
      return errorResponse(ensureError, log, { requestId })
    }

    const { data: dims, error: dimsError } = await supabase
      .from('dimensions')
      .select('id, sie_dim_no, name, parent_sie_dim_no, resets_annually, is_system, is_active, sort_order')
      .eq('company_id', companyId)
      .order('sort_order', { ascending: true })
      .order('sie_dim_no', { ascending: true })

    if (dimsError) {
      log.error('dimension list failed', dimsError)
      return errorResponse(dimsError, log, { requestId })
    }

    const { data: values, error: valuesError } = await supabase
      .from('dimension_values')
      .select('id, dimension_id, code, name, is_active, start_date, end_date')
      .eq('company_id', companyId)
      .order('code', { ascending: true })

    if (valuesError) {
      log.error('dimension value list failed', valuesError)
      return errorResponse(valuesError, log, { requestId })
    }

    const valuesByDimension = new Map<string, Omit<DimensionValueRow, 'dimension_id'>[]>()
    for (const v of (values ?? []) as DimensionValueRow[]) {
      const bucket = valuesByDimension.get(v.dimension_id) ?? []
      bucket.push({
        id: v.id,
        code: v.code,
        name: v.name,
        is_active: v.is_active,
        start_date: v.start_date,
        end_date: v.end_date,
      })
      valuesByDimension.set(v.dimension_id, bucket)
    }

    const dimensions = ((dims ?? []) as DimensionRow[]).map((d) => ({
      ...d,
      values: valuesByDimension.get(d.id) ?? [],
    }))

    return NextResponse.json({ dimensions })
  },
)

/**
 * POST /api/dimensions — create a custom dimension (dimensions PR10).
 *
 * SIE reserves numbers 1-19 for standardized meanings (1 kostnadsställe,
 * 6 projekt, 7 anställd, …) and leaves 20+ free — when sie_dim_no is
 * omitted the server picks the next free number >= 20. Explicit numbers are
 * allowed across the whole 1-9999 range (SIE import already creates
 * reserved-number dims like 7 Anställd; manual creation of one you know is
 * the same operation), uniqueness enforced per company.
 *
 * parent_sie_dim_no (optional) declares an #UNDERDIM hierarchy — it must
 * reference an existing dimension in the company registry; SIE export emits
 * the declaration parent-before-child (lib/reports/sie-export.ts).
 */
export const POST = withRouteContext(
  'dimension.create',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateDimensionSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const { error: ensureError } = await supabase.rpc('ensure_company_dimensions', {
      p_company_id: companyId,
    })
    if (ensureError) {
      log.error('ensure_company_dimensions failed', ensureError)
      return errorResponse(ensureError, log, { requestId })
    }

    const { data: existing, error: existingError } = await supabase
      .from('dimensions')
      .select('sie_dim_no')
      .eq('company_id', companyId)

    if (existingError) {
      log.error('dimension number lookup failed', existingError)
      return errorResponse(existingError, log, { requestId })
    }
    const taken = new Set(
      ((existing ?? []) as { sie_dim_no: number }[]).map((d) => d.sie_dim_no),
    )

    let sieDimNo = body.sie_dim_no
    if (sieDimNo === undefined) {
      // Next free custom number — SIE leaves 20+ unreserved.
      sieDimNo = 20
      while (taken.has(sieDimNo)) sieDimNo++
    } else if (taken.has(sieDimNo)) {
      return NextResponse.json(
        {
          error: {
            code: 'DIMENSION_NUMBER_TAKEN',
            message: `Dimension ${sieDimNo} finns redan i registret.`,
          },
        },
        { status: 409 },
      )
    }

    if (body.parent_sie_dim_no != null) {
      if (body.parent_sie_dim_no === sieDimNo) {
        return NextResponse.json(
          {
            error: {
              code: 'DIMENSION_PARENT_INVALID',
              message: 'En dimension kan inte vara sin egen överordnade dimension.',
            },
          },
          { status: 400 },
        )
      }
      if (!taken.has(body.parent_sie_dim_no)) {
        return NextResponse.json(
          {
            error: {
              code: 'DIMENSION_PARENT_INVALID',
              message: `Överordnad dimension ${body.parent_sie_dim_no} finns inte i registret.`,
            },
          },
          { status: 400 },
        )
      }
    }

    const autoPicked = body.sie_dim_no === undefined
    const insertDimension = (dimNo: number) =>
      supabase
        .from('dimensions')
        .insert({
          company_id: companyId,
          sie_dim_no: dimNo,
          name: body.name,
          parent_sie_dim_no: body.parent_sie_dim_no ?? null,
          resets_annually: body.resets_annually ?? true,
          is_system: false,
          is_active: true,
          // System dims 1/6 sit at sort_order 10/20 (substrate seeding); custom
          // dims trail them by default.
          sort_order: 100,
        })
        .select('id, sie_dim_no, name, parent_sie_dim_no, resets_annually, is_system, is_active, sort_order')
        .single()

    let { data: dimension, error: insertError } = await insertDimension(sieDimNo)

    // Auto-picked numbers can race a concurrent create/SIE import between the
    // read and the insert — the UNIQUE is the arbiter; retry once past the
    // loser instead of surfacing a spurious "finns redan" for a number the
    // user never chose. Explicitly chosen numbers still 409.
    if (insertError?.code === '23505' && autoPicked) {
      sieDimNo++
      while (taken.has(sieDimNo)) sieDimNo++
      ;({ data: dimension, error: insertError } = await insertDimension(sieDimNo))
    }

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json(
          {
            error: {
              code: 'DIMENSION_NUMBER_TAKEN',
              message: `Dimension ${sieDimNo} finns redan i registret.`,
            },
          },
          { status: 409 },
        )
      }
      log.error('dimension create failed', insertError)
      return errorResponse(insertError, log, { requestId })
    }

    return NextResponse.json({ data: { dimension } }, { status: 201 })
  },
  { requireWrite: true },
)

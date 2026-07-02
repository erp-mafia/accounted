/**
 * GET /api/dimensions — the dimension registry (kostnadsställe/projekt + custom
 * dims) with nested values, for the register page and pickers.
 *
 * Calls ensure_company_dimensions first so the system dims (1 = Kostnadsställe,
 * 6 = Projekt) always exist — lazy seeding keeps core zero-config for companies
 * that never touch dimensions (dev_docs/dimensions_implementation_plan.md §6).
 *
 * Response contract (PR2 — the register UI builds against this exactly):
 *   200 { dimensions: [{ id, sie_dim_no, name, resets_annually, is_system,
 *         is_active, sort_order, values: [{ id, code, name, is_active,
 *         start_date, end_date }] }] }
 * Dimensions sorted by sort_order, values by code.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
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
  resets_annually: boolean
  is_system: boolean
  is_active: boolean
  sort_order: number
}

export const GET = withRouteContext(
  'dimension.list',
  async (_request, ctx) => {
    // dimensions_enabled is deliberately NOT enforced here — it is a
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
      .select('id, sie_dim_no, name, resets_annually, is_system, is_active, sort_order')
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

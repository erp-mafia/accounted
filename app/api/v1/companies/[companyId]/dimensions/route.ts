/**
 * GET /api/v1/companies/{companyId}/dimensions
 *
 * List the dimension registry (SIE #DIM) with nested values (#OBJEKT).
 * Ensures the system dims (1 = Kostnadsställe, 6 = Projekt) exist via the
 * ensure_company_dimensions RPC before reading: lazy seeding, so the list is
 * never empty even for companies that have not touched dimensions.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse } from '@/lib/api/v1/errors'

const DimensionValue = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  is_active: z.boolean(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
})

const Dimension = z.object({
  id: z.string().uuid(),
  sie_dim_no: z.number().int().min(1),
  name: z.string(),
  resets_annually: z.boolean(),
  is_system: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
  values: z.array(DimensionValue),
})

const DimensionsResponse = dataEnvelope(z.object({ dimensions: z.array(Dimension) }))

registerEndpoint({
  operation: 'dimensions.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/dimensions',
  summary: 'List dimensions (kostnadsställe/projekt) with their values.',
  description:
    'Returns the company\'s dimension registry: SIE #DIM entries keyed by sie_dim_no (1 = Kostnadsställe, 6 = Projekt; both always exist): with the registered values (#OBJEKT) nested under each dimension. Dimensions are ordered by sort_order, values by code. Line-level tags on journal entries reference these values as {"<sie_dim_no>":"<code>"} in the `dimensions` map.',
  useWhen:
    'You need the valid dimension value codes before tagging journal-entry lines with a cost centre or project, or you are rendering a dimension picker.',
  doNotUseFor:
    'Filtering reports (pass the dimension filter to the report endpoints once available) or reading which lines carry a tag (read the journal entries themselves).',
  pitfalls: [
    'Dimension value codes are STRINGS and case-sensitive: "P001", not 1.',
    'sie_dim_no is the key used in journal_entry_lines.dimensions, NOT the dimension row id.',
    'is_active=false values are historical (archived): do not tag new lines with them.',
    'resets_annually=true (dim 1) means balances reset each fiscal year; dim 6 (projekt) accumulates across years.',
  ],
  example: {
    response: {
      data: {
        dimensions: [
          {
            id: '0e9c…',
            sie_dim_no: 1,
            name: 'Kostnadsställe',
            resets_annually: true,
            is_system: true,
            is_active: true,
            sort_order: 10,
            values: [
              {
                id: 'a8f1…',
                code: 'BUTIK',
                name: 'Butiken',
                is_active: true,
                start_date: null,
                end_date: null,
              },
            ],
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: DimensionsResponse },
})

interface DimensionValueRow {
  id: string
  dimension_id: string
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'dimensions.list',
  async (_request, ctx) => {
    const { error: ensureError } = await ctx.supabase.rpc('ensure_company_dimensions', {
      p_company_id: ctx.companyId!,
    })
    if (ensureError) {
      return v1ErrorResponse(ensureError, ctx.log, { requestId: ctx.requestId })
    }

    const { data: dims, error: dimsError } = await ctx.supabase
      .from('dimensions')
      .select('id, sie_dim_no, name, resets_annually, is_system, is_active, sort_order')
      .eq('company_id', ctx.companyId!)
      .order('sort_order', { ascending: true })
      .order('sie_dim_no', { ascending: true })
    if (dimsError) {
      return v1ErrorResponse(dimsError, ctx.log, { requestId: ctx.requestId })
    }

    const { data: values, error: valuesError } = await ctx.supabase
      .from('dimension_values')
      .select('id, dimension_id, code, name, is_active, start_date, end_date')
      .eq('company_id', ctx.companyId!)
      .order('code', { ascending: true })
    if (valuesError) {
      return v1ErrorResponse(valuesError, ctx.log, { requestId: ctx.requestId })
    }

    const valuesByDimension = new Map<string, Omit<DimensionValueRow, 'dimension_id'>[]>()
    for (const v of ((values ?? []) as DimensionValueRow[])) {
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

    const dimensions = ((dims ?? []) as Array<Record<string, unknown> & { id: string }>).map(
      (d) => ({ ...d, values: valuesByDimension.get(d.id) ?? [] }),
    )

    return ok({ dimensions }, { requestId: ctx.requestId })
  },
)

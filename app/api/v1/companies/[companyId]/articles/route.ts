/**
 * GET /api/v1/companies/{companyId}/articles: list the artikelregister.
 *
 * Read-only (#895): exposes the article catalog so API callers can link
 * invoice items via items[].article_id and copy the article's price,
 * VAT rate, revenue-account override, and ROT/RUT arbetstypskod
 * (housework_type) onto the line. Article CRUD stays dashboard-only for
 * now; the register is small, so this is a plain (non-cursor) list with
 * an include_inactive toggle, mirroring the internal /api/articles GET.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const ArticleShape = z.object({
  id: z.string().uuid(),
  article_number: z.string().nullable(),
  name: z.string(),
  name_en: z.string().nullable(),
  type: z.enum(['vara', 'tjanst']),
  unit: z.string(),
  price_excl_vat: z.number(),
  vat_rate: z.number(),
  revenue_account: z.string().nullable(),
  cost_price: z.number().nullable(),
  ean: z.string().nullable(),
  housework_type: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})

// Explicit projection: excludes user_id, company_id (internal scoping).
const ARTICLE_COLUMNS =
  'id, article_number, name, name_en, type, unit, price_excl_vat, vat_rate, revenue_account, cost_price, ean, housework_type, notes, active, created_at, updated_at'

registerEndpoint({
  operation: 'articles.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/articles',
  summary: 'List the article register (artikelregister).',
  description:
    'Returns the company\'s articles ordered by name. Pass ?include_inactive=true to include soft-deactivated articles. Use the returned id as items[].article_id when creating invoices; housework_type carries the ROT/RUT arbetstypskod for service articles, and revenue_account the optional BAS class-3 override.',
  useWhen:
    'You need the article catalog before composing invoice lines: to resolve an article_id, read its price/VAT defaults, or find ROT/RUT-tagged service articles (housework_type set).',
  doNotUseFor:
    'Creating or editing articles (dashboard-only for now). Invoice line creation itself (POST …/invoices with items[].article_id).',
  pitfalls: [
    'Linking article_id does NOT auto-fill the invoice line: send description, unit_price, vat_rate etc. explicitly on the item (copy them from this response).',
    'price_excl_vat always excludes VAT.',
    'housework_type is an arbetstypskod hint (e.g. BYGG, STAD); the invoice line still needs deduction_type + labor_hours + work_type set explicitly for ROT/RUT.',
    'Inactive articles (active=false) are hidden by default but remain linkable for historical reads.',
  ],
  example: {
    response: {
      data: {
        articles: [
          {
            id: '0e9c…',
            article_number: 'A-0001',
            name: 'Takarbete',
            name_en: null,
            type: 'tjanst',
            unit: 'tim',
            price_excl_vat: 850,
            vat_rate: 25,
            revenue_account: null,
            cost_price: null,
            ean: null,
            housework_type: 'BYGG',
            notes: null,
            active: true,
            created_at: '2026-05-01T09:14:33Z',
            updated_at: '2026-05-01T09:14:33Z',
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(z.object({ articles: z.array(ArticleShape) })) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'articles.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const includeInactiveRaw = url.searchParams.get('include_inactive')
    if (includeInactiveRaw !== null && !['true', 'false'].includes(includeInactiveRaw)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'include_inactive', message: 'Expected true or false.' },
      })
    }
    const includeInactive = includeInactiveRaw === 'true'

    try {
      // Imported product catalogs can exceed PostgREST's silent 1000-row cap:
      // paginate internally, same as the dashboard route. Secondary order on
      // id gives the stable total order .range() paging requires.
      const articles = await fetchAllRows(({ from, to }) => {
        let query = ctx.supabase
          .from('articles')
          .select(ARTICLE_COLUMNS)
          .eq('company_id', ctx.companyId!)
        if (!includeInactive) query = query.eq('active', true)
        return query
          .order('name', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
      })

      return ok({ articles }, { requestId: ctx.requestId })
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)

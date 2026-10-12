/**
 * /api/v1/companies/{companyId}/suppliers: list + create supplier endpoints.
 *
 * GET  : list with filters (supplier_type, search, include_archived).
 *         Cursor pagination on (created_at ASC, id ASC).
 * POST : create: the suppliers.create operation (lib/suppliers/create-
 *         supplier.ts, shared with the dashboard and the agent's approval).
 *         Idempotent (mandatory Idempotency-Key). Dry-runnable.
 *
 * VIES validation note: unlike customers, suppliers do not carry a
 * `vat_number_validated` flag in the schema today. The vat_number is
 * accepted as input but not auto-verified against VIES: a deliberate
 * scope decision documented in the endpoint pitfalls.
 */

import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
  PaginationQueryShape,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ValidationError } from '@/lib/api/v1/errors'
import { v1OperationHandler } from '@/lib/operations/v1'
import { suppliersCreate } from '@/lib/operations/suppliers'

const SupplierType = z.enum([
  'swedish_business',
  'eu_business',
  'non_eu_business',
])

const SupplierSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  supplier_type: SupplierType,
  email: z.string().nullable(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  default_payment_terms: z.number(),
  default_currency: z.string(),
  /** The party (motpart) behind the row; fetch it with GET .../{id}?expand=party or the MCP tool get_party. */
  party_id: z.string().uuid().nullable().optional(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
})

const SuppliersListResponse = listEnvelope(SupplierSummary)

// Explicit projection: never SELECT *. Schema migrations adding columns
// must update this list before the field becomes visible on the public API.
const SUPPLIER_SUMMARY_COLUMNS =
  'id, name, supplier_type, email, org_number, vat_number, default_payment_terms, default_currency, party_id, archived_at, created_at'

const ListFilters = z.object({
  supplier_type: SupplierType.optional().describe('Only suppliers of this type.'),
  search: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Case-insensitive match on the name (anywhere) or the org number (prefix), 1-200 characters.'),
  include_archived: z
    .enum(['true', 'false'])
    .optional()
    .describe('true also returns archived suppliers. Default: false.'),
})

const ListQuery = ListFilters.extend(PaginationQueryShape)

registerEndpoint({
  operation: 'suppliers.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/suppliers',
  summary: 'List suppliers for a company.',
  description:
    'Returns active suppliers in created-first order. Pass ?include_archived=true to include archived rows. Use ?search to match against name or org_number.',
  useWhen:
    'You need a supplier roster: for building a UI picker, resolving a supplier_id before registering a supplier invoice, or syncing an external AP system.',
  doNotUseFor:
    'Fetching a single supplier you already know the id of: use GET /api/v1/companies/{companyId}/suppliers/{id}. Customers are a separate resource.',
  pitfalls: [
    'Archived suppliers are hidden by default; the dashboard makes the same choice.',
    'org_number identifies legal entities only: suppliers currently have no `individual` type, so the field is Bolagsverket public-record data when present.',
    'vat_number is stored as supplied; unlike customers, suppliers are not auto-validated against VIES on create. Validate externally if the integration requires it.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'a8f1…',
          name: 'Office Depot AB',
          supplier_type: 'swedish_business',
          email: 'invoices@officedepot.example',
          org_number: '5566778899',
          vat_number: 'SE556677889901',
          default_payment_terms: 30,
          default_currency: 'SEK',
          archived_at: null,
          created_at: '2026-04-12T08:30:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'suppliers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: ListQuery },
  response: { success: SuppliersListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'suppliers.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const filtersResult = ListFilters.safeParse({
      supplier_type: url.searchParams.get('supplier_type') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      include_archived: url.searchParams.get('include_archived') ?? undefined,
    })
    if (!filtersResult.success) return v1ValidationError(ctx, filtersResult.error)
    const filters = filtersResult.data
    const includeArchived = filters.include_archived === 'true'

    let query = ctx.supabase
      .from('suppliers')
      .select(SUPPLIER_SUMMARY_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (!includeArchived) {
      query = query.is('archived_at', null)
    }
    if (filters.supplier_type) {
      query = query.eq('supplier_type', filters.supplier_type)
    }
    if (filters.search) {
      // Two layers of escaping (matches the customers list):
      //   1. PostgREST `.or()` filter syntax uses commas + parens as
      //      delimiters; strip them from the user-supplied term.
      //   2. SQL LIKE treats `%` and `_` (and `\` as the default escape) as
      //      wildcards; escape them so '100%' matches the literal string.
      const term = filters.search
        .replace(/[,()]/g, '')
        .replace(/[%_\\]/g, '\\$&')
      // org_number is stored without separators (#2391); a caller searching
      // '556677-88' the way the examples show it must still find the row.
      const orgTerm = term.replace(/[\s-]/g, '')
      query = query.or(
        orgTerm === ''
          ? `name.ilike.%${term}%`
          : `name.ilike.%${term}%,org_number.ilike.${orgTerm}%`,
      )
    }

    if (decoded) {
      query = query.or(
        `created_at.gt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`,
      )
    }

    const { data, error } = await query

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    type Row = {
      id: string
      name: string
      supplier_type: string
      email: string | null
      org_number: string | null
      vat_number: string | null
      default_payment_terms: number
      default_currency: string
      archived_at: string | null
      created_at: string
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    // GDPR Art.5(1)(c) defense-in-depth: SupplierType has no `individual`
    // variant today (only swedish_business / eu_business / non_eu_business),
    // so the org_number is Bolagsverket public-record data. Were a future
    // schema iteration introduce a natural-person supplier type, the list
    // endpoint should mask org_number/vat_number the same way the customer
    // list does for `individual`. Leaving the hook (an empty INDIVIDUAL_TYPES
    // set) makes that change a one-line edit and signals the design intent
    // to anyone copying the file.
    const INDIVIDUAL_TYPES = new Set<string>([])

    const suppliers = trimmed.map((r) => {
      const isIndividual = INDIVIDUAL_TYPES.has(r.supplier_type)
      return {
        id: r.id,
        name: r.name,
        supplier_type: r.supplier_type,
        email: r.email,
        org_number: isIndividual ? null : r.org_number,
        vat_number: isIndividual ? null : r.vat_number,
        default_payment_terms: r.default_payment_terms,
        default_currency: r.default_currency,
        archived_at: r.archived_at,
        created_at: r.created_at,
      }
    })

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(suppliers, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST: create supplier (operation suppliers.create)
// ──────────────────────────────────────────────────────────────────

export const POST = v1OperationHandler(suppliersCreate)

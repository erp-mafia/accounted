/**
 * GET /api/v1/companies — list companies the calling API key can access.
 *
 * The API key is bound to a user; that user may be a member of multiple
 * companies (consultant-style). This endpoint returns every company the user
 * has a non-archived membership for, in stable created_at order.
 *
 * Used by 3rd-party integrations to discover which company IDs to scope
 * subsequent calls to.
 */

import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import {
  encodeDefaultCursor,
  parsePaginationParams,
  decodeDefaultCursor,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse } from '@/lib/api/v1/errors'

const Company = z.object({
  id: z.string().uuid(),
  name: z.string(),
  org_number: z.string().nullable(),
  entity_type: z.string(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  created_at: z.string(),
})

const CompaniesListResponse = listEnvelope(Company)

registerEndpoint({
  operation: 'companies.list',
  method: 'GET',
  path: '/api/v1/companies',
  summary: 'List companies the API key can access.',
  description:
    'Returns every non-archived company the API key user is a member of, together with their role. ' +
    'Use the returned `id` as `{companyId}` in subsequent endpoints.',
  useWhen:
    'You need to discover which company IDs an API key has access to before calling company-scoped endpoints.',
  doNotUseFor:
    'Fetching a single company you already know the id of — use GET /api/v1/companies/{companyId} for that.',
  pitfalls: [
    'Multi-company keys (e.g. consultants) will see >1 result. Always pass the correct companyId in subsequent paths.',
    'Archived companies are excluded; if a company disappears the user has been removed from it or it was archived.',
  ],
  example: {
    response: {
      data: [
        {
          id: '8fd5b1f4-…',
          name: 'Acme AB',
          org_number: '556677-8899',
          entity_type: 'aktiebolag',
          role: 'owner',
          created_at: '2025-01-04T08:00:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'companies:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: CompaniesListResponse },
})

export const GET = withApiV1('companies.list', async (request, ctx) => {
  const url = new URL(request.url)
  const { limit, cursor } = parsePaginationParams(url)
  const decoded = decodeDefaultCursor(cursor)

  // Authorization boundary: the query below filters by `user_id = ctx.userId`
  // BEFORE the cursor's keyset is applied, so a tampered cursor can only
  // reorder rows the caller is already entitled to see. Cursors are not
  // signed; that's intentional. See PR #450 review for the trade-off.
  //
  // Keyset pagination uses (joined_at ASC, id ASC) on `company_members`. Two
  // memberships sharing a `joined_at` (bulk-imported, concurrent registrations)
  // are disambiguated by the `company_members.id` tiebreaker so rows on a page
  // boundary are never skipped or duplicated.

  // We over-fetch by one to determine whether a next page exists.
  let query = ctx.supabase
    .from('company_members')
    .select(
      `
        id,
        role,
        joined_at,
        companies:company_id (
          id,
          name,
          org_number,
          entity_type,
          archived_at,
          created_at
        )
      `,
    )
    .eq('user_id', ctx.userId)
    .is('companies.archived_at', null)
    .order('joined_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 1)

  if (decoded) {
    // Compound keyset: joined_at > cursor.ts OR (joined_at = cursor.ts AND id > cursor.id).
    // `.or()` takes a comma-separated PostgREST filter string.
    query = query.or(
      `joined_at.gt.${decoded.ts},and(joined_at.eq.${decoded.ts},id.gt.${decoded.id})`,
    )
  }

  const { data, error } = await query

  if (error) {
    return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  type CompanyRow = {
    id: string
    name: string
    org_number: string | null
    entity_type: string
    archived_at: string | null
    created_at: string
  }

  type Row = {
    // `company_members.id` — the membership row's own UUID, used as the
    // cursor's secondary key. Not exposed in the response.
    id: string
    role: 'owner' | 'admin' | 'member' | 'viewer'
    joined_at: string
    // PostgREST returns the joined company as either an object (one-to-one FK
    // resolution) or an array. Accept both — Supabase's auto-typing chooses
    // the array shape, but actual responses for a single-row FK are objects.
    companies: CompanyRow | CompanyRow[] | null
  }

  const rows = ((data ?? []) as unknown) as Row[]
  const trimmed = rows.slice(0, limit)
  const hasMore = rows.length > limit

  const pickCompany = (r: Row): CompanyRow | null => {
    if (!r.companies) return null
    return Array.isArray(r.companies) ? (r.companies[0] ?? null) : r.companies
  }

  // Defense in depth: PostgREST's `.is('companies.archived_at', null)` is
  // expected to filter out archived companies before the row reaches us.
  // If a `company_members` row arrives without an associated company object,
  // the join filter behaved differently than expected — drop the row AND
  // surface it as a warn so we notice silent data-integrity regressions.
  let droppedNulls = 0
  const companies = trimmed
    .map((r) => {
      const c = pickCompany(r)
      if (!c) {
        droppedNulls += 1
        return null
      }
      return {
        id: c.id,
        name: c.name,
        org_number: c.org_number,
        entity_type: c.entity_type,
        role: r.role,
        created_at: c.created_at,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  if (droppedNulls > 0) {
    ctx.log.warn('companies.list: dropped rows with null company join', { droppedNulls })
  }

  // Cursor encodes the LAST row's `(joined_at, company_members.id)` — always
  // present, no null-guard needed. Independent of whether the joined company
  // dropped out of the response shape.
  const last = trimmed[trimmed.length - 1]
  const nextCursor = hasMore && last
    ? encodeDefaultCursor({ id: last.id, created_at: last.joined_at })
    : null

  return paginated(companies, {
    requestId: ctx.requestId,
    nextCursor: nextCursor ?? undefined,
  })
})

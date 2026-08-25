/**
 * GET /api/v1/companies: list companies the calling API key can access.
 *
 * The API key is bound to a user; that user may be a member of multiple
 * companies (consultant-style). This endpoint returns every company the user
 * has a non-archived membership for, in stable created_at order.
 *
 * Used by 3rd-party integrations to discover which company IDs to scope
 * subsequent calls to.
 */

import { z } from 'zod'
import { paginated, created } from '@/lib/api/v1/response'
import {
  encodeDefaultCursor,
  parsePaginationParams,
  decodeDefaultCursor,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { createCompanyCore } from '@/lib/company/create-company'
import { CompanySetupSchema, planCompanySetup } from '@/lib/company/onboarding-input'

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
    'Fetching a single company you already know the id of: use GET /api/v1/companies/{companyId} for that.',
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

const CreatedCompany = z.object({
  id: z.string().uuid(),
  name: z.string(),
  entity_type: z.enum(['enskild_firma', 'aktiebolag']),
  org_number: z.string().nullable(),
  vat_registered: z.boolean(),
  moms_period: z.enum(['monthly', 'quarterly', 'yearly']).nullable(),
  accounting_method: z.enum(['accrual', 'cash']),
  fiscal_period: z.object({ start_date: z.string(), end_date: z.string(), name: z.string() }),
  team_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'companies.create',
  method: 'POST',
  path: '/api/v1/companies',
  summary: 'Create a company and set it up for bookkeeping.',
  description:
    'Creates a new company owned by the API key user (or attached to one of their teams) and sets it up in one call: ' +
    'owner membership, BAS chart of accounts for the company form, compliance settings, the first fiscal period and the ' +
    'automatic tax deadlines. A 30-day trial with every paid capability starts immediately. ' +
    'Intended for partner platforms provisioning client companies (byrå/vertical SaaS) and for agents onboarding a user.',
  useWhen:
    'A platform or agent needs to provision a company that does not exist in Accounted yet. The caller becomes its owner; invite the end customer afterwards.',
  doNotUseFor:
    'Companies that already exist (list them with GET /api/v1/companies), or changing settings on an existing company (PATCH /api/v1/companies/{companyId}/settings).',
  pitfalls: [
    'A VAT-registered company MUST send moms_period (monthly / quarterly / yearly); the request is refused otherwise, because a missing period silently produces zero VAT deadlines.',
    'Bookkeeping duty under BFL starts when the company exists with a fiscal period: do not create companies to try things out. Use a test-mode key (dry run) for that.',
    'Enskild firma always runs on the calendar year; fiscal_year_start_month is ignored for it.',
    'first_fiscal_year is only for a company in its first year (BFL 3 kap.: up to 18 months). Omit it for an established company.',
    'Not idempotent, and Idempotency-Key is not honoured on this company-less route: a retry after a network failure creates a second company. List GET /api/v1/companies before retrying.',
    'org_number is required for a VAT-registered company (the invoice momsregistreringsnummer derives from it), and f_skatt must be stated explicitly: F-skatt approval is never assumed.',
  ],
  example: {
    request: {
      name: 'Acme AB',
      entity_type: 'aktiebolag',
      org_number: '5566778899',
      vat_registered: true,
      moms_period: 'quarterly',
      accounting_method: 'accrual',
      f_skatt: true,
    },
    response: {
      data: {
        id: '8fd5b1f4-…',
        name: 'Acme AB',
        entity_type: 'aktiebolag',
        org_number: '5566778899',
        vat_registered: true,
        moms_period: 'quarterly',
        accounting_method: 'accrual',
        fiscal_period: { start_date: '2026-01-01', end_date: '2026-12-31', name: 'Räkenskapsår 2026' },
        team_id: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:write',
  risk: 'medium',
  idempotent: false,
  reversible: false,
  dryRunSupported: true,
  request: { body: CompanySetupSchema },
  response: { success: dataEnvelope(CreatedCompany), errorCodes: ['VALIDATION_ERROR', 'FORBIDDEN', 'INTERNAL_ERROR'] },
})

export const POST = withApiV1('companies.create', async (request, ctx) => {
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { field: 'body', message: 'Body is not valid JSON.' },
    })
  }

  const parsed = CompanySetupSchema.safeParse(rawBody)
  if (!parsed.success) {
    return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    })
  }
  const setup = parsed.data

  const plan = planCompanySetup(setup)
  if (!plan.ok) {
    return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { field: 'first_fiscal_year', message: plan.error },
    })
  }

  // Team: explicit, else the caller's first (usually personal) team, same as
  // the web wizard. create_company_for_user re-checks membership.
  let teamId: string | null = setup.team_id ?? null
  if (!teamId) {
    const { data: membership } = await ctx.supabase
      .from('team_members')
      .select('team_id')
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    teamId = (membership?.team_id as string | undefined) ?? null
  }

  const shape = (id: string) => ({
    id,
    name: setup.name,
    entity_type: setup.entity_type,
    org_number: (plan.input.settings.org_number as string | null) ?? null,
    vat_registered: setup.vat_registered,
    moms_period: setup.vat_registered ? setup.moms_period ?? null : null,
    accounting_method: setup.accounting_method,
    fiscal_period: {
      start_date: plan.fiscalPeriod.startDate,
      end_date: plan.fiscalPeriod.endDate,
      name: plan.fiscalPeriod.name,
    },
    team_id: teamId,
  })

  if (ctx.dryRun) {
    return dryRunPreview(shape('00000000-0000-4000-8000-000000000000'), {
      requestId: ctx.requestId,
      log: ctx.log,
    })
  }

  const result = await createCompanyCore(ctx.supabase, plan.input, () =>
    ctx.supabase.rpc('create_company_for_user', {
      p_user_id: ctx.userId,
      p_name: setup.name,
      p_entity_type: setup.entity_type,
      p_team_id: teamId,
    }),
  )

  if (result.error !== undefined) {
    if (result.error === 'org_number_invalid') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'org_number', message: 'Invalid organisationsnummer.' },
      })
    }
    ctx.log.error('companies.create failed', { reason: result.error })
    return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { message: result.error },
    })
  }

  return created(shape(result.companyId), { requestId: ctx.requestId })
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
    // `company_members.id`: the membership row's own UUID, used as the
    // cursor's secondary key. Not exposed in the response.
    id: string
    role: 'owner' | 'admin' | 'member' | 'viewer'
    joined_at: string
    // PostgREST returns the joined company as either an object (one-to-one FK
    // resolution) or an array. Accept both: Supabase's auto-typing chooses
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
  // the join filter behaved differently than expected: drop the row AND
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

  // Cursor encodes the LAST row's `(joined_at, company_members.id)`: always
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

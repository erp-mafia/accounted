/**
 * GET /api/v1/portfolio/overview: one cross-company overview for a key that
 * reaches more than one company (consultant, byrå team member, multi-company
 * owner).
 *
 * The company scope is resolved by lib/portfolio/scope.ts and is ALWAYS
 * intersected with the key user's non-archived memberships: that is the
 * authorization boundary on this static (no `{companyId}`) route, where the
 * wrapper has no URL company to check. The numbers per company are the byrå
 * cockpit's (lib/clients/fetch-client-overview.ts), filtered by
 * lib/portfolio/overview.ts.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ValidationError } from '@/lib/api/v1/errors'
import { isUuid } from '@/lib/invariants/uuid'
import {
  resolveCompanyScope,
  SCOPE_MAX_COMPANIES,
  type CompanyScopeSelector,
} from '@/lib/portfolio/scope'
import {
  DEADLINE_KIND_FILTERS,
  fetchPortfolioOverview,
  type PortfolioCompanyRow,
  type PortfolioOverviewFilters,
} from '@/lib/portfolio/overview'
import type { ClientDeadline } from '@/lib/clients/aggregate'

const Query = z
  .object({
    companies: z
      .string()
      .optional()
      .describe(
        'Comma-separated company ids to read, in this order. Omitted: every company the key can access.',
      ),
    team: z
      .enum(['true', 'false'])
      .optional()
      .describe('true: only the companies on the key user\'s byrå team. Cannot be combined with companies.'),
    exclude: z.string().optional().describe('Comma-separated company ids to leave out.'),
    deadline_kind: z
      .enum(DEADLINE_KIND_FILTERS)
      .optional()
      .describe(
        'Keep companies with an open deadline of this kind: vat (moms incl. OSS/IOSS), agi (arbetsgivardeklaration), f_skatt (F-skatt and skatteinbetalning), inkomstdeklaration, arsredovisning (incl. arsstamma), any (any tax deadline).',
      ),
    deadline_within_days: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(
        'Keep companies whose deadline (of deadline_kind, else the next of any kind) is due within N days, overdue included.',
      ),
    min_unbooked: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Keep companies with at least this many unbooked bank transactions.'),
    min_inbox: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Keep companies with at least this many unconsumed inbox documents.'),
  })
  .superRefine((val, issueCtx) => {
    if (val.companies !== undefined && val.team === 'true') {
      issueCtx.addIssue({
        code: 'custom',
        path: ['team'],
        message: 'team=true cannot be combined with an explicit companies list',
      })
    }
  })

const Deadline = z.object({
  title: z.string(),
  due_date: z.string(),
  tax_deadline_type: z.string().nullable(),
  urgency: z.enum(['overdue', 'action_needed', 'upcoming']),
})

const PortfolioCompany = z.object({
  company_id: z.string().uuid(),
  name: z.string(),
  org_number: z.string().nullable(),
  entity_type: z.string().nullable(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  team_id: z.string().uuid().nullable(),
  unbooked_count: z.number().int(),
  inbox_count: z.number().int(),
  next_deadline: Deadline.nullable(),
  last_booked_date: z.string().nullable(),
  deadlines: z.array(Deadline),
})

const PortfolioOverviewData = z.object({
  team: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  scope: z.object({
    truncated: z.boolean(),
    remaining_company_ids: z.array(z.string().uuid()),
    unresolved: z.array(z.string()),
  }),
  summary: z.object({
    companies: z.number().int(),
    matched: z.number().int(),
    unbooked_total: z.number().int(),
    inbox_total: z.number().int(),
    overdue: z.number().int(),
    action_needed: z.number().int(),
  }),
  companies: z.array(PortfolioCompany),
})

const PortfolioOverviewResponse = dataEnvelope(PortfolioOverviewData)

registerEndpoint({
  operation: 'portfolio.overview',
  method: 'GET',
  path: '/api/v1/portfolio/overview',
  summary: 'Cross-company overview: unbooked, inbox and next deadline per company the key can reach.',
  description:
    'One read over many companies: for every company in scope, the unbooked bank transactions, ' +
    'the unconsumed inbox documents, the next open deadline with its urgency, the latest booked ' +
    'date and the open deadlines (earliest first, at most 10). Rows are urgency-sorted: overdue ' +
    'deadline first, then the largest unbooked pile. The scope is every non-archived company the ' +
    'key user is a member of (default), the key user\'s byrå team (team=true), or an explicit ' +
    'comma-separated companies list; exclude removes ids from any of them. The scope is capped at ' +
    `${SCOPE_MAX_COMPANIES} companies per call: scope.truncated says so and scope.remaining_company_ids ` +
    'lists the rest so the next call can pass them as companies. The filters (deadline_kind, ' +
    'deadline_within_days, min_unbooked, min_inbox) narrow the rows; summary.companies is the scope ' +
    'size and summary.matched the rows left.',
  useWhen:
    'The key reaches several companies and you need to know where to work first: which companies have VAT due this week, who has unbooked transactions piling up, whose inbox is waiting.',
  doNotUseFor:
    'A single company (GET /api/v1/companies/{companyId} plus its per-resource lists), or discovering company ids: GET /api/v1/companies lists them without the numbers.',
  pitfalls: [
    'Unknown, archived or non-member ids in companies do not fail the call: they come back in scope.unresolved with a 200. Check it before trusting an empty result.',
    'team=true with no byrå team returns an empty scope and team: null, not an error. A byrå member without client companies also gets an empty scope, with team set.',
    `More than ${SCOPE_MAX_COMPANIES} companies in scope: the response is truncated (scope.truncated) and scope.remaining_company_ids carries the ids beyond the cap. Call again with companies=<those ids>.`,
    'deadline_kind matches deadlines.tax_deadline_type, so custom deadlines (no tax type) never match a kind; deadline_within_days alone looks at the next deadline of any kind, custom included.',
    'next_deadline is the earliest open deadline of ANY kind even when deadline_kind is set; read deadlines[] for the one that matched.',
    'Counts follow the same predicates as the app (unbooked: is_business unset and not ignored; inbox: a document that has become nothing yet), so they equal what the user sees in Att göra.',
  ],
  example: {
    response: {
      data: {
        team: { id: '2a7a9e8c-4c2e-4a68-9a1a-4f0f6f3f2a10', name: 'Siffra Redovisning' },
        scope: { truncated: false, remaining_company_ids: [], unresolved: [] },
        summary: {
          companies: 2,
          matched: 2,
          unbooked_total: 14,
          inbox_total: 3,
          overdue: 1,
          action_needed: 0,
        },
        companies: [
          {
            company_id: '8fd5b1f4-0000-4000-8000-000000000001',
            name: 'Acme AB',
            org_number: '556677-8899',
            entity_type: 'aktiebolag',
            role: 'member',
            team_id: '2a7a9e8c-4c2e-4a68-9a1a-4f0f6f3f2a10',
            unbooked_count: 11,
            inbox_count: 3,
            next_deadline: {
              title: 'Momsdeklaration',
              due_date: '2026-09-12',
              tax_deadline_type: 'moms_quarterly',
              urgency: 'overdue',
            },
            last_booked_date: '2026-08-28',
            deadlines: [
              {
                title: 'Momsdeklaration',
                due_date: '2026-09-12',
                tax_deadline_type: 'moms_quarterly',
                urgency: 'overdue',
              },
              {
                title: 'Arbetsgivardeklaration',
                due_date: '2026-10-12',
                tax_deadline_type: 'arbetsgivardeklaration',
                urgency: 'upcoming',
              },
            ],
          },
          {
            company_id: '8fd5b1f4-0000-4000-8000-000000000002',
            name: 'Beta Konsult',
            org_number: null,
            entity_type: 'enskild_firma',
            role: 'member',
            team_id: '2a7a9e8c-4c2e-4a68-9a1a-4f0f6f3f2a10',
            unbooked_count: 3,
            inbox_count: 0,
            next_deadline: null,
            last_booked_date: '2026-09-15',
            deadlines: [],
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: Query },
  response: { success: PortfolioOverviewResponse },
})

/** "a, b,,c" to ['a', 'b', 'c']: trimmed, empty fragments dropped. */
function splitIds(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

function serializeDeadline(deadline: ClientDeadline) {
  return {
    title: deadline.title,
    due_date: deadline.dueDate,
    tax_deadline_type: deadline.taxDeadlineType,
    urgency: deadline.urgency,
  }
}

function serializeRow(row: PortfolioCompanyRow) {
  return {
    company_id: row.companyId,
    name: row.name,
    org_number: row.orgNumber,
    entity_type: row.entityType,
    role: row.role,
    team_id: row.teamId,
    unbooked_count: row.unbookedCount,
    inbox_count: row.inboxCount,
    next_deadline: row.nextDeadline ? serializeDeadline(row.nextDeadline) : null,
    last_booked_date: row.lastBookedDate,
    deadlines: (row.deadlines ?? []).map(serializeDeadline),
  }
}

export const GET = withApiV1('portfolio.overview', async (request, ctx) => {
  const url = new URL(request.url)
  const parsed = Query.safeParse({
    companies: url.searchParams.get('companies') ?? undefined,
    team: url.searchParams.get('team') ?? undefined,
    exclude: url.searchParams.get('exclude') ?? undefined,
    deadline_kind: url.searchParams.get('deadline_kind') ?? undefined,
    deadline_within_days: url.searchParams.get('deadline_within_days') ?? undefined,
    min_unbooked: url.searchParams.get('min_unbooked') ?? undefined,
    min_inbox: url.searchParams.get('min_inbox') ?? undefined,
  })
  if (!parsed.success) return v1ValidationError(ctx, parsed.error)
  const query = parsed.data

  // A malformed id is a client bug, so it is a 400 here; an id that is
  // well-formed but not one of the caller's companies is reported in
  // scope.unresolved by the resolver instead (callers decide).
  const companyIds = splitIds(query.companies)
  const excludeIds = splitIds(query.exclude)
  const malformed = [
    ...companyIds.filter((id) => !isUuid(id)).map((id) => ({ field: 'companies', id })),
    ...excludeIds.filter((id) => !isUuid(id)).map((id) => ({ field: 'exclude', id })),
  ]
  if (malformed.length > 0) {
    return v1ValidationError(ctx, {
      issues: malformed.map(({ field, id }) => ({
        path: [field],
        message: `Not a company id (UUID expected): ${id}`,
      })),
    })
  }

  const selector: CompanyScopeSelector =
    query.companies !== undefined ? companyIds : query.team === 'true' ? 'team' : 'all'

  const filters: PortfolioOverviewFilters = {}
  if (query.deadline_kind !== undefined) filters.deadlineKind = query.deadline_kind
  if (query.deadline_within_days !== undefined) {
    filters.deadlineWithinDays = query.deadline_within_days
  }
  if (query.min_unbooked !== undefined) filters.minUnbooked = query.min_unbooked
  if (query.min_inbox !== undefined) filters.minInbox = query.min_inbox

  const scope = await resolveCompanyScope(ctx.supabase, ctx.userId, {
    companies: selector,
    ...(excludeIds.length > 0 ? { exclude: excludeIds } : {}),
    // Per-key company allowlist: a restricted key never sees a company it was
    // not issued for, whatever the selector says.
    ...(ctx.allowedCompanyIds ? { restrictTo: ctx.allowedCompanyIds } : {}),
  })
  const overview = await fetchPortfolioOverview(ctx.supabase, scope, filters)

  return ok(
    {
      team: overview.team,
      scope: {
        truncated: scope.truncated,
        remaining_company_ids: scope.remainingCompanyIds,
        unresolved: scope.unresolved,
      },
      summary: overview.summary,
      companies: overview.companies.map(serializeRow),
    },
    { requestId: ctx.requestId },
  )
})

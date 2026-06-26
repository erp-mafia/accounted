/**
 * /api/v1/companies/{companyId}/salary-runs — list + create salary runs.
 *
 * GET   — list with filters (period_year, status). Cursor pagination on
 *         (created_at ASC, id ASC).
 * POST  — create a new monthly salary run. New runs start in `draft` status.
 *         The line items and per-employee calculations are populated by
 *         POST /salary-runs/{id}/calculate. Idempotent (mandatory Idempotency-Key).
 *         Dry-runnable.
 *
 * The `(company_id, period_year, period_month)` tuple is uniquely indexed at
 * the DB layer; duplicate creation returns 409 SALARY_RUN_DUPLICATE_PERIOD.
 */

import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { CreateSalaryRunSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'

const SalaryRunStatus = z.enum(['draft', 'review', 'approved', 'paid', 'booked', 'corrected'])

const SalaryRunSummary = z.object({
  id: z.string().uuid(),
  period_year: z.number().int(),
  period_month: z.number().int(),
  payment_date: z.string(),
  status: SalaryRunStatus,
  voucher_series: z.string(),
  total_gross: z.number(),
  total_tax: z.number(),
  total_net: z.number(),
  total_avgifter: z.number(),
  total_employer_cost: z.number(),
  agi_generated_at: z.string().nullable(),
  agi_submitted_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  booked_at: z.string().nullable(),
  created_at: z.string(),
})

const SalaryRunsListResponse = listEnvelope(SalaryRunSummary)

const SALARY_RUN_SUMMARY_COLUMNS =
  'id, period_year, period_month, payment_date, status, voucher_series, total_gross, total_tax, total_net, total_avgifter, total_employer_cost, agi_generated_at, agi_submitted_at, approved_at, paid_at, booked_at, created_at'

registerEndpoint({
  operation: 'salary-runs.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary-runs',
  summary: 'List salary runs.',
  description:
    'Returns salary runs in created-first order with their lifecycle status (draft|review|approved|paid|booked|corrected) and denormalised totals. Filters: ?period_year=YYYY, ?status=draft.',
  useWhen:
    'You need an overview of payroll activity — for building a list view, finding the current open run, or resolving a salary_run_id before invoking a lifecycle verb.',
  doNotUseFor:
    'Per-employee details (those live on the detail endpoint). Salary journal report (use GET /reports/salary-journal in Phase 5 PR-3).',
  pitfalls: [
    'A company has at most one salary run per (period_year, period_month). The unique constraint is at the DB layer.',
    'Totals are denormalised: they are 0 until POST /calculate runs.',
    '`corrected` status is reached via the internal /correct route (not yet exposed on v1) — Phase 5 PR-1 ships create/calculate/approve/mark-paid/book/generate-agi only.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'run_a8f1…',
          period_year: 2026,
          period_month: 5,
          payment_date: '2026-05-25',
          status: 'draft',
          voucher_series: 'A',
          total_gross: 0,
          total_tax: 0,
          total_net: 0,
          total_avgifter: 0,
          total_employer_cost: 0,
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: SalaryRunsListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'salary-runs.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const FiltersSchema = z.object({
      period_year: z.coerce.number().int().min(2020).max(2100).optional(),
      status: SalaryRunStatus.optional(),
    })
    const filtersResult = FiltersSchema.safeParse({
      period_year: url.searchParams.get('period_year') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    })
    if (!filtersResult.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: filtersResult.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const filters = filtersResult.data

    let query = ctx.supabase
      .from('salary_runs')
      .select(SALARY_RUN_SUMMARY_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (filters.period_year !== undefined) {
      query = query.eq('period_year', filters.period_year)
    }
    if (filters.status) {
      query = query.eq('status', filters.status)
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
      created_at: string
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(trimmed, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST — create salary run
// ──────────────────────────────────────────────────────────────────

const SalaryRunCreated = SalaryRunSummary.extend({
  notes: z.string().nullable(),
  calculation_params: z.unknown().nullable(),
  updated_at: z.string(),
})

const SALARY_RUN_DETAIL_COLUMNS =
  'id, period_year, period_month, payment_date, status, voucher_series, total_gross, total_tax, total_net, total_avgifter, total_vacation_accrual, total_employer_cost, salary_entry_id, avgifter_entry_id, vacation_entry_id, agi_generated_at, agi_submitted_at, calculation_params, approved_by, approved_at, paid_at, booked_at, booked_by, notes, created_at, updated_at'

registerEndpoint({
  operation: 'salary-runs.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs',
  summary: 'Create a salary run.',
  description:
    'Creates a draft salary run for the given period (period_year, period_month). The run starts empty — add employees via the internal /salary/runs/{id}/employees endpoints, then POST /salary-runs/{id}/calculate. Requires Idempotency-Key. Dry-runnable.',
  useWhen:
    'You are starting a new month\'s payroll. Use dry-run first to validate the period + voucher_series choice without committing.',
  doNotUseFor:
    'Adding employees to an existing run (that is a separate surface — see internal /salary/runs/{id}/employees for Phase 5 PR-1; promoting it to v1 is deferred to a follow-up).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Duplicate (period_year, period_month) for the same company returns 409 SALARY_RUN_DUPLICATE_PERIOD.',
    'period_month is 1–12. The DB CHECK enforces this — a 0 or 13 returns 400 VALIDATION_ERROR before reaching the DB.',
    'voucher_series defaults to "A". If the company uses a dedicated salary voucher series, set it explicitly.',
    'A newly-created run has no employees — :calculate without employees returns 400 SALARY_RUN_NO_EMPLOYEES.',
  ],
  example: {
    request: {
      period_year: 2026,
      period_month: 5,
      payment_date: '2026-05-25',
      voucher_series: 'L',
    },
    response: {
      data: {
        id: 'run_a8f1…',
        period_year: 2026,
        period_month: 5,
        payment_date: '2026-05-25',
        status: 'draft',
        voucher_series: 'L',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateSalaryRunSchema },
  response: { success: SalaryRunCreated },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'salary-runs.create',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = CreateSalaryRunSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: null,
          period_year: body.period_year,
          period_month: body.period_month,
          payment_date: body.payment_date,
          status: 'draft' as const,
          voucher_series: body.voucher_series,
          total_gross: 0,
          total_tax: 0,
          total_net: 0,
          total_avgifter: 0,
          total_vacation_accrual: 0,
          total_employer_cost: 0,
          notes: body.notes ?? null,
          calculation_params: null,
          approved_by: null,
          approved_at: null,
          paid_at: null,
          booked_at: null,
          booked_by: null,
          agi_generated_at: null,
          agi_submitted_at: null,
          created_at: null,
          updated_at: null,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('salary_runs')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        period_year: body.period_year,
        period_month: body.period_month,
        payment_date: body.payment_date,
        voucher_series: body.voucher_series,
        notes: body.notes ?? null,
        status: 'draft',
      })
      .select(SALARY_RUN_DETAIL_COLUMNS)
      .single()

    if (error) {
      // Disambiguate 23505 by constraint name. The salary_runs table has one
      // unique index today: (company_id, period_year, period_month). A future
      // migration could add another; mapping every 23505 here to
      // SALARY_RUN_DUPLICATE_PERIOD would be misleading once that happens.
      if (error.code === '23505') {
        const constraint = (error as { constraint?: string }).constraint
        if (constraint && constraint.includes('period_year')) {
          return v1ErrorResponseFromCode('SALARY_RUN_DUPLICATE_PERIOD', ctx.log, {
            requestId: ctx.requestId,
            details: {
              field: 'period',
              period_year: body.period_year,
              period_month: body.period_month,
            },
          })
        }
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    try {
      await eventBus.emit({
        type: 'salary_run.created',
        payload: {
          salaryRunId: (data as { id: string }).id,
          periodYear: body.period_year,
          periodMonth: body.period_month,
          userId: ctx.userId,
          companyId: ctx.companyId!,
        },
      })
    } catch (err) {
      ctx.log.warn('salary_run.created emit failed', err as Error)
    }

    return created(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)

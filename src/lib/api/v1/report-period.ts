/**
 * Shared helpers for v1 report endpoints.
 *
 * Most reports follow the same shape: parse `period_id` from the query
 * string, validate it as a UUID, and confirm it's a fiscal period the
 * caller's company owns before invoking the lib generator. This helper
 * centralises that pattern so each route stays at ~40 lines of business
 * logic and the validation behavior stays consistent across all reports.
 */

import { z } from 'zod'
import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { parseReportDateRange, type DateRange } from '@/lib/reports/date-range'
import { v1ErrorResponse, v1ErrorResponseFromCode } from './errors'
import type { EndpointDefinition } from './registry'
import { UUID_RE } from '@/lib/invariants/uuid'

/**
 * The query parameters loadPeriodFromQuery and parseReportDateRange read, as
 * the endpoint registry documents them (spread into a report route's
 * `request.query`). The helpers stay the parsers; these shapes describe them.
 */
export const ReportPeriodQueryShape = {
  period_id: z.string().describe('Fiscal period id (from GET /fiscal-periods). Required.'),
}

export const ReportDateRangeQueryShape = {
  from_date: z
    .string()
    .optional()
    .describe('YYYY-MM-DD, inside the fiscal period. Omit with to_date for the whole period.'),
  to_date: z
    .string()
    .optional()
    .describe('YYYY-MM-DD, inside the fiscal period and not before from_date.'),
}

/**
 * The dimension filter pair parseDimensionFilterParams reads
 * (lib/reports/dimension-filter.ts). Only the P&L-safe reports document it;
 * on any other report the query gate in withApiV1 answers 400 instead of
 * the unfiltered report.
 */
export const ReportDimensionFilterQueryShape = {
  dim_no: z
    .string()
    .optional()
    .describe('SIE dimension number to filter on: "1" kostnadsställe, "6" projekt, 20+ custom. Send with dim_code.'),
  dim_code: z.string().optional().describe('The dimension value code, e.g. "P001". Send with dim_no.'),
}

export interface FiscalPeriodRow {
  id: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

export type PeriodResult =
  | { ok: true; period: FiscalPeriodRow }
  | { ok: false; response: Response }

/**
 * Parse + validate `period_id` from the URL's query string, then load the
 * matching `fiscal_periods` row scoped to the caller's company. Returns
 * either the row (success) or a pre-built error response (caller just
 * returns it).
 *
 * Why a tight helper: every report endpoint does this same 4-step dance
 * (parse query, validate UUID, fetch period, 404 on miss). Pulling it
 * out reduces each route to its actual business logic.
 */
export async function loadPeriodFromQuery(
  request: Request,
  ctx: {
    supabase: SupabaseClient
    companyId: string
    requestId: string
    log: Logger
  },
): Promise<PeriodResult> {
  const url = new URL(request.url)
  const periodId = url.searchParams.get('period_id')

  if (!periodId) {
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'period_id', message: 'period_id query parameter is required.' },
      }),
    }
  }

  if (!UUID_RE.test(periodId)) {
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'period_id', message: 'period_id must be a UUID.' },
      }),
    }
  }

  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, is_closed, locked_at')
    .eq('id', periodId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      response: await v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId }),
    }
  }
  if (!data) {
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'fiscal_period', id: periodId },
      }),
    }
  }

  return { ok: true, period: data as FiscalPeriodRow }
}

export type QueryParamsResult = { ok: true } | { ok: false; response: Response }

/**
 * Reject unknown query parameters instead of silently ignoring them.
 *
 * Report endpoints historically dropped anything they didn't read, so an
 * agent passing a misspelled or unsupported parameter (e.g. `from=` instead
 * of `from_date=`) got a full-period report back with no signal that its
 * intent was ignored. For date-scoped financial reports that's dangerous:
 * the caller believes it holds a January-July resultatrapport when it holds
 * the whole year. Scoped to the report routes that opt in; not a global v1
 * behavior change.
 */
// Params the withApiV1 wrapper itself reads on every request; a route-level
// allowlist must never reject them.
const WRAPPER_PARAMS = ['dry_run']

export async function assertKnownQueryParams(
  request: Request,
  allowed: readonly string[],
  ctx: { requestId: string; log: Logger },
): Promise<QueryParamsResult> {
  const url = new URL(request.url)
  const unknown = [...new Set(url.searchParams.keys())].filter(
    (k) => !allowed.includes(k) && !WRAPPER_PARAMS.includes(k),
  )
  if (unknown.length === 0) return { ok: true }
  return {
    ok: false,
    response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: {
        unknown_params: unknown,
        allowed_params: [...allowed],
        message: `Unknown query parameter(s): ${unknown.join(', ')}. Unknown parameters are rejected rather than silently ignored.`,
      },
    }),
  }
}

/**
 * Operation-id prefixes whose GET doors serve a report or a report file (the
 * SIE import lease keys on `reports.` the same way, lib/import/sie-period-read.ts).
 */
const REPORT_OPERATION_PREFIXES = ['reports.', 'arsredovisning.'] as const

/**
 * True for a read of a report: withApiV1 runs the report query gate
 * (assertReportQuery) on it before the handler.
 */
export function isReportRead(method: string, operation: string): boolean {
  return method === 'GET' && REPORT_OPERATION_PREFIXES.some((prefix) => operation.startsWith(prefix))
}

/**
 * Every spelling of "filter by dimension" the product accepts: the pair the
 * report routes parse (dim_no + dim_code, lib/reports/dimension-filter.ts)
 * and the names the MCP tools and journal lines use for the same intent
 * (dimensions, and the kostnadsställe/projekt aliases cost_center, project).
 * On a report that does not register one of them it is refused, never
 * dropped: dropping it answers the unfiltered report, which the caller then
 * takes for the filtered one (?dim_no=6&dim_code=P001 on the trial balance).
 */
export const DIMENSION_FILTER_QUERY_PARAMS: readonly string[] = ['dim_no', 'dim_code', 'dimensions', 'cost_center', 'project']

/**
 * Full strictness for report reads: when true, EVERY query parameter a
 * report does not register is refused with 400. Off by default because
 * integrations in production may send parameters nobody can see, and a new
 * 400 breaks them without warning (the 2026-08-25 MCP strictness change
 * took an integration down for a week). While off, only a misplaced
 * dimension filter is refused; any other stray parameter is served and
 * named in the X-Ignored-Query-Params response header. Flipping it is a
 * founder call, made after API users have been told.
 */
export const STRICT_REPORT_QUERY_PARAMS = false

/** Response header naming the query parameters a report did not apply. */
export const IGNORED_QUERY_PARAMS_HEADER = 'X-Ignored-Query-Params'

export interface ReportQueryVerdict {
  /** Refused with 400: the request is not served. */
  refused: string[]
  /** Not registered but served anyway; named in IGNORED_QUERY_PARAMS_HEADER. */
  ignored: string[]
}

/**
 * Sort a report read's unregistered query parameters into refused and
 * ignored. `dry_run` belongs to the wrapper and is never either.
 */
export function reportQueryVerdict(
  searchParams: URLSearchParams,
  registered: readonly string[],
  options: { strict: boolean },
): ReportQueryVerdict {
  const unregistered = [...new Set(searchParams.keys())].filter(
    (k) => !registered.includes(k) && !WRAPPER_PARAMS.includes(k),
  )
  if (options.strict) return { refused: unregistered, ignored: [] }
  return {
    refused: unregistered.filter((k) => DIMENSION_FILTER_QUERY_PARAMS.includes(k)),
    ignored: unregistered.filter((k) => !DIMENSION_FILTER_QUERY_PARAMS.includes(k)),
  }
}

/**
 * The report query gate withApiV1 runs on every report read, against the
 * query the endpoint registers. A refusal is the same VALIDATION_ERROR
 * envelope assertKnownQueryParams answers (unknown_params + allowed_params).
 */
export async function assertReportQuery(
  request: Request,
  registered: readonly string[],
  ctx: { requestId: string; log: Logger },
  options: { strict: boolean },
): Promise<{ ok: true; ignored: string[] } | { ok: false; response: Response }> {
  const verdict = reportQueryVerdict(new URL(request.url).searchParams, registered, options)
  if (verdict.refused.length === 0) return { ok: true, ignored: verdict.ignored }
  const names = verdict.refused.join(', ')
  return {
    ok: false,
    response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: {
        unknown_params: verdict.refused,
        allowed_params: [...registered],
        message: options.strict
          ? `Unknown query parameter(s): ${names}. Unknown parameters are rejected rather than silently ignored.`
          : `This report takes no dimension filter (${names}). It is refused rather than ignored, so the answer is never an unfiltered report taken for a filtered one; income-statement, general-ledger, monthly-breakdown and kpi accept dim_no + dim_code.`,
      },
    }),
  }
}

/**
 * The query parameters an endpoint registers in `request.query`: what the
 * OpenAPI spec publishes and, pinned by query-params-registered.test.ts,
 * exactly what the route reads. Null when there is nothing reliable to check
 * against (no registration, or a query schema that is not an object).
 */
export function registeredQueryParams(def: EndpointDefinition | undefined): string[] | null {
  if (!def) return null
  const query = def.request?.query
  if (!query) return []
  return query instanceof z.ZodObject ? Object.keys(query.shape) : null
}

export type RangeResult =
  | { ok: true; range: DateRange }
  | { ok: false; response: Response }

/**
 * Parse the optional `from_date` / `to_date` (and, when `asOfAlias` is set,
 * `as_of` as an alias for `to_date`: the natural vocabulary for a balance
 * position) from the query string, validated against the fiscal period via
 * the same `parseReportDateRange` the dashboard report routes use. Keeping
 * one validator means the REST surface accepts exactly the ranges the web
 * UI accepts: clamped inside the räkenskapsår, `from_date <= to_date`.
 */
export async function loadRangeFromQuery(
  request: Request,
  period: FiscalPeriodRow,
  ctx: { requestId: string; log: Logger },
  opts?: { asOfAlias?: boolean },
): Promise<RangeResult> {
  const url = new URL(request.url)
  const searchParams = new URLSearchParams(url.searchParams)

  if (opts?.asOfAlias) {
    const asOf = searchParams.get('as_of')
    if (asOf !== null) {
      if (searchParams.get('to_date') !== null) {
        return {
          ok: false,
          response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
            requestId: ctx.requestId,
            details: {
              field: 'as_of',
              message: 'Pass either as_of or to_date, not both (as_of is an alias for to_date).',
            },
          }),
        }
      }
      searchParams.set('to_date', asOf)
      searchParams.delete('as_of')
    }
  }

  const parsed = parseReportDateRange(searchParams, period)
  if (!parsed.ok) {
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { fields: ['from_date', 'to_date'], message: parsed.error },
      }),
    }
  }
  return { ok: true, range: parsed.range }
}

/**
 * Wrap a report-generator call in a try/catch that surfaces a structured
 * REPORT_GENERATION_FAILED error if the generator throws. Mirrors the
 * dashboard's pattern so any lib-layer exception becomes a clean v1
 * envelope rather than leaking the underlying error.
 */
export async function safeGenerate<T>(
  generate: () => Promise<T>,
  ctx: { log: Logger; requestId: string; reportName: string },
): Promise<{ ok: true; result: T } | { ok: false; response: NextResponse }> {
  try {
    const result = await generate()
    return { ok: true, result }
  } catch (err) {
    ctx.log.error(`${ctx.reportName} report generation failed`, err as Error)
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('REPORT_GENERATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          report: ctx.reportName,
          reason: err instanceof Error ? err.message : 'unknown',
        },
      }),
    }
  }
}

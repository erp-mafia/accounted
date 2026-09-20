/**
 * GET    /api/v1/companies/{companyId}/reports/vat-declaration/filings
 * POST   /api/v1/companies/{companyId}/reports/vat-declaration/filings
 * DELETE /api/v1/companies/{companyId}/reports/vat-declaration/filings
 *
 * The company's own record of which calendar VAT periods (monthly or
 * quarterly momsdeklaration) are filed (issue #2746). The record is the
 * period's completed moms deadline (lib/vat/filing-record.ts): the
 * Skatteverket kvittens cron completes it for declarations signed through
 * the connection, POST completes it for a declaration filed any other way
 * (skatteverket.se by hand, an ombud, another system). DELETE undoes a
 * manual mark; a Skatteverket-confirmed filing cannot be unmarked.
 *
 * This is local bookkeeping state, not a Skatteverket read: for what
 * Skatteverket has on file, use /skatteverket/vat-declarations.
 *
 * Operation names are `vat_filings.*`, deliberately NOT `reports.*`, although
 * the path sits beside the declaration report. withApiV1 holds every
 * `reports.*` operation behind the SIE period read lease
 * (lib/import/sie-period-read.ts) so a ledger report never reads a
 * half-imported ledger. These endpoints read and write the deadlines table
 * only; under that prefix an unfinished SIE import would refuse a filing
 * mark with a conflict for no reason.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { MarkVatFilingSchema, VatFilingPeriodSchema } from '@/lib/api/schemas'
import { vatFilingDateProblem } from '@/lib/vat/filing-record'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  listVatFilings,
  markVatPeriodFiled,
  unmarkVatPeriodFiled,
} from '@/lib/vat/filing-record-store'

const VatFilingRecordSchema = z.object({
  deadline_id: z.string().uuid(),
  period_type: z.enum(['monthly', 'quarterly']),
  year: z.number().int(),
  period: z.number().int(),
  tax_period: z.string(),
  filed_on: z.string(),
  source: z.enum(['skatteverket', 'manual']),
  reference: z.string().nullable(),
})

const MarkResponse = VatFilingRecordSchema.extend({
  /** True when the company had no deadline row for the period and one was created. */
  created: z.boolean(),
  /** False when the period was already confirmed at Skatteverket and left unchanged. */
  changed: z.boolean(),
})

const UnmarkResponse = z.object({
  deadline_id: z.string().uuid(),
  unmarked: z.literal(true),
})

const FILING_ERROR_CODES = [
  'VALIDATION_ERROR',
  'VAT_FILING_PERIOD_NOT_ENDED',
  'VAT_FILING_DATE_BEFORE_PERIOD_END',
  'VAT_FILING_DATE_IN_FUTURE',
]

registerEndpoint({
  operation: 'vat_filings.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/vat-declaration/filings',
  summary: 'List the calendar VAT periods the company has recorded as filed.',
  description:
    'Returns every monthly or quarterly momsdeklaration period the company has on record as filed, newest first. `source` is `skatteverket` when the filing was confirmed by a Skatteverket kvittens through the connection, `manual` when a person or an API caller recorded it (POST on this path, or completing the period\'s moms deadline). `reference` is the Skatteverket reference typed at manual marking, if any. Local state: not a Skatteverket read.',
  useWhen:
    'Deciding which VAT period is next to prepare, checking whether a period was already filed before recomputing it, or reconciling a filing calendar against the books.',
  doNotUseFor:
    'Reading what Skatteverket actually has on file (use /skatteverket/vat-declarations) or computing the declaration figures (use /reports/vat-declaration).',
  pitfalls: [
    'Helårsmoms (yearly) periods are not listed: their deadline is labelled per räkenskapsår and is completed from the calendar.',
    'An empty list means nothing is recorded, not that nothing was filed: companies that file on skatteverket.se by hand only get records when they mark the period (POST here or in the app).',
  ],
  example: {
    response: {
      data: [
        {
          deadline_id: '11111111-1111-4111-8111-111111111111',
          period_type: 'quarterly',
          year: 2026,
          period: 2,
          tax_period: '2026-Q2',
          filed_on: '2026-08-10',
          source: 'manual',
          reference: null,
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(z.array(VatFilingRecordSchema)) },
})

registerEndpoint({
  operation: 'vat_filings.mark',
  method: 'POST',
  path: '/api/v1/companies/:companyId/reports/vat-declaration/filings',
  summary: 'Record that a VAT period was filed outside the Skatteverket connection.',
  description:
    'Marks a monthly or quarterly momsdeklaration period as filed on `filed_on` (Swedish calendar date), optionally with Skatteverket\'s `reference` (kvittensnummer). Completes the period\'s moms deadline with status `submitted`, creating the deadline row when the company has none for the period. Nothing is sent to Skatteverket. Idempotent: marking an already-marked period updates its date and reference; a period already confirmed at Skatteverket is returned unchanged (`changed: false`). Dry-runnable.',
  useWhen:
    'The declaration was filed on skatteverket.se by hand, by an ombud, or from another system, and the books should know the period is done so the next period opens by default.',
  doNotUseFor:
    'Filing the declaration itself: that is the BankID-signed flow (accounted_vat_declaration_submit / the Skatteverket panel). Yearly (helårsmoms) periods: complete the calendar deadline instead.',
  pitfalls: [
    'The period must have ended and `filed_on` must fall after the period\'s last day and no later than today (Swedish date): otherwise 400 with VAT_FILING_PERIOD_NOT_ENDED, VAT_FILING_DATE_BEFORE_PERIOD_END or VAT_FILING_DATE_IN_FUTURE.',
    'Omitting `reference` keeps a previously stored reference; pass null to clear it.',
    'This records a fact about the books, it does not verify anything at Skatteverket. Use /skatteverket/vat-declarations to check what was actually received.',
  ],
  example: {
    request: { period_type: 'quarterly', year: 2026, period: 2, filed_on: '2026-08-10', reference: 'ABC123' },
    response: {
      data: {
        deadline_id: '11111111-1111-4111-8111-111111111111',
        period_type: 'quarterly',
        year: 2026,
        period: 2,
        tax_period: '2026-Q2',
        filed_on: '2026-08-10',
        source: 'manual',
        reference: 'ABC123',
        created: false,
        changed: true,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: MarkVatFilingSchema },
  response: { success: dataEnvelope(MarkResponse), errorCodes: FILING_ERROR_CODES },
})

registerEndpoint({
  operation: 'vat_filings.unmark',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/reports/vat-declaration/filings',
  summary: 'Undo a manual "filed" mark on a VAT period.',
  description:
    'Puts the period\'s moms deadline back to pending and removes the stored reference. Query params: period_type (monthly|quarterly), year, period. A period confirmed at Skatteverket through the connection is refused with 409 VAT_FILING_CONFIRMED_BY_SKATTEVERKET; a period with no filing record answers 404 VAT_FILING_NOT_FOUND. Dry-runnable.',
  useWhen: 'A period was marked as filed by mistake.',
  doNotUseFor:
    'Withdrawing or correcting a declaration at Skatteverket: that is a new declaration for the same period, filed through the ordinary flow.',
  pitfalls: [
    'Only manual marks can be undone; a Skatteverket kvittens is a fact this endpoint does not erase.',
  ],
  example: {
    request: { period_type: 'quarterly', year: 2026, period: 2 },
    response: {
      data: { deadline_id: '11111111-1111-4111-8111-111111111111', unmarked: true },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { query: VatFilingPeriodSchema },
  response: {
    success: dataEnvelope(UnmarkResponse),
    errorCodes: ['VALIDATION_ERROR', 'VAT_FILING_NOT_FOUND', 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET'],
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'vat_filings.list',
  async (_request, ctx) => {
    try {
      const records = await listVatFilings(ctx.supabase, ctx.companyId!)
      return ok(records, { requestId: ctx.requestId })
    } catch (err) {
      ctx.log.error('vat_filings.list failed', err as Error)
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'vat_filings.mark',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      rawBody = null
    }
    const parsed = MarkVatFilingSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data
    const input = {
      periodType: body.period_type,
      year: body.year,
      period: body.period,
      filedOn: body.filed_on,
    }

    if (ctx.dryRun) {
      // Same date rules as the write, so a dry run reports the refusal the
      // real call would give, without touching the deadline row.
      const problem = vatFilingDateProblem(input, todayIsoStockholm())
      if (problem) {
        return v1ErrorResponseFromCode(problem, ctx.log, { requestId: ctx.requestId })
      }
      return dryRunPreview(
        { would_mark: { ...body, reference: body.reference ?? null } },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      const result = await markVatPeriodFiled(ctx.supabase, ctx.companyId!, {
        ...input,
        reference: body.reference,
        userId: ctx.userId,
      })
      if (!result.ok) {
        return v1ErrorResponseFromCode(result.code, ctx.log, { requestId: ctx.requestId })
      }
      return ok(
        { ...result.record, created: result.created, changed: result.changed },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      ctx.log.error('vat_filings.mark failed', err as Error)
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)

export const DELETE = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'vat_filings.unmark',
  async (request, ctx) => {
    const url = new URL(request.url)
    const parsed = VatFilingPeriodSchema.safeParse({
      period_type: url.searchParams.get('period_type') ?? undefined,
      year: url.searchParams.get('year') ?? undefined,
      period: url.searchParams.get('period') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const query = parsed.data
    const input = { periodType: query.period_type, year: query.year, period: query.period }

    if (ctx.dryRun) {
      return dryRunPreview({ would_unmark: query }, { requestId: ctx.requestId, log: ctx.log })
    }

    try {
      const result = await unmarkVatPeriodFiled(ctx.supabase, ctx.companyId!, input)
      if (!result.ok) {
        return v1ErrorResponseFromCode(result.code, ctx.log, { requestId: ctx.requestId })
      }
      return ok(
        { deadline_id: result.deadline_id, unmarked: true as const },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      ctx.log.error('vat_filings.unmark failed', err as Error)
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)

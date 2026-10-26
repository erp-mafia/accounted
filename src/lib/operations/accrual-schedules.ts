/**
 * Accrual schedule (periodisering) operations: re-plan the months not yet
 * posted. One definition behind v1 (POST
 * /accrual-schedules/{id}/replan), the staged MCP tool
 * gnubok_replan_accrual_schedule and the dashboard's PATCH
 * /api/bookkeeping/accruals/{id}; the rules live in
 * replanRemainingInstallments (lib/bookkeeping/accruals/service.ts).
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { replanRemainingInstallments } from '@/lib/bookkeeping/accruals/service'
import { defineOperation } from './types'

const META_EXAMPLE = { request_id: 'req_…', api_version: '2026-05-12' }

/** The re-plan fields: the operation's input and the dashboard route's body. */
export const ReplanAccrualFields = z.object({
  period_end: saneIsoDateSchema.optional().describe('New last day of the period, YYYY-MM-DD. Unchanged when omitted.'),
  release_day: z
    .number()
    .int()
    .min(1)
    .max(31)
    .nullable()
    .optional()
    .describe('Day of the month each month books on (1-31, 31 = last day), null for the first. Unchanged when omitted.'),
})

export const replanChangesSomething = (body: { period_end?: unknown; release_day?: unknown }): boolean =>
  body.period_end !== undefined || body.release_day !== undefined

export const REPLAN_NEEDS_A_CHANGE = {
  message: 'Ange ett nytt slutdatum, en ny bokföringsdag eller båda.',
  path: ['period_end'],
}

const ReplanMonth = z.object({
  period_month: z.string().describe('First day of the month, YYYY-MM-01.'),
  amount: z.number().describe('SEK the month dissolves.'),
  booking_date: z.string().describe('The day the month books on.'),
})

const ReplanResult = z.object({
  accrual_schedule_id: z.string().uuid(),
  period_start: z.string(),
  period_end_before: z.string(),
  period_end_after: z.string(),
  release_day_before: z.number().int().nullable(),
  release_day_after: z.number().int().nullable(),
  remaining_amount: z.number(),
  before: z.array(ReplanMonth),
  after: z.array(ReplanMonth),
  posted_now: z.number().int().optional(),
})

export const accrualSchedulesReplan = defineOperation({
  id: 'accrual-schedules.replan',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Re-plan the months of a periodisering that are not yet posted: a new period end and/or the day each month books on.',
    description:
      'Ändra periodisering. Posted months and their verifikat stay exactly as they are; what remains (total minus posted) is split equally over the calendar months of the new period that have no posted month, the same split a new schedule gets. release_day sets the day each month books on (1-31, clamped to the month end, so 31 is the last day; null is the first of the month). Months whose day has already come are booked at once. A deferral only (förutbetald kostnad 17xx, förutbetald intäkt 29xx): an upplupen kostnad is refused. Dry-runnable: the dry run answers the months before and after and writes nothing.',
    useWhen:
      'The service period of a periodiserad invoice line changed (a contract ends early or runs longer), or the months should book on the day the period starts, e.g. the 14th for a rent running 14th to 13th.',
    doNotUseFor:
      'Changing months already posted (correct those verifikat, or credit the invoice), booking the whole remainder now (Lös upp nu), or an upplupen kostnad on 29xx.',
    pitfalls: [
      'period_end must be on or after the last posted month and leave at least one unposted month: 400 ACCRUAL_REPLAN_INVALID with details.reason otherwise.',
      'A schedule a credit is still settling (cancelled months) or that is not active cannot be re-planned.',
      'A month the posting run books between the dry run and the commit makes the commit answer 409 ACCRUAL_REPLAN_CONFLICT: re-read and retry.',
    ],
    example: {
      request: { period_end: '2027-06-30', release_day: 14 },
      response: {
        data: {
          accrual_schedule_id: '7f3c…',
          period_start: '2026-07-01',
          period_end_before: '2026-12-31',
          period_end_after: '2027-06-30',
          release_day_before: null,
          release_day_after: 14,
          remaining_amount: 4000,
          before: [{ period_month: '2026-11-01', amount: 2000, booking_date: '2026-11-01' }],
          after: [{ period_month: '2026-11-01', amount: 500, booking_date: '2026-11-14' }],
          posted_now: 0,
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z
    .object({
      accrual_schedule_id: z
        .string()
        .uuid()
        .describe('The schedule id, from gnubok_list_accrual_schedules or GET /api/bookkeeping/accruals.'),
      ...ReplanAccrualFields.shape,
    })
    .refine(replanChangesSomething, REPLAN_NEEDS_A_CHANGE),
  output: ReplanResult,
  errorCodes: [
    'ACCRUAL_NOT_FOUND',
    'ACCRUAL_NOT_ACTIVE',
    'ACCRUAL_REPLAN_INVALID',
    'ACCRUAL_REPLAN_CONFLICT',
    'ACCRUAL_REPLAN_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/accrual-schedules/:id/replan',
    pathParams: { id: 'accrual_schedule_id' },
  },
  mcp: {
    name: 'gnubok_replan_accrual_schedule',
    title: 'Replan Accrual Schedule (Ändra Periodisering)',
    description:
      'Stage a re-plan of a periodisering\'s months not yet posted: a new period end and/or the day each month books on. Posted months stay; the rest is split equally. Deferrals only. Schedule ids: gnubok_list_accrual_schedules.',
    keywords: ['periodisering', 'ändra periodisering', 'periodiseringsplan', 'förutbetald kostnad', 'förutbetald intäkt', 'bokföringsdag', 'upplösning'],
    stage: { pendingType: 'replan_accrual_schedule', title: () => 'Ändra periodisering' },
  },
  run: async (ctx, { accrual_schedule_id, period_end, release_day }, { dryRun }) =>
    replanRemainingInstallments(
      ctx,
      accrual_schedule_id,
      {
        ...(period_end !== undefined ? { periodEnd: period_end } : {}),
        ...(release_day !== undefined ? { releaseDay: release_day } : {}),
      },
      { dryRun },
    ),
})

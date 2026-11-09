/**
 * Accrual schedule (periodisering) operations: re-plan the months not yet
 * posted, and create or undo a periodisering set up by hand. Each is one
 * definition behind v1, its staged MCP tool and the dashboard route; the
 * rules live in replanRemainingInstallments (lib/bookkeeping/accruals/service.ts)
 * and lib/bookkeeping/accruals/manual.ts.
 */
import { z } from 'zod'
import { accountNumberSchema, saneIsoDateSchema } from '@/lib/invariants/zod'
import { DEFAULT_PREPAID_EXPENSE_ACCOUNT, isInterimBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isBasResultAccount } from '@/lib/bookkeeping/result-account-ranges'
import { replanRemainingInstallments } from '@/lib/bookkeeping/accruals/service'
import { cancelManualSchedule, createManualAccrualSchedule } from '@/lib/bookkeeping/accruals/manual'
import type { AccrualSchedule } from '@/types'
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

const ManualAccrualResult = z.object({
  accrual_schedule_id: z.string().uuid(),
  source_kind: z.literal('manual'),
  direction: z.enum(['expense', 'revenue']),
  balance_account: z.string(),
  target_account: z.string(),
  total_amount: z.number(),
  period_start: z.string(),
  period_end: z.string(),
  months: z.number().int(),
  origin_journal_entry_id: z.string().uuid().nullable(),
  posting_floor_date: z.string(),
})

function manualResult(schedule: AccrualSchedule): z.infer<typeof ManualAccrualResult> {
  return {
    accrual_schedule_id: schedule.id,
    source_kind: 'manual',
    direction: schedule.direction,
    balance_account: schedule.balance_account,
    target_account: schedule.target_account,
    total_amount: Number(schedule.total_amount),
    period_start: schedule.period_start,
    period_end: schedule.period_end,
    months: schedule.months,
    origin_journal_entry_id: schedule.origin_journal_entry_id,
    posting_floor_date: schedule.posting_floor_date,
  }
}

/** The create fields: the operation's input and the dashboard route's body. */
export const CreateManualAccrualFields = z.object({
  direction: z
    .enum(['expense', 'revenue'])
    .describe('expense: a cost (förutbetald kostnad on 17xx, upplupen kostnad on 29xx); revenue: förutbetald intäkt on 29xx, upplupen intäkt on 17xx.'),
  amount_sek: z
    .number()
    .positive()
    .max(99999999)
    .describe('What remains to spread, in SEK: for a migrated or half-dissolved item, the balance left on the account, not the original amount.'),
  balance_account: accountNumberSchema
    .refine(isInterimBalanceAccount, 'Balanskontot måste vara ett 17xx- eller 29xx-konto.')
    .describe('The interim account the amount sits on, 17xx or 29xx.'),
  target_account: accountNumberSchema
    .refine(isBasResultAccount, 'Resultatkontot måste vara ett konto i klass 3-8.')
    .describe('The resultatkonto each month dissolves to, 3xxx-8xxx.'),
  period_start: saneIsoDateSchema.describe('The first month not yet dissolved, YYYY-MM-DD (any day of the month).'),
  months: z.number().int().min(1).max(120).optional().describe('Number of months, 1-120. Give this or period_end.'),
  period_end: saneIsoDateSchema.optional().describe('The last month, YYYY-MM-DD. Give this or months.'),
  description: z.string().trim().min(1).max(500),
  dimensions: z.record(z.string(), z.string()).optional(),
  origin_journal_entry_id: z
    .string()
    .uuid()
    .optional()
    .describe('The posted verifikat that put the amount on balance_account. Omit when it came with the ingående balans.'),
})

export const createNamesPeriod = (input: { months?: unknown; period_end?: unknown }): boolean =>
  input.months !== undefined || input.period_end !== undefined

export const CREATE_NEEDS_A_PERIOD = { message: 'Ange antal månader eller ett slutdatum.', path: ['months'] }

// The docs example: an annual bank fee paid in January on the prepaid
// account, half of it already released.
const EXAMPLE_BALANCE_ACCOUNT = DEFAULT_PREPAID_EXPENSE_ACCOUNT
const EXAMPLE_TARGET_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'payment_fees')

export const accrualSchedulesCreate = defineOperation({
  id: 'accrual-schedules.create',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Create a periodisering by hand for an amount on 17xx/29xx that no invoice line in Accounted carries, with monthly catch-up.',
    description:
      'Ny periodisering. Spreads amount_sek over calendar months with the same installments and catch-up as an invoice plan. For a deferral (förutbetald kostnad on 17xx, förutbetald intäkt on 29xx) amount_sek is what remains to dissolve: it may not exceed the balance left on balance_account (from its latest ingående balans on, after every month already dissolved, by Accounted, by hand or by an imported voucher from an earlier system) less the months not yet posted of other active plans on the account, nor what the origin verifikat or ingående balans put there. Start at the first month not yet dissolved. An upplupen kostnad (29xx) or intäkt (17xx) has no such limit. Months already begun post at approval; the rest post through the nightly accrual run. Dry-runnable: the dry run answers the months and available_sek and writes nothing.',
    useWhen:
      'A migration brought a running periodisering whose remaining months must keep dissolving, or a bank booking or the ingående balans put an annual insurance, licence or rent on 17xx/29xx without an invoice line in Accounted.',
    doNotUseFor: 'An invoice line in Accounted (periodisera on that line), changing an existing plan (replan it), or undoing one (cancel it).',
    pitfalls: [
      'For a migrated plan give the REMAINING amount and the first month not yet dissolved: the earlier system\'s dissolutions are already in the books, and booking a month twice is refused with 400 ACCRUAL_BALANCE_EXCEEDED (details.available_sek says what is left).',
      'Without origin_journal_entry_id a deferral comes from the ingående balans: 400 ACCRUAL_OPENING_BALANCE_MISSING when the account has none. A reversed origin is refused (ACCRUAL_ORIGIN_REVERSED).',
      'Give either months (1-120) or period_end. The amount is split in öre over every calendar month and sums exactly to amount_sek. target_account must be a resultatkonto, 3xxx-8xxx.',
      'Reversing the origin verifikat later cancels the plan and stornoes the months it posted.',
    ],
    example: {
      request: {
        direction: 'expense', amount_sek: 6000, balance_account: EXAMPLE_BALANCE_ACCOUNT,
        target_account: EXAMPLE_TARGET_ACCOUNT, period_start: '2026-07-01', months: 6,
        description: 'Årsavgift bankpaket, resterande månader', origin_journal_entry_id: '5b1e…',
      },
      response: {
        data: {
          accrual_schedule_id: '7f3c…', source_kind: 'manual', direction: 'expense', balance_account: EXAMPLE_BALANCE_ACCOUNT,
          target_account: EXAMPLE_TARGET_ACCOUNT, total_amount: 6000, period_start: '2026-07-01', period_end: '2026-12-31',
          months: 6, origin_journal_entry_id: '5b1e…', posting_floor_date: '2026-01-10',
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: CreateManualAccrualFields.strict().refine(createNamesPeriod, CREATE_NEEDS_A_PERIOD),
  output: ManualAccrualResult,
  errorCodes: [
    'ACCRUAL_PERIOD_REQUIRED', 'ACCRUAL_AMOUNT_INVALID', 'ACCRUAL_BALANCE_ACCOUNT_INVALID', 'ACCRUAL_TARGET_ACCOUNT_INVALID',
    'ACCRUAL_ORIGIN_NOT_FOUND', 'ACCRUAL_ORIGIN_REVERSED', 'ACCRUAL_ORIGIN_ACCOUNT_MISSING', 'ACCRUAL_OPENING_BALANCE_MISSING',
    'ACCRUAL_BALANCE_EXCEEDED', 'ACCRUAL_CREATE_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/accrual-schedules' },
  mcp: {
    name: 'gnubok_create_accrual_schedule',
    title: 'Create Accrual Schedule (Ny Periodisering)',
    description:
      'Stage a periodisering for an amount on 17xx/29xx no invoice line carries. For a deferral give what REMAINS on the account and the first month not yet dissolved; the dry run answers available_sek. Elapsed months post at approval.',
    keywords: ['periodisering', 'ny periodisering', 'förutbetald kostnad', 'upplupen kostnad', 'förutbetald intäkt', 'migrerad periodisering'],
    stage: { pendingType: 'create_accrual_schedule', title: (input) => `Ny periodisering: ${String(input.description)}` },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await createManualAccrualSchedule(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ...outcome, data: manualResult(outcome.data) }
  },
})

const CancelAccrualResult = z.object({
  accrual_schedule_id: z.string().uuid(),
  status: z.enum(['cancelled', 'active']),
  cancelled_months: z.number().int(),
  reversed_entries: z.number().int(),
  failed_reversals: z.number().int(),
})

export const accrualSchedulesCancel = defineOperation({
  id: 'accrual-schedules.cancel',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Undo a periodisering set up by hand: cancel its months not yet posted and storno the months it posted.',
    description:
      'Ångra periodisering. The months not yet posted are cancelled and every month the plan posted is stornoed (dated today when today lies in that month\'s fiscal year, else on the month\'s own date), so the whole amount is back on the balance account. Only a manual plan: an invoice\'s plan is cancelled by crediting the invoice. Dry-runnable: the dry run lists the months it would cancel and reverse.',
    useWhen: 'A manual periodisering was set up wrong (amount, accounts, months), or the item it spreads no longer exists.',
    doNotUseFor: 'Booking the rest now (Lös upp nu), moving the end or the booking day (replan it), or an invoice\'s plan (credit the invoice).',
    pitfalls: [
      'A month whose storno fails (a locked or closed year) keeps the plan active with failed_reversals > 0 and a last_error on the month: unlock and cancel again.',
      'Reversing the origin verifikat runs the same undo on its own.',
    ],
    example: {
      request: {},
      response: {
        data: { accrual_schedule_id: '7f3c…', status: 'cancelled', cancelled_months: 4, reversed_entries: 2, failed_reversals: 0 },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({
    accrual_schedule_id: z
      .string()
      .uuid()
      .describe('The schedule id, from gnubok_list_accrual_schedules or GET /api/bookkeeping/accruals.'),
  }),
  output: CancelAccrualResult,
  errorCodes: ['ACCRUAL_NOT_FOUND', 'ACCRUAL_NOT_ACTIVE', 'ACCRUAL_CANCEL_NOT_MANUAL', 'ACCRUAL_CANCEL_FAILED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/accrual-schedules/:id/cancel',
    pathParams: { id: 'accrual_schedule_id' },
  },
  mcp: {
    name: 'gnubok_cancel_accrual_schedule',
    title: 'Cancel Accrual Schedule (Ångra Periodisering)',
    description:
      'Stage the undo of a periodisering set up by hand: its months not yet posted are cancelled and its posted months stornoed, so the amount is back on the balance account. Not for an invoice\'s plan (credit the invoice).',
    keywords: ['periodisering', 'ångra periodisering', 'ta bort periodisering', 'makulera periodisering'],
    stage: { pendingType: 'cancel_accrual_schedule', title: () => 'Ångra periodisering' },
  },
  run: async (ctx, { accrual_schedule_id }, { dryRun }) => cancelManualSchedule(ctx, accrual_schedule_id, { dryRun }),
})

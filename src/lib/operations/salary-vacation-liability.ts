/**
 * Stäm av semesterlöneskuld per datum through the machine doors
 * (lib/salary/vacation-liability-reconcile.ts): book the difference between
 * the computed semesterlöneskuld and what 2920/2940 hold on a date without a
 * salary run. The dashboard route /api/salary/vacation-liability/reconcile
 * calls the same service.
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { reconcileVacationLiability } from '@/lib/salary/vacation-liability-reconcile'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

export const salaryVacationLiabilityReconcile = defineOperation({
  id: 'salary.vacation-liability.reconcile',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Book the semesterlöneskuld at its computed value on a date: the difference to 2920/2940 as one verifikat.',
    description:
      'Computes the vacation liability as of `as_of` per employee (unpaid vacation pay for days earned and not taken: the remaining paid days of the vacation year, sparade dagar, on the statutory April to March basis the days earned so far toward the next semesterår, and under sammalöneregeln the unpaid semesterlön of rörliga lönedelar; each day valued at the company\'s vacation_day_value convention, avgifter at each employee\'s age-tier rate) and books the difference to what 2920 and 2940 hold: 7090 (arbetare) or 7290 per employee against 2920, and 7519 against 2940, debit when the liability grows and credit when it shrinks, dated `as_of` (source_type salary_payment). The calculation behind it is stored as the verifikat\'s underlag and is what the Semesterskuld report starts from afterwards. A side whose every amount stays within 1 krona is not booked; when nothing moves, `adjusted` is false and no verifikat is created, so a repeat is harmless. Dry-runnable: the dry run answers the lines and the per-employee figures and writes nothing.',
    useWhen:
      'A month or quarter end without a salary run, when the balance sheet should carry the vacation liability as it stands (for example before a bokslut or a report to the bank).',
    doNotUseFor:
      'The yearly semesterårsavslut that rolls days into the next vacation year (POST /salary/vacation-year-close), or reading the liability without booking (GET /reports/vacation-liability).',
    pitfalls: [
      '`as_of` must not be in the future: 400 VACATION_LIABILITY_DATE_AHEAD.',
      'A closed or locked period, or a date on or before the company lock date, answers 400 PERIOD_LOCKED; no voucher number is spent.',
      'Salary runs count when they are booked and were paid on or before `as_of`, or deduct leave that ended by then. Book the month\'s run first, or reconcile as of a date before it.',
      'A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing. After a storno the report starts from the previous remeasurement or close again.',
    ],
    example: {
      request: { as_of: '2026-10-31' },
      response: {
        data: {
          as_of: '2026-10-31',
          adjusted: true,
          journal_entry_id: '9a0b…',
          voucher_series: 'K',
          voucher_number: 41,
          booked_2920: 48210,
          booked_2940: 15147.58,
          computed_liability: 60550,
          computed_avgifter: 19024.81,
          difference_2920: 12340,
          difference_2940: 3877.23,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    as_of: saneIsoDateSchema.describe('The date the liability is valued and booked at (YYYY-MM-DD), today or earlier.'),
  }),
  output: z.object({
    as_of: z.string(),
    adjusted: z.boolean().describe('False when every difference stayed within 1 krona: nothing was booked.'),
    journal_entry_id: z.string().uuid().nullable(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    booked_2920: z.number(),
    booked_2940: z.number(),
    computed_liability: z.number(),
    computed_avgifter: z.number(),
    difference_2920: z.number().describe('Computed minus booked on 2920 (positive: the books held too little).'),
    difference_2940: z.number(),
  }),
  errorCodes: [
    'VACATION_LIABILITY_DATE_AHEAD',
    'VACATION_LIABILITY_NO_FISCAL_PERIOD',
    'VACATION_LIABILITY_RECONCILE_FAILED',
    'PERIOD_LOCKED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/salary/vacation-liability/reconcile' },
  run: async (ctx, input, { dryRun }) => reconcileVacationLiability(ctx, { as_of: input.as_of }, { dryRun }),
})

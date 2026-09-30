/**
 * Räkenskapsår (fiscal year) operations: create, edit, unlock, and the
 * klarmarkera pair for migrated years (mark closed in the previous system,
 * undo that). Rules live in lib/core/bookkeeping/fiscal-year-service.ts;
 * lock, close and year-end keep their hand-written v1 routes.
 *
 * fiscal-periods.unlock has no MCP binding on purpose: gnubok_unlock_period
 * (staged as unlock_period) already serves that door, and a second tool for
 * the same verb would only split agents between two names.
 */
import { z } from 'zod'
import {
  closeFiscalPeriodExternally,
  createFiscalPeriod,
  reopenExternallyClosedFiscalPeriod,
  unlockFiscalPeriod,
  updateFiscalPeriod,
} from '@/lib/core/bookkeeping/fiscal-year-service'
import { isoDateSchema } from '@/lib/invariants/zod'
import type { FiscalPeriod as FiscalPeriodRow } from '@/types'
import { defineOperation, type OperationOutcome } from './types'

const FiscalPeriod = z.object({
  id: z.string().uuid(),
  name: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  is_closed: z.boolean(),
  closed_at: z.string().nullable(),
  closed_externally: z.boolean(),
  locked_at: z.string().nullable(),
  previous_period_id: z.string().uuid().nullable(),
  created_at: z.string(),
})

type PublicFiscalPeriod = z.infer<typeof FiscalPeriod>

/** The public columns of a period row (the row also carries user/company ids and review tokens). */
function toPublic(row: FiscalPeriodRow): PublicFiscalPeriod {
  return {
    id: row.id,
    name: row.name,
    period_start: row.period_start,
    period_end: row.period_end,
    is_closed: row.is_closed,
    closed_at: row.closed_at,
    closed_externally: row.closed_externally ?? false,
    locked_at: row.locked_at,
    previous_period_id: row.previous_period_id,
    created_at: row.created_at,
  }
}

/** Project a successful outcome's period onto the public shape; failures and previews pass through. */
function publicOutcome(outcome: OperationOutcome<FiscalPeriodRow>): OperationOutcome<PublicFiscalPeriod> {
  if (!outcome.ok || outcome.dryRun) return outcome
  return { ...outcome, data: toPublic(outcome.data) }
}

const FISCAL_PERIOD_ID = z
  .string()
  .uuid()
  .describe('The fiscal period (räkenskapsår) id, from GET /fiscal-periods.')

const PERIOD_EXAMPLE = {
  id: 'a8f1…',
  name: 'Räkenskapsår 2027',
  period_start: '2027-01-01',
  period_end: '2027-12-31',
  is_closed: false,
  closed_at: null,
  closed_externally: false,
  locked_at: null,
  previous_period_id: '5c2e…',
  created_at: '2026-12-01T09:00:00Z',
}

const META_EXAMPLE = { request_id: 'req_…', api_version: '2026-05-12' }

export const fiscalPeriodsCreate = defineOperation({
  id: 'fiscal-periods.create',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Create a fiscal year (räkenskapsår).',
    description:
      'Creates a räkenskapsår and links it into the continuity chain (previous_period_id, BFNAR 2013:2). The year must be at most 18 months, end on a month end, and start on the 1st unless it becomes the earliest year (BFL 3 kap. 1 and 3 §§). It must be contiguous with its neighbours: appended, it starts the day after the latest year ends; filling a gap, it also ends the day before the next year starts; prepended, it ends the day before the earliest year starts. A still-open prior year does not block: the 201 carries a PRIOR_FISCAL_YEAR_STILL_OPEN warning. Idempotent. Dry-runnable.',
    useWhen:
      'The company needs the next räkenskapsår to book in (e.g. January arrives), or an earlier year must exist before its SIE file or opening balances can be imported.',
    doNotUseFor:
      'Closing the prior year (run the year-end), or changing an existing year (PATCH /fiscal-periods/{id}).',
    pitfalls: [
      'A start that does not continue the preceding year answers 400 FISCAL_PERIOD_NOT_CONTIGUOUS with details.expected_start (or details.expected_end): retry with that date.',
      'Overlapping an existing year answers 409 FISCAL_PERIOD_OVERLAP.',
      'An enskild firma normally runs the calendar year; a brutet räkenskapsår needs Skatteverket\'s permission.',
      'There is no delete: a wrong year can be re-dated with PATCH only while nothing is posted in it.',
    ],
    example: {
      request: { name: 'Räkenskapsår 2027', period_start: '2027-01-01', period_end: '2027-12-31' },
      response: {
        data: { fiscal_period: PERIOD_EXAMPLE },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z
    .object({
      name: z.string().trim().min(1).max(100).describe('Display name, e.g. "Räkenskapsår 2027".'),
      period_start: isoDateSchema.describe('First day, YYYY-MM-DD.'),
      period_end: isoDateSchema.describe('Last day, YYYY-MM-DD (a month end).'),
    })
    .refine((b) => b.period_start < b.period_end, {
      message: 'period_end must be after period_start.',
      path: ['period_end'],
    }),
  output: z.object({ fiscal_period: FiscalPeriod }),
  errorCodes: [
    'FISCAL_PERIOD_INVALID_DATES',
    'FISCAL_PERIOD_START_NOT_FIRST_OF_MONTH',
    'FISCAL_PERIOD_END_NOT_MONTH_END',
    'FISCAL_PERIOD_TOO_LONG',
    'FISCAL_PERIOD_NOT_CONTIGUOUS',
    'FISCAL_PERIOD_OVERLAP',
    'FISCAL_PERIOD_CREATE_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/fiscal-periods' },
  mcp: {
    name: 'gnubok_create_fiscal_period',
    title: 'Create Fiscal Period',
    description:
      'Stage a new räkenskapsår. It must continue the chain: start the day after the latest year ends (or end the day before the earliest when backfilling), max 18 months, month-end end date. An open prior year does not block.',
    keywords: ['räkenskapsår', 'nytt räkenskapsår', 'skapa räkenskapsår', 'bokföringsår', 'nytt år', 'brutet räkenskapsår'],
    stage: { pendingType: 'create_fiscal_period', title: (input) => `Nytt räkenskapsår: ${String(input.name)}` },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await createFiscalPeriod(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ...outcome, data: { fiscal_period: toPublic(outcome.data.fiscal_period) } }
  },
})

export const fiscalPeriodsUpdate = defineOperation({
  id: 'fiscal-periods.update',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Rename or re-date an open fiscal year.',
    description:
      'Sparse update of an open, unlocked räkenskapsår: name, period_start, period_end. The name can change at any time on an open year; the dates only while no posted or reversed verifikat exist in it. New dates follow the same BFL 3 kap. rules as create (18-month cap, month-end end, 1st-of-month start unless it is the earliest year, calendar year for an enskild firma) and may not overlap another year. Idempotent. Dry-runnable.',
    useWhen: 'A year was created with the wrong dates or name and nothing has been booked in it yet.',
    doNotUseFor:
      'Moving verifikat between years, changing a locked or closed year, or lengthening a year that already has bookings.',
    pitfalls: [
      'Any posted or reversed verifikat in the year answers 409 FISCAL_PERIOD_HAS_POSTED_ENTRIES when dates are sent: send only name to rename.',
      'A locked year answers 409 FISCAL_PERIOD_UPDATE_LOCKED, a closed one 409 FISCAL_PERIOD_UPDATE_CLOSED.',
      'Re-dating does not re-chain previous_period_id: keep the years contiguous yourself.',
    ],
    example: {
      request: { period_end: '2027-06-30' },
      response: { data: { ...PERIOD_EXAMPLE, period_end: '2027-06-30' }, meta: META_EXAMPLE },
    },
  },
  input: z
    .object({
      fiscal_period_id: FISCAL_PERIOD_ID,
      name: z.string().trim().min(1).max(100).optional(),
      period_start: isoDateSchema.optional(),
      period_end: isoDateSchema.optional(),
    })
    .refine((b) => b.name !== undefined || b.period_start !== undefined || b.period_end !== undefined, {
      message: 'Send at least one of name, period_start, period_end.',
    }),
  output: FiscalPeriod,
  errorCodes: [
    'PERIOD_NOT_FOUND',
    'FISCAL_PERIOD_UPDATE_CLOSED',
    'FISCAL_PERIOD_UPDATE_LOCKED',
    'FISCAL_PERIOD_HAS_POSTED_ENTRIES',
    'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR',
    'FISCAL_PERIOD_START_NOT_FIRST_OF_MONTH',
    'FISCAL_PERIOD_END_NOT_MONTH_END',
    'FISCAL_PERIOD_TOO_LONG',
    'FISCAL_PERIOD_OVERLAP',
    'FISCAL_PERIOD_UPDATE_FAILED',
  ],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/fiscal-periods/:id',
    pathParams: { id: 'fiscal_period_id' },
  },
  mcp: {
    name: 'gnubok_update_fiscal_period',
    title: 'Update Fiscal Period',
    description:
      'Stage a rename or re-date of an open, unlocked räkenskapsår. Dates can only move while no posted verifikat exist in the year; the name can always change.',
    keywords: ['ändra räkenskapsår', 'byt namn räkenskapsår', 'förläng räkenskapsår', 'förkorta räkenskapsår'],
    stage: { pendingType: 'update_fiscal_period', title: () => 'Ändra räkenskapsår' },
  },
  run: async (ctx, { fiscal_period_id, ...changes }, { dryRun }) =>
    publicOutcome(await updateFiscalPeriod(ctx, fiscal_period_id, changes, { dryRun })),
})

export const fiscalPeriodsUnlock = defineOperation({
  id: 'fiscal-periods.unlock',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Unlock a locked (not closed) fiscal year.',
    description:
      'Clears locked_at so the year accepts postings again, and writes the unlock to the audit log (BFNAR 2013:2 behandlingshistorik). A closed year is never unlocked: past a close, corrections go into an open year as storno. Re-lock with POST /fiscal-periods/{id}/lock after the correction. Idempotent. Dry-runnable.',
    useWhen:
      'The user asked to correct something in a locked year, or a year-end must run on a year that was locked beforehand.',
    doNotUseFor:
      'Getting a booking past a lock without the user asking for that correction, or reopening a closed year (a year marked closed in a previous system: POST /fiscal-periods/{id}/reopen-external).',
    pitfalls: [
      'A closed year answers 409 PERIOD_UNLOCK_CLOSED; an unlocked one 409 PERIOD_UNLOCK_NOT_LOCKED.',
      'The company-wide lock date (bookkeeping_locked_through) is a separate lock this does not touch.',
    ],
    example: {
      response: { data: { ...PERIOD_EXAMPLE, locked_at: null }, meta: META_EXAMPLE },
    },
  },
  input: z.object({ fiscal_period_id: FISCAL_PERIOD_ID }),
  output: FiscalPeriod,
  errorCodes: ['PERIOD_NOT_FOUND', 'PERIOD_UNLOCK_CLOSED', 'PERIOD_UNLOCK_NOT_LOCKED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/fiscal-periods/:id/unlock',
    pathParams: { id: 'fiscal_period_id' },
  },
  run: async (ctx, { fiscal_period_id }, { dryRun }) =>
    publicOutcome(await unlockFiscalPeriod(ctx, fiscal_period_id, { dryRun })),
})

export const fiscalPeriodsCloseExternal = defineOperation({
  id: 'fiscal-periods.close-external',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Mark a migrated fiscal year as closed in the previous system (klarmarkera).',
    description:
      'Closes and locks an imported historical räkenskapsår whose bokslut was done in the previous bookkeeping software, without a closing entry here, and writes the decision to the audit log. Only for migrated years: the year must have ended, have no closing entry in Accounted, and hold imported verifikat, no verifikat, or balance-sheet-only verifikat with the next year\'s IB already posted. Unbooked bank transactions in the year block it, as for a lock. Undo with reopen-external. Idempotent. Dry-runnable.',
    useWhen: 'After an SIE migration, the earlier years show as pending bokslut although their bokslut was done in the old system.',
    doNotUseFor:
      'Closing a year bookkept in Accounted: run the year-end (POST /fiscal-periods/{id}/year-end), which transfers the result and carries the balances forward.',
    pitfalls: [
      'A year bookkept here with result accounts answers 409 FISCAL_PERIOD_CLOSE_EXTERNAL_NATIVE_BOOKKEEPING: run the year-end instead.',
      'A running year answers 409 FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED.',
      'Unbooked bank transactions answer 400 PERIOD_HAS_UNBOOKED_TRANSACTIONS with the count in details.reason.',
    ],
    example: {
      response: {
        data: {
          ...PERIOD_EXAMPLE,
          name: 'Räkenskapsår 2024',
          period_start: '2024-01-01',
          period_end: '2024-12-31',
          is_closed: true,
          closed_at: '2026-09-25T09:00:00Z',
          closed_externally: true,
          locked_at: '2026-09-25T09:00:00Z',
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({ fiscal_period_id: FISCAL_PERIOD_ID }),
  output: FiscalPeriod,
  errorCodes: [
    'PERIOD_NOT_FOUND',
    'FISCAL_PERIOD_CLOSE_EXTERNAL_ALREADY_CLOSED',
    'FISCAL_PERIOD_CLOSE_EXTERNAL_HAS_CLOSING_ENTRY',
    'FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED',
    'FISCAL_PERIOD_CLOSE_EXTERNAL_NATIVE_BOOKKEEPING',
    'FISCAL_PERIOD_CLOSE_EXTERNAL_CHECK_FAILED',
    'PERIOD_HAS_UNBOOKED_TRANSACTIONS',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/fiscal-periods/:id/close-external',
    pathParams: { id: 'fiscal_period_id' },
  },
  mcp: {
    name: 'gnubok_close_fiscal_period_external',
    title: 'Mark Fiscal Period Closed Externally',
    description:
      'Stage klarmarkera: mark a migrated räkenskapsår as closed in the previous system (closes and locks it, no closing entry here). Only for imported years that have ended; a year bookkept here needs gnubok_run_year_end.',
    keywords: ['klarmarkera', 'avslutat i tidigare program', 'stäng importerat år', 'migrerat räkenskapsår'],
    stage: { pendingType: 'close_fiscal_period_external', title: () => 'Klarmarkera räkenskapsår' },
  },
  run: async (ctx, { fiscal_period_id }, { dryRun }) =>
    publicOutcome(await closeFiscalPeriodExternally(ctx, fiscal_period_id, { dryRun })),
})

export const fiscalPeriodsReopenExternal = defineOperation({
  id: 'fiscal-periods.reopen-external',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Undo klarmarkera: reopen a year marked closed in the previous system.',
    description:
      'Reopens and unlocks a räkenskapsår that close-external closed, and writes the decision to the audit log. Only while that close is still the klarmarkera one: a year closed by a year-end run in Accounted is never reopened. Typical need: the prior-year SIE file was wrong and must be replaced. Idempotent. Dry-runnable.',
    useWhen: 'A year was marked closed in the previous system by mistake, or its imported contents must be replaced.',
    doNotUseFor: 'Reopening a year closed by a year-end here (not possible), or unlocking a locked year (POST /fiscal-periods/{id}/unlock).',
    pitfalls: [
      'An open year answers 409 PERIOD_REOPEN_NOT_CLOSED.',
      'A year closed by a year-end run here answers 409 PERIOD_REOPEN_NOT_EXTERNAL.',
      'The lock is cleared too: lock or klarmarkera the year again once the correction is done.',
    ],
    example: {
      response: {
        data: { ...PERIOD_EXAMPLE, name: 'Räkenskapsår 2024', period_start: '2024-01-01', period_end: '2024-12-31' },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({ fiscal_period_id: FISCAL_PERIOD_ID }),
  output: FiscalPeriod,
  errorCodes: ['PERIOD_NOT_FOUND', 'PERIOD_REOPEN_NOT_CLOSED', 'PERIOD_REOPEN_NOT_EXTERNAL'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/fiscal-periods/:id/reopen-external',
    pathParams: { id: 'fiscal_period_id' },
  },
  mcp: {
    name: 'gnubok_reopen_fiscal_period_external',
    title: 'Reopen Externally Closed Fiscal Period',
    description:
      'Stage undoing klarmarkera: reopen and unlock a räkenskapsår that was marked closed in the previous system. Refused for a year closed by a year-end run in Accounted.',
    keywords: ['ångra klarmarkera', 'öppna räkenskapsår', 'återöppna importerat år'],
    stage: { pendingType: 'reopen_fiscal_period_external', title: () => 'Öppna klarmarkerat räkenskapsår' },
  },
  run: async (ctx, { fiscal_period_id }, { dryRun }) =>
    publicOutcome(await reopenExternallyClosedFiscalPeriod(ctx, fiscal_period_id, { dryRun })),
})

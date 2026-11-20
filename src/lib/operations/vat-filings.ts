/**
 * The momsdeklaration filing record for agents (issues #2785, #2786): which
 * VAT periods the company has on record as filed, marking a period filed
 * after a filing made outside the Skatteverket connection, and undoing a
 * manual mark. Thin wrappers over lib/vat/filing-record-store.ts, the store
 * the dashboard routes and the v1 endpoints use, so the rules are the same on
 * every door: a Skatteverket-confirmed filing is never relabelled by a mark,
 * and unmarking one is refused.
 *
 * MCP only. The v1 doors already exist as the hand-written
 * /reports/vat-declaration/filings route (operation names vat_filings.*,
 * outside the SIE read lease), and binding these operations to that path
 * would change its public contract: the list answers a bare array there, and
 * an operation's MCP output must be an object; the DELETE takes its period in
 * the query string, which the operation v1 door does not read. Both doors
 * validate with the same schemas (lib/api/schemas.ts) and run the same store
 * functions, dry runs included.
 *
 * Every cadence goes through the same path. A yearly (helårsmoms) period is
 * the räkenskapsår, named by the calendar year it ends in with period 1; the
 * store places it from the company's fiscal-year settings.
 *
 * booksLockOffer is the offer the tools that record or report a filing pass
 * on to the agent (the mark here, and the submit and status tools of the MCP
 * server): lock the books through the period's last day.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { MarkVatFilingSchema, VatFilingPeriodSchema } from '@/lib/api/schemas'
import { formatPeriodLabel } from '@/lib/reports/period-dates'
import {
  markVatPeriodFiled,
  previewMarkVatPeriodFiled,
  previewUnmarkVatPeriodFiled,
  unmarkVatPeriodFiled,
} from '@/lib/vat/filing-record-store'
import { listVatFilingsWithChanges, VatFilingChangeSchema } from '@/lib/vat/filed-period-changes'
import { readFiledPeriodLock } from '@/lib/vat/filed-period-lock'
import type { VatFilingPeriodType } from '@/lib/vat/filing-record'
import { settingsUpdateBookkeepingLock } from './company-settings'
import { defineOperation, type OperationStageExtras } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const VatFilingRecordSchema = z.object({
  deadline_id: z.string().uuid().describe('The completed moms deadline that carries the record.'),
  period_type: z.enum(['monthly', 'quarterly', 'yearly']),
  year: z.number().int().describe('Calendar year of the period; for yearly, the year the räkenskapsår ends.'),
  period: z.number().int().describe('1-12 monthly, 1-4 quarterly, 1 yearly.'),
  tax_period: z.string().describe('The deadline label: YYYY-MM, YYYY-QN, or YYYY / YYYY-1/YYYY for a räkenskapsår.'),
  period_start: z.string().describe('First day of the declared period.'),
  period_end: z.string().describe('Last day of the declared period.'),
  filed_on: z.string().describe('Swedish calendar date the declaration was filed.'),
  source: z.enum(['skatteverket', 'manual']).describe('skatteverket: confirmed by a kvittens through the connection.'),
  reference: z.string().nullable().describe("Skatteverket's reference typed at manual marking, if any."),
})

const EXAMPLE_RECORD = {
  deadline_id: '11111111-1111-4111-8111-111111111111',
  period_type: 'yearly',
  year: 2026,
  period: 1,
  tax_period: '2025/2026',
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  filed_on: '2026-08-20',
  source: 'manual',
  reference: null,
}

type PeriodInput = { period_type: VatFilingPeriodType; year: number; period: number }

function storePeriod(input: PeriodInput) {
  return { periodType: input.period_type, year: input.year, period: input.period }
}

function stageLabel(input: Record<string, unknown>): string {
  return formatPeriodLabel(
    input.period_type as VatFilingPeriodType,
    Number(input.year),
    Number(input.period),
  )
}

/**
 * What the lock offer rests on: the day to lock through (the filed period's
 * last day, still open for writes), and the last day of the newest
 * räkenskapsår that ends on or before it and is not closed yet, whose bokslut
 * the lock would stop (null when there is none). The mark's dry run carries it
 * in its preview, so the names are the preview's.
 */
interface LockOffer {
  through: string
  open_year_end: string | null
}

/**
 * The offer for a filed period, or null when there is none to make: the
 * period's last day is already shut for writes, or how the books stand on it
 * could not be read (lib/vat/filed-period-lock.ts has the rule).
 */
async function readLockOffer(supabase: SupabaseClient, companyId: string, periodEnd: string): Promise<LockOffer | null> {
  const lock = await readFiledPeriodLock(supabase, companyId, periodEnd)
  return lock?.state === 'open' ? { through: lock.lockThrough, open_year_end: lock.openYearEnd } : null
}

/** When the agent asks: the filing is a fact now, or will be once something else has happened. */
const LOCK_OFFER_MOMENT = {
  filed: 'The declaration is filed: ask the user whether',
  once_filed: 'Once the declaration is filed, ask the user whether',
  once_approved: 'Once this is approved the period is on record as filed: then ask the user whether',
} as const

/**
 * The follow-up an agent is handed where a momsdeklaration is filed: ask the
 * person whether to lock the books through the period's last day, and stage
 * the existing lock (settings.update-bookkeeping-lock: staged, high risk,
 * approved by the person as ever) only on a yes. Filing freezes nothing, so
 * this is what keeps the filed period as it was declared.
 */
function lockOfferHint(
  { through, open_year_end }: LockOffer,
  moment: keyof typeof LOCK_OFFER_MOMENT,
): NonNullable<OperationStageExtras['next']> {
  const tool = settingsUpdateBookkeepingLock.mcp!.name
  const openYear = open_year_end
    ? ` Say too that the räkenskapsår ending ${open_year_end} is not closed, so its bokslut cannot be booked until the lock date is moved back.`
    : ''
  return {
    description: `Filing locks nothing, and the books are open through the period's last day. ${LOCK_OFFER_MOMENT[moment]} to lock the books through ${through}, after which verifikat dated on or before it can no longer be created or changed (the lock date is moved back under Inställningar > Bokföring).${openYear} Only on a yes, stage ${tool}; it is high risk and the user approves it.`,
    tool,
    args: { bookkeeping_locked_through: through },
  }
}

/** The lock offer as the `next` hint of an MCP tool that reports a filing, or null when there is none to make. */
export async function booksLockOffer(
  supabase: SupabaseClient,
  companyId: string,
  periodEnd: string,
  moment: keyof typeof LOCK_OFFER_MOMENT,
): Promise<NonNullable<OperationStageExtras['next']> | null> {
  const offer = await readLockOffer(supabase, companyId, periodEnd)
  return offer ? lockOfferHint(offer, moment) : null
}

export const vatFilingsList = defineOperation({
  id: 'vat-filings.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the VAT periods the company has on record as filed.',
    description:
      'Every momsdeklaration period (monthly, quarterly or yearly) the company has on record as filed, newest first, with the dates each period covers. source is skatteverket when a Skatteverket kvittens confirmed the filing through the connection, manual when a person or an agent recorded it. Local state, not a Skatteverket read.',
    useWhen:
      'Deciding which VAT period to prepare next, or checking whether a period was already filed before recomputing or submitting it.',
    doNotUseFor:
      'What Skatteverket actually has on file (gnubok_vat_declaration_status) or the declaration figures (gnubok_get_vat_report).',
    pitfalls: [
      'An empty list means nothing is recorded, not that nothing was filed: a declaration filed by hand on skatteverket.se is only on record once it is marked (gnubok_mark_vat_period_filed).',
      'A yearly period is the räkenskapsår: year is the year it ends in, tax_period is 2025/2026 for a broken fiscal year.',
      'changed_after_filing is not null when verifikat posted, corrected or re-dated after the filing moved the declared period: that change does not reach Skatteverket by itself.',
    ],
    example: { response: { data: { filings: [{ ...EXAMPLE_RECORD, changed_after_filing: null }] }, meta: META } },
  },
  input: z.object({}),
  output: z.object({
    filings: z.array(
      VatFilingRecordSchema.extend({
        changed_after_filing: VatFilingChangeSchema.nullable().describe(
          'What moved in the declared period since it was filed, per ruta and verifikat; null when the books still read as filed.',
        ),
      }),
    ),
  }),
  mcp: {
    name: 'gnubok_list_vat_filings',
    title: 'List Filed VAT Periods',
    description:
      'Which momsdeklaration periods (monthly, quarterly, helårsmoms) are on record as filed, via a Skatteverket kvittens or marked by hand, with the dates each covers. Local record, not a Skatteverket read.',
    keywords: ['inlämnad', 'inlämnade momsdeklarationer', 'momsperiod', 'helårsmoms', 'deklarerad', 'kvittens'],
  },
  run: async (ctx) => ({ ok: true, data: { filings: await listVatFilingsWithChanges(ctx.supabase, ctx.companyId) } }),
})

export const vatFilingsMark = defineOperation({
  id: 'vat-filings.mark',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Record that a VAT period was filed outside the Skatteverket connection.',
    description:
      "Marks a momsdeklaration period (monthly, quarterly or yearly) as filed on filed_on, optionally with Skatteverket's reference. Completes the period's moms deadline with status submitted, creating it when the company has none. Nothing is sent to Skatteverket. Marking a marked period updates its date and reference; a period confirmed at Skatteverket is left unchanged.",
    useWhen:
      'The declaration was filed on skatteverket.se by hand, by an ombud or from another system, and the books should know the period is done.',
    doNotUseFor:
      'Filing the declaration itself: that is the BankID-signed flow (gnubok_vat_declaration_submit).',
    pitfalls: [
      'The period must have ended, and filed_on must fall after its last day and no later than today: otherwise VAT_FILING_PERIOD_NOT_ENDED, VAT_FILING_DATE_BEFORE_PERIOD_END or VAT_FILING_DATE_IN_FUTURE.',
      'Yearly: year is the year the räkenskapsår ends in and period is 1; a broken fiscal year ends in its own month, not December.',
      'Omitting reference keeps a stored one; null clears it.',
      "Marking locks nothing. While verifikat can still be posted on the period's last day the preview carries lock_offer (the day to lock through, and open_year_end when a räkenskapsår that is not closed ends on or before it) and the staged answer offers the lock in next.",
    ],
    example: {
      request: { period_type: 'yearly', year: 2026, period: 1, filed_on: '2026-08-20', reference: 'ABC123' },
      response: { data: { ...EXAMPLE_RECORD, reference: 'ABC123', created: false, changed: true }, meta: META },
    },
  },
  input: MarkVatFilingSchema,
  output: VatFilingRecordSchema.extend({
    created: z.boolean().describe('True when the company had no deadline row for the period and one was created.'),
    changed: z.boolean().describe('False when the period was already confirmed at Skatteverket and left unchanged.'),
  }),
  errorCodes: [
    'VAT_FILING_PERIOD_NOT_ENDED',
    'VAT_FILING_DATE_BEFORE_PERIOD_END',
    'VAT_FILING_DATE_IN_FUTURE',
    'CONFLICT',
  ],
  mcp: {
    name: 'gnubok_mark_vat_period_filed',
    title: 'Mark VAT Period Filed',
    description:
      "Stage recording that a momsdeklaration period (monthly, quarterly or helårsmoms) was filed outside the Skatteverket connection, with the filing date and Skatteverket's reference. Sends nothing to Skatteverket. Approval records it.",
    keywords: ['markera som inlämnad', 'inlämnad', 'momsdeklaration inlämnad', 'helårsmoms', 'kvittensnummer', 'deklarerat'],
    stage: {
      pendingType: 'mark_vat_period_filed',
      title: (input) => `Markera momsdeklaration ${stageLabel(input)} som inlämnad`,
      extras: (_input, preview) =>
        preview.lock_offer ? { next: lockOfferHint(preview.lock_offer as LockOffer, 'once_approved') } : {},
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const markInput = { ...storePeriod(input), filedOn: input.filed_on, reference: input.reference }
    if (dryRun) {
      const preview = await previewMarkVatPeriodFiled(ctx.supabase, ctx.companyId, markInput)
      if (!preview.ok) return { ok: false, code: preview.code }
      const { would_mark, effect, current } = preview
      // Marking locks nothing: while the period's last day is open for writes
      // the preview says what a lock through it would rest on.
      const lock_offer = await readLockOffer(ctx.supabase, ctx.companyId, would_mark.period_end)
      return { ok: true, dryRun: true, preview: { would_mark, effect, current, lock_offer } }
    }
    const result = await markVatPeriodFiled(ctx.supabase, ctx.companyId, { ...markInput, userId: ctx.userId })
    if (!result.ok) return { ok: false, code: result.code }
    return {
      ok: true,
      data: { ...result.record, created: result.created, changed: result.changed },
      created: result.created,
    }
  },
})

export const vatFilingsUnmark = defineOperation({
  id: 'vat-filings.unmark',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Undo a manual "filed" mark on a VAT period.',
    description:
      "Puts the period's moms deadline back to pending and removes the stored reference. Refused for a period confirmed at Skatteverket through the connection (VAT_FILING_CONFIRMED_BY_SKATTEVERKET) and for a period with no filing record (VAT_FILING_NOT_FOUND).",
    useWhen: 'A period was marked as filed by mistake.',
    doNotUseFor:
      'Withdrawing or correcting a declaration at Skatteverket: that is a new declaration for the same period.',
    pitfalls: ['Only manual marks can be undone; a Skatteverket kvittens is a fact this does not erase.'],
    example: {
      request: { period_type: 'quarterly', year: 2026, period: 2 },
      response: { data: { deadline_id: '11111111-1111-4111-8111-111111111111', unmarked: true }, meta: META },
    },
  },
  input: VatFilingPeriodSchema,
  output: z.object({ deadline_id: z.string().uuid(), unmarked: z.literal(true) }),
  errorCodes: ['VAT_FILING_NOT_FOUND', 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET'],
  mcp: {
    name: 'gnubok_unmark_vat_period_filed',
    title: 'Unmark VAT Period Filed',
    description:
      'Stage undoing a manual "filed" mark on a momsdeklaration period (monthly, quarterly or helårsmoms). Refused when Skatteverket confirmed the filing with a kvittens, or when nothing is recorded. Approval puts the period back to pending.',
    keywords: ['ångra inlämnad', 'avmarkera', 'inte inlämnad', 'momsdeklaration', 'helårsmoms'],
    stage: {
      pendingType: 'unmark_vat_period_filed',
      title: (input) => `Ångra inlämnad-markering för momsdeklaration ${stageLabel(input)}`,
    },
  },
  run: async (ctx, input, { dryRun }) => {
    if (dryRun) {
      const preview = await previewUnmarkVatPeriodFiled(ctx.supabase, ctx.companyId, storePeriod(input))
      if (!preview.ok) return { ok: false, code: preview.code }
      return { ok: true, dryRun: true, preview: { would_unmark: preview.would_unmark, current: preview.current } }
    }
    const result = await unmarkVatPeriodFiled(ctx.supabase, ctx.companyId, storePeriod(input))
    if (!result.ok) return { ok: false, code: result.code }
    return { ok: true, data: { deadline_id: result.deadline_id, unmarked: true as const } }
  },
})

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
 */
import { z } from 'zod'
import { MarkVatFilingSchema, VatFilingPeriodSchema } from '@/lib/api/schemas'
import { formatPeriodLabel } from '@/lib/reports/period-dates'
import {
  listVatFilings,
  markVatPeriodFiled,
  previewMarkVatPeriodFiled,
  previewUnmarkVatPeriodFiled,
  unmarkVatPeriodFiled,
} from '@/lib/vat/filing-record-store'
import type { VatFilingPeriodType } from '@/lib/vat/filing-record'
import { defineOperation } from './types'

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
    ],
    example: { response: { data: { filings: [EXAMPLE_RECORD] }, meta: META } },
  },
  input: z.object({}),
  output: z.object({ filings: z.array(VatFilingRecordSchema) }),
  mcp: {
    name: 'gnubok_list_vat_filings',
    title: 'List Filed VAT Periods',
    description:
      'Which momsdeklaration periods (monthly, quarterly, helårsmoms) are on record as filed, via a Skatteverket kvittens or marked by hand, with the dates each covers. Local record, not a Skatteverket read.',
    keywords: ['inlämnad', 'inlämnade momsdeklarationer', 'momsperiod', 'helårsmoms', 'deklarerad', 'kvittens'],
  },
  run: async (ctx) => ({ ok: true, data: { filings: await listVatFilings(ctx.supabase, ctx.companyId) } }),
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
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const markInput = { ...storePeriod(input), filedOn: input.filed_on, reference: input.reference }
    if (dryRun) {
      const preview = await previewMarkVatPeriodFiled(ctx.supabase, ctx.companyId, markInput)
      if (!preview.ok) return { ok: false, code: preview.code }
      const { would_mark, effect, current } = preview
      return { ok: true, dryRun: true, preview: { would_mark, effect, current } }
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

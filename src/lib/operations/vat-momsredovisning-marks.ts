/**
 * "Rättelse, inte momsredovisning" for agents (crm#1849). The momsdeklaration
 * takes a verifikat shaped like a momsredovisning (a declaration account and
 * a 2650/1650 line, not a sale or a purchase with a same-side 2650/1650 line)
 * for the period's momsredovisning: the rutor leave it out
 * and the period counts as settled. A correction can have that shape. The Moms
 * page lets a person mark such a verifikat as a correction; these operations
 * let an agent propose the same mark, or its withdrawal. The approval runs
 * lib/vat/momsredovisning-marks.ts, the service the dashboard route
 * /api/reports/vat-declaration/not-momsredovisning runs too, so the refusals
 * are the same on every door, and the mark is recorded in the approver's name
 * (approved in the chat, the API key's owner).
 *
 * MCP only and always staged, like vat-check-reviews.mark: a mark changes what
 * a declaration reads, so the tool call itself never writes one.
 */
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import {
  markNotMomsredovisning,
  previewMomsredovisningMark,
  withdrawNotMomsredovisning,
} from '@/lib/vat/momsredovisning-marks'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const TargetSchema = z.object({
  journal_entry_id: z.string().uuid().describe('The verifikat (journal entry id) the momsdeklaration takes for a momsredovisning.'),
})

const ResultSchema = z.object({
  journal_entry_id: z.string().uuid(),
  marked: z.boolean().describe('True while the verifikat carries the mark: the momsdeklaration reads it as an ordinary verifikat.'),
  changed: z.boolean().describe('False when the verifikat was already in the asked state; nothing was written.'),
})

// The refusals a mark and its withdrawal share.
const REFUSALS = [
  'JOURNAL_ENTRY_NOT_FOUND',
  'VAT_MARK_NOT_POSTED',
  'VAT_MARK_TAGGED_SETTLEMENT',
  'VAT_MARK_STORNO',
  'VAT_MARK_PERIOD_LOCKED',
  'VAT_MARK_PERIOD_FILED',
  'VAT_MARK_NOT_READY',
] as const

const PITFALLS = [
  'Only a posted verifikat. The momsredovisning booked from the Moms page (source_type vat_settlement) is reversed instead, never marked: VAT_MARK_TAGGED_SETTLEMENT.',
  'A storno follows its original: mark the original. VAT_MARK_STORNO.',
  'Never in a closed or locked period (VAT_MARK_PERIOD_LOCKED) or in a VAT period already filed (VAT_MARK_PERIOD_FILED).',
]

// Keys pending.preview_field already labels for the approver.
function stagePreview(preview: Record<string, unknown>, markedWhenDone: boolean) {
  return {
    voucher: preview.verifikat,
    voucher_date: preview.entry_date,
    voucher_description: preview.description,
    already_in_state: preview.marked_now === markedWhenDone,
  }
}

export const vatMomsredovisningMarksMark = defineOperation({
  id: 'vat-momsredovisning-marks.mark',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Mark a verifikat the momsdeklaration takes for a momsredovisning as a correction, so the rutor read it.',
    description:
      'The momsdeklaration leaves out a verifikat shaped like a momsredovisning (a line on a declaration account and one on 2650/1650, except a sale or a purchase whose lines all stand on the side of its 2650/1650 line, or a pure movement between VAT accounts and the skattekonto) and counts it as a momsredovisning of the period. A correction can have that shape, e.g. output VAT moved to 1650 next to a sales correction. Marked, the verifikat and its storno are read like any other verifikat and no longer count as a momsredovisning; when it was the period\'s only one, the period\'s momsredovisning can then be booked. Nothing in the books changes and nothing is sent to Skatteverket. Withdrawable while the period is open and its VAT return not filed.',
    useWhen:
      'gnubok_get_vat_settlement_proposal lists a verifikat in existing_entries, or booking answers VAT_SETTLEMENT_ALREADY_BOOKED, for a verifikat the user confirms is a correction, not the period\'s momsredovisning.',
    doNotUseFor:
      'A real momsredovisning (also one imported from another program), or a verifikat nobody has checked. Do not mark on your own judgement.',
    pitfalls: [
      'Only a verifikat the momsdeklaration takes for a momsredovisning (listed in existing_entries); any other answers VAT_MARK_NOT_SHAPE: a mark would change nothing.',
      ...PITFALLS,
    ],
    example: {
      request: { journal_entry_id: '33333333-3333-4333-8333-333333333333' },
      response: {
        data: { journal_entry_id: '33333333-3333-4333-8333-333333333333', marked: true, changed: true },
        meta: META,
      },
    },
  },
  input: TargetSchema,
  output: ResultSchema,
  errorCodes: [...REFUSALS, 'VAT_MARK_NOT_SHAPE'],
  mcp: {
    name: 'gnubok_mark_not_momsredovisning',
    title: 'Mark Entry As Correction, Not VAT Settlement',
    description:
      'Stage marking a journal entry the VAT return (momsdeklaration) takes for a momsredovisning (existing_entries) as a correction, once the user confirms it. The rutor then read it and it no longer counts as the period\'s momsredovisning.',
    keywords: ['rättelse', 'inte momsredovisning', 'momsredovisning', 'redan bokförd', 'momsdeklaration', 'existing_entries', 'VAT_SETTLEMENT_ALREADY_BOOKED'],
    stage: {
      pendingType: 'mark_not_momsredovisning',
      title: (_input, preview) => `Räkna ${String(preview?.verifikat ?? 'verifikatet')} som rättelse, inte momsredovisning`,
      preview: (_input, preview) => stagePreview(preview, true),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    if (dryRun) {
      const outcome = await previewMomsredovisningMark(ctx.supabase, ctx.companyId, input.journal_entry_id, 'mark')
      if (!outcome.ok) return { ok: false, code: outcome.code }
      return { ok: true, dryRun: true, preview: { ...outcome.preview } }
    }
    // The approval reads and checks with the door's client; only the server
    // writes the mark, in the approving person's name (ctx.userId).
    const outcome = await markNotMomsredovisning(
      ctx.supabase, createServiceClient(), ctx.companyId, ctx.userId, input.journal_entry_id,
    )
    if (!outcome.ok) return { ok: false, code: outcome.code }
    return { ok: true, data: outcome.data, created: outcome.data.changed }
  },
})

export const vatMomsredovisningMarksWithdraw = defineOperation({
  id: 'vat-momsredovisning-marks.withdraw',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Withdraw a correction mark: the momsdeklaration decides again by shape whether the verifikat is a momsredovisning.',
    description:
      'Takes back a "rättelse, inte momsredovisning" mark: the momsdeklaration decides again by the verifikat\'s lines. Still shaped like a momsredovisning (unless a rättelse changed its lines since it was marked), it is left out of the rutor and counts as a momsredovisning of the period, beside any booked since: a momsredovisning booked while the mark held cleared what the mark counted, and the verifikat moves the rest. Nothing in the books changes and nothing is sent to Skatteverket.',
    useWhen: 'The user says a verifikat marked as a correction is the period\'s momsredovisning after all.',
    doNotUseFor: 'A verifikat that carries no mark (VAT_MARK_NOT_FOUND).',
    pitfalls: PITFALLS,
    example: {
      request: { journal_entry_id: '33333333-3333-4333-8333-333333333333' },
      response: {
        data: { journal_entry_id: '33333333-3333-4333-8333-333333333333', marked: false, changed: true },
        meta: META,
      },
    },
  },
  input: TargetSchema,
  output: ResultSchema,
  errorCodes: [...REFUSALS, 'VAT_MARK_NOT_FOUND'],
  mcp: {
    name: 'gnubok_withdraw_not_momsredovisning',
    title: 'Withdraw Correction Mark',
    description:
      'Stage withdrawing a "rättelse, inte momsredovisning" mark once the user confirms: the VAT return (momsdeklaration) then decides again by the journal entry\'s lines whether it is a momsredovisning.',
    keywords: ['ångra rättelse', 'ta tillbaka markering', 'momsredovisning', 'momsdeklaration'],
    stage: {
      pendingType: 'withdraw_not_momsredovisning',
      title: (_input, preview) => `Ta bort markeringen som rättelse på ${String(preview?.verifikat ?? 'verifikatet')}`,
      preview: (_input, preview) => stagePreview(preview, false),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    if (dryRun) {
      const outcome = await previewMomsredovisningMark(ctx.supabase, ctx.companyId, input.journal_entry_id, 'withdraw')
      if (!outcome.ok) return { ok: false, code: outcome.code }
      return { ok: true, dryRun: true, preview: { ...outcome.preview } }
    }
    const outcome = await withdrawNotMomsredovisning(
      ctx.supabase, createServiceClient(), ctx.companyId, ctx.userId, input.journal_entry_id,
    )
    if (!outcome.ok) return { ok: false, code: outcome.code }
    return { ok: true, data: outcome.data, created: outcome.data.changed }
  },
})

/**
 * Deadlines for agents (crm#1848): listing the company's deadlines and
 * ticking one off, or putting it back, by its id. Before this an agent could
 * only close a moms or AGI deadline, by recording the filing
 * (vat-filings.mark, agi-filings.mark); every other deadline was a tick in
 * the dashboard only, and no read listed them.
 *
 * Thin wrappers over lib/deadlines/completion.ts, the service the dashboard
 * route (POST /api/deadlines/:id/complete) runs too, so the rule is the same
 * on every door. A deadline is a reminder: no verifikat, period or filing is
 * touched, and nothing is sent anywhere.
 *
 * MCP only: no v1 endpoint yet (the dashboard's deadline routes have none
 * either, see session-route-parity.ts).
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import {
  DEADLINE_LIST_DEFAULT_LIMIT,
  DEADLINE_LIST_MAX_LIMIT,
  listDeadlines,
  setDeadlineCompletion,
  summarizeDeadline,
} from '@/lib/deadlines/completion'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const DeadlineSchema = z.object({
  deadline_id: z.string().uuid(),
  title: z.string(),
  due_date: z.string().describe('YYYY-MM-DD.'),
  due_time: z.string().nullable(),
  deadline_type: z.string().describe('tax, report, invoicing, delivery or other.'),
  tax_deadline_type: z.string().nullable().describe('The filing a system tax deadline stands for, e.g. moms_quarterly.'),
  tax_period: z.string().nullable().describe('YYYY-MM, YYYY-QN or YYYY for a tax deadline.'),
  priority: z.string(),
  source: z.string().describe('system: generated from the tax settings; user: added by hand.'),
  is_completed: z.boolean(),
  completed_at: z.string().nullable(),
  overdue: z.boolean().describe('Open and past its due date. A completed deadline is never overdue.'),
  days_until_due: z.number().int().describe('Swedish calendar days to the due date; negative once it has passed.'),
  notes: z.string().nullable(),
})

const EXAMPLE_DEADLINE = {
  deadline_id: '11111111-1111-4111-8111-111111111111',
  title: 'Årsredovisning till Bolagsverket',
  due_date: '2026-07-31',
  due_time: null,
  deadline_type: 'report',
  tax_deadline_type: null,
  tax_period: null,
  priority: 'important',
  source: 'user',
  is_completed: false,
  completed_at: null,
  overdue: false,
  days_until_due: 12,
  notes: null,
}

export const deadlinesList = defineOperation({
  id: 'deadlines.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: "List the company's deadlines, the open ones by default.",
    description:
      'The deadlines under Deadlines in the app, earliest due date first: tax and filing deadlines generated from the tax settings and the ones added by hand. status open (the default) is what is left to do; completed and all include what is ticked off. A deadline the company removed from its list is never returned. overdue is computed from the due date and only for an open deadline.',
    useWhen: 'Seeing what is due, or finding the deadline_id to tick off after the work is done.',
    doNotUseFor:
      'Which moms periods are on record as filed (gnubok_list_vat_filings) or what Skatteverket has on file (gnubok_vat_declaration_status).',
    pitfalls: [
      'has_more true means more deadlines match than limit returned: narrow with due_from and due_to.',
      'A completed deadline says the company ticked it off or a filing was recorded, not that Skatteverket received anything.',
    ],
    example: { response: { data: { deadlines: [EXAMPLE_DEADLINE], has_more: false }, meta: META } },
  },
  input: z
    .object({
      status: z.enum(['open', 'completed', 'all']).default('open').describe('open: not ticked off (default).'),
      due_from: saneIsoDateSchema.optional().describe('Earliest due date, YYYY-MM-DD.'),
      due_to: saneIsoDateSchema.optional().describe('Latest due date, YYYY-MM-DD.'),
      limit: z.number().int().min(1).max(DEADLINE_LIST_MAX_LIMIT).default(DEADLINE_LIST_DEFAULT_LIMIT),
    })
    .strict(),
  output: z.object({ deadlines: z.array(DeadlineSchema), has_more: z.boolean() }),
  mcp: {
    name: 'gnubok_list_deadlines',
    title: 'List Deadlines',
    description:
      "List the company's deadlines by due date: open ones by default, or completed/all. Each has a deadline_id, due_date and overdue. Use to see what is due or to find the deadline to tick off (gnubok_complete_deadline).",
    keywords: ['deadline', 'deadlines', 'viktiga datum', 'påminnelse', 'förfaller', 'försenad', 'skattekalender'],
  },
  run: (ctx, input) => listDeadlines(ctx, input),
})

export const deadlinesComplete = defineOperation({
  id: 'deadlines.complete',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  // The same call with the other is_completed puts it back.
  reversible: true,
  docs: {
    summary: 'Tick a deadline off, or put it back on the list.',
    description:
      'Sets one deadline completed (is_completed true) or open again (false), as the checkbox under Deadlines in the app does. Only the tick changes: no verifikat, period or filing is touched and nothing is sent to Skatteverket. Asking for the state the deadline already has changes nothing (changed false). Dry-runnable.',
    useWhen: 'The work a deadline stands for is done (or was ticked off by mistake) and it should leave (or return to) the open list.',
    doNotUseFor:
      'A moms or AGI filing made outside Accounted: record the filing instead (gnubok_mark_vat_period_filed, gnubok_mark_agi_period_filed), which completes the deadline with the filing date.',
    pitfalls: [
      'DEADLINE_NOT_FOUND for an id that is not one of the company\'s listed deadlines (gnubok_list_deadlines), including one the company removed.',
      'DEADLINE_CONFIRMED_BY_SKATTEVERKET when is_completed false targets a deadline whose filing Skatteverket confirmed through the connection.',
    ],
    example: {
      request: { deadline_id: EXAMPLE_DEADLINE.deadline_id, is_completed: true },
      response: {
        data: {
          deadline: { ...EXAMPLE_DEADLINE, is_completed: true, completed_at: '2026-07-19T08:30:00.000Z' },
          changed: true,
        },
        meta: META,
      },
    },
  },
  input: z
    .object({
      deadline_id: z.string().uuid().describe('From gnubok_list_deadlines.'),
      is_completed: z.boolean().describe('true ticks the deadline off; false puts it back on the open list.'),
    })
    .strict(),
  output: z.object({
    deadline: DeadlineSchema,
    changed: z.boolean().describe('False when the deadline already had the requested state.'),
  }),
  errorCodes: ['DEADLINE_NOT_FOUND', 'DEADLINE_CONFIRMED_BY_SKATTEVERKET'],
  mcp: {
    name: 'gnubok_complete_deadline',
    title: 'Complete Deadline',
    description:
      'Stage ticking a deadline off (is_completed true) or putting it back (false), by deadline_id from gnubok_list_deadlines. Changes only the tick; books and files nothing. For a moms or AGI filing use gnubok_mark_vat_period_filed / gnubok_mark_agi_period_filed.',
    keywords: ['deadline', 'bocka av', 'klarmarkera', 'markera klar', 'påminnelse', 'ångra klar', 'viktiga datum'],
    hints: { idempotent: true },
    stage: {
      pendingType: 'complete_deadline',
      title: (input, preview) => {
        const name = typeof preview?.title === 'string' ? `: ${preview.title}` : ''
        return input.is_completed === false ? `Sätt tillbaka deadline${name}` : `Bocka av deadline${name}`
      },
    },
  },
  run: async (ctx, { deadline_id, is_completed }, { dryRun }) => {
    const outcome = await setDeadlineCompletion(
      ctx,
      { deadlineId: deadline_id, isCompleted: is_completed },
      { dryRun, protectConfirmed: true },
    )
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { deadline: summarizeDeadline(outcome.data.deadline), changed: outcome.data.changed } }
  },
})

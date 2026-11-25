/**
 * Counterparty template operations: what a person does to a rule under
 * Bokföringsregler and the settings panel, for agents. A rule is a
 * categorization_templates row, learned from bookings. Before these an agent
 * could only read them (gnubok_get_counterparty_templates): a rule that had
 * learned a wrong account stayed and kept proposing it, and the agent could
 * only book a correction each time.
 *
 * MCP only, staged at low risk: the session routes /api/settings/
 * counterparty-templates (rename, remove) and /api/rules/:id (pause, resume,
 * always review) call the same functions in lib/rules/service.ts. The web's
 * remove is a soft delete that the table's trigger reads as paused, so
 * pausing here is the same act. A rule changes proposals from then on;
 * nothing booked changes.
 */
import { z } from 'zod'
import { formatCounterpartyName } from '@/lib/bookkeeping/counterparty-template-format'
import { getRule, renameCounterpartyTemplate, updateRule } from '@/lib/rules/service'
import { USER_SETTABLE_MODES, type RuleMode } from '@/lib/rules/model'
import { defineOperation } from './types'

const MODES = ['proposed', 'propose', 'auto', 'paused'] as const

const Template = z.object({
  counterparty_template_id: z.string().uuid(),
  counterparty_name: z.string().describe('The stored key: lowercase, single-spaced.'),
  counterparty_name_display: z.string(),
  counterparty_aliases: z.array(z.string()).describe('Other bank texts that match the rule; a rename keeps the old name here.'),
  debit_account: z.string(),
  credit_account: z.string(),
  mode: z.enum(MODES).describe('propose: suggests on matching rows; paused: suggests nothing.'),
  always_review: z.boolean().describe('Every booking from the rule asks for a review; it never books with one click.'),
})

type TemplateSummary = z.infer<typeof Template>

interface TemplateRowLike {
  id: string
  counterparty_name: string
  counterparty_aliases: string[] | null
  debit_account: string
  credit_account: string
  mode?: RuleMode | null
  is_active?: boolean | null
  always_review?: boolean | null
}

function summarize(row: TemplateRowLike): TemplateSummary {
  return {
    counterparty_template_id: row.id,
    counterparty_name: row.counterparty_name,
    counterparty_name_display: formatCounterpartyName(row.counterparty_name),
    counterparty_aliases: row.counterparty_aliases ?? [],
    debit_account: row.debit_account,
    credit_account: row.credit_account,
    mode: row.mode ?? (row.is_active === false ? 'paused' : 'propose'),
    always_review: row.always_review ?? false,
  }
}

const TEMPLATE_ID = z
  .string()
  .uuid()
  .describe('The template id (id in gnubok_get_counterparty_templates; include_paused true lists paused ones).')

// The accounts are left out: an account number at a call site is a place
// another country's chart cannot reach (check:guards, bas-account-literal).
const EXAMPLE_TEMPLATE: Omit<TemplateSummary, 'debit_account' | 'credit_account'> = {
  counterparty_template_id: '3f2a…',
  counterparty_name: 'hallon',
  counterparty_name_display: 'Hallon',
  counterparty_aliases: ['hallon ab'],
  mode: 'paused',
  always_review: false,
}
const META = { request_id: 'req_…', api_version: '2026-05-12' }

function displayName(input: Record<string, unknown>, preview?: Record<string, unknown>): string {
  const name = preview?.counterparty_name_display
  return typeof name === 'string' && name ? name : 'motparten'
}

export const counterpartyTemplatesRename = defineOperation({
  id: 'counterparty-templates.rename',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  // Renaming it back is one call; the alias it adds stays.
  reversible: true,
  docs: {
    summary: 'Rename a counterparty template (a learned booking rule).',
    description:
      'Gives an active template a new name, as the settings panel does. The name is stored lowercase and single-spaced; the old name is kept as an alias, so bank rows with the old text still match the rule. Accounts, VAT and the rule\'s mode do not change, and nothing booked changes. Renaming to the name it already has changes nothing (changed false). Dry-runnable.',
    useWhen: 'A rule carries a bank text as its name (a card reference, a city) and should carry the counterparty\'s own name.',
    doNotUseFor: 'Stopping a rule from proposing (gnubok_update_counterparty_template with mode paused).',
    pitfalls: [
      'Only an active template: a paused one answers COUNTERPARTY_TEMPLATE_NOT_FOUND until it is resumed.',
      'Another active template with the same name answers COUNTERPARTY_TEMPLATE_NAME_TAKEN.',
      'A name shorter than two characters answers VALIDATION_ERROR.',
    ],
    example: {
      request: { counterparty_template_id: '3f2a…', counterparty_name: 'Hallon' },
      response: { data: { template: { ...EXAMPLE_TEMPLATE, mode: 'propose' }, changed: true }, meta: META },
    },
  },
  input: z
    .object({
      counterparty_template_id: TEMPLATE_ID,
      counterparty_name: z.string().trim().min(1).max(100).describe('The new name, e.g. "Hallon".'),
    })
    .strict(),
  output: z.object({
    template: Template,
    changed: z.boolean().describe('False when the template already had the name.'),
  }),
  errorCodes: ['COUNTERPARTY_TEMPLATE_NOT_FOUND', 'COUNTERPARTY_TEMPLATE_NAME_TAKEN', 'VALIDATION_ERROR'],
  mcp: {
    name: 'gnubok_rename_counterparty_template',
    title: 'Rename Counterparty Template',
    description:
      'Stage renaming an active counterparty template (a learned booking rule), id from gnubok_get_counterparty_templates. The old name stays as an alias; accounts and nothing booked change.',
    keywords: ['motpartsmall', 'byt namn', 'döp om', 'regel', 'bokföringsregel', 'konteringsmall'],
    hints: { idempotent: true },
    stage: {
      pendingType: 'rename_counterparty_template',
      title: (input, preview) => {
        const from = displayName(input, preview)
        const to = typeof preview?.new_name_display === 'string' ? preview.new_name_display : String(input.counterparty_name)
        return `Byt namn på regeln ${from} till ${to}`
      },
    },
  },
  run: async (ctx, { counterparty_template_id, counterparty_name }, { dryRun }) => {
    const outcome = await renameCounterpartyTemplate(ctx.supabase, ctx.companyId, counterparty_template_id, counterparty_name, { dryRun })
    if (!outcome.ok) {
      if (outcome.reason === 'NAME_TOO_SHORT') {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          messageSv: 'Namnet måste vara minst två tecken.',
          messageEn: 'The name must be at least two characters.',
        }
      }
      return {
        ok: false,
        code: outcome.reason === 'NOT_FOUND' ? 'COUNTERPARTY_TEMPLATE_NOT_FOUND' : 'COUNTERPARTY_TEMPLATE_NAME_TAKEN',
      }
    }
    const template = summarize(outcome.template)
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          counterparty_template_id,
          counterparty_name_display: formatCounterpartyName(outcome.previousName),
          new_name_display: template.counterparty_name_display,
          debit_account: template.debit_account,
          credit_account: template.credit_account,
          changed: outcome.changed,
        },
      }
    }
    return { ok: true, data: { template, changed: outcome.changed } }
  },
})

export const counterpartyTemplatesUpdate = defineOperation({
  id: 'counterparty-templates.update',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  // The same call with the other mode or flag puts it back.
  reversible: true,
  docs: {
    summary: 'Pause or resume a counterparty template (a learned booking rule), or set whether it always asks for a review.',
    description:
      'Changes a rule as Bokföringsregler does. mode paused: the rule stops proposing its accounts on matching bank rows (the web\'s remove is the same pause); propose: it proposes again. always_review true: every booking from the rule asks for a review and never books with one click. The rule\'s accounts are not edited here: they follow the bookings, so the next booking of the counterparty on other accounts corrects them (a paused rule too, which stays paused until resumed). Nothing booked changes. Asking for what the rule already is changes nothing (changed false). Dry-runnable.',
    useWhen:
      'A rule keeps proposing a wrong account or counterparty, should propose again after a pause, or should always be reviewed.',
    doNotUseFor: 'Correcting a booking already made (gnubok_correct_entry), or renaming a rule (gnubok_rename_counterparty_template).',
    pitfalls: [
      'At least one of mode and always_review must be sent.',
      'mode takes propose or paused only; booking on its own (auto) is not settable.',
      'An id of another company, or none, answers COUNTERPARTY_TEMPLATE_NOT_FOUND.',
    ],
    example: {
      request: { counterparty_template_id: '3f2a…', mode: 'paused' },
      response: { data: { template: EXAMPLE_TEMPLATE, changed: true }, meta: META },
    },
  },
  input: z
    .object({
      counterparty_template_id: TEMPLATE_ID,
      mode: z
        .enum(USER_SETTABLE_MODES)
        .optional()
        .describe('paused stops the rule proposing; propose resumes it.'),
      always_review: z.boolean().optional().describe('true: every booking from the rule asks for a review.'),
    })
    .strict()
    .refine((input) => input.mode !== undefined || input.always_review !== undefined, {
      message: 'Send mode or always_review.',
    }),
  output: z.object({
    template: Template,
    changed: z.boolean().describe('False when the rule already had the requested mode and flag.'),
  }),
  errorCodes: ['COUNTERPARTY_TEMPLATE_NOT_FOUND'],
  mcp: {
    name: 'gnubok_update_counterparty_template',
    title: 'Update Counterparty Template',
    description:
      'Stage pausing (mode paused) or resuming (propose) a counterparty template, a learned booking rule, or setting always_review, id from gnubok_get_counterparty_templates. Pause one that learned a wrong account; nothing booked changes.',
    keywords: ['motpartsmall', 'pausa regel', 'ta bort regel', 'återuppta regel', 'bokföringsregel', 'alltid granska', 'fel konto'],
    hints: { idempotent: true },
    stage: {
      pendingType: 'update_counterparty_template',
      title: (input, preview) => {
        const name = displayName(input, preview)
        if (input.mode === 'paused') return `Pausa regeln för ${name}`
        if (input.mode === 'propose') return `Låt regeln för ${name} föreslå igen`
        return input.always_review === false
          ? `Regeln för ${name} behöver inte alltid granskas`
          : `Regeln för ${name} ska alltid granskas`
      },
    },
  },
  run: async (ctx, { counterparty_template_id, mode, always_review }, { dryRun }) => {
    const rule = await getRule(ctx.supabase, ctx.companyId, counterparty_template_id)
    if (!rule) return { ok: false, code: 'COUNTERPARTY_TEMPLATE_NOT_FOUND' }
    const before = summarize(rule)
    const changed =
      (mode !== undefined && mode !== before.mode) || (always_review !== undefined && always_review !== before.always_review)
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          counterparty_template_id,
          counterparty_name_display: before.counterparty_name_display,
          debit_account: before.debit_account,
          credit_account: before.credit_account,
          mode_before: before.mode,
          mode_after: mode ?? before.mode,
          always_review_before: before.always_review,
          always_review_after: always_review ?? before.always_review,
          changed,
        },
      }
    }
    if (!changed) return { ok: true, data: { template: before, changed: false } }
    const updated = await updateRule(ctx.supabase, ctx.companyId, counterparty_template_id, { mode, always_review })
    if (!updated) return { ok: false, code: 'COUNTERPARTY_TEMPLATE_NOT_FOUND' }
    return { ok: true, data: { template: summarize(updated), changed: true } }
  },
})

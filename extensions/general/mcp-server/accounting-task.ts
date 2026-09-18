import { z } from 'zod'
import { ACCOUNTING_TASKS, ACCOUNTING_TASK_INSTRUCTIONS, type AccountingTaskKind } from '@/lib/ai-handoff/tasks'
import { MAX_HANDOFF_RECORDS } from '@/lib/ai-handoff/prompt'
import { codedError } from './company-routing'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadSkillCatalog, loadCatalogSkill } from '@/lib/agent-skills/catalog'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'

const TaskScopeSchema = z.object({
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
  fiscal_period_id: z.string().uuid().optional(),
  transaction_ids: z.array(z.string().uuid()).max(MAX_HANDOFF_RECORDS).optional(),
  tax_transaction_ids: z.array(z.string().uuid()).max(MAX_HANDOFF_RECORDS).optional(),
  cash_account_id: z.string().uuid().optional(),
  account_key: AccountKeySchema.optional(),
  source: z.enum(['bank', 'skatteverket']).optional(),
  query: z.string().max(500).optional(),
}).strict().refine((s) => !s.date_from || !s.date_to || s.date_from <= s.date_to, 'date_from must not follow date_to')
  .refine((s) => (s.transaction_ids?.length ?? 0) + (s.tax_transaction_ids?.length ?? 0) <= MAX_HANDOFF_RECORDS, 'Too many selected records')

const TaskRequestSchema = z.object({
  kind: z.union([z.enum(Object.keys(ACCOUNTING_TASKS) as [AccountingTaskKind, ...AccountingTaskKind[]]), z.string().regex(/^skill:[a-z0-9][a-z0-9/-]{0,249}$/)]),
  scope: TaskScopeSchema.optional(),
}).strict()

// Compact wire schema; Zod below enforces the detailed validation. Repeating
// Zod's UUID regex in every array needlessly consumes the default tool budget.
const uuid = { type: 'string', format: 'uuid' }
export const ACCOUNTING_TASK_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: {
    kind: { type: 'string', description: 'bookkeep, check, month-close, payroll, vat, year-end, start, or skill:<slug>.' },
    scope: { type: 'object', additionalProperties: false, properties: {
      date_from: { type: 'string', format: 'date' }, date_to: { type: 'string', format: 'date' },
      fiscal_period_id: uuid, cash_account_id: uuid,
      account_key: { type: 'string' },
      transaction_ids: { type: 'array', items: uuid, maxItems: MAX_HANDOFF_RECORDS },
      tax_transaction_ids: { type: 'array', items: uuid, maxItems: MAX_HANDOFF_RECORDS },
      source: { type: 'string', enum: ['bank', 'skatteverket'] }, query: { type: 'string', maxLength: 500 },
    } },
  },
}

export async function getAccountingTask(args: Record<string, unknown>, companyId: string, supabase: SupabaseClient) {
  const parsed = TaskRequestSchema.safeParse(args)
  if (!parsed.success) throw codedError('VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; '))
  const { kind, scope } = parsed.data
  const catalog = await loadSkillCatalog(supabase, companyId)
  const requestedSkill = kind.startsWith('skill:') ? await loadCatalogSkill(supabase, companyId, kind.slice(6)) : null
  if (kind.startsWith('skill:') && !requestedSkill) throw codedError('NOT_FOUND', 'Skill not found')
  const task = requestedSkill
    ? { goal: `Use ${requestedSkill.name} to help the user complete their accounting task. Clarify the objective before making changes.`, skills: [requestedSkill.slug] }
    : ACCOUNTING_TASKS[kind as AccountingTaskKind]
  return {
    company_id: companyId,
    kind,
    goal: task.goal,
    scope: scope ?? {},
    skills: [...new Set([...task.skills, ...catalog.filter((skill) => skill.active && skill.tier !== 'workflow').map((skill) => skill.slug)])],
    instructions: [...ACCOUNTING_TASK_INSTRUCTIONS],
  }
}

import { z } from 'zod'
import { ACCOUNTING_TASKS, ACCOUNTING_TASK_INSTRUCTIONS, type AccountingTaskKind } from '@/lib/ai-handoff/tasks'
import { MAX_HANDOFF_RECORDS } from '@/lib/ai-handoff/prompt'
import { codedError } from './company-routing'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadSkillCatalog, loadCatalogSkill } from '@/lib/agent-skills/catalog'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { loadAgentBundle, type AgentBundle } from '@/lib/agent-skills/agent-bundle'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'

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
  kind: z.union([
    z.enum(Object.keys(ACCOUNTING_TASKS) as [AccountingTaskKind, ...AccountingTaskKind[]]),
    z.string().regex(/^skill:[a-z0-9][a-z0-9/-]{0,249}$/),
    z.string().regex(/^agent:(own\/[0-9a-f-]{36}|[a-z0-9][a-z0-9-]{0,63})$/),
  ]),
  scope: TaskScopeSchema.optional(),
  /** Which AI runs the agent: Kvittojakten's workflow differs per client. */
  client: z.enum(AI_CLIENTS.map((c) => c.id) as [AiClient, ...AiClient[]]).optional(),
}).strict()

/** How an agent is run, prepended to the general handoff instructions. */
export const AGENT_INSTRUCTIONS = [
  'You are running an Accounted agent. `workflow.body` is how to do the job: follow it step by step.',
  'Swedish rules come only from `knowledge` (already included) and `references` (load one with load_skill when a case needs it). Never answer a Swedish tax or accounting rule from memory; if the knowledge does not settle it, say so and ask.',
  '`company_knowledge` is what Accounted knows about this company (registers, ledger, its documents, what it told earlier agents): use it instead of asking the user again. When two facts disagree (for example the VAT method Skatteverket registered and the accounting method in the settings), say so before acting. `onboarding_summary` was written once at sign-up: where it and `facts` differ, the facts win. For anything else in its documents, use `company_knowledge.documents.look_up`.',
  '`company` lists this company\'s industry and structure knowledge: load an entry with load_skill before deciding anything it covers.',
  'A connection with status `missing` cannot be used: tell the user where to connect it (`settings_href`). Status `in_ai` means your own tools (for example Gmail or a browser); use them only if you have them.',
] as const

/**
 * Closes a community flow: a "yes, it worked" is the user's upvote, which
 * tells the next company to trust it. gnubok_feedback saves it to the same
 * row as the upvote on the Agentinstruktioner page.
 */
export function communityClosingInstruction(slug: string): string {
  return `This is a community item shared by another company. When the work is done, ask the user "Fungerade det?" (did it work for you?). On a yes, call gnubok_feedback with skill_slug "${slug}", upvote true, context = what the user said. On a no or no answer, record nothing. Ask once.`
}

/** Added after the knowledge rule only when the company has sections for this workflow. */
export const INDUSTRY_SECTIONS_INSTRUCTION = '`industry_sections` is "Er bransch, för det här arbetsflödet": the parts of this company\'s industry and company-form knowledge that concern this workflow, already included. Read them before `references`; they are more specific to this company than `knowledge`, which still holds where they are silent. The rest of each pack in `company` stays loadable with load_skill.'

// Compact wire schema: TaskRequestSchema above validates everything, and the
// handoff prompt passes scope verbatim, so listing its fields here would only
// spend the default tools/list budget.
export const ACCOUNTING_TASK_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: {
    kind: { type: 'string', description: 'bookkeep, check, month-close, payroll, vat, year-end, start, skill:<slug>, or agent:<id>.' },
    scope: { type: 'object', description: 'From the handoff prompt, unchanged.' },
    client: { type: 'string', enum: ['claude', 'chatgpt', 'grok'] },
  },
}

export async function getAccountingTask(args: Record<string, unknown>, companyId: string, supabase: SupabaseClient) {
  const parsed = TaskRequestSchema.safeParse(args)
  if (!parsed.success) throw codedError('VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; '))
  const { kind, scope, client } = parsed.data
  if (kind.startsWith('agent:')) return getAgentTask(kind.slice(6), scope ?? {}, companyId, supabase, client)
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
    instructions: [...ACCOUNTING_TASK_INSTRUCTIONS, ...(requestedSkill?.tier === 'community' ? [communityClosingInstruction(requestedSkill.slug)] : [])],
  }
}

async function getAgentTask(id: string, scope: z.infer<typeof TaskScopeSchema>, companyId: string, supabase: SupabaseClient, client?: AiClient): Promise<AgentBundle & {
  company_id: string; kind: string; goal: string; scope: z.infer<typeof TaskScopeSchema>; skills: string[]; instructions: string[]
}> {
  const bundle = await loadAgentBundle(supabase, companyId, id, client)
  if (!bundle) throw codedError('NOT_FOUND', `Agent not found: ${id}`)
  return {
    company_id: companyId,
    kind: `agent:${id}`,
    goal: `Run the ${bundle.agent.name} agent for this company. Clarify the objective before making changes.`,
    scope,
    skills: [bundle.workflow.slug, ...bundle.knowledge.map((k) => k.id), ...bundle.industry_sections.map((s) => s.id)],
    instructions: [
      ...AGENT_INSTRUCTIONS.slice(0, 2),
      ...(bundle.industry_sections.length > 0 ? [INDUSTRY_SECTIONS_INSTRUCTION] : []),
      ...AGENT_INSTRUCTIONS.slice(2),
      ...ACCOUNTING_TASK_INSTRUCTIONS,
    ],
    ...bundle,
  }
}

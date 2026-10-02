import { taskSkills, type AccountingTaskRequest } from './tasks'

type Translate = (key: string, values?: Record<string, string | number>) => string

export const MAX_HANDOFF_RECORDS = 200
export const MAX_HANDOFF_INSTRUCTIONS = 2000

export function handoffRecordCount(task: AccountingTaskRequest): number {
  return (task.scope?.transaction_ids?.length ?? 0) + (task.scope?.tax_transaction_ids?.length ?? 0)
}

/** Render locally. Prompts and company context must never enter external URLs. */
export function buildAccountingPrompt(
  input: {
    company: { id: string; name: string }
    task: AccountingTaskRequest
    instructions?: string
  },
  t: Translate,
): string {
  if (handoffRecordCount(input.task) > MAX_HANDOFF_RECORDS) {
    throw new Error('Too many selected records')
  }
  const instructions = input.instructions?.trim() ?? ''
  if (instructions.length > MAX_HANDOFF_INSTRUCTIONS) throw new Error('Instructions are too long')
  const { task, company } = input
  const args = { company_id: company.id, kind: task.kind, ...(task.scope ? { scope: task.scope } : {}) }
  const skills = taskSkills(task.kind)
  return [
    t('prompt_company', { name: company.name, companyId: company.id }),
    task.request || (task.kind.startsWith('skill:') ? t('task_skill', { skill: task.kind.slice(6) }) : t(`task_${task.kind}`)),
    t('prompt_bootstrap', { args: JSON.stringify(args) }),
    skills.length ? t('prompt_skills', { skills: skills.join(', ') }) : t('prompt_discover'),
    t('prompt_scope'),
    t('prompt_evidence'),
    t('prompt_approval'),
    t('prompt_finish'),
    instructions ? t('prompt_extra', { instructions }) : '',
  ].filter(Boolean).join('\n\n')
}

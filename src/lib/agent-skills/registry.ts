import { kvittojaktenSkillSlug, type AiClient } from '@/lib/onboarding/ai-clients'
import type { WorklistCategory } from '@/lib/worklist/types'

/**
 * The ten skills the Skills page shows, in display order. The first two
 * are free and lit from the start; the other eight light up once an AI
 * client is connected. The swedish-* rule packs and the other workflow
 * skills stay background knowledge the agent loads on its own.
 *
 * Browser-safe on purpose: the page imports this file. Names, descriptions
 * and steps are UI strings in messages/*.json under skills_registry.skills.
 */
export const REGISTRY_SKILLS = [
  { id: 'bookkeep', group: 'daily' },
  { id: 'kvittojakten', group: 'daily' },
  { id: 'reconcile-month', group: 'month' },
  { id: 'month-end-close', group: 'month' },
  { id: 'quarterly-vat-review', group: 'vat' },
  { id: 'payroll-monthly', group: 'payroll' },
  { id: 'invoicing-rules', group: 'invoice' },
  { id: 'kreditfaktura-process', group: 'invoice' },
  { id: 'year-end-close', group: 'year' },
  { id: 'tax-planning', group: 'year' },
] as const

export type RegistrySkillId = (typeof REGISTRY_SKILLS)[number]['id']
export type RegistrySkillGroup = (typeof REGISTRY_SKILLS)[number]['group']

/** How many skills are free before an AI is connected. */
export const FREE_SKILLS = 2

/**
 * The slug the agent loads. Kvittojakten has one body per client (the
 * harness block differs), every other skill has a single slug.
 */
export function registrySkillSlug(id: RegistrySkillId, client: AiClient): string {
  return id === 'kvittojakten' ? kvittojaktenSkillSlug(client) : id
}

/**
 * Which "Att göra" counts make a skill worth running right now. A skill is
 * tagged with its count when any of its categories has work waiting. Skills with
 * no entry are never tagged: VAT and payroll deadlines share one count
 * (deadline_action) that does not say which tax is due.
 */
const NOW_CATEGORIES: Partial<Record<RegistrySkillId, readonly WorklistCategory[]>> = {
  bookkeep: ['book_transaction', 'book_skattekonto'],
  kvittojakten: ['verifikat_missing_document', 'inbox_document'],
  'reconcile-month': ['reconciliation_due'],
}

/**
 * Skills whose zero count does not mean done. reconciliation_due answers 0
 * until the company's first sign-off (the adoption gate in
 * countReconciliationDue), so a company that never reconciled would read
 * "Allt klart".
 */
const ZERO_IS_NOT_DONE: ReadonlySet<RegistrySkillId> = new Set(['reconcile-month'])

/** Whether an empty count for the skill means "all done". */
export function hasTodoSignal(id: RegistrySkillId): boolean {
  return id in NOW_CATEGORIES && !ZERO_IS_NOT_DONE.has(id)
}

/** The skills with waiting work, and how many Att göra items each would clear. */
export function skillsToDoNow(counts: Partial<Record<WorklistCategory, number>>): Map<RegistrySkillId, number> {
  const now = new Map<RegistrySkillId, number>()
  for (const [id, categories] of Object.entries(NOW_CATEGORIES) as [RegistrySkillId, readonly WorklistCategory[]][]) {
    const total = categories.reduce((sum, category) => sum + Math.max(0, counts[category] ?? 0), 0)
    if (total > 0) now.set(id, total)
  }
  return now
}

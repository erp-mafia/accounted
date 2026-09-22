import { kvittojaktenSkillSlug, type AiClient } from '@/lib/onboarding/ai-clients'
import type { WorklistCategory } from '@/lib/worklist/types'

/**
 * The ten skills the Skills page shows, in display order. The first three
 * are free and lit from the start; the other seven light up once an AI
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
export const FREE_SKILLS = 3

/**
 * The slug the agent loads. Kvittojakten has one body per client (the
 * harness block differs), every other skill has a single slug.
 */
export function registrySkillSlug(id: RegistrySkillId, client: AiClient): string {
  return id === 'kvittojakten' ? kvittojaktenSkillSlug(client) : id
}

/**
 * Whether the page can show the full instruction text. Kvittojakten lives in
 * the MCP extension, which core must not import, so /api/skills cannot
 * resolve it: the page shows its steps only.
 */
export function registrySkillHasBody(id: RegistrySkillId): boolean {
  return id !== 'kvittojakten'
}

/**
 * Which "Att göra" counts make a skill worth running right now. A skill is
 * tagged "Gör nu" when any of its categories has work waiting. Skills with
 * no entry are never tagged: VAT and payroll deadlines share one count
 * (deadline_action) that does not say which tax is due.
 */
const NOW_CATEGORIES: Partial<Record<RegistrySkillId, readonly WorklistCategory[]>> = {
  bookkeep: ['book_transaction', 'book_skattekonto'],
  kvittojakten: ['verifikat_missing_document', 'inbox_document'],
  'reconcile-month': ['reconciliation_due'],
}

/** The skills with waiting work, given the worklist counts. */
export function skillsToDoNow(counts: Partial<Record<WorklistCategory, number>>): Set<RegistrySkillId> {
  const now = new Set<RegistrySkillId>()
  for (const [id, categories] of Object.entries(NOW_CATEGORIES) as [RegistrySkillId, readonly WorklistCategory[]][]) {
    if (categories.some((category) => (counts[category] ?? 0) > 0)) now.add(id)
  }
  return now
}

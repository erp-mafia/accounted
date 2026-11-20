import type { AiEffort } from '@/lib/ai'

/**
 * Who has the support assistant, and how hard it thinks.
 *
 * SUPPORT_ASSISTANT_COMPANY_IDS lists the companies that get the assistant in
 * the support dialog: comma-separated company ids, or `*` for every company.
 * Unset means nobody, so a deploy never opens it by itself: it is tried on a
 * few companies first and opened for everyone by setting `*`. There is no
 * plan gate behind it. Once the switch says a company has it, every member
 * but the invoicing-only role can ask, on trial and on every plan
 * (decided 2026-11-18); a company that switched AI off under Datadelning och
 * AI is refused by the AI layer itself.
 */
type Env = Record<string, string | undefined>

export function supportAssistantRollout(env: Env = process.env): 'all' | string[] {
  const raw = env.SUPPORT_ASSISTANT_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))]
}

export function isSupportAssistantEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = supportAssistantRollout(env)
  return rollout === 'all' || rollout.includes(companyId)
}

const EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high']

/**
 * SUPPORT_ASSISTANT_EFFORT: how much the model reasons before it answers.
 * `medium` unless set: a support answer is waited for, and most questions are
 * "where do I do this", which the tools answer, not long reasoning. `default`
 * sends no effort at all and leaves it to the model, for an installation
 * whose assistant model does not take the setting.
 */
export function supportAssistantEffort(env: Env = process.env): AiEffort | undefined {
  const raw = env.SUPPORT_ASSISTANT_EFFORT?.trim().toLowerCase()
  if (!raw) return 'medium'
  if (raw === 'default') return undefined
  return EFFORTS.find((effort) => effort === raw) ?? 'medium'
}

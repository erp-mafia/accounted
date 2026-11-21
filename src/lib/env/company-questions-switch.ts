/**
 * COMPANY_QUESTIONS_COMPANY_IDS: the question list (company_questions), its
 * page and routes in the app, its MCP doors and its briefing part. Unset =
 * nobody.
 *
 * It rolls out per company, like BOLAGET_COMPANY_IDS: `*` opens it for every
 * company, a comma-separated list of company ids for those only.
 *
 * What the switch never stops: the rows already written. Switching it off
 * hides the list, it does not delete or change a question.
 */
type Env = Record<string, string | undefined>

export type CompanyQuestionsRollout = 'all' | readonly string[]

/** The companies in the rollout: `'all'` for `*`, else the listed ids (lowercased, each once). */
export function companyQuestionsRollout(env: Env = process.env): CompanyQuestionsRollout {
  const raw = env.COMPANY_QUESTIONS_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether the question list is switched on for this company. */
export function isCompanyQuestionsEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = companyQuestionsRollout(env)
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}

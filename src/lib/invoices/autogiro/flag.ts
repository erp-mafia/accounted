/**
 * Autogiro rolls out per company: it moves customers' money, so it opens to
 * the pilot first and to everyone once real debits have run (rule:
 * no date to anyone until one real debit has gone through).
 *
 * AUTOGIRO_COMPANY_IDS lists the companies (comma-separated ids, or `*` for
 * everyone); unset means nobody, so a deploy never turns it on for anyone.
 * What a company already holds (its mandates, its debits, the reports on
 * them) stays readable whatever the flag says; the flag gates starting.
 */
export function autogiroRollout(): 'all' | string[] {
  const raw = process.env.AUTOGIRO_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether this company can set up Autogiro and write files for Bankgirot. */
export function isAutogiroEnabled(companyId: string | null | undefined): boolean {
  if (!companyId) return false
  const rollout = autogiroRollout()
  return rollout === 'all' || rollout.includes(companyId)
}

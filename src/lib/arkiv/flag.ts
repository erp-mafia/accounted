/**
 * Arkiv rollout flag (dev_docs/arkiv_plan.md). The document knowledge layer
 * ships as an unmerged chain and then rolls out per company: everything that
 * costs model calls or shows new UI runs only for companies listed in
 * ARKIV_COMPANY_IDS (comma-separated company ids, or `*` for everyone). Unset
 * means nobody, so a deploy never starts transcribing every archive at once.
 * Same shape as RECEIPT_HUNT_COMPANY_IDS.
 */
export function arkivRollout(): 'all' | string[] {
  const raw = process.env.ARKIV_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  // Each company once: the crons walk this list, and a repeated id would take a slot per repeat.
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

export function isArkivEnabled(companyId: string | null | undefined): boolean {
  if (!companyId) return false
  const rollout = arkivRollout()
  return rollout === 'all' || rollout.includes(companyId)
}

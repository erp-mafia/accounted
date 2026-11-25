/**
 * The second arrangement of the books act (the AI and the receipts as steps
 * of their own) is shown per person. ONBOARDING_SOURCES_USER_IDS lists the
 * users (comma-separated ids, or `*` for everyone); unset or empty means
 * nobody, so a deploy never changes anyone's onboarding.
 */
export function onboardingSourcesRollout(): 'all' | string[] {
  const raw = process.env.ONBOARDING_SOURCES_USER_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether this user sees the arrangement with the AI and receipts steps. */
export function isOnboardingSourcesEnabled(userId: string | null | undefined): boolean {
  if (!userId) return false
  const rollout = onboardingSourcesRollout()
  return rollout === 'all' || rollout.includes(userId)
}

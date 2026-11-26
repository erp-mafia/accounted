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

/**
 * The extensions the arrangement's own two stops connect through: the agent
 * connection (the AI stop) and the inbox (the receipts stop).
 */
export const SOURCES_FLOW_EXTENSIONS: readonly string[] = ['mcp-server', 'invoice-inbox']

/**
 * Whether this deployment can show the arrangement at all. Without one of
 * the extensions above a stop would offer what the deployment does not have,
 * so the first arrangement stands, whoever the rollout lists.
 */
export function sourcesFlowAvailable(enabledExtensionIds: ReadonlySet<string>): boolean {
  return SOURCES_FLOW_EXTENSIONS.every((id) => enabledExtensionIds.has(id))
}

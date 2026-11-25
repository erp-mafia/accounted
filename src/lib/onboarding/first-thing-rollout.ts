/**
 * Hem's first-thing block rolls out per person. HEM_FIRST_THING_USER_IDS
 * lists the users (comma-separated ids, or `*` for everyone); unset or empty
 * means nobody, so a deploy never changes anyone's Hem.
 */
export function hemFirstThingRollout(): 'all' | string[] {
  const raw = process.env.HEM_FIRST_THING_USER_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether this person's Hem may open on the first-thing block. */
export function isHemFirstThingEnabled(userId: string | null | undefined): boolean {
  if (!userId) return false
  const rollout = hemFirstThingRollout()
  return rollout === 'all' || rollout.includes(userId)
}

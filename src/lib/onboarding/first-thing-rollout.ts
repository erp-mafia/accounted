import { isSaneDateString } from '@/lib/invariants/iso-date'

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

/**
 * HEM_FIRST_THING_FROM: the first day (YYYY-MM-DD, the UTC day of the
 * creation time) a company may have been created on to get the block, so switching the block on for everyone leaves
 * the Hem of companies already under way as it is. Unset, empty or not a day
 * that exists (2026-02-31): no such day, every company young enough gets it.
 */
export function hemFirstThingCreatedFrom(): string | null {
  const raw = process.env.HEM_FIRST_THING_FROM?.trim()
  return raw && isSaneDateString(raw) ? raw : null
}

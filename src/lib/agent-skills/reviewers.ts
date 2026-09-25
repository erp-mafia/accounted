/**
 * Who reviews shared instructions for Accounted before they are published:
 * COMMUNITY_REVIEWER_USER_IDS, comma-separated user ids. Unset means nobody,
 * so the review list is closed until someone is named.
 */
export function isCommunityReviewer(userId: string | null | undefined): boolean {
  if (!userId) return false
  const raw = process.env.COMMUNITY_REVIEWER_USER_IDS?.trim()
  if (!raw) return false
  return raw.split(',').map((s) => s.trim()).includes(userId)
}

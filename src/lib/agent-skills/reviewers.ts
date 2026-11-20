/**
 * Who reviews shared instructions for Accounted before they are published:
 * COMMUNITY_REVIEWER_USER_IDS, comma-separated user ids. Unset means nobody,
 * so the review list is closed until someone is named.
 */
export function communityReviewerIds(): string[] {
  const raw = process.env.COMMUNITY_REVIEWER_USER_IDS?.trim()
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export function isCommunityReviewer(userId: string | null | undefined): boolean {
  if (!userId) return false
  return communityReviewerIds().includes(userId)
}

import { notFound } from 'next/navigation'
import { getDashboardAuthContext } from '../../request-context'
import { isCommunityReviewer } from '@/lib/agent-skills/reviewers'
import { ReviewQueue } from '@/components/skills/ReviewQueue'

/** /skills/granskning: Accounted's review of shared instructions. Reviewers only (COMMUNITY_REVIEWER_USER_IDS). */
export default async function CommunityReviewPage() {
  const { user } = await getDashboardAuthContext()
  if (!isCommunityReviewer(user?.id)) notFound()
  return <ReviewQueue />
}

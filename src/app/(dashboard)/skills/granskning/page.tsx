import { notFound } from 'next/navigation'
import { getDashboardAuthContext } from '../../request-context'
import { isCommunityReviewer } from '@/lib/agent-skills/reviewers'
import { reviewerSessionHasMfa } from '@/lib/agent-skills/reviewer-mfa'
import { ReviewQueue } from '@/components/skills/ReviewQueue'

/**
 * /skills/granskning: Accounted's review of shared instructions. Reviewers
 * only (COMMUNITY_REVIEWER_USER_IDS), and only with MFA in the session (CASA
 * 3.3.1, lib/agent-skills/reviewer-mfa.ts): without it the page says how to
 * turn it on instead of showing the queue, whose routes refuse with 403.
 */
export default async function CommunityReviewPage() {
  const { supabase, user } = await getDashboardAuthContext()
  if (!isCommunityReviewer(user?.id)) notFound()
  const mfaSatisfied = await reviewerSessionHasMfa(supabase)
  return <ReviewQueue mfaRequired={!mfaSatisfied} />
}

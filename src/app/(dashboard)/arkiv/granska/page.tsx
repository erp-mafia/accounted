import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { ArkivReview } from '@/components/arkiv/ArkivReview'

/**
 * /arkiv/granska: the two questions Arkiv asks a person (phase 2).
 * "Är du säker på att det här rör bolaget?" for documents held at the door,
 * and "Vad är det här dokumentet?" for admitted documents the classifier
 * could not settle. Reachable from Att göra; 404 outside the rollout.
 */
export default async function ArkivReviewPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivEnabled(companyId)) notFound()
  return <ArkivReview />
}

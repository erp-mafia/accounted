import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { ArkivAgreements } from '@/components/arkiv/ArkivAgreements'

/**
 * /arkiv/avtal: the company's agreements as Arkiv derived them (phase 4),
 * with the next expected payment and the dates that went into Viktiga datum,
 * each pointing back at its page. 404 outside the rollout.
 */
export default async function ArkivAgreementsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivBrainEnabled(companyId)) notFound()
  return <ArkivAgreements />
}

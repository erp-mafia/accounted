import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../request-context'
import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { ArkivHome } from '@/components/arkiv/ArkivHome'

/** /arkiv: every document, search and upload. 404 for a company outside the section rollout. */
export default async function ArkivPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivSectionEnabled(companyId)) notFound()
  return <ArkivHome />
}

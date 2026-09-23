import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../request-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { ArkivHome } from '@/components/arkiv/ArkivHome'

/** /arkiv: the graph and every document (plan of record, decisions 4, 7 and 8). 404 outside the rollout. */
export default async function ArkivPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivEnabled(companyId)) notFound()
  return <ArkivHome />
}

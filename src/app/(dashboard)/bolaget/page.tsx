import { notFound } from 'next/navigation'
import { getDashboardAuthContext, getDashboardCompanyId } from '../request-context'
import { bolagetHubAccess } from '@/lib/bolaget/gate'
import { bolagetHubOpen } from '@/lib/bolaget/hub'
import { BolagetOverview } from '@/components/bolaget/BolagetOverview'

/**
 * /bolaget: the overview of the Bolaget registers, one line each. 404 for a
 * company with neither half open (outside BOLAGET_COMPANY_IDS).
 */
export default async function BolagetPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId) notFound()
  const { supabase } = await getDashboardAuthContext()
  const access = await bolagetHubAccess(supabase, companyId)
  if (!bolagetHubOpen(access)) notFound()
  return <BolagetOverview access={access} />
}

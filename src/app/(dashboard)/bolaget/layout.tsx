import { getDashboardAuthContext, getDashboardCompanyId } from '../request-context'
import { bolagetHubAccess } from '@/lib/bolaget/gate'
import { NO_BOLAGET_ACCESS } from '@/lib/bolaget/hub'
import { BolagetHubProvider } from '@/components/bolaget/BolagetTabs'

/**
 * The /bolaget pages share one tab bar (BolagetTabs); which tabs the company
 * has is resolved once here. Each page still answers 404 by its own gate.
 */
export default async function BolagetLayout({ children }: { children: React.ReactNode }) {
  const companyId = await getDashboardCompanyId()
  const access = companyId ? await bolagetHubAccess((await getDashboardAuthContext()).supabase, companyId) : NO_BOLAGET_ACCESS
  return <BolagetHubProvider access={access}>{children}</BolagetHubProvider>
}

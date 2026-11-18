import { notFound } from 'next/navigation'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'
import { bolagetGate } from '@/lib/bolaget/gate'
import { ShareRegister } from '@/components/bolaget/ShareRegister'

/** /bolaget/aktiebok: Aktiebok (ABL 5-6 kap.). 404 outside BOLAGET_COMPANY_IDS and for a form without an aktiebok. */
export default async function ShareRegisterPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId) notFound()
  const { supabase } = await getDashboardAuthContext()
  if (await bolagetGate(supabase, companyId)) notFound()
  return <ShareRegister />
}

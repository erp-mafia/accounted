import { notFound } from 'next/navigation'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'
import { bolagetGate } from '@/lib/bolaget/gate'
import { MeetingsRegister } from '@/components/bolaget/MeetingsRegister'

/** /bolaget/moten: Möten och protokoll (bolagsstämmor, styrelsemöten, per capsulam). 404 outside BOLAGET_COMPANY_IDS and for a form without an aktiebok. */
export default async function MeetingsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId) notFound()
  const { supabase } = await getDashboardAuthContext()
  if (await bolagetGate(supabase, companyId)) notFound()
  return <MeetingsRegister />
}

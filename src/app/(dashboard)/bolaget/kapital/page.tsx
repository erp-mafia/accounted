import { notFound } from 'next/navigation'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'
import { bolagetGate } from '@/lib/bolaget/gate'
import { CapitalEvents } from '@/components/bolaget/CapitalEvents'

/** /bolaget/kapital: Kapital och utdelning (ABL 12-13, 17-18, 20 kap.; KU31). 404 outside BOLAGET_COMPANY_IDS and for a form without an aktiebok. */
export default async function CapitalEventsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId) notFound()
  const { supabase } = await getDashboardAuthContext()
  if (await bolagetGate(supabase, companyId)) notFound()
  return <CapitalEvents />
}

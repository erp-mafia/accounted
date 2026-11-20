import { notFound } from 'next/navigation'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'
import { bolagetGate } from '@/lib/bolaget/gate'
import { BoardAndSignatories } from '@/components/bolaget/BoardAndSignatories'

/** /bolaget/styrelse: Styrelse och firmateckning, with the verkliga huvudmän. 404 outside BOLAGET_COMPANY_IDS and for a form without an aktiebok. */
export default async function BoardPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId) notFound()
  const { supabase } = await getDashboardAuthContext()
  if (await bolagetGate(supabase, companyId)) notFound()
  return <BoardAndSignatories />
}

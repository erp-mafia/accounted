import { notFound } from 'next/navigation'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'
import { bolagetGate } from '@/lib/bolaget/gate'
import { OwnerTax } from '@/components/bolaget/OwnerTax'

/** /bolaget/agarskatt: Ägarskatt och närstående (K10 underlag, owner loans and ABL 21 kap., KU20). 404 outside BOLAGET_COMPANY_IDS and for a form without an aktiebok. */
export default async function OwnerTaxPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId) notFound()
  const { supabase } = await getDashboardAuthContext()
  if (await bolagetGate(supabase, companyId)) notFound()
  return <OwnerTax />
}

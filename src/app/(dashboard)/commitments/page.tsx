import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../request-context'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import { CommitmentsRegister } from '@/components/commitments/CommitmentsRegister'

/** /commitments: Avtal och åtaganden (Bolaget). 404 for a company outside BOLAGET_COMPANY_IDS. */
export default async function CommitmentsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !commitmentsEnabledFor(companyId)) notFound()
  return <CommitmentsRegister />
}

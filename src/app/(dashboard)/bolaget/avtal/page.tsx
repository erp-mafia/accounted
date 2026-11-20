import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import { CommitmentsRegister } from '@/components/commitments/CommitmentsRegister'

/** /bolaget/avtal: Avtal och åtaganden, the Avtal tab of Bolaget. 404 for a company outside BOLAGET_COMPANY_IDS. */
export default async function AgreementsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !commitmentsEnabledFor(companyId)) notFound()
  return <CommitmentsRegister />
}

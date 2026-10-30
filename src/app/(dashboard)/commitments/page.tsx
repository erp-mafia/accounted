import { notFound, redirect } from 'next/navigation'
import { getDashboardCompanyId } from '../request-context'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'

/**
 * /commitments: Avtal och åtaganden moved under Bolaget as its Avtal tab
 * (/bolaget/avtal); an old link lands there. 404 for a company outside
 * BOLAGET_COMPANY_IDS, as before.
 */
export default async function CommitmentsPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !commitmentsEnabledFor(companyId)) notFound()
  redirect('/bolaget/avtal')
}

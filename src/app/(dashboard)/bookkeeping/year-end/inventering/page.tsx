import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '@/app/(dashboard)/request-context'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'
import { StockCountRegister } from '@/components/bokslut/StockCountRegister'

/**
 * /bookkeeping/year-end/inventering: the year-end stock count
 * (inventeringslista, LIV 1955:257), next to the other bokslut registers.
 * 404 unless the company is in BOLAGET_COMPANY_IDS.
 */
export default async function StockCountPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !stockCountEnabledFor(companyId)) notFound()
  return <StockCountRegister />
}

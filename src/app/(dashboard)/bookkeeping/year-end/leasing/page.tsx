import { notFound } from 'next/navigation'
import { financeLeaseEnabled } from '@/lib/env/finance-lease-switch'
import { FinanceLeaseRegister } from '@/components/bokslut/FinanceLeaseRegister'

/** /bookkeeping/year-end/leasing: finansiella leasingavtal (K3 kapitel 20). 404 while the switch is off. */
export default function FinanceLeasesPage() {
  if (!financeLeaseEnabled()) notFound()
  return <FinanceLeaseRegister />
}

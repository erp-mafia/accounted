import { notFound } from 'next/navigation'
import { contractRevenueEnabled } from '@/lib/env/contract-revenue-switch'
import { ContractRevenueRegister } from '@/components/bokslut/ContractRevenueRegister'

/** /bookkeeping/year-end/pagaende-arbeten: pågående arbeten (K3 kapitel 23). 404 while the switch is off. */
export default function ContractRevenuePage() {
  if (!contractRevenueEnabled()) notFound()
  return <ContractRevenueRegister />
}

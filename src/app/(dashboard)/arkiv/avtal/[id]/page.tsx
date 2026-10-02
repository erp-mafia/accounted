import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../../request-context'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { AgreementRecord } from '@/components/arkiv/AgreementRecord'

/** /arkiv/avtal/[id]: one agreement with its facts, payments, dates and history. */
export default async function AgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivBrainEnabled(companyId)) notFound()
  const { id } = await params
  return <AgreementRecord agreementId={id} />
}

import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../../request-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { DocumentRecord } from '@/components/arkiv/DocumentRecord'

/** /arkiv/dokument/[id]: a document as a record. */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivEnabled(companyId)) notFound()
  const { id } = await params
  return <DocumentRecord documentId={id} />
}

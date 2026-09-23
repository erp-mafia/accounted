import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../../request-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { DocumentRecord } from '@/components/arkiv/DocumentRecord'

/** /arkiv/dokument/[id]?page=N: a document as a record, opened at a page when a search hit points there. */
export default async function DocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivEnabled(companyId)) notFound()
  const [{ id }, { page }] = await Promise.all([params, searchParams])
  const initialPage = page && /^[1-9][0-9]{0,3}$/.test(page) ? Number(page) : null
  return <DocumentRecord documentId={id} initialPage={initialPage} />
}

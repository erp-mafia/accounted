import JournalEntryDetail from '@/components/bookkeeping/JournalEntryDetail'
import { getInitialJournalEntryDetail } from './initial-data'

export default async function JournalEntryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const seed = await getInitialJournalEntryDetail(id)
  return <JournalEntryDetail id={id} initialCompanyId={seed?.companyId} initialData={seed?.data} />
}

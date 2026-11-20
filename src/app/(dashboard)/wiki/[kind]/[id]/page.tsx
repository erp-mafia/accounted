import { WikiRecordPage } from '@/components/wiki/WikiRecordPage'

/** One record in the wiki, as gnubok_get_record opens it for an agent. */
export default async function WikiRecordRoute({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params
  return <WikiRecordPage kind={kind} id={id} />
}

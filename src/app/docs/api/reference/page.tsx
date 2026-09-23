import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { buildReferenceOverviewMd } from '@/lib/docs/content/reference'

export const metadata: Metadata = {
  title: 'API reference · accounted API',
  description: 'Every endpoint exposed by the accounted REST API, grouped by resource.',
}

export default function DocsApiReferencePage() {
  return (
    <DocsLayout currentPath="/docs/api/reference">
      <DocsMarkdown source={buildReferenceOverviewMd()} />
    </DocsLayout>
  )
}

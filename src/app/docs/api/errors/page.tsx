import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { buildErrorReferenceMd } from '@/lib/docs/content/errors'

export const metadata: Metadata = {
  title: 'Errors · accounted API',
  description: 'Every stable error code returned by the accounted REST API, with HTTP status, description, and remediation.',
}

export default function DocsApiErrorsPage() {
  const md = buildErrorReferenceMd()
  return (
    <DocsLayout currentPath="/docs/api/errors">
      <DocsMarkdown source={md} />
    </DocsLayout>
  )
}

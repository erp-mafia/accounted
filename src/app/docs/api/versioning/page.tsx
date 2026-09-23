import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { VERSIONING_MD } from '@/lib/docs/content/versioning'

export const metadata: Metadata = {
  title: 'Versioning · accounted API',
  description: 'How API versions are pinned, upgraded, and deprecated. Plus idempotency, dry-run, and strict-mode write semantics.',
}

export default function DocsApiVersioningPage() {
  return (
    <DocsLayout currentPath="/docs/api/versioning">
      <DocsMarkdown source={VERSIONING_MD} />
    </DocsLayout>
  )
}

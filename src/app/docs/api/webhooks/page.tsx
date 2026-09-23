import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { WEBHOOKS_MD } from '@/lib/docs/content/webhooks'

export const metadata: Metadata = {
  title: 'Webhooks · accounted API',
  description: 'Receive HMAC-signed POST notifications when state changes in accounted. Includes signature verification samples in Node.js and Python.',
}

export default function DocsApiWebhooksPage() {
  return (
    <DocsLayout currentPath="/docs/api/webhooks">
      <DocsMarkdown source={WEBHOOKS_MD} />
    </DocsLayout>
  )
}

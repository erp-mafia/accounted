import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { CLI_MD } from '@/lib/docs/content/cli'

export const metadata: Metadata = {
  title: 'Command line (CLI) · accounted API',
  description:
    'Run every Accounted tool from a terminal, a script, or a shell agent (Claude Code, Codex, Cursor) with the accounted CLI: browser sign-in, JSON arguments, staged writes you approve.',
}

export default function DocsApiCliPage() {
  return (
    <DocsLayout currentPath="/docs/api/cli">
      <DocsMarkdown source={CLI_MD} />
    </DocsLayout>
  )
}

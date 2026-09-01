import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { ANSLUT_CLAUDE_MD } from '@/lib/docs/content/anslut-claude'

export const metadata: Metadata = {
  title: 'Anslut Claude · accounted API',
  description:
    'Koppla Accounted till Claude (claude.ai, Claude Desktop, Claude Code) via MCP-servern: OAuth 2.1-connector, Claude Code-plugin eller npx accounted-mcp.',
}

export default function DocsApiAnslutClaudePage() {
  return (
    <DocsLayout currentPath="/docs/api/anslut-claude">
      <DocsMarkdown source={ANSLUT_CLAUDE_MD} />
    </DocsLayout>
  )
}

import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { CONNECT_CLAUDE_MD } from '@/lib/docs/content/connect-claude'

export const metadata: Metadata = {
  title: 'Connect with Claude · accounted API',
  description:
    'Connect Accounted to Claude (claude.ai, Claude Desktop, Claude Code) via the MCP server: OAuth 2.1 connector or the npx gnubok-mcp stdio bridge.',
}

export default function DocsApiConnectClaudePage() {
  return (
    <DocsLayout currentPath="/docs/api/connect-claude">
      <DocsMarkdown source={CONNECT_CLAUDE_MD} />
    </DocsLayout>
  )
}

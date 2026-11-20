import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { KOMMANDORAD_MD } from '@/lib/docs/content/kommandorad'

export const metadata: Metadata = {
  title: 'Kommandoraden · accounted API',
  description:
    'Använd alla Accounted-verktyg från terminalen, skript eller en agent (Claude Code, Codex, Cursor) med kommandot accounted: inloggning i webbläsaren, JSON-argument och skrivningar som du godkänner.',
}

export default function DocsApiKommandoradPage() {
  return (
    <DocsLayout currentPath="/docs/api/kommandorad">
      <DocsMarkdown source={KOMMANDORAD_MD} />
    </DocsLayout>
  )
}

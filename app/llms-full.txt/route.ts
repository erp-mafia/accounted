/**
 * /llms-full.txt: full docs concatenated for LLM ingestion.
 *
 * Sibling to /llms.txt (which is the concise discovery index). This is the
 * "ingest the whole thing in one HTTP call" surface: agents that need
 * deep context can fetch this once and parse instead of crawling every
 * /docs/api/*.md page individually.
 *
 * Concatenates: landing → versioning → webhooks concept → errors →
 * reference overview → every per-resource reference → quickstart cookbook
 * → webhooks cookbook → changelog. Section separators are `---` so a
 * downstream Markdown parser sees them as horizontal rules.
 */

import { NextResponse } from 'next/server'
import { LANDING_MD } from '@/lib/docs/content/landing'
import { VERSIONING_MD } from '@/lib/docs/content/versioning'
import { WEBHOOKS_MD } from '@/lib/docs/content/webhooks'
import { CHANGELOG_MD } from '@/lib/docs/content/changelog'
import { buildErrorReferenceMd } from '@/lib/docs/content/errors'
import { buildReferenceOverviewMd, buildResourcePages } from '@/lib/docs/content/reference'
import { COOKBOOK } from '@/lib/docs/content/cookbook'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'

function joinSections(sections: string[]): string {
  return sections.map((s) => s.trim()).join('\n\n---\n\n')
}

function build(): string {
  const sections: string[] = [
    LANDING_MD,
    VERSIONING_MD,
    WEBHOOKS_MD,
    buildErrorReferenceMd(),
    buildReferenceOverviewMd(),
  ]

  for (const page of buildResourcePages()) {
    sections.push(page.markdown)
  }

  for (const recipe of COOKBOOK) {
    if (recipe.markdown) sections.push(recipe.markdown)
  }

  sections.push(CHANGELOG_MD)

  return joinSections(sections)
}

export async function GET() {
  return new NextResponse(build(), {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}

/**
 * /.well-known/skills/index.json: workflow catalogue exposed at a well-known URL.
 *
 * Mirrors the MCP `gnubok_list_skills` tool: a flat array of skill descriptors
 * (slug, name, summary, tags) that external agents can discover without
 * speaking MCP. Each skill's full Markdown body remains gated behind MCP +
 * authentication; this index is public summary metadata only.
 */

import { NextResponse } from 'next/server'
import { skills } from '@/extensions/general/mcp-server/skills'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'
import { getCanonicalBaseUrl } from '@/lib/api/v1/base-url'

export async function GET(_request: Request) {
  const base = getCanonicalBaseUrl()

  const catalogue = {
    schema_version: '1',
    api_version: API_V1_VERSION,
    docs_url: `${base}/docs/api`,
    mcp_endpoint: `${base}/api/extensions/ext/mcp-server/mcp`,
    skills: skills.map((s) => ({
      slug: s.slug,
      name: s.name,
      summary: s.summary,
      tags: s.tags,
      /** MCP resource URI; load via the MCP server's resources/read with an authenticated key. */
      uri: `Accounted://skill/${s.slug}`,
    })),
  }

  return NextResponse.json(catalogue, {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}

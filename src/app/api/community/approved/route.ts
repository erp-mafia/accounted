import { NextResponse } from 'next/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { COMMUNITY_OPEN } from '@/lib/agent-skills/agents'
import { loadApprovedCommunityItems } from '@/lib/agent-skills/community-approved'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('community.approved')

/**
 * Public, no login: the community items accounted.se may show, as
 * [{ slug, sha }], and whether sharing from the app is open. The website
 * lists community/<slug> of erp-mafia/accounted-skills only when its SKILL.md
 * hashes to sha, the text an Accounted reviewer approved, and shows the
 * "Dela från Accounted" button only while sharing is open. Until the
 * community launches (COMMUNITY_OPEN) the list is empty, as it is in the app.
 *
 * No auth wrapper on purpose: there is no user or company here, and nothing
 * but names and hashes of files that are already public. The CDN caches it
 * for five minutes, so traffic on it does not reach the database.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const items = COMMUNITY_OPEN ? await loadApprovedCommunityItems(createServiceClientNoCookies()) : []
    return NextResponse.json({ data: { sharing_open: COMMUNITY_OPEN, items } }, {
      headers: withPublicSecurityHeaders({ 'Cache-Control': 'public, max-age=300, s-maxage=300' }),
    })
  } catch (err) {
    // A failed read must never be cached as "nothing is approved": the website falls back to showing none anyway.
    const response = errorResponse(err, log)
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}

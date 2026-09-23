import { NextResponse } from 'next/server'
import { buildReferenceOverviewMd } from '@/lib/docs/content/reference'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'

export async function GET() {
  return new NextResponse(buildReferenceOverviewMd(), {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}

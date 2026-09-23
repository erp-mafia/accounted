import { NextResponse } from 'next/server'
import { buildErrorReferenceMd } from '@/lib/docs/content/errors'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'

export async function GET() {
  return new NextResponse(buildErrorReferenceMd(), {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}

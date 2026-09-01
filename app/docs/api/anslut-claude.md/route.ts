import { NextResponse } from 'next/server'
import { ANSLUT_CLAUDE_MD } from '@/lib/docs/content/anslut-claude'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'

export async function GET() {
  return new NextResponse(ANSLUT_CLAUDE_MD, {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}

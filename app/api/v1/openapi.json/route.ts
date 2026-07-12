/**
 * GET /api/v1/openapi.json: public OpenAPI 3.1 spec for the v1 surface.
 *
 * Generated from the Zod schema registry at request time. Cached for 5
 * minutes in shared caches.
 */

import { NextResponse } from 'next/server'
import { generateOpenApiSpec } from '@/lib/api/v1/registry'
import { withPublicSecurityHeaders } from '@/lib/api/v1/security-headers'
import { getCanonicalBaseUrl } from '@/lib/api/v1/base-url'
import '@/lib/api/v1/load-routes'

export async function GET(_request: Request) {
  const spec = generateOpenApiSpec(getCanonicalBaseUrl())

  return NextResponse.json(spec, {
    status: 200,
    headers: withPublicSecurityHeaders({
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    }),
  })
}

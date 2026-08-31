import { NextResponse } from 'next/server'
import { buildProtectedResourceMetadata } from '@/lib/auth/protected-resource-metadata'

/**
 * RFC 9728: Protected Resource Metadata, root location. This is the URL the
 * MCP endpoint's 401 `WWW-Authenticate` header points at. The same document
 * is also served at the path-based and endpoint-appended locations (see
 * lib/auth/protected-resource-metadata.ts for why all three exist).
 */
export async function GET(request: Request) {
  return NextResponse.json(buildProtectedResourceMetadata(request))
}

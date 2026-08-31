import { NextResponse } from 'next/server'
import {
  MCP_RESOURCE_PATH,
  buildProtectedResourceMetadata,
} from '@/lib/auth/protected-resource-metadata'

/**
 * RFC 9728 §3.1 path-based Protected Resource Metadata:
 * `/.well-known/oauth-protected-resource{resource-path}`.
 *
 * Claude.ai's connector setup derives this URL from the MCP server URL and
 * fetches it before any 401 challenge; without it the dialog reports
 * "Authorization with Accounted failed". Only the MCP endpoint is a protected
 * resource here, so every other path is a 404 rather than a generic answer
 * that would advertise resources this server does not serve.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  const resourcePath = '/' + (path ?? []).join('/')
  if (resourcePath !== MCP_RESOURCE_PATH) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json(buildProtectedResourceMetadata(request))
}

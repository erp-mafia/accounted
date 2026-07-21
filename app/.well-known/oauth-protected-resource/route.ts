import { NextResponse } from 'next/server'
import { resolveDiscoveryBaseUrl } from '@/lib/api/v1/base-url'

/**
 * RFC 9728: Protected Resource Metadata.
 * Tells MCP clients which authorization server to use.
 *
 * The resource/AS URLs reflect the (allowlisted) request host: MCP clients
 * validate the advertised resource against the server URL they were
 * configured with, and existing connectors point at the legacy
 * app.gnubok.se domain after the app.accounted.se cutover.
 */
export async function GET(request: Request) {
  const appUrl = resolveDiscoveryBaseUrl(request)

  return NextResponse.json({
    resource: `${appUrl}/api/extensions/ext/mcp-server/mcp`,
    authorization_servers: [appUrl],
    scopes_supported: ['mcp'],
  })
}

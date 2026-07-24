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
  const resource = new URL('/api/extensions/ext/mcp-server/mcp', appUrl)
  // `accounted` is the COMPLETE allow-list of reflectable namespaces. We never
  // echo the inbound parameter value: on an exact match we set the fixed
  // literal, so a crafted tool_namespace (URL-special chars, other values) can
  // never reach the advertised resource URL. Do not loosen this to a broader
  // match without re-checking every downstream consumer that parses `resource`.
  if (new URL(request.url).searchParams.get('tool_namespace') === 'accounted') {
    resource.searchParams.set('tool_namespace', 'accounted')
  }

  return NextResponse.json({
    resource: resource.toString(),
    authorization_servers: [appUrl],
    scopes_supported: ['mcp'],
  })
}

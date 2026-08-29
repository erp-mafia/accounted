import { resolveDiscoveryBaseUrl } from '@/lib/api/v1/base-url'

/** Path of the one protected resource this server advertises: the MCP endpoint. */
export const MCP_RESOURCE_PATH = '/api/extensions/ext/mcp-server/mcp'

/**
 * RFC 9728 Protected Resource Metadata for the MCP endpoint.
 *
 * Served from three URLs, because clients derive the location differently:
 *   - `/.well-known/oauth-protected-resource` (root): what our 401
 *     `WWW-Authenticate: resource_metadata=` header points at; Claude Code
 *     and the stdio bridges follow that hint.
 *   - `/.well-known/oauth-protected-resource/api/extensions/ext/mcp-server/mcp`
 *     (RFC 9728 §3.1 path-based form): Claude.ai's connector setup derives
 *     this from the server URL and fetches it BEFORE any 401, so a 404 here
 *     reads as "Authorization failed" in the connector dialog.
 *   - `/api/extensions/ext/mcp-server/mcp/.well-known/oauth-protected-resource`
 *     (endpoint-appended form, tried by the same client as a fallback).
 *
 * The resource/AS URLs reflect the (allowlisted) request host: MCP clients
 * validate the advertised resource against the server URL they were
 * configured with, and existing connectors point at the legacy
 * app.gnubok.se domain after the app.accounted.se cutover.
 */
export function buildProtectedResourceMetadata(request: Request): {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
} {
  const appUrl = resolveDiscoveryBaseUrl(request)
  const resource = new URL(MCP_RESOURCE_PATH, appUrl)
  // `accounted` is the COMPLETE allow-list of reflectable namespaces. We never
  // echo the inbound parameter value: on an exact match we set the fixed
  // literal, so a crafted tool_namespace (URL-special chars, other values) can
  // never reach the advertised resource URL. Do not loosen this to a broader
  // match without re-checking every downstream consumer that parses `resource`.
  if (new URL(request.url).searchParams.get('tool_namespace') === 'accounted') {
    resource.searchParams.set('tool_namespace', 'accounted')
  }

  return {
    resource: resource.toString(),
    authorization_servers: [appUrl],
    scopes_supported: ['mcp'],
  }
}

import { NextResponse } from 'next/server'
import { PUBLIC_OAUTH_METADATA_SCOPES } from '@/lib/auth/api-keys'
import { resolveDiscoveryBaseUrl } from '@/lib/api/v1/base-url'

/**
 * RFC 8414: OAuth 2.0 Authorization Server Metadata.
 * Tells MCP clients where the authorize/token endpoints are.
 *
 * The issuer reflects the (allowlisted) request host: clients that
 * connected via the legacy app.gnubok.se domain must keep seeing a
 * self-consistent issuer there, or their issuer validation breaks on
 * re-auth after the app.accounted.se cutover.
 */
export async function GET(request: Request) {
  const appUrl = resolveDiscoveryBaseUrl(request)

  return NextResponse.json({
    issuer: appUrl,
    authorization_endpoint: `${appUrl}/api/mcp-oauth/authorize`,
    token_endpoint: `${appUrl}/api/mcp-oauth/token`,
    registration_endpoint: `${appUrl}/api/mcp-oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    // RFC 9207: the authorize endpoint includes `iss` in every authorization
    // response (success and error) so clients can detect mix-up attacks.
    authorization_response_iss_parameter_supported: true,
    // Advertise only the safe read-only default scopes plus the coarse
    // `mcp` marker. Destructive scopes (*:write, pending_operations:approve,
    // bookkeeping:write) are still accepted by /authorize when requested
    // explicitly, but enumerating them in public discovery aids
    // scope-escalation reconnaissance (CC6.1, defense-in-depth).
    scopes_supported: ['mcp', ...PUBLIC_OAUTH_METADATA_SCOPES],
  })
}

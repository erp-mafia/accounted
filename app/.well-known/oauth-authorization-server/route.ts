import { NextResponse } from 'next/server'
import { PUBLIC_OAUTH_METADATA_SCOPES } from '@/lib/auth/api-keys'

/**
 * RFC 8414: OAuth 2.0 Authorization Server Metadata.
 * Tells MCP clients where the authorize/token endpoints are.
 */
export async function GET() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  return NextResponse.json({
    issuer: appUrl,
    authorization_endpoint: `${appUrl}/api/mcp-oauth/authorize`,
    token_endpoint: `${appUrl}/api/mcp-oauth/token`,
    registration_endpoint: `${appUrl}/api/mcp-oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    // Advertise only the safe read-only default scopes plus the coarse
    // `mcp` marker. Destructive scopes (*:write, pending_operations:approve,
    // bookkeeping:write) are still accepted by /authorize when requested
    // explicitly, but enumerating them in public discovery aids
    // scope-escalation reconnaissance (CC6.1, defense-in-depth).
    scopes_supported: ['mcp', ...PUBLIC_OAUTH_METADATA_SCOPES],
  })
}

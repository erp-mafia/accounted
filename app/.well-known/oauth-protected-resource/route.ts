import { NextResponse } from 'next/server'

/**
 * RFC 9728: Protected Resource Metadata.
 * Tells MCP clients which authorization server to use.
 */
export async function GET() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  return NextResponse.json({
    resource: `${appUrl}/api/extensions/ext/mcp-server/mcp`,
    authorization_servers: [appUrl],
    scopes_supported: ['mcp'],
  })
}

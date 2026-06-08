/**
 * Origin-header validation for the MCP Streamable HTTP endpoint.
 *
 * MCP spec (2025-06-18, Streamable HTTP transport): "Servers MUST validate
 * the Origin header on all incoming connections to prevent DNS rebinding
 * attacks." Also an explicit Claude Connectors Directory submission
 * requirement.
 *
 * Non-browser clients send no Origin header and are allowed: claude.ai's
 * backend connector, Claude Desktop, the npx gnubok-mcp bridge, Claude Code,
 * and MCP Inspector (whose Node proxy makes the actual call). A browser page
 * sends its own origin: allowed only when it matches the deployment's own
 * host — compared against the request Host (covers Vercel previews and
 * self-hosted domains without hardcoding) and NEXT_PUBLIC_APP_URL (covers
 * proxies that rewrite Host). Anything else is a cross-site browser request
 * the endpoint never serves (it sets no CORS headers), so reject explicitly.
 */
export function isForbiddenOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    // Malformed Origin (including the literal "null" some browsers send for
    // sandboxed/opaque contexts) — treat as foreign.
    return true
  }

  const allowedHosts = new Set<string>()
  const hostHeader = request.headers.get('host')
  if (hostHeader) allowedHosts.add(hostHeader)
  try {
    allowedHosts.add(new URL(request.url).host)
  } catch {
    // request.url should always parse; ignore if not.
  }
  if (process.env.NEXT_PUBLIC_APP_URL) {
    try {
      allowedHosts.add(new URL(process.env.NEXT_PUBLIC_APP_URL).host)
    } catch {
      // Misconfigured env var — fall through to the request-derived hosts.
    }
  }

  return !allowedHosts.has(originHost)
}

export function forbiddenOriginResponse(): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Origin not allowed' },
    },
    { status: 403 },
  )
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpServerExtension } from '../index'

// Endpoint-appended RFC 9728 discovery: Claude.ai's connector setup tries
// <server url>/.well-known/oauth-protected-resource before any 401 and turns
// a 404 into "Authorization failed" (production, 2026-08-26).

function findRoute(method: string, path: string) {
  const route = mcpServerExtension.apiRoutes?.find((r) => r.method === method && r.path === path)
  if (!route) throw new Error(`route ${method} ${path} not declared`)
  return route
}

describe('GET /mcp/.well-known/oauth-protected-resource (dispatcher route)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is declared unauthenticated and answers the same document as the root location', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    const route = findRoute('GET', '/mcp/.well-known/oauth-protected-resource')
    expect(route.skipAuth).toBe(true)
    const response = await route.handler(
      new Request(
        'https://app.accounted.se/api/extensions/ext/mcp-server/mcp/.well-known/oauth-protected-resource?tool_namespace=accounted',
        { headers: { host: 'app.accounted.se' } }
      ),
      undefined as never
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.resource).toBe(
      'https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted'
    )
    expect(body.authorization_servers).toEqual(['https://app.accounted.se'])
  })

  it('still refuses a foreign browser origin (DNS-rebinding defense)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    const route = findRoute('GET', '/mcp/.well-known/oauth-protected-resource')
    const response = await route.handler(
      new Request(
        'https://app.accounted.se/api/extensions/ext/mcp-server/mcp/.well-known/oauth-protected-resource',
        { headers: { host: 'app.accounted.se', origin: 'https://evil.example' } }
      ),
      undefined as never
    )
    expect(response.status).toBe(403)
  })
})

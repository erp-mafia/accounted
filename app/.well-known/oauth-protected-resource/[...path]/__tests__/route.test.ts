import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '../route'

// RFC 9728 path-based discovery: Claude.ai's connector setup fetches
// /.well-known/oauth-protected-resource/<mcp path> before any 401 and treats
// a 404 as "Authorization failed" (seen in production 2026-08-26).

function call(url: string, path: string[]) {
  return GET(new Request(url, { headers: { host: new URL(url).host } }), {
    params: Promise.resolve({ path }),
  })
}

describe('path-based MCP protected-resource discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('serves the MCP endpoint metadata at the RFC 9728 path-based location', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    const response = await call(
      'https://app.accounted.se/.well-known/oauth-protected-resource/api/extensions/ext/mcp-server/mcp',
      ['api', 'extensions', 'ext', 'mcp-server', 'mcp']
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.resource).toBe('https://app.accounted.se/api/extensions/ext/mcp-server/mcp')
    expect(body.authorization_servers).toEqual(['https://app.accounted.se'])
    expect(body.scopes_supported).toEqual(['mcp'])
  })

  it('reflects the accounted namespace exactly like the root document', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    const response = await call(
      'https://app.accounted.se/.well-known/oauth-protected-resource/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted',
      ['api', 'extensions', 'ext', 'mcp-server', 'mcp']
    )
    const body = await response.json()
    expect(body.resource).toBe(
      'https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted'
    )
  })

  it('never echoes an arbitrary namespace value', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    const response = await call(
      'https://app.accounted.se/.well-known/oauth-protected-resource/api/extensions/ext/mcp-server/mcp?tool_namespace=evil%22',
      ['api', 'extensions', 'ext', 'mcp-server', 'mcp']
    )
    const body = await response.json()
    expect(body.resource).toBe('https://app.accounted.se/api/extensions/ext/mcp-server/mcp')
  })

  it('answers 404 for any other path so no phantom resource is advertised', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    const response = await call(
      'https://app.accounted.se/.well-known/oauth-protected-resource/api/v1/companies',
      ['api', 'v1', 'companies']
    )
    expect(response.status).toBe(404)
  })
})

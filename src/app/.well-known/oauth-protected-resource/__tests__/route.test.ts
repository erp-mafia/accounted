import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '../route'

describe('MCP protected-resource discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps the legacy MCP resource unchanged by default', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')

    const response = await GET(
      new Request('https://app.gnubok.se/.well-known/oauth-protected-resource', {
        headers: { host: 'app.gnubok.se' },
      })
    )
    const body = await response.json()

    expect(body.resource).toBe(
      'https://app.gnubok.se/api/extensions/ext/mcp-server/mcp'
    )
    expect(body.authorization_servers).toEqual(['https://app.gnubok.se'])
  })

  it('advertises the exact Accounted namespace resource when requested', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')

    const response = await GET(
      new Request(
        'https://app.accounted.se/.well-known/oauth-protected-resource?tool_namespace=accounted',
        { headers: { host: 'app.accounted.se' } }
      )
    )
    const body = await response.json()

    expect(body.resource).toBe(
      'https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted'
    )
    expect(body.authorization_servers).toEqual(['https://app.accounted.se'])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))

import { GET } from '../route'

describe('MCP protected-resource discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('advertises the resource on the registered byrå domain the client called', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
    resolveBrandResultByHostMock.mockResolvedValue({
      brand: { domain: 'byra.example.se' },
      lookupFailed: false,
    })

    const response = await GET(
      new Request(
        'https://byra.example.se/.well-known/oauth-protected-resource?tool_namespace=accounted',
        { headers: { host: 'byra.example.se' } }
      )
    )
    const body = await response.json()

    expect(body.resource).toBe(
      'https://byra.example.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted'
    )
    expect(body.authorization_servers).toEqual(['https://byra.example.se'])
  })

  it('keeps the legacy MCP resource and names the canonical authorization server', async () => {
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
    // The legacy host's login page forwards to the canonical host, so the
    // sign-in finishes there and its `iss` is the canonical issuer.
    expect(body.authorization_servers).toEqual(['https://app.accounted.se'])
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

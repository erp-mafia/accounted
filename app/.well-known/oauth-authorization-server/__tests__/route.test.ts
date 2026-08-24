import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '../route'

describe('GET /.well-known/oauth-authorization-server', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('advertises CIMD alongside public-client token auth so Claude and Codex pick it over DCR', async () => {
    // Clients select Client ID Metadata Documents only when BOTH are present:
    // the flag and `none` in token_endpoint_auth_methods_supported.
    const res = await GET(new Request('https://app.example.test/.well-known/oauth-authorization-server'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.client_id_metadata_document_supported).toBe(true)
    expect(body.token_endpoint_auth_methods_supported).toContain('none')
    // DCR stays for clients that still use it (ChatGPT).
    expect(body.registration_endpoint).toBe('https://app.example.test/api/mcp-oauth/register')
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.authorization_response_iss_parameter_supported).toBe(true)
  })

  it('does not enumerate write scopes in public discovery', async () => {
    const res = await GET(new Request('https://app.example.test/.well-known/oauth-authorization-server'))
    const body = await res.json()
    expect(body.scopes_supported).toContain('mcp')
    expect(body.scopes_supported.some((s: string) => s.endsWith(':write'))).toBe(false)
  })
})

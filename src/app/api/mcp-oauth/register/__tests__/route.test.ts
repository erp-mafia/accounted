import { describe, it, expect } from 'vitest'
import { POST } from '../route'

function createRequest(body: unknown) {
  return new Request('http://localhost/api/mcp-oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/mcp-oauth/register', () => {
  it('returns 400 for invalid JSON', async () => {
    const request = new Request('http://localhost/api/mcp-oauth/register', {
      method: 'POST',
      body: 'not json',
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it('accepts registration with valid claude.ai redirect_uris', async () => {
    const response = await POST(createRequest({
      client_name: 'Test Client',
      redirect_uris: ['https://claude.ai/api/oauth/callback'],
    }))
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.client_id).toBeDefined()
    expect(body.redirect_uris).toEqual(['https://claude.ai/api/oauth/callback'])
  })

  it('accepts registration with localhost redirect_uris', async () => {
    const response = await POST(createRequest({
      redirect_uris: ['http://localhost:3000/callback'],
    }))
    expect(response.status).toBe(201)
  })

  it('accepts registration with 127.0.0.1 redirect_uris', async () => {
    const response = await POST(createRequest({
      redirect_uris: ['http://127.0.0.1:8080/callback'],
    }))
    expect(response.status).toBe(201)
  })

  it('accepts registration with claude.com redirect_uris', async () => {
    const response = await POST(createRequest({
      redirect_uris: ['https://claude.com/api/oauth/callback'],
    }))
    expect(response.status).toBe(201)
  })

  it('accepts registration with the grok.com connector callback', async () => {
    const response = await POST(createRequest({
      client_name: 'Grok',
      redirect_uris: ['https://grok.com/connectors-oauth-exchange-code/'],
      token_endpoint_auth_method: 'none',
    }))
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.redirect_uris).toEqual(['https://grok.com/connectors-oauth-exchange-code/'])
    expect(body.token_endpoint_auth_method).toBe('none')
  })

  it('accepts the three redirect_uris Cursor registers in one request', async () => {
    // Cursor sends the legacy deeplink, the Cloud Agents web fallback and the
    // RFC 8252 loopback together; one unknown URI used to fail the whole set.
    const uris = [
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'http://localhost:8787/callback',
    ]
    const response = await POST(createRequest({
      client_name: 'Cursor',
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
    }))
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.redirect_uris).toEqual(uris)
  })

  it('rejects other cursor.com paths and other cursor:// authorities', async () => {
    for (const uri of [
      'https://www.cursor.com/agents/mcp/oauth/callback2',
      'https://cursor.com/agents/mcp/oauth/callback',
      'cursor://evil.extension/oauth/callback',
    ]) {
      const response = await POST(createRequest({ redirect_uris: [uri] }))
      expect(response.status, uri).toBe(400)
    }
  })

  it('rejects other grok.com paths', async () => {
    const response = await POST(createRequest({
      redirect_uris: ['https://grok.com/oauth/callback'],
    }))
    expect(response.status).toBe(400)
  })

  it('registers Gemini as a public client although it asks for a client secret', async () => {
    // The body Gemini custom apps send (github.com/a91453/mml-tools pull 136):
    // a confidential-client request on Google's relay. The answer is the same
    // public PKCE client every caller gets, with no secret to hold.
    const redirect = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-app_accounted_se'
    const response = await POST(createRequest({
      client_name: 'Gemini',
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
      scope: 'mcp offline_access',
      application_type: 'web',
    }))
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.redirect_uris).toEqual([redirect])
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(body.client_secret).toBeUndefined()
  })

  it('rejects a Google relay callback that is not a Gemini custom app', async () => {
    const response = await POST(createRequest({
      redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/some-cloud-project'],
    }))
    expect(response.status).toBe(400)
  })

  it('rejects registration with disallowed redirect_uris', async () => {
    const response = await POST(createRequest({
      redirect_uris: ['https://evil.com/callback'],
    }))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('invalid_redirect_uri')
  })

  it('rejects if any redirect_uri in array is invalid', async () => {
    const response = await POST(createRequest({
      redirect_uris: [
        'https://claude.ai/api/callback',
        'https://evil.com/steal',
      ],
    }))
    expect(response.status).toBe(400)
  })

  it('accepts registration with no redirect_uris', async () => {
    const response = await POST(createRequest({
      client_name: 'No URIs',
    }))
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.redirect_uris).toEqual([])
  })

  it('defaults client_name to MCP Client', async () => {
    const response = await POST(createRequest({}))
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.client_name).toBe('MCP Client')
  })
})

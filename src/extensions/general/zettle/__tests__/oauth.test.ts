import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildAuthorizeUrl, ZETTLE_OAUTH_SCOPES } from '../lib/oauth'

describe('zettle oauth', () => {
  const env = { ...process.env }

  beforeEach(() => {
    process.env.ZETTLE_CLIENT_ID = 'client-123'
    process.env.ZETTLE_CLIENT_SECRET = 'secret-456'
    process.env.ZETTLE_CREDENTIALS_ENCRYPTION_KEY = 'enc-key'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it('builds the authorize URL with purchase + userinfo scopes', () => {
    const url = new URL(buildAuthorizeUrl('state-abc'))
    expect(url.origin + url.pathname).toBe('https://oauth.zettle.com/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-123')
    expect(url.searchParams.get('state')).toBe('state-abc')
    expect(url.searchParams.get('scope')).toBe(ZETTLE_OAUTH_SCOPES)
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/extensions/zettle/callback',
    )
  })
})

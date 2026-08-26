import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildAuthorizeUrl } from '../lib/oauth'

/**
 * Scope-set regression guard.
 *
 * Every entry here was added because removing it broke a live filing, and the
 * damage is always delayed: SKV issues the token happily and the missing scope
 * only surfaces as a 403 from the one API that needed it. A "remove unused
 * scopes" cleanup has already cost us this twice (#431 for `ska`, and `agd`
 * alone for AGI kvittenser). Pin them.
 */
describe('Skatteverket per-flow OAuth scopes', () => {
  const originalClientId = process.env.SKATTEVERKET_OAUTH2_CLIENT_ID

  beforeEach(() => {
    process.env.SKATTEVERKET_OAUTH2_CLIENT_ID = 'test-client-id'
  })

  afterEach(() => {
    if (originalClientId === undefined) delete process.env.SKATTEVERKET_OAUTH2_CLIENT_ID
    else process.env.SKATTEVERKET_OAUTH2_CLIENT_ID = originalClientId
  })

  function requestedScopes(): string[] {
    const url = new URL(buildAuthorizeUrl('https://app.example/callback', 'state-123'))
    return (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean)
  }

  it('requests both AGI scopes, one per backing API', () => {
    // `agd` backs inlamning (submit/sign); `agdredovisningperiod` backs
    // hanteraredovisningsperiod (kvittenser/las). A token with only the first
    // completes a filing and then fails on "Hämta kvittens".
    expect(requestedScopes()).toEqual(
      expect.arrayContaining(['agd', 'agdredovisningperiod']),
    )
  })

  it('keeps the interactive skattekonto scope', () => {
    expect(requestedScopes()).toContain('ska')
  })

  it('keeps the momsdeklaration scope', () => {
    expect(requestedScopes()).toContain('momsdeklaration')
  })

  it('lets an explicit scope option override the defaults', () => {
    const url = new URL(
      buildAuthorizeUrl('https://app.example/callback', 'state-123', { scope: 'agd' }),
    )
    expect(url.searchParams.get('scope')).toBe('agd')
  })
})

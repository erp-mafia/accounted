import { describe, it, expect, vi } from 'vitest'

/**
 * The voucher-attachment scopes (Arkivplats + Koppla filer) are opt-in per
 * authorize call rather than part of every Fortnox connect. Two reasons, both
 * of which have already cost us once:
 *
 *  1. Fortnox derives its customer licence requirements from what the
 *     integration requests, so asking every customer for Arkivplats would put
 *     a licence in front of people who never import a receipt.
 *  2. A scope the registered app lacks makes authorize reject with
 *     invalid_scope before login. Keeping it off the ordinary connect means
 *     the blast radius of getting it wrong is the underlag flow, not every
 *     Fortnox connection in production (incident 2026-08-13).
 */

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
  createServiceClientNoCookies: () => ({ from: vi.fn() }),
}))

vi.mock('@/lib/providers/oauth-config', () => ({
  getOAuthConfig: () => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://accounted.example.test/callback',
  }),
}))

import {
  fortnoxConsentScopes,
  FORTNOX_DOCUMENT_SCOPES,
} from '@/lib/providers/fortnox/oauth'
import { getAuthUrl } from '../lib/provider-client'

const scopesOf = (url: string) =>
  new URL(url).searchParams.get('scope')?.split(' ') ?? []

describe('Fortnox document scopes are opt-in', () => {
  it('leaves the attachment scopes out of an ordinary consent', () => {
    expect(fortnoxConsentScopes()).not.toContain('archive')
    expect(fortnoxConsentScopes()).not.toContain('connectfile')
  })

  // The OAuth callback overwrites the consent's tokens in place, so a document
  // consent that dropped the base scopes would silently revoke the migration's
  // own access to the ledger it just imported.
  it('never drops the base scopes when asking for the attachment scopes', () => {
    const base = fortnoxConsentScopes()
    const withDocuments = fortnoxConsentScopes({ documents: true })

    for (const scope of base) {
      expect(withDocuments).toContain(scope)
    }
    expect(withDocuments.length).toBeGreaterThanOrEqual(base.length)
    expect(new Set(withDocuments).size).toBe(withDocuments.length)
  })

  it('names both attachment scopes, so the portal registration has a source of truth', () => {
    expect(FORTNOX_DOCUMENT_SCOPES).toEqual(['archive', 'connectfile'])
  })

  it('builds the ordinary connect URL without the attachment scopes', async () => {
    const { url } = await getAuthUrl('fortnox', 'state-1', 'https://cb.test')

    expect(scopesOf(url)).toEqual(fortnoxConsentScopes())
    expect(scopesOf(url)).not.toContain('archive')
  })

  it('builds the underlag reconnect URL from the document consent scopes', async () => {
    const { url } = await getAuthUrl('fortnox', 'state-2', 'https://cb.test', {
      documentScopes: true,
    })

    expect(scopesOf(url)).toEqual(fortnoxConsentScopes({ documents: true }))
    for (const scope of fortnoxConsentScopes()) {
      expect(scopesOf(url)).toContain(scope)
    }
  })
})

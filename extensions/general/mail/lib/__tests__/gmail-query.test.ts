/**
 * The Gmail query is where recall is won or lost, so it is pure and tested
 * without a mailbox. Cases are drawn from the real bank descriptors and
 * confirmed receipt pairs observed in production.
 */
import { describe, it, expect } from 'vitest'
import {
  DAYS_AFTER,
  DAYS_BEFORE,
  amountTerms,
  buildGmailQuery,
  looksLikeReceipt,
  merchantTerms,
} from '../gmail-query'

describe('merchantTerms', () => {
  it('drops legal forms and other tokens that would match the whole mailbox', () => {
    expect(merchantTerms('circle k')).toEqual(['circle'])
    expect(merchantTerms('ryde sweden')).toEqual(['ryde'])
    expect(merchantTerms('')).toEqual([])
    expect(merchantTerms(null)).toEqual([])
  })

  it('keeps at most three terms so the query stays selective', () => {
    expect(merchantTerms('alviks kott och fisk stockholm sodermalm').length).toBeLessThanOrEqual(3)
  })
})

describe('amountTerms', () => {
  it('offers both Swedish and international decimal forms', () => {
    // A Swedish receipt writes 438,75; a SaaS invoice writes 438.75.
    expect(amountTerms(438.75)).toEqual(expect.arrayContaining(['438.75', '438,75']))
  })

  it('adds the bare integer when the amount is whole', () => {
    expect(amountTerms(425)).toEqual(expect.arrayContaining(['425.00', '425,00', '425']))
  })

  it('ignores the sign, since bank outflows are negative', () => {
    expect(amountTerms(-425)).toEqual(amountTerms(425))
  })
})

describe('buildGmailQuery', () => {
  const base = { merchant: 'circle', amount: 438.75, currency: 'SEK', date: '2026-05-02' }

  it('brackets the purchase with an asymmetric window', () => {
    const q = buildGmailQuery(base)
    // Receipts arrive at or after the purchase; the bank may post it late.
    expect(DAYS_AFTER).toBeGreaterThan(DAYS_BEFORE)
    expect(q).toContain('after:2026/04/28')
    expect(q).toContain('before:2026/05/13')
  })

  it('ORs merchant against amount rather than requiring both', () => {
    // Requiring both misses every rebrand and reseller: Anthropic bills as
    // Claude, and the amount alone is a strong filter inside two weeks.
    const q = buildGmailQuery(base)
    expect(q).toMatch(/\("circle" OR .*"438\.75"/)
  })

  it('still searches on amount alone when the merchant is unusable', () => {
    const q = buildGmailQuery({ ...base, merchant: 'ab' })
    expect(q).toContain('"438.75"')
    expect(q).not.toContain('"ab"')
  })

  it('does not require an attachment, because many receipts are the body', () => {
    expect(buildGmailQuery(base)).not.toContain('has:attachment')
  })
})

describe('looksLikeReceipt', () => {
  it('keeps plausible receipts', () => {
    expect(looksLikeReceipt('Ditt kvitto från Circle K', 'no-reply@circlek.se')).toBe(true)
    expect(looksLikeReceipt('Your receipt from Anthropic', 'billing@anthropic.com')).toBe(true)
  })

  it('drops the obvious non-receipts before anything expensive reads them', () => {
    expect(looksLikeReceipt('Nyhetsbrev maj', 'news@example.com')).toBe(false)
    expect(looksLikeReceipt('Calendar invite: standup', 'cal@example.com')).toBe(false)
  })
})

describe('buildAuthorizationUrl', () => {
  it('carries the CSRF state, which the callback refuses to proceed without', async () => {
    const { buildAuthorizationUrl } = await import('../google-oauth')
    const url = buildAuthorizationUrl(
      { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://app.accounted.se/cb' },
      'signed-state',
    )
    const params = new URL(url).searchParams
    expect(params.get('state')).toBe('signed-state')
    // Read-only, and offline so a refresh token is actually issued.
    expect(params.get('scope')).toContain('gmail.readonly')
    expect(params.get('scope')).not.toContain('gmail.modify')
    expect(params.get('scope')).not.toContain('gmail.send')
    expect(params.get('access_type')).toBe('offline')
  })
})

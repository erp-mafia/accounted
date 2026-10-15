import { describe, expect, it } from 'vitest'
import { isReturnBounceTarget, RETURN_BOUNCE_PATH, viaCanonicalOrigin } from '../return-bounce'

const CANONICAL = 'https://app.accounted.se'

describe('viaCanonicalOrigin', () => {
  it('leaves a return on the canonical origin as it is', () => {
    const target = 'https://app.accounted.se/settings/connections?bank_connect=c1'
    expect(viaCanonicalOrigin(target, CANONICAL)).toBe(target)
  })

  it('sends a brand host return through the hop on the canonical origin, the real target named', () => {
    const target = 'https://app.ziffr.se/settings/connections?bank_connect=c1'
    const hop = new URL(viaCanonicalOrigin(target, CANONICAL))
    expect(hop.origin).toBe(CANONICAL)
    expect(hop.pathname).toBe(RETURN_BOUNCE_PATH)
    expect(hop.searchParams.get('to')).toBe(target)
  })

  it('reads the canonical origin without its path', () => {
    const hop = new URL(viaCanonicalOrigin('https://brand.accounted.se/payments?signing=b1', 'https://app.accounted.se/'))
    expect(hop.toString().startsWith(`${CANONICAL}${RETURN_BOUNCE_PATH}?to=`)).toBe(true)
  })
})

describe('isReturnBounceTarget', () => {
  it('accepts the signing pages only', () => {
    for (const path of ['/settings/connections', '/settings/banking', '/onboarding/books', '/payments', '/koppla/tok_1', '/betala/tok_2']) {
      expect(isReturnBounceTarget(path)).toBe(true)
    }
    for (const path of ['/', '/login', '/settings', '/koppla/', '/koppla/a/b', '/betala/', '/api/bank/return', '//evil.example', '/payments/x']) {
      expect(isReturnBounceTarget(path)).toBe(false)
    }
  })
})

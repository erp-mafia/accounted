import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../peppol-delivery'

describe('sha256Hex', () => {
  it('produces a stable lowercase fingerprint for the exact XML bytes', () => {
    expect(sha256Hex('<Invoice>åäö</Invoice>')).toBe(
      'ab1c7c9e3a2780e73140e40a0af1a1d355026e3b754049bc6b0e8d03490b4d65',
    )
  })
})

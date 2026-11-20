import { describe, it, expect } from 'vitest'
import { confirmFormAction } from '../confirm-link'

describe('confirmFormAction', () => {
  it('posts to the callback with the link query, in order', () => {
    expect(
      confirmFormAction(new URLSearchParams('next=%2Freset-password&type=recovery')),
    ).toBe('/auth/callback?next=%2Freset-password&type=recovery')
  })

  it('keeps the email-change markers the middleware lets through', () => {
    expect(
      confirmFormAction(new URLSearchParams('flow=email_change&type=email_change')),
    ).toBe('/auth/callback?flow=email_change&type=email_change')
  })

  it('never carries a token_hash, even when the page URL was handed one', () => {
    expect(
      confirmFormAction(new URLSearchParams('token_hash=abc&type=signup')),
    ).toBe('/auth/callback?type=signup')
  })

  it('posts to the bare callback when there is no query', () => {
    expect(confirmFormAction(new URLSearchParams())).toBe('/auth/callback')
  })
})

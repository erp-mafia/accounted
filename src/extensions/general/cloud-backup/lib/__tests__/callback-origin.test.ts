import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCallbackOrigin } from '../callback-origin'

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL
})

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
})

describe('resolveCallbackOrigin', () => {
  it('falls back to the request origin when no canonical URL is configured', () => {
    expect(resolveCallbackOrigin('https://self-hosted.example')).toBe(
      'https://self-hosted.example'
    )
  })

  it('prefers the canonical app origin over the request origin', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.se'
    expect(resolveCallbackOrigin('https://app.gnubok.se')).toBe(
      'https://app.accounted.se'
    )
  })

  it('normalizes a trailing slash so the redirect URI stays byte-identical', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.se/'
    expect(resolveCallbackOrigin('https://other.example')).toBe(
      'https://app.accounted.se'
    )
  })

  it('strips any path from the configured URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.se/dashboard'
    expect(resolveCallbackOrigin('https://other.example')).toBe(
      'https://app.accounted.se'
    )
  })

  it('ignores a blank value', () => {
    process.env.NEXT_PUBLIC_APP_URL = '   '
    expect(resolveCallbackOrigin('https://other.example')).toBe(
      'https://other.example'
    )
  })

  it('falls back to the request origin when the configured URL is malformed', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'not a url'
    expect(resolveCallbackOrigin('https://other.example')).toBe(
      'https://other.example'
    )
  })

  it('falls back to the request origin for a non-web URL scheme', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'mailto:backup@example.com'
    expect(resolveCallbackOrigin('https://other.example')).toBe(
      'https://other.example'
    )
  })
})

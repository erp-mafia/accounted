import { describe, it, expect } from 'vitest'
import { friendlyModelError } from '../run-turn'

describe('friendlyModelError', () => {
  it('429 status → "Anna är upptagen"', () => {
    expect(friendlyModelError({ status: 429, message: 'Too Many Requests' })).toMatch(/upptagen/i)
  })

  it('throttling message → busy', () => {
    expect(friendlyModelError(new Error('ThrottlingException: Rate exceeded'))).toMatch(/upptagen/i)
  })

  it('timeout / dropped connection → "Anslutningen ... bröts"', () => {
    expect(friendlyModelError(new Error('socket hang up ETIMEDOUT'))).toMatch(/anslutningen/i)
  })

  it('5xx → temporary service error', () => {
    expect(friendlyModelError({ status: 503, message: 'Service Unavailable' })).toMatch(/tillfälligt fel/i)
  })

  it('unknown error → generic Swedish line', () => {
    expect(friendlyModelError(new Error('weird'))).toMatch(/något gick fel/i)
  })

  it('never leaks the raw English SDK message to the user', () => {
    const out = friendlyModelError(new Error('ValidationException: model id invalid'))
    expect(out).not.toContain('ValidationException')
    expect(out).not.toContain('model id')
  })
})

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
    expect(friendlyModelError({ status: 500, message: 'Internal Server Error' })).toMatch(/tillfälligt fel/i)
  })

  it('provider overload (overloaded_error event, 529, Bedrock 503) → honest overload line', () => {
    const overloaded = 'Assistenten är överbelastad just nu, försök igen om en minut.'
    expect(
      friendlyModelError(new Error('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')),
    ).toBe(overloaded)
    expect(friendlyModelError({ status: 529, message: 'Overloaded' })).toBe(overloaded)
    expect(friendlyModelError({ status: 503, message: 'Bedrock is unable to process your request.' })).toBe(overloaded)
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

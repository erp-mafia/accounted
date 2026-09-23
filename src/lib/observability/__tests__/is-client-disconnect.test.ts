import { describe, it, expect } from 'vitest'
import { isClientDisconnectError } from '../is-client-disconnect'

describe('isClientDisconnectError', () => {
  it('matches React\'s cancel error for a stream the client closed', () => {
    expect(isClientDisconnectError(new Error('The destination stream closed early.'))).toBe(true)
  })

  it('matches the sibling cancel error React raises on a write failure', () => {
    expect(
      isClientDisconnectError(new Error('The destination stream errored while writing data.')),
    ).toBe(true)
  })

  it('matches Next\'s own ResponseAborted error by name', () => {
    const aborted = Object.assign(new Error('The response was aborted'), {
      name: 'ResponseAborted',
    })
    expect(isClientDisconnectError(aborted)).toBe(true)
  })

  it('does not match an ordinary error', () => {
    expect(isClientDisconnectError(new Error('boom'))).toBe(false)
    expect(isClientDisconnectError(new TypeError('fetch failed'))).toBe(false)
  })

  it('does not match a real provider timeout or socket reset', () => {
    // AbortSignal.timeout throws this shape all over lib/providers; treating
    // it as a client disconnect would hide genuine integration failures.
    expect(isClientDisconnectError(new DOMException('Aborted', 'AbortError'))).toBe(false)
    expect(
      isClientDisconnectError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
    ).toBe(false)
    expect(
      isClientDisconnectError(
        Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }),
      ),
    ).toBe(false)
  })

  it('matches the message exactly, so a real error cannot hide behind the phrase', () => {
    expect(
      isClientDisconnectError(
        new Error('Supabase query failed: The destination stream closed early.'),
      ),
    ).toBe(false)
  })

  it('is false for anything that is not an error object', () => {
    expect(isClientDisconnectError(null)).toBe(false)
    expect(isClientDisconnectError(undefined)).toBe(false)
    expect(isClientDisconnectError('The destination stream closed early.')).toBe(false)
    expect(isClientDisconnectError(42)).toBe(false)
  })
})

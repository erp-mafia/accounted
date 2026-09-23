import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  notifySessionExpired,
  SESSION_TIMEOUT_CHANNEL,
  SESSION_TIMEOUT_REASON_HEADER,
} from '../session-timeout-shared'

const posted: Array<{ name: string; message: unknown }> = []

class FakeBroadcastChannel {
  constructor(public readonly name: string) {}
  postMessage(message: unknown) {
    posted.push({ name: this.name, message })
  }
  close() {}
}

function expiredResponse(reason: string, status = 401): Response {
  return new Response(
    JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: 'Sessionen har upphört.' } }),
    { status, headers: { [SESSION_TIMEOUT_REASON_HEADER]: reason } },
  )
}

describe('notifySessionExpired', () => {
  beforeEach(() => {
    posted.length = 0
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('announces an idle timeout on the session channel', () => {
    expect(notifySessionExpired(expiredResponse('idle'))).toBe(true)
    expect(posted).toEqual([
      { name: SESSION_TIMEOUT_CHANNEL, message: { type: 'expired', reason: 'idle' } },
    ])
  })

  it('announces an absolute timeout on the session channel', () => {
    expect(notifySessionExpired(expiredResponse('absolute'))).toBe(true)
    expect(posted).toEqual([
      { name: SESSION_TIMEOUT_CHANNEL, message: { type: 'expired', reason: 'absolute' } },
    ])
  })

  // A 401 from a route's own auth check is not a timeout: signing the user out
  // and redirecting on one would turn a single failed call into a logout.
  it('ignores a 401 that carries no timeout reason', () => {
    expect(notifySessionExpired(new Response('{}', { status: 401 }))).toBe(false)
    expect(posted).toEqual([])
  })

  it('ignores an unknown reason', () => {
    expect(notifySessionExpired(expiredResponse('whatever'))).toBe(false)
    expect(posted).toEqual([])
  })

  it('ignores a successful response that happens to carry the header', () => {
    expect(notifySessionExpired(expiredResponse('idle', 200))).toBe(false)
    expect(posted).toEqual([])
  })

  it('still reports the timeout where BroadcastChannel is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    expect(notifySessionExpired(expiredResponse('idle'))).toBe(true)
    expect(posted).toEqual([])
  })
})

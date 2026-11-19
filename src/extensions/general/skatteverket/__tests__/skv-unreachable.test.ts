/**
 * The transport's conversion (asSkvUnavailable) read by skvUnreachable: which
 * failed calls mean "Skatteverket did not answer, try again" (a timeout, a
 * failed fetch whose cause waiting can cure, or whose cause the runtime does
 * not state) and which are a fault that waiting does not cure (a refused
 * redirect, a host that does not resolve, a certificate error, an invalid
 * URL). The errors are built the way the runtime builds them; the last block
 * makes real fetches so a runtime that words a cause differently turns this
 * red.
 */
import http from 'node:http'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asSkvUnavailable, skvUnreachable } from '../lib/api-client'

/** undici's TypeError('fetch failed') with the cause the runtime attaches. */
function fetchFailed(cause?: unknown): TypeError {
  return cause === undefined ? new TypeError('fetch failed') : Object.assign(new TypeError('fetch failed'), { cause })
}
function causeWithCode(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

describe('skvUnreachable: transient, Skatteverket did not answer', () => {
  it.each<[string, unknown]>([
    ['the call timed out (AbortSignal.timeout)', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['the call was aborted', new DOMException('This operation was aborted', 'AbortError')],
    ['ECONNREFUSED', fetchFailed(causeWithCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443'))],
    ['ECONNREFUSED on every address (AggregateError)', fetchFailed(Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }))],
    ['ECONNRESET', fetchFailed(causeWithCode('ECONNRESET', 'read ECONNRESET'))],
    ['ETIMEDOUT', fetchFailed(causeWithCode('ETIMEDOUT'))],
    ['EAI_AGAIN (DNS did not answer)', fetchFailed(causeWithCode('EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.skatteverket.se'))],
    ['UND_ERR_CONNECT_TIMEOUT', fetchFailed(causeWithCode('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'))],
    ['UND_ERR_SOCKET', fetchFailed(causeWithCode('UND_ERR_SOCKET', 'other side closed'))],
    ['UND_ERR_HEADERS_TIMEOUT', fetchFailed(causeWithCode('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'))],
    ['no cause at all', fetchFailed()],
    ['a cause with no code and an unknown message', fetchFailed(new Error('something new'))],
    ['a cause with an unknown code', fetchFailed(causeWithCode('UND_ERR_SOMETHING_NEW'))],
    ['a cause that is not an object', fetchFailed('string cause')],
  ])('%s', (_label, err) => {
    expect(skvUnreachable(asSkvUnavailable(err))).toBe(true)
  })
})

describe('skvUnreachable: a fault waiting does not cure', () => {
  it.each<[string, unknown]>([
    ['a refused redirect (redirect: error)', fetchFailed(new Error('unexpected redirect'))],
    ['a host that does not resolve', fetchFailed(causeWithCode('ENOTFOUND', 'getaddrinfo ENOTFOUND api.skatteverket.se'))],
    ['an expired certificate', fetchFailed(causeWithCode('CERT_HAS_EXPIRED', 'certificate has expired'))],
    ['a certificate not yet valid', fetchFailed(causeWithCode('CERT_NOT_YET_VALID'))],
    ['an unverifiable leaf certificate', fetchFailed(causeWithCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))],
    ['a missing local issuer certificate', fetchFailed(causeWithCode('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))],
    ['a self-signed certificate in the chain', fetchFailed(causeWithCode('SELF_SIGNED_CERT_IN_CHAIN'))],
    ['a self-signed certificate', fetchFailed(causeWithCode('DEPTH_ZERO_SELF_SIGNED_CERT'))],
    ['a certificate for another host', fetchFailed(causeWithCode('ERR_TLS_CERT_ALTNAME_INVALID'))],
    [
      'an invalid URL',
      Object.assign(new TypeError('Failed to parse URL from not a url'), { cause: causeWithCode('ERR_INVALID_URL', 'Invalid URL') }),
    ],
    ['any other error', new Error('fetch failed')],
  ])('%s', (_label, err) => {
    expect(skvUnreachable(asSkvUnavailable(err))).toBe(false)
  })

  it('a platform no-answer error that did not come through the transport', () => {
    expect(skvUnreachable(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(false)
    expect(skvUnreachable(fetchFailed(causeWithCode('ECONNREFUSED')))).toBe(false)
  })
})

describe('skvUnreachable over real fetches (the runtime words the cause)', () => {
  let redirecting: http.Server
  let redirectUrl: string
  let closedUrl: string

  beforeAll(async () => {
    redirecting = http.createServer((_req, res) => {
      res.writeHead(307, { Location: 'http://127.0.0.1/elsewhere' })
      res.end()
    })
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve))
    redirectUrl = `http://127.0.0.1:${(redirecting.address() as net.AddressInfo).port}/`

    // A port that was free a moment ago: nothing listens there now.
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    closedUrl = `http://127.0.0.1:${(probe.address() as net.AddressInfo).port}/`
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => redirecting.close(() => resolve()))
  })

  async function failureOf(url: string): Promise<unknown> {
    // The transport's own options: redirect 'error' and a deadline.
    const err = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TypeError)
    expect((err as TypeError).message).toBe('fetch failed')
    return err
  }

  it('a 307 answer is a fault, not "did not answer"', async () => {
    expect(skvUnreachable(asSkvUnavailable(await failureOf(redirectUrl)))).toBe(false)
  })

  it('a refused connection did not answer', async () => {
    expect(skvUnreachable(asSkvUnavailable(await failureOf(closedUrl)))).toBe(true)
  })
})

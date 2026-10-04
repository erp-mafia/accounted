import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { CONTRACT_VERSION } from '@accounted/connect-contract'
import {
  callConnectorOperation,
  ConnectorCallError,
  connectorHeaders,
  CONNECTOR_COMPANY_MISSING_CODE,
  CONNECTOR_INSECURE_URL_CODE,
  CONNECTOR_PROTOCOL_ERROR_CODE,
  CONNECTOR_REQUEST_INVALID_CODE,
  CONNECTOR_UNREACHABLE_CODE,
} from '../connector-fetch'

const DEF = {
  method: 'POST',
  path: '/things',
  company: true,
  request: z.object({ name: z.string().min(1) }),
  response: z.object({ id: z.string() }),
} as const

const UPSTREAM = { baseUrl: 'https://connect.example.se/api/connect/x/', key: 'gnubok_ck_secret' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function failure(promise: Promise<unknown>): Promise<ConnectorCallError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorCallError)
    return error as ConnectorCallError
  }
  throw new Error('expected a ConnectorCallError')
}

describe('connectorHeaders', () => {
  it('always carries the bearer key and the contract version', () => {
    expect(connectorHeaders({ key: 'k' })).toEqual({ Authorization: 'Bearer k', 'X-Connect-Contract-Version': CONTRACT_VERSION })
  })

  it('adds JSON, company and connection headers only when given', () => {
    expect(connectorHeaders({ key: 'k', companyId: 'co-1', connectionHandle: 'h-1', json: true })).toEqual({
      Authorization: 'Bearer k',
      'X-Connect-Contract-Version': CONTRACT_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Connector-Company': 'co-1',
      'X-Connector-Connection': 'h-1',
    })
    expect(connectorHeaders({ key: 'k', companyId: null, connectionHandle: null })).not.toHaveProperty('X-Connector-Company')
  })
})

describe('callConnectorOperation', () => {
  it('sends the validated body with every header, no redirects and no cache, and parses the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 't-1', extra: 'stripped' }))
    const result = await callConnectorOperation({
      upstream: UPSTREAM,
      operation: 'things.create',
      def: DEF,
      body: { name: 'x', unknown: true },
      companyId: 'co-1',
      connectionHandle: 'h-1',
      timeoutMs: 1000,
      fetch: fetchMock,
    })
    expect(result).toEqual({ id: 't-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://connect.example.se/api/connect/x/things')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' })
    expect(JSON.parse(init.body)).toEqual({ name: 'x' })
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer gnubok_ck_secret',
      'X-Connect-Contract-Version': CONTRACT_VERSION,
      'X-Connector-Company': 'co-1',
      'X-Connector-Connection': 'h-1',
    })
  })

  it('sends no company header on a key-wide operation and no body on GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'x' }))
    await callConnectorOperation({
      upstream: UPSTREAM,
      operation: 'list',
      def: { ...DEF, method: 'GET', company: false, request: z.null() },
      body: null,
      companyId: 'co-1',
      timeoutMs: 1000,
      fetch: fetchMock,
    })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.body).toBeUndefined()
    expect(init.headers).not.toHaveProperty('X-Connector-Company')
  })

  it('refuses a non-https service before sending anything (loopback http allowed)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'x' }))
    const error = await failure(
      callConnectorOperation({ upstream: { ...UPSTREAM, baseUrl: 'http://connect.example.se' }, operation: 'o', def: DEF, body: { name: 'x' }, companyId: 'c', timeoutMs: 1000, fetch: fetchMock }),
    )
    expect(error.code).toBe(CONNECTOR_INSECURE_URL_CODE)
    expect(error.retryable).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    await callConnectorOperation({ upstream: { ...UPSTREAM, baseUrl: 'http://localhost:3001' }, operation: 'o', def: DEF, body: { name: 'x' }, companyId: 'c', timeoutMs: 1000, fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a company operation without a company, and a body that breaks the contract', async () => {
    const fetchMock = vi.fn()
    expect((await failure(callConnectorOperation({ upstream: UPSTREAM, operation: 'o', def: DEF, body: { name: 'x' }, timeoutMs: 1000, fetch: fetchMock }))).code).toBe(
      CONNECTOR_COMPANY_MISSING_CODE,
    )
    const invalid = await failure(callConnectorOperation({ upstream: UPSTREAM, operation: 'o', def: DEF, body: { name: '' }, companyId: 'c', timeoutMs: 1000, fetch: fetchMock }))
    expect(invalid.code).toBe(CONNECTOR_REQUEST_INVALID_CODE)
    expect(invalid.retryable).toBe(false)
    expect(invalid.detail).toContain('name')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps the service envelope to code, retryable, detail and status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, { error: 'in flight', code: 'CONNECTOR_IDEMPOTENCY_IN_FLIGHT', retryable: true, detail: 'lease held' }),
    )
    const error = await failure(callConnectorOperation({ upstream: UPSTREAM, operation: 'o', def: DEF, body: { name: 'x' }, companyId: 'c', timeoutMs: 1000, fetch: fetchMock }))
    expect(error).toMatchObject({ code: 'CONNECTOR_IDEMPOTENCY_IN_FLIGHT', retryable: true, detail: 'lease held', status: 409 })
  })

  it('names a body-less failure by status, retryable only for 429 and 5xx', async () => {
    const at = (status: number) =>
      failure(
        callConnectorOperation({
          upstream: UPSTREAM,
          operation: 'o',
          def: DEF,
          body: { name: 'x' },
          companyId: 'c',
          timeoutMs: 1000,
          fetch: vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status })),
        }),
      )
    expect(await at(502)).toMatchObject({ code: 'HTTP_502', retryable: true })
    expect(await at(429)).toMatchObject({ code: 'HTTP_429', retryable: true })
    expect(await at(400)).toMatchObject({ code: 'HTTP_400', retryable: false })
  })

  it('treats an answer that breaks the contract as a protocol error, never retried', async () => {
    const error = await failure(
      callConnectorOperation({ upstream: UPSTREAM, operation: 'o', def: DEF, body: { name: 'x' }, companyId: 'c', timeoutMs: 1000, fetch: vi.fn().mockResolvedValue(jsonResponse(200, { nope: 1 })) }),
    )
    expect(error).toMatchObject({ code: CONNECTOR_PROTOCOL_ERROR_CODE, retryable: false, status: 200 })
  })

  it('turns a network failure or a timeout into a retryable CONNECTOR_UNREACHABLE', async () => {
    const network = await failure(
      callConnectorOperation({ upstream: UPSTREAM, operation: 'o', def: DEF, body: { name: 'x' }, companyId: 'c', timeoutMs: 1000, fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')) }),
    )
    expect(network).toMatchObject({ code: CONNECTOR_UNREACHABLE_CODE, retryable: true })

    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const timeout = await failure(
      callConnectorOperation({ upstream: UPSTREAM, operation: 'o', def: DEF, body: { name: 'x' }, companyId: 'c', timeoutMs: 5, fetch: hanging as unknown as typeof fetch }),
    )
    expect(timeout).toMatchObject({ code: CONNECTOR_UNREACHABLE_CODE, retryable: true })
  })
})

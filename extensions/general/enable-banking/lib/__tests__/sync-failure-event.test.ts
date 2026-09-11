/**
 * Feedback seq 340107: one failure taxonomy for every bank sync path, with
 * the internal error in the event and the user-facing string kept out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bankConnectorMode: vi.fn(),
}))
vi.mock('@/lib/connect/instance/upstreams', () => ({
  bankConnectorMode: (...args: unknown[]) => mocks.bankConnectorMode(...args),
}))

import {
  AspspUnavailableError,
  ConnectorSyncError,
  SessionExpiredError,
  REAUTH_REQUIRED_MESSAGE,
  SYNC_FAILED_MESSAGE,
} from '../api-client'
import { classifyBankSyncFailure, emitBankSyncFailed } from '../sync-failure-event'

describe('classifyBankSyncFailure', () => {
  it('maps the three transport errors and everything else to the four classes', () => {
    expect(classifyBankSyncFailure(new SessionExpiredError(403, '{"code":403,"error":"SESSION_CLOSED"}'))).toEqual({
      errorClass: 'session_expired',
      message: 'Bank session expired (403): {"code":403,"error":"SESSION_CLOSED"}',
      httpStatus: 403,
      ebCode: '403',
    })
    expect(
      classifyBankSyncFailure(
        new AspspUnavailableError(500, '{"error":"ASPSP_ERROR"}', 'ladder-exhausted', '2026-08-01'),
      ),
    ).toMatchObject({ errorClass: 'bank_unavailable', httpStatus: 500, ebCode: 'ASPSP_ERROR' })
    expect(classifyBankSyncFailure(new ConnectorSyncError(null, 'CONNECTOR_TIMEOUT', ''))).toEqual({
      errorClass: 'connector',
      message: 'Connector bank sync failed (no response CONNECTOR_TIMEOUT)',
      ebCode: 'CONNECTOR_TIMEOUT',
    })
    expect(classifyBankSyncFailure(new TypeError('fetch failed'))).toEqual({
      errorClass: 'unknown',
      message: 'fetch failed',
    })
    expect(classifyBankSyncFailure('plain string')).toEqual({ errorClass: 'unknown', message: 'plain string' })
  })

  it('reads no code out of a non-JSON body and caps a long message', () => {
    const html = new SessionExpiredError(401, '<html>gateway</html>')
    expect(classifyBankSyncFailure(html)).not.toHaveProperty('ebCode')
    const long = new Error('x'.repeat(2_000))
    expect(classifyBankSyncFailure(long).message).toHaveLength(501)
  })

  it('never returns the user-facing strings', () => {
    for (const error of [
      new SessionExpiredError(401, '{}'),
      new AspspUnavailableError(503, '{}', 'window-already-accepted', undefined),
      new ConnectorSyncError(502, 'CONNECTOR_UPSTREAM_ERROR', 'body'),
      new Error('boom'),
    ]) {
      const { message } = classifyBankSyncFailure(error)
      expect(message).not.toBe(REAUTH_REQUIRED_MESSAGE)
      expect(message).not.toBe(SYNC_FAILED_MESSAGE)
    }
  })
})

describe('emitBankSyncFailed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.bankConnectorMode.mockReturnValue(null)
  })

  const args = {
    connectionId: 'conn-1',
    companyId: 'co-1',
    userId: 'user-1',
    bankName: 'Nordea',
    status: 'error',
    trigger: 'cron' as const,
    error: new Error('boom'),
  }

  it('builds the payload with userId/companyId for event_log and the provider from connector mode', async () => {
    const emit = vi.fn().mockResolvedValue(undefined)
    await emitBankSyncFailed(emit, args)
    expect(emit).toHaveBeenCalledWith({
      type: 'bank_connection.sync_failed',
      payload: {
        connectionId: 'conn-1',
        bankName: 'Nordea',
        provider: 'enable_banking',
        trigger: 'cron',
        status: 'error',
        errorClass: 'unknown',
        message: 'boom',
        userId: 'user-1',
        companyId: 'co-1',
      },
    })
    expect(mocks.bankConnectorMode).toHaveBeenCalledWith('co-1')

    mocks.bankConnectorMode.mockReturnValue({ baseUrl: 'https://connect', key: 'k' })
    await emitBankSyncFailed(emit, args)
    expect(emit.mock.calls[1][0].payload.provider).toBe('accounted_connect')
  })

  it('swallows a failing bus: the event is the diagnosis, not the sync', async () => {
    const emit = vi.fn().mockRejectedValue(new Error('bus down'))
    await expect(emitBankSyncFailed(emit, args)).resolves.toBeUndefined()
  })
})

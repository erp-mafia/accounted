/**
 * The TIC side of the signing seam: results instead of throws, and the
 * signature collected in the same call that sees the session complete,
 * because TIC hands a completed result out at most twice (#2471).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const client = vi.hoisted(() => ({
  startBankIdSign: vi.fn(),
  pollBankIdSession: vi.fn(),
  collectBankIdResult: vi.fn(),
  cancelBankIdSession: vi.fn(),
}))
vi.mock('../lib/bankid-client', () => client)

import { cancelBankIdSignature, pollBankIdSignature, startBankIdSignature } from '../lib/bankid-signing'
import { TICAPIError } from '../lib/tic-types'

const USER = { personalNumber: '199001011234', givenName: 'Anna Maria', surname: 'Andersson', name: 'Anna Maria Andersson' }
const SIGNATURE = { value: 'PD94bWwg', ocspResponse: 'MIIHfgoB' }
const COMPLETED_AT = '2026-10-24T10:00:00Z'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('startBankIdSignature', () => {
  it('starts a sign session in simpleMarkdownV1 and answers the tokens', async () => {
    client.startBankIdSign.mockResolvedValue({
      sessionId: 's1', autoStartToken: 'auto', qrStartToken: 'qr', qrStartSecret: 'secret', sessionExpiresAt: '2026-10-24T10:05:00Z',
    })

    const result = await startBankIdSignature({
      endUserIp: '10.0.0.1',
      userVisibleData: 'Jag signerar *Avtal*',
      userNonVisibleData: '{"v":1}',
      personalNumber: '199001011234',
    })

    expect(client.startBankIdSign).toHaveBeenCalledWith({
      endUserIp: '10.0.0.1',
      userVisibleData: 'Jag signerar *Avtal*',
      userVisibleDataFormat: 'simpleMarkdownV1',
      userNonVisibleData: '{"v":1}',
      personalNumber: '199001011234',
    })
    expect(result).toEqual({
      ok: true,
      data: { sessionId: 's1', autoStartToken: 'auto', qrStartToken: 'qr', qrStartSecret: 'secret', expiresAt: '2026-10-24T10:05:00Z' },
    })
  })

  it('leaves the lock out when there is none', async () => {
    client.startBankIdSign.mockResolvedValue({ sessionId: 's1' })
    await startBankIdSignature({ endUserIp: '10.0.0.1', userVisibleData: 'x', userNonVisibleData: 'y' })
    expect(client.startBankIdSign.mock.calls[0][0]).not.toHaveProperty('personalNumber')
  })

  it('maps provider errors to results', async () => {
    client.startBankIdSign.mockRejectedValueOnce(new TICAPIError('no key', undefined, 'NOT_CONFIGURED'))
    expect(await startBankIdSignature({ endUserIp: 'i', userVisibleData: 'x', userNonVisibleData: 'y' }))
      .toEqual({ ok: false, code: 'NOT_CONFIGURED' })

    client.startBankIdSign.mockRejectedValueOnce(new TICAPIError('slow down', 429, 'RATE_LIMIT_EXCEEDED'))
    expect(await startBankIdSignature({ endUserIp: 'i', userVisibleData: 'x', userNonVisibleData: 'y' }))
      .toEqual({ ok: false, code: 'RATE_LIMITED', httpStatus: 429 })

    client.startBankIdSign.mockRejectedValueOnce(new TICAPIError('boom', 500))
    expect(await startBankIdSignature({ endUserIp: 'i', userVisibleData: 'x', userNonVisibleData: 'y' }))
      .toEqual({ ok: false, code: 'PROVIDER_ERROR', httpStatus: 500 })

    client.startBankIdSign.mockRejectedValueOnce(new Error('network'))
    expect(await startBankIdSignature({ endUserIp: 'i', userVisibleData: 'x', userNonVisibleData: 'y' }))
      .toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })
})

describe('pollBankIdSignature', () => {
  it('answers pending with the refreshed QR tokens', async () => {
    client.pollBankIdSession.mockResolvedValue({ sessionId: 's1', status: 'pending', hintCode: 'outstandingTransaction', qrStartToken: 'q2', qrStartSecret: 's2' })
    expect(await pollBankIdSignature('s1')).toEqual({
      ok: true,
      data: { status: 'pending', hintCode: 'outstandingTransaction', qrStartToken: 'q2', qrStartSecret: 's2' },
    })
    expect(client.collectBankIdResult).not.toHaveBeenCalled()
  })

  it('collects the signature in the same call that sees the session complete', async () => {
    client.pollBankIdSession.mockResolvedValue({ sessionId: 's1', status: 'complete', user: USER, completedAt: COMPLETED_AT })
    client.collectBankIdResult.mockResolvedValue({ sessionId: 's1', status: 'complete', user: USER, signature: SIGNATURE, completedAt: COMPLETED_AT })

    expect(await pollBankIdSignature('s1')).toEqual({
      ok: true,
      data: {
        status: 'complete',
        signature: {
          personalNumber: '199001011234',
          givenName: 'Anna Maria',
          surname: 'Andersson',
          name: 'Anna Maria Andersson',
          completedAt: COMPLETED_AT,
          signatureXml: 'PD94bWwg',
          ocspResponse: 'MIIHfgoB',
        },
      },
    })
    expect(client.collectBankIdResult).toHaveBeenCalledWith('s1')
  })

  it('takes the signature from the poll when it carries one, without a second handout', async () => {
    client.pollBankIdSession.mockResolvedValue({ sessionId: 's1', status: 'complete', user: USER, signature: SIGNATURE, completedAt: COMPLETED_AT })
    const result = await pollBankIdSignature('s1')
    expect(result.ok && result.data.status).toBe('complete')
    expect(client.collectBankIdResult).not.toHaveBeenCalled()
  })

  it('answers gone when the collect carries no signature or TIC already handed it out', async () => {
    client.pollBankIdSession.mockResolvedValue({ sessionId: 's1', status: 'complete', user: USER, completedAt: COMPLETED_AT })
    client.collectBankIdResult.mockResolvedValueOnce({ sessionId: 's1', status: 'complete', user: USER, completedAt: COMPLETED_AT })
    expect(await pollBankIdSignature('s1')).toEqual({ ok: true, data: { status: 'gone' } })

    client.collectBankIdResult.mockResolvedValueOnce({ sessionId: 's1', status: 'collected' })
    expect(await pollBankIdSignature('s1')).toEqual({ ok: true, data: { status: 'gone' } })
  })

  it('answers gone for a collected poll, a 410 body without status, and a 404', async () => {
    client.pollBankIdSession.mockResolvedValueOnce({ sessionId: 's1', status: 'collected' })
    expect(await pollBankIdSignature('s1')).toEqual({ ok: true, data: { status: 'gone' } })

    client.pollBankIdSession.mockResolvedValueOnce({ error: 'session_expired' })
    expect(await pollBankIdSignature('s1')).toEqual({ ok: true, data: { status: 'gone' } })

    client.pollBankIdSession.mockRejectedValueOnce(new TICAPIError('not found', 404))
    expect(await pollBankIdSignature('s1')).toEqual({ ok: true, data: { status: 'gone' } })
  })

  it('answers failed and cancelled as statuses, and other errors as failures', async () => {
    client.pollBankIdSession.mockResolvedValueOnce({ sessionId: 's1', status: 'failed', hintCode: 'userCancel' })
    expect(await pollBankIdSignature('s1')).toEqual({ ok: true, data: { status: 'failed', hintCode: 'userCancel' } })

    client.pollBankIdSession.mockResolvedValueOnce({ sessionId: 's1', status: 'cancelled' })
    expect(await pollBankIdSignature('s1')).toEqual({ ok: true, data: { status: 'cancelled' } })

    client.pollBankIdSession.mockRejectedValueOnce(new TICAPIError('timeout', undefined, 'TIMEOUT'))
    expect(await pollBankIdSignature('s1')).toEqual({ ok: false, code: 'TIMEOUT' })
  })
})

describe('cancelBankIdSignature', () => {
  it('cancels, and treats a session TIC already dropped as cancelled', async () => {
    client.cancelBankIdSession.mockResolvedValueOnce(undefined)
    expect(await cancelBankIdSignature('s1')).toEqual({ ok: true, data: null })

    client.cancelBankIdSession.mockRejectedValueOnce(new TICAPIError('gone', 410))
    expect(await cancelBankIdSignature('s1')).toEqual({ ok: true, data: null })

    client.cancelBankIdSession.mockRejectedValueOnce(new TICAPIError('boom', 502))
    expect(await cancelBankIdSignature('s1')).toEqual({ ok: false, code: 'PROVIDER_ERROR', httpStatus: 502 })
  })
})

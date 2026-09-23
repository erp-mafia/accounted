import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startBankIdAuth,
  pollBankIdSession,
  collectBankIdResult,
  cancelBankIdSession,
} from '../lib/bankid-client'
import { TICAPIError } from '../lib/tic-types'

const API_KEY = 'test-api-key'
const BASE_URL = 'https://id.tic.io/api/v1'

describe('bankid-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubEnv('TIC_IDENTITY_API_KEY', API_KEY)
    vi.stubEnv('TIC_IDENTITY_API_URL', BASE_URL)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  describe('startBankIdAuth', () => {
    it('calls POST /auth/bankid/start with correct params', async () => {
      const mockResponse = {
        sessionId: 'test-session',
        autoStartToken: 'auto-token',
        qrStartToken: 'qr-token',
        qrStartSecret: 'qr-secret',
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      )

      const result = await startBankIdAuth('192.168.1.1', 'TestAgent')

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/bankid/start`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Api-Key': API_KEY,
            'Content-Type': 'application/json',
          }),
        })
      )

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
      )
      expect(body.endUserIp).toBe('192.168.1.1')
      expect(body.userAgent).toBe('TestAgent')
      expect(result.sessionId).toBe('test-session')
    })

    it('throws NOT_CONFIGURED when API key is missing', async () => {
      vi.stubEnv('TIC_IDENTITY_API_KEY', '')

      await expect(startBankIdAuth('1.1.1.1')).rejects.toThrow(TICAPIError)
      await expect(startBankIdAuth('1.1.1.1')).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      })
    })

    it('throws RATE_LIMIT_EXCEEDED on 429', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('Too many requests', { status: 429 })
      )

      await expect(startBankIdAuth('1.1.1.1')).rejects.toMatchObject({
        statusCode: 429,
        code: 'RATE_LIMIT_EXCEEDED',
      })
    })
  })

  describe('pollBankIdSession', () => {
    it('calls POST /auth/{sessionId}/poll', async () => {
      const mockResponse = {
        sessionId: 'test-session',
        status: 'pending',
        hintCode: 'outstandingTransaction',
        message: 'Starta BankID-appen',
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      )

      const result = await pollBankIdSession('test-session')

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/test-session/poll`,
        expect.objectContaining({ method: 'POST' })
      )
      expect(result.status).toBe('pending')
      expect(result.message).toBe('Starta BankID-appen')
    })

    it('returns complete status with user data', async () => {
      const mockResponse = {
        sessionId: 'test-session',
        status: 'complete',
        user: {
          personalNumber: '199001011234',
          givenName: 'Test',
          surname: 'Testsson',
          name: 'Test Testsson',
        },
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      )

      const result = await pollBankIdSession('test-session')
      expect(result.status).toBe('complete')
      expect(result.user?.personalNumber).toBe('199001011234')
    })

    it('returns failed status on 410 Gone', async () => {
      const mockResponse = {
        sessionId: 'test-session',
        status: 'failed',
        hintCode: 'userCancel',
        error: 'authentication_failed',
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 410 })
      )

      const result = await pollBankIdSession('test-session')
      expect(result.status).toBe('failed')
    })
  })

  describe('collectBankIdResult', () => {
    it('calls GET /auth/{sessionId}/collect', async () => {
      const mockResponse = {
        sessionId: 'test-session',
        status: 'complete',
        user: {
          personalNumber: '199001011234',
          givenName: 'Test',
          surname: 'Testsson',
          name: 'Test Testsson',
        },
      }
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      )

      const result = await collectBankIdResult('test-session')

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/test-session/collect`,
        expect.objectContaining({ method: 'GET' })
      )
      expect(result.user?.name).toBe('Test Testsson')
    })
  })

  describe('cancelBankIdSession', () => {
    it('calls DELETE /auth/{sessionId}', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))

      await cancelBankIdSession('test-session')

      expect(fetch).toHaveBeenCalledWith(
        `${BASE_URL}/auth/test-session`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })
})

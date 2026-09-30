/**
 * The reconciliation services answer null for an account key they cannot
 * resolve, and the MCP tools used to turn every null into the same
 * `Unknown account_key` string. Easy Online Stores (brief 2026-09-16, F6)
 * hit it for "skattekonto" before Skatteverket was connected and had to guess
 * why. One helper now explains the null: the skattekonto cause by name, and
 * for any other key the keys that do exist.
 *
 * Each answer is coded: as plain errors they reached agents as UNKNOWN_ERROR
 * ("Något gick fel. Försök igen."), and agents retried (19 calls in 3
 * companies for a skattekonto with nothing fetched, 2026-09-23..28).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMock = vi.fn()
const tokenMock = vi.fn()
vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: (...args: unknown[]) => listMock(...args),
}))
vi.mock('@/extensions/general/skatteverket/lib/resolve-auth', () => ({
  findCompanyTokenUser: (...args: unknown[]) => tokenMock(...args),
}))

import {
  unknownAccountKeyError,
  SKATTEKONTO_CONNECTION_EXPIRED_MESSAGE,
  SKATTEKONTO_NOT_CONNECTED_MESSAGE,
  SKATTEKONTO_NOT_SYNCED_MESSAGE,
} from '../reconciliation-key-error'
import { toToolError } from '../tool-result'

const supabase = { from: vi.fn() } as never
const COMPANY = 'company-1'
const BANK_KEY = 'bank:22222222-2222-4222-8222-222222222222'

/** The envelope an agent receives for the thrown error. */
const envelope = (error: Error) => toToolError(error, { toolName: 'gnubok_get_reconciliation_status' }).error

describe('unknownAccountKeyError', () => {
  beforeEach(() => {
    listMock.mockReset()
    tokenMock.mockReset()
  })

  it('skattekonto without a Skatteverket token: SKATTEVERKET_NOT_CONNECTED, saying how to connect', async () => {
    tokenMock.mockResolvedValue(null)
    const error = await unknownAccountKeyError(supabase, COMPANY, 'skattekonto')
    expect(error.message).toBe(SKATTEKONTO_NOT_CONNECTED_MESSAGE)
    expect(error.message).toContain('gnubok_connect_skatteverket')
    expect(tokenMock).toHaveBeenCalledWith(supabase, COMPANY)
    expect(listMock).not.toHaveBeenCalled()
    expect(envelope(error)).toMatchObject({
      code: 'SKATTEVERKET_NOT_CONNECTED',
      message_sv: SKATTEKONTO_NOT_CONNECTED_MESSAGE,
      retryable: false,
      remediation: { description: expect.stringMatching(/BankID/) },
    })
  })

  it('skattekonto with a live token but no fetched rows yet: SKATTEKONTO_NOT_SYNCED, the one retryable answer', async () => {
    tokenMock.mockResolvedValue({ userId: 'user-1', needsReconsent: false })
    const error = await unknownAccountKeyError(supabase, COMPANY, 'skattekonto')
    expect(error.message).toBe(SKATTEKONTO_NOT_SYNCED_MESSAGE)
    expect(envelope(error)).toMatchObject({
      code: 'SKATTEKONTO_NOT_SYNCED',
      // thrown_message_sv: the thrower's sentence, account_key included, survives.
      message_sv: SKATTEKONTO_NOT_SYNCED_MESSAGE,
      retryable: true,
      remediation: { tool: 'gnubok_connect_skatteverket' },
    })
  })

  it('skattekonto whose only token needs reconsent: SKATTEVERKET_NOT_CONNECTED, never "wait for the first fetch"', async () => {
    // Two of the three companies told "connected, not fetched yet" had a
    // connection flagged needs_reconsent weeks earlier: no fetch was coming,
    // and one agent asked 13 times in a day.
    tokenMock.mockResolvedValue({ userId: 'user-1', needsReconsent: true })
    const error = await unknownAccountKeyError(supabase, COMPANY, 'skattekonto')
    expect(error.message).toBe(SKATTEKONTO_CONNECTION_EXPIRED_MESSAGE)
    expect(error.message).toContain('gnubok_connect_skatteverket')
    expect(envelope(error)).toMatchObject({ code: 'SKATTEVERKET_NOT_CONNECTED', retryable: false })
  })

  it('a failing token lookup still answers, as not connected', async () => {
    tokenMock.mockRejectedValue(new Error('boom'))
    const error = await unknownAccountKeyError(supabase, COMPANY, 'skattekonto')
    expect(error.message).toBe(SKATTEKONTO_NOT_CONNECTED_MESSAGE)
    expect(envelope(error).code).toBe('SKATTEVERKET_NOT_CONNECTED')
  })

  it('a well-formed key the company lacks: VALIDATION_ERROR listing the keys that exist', async () => {
    listMock.mockResolvedValue([{ account_key: BANK_KEY }, { account_key: 'manual:1930' }])
    const error = await unknownAccountKeyError(supabase, COMPANY, 'manual:1510')
    expect(error.message).toBe(
      `Unknown account_key "manual:1510" for this company. Known keys: ${BANK_KEY}, manual:1930.`,
    )
    expect(listMock).toHaveBeenCalledWith(supabase, COMPANY, { withStatus: false })
    expect(tokenMock).not.toHaveBeenCalled()
    expect(envelope(error)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message_en: expect.stringContaining(BANK_KEY),
      retryable: false,
    })
  })

  it('a malformed key: adds the format and, with nothing to list, what to connect', async () => {
    listMock.mockResolvedValue([])
    const error = await unknownAccountKeyError(supabase, COMPANY, '1930')
    expect(error.message).toBe(
      'Unknown account_key "1930" for this company. Format: "skattekonto", "bank:<cash_account_id>" or "manual:<BAS>". No reconciliation accounts yet: connect a bank or Skatteverket, or use manual:<BAS>.',
    )
    expect(envelope(error).code).toBe('VALIDATION_ERROR')
  })

  it('a failing listing still answers with the unknown-key error', async () => {
    listMock.mockRejectedValue(new Error('boom'))
    const error = await unknownAccountKeyError(supabase, COMPANY, 'manual:1510')
    expect(error.message).toMatch(/^Unknown account_key "manual:1510" for this company\. No reconciliation accounts yet/)
    expect(envelope(error).code).toBe('VALIDATION_ERROR')
  })
})

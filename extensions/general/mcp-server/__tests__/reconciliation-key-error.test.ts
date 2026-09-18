/**
 * The reconciliation services answer null for an account key they cannot
 * resolve, and the MCP tools used to turn every null into the same
 * `Unknown account_key` string. Easy Online Stores (brief 2026-09-16, F6)
 * hit it for "skattekonto" before Skatteverket was connected and had to guess
 * why. One helper now explains the null: the skattekonto cause by name, and
 * for any other key the keys that do exist.
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
  SKATTEKONTO_NOT_CONNECTED_MESSAGE,
  SKATTEKONTO_NOT_SYNCED_MESSAGE,
} from '../reconciliation-key-error'

const supabase = { from: vi.fn() } as never
const COMPANY = 'company-1'
const BANK_KEY = 'bank:22222222-2222-4222-8222-222222222222'

describe('unknownAccountKeyError', () => {
  beforeEach(() => {
    listMock.mockReset()
    tokenMock.mockReset()
  })

  it('skattekonto without a Skatteverket token: says it is not connected and how to connect', async () => {
    tokenMock.mockResolvedValue(null)
    const error = await unknownAccountKeyError(supabase, COMPANY, 'skattekonto')
    expect(error.message).toBe(SKATTEKONTO_NOT_CONNECTED_MESSAGE)
    expect(error.message).toContain('gnubok_connect_skatteverket')
    expect(tokenMock).toHaveBeenCalledWith(supabase, COMPANY)
    expect(listMock).not.toHaveBeenCalled()
  })

  it('skattekonto with a token but no fetched rows yet: connected, waiting for the first sync', async () => {
    tokenMock.mockResolvedValue({ userId: 'user-1', needsReconsent: false })
    const error = await unknownAccountKeyError(supabase, COMPANY, 'skattekonto')
    expect(error.message).toBe(SKATTEKONTO_NOT_SYNCED_MESSAGE)
  })

  it('a failing token lookup still answers, as not connected', async () => {
    tokenMock.mockRejectedValue(new Error('boom'))
    const error = await unknownAccountKeyError(supabase, COMPANY, 'skattekonto')
    expect(error.message).toBe(SKATTEKONTO_NOT_CONNECTED_MESSAGE)
  })

  it('a well-formed key the company lacks: lists the keys that exist', async () => {
    listMock.mockResolvedValue([{ account_key: BANK_KEY }, { account_key: 'manual:1930' }])
    const error = await unknownAccountKeyError(supabase, COMPANY, 'manual:1510')
    expect(error.message).toBe(
      `Unknown account_key "manual:1510" for this company. Known keys: ${BANK_KEY}, manual:1930.`,
    )
    expect(listMock).toHaveBeenCalledWith(supabase, COMPANY, { withStatus: false })
    expect(tokenMock).not.toHaveBeenCalled()
  })

  it('a malformed key: adds the format and, with nothing to list, what to connect', async () => {
    listMock.mockResolvedValue([])
    const error = await unknownAccountKeyError(supabase, COMPANY, '1930')
    expect(error.message).toBe(
      'Unknown account_key "1930" for this company. Format: "skattekonto", "bank:<cash_account_id>" or "manual:<BAS>". No reconciliation accounts yet: connect a bank or Skatteverket, or use manual:<BAS>.',
    )
  })

  it('a failing listing still answers with the unknown-key error', async () => {
    listMock.mockRejectedValue(new Error('boom'))
    const error = await unknownAccountKeyError(supabase, COMPANY, 'manual:1510')
    expect(error.message).toMatch(/^Unknown account_key "manual:1510" for this company\. No reconciliation accounts yet/)
  })
})

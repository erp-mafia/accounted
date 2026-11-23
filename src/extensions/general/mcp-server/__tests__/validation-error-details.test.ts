/**
 * A VALIDATION_ERROR reaches the agent with its details over MCP, as it does
 * on v1 and on the session routes (crm#2158). Before, the MCP envelope kept
 * details only for an allowlist of codes, so an operation refusal such as
 * gnubok_change_bank_ledgers on an account no bank connection syncs answered
 * "Några uppgifter stämmer inte" with nothing saying which rule refused it,
 * although the operation's contract names details.reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { tools } from '../server'
import { toToolError } from '../tool-result'
import { fieldValidationError } from '@/lib/errors/refusal'

const changeBankLedgers = tools.find((t) => t.name === 'gnubok_change_bank_ledgers')!

const CASH_ACCOUNT_ID = '8c68beba-0000-4000-8000-000000000001'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('VALIDATION_ERROR details over MCP', () => {
  it('a ledger change on a cash account no bank connection syncs names the reason', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // The owner's role, then the cash account: a payment provider's balance
    // account the feed created by hand (source manual, no bank connection).
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [{ id: CASH_ACCOUNT_ID, bank_connection_id: null, external_uid: null }] })

    let thrown: unknown
    try {
      await changeBankLedgers.execute(
        { accounts: [{ cash_account_id: CASH_ACCOUNT_ID, ledger_account: '1943' }], dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      )
    } catch (err) {
      thrown = err
    }

    const error = toToolError(thrown, { toolName: 'gnubok_change_bank_ledgers' }).error
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.details).toEqual({
      field: 'accounts',
      reason: 'not_bank_connected',
      cash_account_id: CASH_ACCOUNT_ID,
    })
  })

  it('an argument refusal without details stays as it was', () => {
    const error = toToolError(
      fieldValidationError('Invalid arguments', [{ field: 'accounts', en: 'Required', sv: 'Obligatoriskt fält saknas.' }]),
    ).error
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.details).toBeUndefined()
  })
})

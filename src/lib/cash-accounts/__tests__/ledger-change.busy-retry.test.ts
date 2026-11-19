/**
 * crm#1702: the ledger change's save meets CASH_ACCOUNT_OPERATION_BUSY while
 * another write to the company's bank rows holds the lock the bank guards
 * take without waiting. The save is one statement the database rolled back,
 * so it is tried again, as the other bank-row writers do, and only a lock
 * that stays taken reaches the dialog, with its own sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { CASH_ACCOUNT_BUSY_RETRY } from '@/lib/bookkeeping/cash-account-busy'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { sessionFailureResponse } from '@/lib/operations/session'

const emit = vi.fn()
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: (...a: unknown[]) => emit(...a) } }))

vi.mock('@/lib/operations/access', () => ({ requireCompanyAdmin: vi.fn().mockResolvedValue(null) }))

vi.mock('@/lib/composition/ledger-move-twins', () => ({
  LEDGER_MOVE_TWINS: {
    module: 'transactions',
    prepare: vi.fn().mockResolvedValue({ setAside: [], overBookedBuckets: 0 }),
    apply: vi.fn().mockResolvedValue(0),
  },
}))

import { changeBankAccountLedgers } from '../ledger-change'

const COMPANY = 'company-1'
const CONNECTION = 'conn-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

// The PostgREST error the bank guards raise (RAISE ... USING ERRCODE = 'PT409').
const BUSY = { code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY', details: null, hint: null }

const ACCOUNTS = [
  { uid: '1111', name: 'Företagskonto', iban: 'SE0000000000000000001111', currency: 'SEK', enabled: true },
]

function setup(saveAnswers: Array<{ data?: unknown; error?: unknown }>) {
  const mock = createTableMockSupabase({
    'rpc:read_bank_configuration': {
      data: {
        token: 'token-1',
        connection: {
          id: CONNECTION,
          status: 'active',
          session_id: 'session-1',
          bank_name: 'Testbanken',
          accounts_data: ACCOUNTS,
          aggregator: 'enable_banking',
        },
      },
    },
    cash_accounts: {
      data: [{
        id: 'cash-1',
        ledger_account: '1935',
        bank_connection_id: CONNECTION,
        external_uid: '1111',
        iban: 'SE0000000000000000001111',
        currency: 'SEK',
      }],
    },
    'rpc:cash_account_booked_rows': { data: 0 },
    open_bank_rows: { count: 12 },
    'rpc:save_bank_account_selection': saveAnswers,
  })
  const ctx = { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY, userId: 'user-1', log }
  const saves = () => mock.findCalls('rpc:save_bank_account_selection', 'rpc')
  return { ctx, saves }
}

const REQUEST = { connectionId: CONNECTION, accounts: [{ uid: '1111', ledger_account: '1930' }] }
const RECEIPT = { data: { status: 'active', accounts: ACCOUNTS } }

const realDelays = CASH_ACCOUNT_BUSY_RETRY.delaysMs

beforeEach(() => {
  vi.clearAllMocks()
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = [0, 0, 0, 0]
})
afterEach(() => {
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = realDelays
})

describe('changeBankAccountLedgers while the bank rows are busy (crm#1702)', () => {
  it('saves again when the first save meets the busy lock, and the move goes through', async () => {
    const { ctx, saves } = setup([{ error: BUSY }, RECEIPT])

    const outcome = await changeBankAccountLedgers(ctx, REQUEST)

    expect(outcome.ok && !outcome.dryRun && outcome.data.moves.map((m) => [m.from_ledger, m.to_ledger])).toEqual([['1935', '1930']])
    expect(saves()).toHaveLength(2)
    // Both attempts carry the same snapshot token: a refused save changed nothing.
    expect(saves().map(([args]) => (args as { p_expected_token: string }).p_expected_token)).toEqual(['token-1', 'token-1'])
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('answers CASH_ACCOUNT_OPERATION_BUSY with its own sentence when the lock stays taken, not the generic transient text', async () => {
    const { ctx, saves } = setup([{ error: BUSY }])

    const outcome = await changeBankAccountLedgers(ctx, REQUEST)

    expect(outcome).toMatchObject({ ok: false, code: 'CASH_ACCOUNT_OPERATION_BUSY' })
    // The first try plus one per configured wait.
    expect(saves()).toHaveLength(1 + CASH_ACCOUNT_BUSY_RETRY.delaysMs.length)
    expect(emit).not.toHaveBeenCalled()

    if (outcome.ok) throw new Error('expected a refusal')
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      sessionFailureResponse(outcome, log, 'req-1'),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('CASH_ACCOUNT_OPERATION_BUSY')
    expect(body.error.message).toBe(getErrorEntry('CASH_ACCOUNT_OPERATION_BUSY')?.message_sv)
    expect(body.error.message).not.toBe(getErrorEntry('TRANSIENT_ERROR')?.message_sv)
  })

  it('answers a refusal that is not the busy lock at once, without saving again', async () => {
    const { ctx, saves } = setup([{ error: { code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED', details: null, hint: null } }])

    const outcome = await changeBankAccountLedgers(ctx, REQUEST)

    expect(outcome).toMatchObject({ ok: false, code: 'BANK_CONFIGURATION_CHANGED' })
    expect(saves()).toHaveLength(1)
  })

  it('never saves on a dry run, busy or not', async () => {
    const { ctx, saves } = setup([{ error: BUSY }])

    const outcome = await changeBankAccountLedgers(ctx, REQUEST, { dryRun: true })

    expect(outcome).toMatchObject({ ok: true, dryRun: true })
    expect(saves()).toHaveLength(0)
  })
})

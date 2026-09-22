/**
 * Executor tests for the staged kontoplan + verifikat-note operations:
 * commitCreateAccount, commitUpdateAccount, commitSetVoucherNote. The
 * executors are private to lib/pending-operations/commit.ts and reached
 * through commitPendingOperation, same pattern as
 * dimension-value-executor.test.ts. Staging-side coverage (the MCP tools'
 * pre-flight gates) lives in extensions/general/mcp-server/__tests__/.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_account',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-07-17T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-17T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_account', () => {
  const validParams = {
    account_number: '5410',
    account_name: 'Förbrukningsinventarier',
    account_type: 'expense',
    normal_balance: 'debit',
    plan_type: 'full_bas',
    sru_code: '7321', // 5410's catalog value (lib/bookkeeping/bas-data)
  }

  it('happy path: inserts the account and returns committed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier' } }) // insert
    enqueue({ data: null }) // finalize update

    const op = makePendingOp({ params: validParams })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      account_number: '5410',
      account_name: 'Förbrukningsinventarier',
    })
  })

  it('duplicate account number (23505) auto-rejects with 409', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value' } }) // insert conflict
    enqueue({ data: null }) // dispatcher reject update

    const op = makePendingOp({ params: validParams })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // 404/409 are auto-rejected by the dispatcher (re-stageable), not failed.
    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/finns redan/)
  })

  it('re-validates staged params at the commit boundary (tampered account_type rejected)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { ...validParams, account_type: 'weapons_cache' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid account_type/)
  })

  it('rejects a tampered non-4-digit account_number', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { ...validParams, account_number: '5410; DROP TABLE' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid account_number/)
  })

  it('rejects an account_type inconsistent with the BAS class digit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // dispatcher reject update

    // Class 2 is equity/liability/untaxed_reserves; an expense there would
    // put a P&L account on the balance-sheet side of every report.
    const op = makePendingOp({
      params: { ...validParams, account_number: '2999', account_type: 'expense' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/BAS class 2/)
  })

  it('accepts class 8 revenue and class 2 untaxed_reserves (legal combinations)', async () => {
    for (const params of [
      { ...validParams, account_number: '8310', account_name: 'Ränteintäkter', account_type: 'revenue', normal_balance: 'credit' },
      { ...validParams, account_number: '2150', account_name: 'Ackumulerade överavskrivningar', account_type: 'untaxed_reserves', normal_balance: 'credit' },
    ]) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'op-1' } }) // CAS claim
      enqueue({ data: { account_number: params.account_number, account_name: params.account_name } }) // insert
      enqueue({ data: null }) // finalize update

      const op = makePendingOp({ params })
      const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)
      expect(result.status).toBe('committed')
    }
  })
})

describe('commitPendingOperation: update_account', () => {
  it('happy path: applies only the provided fields', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { account_number: '5410', account_name: 'Verktyg', is_active: false } }) // update
    enqueue({ data: null }) // finalize update

    const op = makePendingOp({
      operation_type: 'update_account',
      params: { account_number: '5410', account_name: 'Verktyg', is_active: false },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      account_number: '5410',
      account_name: 'Verktyg',
      is_active: false,
    })
  })

  it('empty string clears a stored text field (description → null)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true } }) // update
    enqueue({ data: null }) // finalize update

    const op = makePendingOp({
      operation_type: 'update_account',
      params: { account_number: '5410', description: '' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // '' normalises to null in the update payload (clear), so the op commits
    // rather than tripping the empty-change-set guard.
    expect(result.status).toBe('committed')
  })

  it('derives an omitted booking rate at commit when the stored rate is unset', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { default_vat_rate: null } }) // current account
    enqueue({ data: { account_number: '4056', account_name: 'EU-varor', is_active: true } }) // update
    enqueue({ data: null }) // finalize update

    const op = makePendingOp({
      operation_type: 'update_account',
      params: {
        account_number: '4056',
        default_vat_treatment: 'reverse_charge_eu_goods',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(findCalls('chart_of_accounts', 'update')[0]?.[0]).toMatchObject({
      default_vat_treatment: 'reverse_charge_eu_goods',
      default_vat_rate: 0.25,
    })
  })

  it('preserves a stored booking rate when a staged treatment omits it', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { default_vat_rate: 0.12 } }) // current account
    enqueue({ data: { account_number: '4056', account_name: 'EU-varor', is_active: true } }) // update
    enqueue({ data: null }) // finalize update

    const op = makePendingOp({
      operation_type: 'update_account',
      params: {
        account_number: '4056',
        default_vat_treatment: 'reverse_charge_eu_goods',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(findCalls('chart_of_accounts', 'update')[0]?.[0]).toEqual({
      default_vat_treatment: 'reverse_charge_eu_goods',
    })
  })

  it('unknown account (PGRST116) auto-rejects with 404', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null, error: { code: 'PGRST116', message: 'zero rows' } }) // update miss
    enqueue({ data: null }) // dispatcher reject update

    const op = makePendingOp({
      operation_type: 'update_account',
      params: { account_number: '5410', is_active: true },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
    expect(result.error).toMatch(/hittades inte/)
  })

  it('rejects an empty change set (tampered params)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // dispatcher reject update

    const op = makePendingOp({
      operation_type: 'update_account',
      params: { account_number: '5410' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Inget att uppdatera/)
  })
})

describe('commitPendingOperation: set_voucher_note', () => {
  const JE_ID = '3f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'

  it('happy path: notes-only update returns the voucher reference', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: JE_ID, voucher_series: 'A', voucher_number: 42 } }) // update
    enqueue({ data: null }) // finalize update

    const op = makePendingOp({
      operation_type: 'set_voucher_note',
      params: { journal_entry_id: JE_ID, notes: 'Avser Q1-hyran' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      journal_entry_id: JE_ID,
      voucher_series: 'A',
      voucher_number: 42,
      notes: 'Avser Q1-hyran',
    })
  })

  it('null clears the note', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: JE_ID, voucher_series: 'A', voucher_number: 42 } }) // update
    enqueue({ data: null }) // finalize update

    const op = makePendingOp({
      operation_type: 'set_voucher_note',
      params: { journal_entry_id: JE_ID, notes: null },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ notes: null })
  })

  it('unknown entry auto-rejects with 404 (no phantom success)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // update matches zero rows (maybeSingle → null)
    enqueue({ data: null }) // dispatcher reject update

    const op = makePendingOp({
      operation_type: 'set_voucher_note',
      params: { journal_entry_id: JE_ID, notes: 'x' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
    expect(result.error).toMatch(/hittades inte/)
  })

  it('re-validates staged params at the commit boundary (oversized note rejected)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // dispatcher reject update

    const op = makePendingOp({
      operation_type: 'set_voucher_note',
      params: { journal_entry_id: JE_ID, notes: 'x'.repeat(2001) },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid notes/)
  })

  it('trigger rejection (e.g. locked period) surfaces as a failed op, not a throw', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null, error: { code: 'P0001', message: 'Bokföringen är låst till och med 2026-03-31' } })
    enqueue({ data: null }) // dispatcher reject update

    const op = makePendingOp({
      operation_type: 'set_voucher_note',
      params: { journal_entry_id: JE_ID, notes: 'x' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/låst/)
  })
})

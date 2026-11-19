import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { MigratedDeductionHeldByRequestError } from '@/lib/bookkeeping/errors'
import { createTableMockSupabase } from '@/tests/helpers'

const { log } = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))

import {
  assertMigratedDeductionReversible,
  syncMigratedDeductionAfterReversal,
} from '../migrated-deduction-reversal'

const RPC = 'rpc:revert_migrated_invoice_deduction'
const ENTRY = { id: 'je-reclass', source_id: 'inv-1' }

const mock = createTableMockSupabase()
const supabase = mock.supabase as unknown as SupabaseClient

function rpcArgs(): unknown[] {
  return mock.findCalls(RPC, 'rpc').map((args) => args[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mock.reset()
})

describe('assertMigratedDeductionReversible', () => {
  it('passes when the check answers ok, asking in check-only mode', async () => {
    mock.setTable(RPC, { data: { ok: true } })

    await expect(assertMigratedDeductionReversible(supabase, 'company-1', ENTRY)).resolves.toBeUndefined()
    expect(rpcArgs()).toEqual([
      { p_company_id: 'company-1', p_invoice_id: 'inv-1', p_journal_entry_id: 'je-reclass', p_check_only: true },
    ])
  })

  it('throws MigratedDeductionHeldByRequestError while a begäran holds the invoice', async () => {
    mock.setTable(RPC, { data: { ok: false, code: 'HELD_BY_REQUEST' } })

    const error = await assertMigratedDeductionReversible(supabase, 'company-1', ENTRY).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MigratedDeductionHeldByRequestError)
    expect((error as MigratedDeductionHeldByRequestError).invoiceId).toBe('inv-1')
    expect((error as MigratedDeductionHeldByRequestError).code).toBe('MIGRATED_DEDUCTION_HELD_BY_REQUEST')
  })

  it('throws the RPC error: an unverifiable reversal is not reversible', async () => {
    const rpcError = { message: 'connection reset', code: '08006' }
    mock.setTable(RPC, { error: rpcError })

    await expect(assertMigratedDeductionReversible(supabase, 'company-1', ENTRY)).rejects.toBe(rpcError)
  })

  it('warns and lets the storno through on any other refusal', async () => {
    mock.setTable(RPC, { data: { ok: false, code: 'INVOICE_NOT_FOUND' } })

    await expect(assertMigratedDeductionReversible(supabase, 'company-1', ENTRY)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][1]).toMatchObject({ entryId: 'je-reclass', invoiceId: 'inv-1', code: 'INVOICE_NOT_FOUND' })
  })

  it('asks nothing for a voucher without a source invoice', async () => {
    await expect(
      assertMigratedDeductionReversible(supabase, 'company-1', { id: 'je-reclass', source_id: null }),
    ).resolves.toBeUndefined()
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('syncMigratedDeductionAfterReversal', () => {
  it('reverts the invoice through the RPC and logs the revert', async () => {
    mock.setTable(RPC, { data: { ok: true, reverted: true, status: 'sent' } })

    await syncMigratedDeductionAfterReversal(supabase, 'company-1', ENTRY)

    expect(rpcArgs()).toEqual([
      { p_company_id: 'company-1', p_invoice_id: 'inv-1', p_journal_entry_id: 'je-reclass', p_check_only: false },
    ])
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('logs and returns on a refusal: the storno stands', async () => {
    mock.setTable(RPC, { data: { ok: false, code: 'HELD_BY_REQUEST' } })

    await expect(syncMigratedDeductionAfterReversal(supabase, 'company-1', ENTRY)).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error.mock.calls[0][2]).toMatchObject({ entryId: 'je-reclass', invoiceId: 'inv-1', code: 'HELD_BY_REQUEST' })
    expect(log.info).not.toHaveBeenCalled()
  })

  it('logs and returns on an RPC error', async () => {
    const rpcError = { message: 'deadlock detected' }
    mock.setTable(RPC, { error: rpcError })

    await expect(syncMigratedDeductionAfterReversal(supabase, 'company-1', ENTRY)).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error.mock.calls[0][1]).toBe(rpcError)
  })

  it('stays quiet when the invoice had nothing to revert', async () => {
    mock.setTable(RPC, { data: { ok: true, reverted: false } })

    await syncMigratedDeductionAfterReversal(supabase, 'company-1', ENTRY)

    expect(log.info).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it('asks nothing for a voucher without a source invoice', async () => {
    await syncMigratedDeductionAfterReversal(supabase, 'company-1', { id: 'je-reclass', source_id: null })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })
})

import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { getTwinRepairReceipt, healTwinCashAccounts } from '../heal-twins'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
const companyId = '123e4567-e89b-12d3-a456-426614174000'
const operationId = '123e4567-e89b-12d3-a456-426614174001'
const fingerprint = 'a'.repeat(64)
const actor = { type: 'system' as const, id: operationId, label: 'twin repair' }
const write = { dryRun: false as const, expectedFingerprint: fingerprint, operationId, actor }
const plan = { companyId, dryRun: true, fingerprint, groups: [] }
const receipt = { ...plan, dryRun: false, operationId }

describe('healTwinCashAccounts', () => {
  it('uses the database plan without any writes during review', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: plan, error: null })
    const from = vi.fn()
    expect(await healTwinCashAccounts({ rpc, from } as unknown as SupabaseClient, companyId, { dryRun: true })).toEqual(plan)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('plan_cash_account_twins', { p_company_id: companyId })
    expect(from).not.toHaveBeenCalled()
  })
  it('passes the same reviewed fingerprint and stable operation ID on every retry', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: receipt, error: null })
    const from = vi.fn()
    const db = { rpc, from } as unknown as SupabaseClient
    expect(await healTwinCashAccounts(db, companyId, write)).toEqual(receipt)
    expect(await healTwinCashAccounts(db, companyId, write)).toEqual(receipt)
    expect(rpc).toHaveBeenNthCalledWith(1, 'heal_cash_account_twins', {
      p_company_id: companyId, p_expected_fingerprint: fingerprint, p_operation_id: operationId, p_actor: actor,
    })
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0])
    expect(from).not.toHaveBeenCalled()
  })
  it('propagates database conflicts without attempting any separate audit or repair writes', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '40001', message: 'plan changed' } })
    const from = vi.fn()
    await expect(healTwinCashAccounts({ rpc, from } as unknown as SupabaseClient, companyId, write))
      .rejects.toMatchObject({ code: '40001', message: 'cash account twin repair failed: plan changed' })
    expect(from).not.toHaveBeenCalled()
  })
  it.each([null, { ...receipt, companyId: 'another' }, { ...receipt, operationId: 'another' }, { ...receipt, fingerprint: 'old' }])
    ('rejects an invalid completion acknowledgement: %j', async data => {
      const rpc = vi.fn().mockResolvedValue({ data, error: null })
      await expect(healTwinCashAccounts({ rpc } as unknown as SupabaseClient, companyId, write))
        .rejects.toThrow('missing or invalid acknowledgement')
    })
  it('preserves the actor PII boundary before execution', async () => {
    const rpc = vi.fn()
    await expect(healTwinCashAccounts({ rpc } as unknown as SupabaseClient, companyId,
      { ...write, actor: { type: 'user', id: companyId, label: '900101-1234' } })).rejects.toThrow('actor.label contains PII')
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('getTwinRepairReceipt', () => {
  it.each([null, { payload: { phase: 'completed', result: receipt } }])('recovers by company and operation without finding twins: %j', async data => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data, error: null }) }
    const from = vi.fn().mockReturnValue(query)
    expect(await getTwinRepairReceipt({ from } as unknown as SupabaseClient, companyId, operationId)).toEqual(data ? receipt : null)
    expect(from).toHaveBeenCalledExactlyOnceWith('processing_history')
    expect(query.eq).toHaveBeenCalledWith('company_id', companyId)
    expect(query.eq).toHaveBeenCalledWith('event_id', operationId)
    expect(query.eq).toHaveBeenCalledWith('event_type', 'CashAccountTwinsMerged')
  })
})

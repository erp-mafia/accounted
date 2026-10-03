import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'

// #3440 interim block, approval door. The suspension module is NOT mocked:
// these tests pin the switch as shipped. The fix PR deletes this file with the
// suspension module.

vi.mock('@/lib/core/bookkeeping/kontantmetod-cutoff', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/core/bookkeeping/kontantmetod-cutoff')
  >('@/lib/core/bookkeeping/kontantmetod-cutoff')
  return {
    ...actual,
    assessKontantmetodCutoff: vi.fn(),
    postKontantmetodCutoff: vi.fn(),
  }
})

import { commitPendingOperation } from '../commit'
import {
  assessKontantmetodCutoff,
  postKontantmetodCutoff,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { isKontantmetodCutoffSuspended } from '@/lib/core/bookkeeping/kontantmetod-cutoff-suspension'
import { getErrorEntry } from '@/lib/errors/structured-errors'

/** An operation staged before the suspension shipped, exactly as staging wrote it. */
function preStagedCutoffOp(): PendingOperation {
  return {
    id: 'op-1', user_id: 'user-1', company_id: 'company-1',
    operation_type: 'post_kontantmetod_cutoff', status: 'pending',
    title: 'Kontantmetodens bokslutsavgränsning: 2026',
    params: {
      fiscal_period_id: 'fp-1',
      next_fiscal_period_id: 'fp-2',
      period_end: '2026-12-31',
      entity_type: 'aktiebolag',
      preview_fingerprint: 'a'.repeat(64),
    },
    preview_data: {}, result_data: null, actor_type: 'api_key', actor_id: null,
    actor_label: null, risk_level: 'high', created_at: '2027-01-15T00:00:00Z',
    resolved_at: null, updated_at: '2027-01-15T00:00:00Z',
  } as unknown as PendingOperation
}

/** Records every table touched; any read or write is a failure of the gate. */
function makeRecordingSupabase() {
  const from = vi.fn(() => {
    throw new Error('the suspension gate must refuse before touching the database')
  })
  return { auth: {}, from, rpc: vi.fn() }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('kontantmetoden cut-off suspension (#3440): approval door', () => {
  it('is switched on', () => {
    expect(isKontantmetodCutoffSuspended()).toBe(true)
  })

  it('refuses a pre-staged cut-off with KONTANTMETOD_CUTOFF_SUSPENDED and keeps it pending', async () => {
    const supabase = makeRecordingSupabase()
    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', preStagedCutoffOp(),
      { commitMethod: 'api_key', actor: { type: 'api_key' } },
    )

    expect(result).toMatchObject({
      status: 'failed',
      code: 'KONTANTMETOD_CUTOFF_SUSPENDED',
      http_status: 409,
      operation_status: 'pending',
    })
    expect(result.error).toBe(getErrorEntry('KONTANTMETOD_CUTOFF_SUSPENDED')?.message_sv)
    // Before the claim and before any read: the op is not consumed and
    // nothing is assessed or posted.
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(assessKontantmetodCutoff).not.toHaveBeenCalled()
    expect(postKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('refuses the same way for an in-app approval', async () => {
    const supabase = makeRecordingSupabase()
    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', preStagedCutoffOp(),
      { commitMethod: 'user_accept', actor: { type: 'user', label: 'owner@example.com' } },
    )
    expect(result.code).toBe('KONTANTMETOD_CUTOFF_SUSPENDED')
    expect(result.operation_status).toBe('pending')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('leaves every other operation type alone', async () => {
    const op = { ...preStagedCutoffOp(), operation_type: 'run_year_end' } as PendingOperation
    const supabase = makeRecordingSupabase()
    // run_year_end goes on to the claim, which this recording client refuses
    // by throwing: proof the suspension gate let it through.
    await expect(
      commitPendingOperation(supabase as never, 'user-1', 'company-1', op),
    ).rejects.toThrow(/must refuse before touching the database/)
  })
})

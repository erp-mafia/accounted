/**
 * Tests for the commit-time capability gate in commitPendingOperation.
 *
 * This is the twin of the MCP dispatch gate and the true external-service
 * chokepoint: it runs BEFORE the atomic claim, so a blocked op stays 'pending'
 * (re-approvable once the company subscribes) and an op staged DURING the trial
 * cannot be committed once the grant expires — regardless of caller (MCP approve
 * tool or the UI approval path).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn() }
})

import { commitPendingOperation } from '../commit'
import { hasCapability } from '@/lib/entitlements/has-capability'

const mockHasCapability = vi.mocked(hasCapability)

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'send_invoice',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: capability gate', () => {
  it('blocks send_invoice when email_send is not entitled — 403, op left pending', async () => {
    mockHasCapability.mockResolvedValue(false)
    const { supabase } = createQueuedMockSupabase() // no responses enqueued: the claim must never run

    const op = makePendingOp({ operation_type: 'send_invoice', params: { invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(403)
    expect(result.code).toBe('capability_blocked')
    expect(mockHasCapability).toHaveBeenCalledWith(supabase, 'company-1', 'email_send')
  })

  it('blocks submit_vat_declaration when skatteverket is not entitled', async () => {
    mockHasCapability.mockResolvedValue(false)
    const { supabase } = createQueuedMockSupabase()

    const op = makePendingOp({ operation_type: 'submit_vat_declaration', params: { period_type: 'monthly', year: 2025, period: 3 } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(403)
    expect(result.code).toBe('capability_blocked')
    expect(mockHasCapability).toHaveBeenCalledWith(supabase, 'company-1', 'skatteverket')
  })

  it('does NOT consult the gate for a free operation type', async () => {
    mockHasCapability.mockResolvedValue(false)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // claim resolves to "already claimed" → early 409, before any executor

    const op = makePendingOp({ operation_type: 'create_customer', params: { name: 'x' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // create_customer is not in PAID_OPERATION_CAPABILITY_MAP — the gate is skipped.
    expect(mockHasCapability).not.toHaveBeenCalled()
    expect(result.status).toBe('failed') // claim returned no row (409); proves we got past the gate
  })
})

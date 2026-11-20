/**
 * A staged attest (approve_supplier_invoice) approved in a bulk approval:
 * the executor hands the bulk route's decision batch to the attest service,
 * which adds the answer the moment the attest is stored instead of mailing,
 * so the route sends one mail for all of them
 * (lib/supplier-invoices/attest-decision-notify.ts). A single approval leaves
 * the mail to the service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

const approveSupplierInvoice = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supplier-invoices/attest-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supplier-invoices/attest-service')>()),
  approveSupplierInvoice: (...args: unknown[]) => approveSupplierInvoice(...args),
}))

import { commitPendingOperation } from '../commit'
import { createAttestDecisionBatch } from '@/lib/supplier-invoices/attest-decision-notify'

function stagedAttest(id: string, invoiceId: string): PendingOperation {
  return {
    id,
    user_id: 'agent-user',
    company_id: 'company-1',
    operation_type: 'approve_supplier_invoice',
    status: 'pending',
    title: 'Attestera faktura',
    params: { supplier_invoice_id: invoiceId },
    preview_data: { total_sek: 1000 },
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Claude',
    risk_level: 'low',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-10-31T08:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-31T08:00:00Z',
  } as PendingOperation
}

const attested = (invoiceId: string) => ({
  ok: true,
  data: {
    invoice: { id: invoiceId, status: 'approved', approved_at: '2026-10-31T09:00:00Z' },
    approved: true,
    attest: { remaining: [] },
    attestation_id: `att-${invoiceId}`,
  },
})

function claimAndFinalize() {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: { id: 'op', updated_at: '2026-10-31T09:00:00Z' } }) // CAS claim
  mock.enqueue({ data: null }) // finalize
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('approve_supplier_invoice in a bulk approval', () => {
  it('hands the same batch to the attest service for every staged attest', async () => {
    const batch = createAttestDecisionBatch()
    for (const [op, invoiceId] of [
      ['op-1', 'si-1'],
      ['op-2', 'si-2'],
    ]) {
      approveSupplierInvoice.mockResolvedValueOnce(attested(invoiceId))
      const { supabase } = claimAndFinalize()
      const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', stagedAttest(op, invoiceId), {
        commitMethod: 'bulk_accept',
        actor: { type: 'user', label: 'byra@example.se' },
        attestDecisions: batch,
      })
      expect(result.status).toBe('committed')
    }
    expect(approveSupplierInvoice).toHaveBeenCalledTimes(2)
    for (const [, input] of approveSupplierInvoice.mock.calls) {
      expect(input).toMatchObject({ source: 'mcp' })
      expect((input as { decisions?: unknown }).decisions).toBe(batch)
    }
  })

  it('a single approval leaves the mail to the attest service', async () => {
    approveSupplierInvoice.mockResolvedValueOnce(attested('si-1'))
    const { supabase } = claimAndFinalize()
    await commitPendingOperation(supabase as never, 'user-1', 'company-1', stagedAttest('op-1', 'si-1'), { commitMethod: 'user_accept' })
    expect(approveSupplierInvoice.mock.calls[0][1]).not.toHaveProperty('decisions')
  })
})

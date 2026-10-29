import { describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => {
    throw new Error('the machine doors write with their own service client')
  }),
}))

import {
  supplierInvoicesAttestPolicyGet,
  supplierInvoicesAttestPolicyUpdate,
  supplierInvoicesAttestationsList,
  supplierInvoicesReject,
} from '../supplier-invoice-attest'

const ANNA = '0b8f3e9a-2b1c-4c47-9a39-3a0f6f4f1d11'
const BO = '6d2a1c3e-8f4b-4a5d-9e7f-1a2b3c4d5e6f'
const log = createLogger('test')
const POLICY = {
  company_id: 'c1',
  enabled: true,
  threshold_amount: '5000.00',
  mode: 'any',
  attesters: [ANNA],
  preparer_may_attest: false,
  two_step_from_sek: null,
  updated_by: ANNA,
  updated_at: '2026-10-14T09:00:00Z',
}

function ctx(tables: Record<string, unknown>) {
  const mock = createTableMockSupabase(tables as never)
  return { mock, ctx: { supabase: mock.supabase as never, companyId: 'c1', userId: ANNA, log } }
}

describe('supplier-invoices.attest-policy.get', () => {
  it('answers the policy with its attesters named and their limits', async () => {
    const { ctx: c } = ctx({
      company_attest_policies: { data: { ...POLICY, attesters: [ANNA, BO], two_step_from_sek: '100000.00' } },
      company_attest_limits: { data: [{ user_id: ANNA, max_amount_sek: '50000.00' }] },
      profiles: { data: [{ id: ANNA, email: 'anna@example.se', full_name: 'Anna Ek' }] },
    })
    const outcome = await supplierInvoicesAttestPolicyGet.run(c, {}, { dryRun: false })
    expect(outcome).toEqual({
      ok: true,
      data: {
        enabled: true,
        threshold_amount: 5000,
        mode: 'any',
        attesters: [
          { user_id: ANNA, name: 'Anna Ek', email: 'anna@example.se', limit_sek: 50000 },
          { user_id: BO, name: null, email: null, limit_sek: null },
        ],
        preparer_may_attest: false,
        two_step_from_sek: 100000,
        updated_at: '2026-10-14T09:00:00Z',
      },
    })
    expect(supplierInvoicesAttestPolicyGet.output.safeParse((outcome as { data: unknown }).data).success).toBe(true)
  })

  it('reads a company without a policy as off', async () => {
    const { ctx: c } = ctx({ company_attest_policies: { data: null } })
    expect(await supplierInvoicesAttestPolicyGet.run(c, {}, { dryRun: false })).toMatchObject({ ok: true, data: { enabled: false, attesters: [] } })
  })
})

describe('supplier-invoices.attest-policy.update', () => {
  const input = { enabled: true, threshold_amount: 5000, mode: 'any' as const, attesters: [ANNA], preparer_may_attest: false }

  it('is for owners and admins: a member is refused before anything is written', async () => {
    const { mock, ctx: c } = ctx({ company_members: { data: { role: 'member' } } })
    expect(await supplierInvoicesAttestPolicyUpdate.run(c, input, { dryRun: false })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(mock.payloads('company_attest_policies', 'upsert')).toEqual([])
  })

  it('saves for an owner, and a dry run writes nothing', async () => {
    const { mock, ctx: c } = ctx({
      company_members: [{ data: { role: 'owner' } }, { data: [{ user_id: ANNA, role: 'owner' }] }],
      company_attest_policies: { data: POLICY },
      profiles: { data: [] },
    })
    expect(await supplierInvoicesAttestPolicyUpdate.run(c, input, { dryRun: true })).toMatchObject({ ok: true, dryRun: true })
    expect(mock.findCalls('rpc:save_company_attest_policy', 'rpc')).toEqual([])
    mock.setTable('company_members', [{ data: { role: 'owner' } }, { data: [{ user_id: ANNA, role: 'owner' }] }])
    expect(
      await supplierInvoicesAttestPolicyUpdate.run(c, { ...input, limits: [{ user_id: ANNA, max_amount_sek: 50000 }] }, { dryRun: false }),
    ).toMatchObject({ ok: true, data: { enabled: true, threshold_amount: 5000 } })
    // The door's own (service-role) client saves the policy and the limits in one call.
    expect(mock.findCall('rpc:save_company_attest_policy', 'rpc')?.[0]).toMatchObject({
      p_attesters: [ANNA],
      p_updated_by: ANNA,
      p_limits: [{ user_id: ANNA, max_amount_sek: 50000 }],
    })
  })

  it('validates its input: a negative threshold, an unknown mode, a limit of zero and a bad two-step amount are refused by the schema', () => {
    expect(supplierInvoicesAttestPolicyUpdate.input.safeParse({ ...input, threshold_amount: -1 }).success).toBe(false)
    expect(supplierInvoicesAttestPolicyUpdate.input.safeParse({ ...input, mode: 'some' }).success).toBe(false)
    expect(supplierInvoicesAttestPolicyUpdate.input.safeParse({ ...input, limits: [{ user_id: ANNA, max_amount_sek: 0 }] }).success).toBe(false)
    expect(supplierInvoicesAttestPolicyUpdate.input.safeParse({ ...input, limits: [{ user_id: 'anna', max_amount_sek: 10 }] }).success).toBe(false)
    expect(supplierInvoicesAttestPolicyUpdate.input.safeParse({ ...input, two_step_from_sek: -1 }).success).toBe(false)
    expect(supplierInvoicesAttestPolicyUpdate.input.safeParse({ ...input, two_step_from_sek: null, limits: [{ user_id: ANNA, max_amount_sek: null }] }).success).toBe(true)
  })
})

describe('supplier-invoices.attestations.list and supplier-invoices.reject', () => {
  it('answers SI_NOT_FOUND for an invoice of another company', async () => {
    const { ctx: c } = ctx({ supplier_invoices: { data: null } })
    expect(await supplierInvoicesAttestationsList.run(c, { supplier_invoice_id: ANNA }, { dryRun: false })).toMatchObject({ ok: false, code: 'SI_NOT_FOUND' })
    expect(await supplierInvoicesReject.run(c, { supplier_invoice_id: ANNA, comment: null }, { dryRun: false })).toMatchObject({ ok: false, code: 'SI_NOT_FOUND' })
  })

  it('rejects from the API with the comment, writing with the door\'s own client', async () => {
    const { mock, ctx: c } = ctx({
      supplier_invoices: { data: { id: 'inv-1', company_id: 'c1', user_id: 'cilla', status: 'registered', approved_at: null, due_date: '2999-01-01', remaining_amount: 100, currency: 'SEK', total: 100, total_sek: null, exchange_rate: null, is_credit_note: false } },
      company_attest_policies: { data: null },
      supplier_invoice_attestations: { data: { id: 'att-1' } },
    })
    const outcome = await supplierInvoicesReject.run(c, { supplier_invoice_id: ANNA, comment: 'Fel belopp' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { attestation_id: 'att-1', status: 'registered' } })
    expect(mock.payloads('supplier_invoice_attestations', 'insert')[0]).toMatchObject({ decision: 'rejected', source: 'api', comment: 'Fel belopp' })
  })
})

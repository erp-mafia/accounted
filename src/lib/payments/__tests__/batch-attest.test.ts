import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { createSupplierPaymentBatch, previewSupplierPaymentBatch } from '@/lib/payments/batch-service'

/**
 * The payment file path under the attest policy: an invoice the policy
 * requires attest for and has not got is left out (attest_required) of the
 * preview and refused by the create, the same rule as the bank payment path
 * (orders/__tests__/prepare-lifecycle.test.ts).
 */

const COMPANY_ID = 'c0000000-0000-0000-0000-000000000001'

const SUPPLIER = {
  id: 'sup-1',
  name: 'Derome Bygg & Industri AB',
  city: 'Veddige',
  bankgiro: '5050-1055',
  plusgiro: null,
  bank_account: null,
  clearing_number: null,
  account_number: null,
}

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  user_id: 'registrant',
  status: 'registered',
  approved_at: null,
  due_date: '2099-08-20',
  remaining_amount: 737.5,
  total: 737.5,
  total_sek: null,
  exchange_rate: null,
  currency: 'SEK',
  is_credit_note: false,
  payment_reference: null,
  supplier_invoice_number: `F-${id}`,
  supplier: SUPPLIER,
  ...overrides,
})

function db(policy: Record<string, unknown> | null) {
  return createTableMockSupabase({
    companies: { data: { name: 'Testbolaget AB', org_number: '556677-8899' } },
    company_settings: {
      data: { company_name: 'Testbolaget AB', org_number: '556677-8899', city: 'Stockholm', iban: 'SE3550000000054910000003', bic: 'ESSESESS', bankgiro: '991-2346', clearing_number: null, bank_name: null, accounting_method: 'accrual' },
    },
    supplier_invoices: { data: [row('unattested'), row('attested', { status: 'approved', approved_at: '2026-08-01T10:00:00Z' })] },
    supplier_payment_batch_items: { data: [] },
    payment_orders: { data: [] },
    company_attest_policies: { data: policy },
  })
}

const POLICY_ON = { company_id: COMPANY_ID, enabled: true, threshold_amount: null, mode: 'any', attesters: ['anna'], preparer_may_attest: false, updated_by: null, updated_at: null }

describe('payment file under the attest policy', () => {
  it('preview: leaves out the invoice that waits for attest', async () => {
    const mock = db(POLICY_ON)
    const preview = await previewSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, { ids: ['unattested', 'attested'] })
    expect(preview.excluded).toEqual([{ id: 'unattested', reason: 'attest_required' }])
    expect(preview.eligible.map((l) => l.id)).toEqual(['attested'])
  })

  it('create: refuses the invoice that waits for attest before the RPC', async () => {
    const mock = db(POLICY_ON)
    const result = await createSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, 'user-1', {
      format: 'pain001',
      items: [{ supplier_invoice_id: 'unattested' }],
    })
    expect(result).toEqual({ ok: false, code: 'ineligible', details: [{ id: 'unattested', reason: 'attest_required' }] })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('a failed policy read stops the preview and the create: it never reads as no policy', async () => {
    const failed = { message: 'policy read failed' }
    const mock = db(null)
    mock.setTable('company_attest_policies', { data: null, error: failed })
    await expect(previewSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, { ids: ['unattested'] })).rejects.toBe(failed)
    await expect(
      createSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, 'user-1', {
        format: 'pain001',
        items: [{ supplier_invoice_id: 'unattested' }],
      }),
    ).rejects.toBe(failed)
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('policy off: the unattested invoice is in the file with the warning, as before', async () => {
    const mock = db(null)
    const preview = await previewSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, { ids: ['unattested'] })
    expect(preview.excluded).toEqual([])
    expect(preview.eligible[0]!.warnings).toContain('unattested')
  })
})

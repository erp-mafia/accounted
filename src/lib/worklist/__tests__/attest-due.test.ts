import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { listSupplierInvoiceAttestsDue } from '../categories'

/**
 * The per-attester Att göra rows: "Attestera {leverantör} {belopp}", one per
 * invoice waiting for this person's attest under the attest policy.
 */

const POLICY = { company_id: 'c1', enabled: true, threshold_amount: 1000, mode: 'all', attesters: ['anna', 'bo'], preparer_may_attest: false, updated_by: null, updated_at: null }
const invoice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  user_id: 'cilla',
  supplier_invoice_number: `F-${id}`,
  arrival_number: 1,
  total: 5000,
  total_sek: null,
  exchange_rate: null,
  currency: 'SEK',
  due_date: '2026-10-31',
  is_credit_note: false,
  supplier: { name: 'Kontorsvaror AB' },
  ...overrides,
})

function db(overrides: Record<string, unknown> = {}) {
  return createTableMockSupabase({
    company_attest_policies: { data: POLICY },
    company_settings: { data: { accounting_method: 'accrual' } },
    company_members: { data: { role: 'member' } },
    supplier_invoices: { data: [invoice('due'), invoice('small', { total: 10 }), invoice('mine', { user_id: 'anna' }), invoice('given')] },
    supplier_invoice_attestations: { data: [{ supplier_invoice_id: 'given', user_id: 'anna', decision: 'approved', decided_at: '2026-10-01T09:00:00Z' }] },
    ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, v as never])),
  })
}

const list = (mock: ReturnType<typeof db>, userId = 'anna') => listSupplierInvoiceAttestsDue(mock.supabase as unknown as SupabaseClient, 'c1', userId)

describe('listSupplierInvoiceAttestsDue', () => {
  it('lists the invoices waiting for this attester: above the threshold, not their own, not already approved by them', async () => {
    const rows = await list(db())
    expect(rows).toEqual([
      { supplier_invoice_id: 'due', supplier_name: 'Kontorsvaror AB', supplier_invoice_number: 'F-due', arrival_number: 1, total: 5000, currency: 'SEK', due_date: '2026-10-31' },
    ])
  })

  it('brings an invoice back after a rejection restarts the round', async () => {
    const rows = await list(
      db({
        supplier_invoice_attestations: {
          data: [
            { supplier_invoice_id: 'given', user_id: 'anna', decision: 'approved', decided_at: '2026-10-01T09:00:00Z' },
            { supplier_invoice_id: 'given', user_id: 'bo', decision: 'rejected', decided_at: '2026-10-02T09:00:00Z' },
          ],
        },
      }),
    )
    expect(rows.map((r) => r.supplier_invoice_id)).toEqual(['due', 'given'])
  })

  it('is empty for someone who is not an attester, a viewer, a cash-method company and a policy that is off', async () => {
    expect(await list(db(), 'cilla')).toEqual([])
    expect(await list(db({ company_members: { data: { role: 'viewer' } } }))).toEqual([])
    expect(await list(db({ company_settings: { data: { accounting_method: 'cash' } } }))).toEqual([])
    expect(await list(db({ company_attest_policies: { data: { ...POLICY, enabled: false } } }))).toEqual([])
    expect(await list(db({ company_attest_policies: { data: null } }))).toEqual([])
  })

  it('soft-fails to an empty list', async () => {
    expect(await list(db({ supplier_invoices: { error: { message: 'boom' } } }))).toEqual([])
    expect(await list(db({ company_attest_policies: { error: { message: 'boom' } } }))).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { listSupplierInvoiceAttestsDue } from '../categories'

/**
 * The per-attester Att göra rows: "Attestera {leverantör} {belopp}", one per
 * invoice waiting for this person's attest under the attest policy.
 */

const MEMBERS = ['anna', 'bo', 'cilla'].map((user_id) => ({ user_id, role: 'member' }))
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
    company_members: { data: MEMBERS },
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

  it('is empty for someone who is not an attester, an invoicer, a cash-method company and a policy that is off', async () => {
    expect(await list(db(), 'cilla')).toEqual([])
    expect(await list(db({ company_members: { data: [{ user_id: 'anna', role: 'invoicer' }, { user_id: 'bo', role: 'member' }] } }))).toEqual([])
    expect(await list(db({ company_settings: { data: { accounting_method: 'cash' } } }))).toEqual([])
    expect(await list(db({ company_attest_policies: { data: { ...POLICY, enabled: false } } }))).toEqual([])
    expect(await list(db({ company_attest_policies: { data: null } }))).toEqual([])
  })

  it('gives a viewer the policy names the rows a member would have (crm#1569)', async () => {
    const asViewer = await list(db({ company_members: { data: [{ user_id: 'anna', role: 'viewer' }, { user_id: 'bo', role: 'member' }] } }))
    const asMember = await list(db({ company_members: { data: [{ user_id: 'anna', role: 'member' }, { user_id: 'bo', role: 'member' }] } }))
    expect(asViewer.length).toBeGreaterThan(0)
    expect(asViewer).toEqual(asMember)
  })

  it('levels (#135): an invoice above my limit is the row of someone whose limit covers it', async () => {
    // Anna attests up to 1 000 kr, Bo without a limit; the invoice is 5 000 kr.
    const levels = { company_attest_limits: { data: [{ user_id: 'anna', max_amount_sek: 1000 }] } }
    const anyPolicy = { company_attest_policies: { data: { ...POLICY, mode: 'any' } } }
    expect(await list(db({ ...levels, ...anyPolicy }), 'anna')).toEqual([])
    expect((await list(db({ ...levels, ...anyPolicy }), 'bo')).map((r) => r.supplier_invoice_id)).toEqual(['due', 'mine', 'given'])
    // With two attesters from 1 000 kr, Anna's approval counts as one of the two.
    const twoStep = { company_attest_policies: { data: { ...POLICY, mode: 'any', two_step_from_sek: 1000 } } }
    expect((await list(db({ ...levels, ...twoStep }), 'anna')).map((r) => r.supplier_invoice_id)).toEqual(['due'])
    // Once Anna gave hers, the invoice waits for Bo, not for a second limited approval.
    expect((await list(db({ ...levels, ...twoStep }), 'bo')).map((r) => r.supplier_invoice_id)).toEqual(['due', 'mine', 'given'])
  })

  it('soft-fails to an empty list', async () => {
    expect(await list(db({ supplier_invoices: { error: { message: 'boom' } } }))).toEqual([])
    expect(await list(db({ company_attest_policies: { error: { message: 'boom' } } }))).toEqual([])
  })
})

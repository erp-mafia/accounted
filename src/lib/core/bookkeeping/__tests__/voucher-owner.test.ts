import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveVoucherOwner, voucherOwnerOrNull } from '../voucher-owner'

const COMPANY = 'company-1'

function client() {
  const mock = createQueuedMockSupabase()
  return { ...mock, db: mock.supabase as unknown as SupabaseClient }
}

describe('resolveVoucherOwner', () => {
  it('sends an issued invoice voucher to Kreditera on the invoice', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'inv-1', invoice_number: '1043', status: 'sent' } }])

    const owner = await resolveVoucherOwner(db, COMPANY, { id: 'je-1', source_type: 'invoice_created', source_id: 'inv-1' })

    expect(owner).toMatchObject({
      kind: 'invoice',
      owner_id: 'inv-1',
      label: '1043',
      action: 'credit_invoice',
      href: '/invoices/inv-1',
      action_href: '/invoices/inv-1/credit',
      tool: 'gnubok_credit_invoice',
    })
    expect(owner?.hint_sv).toContain('faktura 1043')
    expect(owner?.hint_en).toContain('invoice 1043')
  })

  it('opens an invoice that is already credited instead of offering a second credit', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'inv-1', invoice_number: '1043', status: 'credited' } }])

    const owner = await resolveVoucherOwner(db, COMPANY, { id: 'je-1', source_type: 'invoice_created', source_id: 'inv-1' })

    expect(owner).toMatchObject({ action: 'open_invoice', href: '/invoices/inv-1', action_href: '/invoices/inv-1', tool: null })
  })

  it('opens a customer credit note', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'cn-1', invoice_number: '1050', status: 'sent' } }])

    const owner = await resolveVoucherOwner(db, COMPANY, { id: 'je-1', source_type: 'credit_note', source_id: 'cn-1' })

    expect(owner).toMatchObject({ kind: 'credit_note', action: 'open_invoice', href: '/invoices/cn-1' })
  })

  it('sends an attested supplier invoice voucher to Kreditera on its page', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'si-1', supplier_invoice_number: '3744267', status: 'approved', credited_invoice_id: null } }])

    const owner = await resolveVoucherOwner(db, COMPANY, {
      id: 'je-1',
      source_type: 'supplier_invoice_registered',
      source_id: 'si-1',
    })

    expect(owner).toMatchObject({
      kind: 'supplier_invoice',
      label: '3744267',
      action: 'credit_supplier_invoice',
      href: '/supplier-invoices/si-1',
      action_href: '/supplier-invoices/si-1?action=credit',
      tool: 'gnubok_credit_supplier_invoice',
    })
    expect(owner?.hint_sv).toContain('leverantörsfaktura 3744267')
  })

  it('opens a paid supplier invoice, which its page does not credit', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'si-1', supplier_invoice_number: null, status: 'paid', credited_invoice_id: null } }])

    const owner = await resolveVoucherOwner(db, COMPANY, {
      id: 'je-1',
      source_type: 'supplier_invoice_registered',
      source_id: 'si-1',
    })

    expect(owner).toMatchObject({ action: 'open_supplier_invoice', href: '/supplier-invoices/si-1', label: null })
    expect(owner?.hint_sv).toContain('hör till leverantörsfaktura.')
  })

  it('sends a supplier credit note to the invoice it credits, where Ångra kreditering is', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'scn-1', supplier_invoice_number: 'K-9', status: 'credited', credited_invoice_id: 'si-1' } }])

    const owner = await resolveVoucherOwner(db, COMPANY, {
      id: 'je-1',
      source_type: 'supplier_credit_note',
      source_id: 'scn-1',
    })

    expect(owner).toMatchObject({ kind: 'supplier_credit_note', owner_id: 'scn-1', href: '/supplier-invoices/si-1' })
  })

  it('opens the periodisering a dissolution belongs to', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'sched-1', description: 'Hyra sep-mar' } }])

    const owner = await resolveVoucherOwner(db, COMPANY, { id: 'je-1', source_type: 'accrual', source_id: 'sched-1' })

    expect(owner).toMatchObject({
      kind: 'accrual_schedule',
      label: 'Hyra sep-mar',
      action: 'open_accrual',
      href: '/bookkeeping/periodiseringar',
    })
  })

  it('opens the payroll run, labelled by its period', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'run-1', period_year: 2026, period_month: 9 } }])

    const owner = await resolveVoucherOwner(db, COMPANY, { id: 'je-1', source_type: 'salary_payment', source_id: 'run-1' })

    expect(owner).toMatchObject({
      kind: 'salary_run',
      label: '2026-09',
      href: '/salary/runs/run-1',
      tool: 'gnubok_correct_salary_run',
    })
  })

  it('finds the asset a depreciation verifikat posts through its register row', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { asset: { id: 'asset-1', name: 'Bil' } } }])

    const owner = await resolveVoucherOwner(db, COMPANY, { id: 'je-dep', source_type: 'year_end', source_id: null })

    expect(owner).toMatchObject({ kind: 'asset', owner_id: 'asset-1', label: 'Bil', action: 'open_asset' })
  })

  it('leaves a year-end verifikat without a depreciation row ownerless', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: null }])

    expect(await resolveVoucherOwner(db, COMPANY, { id: 'je-ye', source_type: 'year_end', source_id: null })).toBeNull()
  })

  it('finds the asset an avyttring verifikat books', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: { id: 'asset-1', name: 'Bil' } }])

    const owner = await resolveVoucherOwner(db, COMPANY, { id: 'je-disp', source_type: 'system', source_id: null })

    expect(owner).toMatchObject({ kind: 'asset', owner_id: 'asset-1' })
  })

  it('gives a payment voucher no owner: its Vänd keeps the invoice in step through its hook', async () => {
    const { db, calls } = client()

    expect(await resolveVoucherOwner(db, COMPANY, { id: 'je-1', source_type: 'invoice_paid', source_id: 'inv-1' })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('resolves a correction of a dissolution to the same periodisering', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([
      // The chain root: the dissolution the rättelse replaced.
      { data: { id: 'je-orig', source_type: 'accrual', source_id: 'sched-1', correction_of_id: null, reverses_id: null } },
      { data: { id: 'sched-1', description: 'Hyra' } },
    ])

    const owner = await resolveVoucherOwner(db, COMPANY, {
      id: 'je-corr',
      source_type: 'correction',
      source_id: null,
      correction_of_id: 'je-orig',
    })

    expect(owner).toMatchObject({ kind: 'accrual_schedule', owner_id: 'sched-1' })
  })

  it('resolves a storno of an invoice voucher to the invoice', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([
      { data: { id: 'je-inv', source_type: 'invoice_created', source_id: 'inv-1', correction_of_id: null, reverses_id: null } },
      { data: { id: 'inv-1', invoice_number: '1043', status: 'sent' } },
    ])

    const owner = await resolveVoucherOwner(db, COMPANY, {
      id: 'je-storno',
      source_type: 'storno',
      source_id: 'inv-1',
      reverses_id: 'je-inv',
    })

    expect(owner).toMatchObject({ kind: 'invoice', owner_id: 'inv-1' })
  })

  it('reads the source columns itself when only the id is given', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([
      { data: { id: 'je-1', source_type: 'accrual', source_id: 'sched-1', correction_of_id: null, reverses_id: null } },
      { data: { id: 'sched-1', description: null } },
    ])

    const owner = await resolveVoucherOwner(db, COMPANY, { id: 'je-1' })

    expect(owner).toMatchObject({ kind: 'accrual_schedule', label: null })
  })

  it('answers null when the owner row is gone or belongs to another company', async () => {
    const { db, enqueueMany } = client()
    enqueueMany([{ data: null }])

    expect(await resolveVoucherOwner(db, COMPANY, { id: 'je-1', source_type: 'invoice_created', source_id: 'inv-x' })).toBeNull()
  })
})

describe('voucherOwnerOrNull', () => {
  it('answers null instead of failing the action it rides on', async () => {
    const broken = {
      from: () => {
        throw new Error('connection reset')
      },
    } as unknown as SupabaseClient

    expect(await voucherOwnerOrNull(broken, COMPANY, { id: 'je-1' })).toBeNull()
  })
})

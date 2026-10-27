import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { updateSupplier } from '../update-supplier'

const SUPPLIER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const STORED = {
  id: SUPPLIER_ID,
  name: 'Elnät AB',
  supplier_type: 'swedish_business',
  email: null,
  phone: null,
  address_line1: null,
  address_line2: null,
  postal_code: null,
  city: null,
  country: 'SE',
  org_number: '5560000000',
  vat_number: null,
  bankgiro: '123-4567',
  plusgiro: null,
  bank_account: null,
  clearing_number: null,
  account_number: null,
  iban: null,
  bic: null,
  default_expense_account: null,
  default_payment_terms: 30,
  default_currency: 'SEK',
  auto_debit: false,
  notes: null,
  party_id: null,
  archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const ctx = { supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') }

beforeEach(() => reset())

describe('updateSupplier', () => {
  it('answers SUPPLIER_NOT_FOUND for an id that is not a uuid, without a query', async () => {
    const outcome = await updateSupplier(ctx, 'sup-1', { city: 'Lund' })
    expect(outcome).toMatchObject({ ok: false, code: 'SUPPLIER_NOT_FOUND' })
    expect(findCall('suppliers', 'select')).toBeUndefined()
  })

  it('refuses an update that sends no field', async () => {
    const outcome = await updateSupplier(ctx, SUPPLIER_ID, {})
    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'body' } })
  })

  it('answers SUPPLIER_NOT_FOUND when the supplier is not in the company', async () => {
    enqueue({ data: null })
    const outcome = await updateSupplier(ctx, SUPPLIER_ID, { city: 'Lund' })
    expect(outcome).toMatchObject({ ok: false, code: 'SUPPLIER_NOT_FOUND' })
    expect(findCall('suppliers', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('writes the fields sent, the clearing and account number included (crm#1060)', async () => {
    enqueue({ data: STORED })
    enqueue({ data: { ...STORED, address_line1: 'Box 1', postal_code: '111 22', city: 'Stockholm', clearing_number: '8327', account_number: '1234567' } })

    const outcome = await updateSupplier(ctx, SUPPLIER_ID, {
      address_line1: 'Box 1',
      postal_code: '111 22',
      city: 'Stockholm',
      clearing_number: '8327',
      account_number: '1234567',
    })

    expect(outcome.ok).toBe(true)
    expect(findCall('suppliers', 'update')).toEqual([
      { address_line1: 'Box 1', postal_code: '111 22', city: 'Stockholm', clearing_number: '8327', account_number: '1234567' },
    ])
    expect(outcome.ok && !outcome.dryRun && outcome.data.city).toBe('Stockholm')
  })

  it('previews only the fields that change and flags new payment details', async () => {
    enqueue({ data: STORED })

    const outcome = await updateSupplier(
      ctx,
      SUPPLIER_ID,
      { name: 'Elnät AB', city: 'Lund', bankgiro: '765-4321' },
      { dryRun: true },
    )

    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview.changes).toEqual({
      city: { from: null, to: 'Lund' },
      bankgiro: { from: '123-4567', to: '765-4321' },
    })
    expect(outcome.preview.payment_details_changed).toBe(true)
    expect(outcome.preview.city).toBe('Lund')
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })

  it('does not flag payment details when only contact fields change', async () => {
    enqueue({ data: STORED })
    const outcome = await updateSupplier(ctx, SUPPLIER_ID, { phone: '08-123 45 67' }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun && outcome.preview.payment_details_changed).toBe(false)
  })

  describe('an archived supplier', () => {
    const archived = { ...STORED, archived_at: '2026-05-01T00:00:00Z' }

    it('refuses a change to an identifying field (BFL 7 kap 1 §)', async () => {
      enqueue({ data: archived })
      const outcome = await updateSupplier(ctx, SUPPLIER_ID, { name: 'Nytt namn AB', notes: 'x' })
      expect(outcome).toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'archived_at', archived_at: archived.archived_at, offending_fields: ['name'] },
      })
      expect(findCall('suppliers', 'update')).toBeUndefined()
    })

    it('takes a full form echo whose identifying fields are unchanged ("" equal to null)', async () => {
      enqueue({ data: archived })
      enqueue({ data: { ...archived, notes: 'Avslutad' } })
      const outcome = await updateSupplier(ctx, SUPPLIER_ID, {
        name: 'Elnät AB',
        address_line1: '',
        bankgiro: '123-4567',
        notes: 'Avslutad',
      })
      expect(outcome.ok).toBe(true)
    })

    it('un-archives with archived_at null and sets is_active back', async () => {
      enqueue({ data: archived })
      enqueue({ data: { ...archived, archived_at: null, name: 'Nytt namn AB' } })
      const outcome = await updateSupplier(ctx, SUPPLIER_ID, { archived_at: null, name: 'Nytt namn AB' })
      expect(outcome.ok).toBe(true)
      expect(findCalls('suppliers', 'update')[0]).toEqual([{ archived_at: null, name: 'Nytt namn AB', is_active: true }])
    })
  })

  it('carries a changed auto_debit to the supplier\'s unpaid invoices, and only then (crm#1463)', async () => {
    enqueue({ data: STORED })
    enqueue({ data: { ...STORED, auto_debit: true } })
    enqueue({ data: null })
    const outcome = await updateSupplier(ctx, SUPPLIER_ID, { auto_debit: true })
    expect(outcome).toMatchObject({ ok: true, data: { auto_debit: true } })
    expect(findCall('suppliers', 'update')).toEqual([{ auto_debit: true }])
    expect(findCall('supplier_invoices', 'update')).toEqual([{ auto_debit: true }])
    expect(findCalls('supplier_invoices', 'eq')).toEqual(
      expect.arrayContaining([['company_id', 'company-1'], ['supplier_id', SUPPLIER_ID], ['is_credit_note', false]]),
    )
    expect(findCall('supplier_invoices', 'in')).toEqual(['status', ['registered', 'approved', 'partially_paid', 'overdue']])

    // Unchanged (already false) or another field: the invoices are left alone.
    reset()
    enqueue({ data: STORED })
    enqueue({ data: STORED })
    expect((await updateSupplier(ctx, SUPPLIER_ID, { auto_debit: false, city: 'Lund' })).ok).toBe(true)
    expect(findCall('supplier_invoices', 'update')).toBeUndefined()
  })

  it('answers SUPPLIER_DUPLICATE_ORG_NUMBER when the org number belongs to another supplier', async () => {
    enqueue({ data: STORED })
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })
    const outcome = await updateSupplier(ctx, SUPPLIER_ID, { org_number: '5561111111' })
    expect(outcome).toMatchObject({ ok: false, code: 'SUPPLIER_DUPLICATE_ORG_NUMBER', details: { field: 'org_number' } })
  })
})

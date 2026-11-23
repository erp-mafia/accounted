/**
 * "Ångra kreditering" returns the original to the status its own facts give
 * (crm#2165). Whether it was attested is one of those facts, and approved_at
 * is the only mark of it (resolveUnsettledStatus): an invoice
 * that was never attested goes back to 'registered' and waits for attest,
 * whether or not its registration verifikat is posted. Reading the verifikat
 * as the attest let a credited and uncredited invoice skip attest.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createTableMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { restoredAfterUncredit, uncreditSupplierInvoice } from '@/lib/supplier-invoices/manage'

const NOW = new Date('2026-11-23T10:00:00Z')
const BOOKED = { total: 1000, due_date: '2026-12-31', registration_journal_entry_id: 'je-registration' }
const ATTESTED_AT = '2026-11-20T09:00:00Z'

describe('restoredAfterUncredit: nothing paid', () => {
  it('a booked invoice that was never attested returns to registered', () => {
    expect(restoredAfterUncredit({ ...BOOKED, approved_at: null }, [], NOW)).toEqual({
      status: 'registered',
      remaining_amount: 1000,
    })
  })

  it('an attested invoice returns to approved', () => {
    expect(restoredAfterUncredit({ ...BOOKED, approved_at: ATTESTED_AT }, [], NOW).status).toBe('approved')
  })

  it('an attested invoice the books do not have yet still returns to approved, as the overdue cron un-flips it', () => {
    const unbooked = { ...BOOKED, registration_journal_entry_id: null, approved_at: ATTESTED_AT }
    expect(restoredAfterUncredit(unbooked, [], NOW).status).toBe('approved')
  })

  it('past its due date it returns to overdue, attested or not', () => {
    const due = { ...BOOKED, due_date: '2026-11-01' }
    expect(restoredAfterUncredit({ ...due, approved_at: null }, [], NOW).status).toBe('overdue')
    expect(restoredAfterUncredit({ ...due, approved_at: ATTESTED_AT }, [], NOW).status).toBe('overdue')
  })
})

describe('restoredAfterUncredit: paid', () => {
  it('payments decide, never the attest', () => {
    const unattested = { ...BOOKED, approved_at: null }
    expect(restoredAfterUncredit(unattested, [{ amount: 400 }], NOW)).toEqual({
      status: 'partially_paid',
      remaining_amount: 600,
    })
    expect(restoredAfterUncredit(unattested, [{ amount: 1000 }], NOW)).toEqual({ status: 'paid', remaining_amount: 0 })
  })
})

describe('uncreditSupplierInvoice', () => {
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

  beforeEach(() => {
    eventBus.clear()
  })

  function credited(overrides: Parameters<typeof makeSupplierInvoice>[0] = {}) {
    return makeSupplierInvoice({
      id: 'inv-1',
      status: 'credited',
      total: 1000,
      remaining_amount: 0,
      due_date: '2099-12-31',
      registration_journal_entry_id: 'je-registration',
      approved_at: null,
      ...overrides,
      // The uncredit reads the payments embedded on the row.
      ...({ payments: [] } as object),
    })
  }

  // The credit note has no verifikat here, so no storno is posted: this is
  // about the status the original is written back with.
  function run(original: ReturnType<typeof credited>, dryRun = false) {
    const mock = createTableMockSupabase({
      supplier_invoices: [
        { data: original },
        { data: { id: 'credit-1', registration_journal_entry_id: null } },
        { data: null },
        { data: { ...original, status: 'restored-by-test', remaining_amount: 1000 } },
      ],
    })
    const outcome = uncreditSupplierInvoice(
      { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log },
      'inv-1',
      { dryRun },
    )
    return { mock, outcome }
  }

  it('writes a never attested invoice back as registered, so it waits for attest', async () => {
    const { mock, outcome } = run(credited())
    expect((await outcome).ok).toBe(true)
    const updates = mock.payloads('supplier_invoices', 'update')
    expect(updates[0]).toMatchObject({ status: 'reversed' })
    expect(updates[1]).toEqual({ status: 'registered', remaining_amount: 1000 })
  })

  it('writes an attested invoice back as approved', async () => {
    const { mock, outcome } = run(credited({ approved_at: ATTESTED_AT }))
    expect((await outcome).ok).toBe(true)
    expect(mock.payloads('supplier_invoices', 'update')[1]).toEqual({ status: 'approved', remaining_amount: 1000 })
  })

  it('previews the same status on a dry run', async () => {
    const { mock, outcome } = run(credited(), true)
    const result = await outcome
    expect(result.ok && result.dryRun && result.preview).toMatchObject({ restored_status: 'registered' })
    expect(mock.payloads('supplier_invoices', 'update')).toEqual([])
  })
})

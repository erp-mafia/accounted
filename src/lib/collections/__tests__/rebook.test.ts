import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMemorySupabase, type MemorySupabase } from './memory-supabase'
import { rebookCollectedPayment, type RebookDeps } from '../rebook'
import type { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import type { reverseEntry } from '@/lib/bookkeeping/engine'
import type { recordRecoveredLoss } from '@/lib/customer-loss/recovered'
import { TargetPeriodLockedError } from '@/lib/bookkeeping/errors'

const COMPANY = 'company-1'
const CASE = 'case-1'
const INVOICE = 'invoice-1'
const USER = 'user-1'
const NOW = new Date('2026-10-07T09:00:00.000Z')

type Settle = typeof settleInvoicePayment
type Reverse = typeof reverseEntry

let mem: MemorySupabase
let settle: ReturnType<typeof vi.fn<Settle>>
let reverse: ReturnType<typeof vi.fn<Reverse>>
let release: ReturnType<typeof vi.fn<(args: Record<string, unknown>) => unknown>>

function seed(overrides: Record<string, unknown> = {}, entryStatus = 'posted') {
  mem.seed('collection_connections', [
    { id: 'connection-1', company_id: COMPANY, route: 'fake', state: 'active', user_id: USER, consented_by: USER, clearing_account: '1689', payout_account: '1930', display_name: 'Acme Inkasso' },
  ])
  mem.seed('collection_cases', [{ id: CASE, company_id: COMPANY, invoice_id: INVOICE, connection_id: 'connection-1', opened_by: USER }])
  mem.seed('invoices', [{ id: INVOICE, company_id: COMPANY, currency: 'SEK', total: 1000, paid_amount: 1000, status: 'paid', invoice_number: '1042' }])
  mem.seed('company_settings', [{ company_id: COMPANY, accounting_method: 'accrual', entity_type: 'aktiebolag' }])
  mem.seed('journal_entries', [{ id: 'je-c1', company_id: COMPANY, status: entryStatus, reversed_by_id: entryStatus === 'reversed' ? 'je-storno' : null }])
  mem.seed('invoice_payments', [
    { id: 'ip-1', company_id: COMPANY, invoice_id: INVOICE, source: 'collections', external_ref: 'pay-1', journal_entry_id: 'je-c1' },
  ])
  mem.seed('collection_collected_payments', [
    {
      id: 'collected-1',
      company_id: COMPANY,
      case_id: CASE,
      invoice_id: INVOICE,
      provider_payment_ref: 'pay-1',
      paid_at: '2026-09-27',
      total: 1100,
      capital_paid: 1000,
      to_creditor_other: 0,
      to_agency: 100,
      status: 'booked',
      invoice_payment_id: 'ip-1',
      journal_entry_id: 'je-c1',
      payment_record_document_id: 'record-old',
      booked_at: '2026-09-28T10:00:00.000Z',
      booked_by: USER,
      review_reason: null,
      booking_lease_until: null,
      settlement_id: null,
      rebooked_entry_ids: [],
      ...overrides,
    },
  ])
}

function row() {
  return mem.rows('collection_collected_payments')[0]!
}

function deps(): RebookDeps {
  return {
    db: mem.client as SupabaseClient,
    companyId: COMPANY,
    now: () => NOW,
    settle: settle as unknown as Settle,
    reverse: reverse as unknown as Reverse,
    archiveRecord: vi.fn(async (input) => {
      mem.seed('document_attachments', [{ id: 'record-new', company_id: input.companyId, journal_entry_id: null }])
      return 'record-new'
    }),
  }
}

beforeEach(() => {
  mem = createMemorySupabase()
  settle = vi.fn<Settle>(async (_db, companyId, _userId, params) => {
    mem.seed('journal_entries', [{ id: 'je-c2', company_id: companyId, status: 'posted' }])
    mem.seed('invoice_payments', [
      { id: 'ip-2', company_id: companyId, invoice_id: params.invoice.id, source: 'collections', external_ref: params.externalRef, journal_entry_id: 'je-c2' },
    ])
    return { ok: true, newStatus: 'paid', newPaidAmount: 1000, newRemaining: 0, journalEntryId: 'je-c2', paidAt: params.paymentDate, saleJournalEntryId: null, warnings: [] }
  })
  // The storno: the voucher reversed, the payment row left for the release.
  reverse = vi.fn<Reverse>(async (_db, _companyId, _userId, entryId) => {
    const entry = mem.rows('journal_entries').find((e) => e.id === entryId)!
    entry.status = 'reversed'
    entry.reversed_by_id = 'je-storno'
    return { id: 'je-storno' } as Awaited<ReturnType<Reverse>>
  })
  // collections_rebook_release, as far as the service relies on it (the SQL is pinned in tests/pg/collections-rebook.pg.test.ts).
  release = vi.fn<(args: Record<string, unknown>) => unknown>((args) => {
    const r = mem.rows('collection_collected_payments').find((p) => p.id === args.p_collected_payment_id)!
    const payments = mem.rows('invoice_payments')
    payments.splice(payments.findIndex((p) => p.id === r.invoice_payment_id), 1)
    const reversed = r.journal_entry_id
    Object.assign(r, {
      status: 'pending',
      invoice_payment_id: null,
      journal_entry_id: null,
      payment_record_document_id: null,
      booked_by: null,
      booked_at: null,
      booking_lease_until: null,
      rebooked_entry_ids: [...(r.rebooked_entry_ids as string[]), reversed],
    })
    return { reversed_entry_id: reversed }
  })
  mem.rpcs.set('collections_rebook_release', release)
})

describe('rebookCollectedPayment', () => {
  it('stornos the C voucher under the lease, releases the payment and books it again with a new record', async () => {
    seed()
    let leaseDuringStorno: unknown = null
    reverse.mockImplementationOnce(async (_db, _companyId, userId, entryId, date, options) => {
      leaseDuringStorno = row().booking_lease_until
      expect([userId, entryId, date, options]).toEqual([USER, 'je-c1', undefined, { collectionsRebook: true }])
      const entry = mem.rows('journal_entries').find((e) => e.id === entryId)!
      Object.assign(entry, { status: 'reversed', reversed_by_id: 'je-storno' })
      return { id: 'je-storno' } as Awaited<ReturnType<Reverse>>
    })
    const result = await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })
    expect(result).toMatchObject({
      ok: true,
      reversedEntryId: 'je-c1',
      stornoEntryId: 'je-storno',
      booking: { ok: true, journalEntryId: 'je-c2', invoicePaymentId: 'ip-2', alreadyBooked: false },
    })
    expect(leaseDuringStorno).toBe(new Date(NOW.getTime() + 2 * 60_000).toISOString())
    expect(release).toHaveBeenCalledWith({ p_company_id: COMPANY, p_collected_payment_id: 'collected-1' })
    expect(row()).toMatchObject({
      status: 'booked',
      journal_entry_id: 'je-c2',
      invoice_payment_id: 'ip-2',
      payment_record_document_id: 'record-new',
      rebooked_entry_ids: ['je-c1'],
      booking_lease_until: null,
    })
    // The new record sits on the new voucher; the old one stays with the reversed voucher.
    expect(mem.rows('document_attachments')).toEqual([expect.objectContaining({ id: 'record-new', journal_entry_id: 'je-c2' })])
  })

  it('names the voucher it replaces and its storno on the new payment record', async () => {
    seed()
    Object.assign(mem.rows('journal_entries')[0]!, { voucher_series: 'C', voucher_number: 12 })
    reverse.mockImplementationOnce(async (_db, _companyId, _userId, entryId) => {
      Object.assign(mem.rows('journal_entries').find((e) => e.id === entryId)!, { status: 'reversed', reversed_by_id: 'je-storno' })
      mem.seed('journal_entries', [{ id: 'je-storno', company_id: COMPANY, status: 'posted', voucher_series: 'C', voucher_number: 13 }])
      return { id: 'je-storno' } as Awaited<ReturnType<Reverse>>
    })
    const d = deps()
    await rebookCollectedPayment(d, 'collected-1', { userId: USER })
    expect(d.archiveRecord).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.archiveRecord!).mock.calls[0]![0].model).toMatchObject({ replaces: 'C12, stornerad genom C13' })
  })

  it('goes on from a voucher already reversed (a rebook that died after the storno)', async () => {
    seed({}, 'reversed')
    const result = await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })
    expect(reverse).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, reversedEntryId: 'je-c1', stornoEntryId: 'je-storno', booking: { ok: true } })
  })

  it('books a payment already released (a rebook that died after the release)', async () => {
    seed({ status: 'pending', invoice_payment_id: null, journal_entry_id: null, booked_at: null, payment_record_document_id: null, rebooked_entry_ids: ['je-c1'] })
    mem.rows('invoice_payments').length = 0
    const result = await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })
    expect(reverse).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, reversedEntryId: 'je-c1', stornoEntryId: null, booking: { ok: true, journalEntryId: 'je-c2' } })
  })

  it('answers needs_review when the new booking is refused, with the payment released', async () => {
    seed()
    settle.mockResolvedValueOnce({ ok: false, code: 'INVOICE_PAID_NO_FISCAL_PERIOD', details: {} })
    const result = await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })
    expect(result).toMatchObject({ ok: true, booking: { ok: false, outcome: 'needs_review', reason: 'INVOICE_PAID_NO_FISCAL_PERIOD' } })
    expect(row()).toMatchObject({ status: 'needs_review', journal_entry_id: null, rebooked_entry_ids: ['je-c1'] })
  })

  it('changes nothing when the books refuse the storno, and hands the error on', async () => {
    seed()
    reverse.mockRejectedValueOnce(new TargetPeriodLockedError('2026-09-27', null))
    await expect(rebookCollectedPayment(deps(), 'collected-1', { userId: USER })).rejects.toBeInstanceOf(TargetPeriodLockedError)
    expect(release).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(row()).toMatchObject({ status: 'booked', journal_entry_id: 'je-c1', booking_lease_until: null })
  })

  it('keeps the voucher reversed and the lease free when the release fails, so the next click finishes it', async () => {
    seed()
    mem.rpcs.delete('collections_rebook_release')
    await expect(rebookCollectedPayment(deps(), 'collected-1', { userId: USER })).rejects.toThrow('collections_rebook_release failed')
    expect(row()).toMatchObject({ status: 'booked', booking_lease_until: null })
    mem.rpcs.set('collections_rebook_release', release)
    expect(await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })).toMatchObject({ ok: true, booking: { ok: true } })
    expect(reverse).toHaveBeenCalledTimes(1)
  })

  it('refuses outside its case: not found, not booked, paid out by a booked payout, busy, a voucher not posted', async () => {
    seed({ settlement_id: 'settlement-1' })
    expect(await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })).toEqual({ ok: false, outcome: 'settled' })
    expect(await rebookCollectedPayment(deps(), 'collected-other', { userId: USER })).toEqual({ ok: false, outcome: 'not_found' })
    row().settlement_id = null
    row().booking_lease_until = new Date(NOW.getTime() + 60_000).toISOString()
    expect(await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })).toEqual({ ok: false, outcome: 'busy' })
    row().booking_lease_until = null
    mem.rows('journal_entries')[0]!.status = 'cancelled'
    expect(await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })).toEqual({ ok: false, outcome: 'voucher_not_posted' })
    expect(row().booking_lease_until).toBeNull()
    Object.assign(row(), { status: 'pending', journal_entry_id: null, invoice_payment_id: null, booked_at: null })
    expect(await rebookCollectedPayment(deps(), 'collected-1', { userId: USER })).toEqual({ ok: false, outcome: 'not_booked' })
    expect(reverse).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })
})

describe('rebookCollectedPayment: a payment booked as a recovered loss', () => {
  type RecoverLoss = typeof recordRecoveredLoss

  /** A written-off invoice whose collected payment was booked as återvunnen kundförlust on je-r1. */
  function seedRecovery(overrides: Record<string, unknown> = {}) {
    seed({ invoice_payment_id: null, write_off_id: 'wo-1', journal_entry_id: 'je-r1', ...overrides })
    mem.rows('invoices')[0]!.status = 'written_off'
    mem.rows('invoice_payments').splice(0)
    mem.rows('journal_entries')[0]!.id = 'je-r1'
  }

  function recoveryDeps(recoverLoss: RecoverLoss): RebookDeps {
    return { ...deps(), recoverLoss }
  }

  it('stornos the recovery voucher under the lease, puts the payment back to pending without the release RPC, and recovers again', async () => {
    seedRecovery()
    const recoverLoss = vi.fn<RecoverLoss>(async (_db, companyId) => {
      mem.seed('journal_entries', [{ id: 'je-r2', company_id: companyId, status: 'posted' }])
      return { ok: true, writeOffId: 'wo-2', journalEntryId: 'je-r2', invoiceStatus: 'written_off', amount: 1000 }
    })
    reverse.mockImplementationOnce(async (_db, _companyId, _userId, entryId, _date, options) => {
      expect([entryId, options]).toEqual(['je-r1', { collectionsRebook: true }])
      Object.assign(mem.rows('journal_entries').find((e) => e.id === entryId)!, { status: 'reversed', reversed_by_id: 'je-storno' })
      mem.seed('journal_entries', [{ id: 'je-storno', company_id: COMPANY, status: 'posted' }])
      return { id: 'je-storno' } as Awaited<ReturnType<Reverse>>
    })
    const result = await rebookCollectedPayment(recoveryDeps(recoverLoss as unknown as RecoverLoss), 'collected-1', { userId: USER })
    expect(result).toMatchObject({
      ok: true,
      reversedEntryId: 'je-r1',
      stornoEntryId: 'je-storno',
      booking: { ok: true, journalEntryId: 'je-r2', invoicePaymentId: null, writeOffId: 'wo-2', alreadyBooked: false },
    })
    expect(release).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(recoverLoss).toHaveBeenCalledWith(expect.anything(), COMPANY, USER, expect.objectContaining({ fromCollectedPayment: true, evidenceDocumentId: 'record-new' }))
    expect(row()).toMatchObject({
      status: 'booked',
      write_off_id: 'wo-2',
      invoice_payment_id: null,
      journal_entry_id: 'je-r2',
      payment_record_document_id: 'record-new',
      rebooked_entry_ids: ['je-r1'],
      booking_lease_until: null,
    })
  })

  it('releases nothing when the storno of the recovery is not posted', async () => {
    seedRecovery()
    mem.rows('journal_entries')[0]!.status = 'reversed'
    mem.rows('journal_entries')[0]!.reversed_by_id = 'je-storno'
    mem.seed('journal_entries', [{ id: 'je-storno', company_id: COMPANY, status: 'draft' }])
    const recoverLoss = vi.fn<RecoverLoss>()
    await expect(
      rebookCollectedPayment(recoveryDeps(recoverLoss as unknown as RecoverLoss), 'collected-1', { userId: USER }),
    ).rejects.toThrow(/posted storno/)
    expect(row()).toMatchObject({ status: 'booked', write_off_id: 'wo-1', journal_entry_id: 'je-r1', booking_lease_until: null })
    expect(recoverLoss).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from '@/lib/pos-sales/__tests__/fake-db'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ClearingBankRow } from '@/lib/transactions/clearing-proposals'
import { payoutLines } from '../payouts'

const service = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
  createServiceClient: () => service.current,
}))
const uploadDocument = vi.hoisted(() => vi.fn())
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: (...args: unknown[]) => uploadDocument(...args) }))

import { pairRowsWithPayouts, rowFitsPayout, webshopPayoutProposer } from '../payout-proposals'

const COMPANY = 'company-1'
const PAYOUT_ID = '00000000-0000-4000-8000-00000000aa01'

function payout(over: Record<string, unknown> = {}) {
  return {
    id: PAYOUT_ID,
    company_id: COMPANY,
    platform: 'kustom',
    store_scope: 'M100',
    external_id: 'kustom_M100_payout_PAY123',
    reference: 'PAY123',
    payout_date: '2026-11-19',
    currency: 'SEK',
    amount: 934.37,
    lines: payoutLines([['sale', 1250], ['return', 300], ['fee', 12.5], ['fee_vat', 3.13]]),
    transaction_id: null,
    journal_entry_id: null,
    ...over,
  }
}

function bankRow(over: Partial<ClearingBankRow> = {}): ClearingBankRow {
  return { id: 'tx-1', date: '2026-11-20', amount: 934.37, currency: 'SEK', text: 'KUSTOM AB', merchant_name: null, transaction_method: null, ...over }
}

const noBank = { open: vi.fn(), cleared: vi.fn() }

describe('rowFitsPayout', () => {
  it('fits the same SEK amount from a day before to five days after the payout day', () => {
    const p = { amount: 934.37, currency: 'SEK', payout_date: '2026-11-19' }
    expect(rowFitsPayout({ amount: 934.37, currency: 'SEK', date: '2026-11-18' }, p)).toBe(true)
    expect(rowFitsPayout({ amount: 934.37, currency: null, date: '2026-11-24' }, p)).toBe(true)
    expect(rowFitsPayout({ amount: 934.37, currency: 'SEK', date: '2026-11-25' }, p)).toBe(false)
    expect(rowFitsPayout({ amount: 934.37, currency: 'SEK', date: '2026-11-17' }, p)).toBe(false)
    expect(rowFitsPayout({ amount: 934.36, currency: 'SEK', date: '2026-11-19' }, p)).toBe(false)
    expect(rowFitsPayout({ amount: 934.37, currency: 'EUR', date: '2026-11-19' }, p)).toBe(false)
  })
})

describe('pairRowsWithPayouts', () => {
  const p = (id: string, date: string) => ({ id, amount: 100, currency: 'SEK', payout_date: date })
  const r = (id: string, date: string) => ({ id, amount: 100, currency: 'SEK', date })

  it('pairs each row with its nearest payout, one to one', () => {
    const pairs = pairRowsWithPayouts([r('a', '2026-11-20'), r('b', '2026-11-27')], [p('p1', '2026-11-19'), p('p2', '2026-11-26')])
    expect([...pairs.entries()].map(([row, payout]) => [row, payout.id])).toEqual([
      ['a', 'p1'],
      ['b', 'p2'],
    ])
  })

  it('leaves alone a row two payouts fit equally, and a payout two rows fit equally', () => {
    expect(pairRowsWithPayouts([r('a', '2026-11-20')], [p('p1', '2026-11-19'), p('p2', '2026-11-21')]).size).toBe(0)
    expect(pairRowsWithPayouts([r('a', '2026-11-20'), r('b', '2026-11-20')], [p('p1', '2026-11-19')]).size).toBe(0)
  })

  it('gives a payout to the nearer of two rows', () => {
    const pairs = pairRowsWithPayouts([r('a', '2026-11-20'), r('b', '2026-11-23')], [p('p1', '2026-11-19')])
    expect([...pairs.keys()]).toEqual(['a'])
  })
})

describe('webshopPayoutProposer.propose', () => {
  it('proposes the payout\'s verifikat on its bank row, never booked without a review', async () => {
    const db = createFakeDb({
      webshop_payouts: [payout()],
      webshop_store_settings: [],
      company_settings: [{ company_id: COMPANY, vat_registered: true }],
    })
    const out = await webshopPayoutProposer.propose(db.client as never, COMPANY, [bankRow()], noBank)
    const proposal = out.get('tx-1')
    expect(proposal).toBeDefined()
    expect(proposal).toMatchObject({
      template_id: `clearing:webshop-payout:${PAYOUT_ID}`,
      source: 'clearing',
      requires_review: true,
      booking: { kind: 'account', account: '1686', clearing_ref: { proposer: 'webshop-payouts', ref: PAYOUT_ID } },
      clearing: {
        channel: 'webshop',
        provider: 'Kustom',
        reference: 'PAY123',
        account: '1686',
        expected_amount: 934.37,
        fees: 12.5,
        fee_vat: 3.13,
        clearing_amount: 950,
      },
    })
    expect(proposal!.description_sv).toContain('Utbetalning från Kustom PAY123 2026-11-19')
  })

  it('books against the store\'s own clearing account for the payment method', async () => {
    const db = createFakeDb({
      webshop_payouts: [payout()],
      webshop_store_settings: [{ company_id: COMPANY, platform: 'kustom', store_scope: 'M100', payment_method_account_map: { kustom: { mode: 'book', account: '1687' } } }],
      company_settings: [{ company_id: COMPANY, vat_registered: true }],
    })
    const out = await webshopPayoutProposer.propose(db.client as never, COMPANY, [bankRow()], noBank)
    expect(out.get('tx-1')?.booking).toMatchObject({ account: '1687' })
  })

  it('proposes nothing for a booked payout, one another row claimed, or a cash ledger', async () => {
    const booked = createFakeDb({ webshop_payouts: [payout({ journal_entry_id: 'je-1' })], company_settings: [] })
    expect((await webshopPayoutProposer.propose(booked.client as never, COMPANY, [bankRow()], noBank)).size).toBe(0)
    const claimed = createFakeDb({ webshop_payouts: [payout({ transaction_id: 'tx-other' })], company_settings: [] })
    expect((await webshopPayoutProposer.propose(claimed.client as never, COMPANY, [bankRow()], noBank)).size).toBe(0)
    const cash = createFakeDb({
      webshop_payouts: [payout()],
      webshop_store_settings: [{ company_id: COMPANY, platform: 'kustom', store_scope: 'M100', payment_method_account_map: { kustom: { mode: 'book', account: '1930' } } }],
      company_settings: [],
    })
    expect((await webshopPayoutProposer.propose(cash.client as never, COMPANY, [bankRow()], noBank)).size).toBe(0)
  })

  it('reads only the payouts for a company that has none', async () => {
    const db = createFakeDb({ webshop_payouts: [] })
    const from = vi.spyOn(db.client, 'from')
    expect((await webshopPayoutProposer.propose(db.client as never, COMPANY, [bankRow()], noBank)).size).toBe(0)
    expect(from.mock.calls.map(([t]) => t)).toEqual(['webshop_payouts'])
  })
})

describe('webshopPayoutProposer.booking', () => {
  const booking = webshopPayoutProposer.booking!

  it('states the lines beside the bank leg for the row it fits', async () => {
    const db = createFakeDb({ webshop_payouts: [payout()], webshop_store_settings: [] })
    const outcome = await booking.lines(db.client as never, COMPANY, { id: 'tx-1', date: '2026-11-20', amount: 934.37, currency: 'SEK' }, PAYOUT_ID, { vatRegistered: true })
    expect(outcome).toEqual({
      ok: true,
      description: 'Utbetalning Kustom PAY123 2026-11-19',
      lines: [
        { account_number: '6570', debit_amount: 12.5, credit_amount: 0, description: 'Avgifter Kustom' },
        { account_number: '2641', debit_amount: 3.13, credit_amount: 0, description: 'Moms på avgifter Kustom' },
        { account_number: '1686', debit_amount: 0, credit_amount: 950, description: 'Utbetalning Kustom PAY123 2026-11-19' },
      ],
    })
  })

  it('refuses an unknown payout, a taken one, and a row that does not fit it', async () => {
    const row = { id: 'tx-1', date: '2026-11-20', amount: 934.37, currency: 'SEK' }
    const empty = createFakeDb({ webshop_payouts: [] })
    expect(await booking.lines(empty.client as never, COMPANY, row, PAYOUT_ID, { vatRegistered: true })).toMatchObject({ ok: false, code: 'WEBSHOP_PAYOUT_NOT_FOUND' })
    const taken = createFakeDb({ webshop_payouts: [payout({ journal_entry_id: 'je-1' })] })
    expect(await booking.lines(taken.client as never, COMPANY, row, PAYOUT_ID, { vatRegistered: true })).toMatchObject({ ok: false, code: 'CLEARING_RECORD_TAKEN' })
    const other = createFakeDb({ webshop_payouts: [payout({ transaction_id: 'tx-other' })] })
    expect(await booking.lines(other.client as never, COMPANY, row, PAYOUT_ID, { vatRegistered: true })).toMatchObject({ ok: false, code: 'CLEARING_RECORD_TAKEN' })
    const db = createFakeDb({ webshop_payouts: [payout()] })
    expect(await booking.lines(db.client as never, COMPANY, { ...row, amount: 900 }, PAYOUT_ID, { vatRegistered: true })).toMatchObject({ ok: false, code: 'WEBSHOP_PAYOUT_ROW_MISMATCH' })
  })

  describe('claim, release and settle', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('claims an open payout for the row, as the service role, scoped to the company', async () => {
      const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
      service.current = supabase
      enqueue({ data: [{ id: PAYOUT_ID }] })
      expect(await booking.claim({} as never, COMPANY, PAYOUT_ID, 'tx-1')).toBe(true)
      expect(findCall('webshop_payouts', 'update')).toEqual([{ transaction_id: 'tx-1' }])
      expect(findCalls('webshop_payouts', 'eq')).toEqual([
        ['company_id', COMPANY],
        ['id', PAYOUT_ID],
      ])
      expect(findCalls('webshop_payouts', 'is')).toEqual([['journal_entry_id', null]])
      expect(findCall('webshop_payouts', 'or')).toEqual(['transaction_id.is.null,transaction_id.eq.tx-1'])

      enqueue({ data: [] })
      expect(await booking.claim({} as never, COMPANY, PAYOUT_ID, 'tx-2')).toBe(false)
    })

    it('releases only its own claim on a payout not yet booked', async () => {
      const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
      service.current = supabase
      enqueue({ data: null })
      await booking.release({} as never, COMPANY, PAYOUT_ID, 'tx-1')
      expect(findCall('webshop_payouts', 'update')).toEqual([{ transaction_id: null }])
      expect(findCalls('webshop_payouts', 'eq')).toContainEqual(['transaction_id', 'tx-1'])
      expect(findCalls('webshop_payouts', 'is')).toEqual([['journal_entry_id', null]])
    })

    it('settles the claimed payout on its verifikat and files the specification there', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      service.current = supabase
      enqueue({ data: [payout({ transaction_id: 'tx-1', journal_entry_id: 'je-1' })] })
      const user = createQueuedMockSupabase()
      user.enqueue({ data: { company_name: 'Testbolaget AB', org_number: '556677-8899' } })
      user.enqueue({
        data: [
          { account_number: '1930', debit_amount: 934.37, credit_amount: 0 },
          { account_number: '6570', debit_amount: 12.5, credit_amount: 0 },
          { account_number: '2641', debit_amount: 3.13, credit_amount: 0 },
          { account_number: '1686', debit_amount: 0, credit_amount: 950 },
        ],
      })
      uploadDocument.mockResolvedValue({ id: 'doc-1' })
      await booking.settle(user.supabase as never, COMPANY, 'user-1', PAYOUT_ID, 'tx-1', 'je-1')
      expect(findCall('webshop_payouts', 'update')).toEqual([{ journal_entry_id: 'je-1' }])
      expect(uploadDocument).toHaveBeenCalledTimes(1)
      const [, userId, companyId, file, meta] = uploadDocument.mock.calls[0] as [unknown, string, string, { name: string }, Record<string, unknown>]
      expect([userId, companyId, file.name]).toEqual(['user-1', COMPANY, 'Utbetalning_Kustom_2026-11-19.pdf'])
      expect(meta).toMatchObject({ upload_source: 'system', journal_entry_id: 'je-1', idempotency_key: `webshop-payout:${PAYOUT_ID}` })
    })

    it('never throws: a payout that did not settle is logged and the verifikat stands', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      service.current = supabase
      enqueue({ data: [] })
      await expect(booking.settle({} as never, COMPANY, 'user-1', PAYOUT_ID, 'tx-1', 'je-1')).resolves.toBeUndefined()
      expect(uploadDocument).not.toHaveBeenCalled()
    })
  })
})

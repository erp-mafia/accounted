import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeTransaction } from '@/tests/helpers'
import { accountProposal, type BookingProposal } from '@/lib/bookkeeping/proposal'
import {
  clearingBankRows,
  clearingCandidate,
  proposeClearings,
  type ClearingBankRow,
  type ClearingProposer,
} from '../clearing-proposals'

/**
 * The bank side of the clearing proposals: which rows may be offered one,
 * what a proposer is asked and sees, own-account transfers, a failing
 * proposer, and the open and cleared rows it may ask for.
 */

const COMPANY = 'company-1'

const incoming = (over: Parameters<typeof makeTransaction>[0] = {}) =>
  makeTransaction({ amount: 145.5, date: '2026-10-06', description: 'REF 1834', original_description: 'REF 1834', merchant_name: null, ...over })

const clearing = (id: string): BookingProposal =>
  ({
    ...accountProposal({ id: 'clearing:pos:swish', source: 'clearing', account: '1686', label: 'Swish från kassan', category: 'income_other', vat_treatment: 'exempt', amount: 145.5 }),
    requires_review: true,
    description_sv: id,
  })

function proposer(answer: (ids: string[]) => string[]) {
  const propose = vi.fn(
    async (_s: SupabaseClient, _c: string, asked: readonly ClearingBankRow[]) =>
      new Map(answer(asked.map((r) => r.id)).map((id) => [id, clearing(id)])),
  )
  const p: ClearingProposer = { id: 'test', module: 'pos', propose }
  return Object.assign(p, { propose })
}

/** The table mock as the client type the bank side takes. */
const tables = (initial: Parameters<typeof createTableMockSupabase>[0] = {}) => {
  const mock = createTableMockSupabase(initial)
  return { ...mock, supabase: mock.supabase as unknown as SupabaseClient }
}

describe('clearingCandidate', () => {
  it('takes open incoming rows only, without a stronger match', () => {
    expect(clearingCandidate(incoming())).toBe(true)
    expect(clearingCandidate(incoming({ amount: -145.5 }))).toBe(false)
    expect(clearingCandidate(incoming({ journal_entry_id: 'je-1' }))).toBe(false)
    expect(clearingCandidate(incoming({ is_ignored: true }))).toBe(false)
    expect(clearingCandidate(incoming({ is_business: false }))).toBe(false)
    expect(clearingCandidate(incoming({ potential_invoice_id: 'inv-1' }))).toBe(false)
    expect(clearingCandidate(incoming({ invoice_id: 'inv-1' }))).toBe(false)
    expect(clearingCandidate(incoming({ potential_supplier_invoice_id: 'si-1' }))).toBe(false)
    expect(clearingCandidate(incoming({ potential_rot_rut_payout_request_id: 'rr-1' }))).toBe(false)
    expect(clearingCandidate(incoming({ potential_journal_entry_id: 'je-2' }))).toBe(false)
  })
})

describe('proposeClearings', () => {
  it('asks the proposers about the candidates only, and never when there is none', async () => {
    const { supabase } = tables()
    const p = proposer((ids) => ids)
    const open = incoming({ id: 'tx-open' })
    const out = await proposeClearings(supabase, COMPANY, [open, incoming({ id: 'tx-paid', journal_entry_id: 'je-1' })], [p])
    expect([...out.keys()]).toEqual(['tx-open'])
    expect(p.propose.mock.calls[0][2]).toEqual([
      { id: 'tx-open', date: '2026-10-06', amount: 145.5, currency: 'SEK', text: 'REF 1834', merchant_name: null, transaction_method: null },
    ])

    const none = proposer((ids) => ids)
    expect((await proposeClearings(supabase, COMPANY, [incoming({ amount: -10 })], [none])).size).toBe(0)
    expect(none.propose).not.toHaveBeenCalled()
  })

  it('drops a row that is a transfer from one of the company\'s own accounts', async () => {
    const { supabase, findCalls } = tables({ cash_accounts: { data: [{ iban: 'SE45 5000 0000 0583 9825 7466' }] } })
    const own = incoming({ id: 'tx-own', counterparty_iban: 'se4550000000058398257466' })
    const other = incoming({ id: 'tx-other', counterparty_iban: 'SE3550000000054910000003' })
    const out = await proposeClearings(supabase, COMPANY, [own, other], [proposer((ids) => ids)])
    expect([...out.keys()]).toEqual(['tx-other'])
    expect(findCalls('cash_accounts', 'select')).toHaveLength(1)
  })

  it('reads no cash accounts when nothing was proposed', async () => {
    const { supabase, findCalls } = tables()
    await proposeClearings(supabase, COMPANY, [incoming({ counterparty_iban: 'SE3550000000054910000003' })], [proposer(() => [])])
    expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
  })

  it('logs a failing proposer and goes on with the next', async () => {
    const { supabase } = tables()
    const broken: ClearingProposer = { id: 'broken', module: 'pos', propose: vi.fn(async () => { throw new Error('boom') }) }
    const log = { warn: vi.fn() }
    const out = await proposeClearings(supabase, COMPANY, [incoming({ id: 'tx-1' })], [broken, proposer((ids) => ids)], log)
    expect([...out.keys()]).toEqual(['tx-1'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.objectContaining({ proposer: 'broken' }))
  })
})

describe('clearingBankRows', () => {
  it('open: the candidates in the window, without own-account transfers', async () => {
    const rows = [
      incoming({ id: 'tx-a' }),
      incoming({ id: 'tx-matched', potential_invoice_id: 'inv-1' }),
      incoming({ id: 'tx-own', counterparty_iban: 'SE4550000000058398257466' }),
    ]
    const { supabase, findCall } = tables({
      unbooked_bank_rows: { data: rows },
      cash_accounts: { data: [{ iban: 'SE4550000000058398257466' }] },
    })
    const open = await clearingBankRows(supabase, COMPANY).open('2026-09-15', '2026-10-11')
    expect(open.map((r) => r.id)).toEqual(['tx-a'])
    expect(findCall('unbooked_bank_rows', 'eq')).toEqual(['company_id', COMPANY])
    expect(findCall('unbooked_bank_rows', 'gt')).toEqual(['amount', 0])
  })

  it('cleared: the incoming rows of verifikat crediting the account, by pointer and by bank-line link, in the window', async () => {
    const entry = (id: string, debit: number, credit: number) => ({
      id,
      lines: [{ id: `${id}-l`, account_number: '1686', debit_amount: debit, credit_amount: credit }],
    })
    const { supabase, findCall, findCalls } = tables({
      'rpc:get_entries_with_account_lines': { data: [entry('je-1', 0, 145.5), entry('je-2', 0, 300), entry('je-day', 10_000, 0)] },
      transactions: [
        { data: [incoming({ id: 'tx-pointer', journal_entry_id: 'je-1' })] },
        { data: [incoming({ id: 'tx-linked', date: '2026-10-07', amount: 300 }), incoming({ id: 'tx-out-of-window', date: '2026-12-01' })] },
      ],
      transaction_voucher_links: { data: [{ id: 'link-1', transaction_id: 'tx-linked' }, { id: 'link-2', transaction_id: 'tx-out-of-window' }] },
    })
    const cleared = await clearingBankRows(supabase, COMPANY).cleared(['1686'], '2026-09-15', '2026-10-11')
    expect(cleared.map((r) => r.id)).toEqual(['tx-linked', 'tx-pointer'])
    // A samlingsverifikat may be dated up to a month after its rows.
    expect(findCall('rpc:get_entries_with_account_lines', 'rpc')?.[0]).toMatchObject({
      p_company_id: COMPANY,
      p_start: '2026-09-15',
      p_end: '2026-11-11',
      p_accounts: ['1686'],
      p_statuses: ['posted'],
    })
    expect(findCalls('transactions', 'in')[0]).toEqual(['journal_entry_id', ['je-1', 'je-2']])
    expect(findCalls('transaction_voucher_links', 'eq')).toContainEqual(['role', 'bank_line'])
  })

  it('cleared: reads the lines the paged way while the database lacks the ledger RPC', async () => {
    const { supabase, findCalls } = tables({
      'rpc:get_entries_with_account_lines': { data: null, error: { code: 'PGRST202', message: 'not found' } },
      journal_entries: { data: [{ id: 'je-1' }] },
      journal_entry_lines: { data: [{ id: 'l-1', journal_entry_id: 'je-1', credit_amount: 145.5 }] },
      transactions: { data: [incoming({ id: 'tx-pointer', journal_entry_id: 'je-1' })] },
      transaction_voucher_links: { data: [] },
    })
    const cleared = await clearingBankRows(supabase, COMPANY).cleared(['1686'], '2026-09-15', '2026-10-11')
    expect(cleared.map((r) => r.id)).toEqual(['tx-pointer'])
    expect(findCalls('journal_entry_lines', 'in')).toContainEqual(['account_number', ['1686']])
  })

  it('cleared: nothing to read without accounts', async () => {
    const { supabase, findCalls } = tables()
    expect(await clearingBankRows(supabase, COMPANY).cleared([], '2026-09-15', '2026-10-11')).toEqual([])
    expect(findCalls('journal_entries', 'select')).toHaveLength(0)
  })
})

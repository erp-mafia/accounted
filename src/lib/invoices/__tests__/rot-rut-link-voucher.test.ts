import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  linkRotRutPayoutVoucher,
  listRotRutPayoutVoucherCandidates,
  twoStepPayoutShape,
} from '../rot-rut-link-voucher'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as never

beforeEach(() => reset())

describe('linkRotRutPayoutVoucher', () => {
  it('returns the RPC result on success', async () => {
    enqueue({ data: { ok: true, dry_run: false, already_linked: false, journal_entry_id: 'je-1', rounding: 0.25 } })
    const outcome = await linkRotRutPayoutVoucher(client, 'company-1', { requestIds: ['r-1'], journalEntryId: 'je-1' })
    expect(outcome).toMatchObject({ ok: true, result: { rounding: 0.25 } })
  })

  it('maps an RPC refusal to its code', async () => {
    enqueue({ data: { ok: false, code: 'ROT_RUT_LINK_VOUCHER_IN_USE' } })
    const outcome = await linkRotRutPayoutVoucher(client, 'company-1', { requestIds: ['r-1'], journalEntryId: 'je-1' })
    expect(outcome).toEqual({ ok: false, kind: 'code', code: 'ROT_RUT_LINK_VOUCHER_IN_USE', details: undefined })
  })

  it('passes a database error through', async () => {
    const error = { message: 'boom' }
    enqueue({ error })
    const outcome = await linkRotRutPayoutVoucher(client, 'company-1', { requestIds: ['r-1'], journalEntryId: 'je-1' })
    expect(outcome).toEqual({ ok: false, kind: 'error', error })
  })
})

describe('listRotRutPayoutVoucherCandidates', () => {
  // The read goes entry first (lib/bookkeeping/entry-lines.ts): the
  // company's verifikat, then their lines by journal_entry_id. The old
  // journal_entries!inner embed was planned from the line side and timed out.
  const entryIds = (...ids: string[]) => ({ data: ids.map((id) => ({ id })) })
  const line = (id: string, entry: string, account: string, debit: number, credit: number) => ({
    id,
    journal_entry_id: entry,
    account_number: account,
    debit_amount: String(debit),
    credit_amount: String(credit),
  })

  it('nets the 1513 and bank sides and drops used, storno and non-crediting vouchers', async () => {
    enqueue(entryIds('je-1', 'je-2', 'je-3', 'je-4', 'je-5'))
    enqueue({
      data: [
        line('l-1', 'je-1', '1513', 0, 671.25),
        line('l-2', 'je-2', '1513', 0, 100),
        line('l-3', 'je-3', '1513', 0, 100),
        line('l-4', 'je-4', '1513', 0, 50),
      ],
    })
    enqueue({
      data: [
        {
          id: 'je-1',
          entry_date: '2026-09-01',
          voucher_series: 'A',
          voucher_number: 177,
          description: 'RUT utbetalning',
          source_type: 'manual',
          lines: [
            { account_number: '1930', debit_amount: '671.00', credit_amount: '0' },
            { account_number: '3740', debit_amount: '0.25', credit_amount: '0' },
            { account_number: '1513', debit_amount: '0', credit_amount: '671.25' },
          ],
        },
        {
          id: 'je-2',
          entry_date: '2026-09-02',
          voucher_series: 'A',
          voucher_number: 180,
          description: null,
          source_type: 'storno',
          lines: [{ account_number: '1513', debit_amount: '0', credit_amount: '100' }],
        },
        {
          id: 'je-3',
          entry_date: '2026-09-03',
          voucher_series: 'A',
          voucher_number: 181,
          description: null,
          source_type: 'manual',
          lines: [{ account_number: '1513', debit_amount: '0', credit_amount: '100' }],
        },
        {
          id: 'je-4',
          entry_date: '2026-09-04',
          voucher_series: 'A',
          voucher_number: 182,
          description: null,
          source_type: 'manual',
          lines: [
            { account_number: '1513', debit_amount: '50', credit_amount: '0' },
            { account_number: '1513', debit_amount: '0', credit_amount: '50' },
          ],
        },
      ],
    })
    enqueue({ data: [{ settlement_journal_entry_id: 'je-3' }] })

    const { data, error } = await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25')

    expect(error).toBeNull()
    expect(data).toEqual([
      {
        journal_entry_id: 'je-1',
        entry_date: '2026-09-01',
        voucher_series: 'A',
        voucher_number: 177,
        description: 'RUT utbetalning',
        bank_amount: 671,
        receivable_credit: 671.25,
        share_credit: 0,
      },
    ])
    // Only the verifikat with a 1513 credit are read in full (je-5 has none).
    expect(findCalls('journal_entries', 'in')).toEqual([['id', ['je-1', 'je-2', 'je-3', 'je-4']]])
  })

  it('reads the company\'s verifikat first and their lines by id, never lines filtered through a journal_entries embed', async () => {
    enqueue(entryIds('je-1'))
    enqueue({ data: [] })
    const { data } = await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25')
    expect(data).toEqual([])
    expect(findCalls('journal_entries', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['status', 'posted'],
      ]),
    )
    expect(findCalls('journal_entries', 'is')).toContainEqual(['reversed_by_id', null])
    expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2026-08-25'])
    expect(findCalls('journal_entry_lines', 'in')).toContainEqual(['journal_entry_id', ['je-1']])
    for (const [select] of findCalls('journal_entry_lines', 'select')) {
      expect(String(select)).not.toContain('journal_entries')
    }
    // The picker reads lines on 1513 (the rot_rut_receivable role in the SE pack).
    expect(findCalls('journal_entry_lines', 'eq')).toContainEqual(['account_number', '1513'])
    expect(findCalls('journal_entry_lines', 'gt')).toContainEqual(['credit_amount', 0])
    // No line credits 1513: nothing else is read.
    expect(findCalls('journal_entries', 'in')).toEqual([])
    expect(findCalls('rot_rut_payout_requests', 'in')).toEqual([])
  })

  it('reads no lines when the company has no verifikat since the begäran', async () => {
    enqueue({ data: [] })
    const { data, error } = await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25')
    expect(error).toBeNull()
    expect(data).toEqual([])
    expect(findCalls('journal_entry_lines', 'select')).toEqual([])
  })

  it('passes a failed read through as the error', async () => {
    enqueue({ error: { message: 'canceling statement due to statement timeout', code: '57014' } })
    const { data, error } = await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25')
    expect(data).toEqual([])
    expect(error).toBeTruthy()
  })

  // Kontantmetodens two steps (issue #93): nothing sits on 1513, so a payout
  // booked by hand credits the share's revenue and moms instead.
  it('under kontantmetoden offers a hand-booked two-step payout of exactly the expected amount, and nothing alike', async () => {
    const entry = (id: string, sourceType: string, lines: Array<[string, number, number]>) => ({
      id,
      entry_date: '2026-09-05',
      voucher_series: 'A',
      voucher_number: Number(id.slice(3)) || 1,
      description: 'Utbetalning ROT',
      source_type: sourceType,
      lines: lines.map(([account_number, debit, credit]) => ({
        account_number,
        debit_amount: String(debit),
        credit_amount: String(credit),
      })),
    })
    enqueue(entryIds('je-10', 'je-11', 'je-12', 'je-13', 'je-14'))
    // Nothing credits 1513; the debits of exactly the expected payout.
    enqueue({
      data: [
        line('l-10', 'je-10', '1930', 3750, 0),
        line('l-11', 'je-11', '1630', 3750, 0),
        line('l-12', 'je-12', '1930', 3750, 0),
        line('l-13', 'je-13', '1930', 3750, 0),
        line('l-14', 'je-14', '5410', 3750, 0),
      ],
    })
    enqueue({
      data: [
        // The two steps by hand from the bank.
        entry('je-10', 'manual', [['1930', 3750, 0], ['3001', 0, 3000], ['2611', 0, 750]]),
        // A set-off on the skattekonto: the skattekonto booking links its own.
        entry('je-11', 'system', [['1630', 3750, 0], ['3001', 0, 3000], ['2611', 0, 750]]),
        // A customer's kontantmetod payment of the same amount: its own source.
        entry('je-12', 'invoice_cash_payment', [['1930', 3750, 0], ['3001', 0, 3000], ['2611', 0, 750]]),
        // Something else on the voucher (a customer receivable): not a payout.
        entry('je-13', 'manual', [['1930', 3750, 0], ['1510', 0, 3750]]),
      ],
    })
    enqueue({ data: [] })

    const { data, error } = await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25', {
      expectedAmount: 3750,
    })

    expect(error).toBeNull()
    expect(data.map((candidate) => [candidate.journal_entry_id, candidate.receivable_credit, candidate.share_credit])).toEqual([
      ['je-10', 0, 3750],
    ])
    // One line read: 1513 credits or the expected payout's debit; only a debit
    // on the bank (19xx) counts, not the skattekonto (1630) or a cost (5410).
    expect(findCalls('journal_entry_lines', 'or')).toEqual([
      ['and(account_number.eq.1513,credit_amount.gt.0),debit_amount.eq.3750'],
    ])
    expect(findCalls('journal_entries', 'in')).toEqual([['id', ['je-10', 'je-12', 'je-13']]])
  })

  it('without twoStep (faktureringsmetoden) never reads the payout debits', async () => {
    enqueue(entryIds('je-1'))
    enqueue({ data: [] })
    await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25')
    expect(findCalls('journal_entry_lines', 'or')).toEqual([])
    expect(findCalls('journal_entry_lines', 'eq')).not.toContainEqual(['debit_amount', expect.anything()])
  })
})

describe('twoStepPayoutShape', () => {
  it('nets money in, 1513 and the share, and refuses any other account', () => {
    expect(
      twoStepPayoutShape([
        { account_number: '1930', debit_amount: 4000, credit_amount: 0 },
        { account_number: '1513', debit_amount: 0, credit_amount: 250 },
        { account_number: '3041', debit_amount: 0, credit_amount: 3000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 750 },
      ]),
    ).toEqual({ moneyIn: 4000, receivable: 250, share: 3750 })
    expect(twoStepPayoutShape([
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1513', debit_amount: 0, credit_amount: 100 },
    ])).toBeNull()
    expect(twoStepPayoutShape([
      { account_number: '1930', debit_amount: 125, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 100 },
      { account_number: '2440', debit_amount: 0, credit_amount: 25 },
    ])).toBeNull()
  })
})

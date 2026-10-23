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
  it('nets the 1513 and bank sides and drops used, storno and non-crediting vouchers', async () => {
    enqueue({ data: [{ journal_entry_id: 'je-1' }, { journal_entry_id: 'je-2' }, { journal_entry_id: 'je-3' }, { journal_entry_id: 'je-4' }] })
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
  })

  it('returns nothing without querying entries when no line credits 1513', async () => {
    enqueue({ data: [] })
    const { data } = await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25')
    expect(data).toEqual([])
    // The picker reads lines on 1513 (the rot_rut_receivable role in the SE pack).
    expect(findCalls('journal_entry_lines', 'eq')).toContainEqual(['account_number', '1513'])
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
    enqueue({ data: [] }) // nothing credits 1513
    enqueue({
      data: [
        { journal_entry_id: 'je-10', account_number: '1930' },
        { journal_entry_id: 'je-11', account_number: '1630' },
        { journal_entry_id: 'je-12', account_number: '1930' },
        { journal_entry_id: 'je-13', account_number: '1930' },
        { journal_entry_id: 'je-14', account_number: '5410' },
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
    expect(findCalls('journal_entry_lines', 'eq')).toContainEqual(['debit_amount', 3750])
  })

  it('without twoStep (faktureringsmetoden) never reads a second line set', async () => {
    enqueue({ data: [] })
    await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25')
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

import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  linkRotRutPayoutVoucher,
  listRotRutPayoutVoucherCandidates,
} from '../rot-rut-link-voucher'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
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
      },
    ])
  })

  it('returns nothing without querying entries when no line credits 1513', async () => {
    enqueue({ data: [] })
    const { data } = await listRotRutPayoutVoucherCandidates(client, 'company-1', '2026-08-25')
    expect(data).toEqual([])
  })
})

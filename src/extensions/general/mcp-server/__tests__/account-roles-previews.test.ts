/**
 * Account roles slice 2: two staged previews read their accounts from roles
 * instead of spelling them. Pinned to the accounts they showed before, so the
 * approval card an approver reads is unchanged:
 *
 *   gnubok_run_currency_revaluation   posts_to: operating FX gain and loss (3960, 7960)
 *   gnubok_link_rot_rut_payout_voucher voucher_1513_credit: the voucher's net
 *                                      credit on the ROT/RUT receivable (1513)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const revaluation = tools.find((t) => t.name === 'gnubok_run_currency_revaluation')!
const linkVoucher = tools.find((t) => t.name === 'gnubok_link_rot_rut_payout_voucher')!

const { supabase, setTable, payloads, reset } = createTableMockSupabase()

beforeEach(() => {
  reset()
  setTable('pending_operations', { data: { id: 'op-1' } })
})

function stagedPreview(): Record<string, unknown> {
  const inserts = payloads('pending_operations', 'insert') as Array<{ preview_data: Record<string, unknown> }>
  expect(inserts).toHaveLength(1)
  return inserts[0].preview_data
}

describe('staged previews that read account roles', () => {
  it('the currency revaluation preview names 3960 and 7960', async () => {
    await revaluation.execute(
      { fiscal_period_id: '11111111-1111-4111-8111-111111111111', closing_date: '2026-12-31' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )
    expect(stagedPreview().posts_to).toEqual(['3960', '7960'])
  })

  it('the ROT/RUT payout link preview nets the voucher on 1513 and the bank', async () => {
    setTable('journal_entries', {
      data: {
        id: 'je-1',
        entry_date: '2026-09-01',
        voucher_series: 'A',
        voucher_number: 177,
        description: 'RUT utbetalning',
        status: 'posted',
        lines: [
          { account_number: '1930', debit_amount: 671, credit_amount: 0 },
          { account_number: '3740', debit_amount: 0.25, credit_amount: 0 },
          { account_number: '1513', debit_amount: 0, credit_amount: 671.25 },
        ],
      },
    })
    setTable('rot_rut_payout_requests', {
      data: [
        {
          id: 'req-1',
          name: 'RUT 2026-08',
          deduction_type: 'rut',
          status: 'submitted',
          requested_total: 671,
          decided_total: null,
          settlement_journal_entry_id: null,
        },
      ],
    })

    await linkVoucher.execute(
      { journal_entry_id: 'je-1', request_ids: ['req-1'] },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )
    expect(stagedPreview()).toMatchObject({
      voucher_number: 'A177',
      bank_amount: 671,
      voucher_1513_credit: 671.25,
      expected_total: 671,
      rounding: 0.25,
    })
  })
})

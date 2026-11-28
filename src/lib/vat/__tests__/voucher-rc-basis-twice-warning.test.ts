/**
 * The VAT block's warning for typed lines that declare one reverse-charge
 * purchase twice (../voucher-rc-basis-twice-warning.ts). The rule itself,
 * rcBasisCountedTwice, is pinned in lib/reports/__tests__/rc-basis-gaps.test.ts;
 * here: when the kontoplan is read, and what the warning says.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { rcBasisTwiceVoucherWarning } from '../voucher-rc-basis-twice-warning'

const line = (account_number: string, debit_amount: number, credit_amount = 0) => ({
  account_number,
  debit_amount,
  credit_amount,
})

// An EU-services purchase of 1 000 kr on a cost account whose momskod reports
// ruta 21, with a 4535/4598 basis pair on top and its fiktiv moms once.
const doubled = [
  line('6541', 1000),
  line('1930', 0, 1000),
  line('4535', 1000),
  line('4598', 0, 1000),
  line('2645', 250),
  line('2614', 0, 250),
]

function chartWith6541() {
  const mock = createQueuedMockSupabase()
  mock.enqueue({
    data: [
      {
        account_number: '6541',
        account_name: 'IT-tjänster EU',
        account_class: 6,
        default_vat_treatment: 'reverse_charge_eu_services',
        default_vat_rate: 0.25,
        vat_box: null,
      },
    ],
    error: null,
  })
  return mock
}

describe('rcBasisTwiceVoucherWarning', () => {
  it('reads nothing for lines without a 4598 line', async () => {
    const mock = createQueuedMockSupabase()
    const warning = await rcBasisTwiceVoucherWarning(mock.supabase as never, 'company-1', {
      lines: [line('6541', 1000), line('1930', 0, 1000), line('2645', 250), line('2614', 0, 250)],
    })
    expect(warning).toBeNull()
    expect(mock.findCall('chart_of_accounts', 'select')).toBeUndefined()
  })

  it('asks nothing of an ingående balans', async () => {
    const mock = createQueuedMockSupabase()
    const warning = await rcBasisTwiceVoucherWarning(mock.supabase as never, 'company-1', {
      lines: doubled,
      opening_balance: true,
    })
    expect(warning).toBeNull()
    expect(mock.findCall('chart_of_accounts', 'select')).toBeUndefined()
  })

  it('warns that the verifikat counts the purchase twice, naming the account and both amounts', async () => {
    const mock = chartWith6541()
    const warning = await rcBasisTwiceVoucherWarning(mock.supabase as never, 'company-1', { lines: doubled })

    expect(warning).toMatchObject({
      code: 'REVERSE_CHARGE_BASIS_TWICE',
      details: { own_ruta_accounts: ['6541'], basis_accounts: ['4535'], reported_basis: 2000, expected_basis: 1000 },
    })
    expect(warning?.message_sv).toMatch(/^Verifikationen skulle räkna samma inköp två gånger i momsdeklarationen: konto 6541 /)
    expect(warning?.message_sv).toContain('basbeloppspar mot 4598')
    expect(warning?.message_en).toMatch(/^The voucher would count the purchase twice in the momsdeklaration: account 6541 reports/)
    expect(mock.findCall('chart_of_accounts', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('speaks of the rättelse when the lines replace a posted verifikat', async () => {
    const mock = chartWith6541()
    const warning = await rcBasisTwiceVoucherWarning(mock.supabase as never, 'company-1', {
      lines: doubled,
      replaces: { entry_date: '2026-05-12', lines: [line('6541', 1000), line('1930', 0, 1000)] },
    })
    expect(warning?.message_sv).toMatch(/^Rättelsen skulle räkna samma inköp två gånger i momsdeklarationen/)
    expect(warning?.message_en).toMatch(/^The correction would count the purchase twice/)
  })

  it('leaves the pair alone beside an ordinary cost account', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [], error: null })
    const warning = await rcBasisTwiceVoucherWarning(mock.supabase as never, 'company-1', {
      lines: doubled.map((l) => (l.account_number === '6541' ? { ...l, account_number: '6540' } : l)),
    })
    expect(warning).toBeNull()
  })

  it('passes a failed kontoplan read on: the guard decides what it means', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null, error: { message: 'chart unreadable' } })
    await expect(
      rcBasisTwiceVoucherWarning(mock.supabase as never, 'company-1', { lines: doubled }),
    ).rejects.toBeTruthy()
  })
})

/**
 * The booking-time warning for a verifikat that changes a filed
 * momsdeklaration (../voucher-filed-period-warning.ts), over the two things
 * it reads: which filed period a date lies in, and what the declaration
 * would read of the lines. Both are stubbed here, the effect by a stand-in
 * that answers from the lines it is handed (input moms on 2641 is ruta 48),
 * so a posting judged on the wrong lines or the wrong date fails a test.
 * The real chain, with only the database faked, is ./filed-period-chain.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FiledVatPeriod } from '../filed-period-for-date'
import type { VoucherImpactLine, VoucherVatDeclarationImpact } from '../voucher-vat-impact'

const filed = vi.hoisted(() => ({ filedVatPeriodsOfDates: vi.fn() }))
vi.mock('../filed-period-for-date', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../filed-period-for-date')>()),
  filedVatPeriodsOfDates: filed.filedVatPeriodsOfDates,
}))
const impact = vi.hoisted(() => ({ previewVoucherVatDeclaration: vi.fn() }))
vi.mock('../voucher-vat-impact', () => impact)

import { filedPeriodVoucherWarning } from '../voucher-filed-period-warning'

const supabase = {} as SupabaseClient
const Q2: FiledVatPeriod = { tax_period: '2026-Q2', period_start: '2026-04-01', period_end: '2026-06-30', filed_on: '2026-08-17' }
const Q3: FiledVatPeriod = { tax_period: '2026-Q3', period_start: '2026-07-01', period_end: '2026-09-30', filed_on: '2026-11-11' }

/** The filed period of each date, as the home answers. */
function filedOn(map: Record<string, FiledVatPeriod>) {
  filed.filedVatPeriodsOfDates.mockImplementation(async (_s: unknown, _c: unknown, dates: readonly string[]) => {
    return new Map(dates.filter((d) => map[d]).map((d) => [d, map[d]]))
  })
}

function answer(over: Partial<VoucherVatDeclarationImpact>): VoucherVatDeclarationImpact {
  return { status: 'ok', vat_period: null, counted: true, excluded_as: null, rutor_change: {}, summary: '', ...over }
}

/** A stand-in for the declaration's reading: the input moms on 2641 is ruta 48, and ruta 49 its negative. */
function readsInputVat() {
  impact.previewVoucherVatDeclaration.mockImplementation(
    async (_s: unknown, _c: unknown, input: { lines: readonly VoucherImpactLine[] }) => {
      const vat = input.lines
        .filter((l) => l.account_number === '2641')
        .reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)
      return answer({ rutor_change: vat === 0 ? {} : { ruta48: vat, ruta49: -vat } })
    },
  )
}

const purchase = (vat: number, cost = '6540') => [
  { account_number: cost, debit_amount: vat * 4, credit_amount: 0 },
  { account_number: '2641', debit_amount: vat, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: vat * 5 },
]
const bankFee = [
  { account_number: '6570', debit_amount: 45, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 45 },
]
/** The (date, lines) of every reading the warning asked for, in order. */
const readings = () =>
  impact.previewVoucherVatDeclaration.mock.calls.map(([, , input]) => ({ date: input.entryDate, lines: input.lines }))

beforeEach(() => {
  vi.clearAllMocks()
  filedOn({})
  readsInputVat()
})

describe('filedPeriodVoucherWarning: a new verifikat', () => {
  it('warns when the verifikat moves a ruta of a period already filed, naming the period and its filing date', async () => {
    filedOn({ '2026-09-27': Q3 })

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '2026-09-27', lines: purchase(125) })

    expect(warning?.code).toBe('VAT_PERIOD_ALREADY_FILED')
    expect(warning?.message_sv).toBe(
      'Verifikationen ändrar underlaget för en momsdeklaration som redan är inlämnad: 2026-Q3 (inlämnad 2026-11-11). ' +
        'Bokförs den här kan deklarationen behöva rättas. ' +
        'Hör affärshändelsen till en senare period, välj ett datum där i stället.',
    )
    expect(warning?.message_en).toBe(
      'The voucher changes the figures behind a VAT return already filed: 2026-Q3 (filed 2026-11-11). ' +
        'If it is booked here, the return may need correcting. ' +
        'If the business event belongs to a later period, pick a date there instead.',
    )
    expect(warning?.details).toEqual({
      entry_date: '2026-09-27',
      filed_periods: [{ ...Q3, rutor_change: { ruta48: 125, ruta49: -125 } }],
    })
    expect(impact.previewVoucherVatDeclaration).toHaveBeenCalledWith(supabase, 'c-1', {
      entryDate: '2026-09-27',
      lines: purchase(125),
      isOpeningBalance: false,
    })
  })

  it('speaks of a booking, with no date to pick, for a samlingsverifikat or an underlag booked from Inkorgen', async () => {
    filedOn({ '2026-09-27': Q3 })

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '2026-09-27', lines: purchase(125) }, 'booking')

    expect(warning?.message_sv).toBe(
      'Bokningen ändrar underlaget för en momsdeklaration som redan är inlämnad: 2026-Q3 (inlämnad 2026-11-11). ' +
        'Görs bokningen kan deklarationen behöva rättas.',
    )
    expect(warning?.message_en).toBe(
      'The booking changes the figures behind a VAT return already filed: 2026-Q3 (filed 2026-11-11). ' +
        'If it is made, the return may need correcting.',
    )
  })

  it('says nothing, and reads no more, when the date lies in no filed period', async () => {
    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '2026-10-20', lines: purchase(125) })

    expect(warning).toBeNull()
    expect(impact.previewVoucherVatDeclaration).not.toHaveBeenCalled()
  })

  it('says nothing about a verifikat that moves no ruta: a bank fee in a filed period changes no declaration', async () => {
    filedOn({ '2026-09-27': Q3 })

    expect(await filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '2026-09-27', lines: bankFee })).toBeNull()
  })

  it('warns when only a base ruta moves: the declaration changes without a moms line', async () => {
    filedOn({ '2026-09-27': Q3 })
    impact.previewVoucherVatDeclaration.mockResolvedValue(answer({ rutor_change: { ruta05: 20000 } }))

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', {
      entry_date: '2026-09-27',
      lines: [
        { account_number: '1790', debit_amount: 20000, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 20000 },
      ],
    })

    expect(warning?.details.filed_periods).toEqual([{ ...Q3, rutor_change: { ruta05: 20000 } }])
    // It says the declaration changes, never "the moms".
    expect(warning?.message_sv).not.toContain('momsen')
  })

  it('says nothing about a verifikat the declaration leaves out (a momsredovisning) or a company that files none', async () => {
    filedOn({ '2026-09-27': Q3 })
    impact.previewVoucherVatDeclaration.mockResolvedValueOnce(answer({ counted: false, excluded_as: 'net_account_shape' }))
    expect(await filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '2026-09-27', lines: purchase(125) })).toBeNull()

    impact.previewVoucherVatDeclaration.mockResolvedValueOnce(answer({ status: 'not_vat_registered', counted: null }))
    expect(await filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '2026-09-27', lines: purchase(125) })).toBeNull()
  })

  it('reads the rättelse of an ingående balans by the opening-balance rule, and says nothing while that rule has not counted it', async () => {
    filedOn({ '2026-07-01': Q3 })
    impact.previewVoucherVatDeclaration.mockResolvedValue(answer({ counted: false, excluded_as: 'opening_balance' }))
    const balances = [
      { account_number: '2641', debit_amount: 300, credit_amount: 0 },
      { account_number: '2099', debit_amount: 0, credit_amount: 300 },
    ]

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', {
      entry_date: '2026-07-01',
      lines: balances,
      replaces: { entry_date: '2026-07-01', lines: balances },
      opening_balance: true,
    })

    expect(warning).toBeNull()
    expect(impact.previewVoucherVatDeclaration).toHaveBeenCalledWith(supabase, 'c-1', expect.objectContaining({ isOpeningBalance: true }))
  })

  it('asks nothing of a date that is no date', async () => {
    expect(await filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '', lines: purchase(125) })).toBeNull()
    expect(filed.filedVatPeriodsOfDates).not.toHaveBeenCalled()
  })

  it('throws when the effect cannot be read, so the guard never reads a failure as "no warning"', async () => {
    filedOn({ '2026-09-27': Q3 })
    impact.previewVoucherVatDeclaration.mockResolvedValue(answer({ status: 'unavailable', counted: null }))

    await expect(
      filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '2026-09-27', lines: purchase(125) }),
    ).rejects.toThrow('voucher VAT impact unavailable')
  })
})

describe('filedPeriodVoucherWarning: a rättelse, judged as the pair it posts', () => {
  const original = { entry_date: '2026-09-27', lines: purchase(100) }

  it('reads the new lines on the rättelse\'s date and the original\'s lines on the original\'s date', async () => {
    filedOn({ '2026-09-27': Q3, '2026-06-30': Q2 })

    await filedPeriodVoucherWarning(supabase, 'c-1', { entry_date: '2026-06-30', lines: purchase(125), replaces: original })

    expect(readings()).toEqual([
      { date: '2026-06-30', lines: purchase(125) },
      { date: '2026-09-27', lines: purchase(100) },
    ])
  })

  it('says nothing when the rättelse leaves the moms as it was (another cost account)', async () => {
    filedOn({ '2026-09-27': Q3 })

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', {
      entry_date: '2026-09-27',
      lines: purchase(100, '5410'),
      replaces: original,
    })

    expect(warning).toBeNull()
    expect(readings()).toHaveLength(2)
  })

  it('warns with the net change when the rättelse changes the moms of the filed period', async () => {
    filedOn({ '2026-09-27': Q3 })

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', {
      entry_date: '2026-09-27',
      lines: purchase(125),
      replaces: original,
    })

    expect(warning?.message_sv).toBe(
      'Rättelsen ändrar underlaget för en momsdeklaration som redan är inlämnad: 2026-Q3 (inlämnad 2026-11-11). ' +
        'Görs rättelsen kan deklarationen behöva rättas.',
    )
    expect(warning?.message_en).toBe(
      'The correction changes the figures behind a VAT return already filed: 2026-Q3 (filed 2026-11-11). If it is made, the return may need correcting.',
    )
    // 125 in, the original's 100 out.
    expect(warning?.details.filed_periods).toEqual([{ ...Q3, rutor_change: { ruta48: 25, ruta49: -25 } }])
  })

  it('warns about the storno alone when the rättelse is dated in an open period', async () => {
    filedOn({ '2026-09-27': Q3 })

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', {
      entry_date: '2026-11-17',
      lines: purchase(125),
      replaces: original,
    })

    // Only the original's date is filed: the original's 100 leaves that
    // period, and the new 125 is not read at all.
    expect(readings()).toEqual([{ date: '2026-09-27', lines: purchase(100) }])
    expect(warning?.details.filed_periods).toEqual([{ ...Q3, rutor_change: { ruta48: -100, ruta49: 100 } }])
  })

  it('warns about the new lines alone when a verifikat in an open period is corrected into a filed one', async () => {
    filedOn({ '2026-09-30': Q3 })

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', {
      entry_date: '2026-09-30',
      lines: purchase(125),
      replaces: { entry_date: '2026-10-05', lines: purchase(100) },
    })

    expect(readings()).toEqual([{ date: '2026-09-30', lines: purchase(125) }])
    expect(warning?.details.filed_periods).toEqual([{ ...Q3, rutor_change: { ruta48: 125, ruta49: -125 } }])
  })

  it('names both periods when the rättelse moves moms from one filed period into another', async () => {
    filedOn({ '2026-09-27': Q3, '2026-06-30': Q2 })

    const warning = await filedPeriodVoucherWarning(supabase, 'c-1', {
      entry_date: '2026-06-30',
      lines: purchase(125),
      replaces: original,
    })

    expect(warning?.message_sv).toBe(
      'Rättelsen ändrar underlaget för momsdeklarationer som redan är inlämnade: 2026-Q2 (inlämnad 2026-08-17) och 2026-Q3 (inlämnad 2026-11-11). ' +
        'Görs rättelsen kan deklarationerna behöva rättas.',
    )
    expect(warning?.message_en).toBe(
      'The correction changes the figures behind VAT returns already filed: 2026-Q2 (filed 2026-08-17) and 2026-Q3 (filed 2026-11-11). ' +
        'If it is made, the returns may need correcting.',
    )
    expect(warning?.details.filed_periods).toEqual([
      { ...Q2, rutor_change: { ruta48: 125, ruta49: -125 } },
      { ...Q3, rutor_change: { ruta48: -100, ruta49: 100 } },
    ])
  })
})

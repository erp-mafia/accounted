import { beforeEach, describe, expect, it, vi } from 'vitest'

const covered = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bookkeeping/ledger-coverage', () => ({ ledgerCoverage: covered }))

import { coveredDayMessage, coveredDayReason, coveredFeedRows, isFeedConnectorRow, type CoveredFeedRows } from '../feed-row-coverage'

const supabase = {} as never
const ledgerOf = (accounts: Record<string, string>) => (id: string) => accounts[id]

const MIGRATED: CoveredFeedRows = {
  settlement_account: '1686',
  covered_through: '2026-10-15',
  covered_by: 'migrated_ledger',
  transaction_ids: ['early'],
}
const BY_HAND: CoveredFeedRows = {
  settlement_account: '1686',
  covered_through: '2026-10-15',
  covered_by: 'manual_voucher',
  covering_voucher: { journal_entry_id: 'je-1', voucher_label: 'A12' },
  transaction_ids: ['early', 'same-day'],
}

beforeEach(() => {
  covered.mockReset()
})

describe('isFeedConnectorRow', () => {
  it('is a Stripe row, never a bank, bank-file or manual row', () => {
    expect(isFeedConnectorRow({ import_source: 'stripe' })).toBe(true)
    for (const import_source of [null, undefined, 'camt053', 'csv_seb', 'enable_banking', 'manual']) {
      expect(isFeedConnectorRow({ import_source })).toBe(false)
    }
  })
})

describe('coveredFeedRows', () => {
  it('reads once per settlement account from the earliest feed row and names every covered row, earliest first', async () => {
    covered.mockResolvedValue({
      through: '2026-10-15',
      source: 'manual_voucher',
      voucher: { journal_entry_id: 'je-1', voucher_label: 'A12' },
    })
    const result = await coveredFeedRows(
      supabase,
      'company-1',
      [
        { id: 'late', date: '2026-10-20', import_source: 'stripe' },
        { id: 'same-day', date: '2026-10-15T08:00:00Z', import_source: 'stripe' },
        { id: 'early', date: '2026-10-10', import_source: 'stripe' },
        { id: 'bank', date: '2026-10-01', import_source: null },
      ],
      ledgerOf({ late: '1686', 'same-day': '1686', early: '1686', bank: '1930' }),
    )
    // The row after the covered day and the bank row are left out (crm#1901).
    expect(result).toEqual([BY_HAND])
    expect(covered).toHaveBeenCalledTimes(1)
    expect(covered).toHaveBeenCalledWith(supabase, 'company-1', ['1686'], '2026-10-10')
  })

  it('answers each settlement account with its own day and source', async () => {
    covered.mockImplementation(async (...args: unknown[]) =>
      (args[2] as string[])[0] === '1686' ? { through: '2026-10-15', source: 'migrated_ledger' } : null,
    )
    const result = await coveredFeedRows(
      supabase,
      'company-1',
      [
        { id: 'early', date: '2026-10-10', import_source: 'stripe' },
        { id: 'other', date: '2026-10-10', import_source: 'stripe' },
      ],
      ledgerOf({ early: '1686', other: '1687' }),
    )
    expect(result).toEqual([MIGRATED])
    expect(covered).toHaveBeenCalledTimes(2)
  })

  it('lets a feed row after the covered day through', async () => {
    covered.mockResolvedValue({ through: '2026-10-15', source: 'migrated_ledger' })
    const result = await coveredFeedRows(
      supabase,
      'company-1',
      [{ id: 'late', date: '2026-10-20T00:00:00Z', import_source: 'stripe' }],
      ledgerOf({ late: '1686' }),
    )
    expect(result).toEqual([])
  })

  it('answers nothing without reading when nothing is covered or no row is a feed row', async () => {
    covered.mockResolvedValue(null)
    expect(
      await coveredFeedRows(supabase, 'company-1', [{ id: 'a', date: '2026-10-01', import_source: 'stripe' }], ledgerOf({ a: '1686' })),
    ).toEqual([])
    covered.mockReset()
    expect(
      await coveredFeedRows(supabase, 'company-1', [{ id: 'b', date: '2026-10-01', import_source: null }], ledgerOf({ b: '1930' })),
    ).toEqual([])
    expect(covered).not.toHaveBeenCalled()
  })
})

describe('coveredDayReason', () => {
  it('names the migrated ledger and its last day, so nobody blames a verifikat that did not set it', () => {
    const reason = coveredDayReason(MIGRATED)
    expect(reason.sv).toBe(
      'Bokföringen du importerade från ditt förra program når till och med 2026-10-15 (dess sista verifikat). Transaktioner som hämtats till konto 1686 räknas som redan bokförda där till och med den dagen.',
    )
    expect(reason.en).toContain('reaches 2026-10-15 (its last imported verifikat, on any account)')
  })

  it('names the hand-entered verifikat on the settlement account', () => {
    const reason = coveredDayReason(BY_HAND)
    expect(reason.sv).toContain('Konto 1686 har ett manuellt verifikat daterat 2026-10-15 (A12).')
    expect(reason.en).toContain('Account 1686 has a hand-entered verifikat dated 2026-10-15 (A12).')
  })
})

describe('coveredDayMessage', () => {
  it('speaks of the one row at the single-row door', () => {
    const message = coveredDayMessage([MIGRATED], 1)
    expect(message.sv).toContain('Det gäller den här raden. Länka den till verifikatet som innehåller den eller ignorera den')
    expect(message.en).toContain('That holds for this row.')
  })

  it('counts the refused rows of a selection and says the others are not affected', () => {
    const message = coveredDayMessage([BY_HAND], 5)
    expect(message.sv).toContain('Det gäller 2 av 5 rader i urvalet.')
    expect(message.sv).toContain('De övriga 3 berörs inte och kan bokföras för sig.')
    expect(message.en).toContain('That holds for 2 of the 5 selected rows.')
    expect(message.en).toContain('The other 3 are not affected and can be booked on their own.')
  })

  it('says so when every selected row is covered', () => {
    const message = coveredDayMessage([BY_HAND], 2)
    expect(message.sv).toContain('Det gäller alla rader i urvalet.')
    expect(message.sv).not.toContain('övriga')
  })
})

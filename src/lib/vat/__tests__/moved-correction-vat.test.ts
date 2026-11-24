/**
 * The VAT advice for a rättelse moved out of a locked period: the VAT
 * difference lands in the correction's momsperiod in the books, but belongs
 * to the original's, and a filed return for it is corrected instead (SFL 49
 * kap. 13 §, egen rättelse).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const preview = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../voucher-vat-impact', () => ({ previewVoucherVatDeclaration: preview.fn }))

const target = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/core/bookkeeping/storno-target', () => ({ assertStornoTarget: target.fn }))

import { correctionLanding, movedCorrectionVatWarning, vatAccountChange } from '../moved-correction-vat'

const ORIGINAL_LINES = [
  { account_number: '6110', debit_amount: 800, credit_amount: 0 },
  { account_number: '2641', debit_amount: 200, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
]
// The moms was not deductible: all of it is cost.
const NO_VAT_LINES = [
  { account_number: '6110', debit_amount: 1000, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
]
// Another cost account, the same moms.
const SAME_VAT_LINES = [
  { account_number: '5410', debit_amount: 800, credit_amount: 0 },
  { account_number: '2641', debit_amount: 200, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
]

const vatPeriod = (filed_on: string | null) => ({
  status: 'ok',
  vat_period: { type: 'quarterly', year: 2025, period: 4, start: '2025-10-01', end: '2025-12-31', label: '2025 Q4', filed_on },
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('vatAccountChange', () => {
  it('nets the corrected lines against the original on every 26xx account that moves', () => {
    expect(vatAccountChange(ORIGINAL_LINES, NO_VAT_LINES)).toEqual({ '2641': -200 })
    expect(vatAccountChange(ORIGINAL_LINES, SAME_VAT_LINES)).toEqual({})
  })
})

describe('movedCorrectionVatWarning', () => {
  const input = (correctedLines: typeof NO_VAT_LINES) => ({
    originalDate: '2025-11-15',
    correctionDate: '2026-11-24',
    originalLines: ORIGINAL_LINES,
    correctedLines,
  })

  it('names a filed original period and says to correct that return instead', async () => {
    preview.fn.mockResolvedValue(vatPeriod('2026-02-12'))

    const warning = await movedCorrectionVatWarning({} as never, 'company-1', input(NO_VAT_LINES))

    expect(warning?.code).toBe('VAT_OF_MOVED_CORRECTION')
    expect(warning?.message_sv).toContain('2026-11-24')
    expect(warning?.message_sv).toContain('felet hör till 2025 Q4')
    expect(warning?.message_sv).toContain('redan inlämnad (2026-02-12): rätta den i stället')
    expect(warning?.message_sv).toContain('SFL 49 kap. 13 §')
    expect(warning?.details).toMatchObject({
      original_vat_period: '2025 Q4',
      original_vat_period_filed_on: '2026-02-12',
      vat_account_change: { '2641': -200 },
    })
    expect(preview.fn).toHaveBeenCalledWith({}, 'company-1', expect.objectContaining({ entryDate: '2025-11-15' }))
  })

  it('names an original period not filed here and says the difference belongs there', async () => {
    preview.fn.mockResolvedValue(vatPeriod(null))

    const warning = await movedCorrectionVatWarning({} as never, 'company-1', input(NO_VAT_LINES))

    expect(warning?.message_sv).toContain('inte deklarerad här: ta med skillnaden i deklarationen för 2025 Q4')
  })

  it('says nothing when the pair moves no VAT account, or the company files no momsdeklaration', async () => {
    expect(await movedCorrectionVatWarning({} as never, 'company-1', input(SAME_VAT_LINES))).toBeNull()
    expect(preview.fn).not.toHaveBeenCalled()

    preview.fn.mockResolvedValue({ status: 'not_vat_registered', vat_period: null })
    expect(await movedCorrectionVatWarning({} as never, 'company-1', input(NO_VAT_LINES))).toBeNull()
  })

  it('names the original\'s date when its momsperiod cannot be read', async () => {
    preview.fn.mockResolvedValue({ status: 'unavailable', vat_period: null })

    const warning = await movedCorrectionVatWarning({} as never, 'company-1', input(NO_VAT_LINES))

    expect(warning?.message_sv).toContain('momsperioden för 2025-11-15')
  })
})

describe('correctionLanding', () => {
  const original = {
    id: 'orig-1',
    fiscal_period_id: 'fp-2025',
    entry_date: '2025-11-15',
    source_type: 'manual',
    lines: ORIGINAL_LINES.map((l) => ({ ...l, debit_amount: String(l.debit_amount) })),
  }

  it('asks the storno target with the person\'s option and judges VAT only when the pair moved', async () => {
    target.fn.mockResolvedValueOnce({ date: '2025-11-15', fiscal_period_id: 'fp-2025', moved: false })
    expect(await correctionLanding({} as never, 'company-1', original, NO_VAT_LINES)).toEqual({
      target: { date: '2025-11-15', fiscal_period_id: 'fp-2025', moved: false },
      vatWarning: null,
    })
    expect(target.fn).toHaveBeenCalledWith({}, 'company-1', original, undefined, { inFirstOpenPeriodWhenLocked: true })
    expect(preview.fn).not.toHaveBeenCalled()

    target.fn.mockResolvedValueOnce({ date: '2026-11-24', fiscal_period_id: 'fp-2026', moved: true })
    preview.fn.mockResolvedValue(vatPeriod(null))
    const moved = await correctionLanding({} as never, 'company-1', original, NO_VAT_LINES)
    expect(moved.vatWarning?.details).toMatchObject({ correction_date: '2026-11-24', vat_account_change: { '2641': -200 } })
  })
})

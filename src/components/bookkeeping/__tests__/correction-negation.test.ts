import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  correctionLinesNegateOriginal,
  originalToCorrectionLines,
} from '@/components/bookkeeping/correction-negation'

// A bank fee: cost debit, bank credit.
const ORIGINAL = [
  { account_number: '6570', debit_amount: 100, credit_amount: 0, line_description: 'Bankavgift' },
  { account_number: '1930', debit_amount: 0, credit_amount: 100, line_description: null },
]

function line(account: string, debit: string, credit: string) {
  return { account_number: account, debit_amount: debit, credit_amount: credit, line_description: '' }
}

describe('originalToCorrectionLines', () => {
  it('starts the form from the original lines, sides as posted (not their reversal)', () => {
    expect(originalToCorrectionLines(ORIGINAL)).toEqual([
      { account_number: '6570', debit_amount: '100', credit_amount: '', line_description: 'Bankavgift' },
      { account_number: '1930', debit_amount: '', credit_amount: '100', line_description: '' },
    ])
  })

  it('reads string amounts as the API returns them', () => {
    const lines = originalToCorrectionLines([
      { account_number: '6570', debit_amount: '42.5' as unknown as number, credit_amount: '0' as unknown as number, line_description: '' },
    ])
    expect(lines[0]).toMatchObject({ debit_amount: '42.5', credit_amount: '' })
  })
})

describe('correctionLinesNegateOriginal (crm#1397)', () => {
  it('flags the original with debit and credit swapped: a second reversal', () => {
    expect(correctionLinesNegateOriginal([line('6570', '', '100'), line('1930', '100', '')], ORIGINAL)).toBe(true)
  })

  it('flags the swap however the lines are split', () => {
    expect(
      correctionLinesNegateOriginal(
        [line('6570', '', '60'), line('6570', '', '40'), line('1930', '100', '')],
        ORIGINAL,
      ),
    ).toBe(true)
  })

  it('does not flag the untouched prefill', () => {
    expect(correctionLinesNegateOriginal(originalToCorrectionLines(ORIGINAL), ORIGINAL)).toBe(false)
  })

  it('does not flag a real correction (another amount or another account)', () => {
    expect(correctionLinesNegateOriginal([line('6570', '80', ''), line('1930', '', '80')], ORIGINAL)).toBe(false)
    expect(correctionLinesNegateOriginal([line('6590', '100', ''), line('1930', '', '100')], ORIGINAL)).toBe(false)
  })

  it('does not flag half-typed lines', () => {
    expect(correctionLinesNegateOriginal([line('6570', '', '100'), line('1930', '', '')], ORIGINAL)).toBe(false)
    expect(correctionLinesNegateOriginal([line('6570', '', 'abc'), line('1930', '100', '')], ORIGINAL)).toBe(false)
  })
})

describe('CorrectionEntryDialog wiring (source shape; components are not rendered in tests)', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../CorrectionEntryDialog.tsx'), 'utf8')

  it('prefills from the original lines through the shared helper', () => {
    expect(SRC).toContain('setLines(originalToCorrectionLines(originalLines))')
  })

  it('says in the flow that the storno is automatic', () => {
    expect(SRC).toContain("t('correction_lines_hint', { voucher: formatVoucher(entry) })")
  })

  it('asks before posting a second reversal, without a request first', () => {
    const submit = SRC.slice(SRC.indexOf('async function handleSubmit'), SRC.indexOf("fetch(`/api/bookkeeping/journal-entries/${entry.id}/correct`"))
    expect(submit).toContain('if (!flags.sidesSwapped && linesNegateOriginal)')
    expect(submit).toContain('setNegatesOriginal(true)')
  })

  it('warns inline while typing and offers the way back to the original lines', () => {
    expect(SRC).toContain("t('negates_original_inline', { voucher: formatVoucher(entry) })")
    expect(SRC).toContain("t('negates_original_reset')")
  })
})

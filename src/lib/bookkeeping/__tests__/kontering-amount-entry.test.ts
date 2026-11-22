import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { balancingProposalSide, konteringAmountText, konteringAmountValue, negativeAmountMove } from '../kontering-amount-entry'

describe('negativeAmountMove', () => {
  it('moves a minus debit to kredit as a positive figure', () => {
    expect(negativeAmountMove('debit_amount', '-80')).toEqual({ side: 'credit_amount', value: '80' })
  })

  it('moves a minus credit to debet and keeps the decimals as typed', () => {
    expect(negativeAmountMove('credit_amount', ' -80.50 ')).toEqual({ side: 'debit_amount', value: '80.50' })
  })

  it.each(['', '80', '0', '-0', '-', 'abc'])('leaves %j where it is', (text) => {
    expect(negativeAmountMove('debit_amount', text)).toBeNull()
  })
})

describe('balancingProposalSide', () => {
  it('proposes in debet when the debit side is short and focus is there', () => {
    expect(balancingProposalSide('debit_amount', 80)).toBe('debit_amount')
  })

  it('proposes in kredit when the credit side is short, from either column', () => {
    expect(balancingProposalSide('debit_amount', -80)).toBe('credit_amount')
    expect(balancingProposalSide('credit_amount', -80)).toBe('credit_amount')
  })

  it('proposes nothing in debet for someone standing in kredit', () => {
    expect(balancingProposalSide('credit_amount', 80)).toBeNull()
  })

  it('proposes nothing when the other rows balance', () => {
    expect(balancingProposalSide('debit_amount', 0)).toBeNull()
  })
})

describe('konteringAmountValue', () => {
  // PH 305: the field was a number input, which Chrome reads by the
  // browser's own language. In an English Chrome "100,50" became 10050.
  it.each([
    ['100,50', '100.5'],
    ['100.50', '100.5'],
    ['1 234,56', '1234.56'],
    ['1\u00a0234,56', '1234.56'],
    ['1.234,56', '1234.56'],
    ['0,5', '0.5'],
    [',5', '0.5'],
    ['100,', '100'],
    ['-80,25', '-80.25'],
    ['12,345', '12.35'],
    ['10,000', '10'],
    ['0', '0'],
  ])('reads %j in Swedish as the figure %j', (typed, value) => {
    expect(konteringAmountValue(typed, ',')).toBe(value)
  })

  it.each([
    ['100.50', '100.5'],
    ['10,000', '10000'],
    ['1,234.56', '1234.56'],
    ['1 234.56', '1234.56'],
    ['-80.25', '-80.25'],
  ])('reads %j in English as the figure %j', (typed, value) => {
    expect(konteringAmountValue(typed, '.')).toBe(value)
  })

  it.each(['', '  ', '-', '--5', ',', 'abc', '12abc', '1.2.3', '1e3'])('reads %j as no figure in either language', (typed) => {
    expect(konteringAmountValue(typed, ',')).toBe('')
    expect(konteringAmountValue(typed, '.')).toBe('')
  })

  it.each([
    ['100,50', '100.5'],
    ['0,5', '0.5'],
    ['1.234,56', '1234.56'],
    ['0,500', '0.5'],
    ['0,050', '0.05'],
    ['-0,750', '-0.75'],
  ])('reads %j in English, a comma that cannot group thousands, as the decimal %j', (typed, value) => {
    // A phone set to a Swedish region offers only a comma on its decimal keypad.
    expect(konteringAmountValue(typed, '.')).toBe(value)
  })

  it.each([
    ['-2,675', ','],
    ['-2.675', '.'],
    ['−2,675', ','],
    ['\u{2013}2.675', '.'],
    ['\u{2014}2,675', ','],
    ['\u{2010}2.675', '.'],
  ])('rounds the minus figure %j as the same figure on the other side', (typed, decimal) => {
    const value = konteringAmountValue(typed, decimal as ',' | '.')
    expect(value).toBe('-2.68')
    expect(negativeAmountMove('debit_amount', value)).toEqual({ side: 'credit_amount', value: '2.68' })
    expect(konteringAmountValue(typed.slice(1), decimal as ',' | '.')).toBe('2.68')
  })

  it('hands every reader what a number field handed it: parseFloat reads the value as the typed amount', () => {
    expect(parseFloat(konteringAmountValue('100,50', ','))).toBe(100.5)
    expect(parseFloat(konteringAmountValue('1 234,56', ','))).toBe(1234.56)
    expect(parseFloat(konteringAmountValue('10,000', '.'))).toBe(10000)
  })
})

describe('konteringAmountText', () => {
  it('shows a figure to the öre with the decimal mark of the language', () => {
    expect(konteringAmountText('100.5', ',')).toBe('100,50')
    expect(konteringAmountText('100.5', '.')).toBe('100.50')
    expect(konteringAmountText('-80.25', ',')).toBe('-80,25')
    expect(konteringAmountText('1250', ',')).toBe('1250,00')
    expect(konteringAmountText('12.345', ',')).toBe('12,35')
  })

  it('shows an empty value or one that is not a plain figure as it is', () => {
    expect(konteringAmountText('', ',')).toBe('')
    expect(konteringAmountText('1e3', ',')).toBe('1e3')
  })

  it('reads back as the same figure in either language', () => {
    for (const value of ['100.5', '1234.56', '-80.25', '0.07', '10000']) {
      expect(konteringAmountValue(konteringAmountText(value, ','), ',')).toBe(value)
      expect(konteringAmountValue(konteringAmountText(value, '.'), '.')).toBe(value)
    }
  })
})

describe('the doors', () => {
  const root = path.resolve(__dirname, '../../../')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

  it('the shared editor moves a minus figure when the field is left, for every dialog', () => {
    expect(read('components/bookkeeping/KonteringLinesEditor.tsx')).toContain('negativeAmountMove(')
  })

  it('the shared editor takes typed amounts as text, never as a number field', () => {
    const editor = read('components/bookkeeping/KonteringLinesEditor.tsx')
    expect(editor).toContain('konteringAmountValue(')
    expect(editor).not.toMatch(/type="number"/)
  })

  it('the verifikat form proposes through balancingProposalSide', () => {
    expect(read('components/bookkeeping/JournalEntryForm.tsx')).toContain('balancingProposalSide(')
  })
})

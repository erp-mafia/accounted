import { describe, it, expect } from 'vitest'
import { parseAmountInput } from '@/lib/money'
import {
  UNEDITED_VALIDATION,
  blankEditableLine,
  previewToEditable,
  toLinePayload,
  validateEditableLines,
  type EditablePaymentLine,
  type PaymentPreviewLine,
} from '../payment-preview-lines'

/**
 * Parity with the two copies this module replaced: InvoiceMatchDialog and
 * the supplier invoice page each carried previewToEditable, the balance
 * validation and the payload mapping, word for word. The legacy copy below is
 * that code (naive two-decimal rounding included); for every amount an
 * editor produces, the shared module answers the same.
 */
const legacyRound2 = (n: number) => Math.round(n * 100) / 100
const legacyParse = (s: string) => parseAmountInput(s) ?? 0
function legacyValidate(lines: EditablePaymentLine[]) {
  const totalDebit = legacyRound2(lines.filter((l) => l.side === 'debit').reduce((s, l) => s + legacyParse(l.amount), 0))
  const totalCredit = legacyRound2(lines.filter((l) => l.side === 'credit').reduce((s, l) => s + legacyParse(l.amount), 0))
  const isBalanced = totalDebit === totalCredit && totalDebit > 0
  const accountInvalid = lines.some((l) => !/^\d{4}$/.test(l.account_number.trim()))
  return {
    isBalanced,
    accountInvalid,
    isValid: isBalanced && !accountInvalid,
    diff: legacyRound2(totalDebit - totalCredit),
    totalDebit,
    totalCredit,
  }
}
function legacyPayload(lines: EditablePaymentLine[]) {
  return lines.map((l) => {
    const amount = legacyRound2(legacyParse(l.amount))
    return {
      account_number: l.account_number.trim(),
      debit_amount: l.side === 'debit' ? amount : 0,
      credit_amount: l.side === 'credit' ? amount : 0,
      line_description: l.description?.trim() || undefined,
      ...(l.dimensions && Object.keys(l.dimensions).length > 0 ? { dimensions: { ...l.dimensions } } : {}),
    }
  })
}

const preview: PaymentPreviewLine[] = [
  { account_number: '2440', debit_amount: 1250.5, credit_amount: 0, description: 'Leverantörsskuld', dimensions: { '1': 'P10' } },
  { account_number: '1930', debit_amount: 0, credit_amount: 1250.5, description: 'Bank' },
]

const edits: EditablePaymentLine[][] = [
  preview.map(previewToEditable),
  [
    { account_number: '2440', side: 'debit', amount: '1 250,50', description: ' Skuld ' },
    { account_number: '1930 ', side: 'credit', amount: '1250.5', description: '' },
  ],
  [
    { account_number: '2440', side: 'debit', amount: '100', description: 'a' },
    { account_number: '6570', side: 'debit', amount: '0,33', description: 'Avgift' },
    { account_number: '1930', side: 'credit', amount: '100,33', description: 'b' },
  ],
  [
    { account_number: '244', side: 'debit', amount: '10', description: '' },
    { account_number: '1930', side: 'credit', amount: 'tio', description: '' },
  ],
  [
    { account_number: '2440', side: 'debit', amount: '0', description: '' },
    { account_number: '1930', side: 'credit', amount: '', description: '' },
  ],
]

describe('payment-preview-lines parity with the dialogs it replaced', () => {
  it('validates every edited grid exactly as the old copies did', () => {
    for (const lines of edits) expect(validateEditableLines(lines)).toEqual(legacyValidate(lines))
  })

  it('builds the same request rows, bags included', () => {
    for (const lines of edits) expect(toLinePayload(lines)).toEqual(legacyPayload(lines))
  })
})

describe('previewToEditable', () => {
  it('turns a preview row into one amount with a side, keeping a copy of its bag', () => {
    const [debit, credit] = preview.map(previewToEditable)
    expect(debit).toEqual({
      account_number: '2440',
      side: 'debit',
      amount: '1250.5',
      description: 'Leverantörsskuld',
      dimensions: { '1': 'P10' },
    })
    expect(debit.dimensions).not.toBe(preview[0].dimensions)
    expect(credit).toEqual({ account_number: '1930', side: 'credit', amount: '1250.5', description: 'Bank' })
  })
})

describe('blankEditableLine', () => {
  it('starts an added row on the debit side with the settled document bag', () => {
    expect(blankEditableLine({ '2': 'K1' })).toEqual({
      account_number: '',
      side: 'debit',
      amount: '',
      description: '',
      dimensions: { '2': 'K1' },
    })
    expect(blankEditableLine(null)).not.toHaveProperty('dimensions')
    expect(blankEditableLine({})).not.toHaveProperty('dimensions')
  })
})

describe('validateEditableLines', () => {
  it('needs both sides equal and above zero, and four-digit accounts', () => {
    expect(validateEditableLines(edits[0]).isValid).toBe(true)
    expect(validateEditableLines(edits[3])).toMatchObject({ isBalanced: false, accountInvalid: true, isValid: false })
    expect(validateEditableLines(edits[4]).isBalanced).toBe(false)
  })

  it('reads the Swedish amount form "1 250,50"', () => {
    expect(validateEditableLines(edits[1])).toMatchObject({ totalDebit: 1250.5, totalCredit: 1250.5, isValid: true })
  })

  it('has a neutral answer for a dialog that is not editing', () => {
    expect(UNEDITED_VALIDATION).toMatchObject({ isValid: true, isBalanced: true, accountInvalid: false })
  })
})

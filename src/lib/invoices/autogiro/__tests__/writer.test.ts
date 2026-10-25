import { describe, expect, it } from 'vitest'
import { field } from '../records'
import { verifyAutogiroSeal, sealAutogiroFile } from '../seal'
import { autogiroFile, debitSection, encodeAutogiroFile, mandateSection, type AutogiroPayee } from '../writer'
import { CUSTOMER_NUMBER, PAYEE_BG, PAYEE_BG_DIGITS, PAYER_BG, PAYER_BG_DIGITS, zero } from './autogiro-fixture'

const payee: AutogiroPayee = { customerNumber: CUSTOMER_NUMBER, bankgiro: PAYEE_BG }
const account = { clearing: '5000', number: '1234567' }
/** The payee bankgiro with a wrong check digit. */
const BAD_BG = `${PAYEE_BG_DIGITS.slice(0, -1)}${(Number(PAYEE_BG_DIGITS.slice(-1)) + 1) % 10}`

describe('mandateSection', () => {
  it('opens with TK01: write date, AUTOGIRO, Kundnummer and bankgiro at the manual positions', () => {
    const [opening] = mandateSection(payee, '2026-10-17', [{ kind: 'cancel', payerNumber: '1001' }])

    expect(opening).toHaveLength(80)
    expect(field(opening!, 1, 2)).toBe('01')
    expect(field(opening!, 3, 10)).toBe('20261017')
    expect(field(opening!, 11, 18)).toBe('AUTOGIRO')
    expect(field(opening!, 19, 62)).toBe(' '.repeat(44))
    expect(field(opening!, 63, 68)).toBe(CUSTOMER_NUMBER)
    expect(field(opening!, 69, 78)).toBe(zero(PAYEE_BG_DIGITS, 10))
    expect(field(opening!, 79, 80)).toBe('  ')
  })

  it('writes a new mandate on a bank account (TK04) with clearing, account and personnummer', () => {
    const [, mandate] = mandateSection(payee, '2026-10-17', [
      { kind: 'new', payerNumber: '1001', account, identity: { kind: 'person', number: '190001010000' } },
    ])

    expect(mandate).toHaveLength(80)
    expect(field(mandate!, 1, 2)).toBe('04')
    expect(field(mandate!, 3, 12)).toBe(zero(PAYEE_BG_DIGITS, 10))
    expect(field(mandate!, 13, 28)).toBe(zero('1001', 16))
    expect(field(mandate!, 29, 32)).toBe('5000')
    expect(field(mandate!, 33, 44)).toBe('000001234567')
    expect(field(mandate!, 45, 56)).toBe('190001010000')
    expect(field(mandate!, 57, 80)).toBe(' '.repeat(24))
  })

  it('prefixes an organisationsnummer with 00', () => {
    const [, mandate] = mandateSection(payee, '2026-10-17', [
      { kind: 'new', payerNumber: '7', account, identity: { kind: 'organisation', number: '5566778899' } },
    ])
    expect(field(mandate!, 45, 56)).toBe('005566778899')
  })

  it('writes a mandate on the payer bankgiro with that bankgiro as payer number and 29-80 blank', () => {
    const [, mandate] = mandateSection(payee, '2026-10-17', [{ kind: 'new_on_bankgiro', payerBankgiro: PAYER_BG }])

    expect(field(mandate!, 1, 2)).toBe('04')
    expect(field(mandate!, 13, 28)).toBe(zero(PAYER_BG_DIGITS, 16))
    expect(field(mandate!, 29, 80)).toBe(' '.repeat(52))
  })

  it('answers an internet-bank mandate: blank in 77-78 approves, AV rejects', () => {
    const answer = (approve: boolean) =>
      mandateSection(payee, '2026-10-17', [
        { kind: 'answer_internet_bank', payerNumber: '1001', account, identity: { kind: 'person', number: '190001010000' }, approve },
      ])[1]!
    expect(field(answer(true), 77, 78)).toBe('  ')
    expect(field(answer(false), 77, 78)).toBe('AV')
  })

  it('cancels a mandate with TK03', () => {
    const [, cancel] = mandateSection(payee, '2026-10-17', [{ kind: 'cancel', payerNumber: '1001' }])
    expect(cancel).toBe(`03${zero(PAYEE_BG_DIGITS, 10)}${zero('1001', 16)}${' '.repeat(52)}`)
  })

  it('refuses values that do not fit the record', () => {
    const write = (instruction: Parameters<typeof mandateSection>[2][number]) => () => mandateSection(payee, '2026-10-17', [instruction])

    expect(write({ kind: 'cancel', payerNumber: '1'.repeat(17) })).toThrow('Betalarnummer får vara högst 16 siffror')
    expect(write({ kind: 'cancel', payerNumber: 'A1' })).toThrow('Betalarnummer får bara innehålla siffror')
    expect(write({ kind: 'new', payerNumber: '1', account: { clearing: '82149', number: '1' }, identity: { kind: 'person', number: '190001010000' } })).toThrow(
      'Clearingnumret ska vara 4 siffror',
    )
    expect(write({ kind: 'new', payerNumber: '1', account, identity: { kind: 'person', number: '0001010000' } })).toThrow('12 siffror')
    expect(write({ kind: 'new_on_bankgiro', payerBankgiro: BAD_BG })).toThrow('inget giltigt bankgironummer')
    expect(() => mandateSection({ ...payee, bankgiro: BAD_BG }, '2026-10-17', [{ kind: 'cancel', payerNumber: '1' }])).toThrow(
      'Betalningsmottagarens bankgironummer är inget giltigt bankgironummer',
    )
    expect(() => mandateSection({ ...payee, customerNumber: '1234567' }, '2026-10-17', [{ kind: 'cancel', payerNumber: '1' }])).toThrow(
      'Kundnummer får vara högst 6 siffror',
    )
    expect(() => mandateSection(payee, '2026-10-17', [])).toThrow('inga medgivanden')
  })
})

describe('debitSection', () => {
  it('writes one TK82 per debit: date, period 0, blank count, payer, öre amount, bankgiro and reference', () => {
    const [, debit] = debitSection(payee, '2026-10-17', [{ date: '2026-10-30', payerNumber: '1001', amount: 1500.5, reference: '1001234' }])

    expect(debit).toHaveLength(80)
    expect(field(debit!, 1, 2)).toBe('82')
    expect(field(debit!, 3, 10)).toBe('20261030')
    expect(field(debit!, 11, 11)).toBe('0')
    expect(field(debit!, 12, 15)).toBe('    ')
    expect(field(debit!, 16, 31)).toBe(zero('1001', 16))
    expect(field(debit!, 32, 43)).toBe('000000150050')
    expect(field(debit!, 44, 53)).toBe(zero(PAYEE_BG_DIGITS, 10))
    expect(field(debit!, 54, 69)).toBe('1001234         ')
    expect(field(debit!, 70, 80)).toBe(' '.repeat(11))
  })

  it('turns kronor into exact öre, also for sums that drift in floating point', () => {
    const amountField = (amount: number) =>
      field(debitSection(payee, '2026-10-17', [{ date: '2026-10-30', payerNumber: '1', amount, reference: '1' }])[1]!, 32, 43)
    expect(amountField(0.1 + 0.2)).toBe('000000000030')
    expect(amountField(1234.56)).toBe('000000123456')
    expect(amountField(10.075)).toBe('000000001008')
    expect(amountField(9_999_999_999.99)).toBe('999999999999')
  })

  it('refuses a zero amount, a passed payment day, a long reference and characters Bankgirot does not take', () => {
    const write = (debit: Partial<Parameters<typeof debitSection>[2][number]>) => () =>
      debitSection(payee, '2026-10-17', [{ date: '2026-10-30', payerNumber: '1', amount: 100, reference: '1', ...debit }])

    expect(write({ amount: 0 })).toThrow('Belopp måste vara större än noll')
    expect(write({ amount: -5 })).toThrow('Belopp måste vara större än noll')
    expect(write({ date: '2026-10-16' })).toThrow('Betalningsdagen har redan passerat')
    expect(write({ date: '2026-02-30' })).toThrow('Betalningsdag är inget giltigt datum')
    expect(write({ reference: '1'.repeat(17) })).toThrow('Referens får vara högst 16 tecken')
    expect(write({ reference: 'faktura €12' })).toThrow('Referens innehåller ett tecken som Bankgirot inte tar emot')
    expect(() => debitSection(payee, '2026-10-17', [])).toThrow('inga betalningar')
  })
})

describe('autogiroFile', () => {
  it('ends every record with CRLF and encodes in ISO 8859-1', () => {
    const content = autogiroFile([
      mandateSection(payee, '2026-10-17', [{ kind: 'cancel', payerNumber: '1' }]),
      debitSection(payee, '2026-10-17', [{ date: '2026-10-30', payerNumber: '2', amount: 99, reference: 'Åsa' }]),
    ])

    expect(content.split('\r\n')).toHaveLength(5)
    expect(content.endsWith('\r\n')).toBe(true)
    const bytes = encodeAutogiroFile(content)
    expect(bytes).toHaveLength(4 * 82)
    expect(bytes[82 * 3 + 53]).toBe(0xc5) // Å in the reference at position 54 of the fourth record
  })

  it('makes a file the seal accepts after sealing', () => {
    const content = autogiroFile([debitSection(payee, '2026-10-17', [{ date: '2026-10-30', payerNumber: '2', amount: 99, reference: '42' }])])
    const key = '1234567890ABCDEF1234567890ABCDEF'
    expect(verifyAutogiroSeal(sealAutogiroFile(content, key, '2026-10-17'), key)).toEqual({ ok: true })
  })
})

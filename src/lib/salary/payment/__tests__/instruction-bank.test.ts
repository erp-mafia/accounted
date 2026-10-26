import { describe, it, expect } from 'vitest'
import { salaryInstructionBankFromIban } from '../instruction-bank'

// Made-up account digits; only the bank code (characters 5-7) matters here.
describe('salaryInstructionBankFromIban', () => {
  // crm#1391: a SEB company that never picked its bank in the salary settings
  // still meets SEB's instructions first, from the IBAN its pain.001 debits.
  it('names SEB from bank code 500, spaces and case as typed', () => {
    expect(salaryInstructionBankFromIban('SE45 5000 0000 0583 9825 7466')).toBe('seb')
    expect(salaryInstructionBankFromIban('se4550000000058398257466')).toBe('seb')
  })

  it.each([
    ['SE12 8000 0000 0000 0000 0001', 'swedbank'],
    ['SE12 6000 0000 0000 0000 0001', 'handelsbanken'],
    ['SE12 3000 0000 0000 0000 0001', 'nordea'],
    ['SE12 9500 0000 0000 0000 0001', 'nordea'],
  ] as const)('%s -> %s', (iban, bank) => {
    expect(salaryInstructionBankFromIban(iban)).toBe(bank)
  })

  it.each([
    ['a bank without instructions (Danske Bank)', 'SE12 1200 0000 0000 0000 0001'],
    ['an unknown bank code', 'SE12 9990 0000 0000 0000 0001'],
    ['a foreign IBAN', 'DE89 3704 0044 0532 0130 00'],
    ['a short Swedish IBAN', 'SE12 5000 0000 0000'],
    ['an empty value', ''],
    ['null', null],
    ['undefined', undefined],
  ])('answers null for %s', (_label, iban) => {
    expect(salaryInstructionBankFromIban(iban)).toBeNull()
  })
})

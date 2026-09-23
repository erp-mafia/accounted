import { describe, expect, it } from 'vitest'
import {
  isValidBalanceAccount,
  suggestBalanceAccount,
} from '@/lib/bookkeeping/accruals/account-suggestions'

describe('suggestBalanceAccount', () => {
  it('maps cost accounts to the BAS-conventional interim account', () => {
    expect(suggestBalanceAccount('expense', '5010')).toBe('1710') // lokalhyra
    expect(suggestBalanceAccount('expense', '5220')).toBe('1720') // hyra inventarier
    expect(suggestBalanceAccount('expense', '5615')).toBe('1720') // leasing personbil
    expect(suggestBalanceAccount('expense', '6310')).toBe('1730') // försäkring
    expect(suggestBalanceAccount('expense', '8410')).toBe('1740') // ränta
    expect(suggestBalanceAccount('expense', '6540')).toBe('1790') // IT-tjänster -> övrigt
  })

  it('always suggests 2970 for revenue', () => {
    expect(suggestBalanceAccount('revenue', '3001')).toBe('2970')
    expect(suggestBalanceAccount('revenue', '3041')).toBe('2970')
  })
})

describe('isValidBalanceAccount', () => {
  it('mirrors the DB CHECK ranges', () => {
    expect(isValidBalanceAccount('expense', '1730')).toBe(true)
    expect(isValidBalanceAccount('expense', '1790')).toBe(true)
    expect(isValidBalanceAccount('expense', '2970')).toBe(false)
    expect(isValidBalanceAccount('expense', '5010')).toBe(false)
    expect(isValidBalanceAccount('revenue', '2970')).toBe(true)
    expect(isValidBalanceAccount('revenue', '2990')).toBe(true)
    expect(isValidBalanceAccount('revenue', '1790')).toBe(false)
  })
})

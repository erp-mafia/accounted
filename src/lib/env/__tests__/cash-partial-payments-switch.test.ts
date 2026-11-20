import { describe, it, expect } from 'vitest'
import { cashPartialPaymentsEnabled } from '@/lib/env/cash-partial-payments-switch'
import { getErrorEntry } from '@/lib/errors/structured-errors'

describe('cashPartialPaymentsEnabled', () => {
  it('is off unless CASH_PARTIAL_PAYMENTS_ENABLED says 1 or true', () => {
    expect(cashPartialPaymentsEnabled({})).toBe(false)
    expect(cashPartialPaymentsEnabled({ CASH_PARTIAL_PAYMENTS_ENABLED: '' })).toBe(false)
    expect(cashPartialPaymentsEnabled({ CASH_PARTIAL_PAYMENTS_ENABLED: '0' })).toBe(false)
    expect(cashPartialPaymentsEnabled({ CASH_PARTIAL_PAYMENTS_ENABLED: 'yes' })).toBe(false)
    expect(cashPartialPaymentsEnabled({ CASH_PARTIAL_PAYMENTS_ENABLED: '1' })).toBe(true)
    expect(cashPartialPaymentsEnabled({ CASH_PARTIAL_PAYMENTS_ENABLED: ' TRUE ' })).toBe(true)
  })

  it('leaves the refusal in the words it always had', () => {
    expect(getErrorEntry('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')?.message_sv).toBe(
      'Kontantmetoden kan inte bokföra delbetalningar av en obokförd faktura automatiskt: hela fakturan bokförs vid betalning. Ta emot hela beloppet i en betalning, byt till faktureringsmetoden eller bokför betalningen manuellt som verifikation.',
    )
  })
})

import { describe, expect, it } from 'vitest'
import { getCreditNoteSendMode } from '@/lib/invoices/credit-note-send-mode'

describe('getCreditNoteSendMode', () => {
  it('prefers email when delivery is available and the customer has an address', () => {
    expect(getCreditNoteSendMode({
      customerHasEmail: true,
      isSandbox: false,
      canEmail: true,
    })).toBe('email')
  })

  it.each([
    { customerHasEmail: false, isSandbox: false, canEmail: true },
    { customerHasEmail: true, isSandbox: true, canEmail: true },
    { customerHasEmail: true, isSandbox: false, canEmail: false },
  ])('falls back to manual issuance for $customerHasEmail/$isSandbox/$canEmail', (input) => {
    expect(getCreditNoteSendMode(input)).toBe('manual')
  })
})

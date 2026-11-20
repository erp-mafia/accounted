import { describe, expect, it } from 'vitest'
import { customerLossCanSend, customerLossSummary } from '../text'
import type { CustomerLossView } from '../view'

const line = { account_number: '6352', debit_amount: 1000, credit_amount: 0 }
const doubtful: CustomerLossView['doubtful'] = { available: true, reserve: 1000, vat: 250, lines: [line] }
const confirmed: CustomerLossView['confirmed'] = {
  available: true,
  amount: 1250,
  net: 1000,
  vat: 250,
  shares: [],
  reserveReleased: 0,
  lines: [line],
}

describe('customerLossSummary', () => {
  it('says a befarad loss books the amount and leaves the invoice and VAT as they are', () => {
    expect(customerLossSummary({ doubtful, confirmed }, 'doubtful')).toEqual({ key: 'summary_doubtful', amount: 1000 })
  })

  it('says a konstaterad loss writes the claim off and lowers the output VAT', () => {
    expect(customerLossSummary({ doubtful, confirmed }, 'confirmed')).toEqual({
      key: 'summary_confirmed_vat',
      amount: 1250,
      vat: 250,
      reserveReleased: 0,
    })
  })

  it('leaves VAT out when the invoice carried none, and names a released reserve', () => {
    expect(customerLossSummary({ doubtful, confirmed: { ...confirmed, vat: 0, reserveReleased: 1000 } }, 'confirmed')).toEqual({
      key: 'summary_confirmed',
      amount: 1250,
      vat: 0,
      reserveReleased: 1000,
    })
  })

  it('says nothing when the kind is refused or nothing is booked', () => {
    const refused = { available: false as const, refusal: 'CUSTOMER_LOSS_CURRENCY_UNSUPPORTED' as const }
    expect(customerLossSummary({ doubtful: refused, confirmed }, 'doubtful')).toBeNull()
    expect(customerLossSummary({ doubtful, confirmed: refused }, 'confirmed')).toBeNull()
    expect(customerLossSummary({ doubtful, confirmed: { ...confirmed, lines: null } }, 'confirmed')).toBeNull()
  })
})

describe('customerLossCanSend', () => {
  const ready = { view: { doubtful, confirmed }, reason: 'Konkurs', entryDateValid: true, hasEvidence: true, uploading: false }

  it('stays closed until the person chooses befarad or konstaterad: nothing is preselected', () => {
    expect(customerLossCanSend({ ...ready, kind: null })).toBe(false)
    expect(customerLossCanSend({ ...ready, kind: 'doubtful' })).toBe(true)
    expect(customerLossCanSend({ ...ready, kind: 'confirmed' })).toBe(true)
  })

  it('needs evidence for a konstaterad loss only', () => {
    expect(customerLossCanSend({ ...ready, kind: 'confirmed', hasEvidence: false })).toBe(false)
    expect(customerLossCanSend({ ...ready, kind: 'doubtful', hasEvidence: false })).toBe(true)
  })

  it('needs an available kind, a reason, a date and no upload running', () => {
    const refused = { available: false as const, refusal: 'CUSTOMER_LOSS_CURRENCY_UNSUPPORTED' as const }
    expect(customerLossCanSend({ ...ready, kind: 'confirmed', view: { doubtful, confirmed: refused } })).toBe(false)
    expect(customerLossCanSend({ ...ready, kind: 'doubtful', reason: '  ' })).toBe(false)
    expect(customerLossCanSend({ ...ready, kind: 'doubtful', entryDateValid: false })).toBe(false)
    expect(customerLossCanSend({ ...ready, kind: 'doubtful', uploading: true })).toBe(false)
  })
})

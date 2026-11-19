import { describe, expect, it } from 'vitest'
import { voucherWarningsOfRefusal } from '../voucher-warnings-refusal'

const WARNING = {
  code: 'INPUT_VAT_ABOVE_RATE',
  message_sv: 'Ingående moms är högre än 25 % av underlaget.',
  message_en: 'Input VAT is above 25 % of its base.',
  details: {},
}
const refusal = (warnings: unknown, code = 'VOUCHER_NEEDS_CONFIRMATION') => ({ error: { code, message: 'x', details: { warnings } } })

describe('voucherWarningsOfRefusal', () => {
  it('reads the warnings of a VOUCHER_NEEDS_CONFIRMATION refusal', () => {
    const duplicate = { ...WARNING, code: 'POSSIBLE_DUPLICATE_VOUCHER', details: { journal_entry_id: 'je-1' } }
    expect(voucherWarningsOfRefusal(refusal([WARNING, duplicate]))).toEqual([WARNING, duplicate])
  })

  it('is null for another refusal, even one that carries warnings', () => {
    expect(voucherWarningsOfRefusal(refusal([WARNING], 'PERIOD_LOCKED'))).toBeNull()
  })

  it('is null for an answer that is no refusal at all', () => {
    expect(voucherWarningsOfRefusal(null)).toBeNull()
    expect(voucherWarningsOfRefusal(undefined)).toBeNull()
    expect(voucherWarningsOfRefusal({ data: { journal_entry_id: 'je-1' } })).toBeNull()
  })

  it('is null when the refusal names nothing to read', () => {
    expect(voucherWarningsOfRefusal(refusal([]))).toBeNull()
    expect(voucherWarningsOfRefusal(refusal(undefined))).toBeNull()
    expect(voucherWarningsOfRefusal({ error: { code: 'VOUCHER_NEEDS_CONFIRMATION' } })).toBeNull()
  })

  it('is null when any warning could not be shown or sent back', () => {
    expect(voucherWarningsOfRefusal(refusal([WARNING, { ...WARNING, code: 'SOMETHING_NEW' }]))).toBeNull()
    expect(voucherWarningsOfRefusal(refusal([WARNING, { code: 'INPUT_VAT_ABOVE_RATE' }]))).toBeNull()
    expect(voucherWarningsOfRefusal(refusal([WARNING, 'INPUT_VAT_ABOVE_RATE']))).toBeNull()
  })
})

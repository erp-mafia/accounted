import { describe, it, expect } from 'vitest'
import { shouldAutoApproveSupplierInvoice } from '../auto-approve'

describe('shouldAutoApproveSupplierInvoice', () => {
  it('always auto-approves enskild firma', () => {
    expect(shouldAutoApproveSupplierInvoice(true, false)).toBe(true)
    expect(shouldAutoApproveSupplierInvoice(true, true)).toBe(true)
  })

  it('auto-approves aktiebolag only when the setting is on', () => {
    expect(shouldAutoApproveSupplierInvoice(false, false)).toBe(false)
    expect(shouldAutoApproveSupplierInvoice(false, true)).toBe(true)
  })
})

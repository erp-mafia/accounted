/**
 * singleActionWarning: the consequence sentence the approver consents to
 * must describe what the commit executor will actually do. convert_invoice
 * is the one type whose outcome depends on its params (target 'order').
 */
import { describe, it, expect } from 'vitest'
import { singleActionWarning } from '../vocabulary'

// Echoes the key so the tests pin which sentence is chosen.
const t = (key: string) => key

describe('singleActionWarning', () => {
  it('promises a faktura with F-number for convert_invoice without a target (and with target invoice)', () => {
    expect(singleActionWarning('convert_invoice', undefined, t)).toBe('convert_invoice')
    expect(singleActionWarning('convert_invoice', { invoice_id: 'q-1' }, t)).toBe('convert_invoice')
    expect(singleActionWarning('convert_invoice', { invoice_id: 'q-1', target: 'invoice' }, t)).toBe('convert_invoice')
  })

  it('describes a draft kundorder and no booking for convert_invoice with target order', () => {
    expect(singleActionWarning('convert_invoice', { invoice_id: 'q-1', target: 'order' }, t)).toBe(
      'convert_invoice_to_order',
    )
  })

  it('ignores params for every other operation type', () => {
    expect(singleActionWarning('credit_invoice', { target: 'order' }, t)).toBe('credit_invoice')
    expect(singleActionWarning('unknown_type', { target: 'order' }, t)).toBe('')
  })
})

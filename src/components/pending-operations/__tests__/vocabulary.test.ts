/**
 * singleActionWarning: the consequence sentence the approver consents to
 * must describe what the commit executor will actually do. convert_invoice
 * is the one type whose outcome depends on its params (target 'order').
 */
import { describe, it, expect } from 'vitest'
import { singleActionWarning, singleActionWarnings } from '../vocabulary'

describe('singleActionWarning', () => {
  it('promises a faktura with F-number for convert_invoice without a target (and with target invoice)', () => {
    expect(singleActionWarning('convert_invoice')).toContain('F-nummer')
    expect(singleActionWarning('convert_invoice', { invoice_id: 'q-1' })).toContain('F-nummer')
    expect(singleActionWarning('convert_invoice', { invoice_id: 'q-1', target: 'invoice' })).toContain('F-nummer')
  })

  it('describes a draft kundorder and no booking for convert_invoice with target order', () => {
    const sentence = singleActionWarning('convert_invoice', { invoice_id: 'q-1', target: 'order' })
    expect(sentence).toContain('kundorder')
    expect(sentence).toContain('Ingen faktura')
    expect(sentence).not.toContain('F-nummer')
  })

  it('ignores params for every other operation type', () => {
    expect(singleActionWarning('credit_invoice', { target: 'order' })).toBe(singleActionWarnings.credit_invoice)
    expect(singleActionWarning('unknown_type', { target: 'order' })).toBe('')
  })
})

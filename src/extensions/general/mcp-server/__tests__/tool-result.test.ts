import { describe, it, expect } from 'vitest'
import { withNext, toToolError } from '../tool-result'

describe('withNext', () => {
  it('returns plain { data } when no hint provided', () => {
    expect(withNext({ id: 'x' })).toEqual({ data: { id: 'x' } })
  })

  it('attaches next hint when provided', () => {
    const result = withNext(
      { id: 'x' },
      { description: 'Send the invoice', tool: 'gnubok_send_invoice' }
    )
    expect(result).toEqual({
      data: { id: 'x' },
      next: { description: 'Send the invoice', tool: 'gnubok_send_invoice' },
    })
  })
})

describe('toToolError', () => {
  it('produces structured error from arbitrary throw', () => {
    const result = toToolError(new Error('Period must be locked before closing'))
    expect(result.error.code).toBe('PERIOD_NOT_LOCKED')
    expect(result.error.message_sv).toBeTruthy()
    expect(result.error.message_en).toContain('Period must be locked')
    expect(result.error.remediation?.tool).toBe('gnubok_lock_period')
  })

  it('extracts attempted scope from "Insufficient scope:" message', () => {
    const result = toToolError(
      new Error('Insufficient scope: this API key does not have the "payroll:write" scope')
    )
    expect(result.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(result.error.remediation?.description).toContain('"payroll:write"')
  })

  it('handles non-Error throws', () => {
    const result = toToolError('something broke')
    expect(result.error.code).toBe('UNKNOWN_ERROR')
    expect(result.error.message_en).toBe('something broke')
  })
})

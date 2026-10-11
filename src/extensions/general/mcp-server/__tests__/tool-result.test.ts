import { describe, it, expect } from 'vitest'
import { toToolError } from '../tool-result'

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

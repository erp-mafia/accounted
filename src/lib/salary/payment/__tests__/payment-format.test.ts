import { describe, expect, it } from 'vitest'
import { parseSalaryPaymentFormat, salaryBankListUrl, type SalaryPaymentFileFormat } from '../payment-format'

describe('parseSalaryPaymentFormat', () => {
  it('accepts the known formats', () => {
    expect(parseSalaryPaymentFormat('pain001')).toBe('pain001')
    expect(parseSalaryPaymentFormat('bg_lb')).toBe('bg_lb')
  })

  it('rejects anything else', () => {
    for (const value of ['', 'PAIN001', 'pain001 ', 'bg_lb&x=1', '"><script>', null, undefined, 1, {}]) {
      expect(parseSalaryPaymentFormat(value)).toBeNull()
    }
  })
})

describe('salaryBankListUrl', () => {
  it('builds the JSON and PDF urls with an encoded query', () => {
    expect(salaryBankListUrl('run-1', 'pain001')).toBe('/api/salary/runs/run-1/payment/bank-list?format=pain001')
    expect(salaryBankListUrl('run-1', 'bg_lb', 'pdf')).toBe('/api/salary/runs/run-1/payment/bank-list/pdf?format=bg_lb')
  })

  it('path-encodes the run id', () => {
    expect(salaryBankListUrl('a/b?c', 'pain001')).toBe('/api/salary/runs/a%2Fb%3Fc/payment/bank-list?format=pain001')
  })

  it('refuses a format outside the allow-list even when the type is bypassed', () => {
    expect(() => salaryBankListUrl('run-1', 'javascript:x' as SalaryPaymentFileFormat)).toThrow()
  })
})

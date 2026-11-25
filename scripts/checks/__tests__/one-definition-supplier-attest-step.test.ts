/**
 * The attest-step guard catches the step read from the accounting method
 * alone, and leaves the calls that pass the attest policy.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/supplier-invoice-attest-step.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('supplier-invoice-attest-step', () => {
  it.each([
    'const attests = companyAttestsSupplierInvoices(companySettings?.accounting_method)',
    'if (!companyAttestsSupplierInvoices(accountingMethod)) return 0',
    'companyAttestsSupplierInvoices(methods.get(id) ?? null)',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'const attests = companyAttestsSupplierInvoices(companySettings?.accounting_method, attestPolicyOn)',
    'if (!companyAttestsSupplierInvoices(accountingMethod, policy.enabled)) return null',
    'companyAttestsSupplierInvoices(methods.get(id) ?? null, policy.enabled)',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { ORE_ROUNDING_ACCOUNT } from '@/lib/money'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { DEFAULT_SETTLEMENT_ACCOUNT } from '@/lib/reconciliation/cash-account-scope'
import { SPECIFICATION_PROVIDERS } from '@/lib/reconciliation/manual-reconciliation'
import { KPI_DEFINITIONS } from '@/lib/reports/kpi-definitions'
import { VAT_REFUND_ACCOUNT, VAT_ROUNDING_ACCOUNT, VAT_SETTLEMENT_ACCOUNT } from '@/lib/reports/vat-settlement'

/**
 * Account roles slice 1: the exported constants that moved from a BAS
 * literal onto a role keep the exact literal they had, so every booking,
 * proposal, match and report that reads them is unchanged. The module-private
 * ones (batch-allocation-preview, book-direct-prefill, supplier-reconciliation)
 * are pinned by their modules' own tests, which assert the produced lines.
 */
describe('sites moved onto account roles keep their account', () => {
  it.each([
    ['DEFAULT_SETTLEMENT_ACCOUNT (reconciliation default)', DEFAULT_SETTLEMENT_ACCOUNT, '1930'],
    ['VAT_SETTLEMENT_ACCOUNT', VAT_SETTLEMENT_ACCOUNT, '2650'],
    ['VAT_REFUND_ACCOUNT', VAT_REFUND_ACCOUNT, '1650'],
    ['VAT_ROUNDING_ACCOUNT', VAT_ROUNDING_ACCOUNT, '3740'],
  ])('%s', (_name, value, literal) => {
    expect(value).toBe(literal)
  })

  it('the manual reconciliation still specifies 1510 and 2440 from the reskontra', () => {
    expect(SPECIFICATION_PROVIDERS['1510']?.key).toBe('ar')
    expect(SPECIFICATION_PROVIDERS['2440']?.key).toBe('ap')
    expect(Object.keys(SPECIFICATION_PROVIDERS)).toEqual(['1510', '2440', '2920', '2940'])
  })

  it('the outstanding receivables KPI still reads 1510', () => {
    expect(KPI_DEFINITIONS.find((d) => d.id === 'outstandingReceivables')?.defaultAccounts).toEqual(['1510'])
  })

  it("lib/money's öresavrundning account is the rounding role", () => {
    expect(ORE_ROUNDING_ACCOUNT).toBe(resolveAccountRole(PINNED_JURISDICTION, 'rounding'))
  })
})

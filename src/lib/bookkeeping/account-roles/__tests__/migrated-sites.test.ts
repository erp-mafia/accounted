import { describe, expect, it } from 'vitest'
import { ORE_ROUNDING_ACCOUNT } from '@/lib/money'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { CUSTOMER_ADVANCE_ACCOUNT } from '@/lib/bookkeeping/overpayment'
import { FX_GAIN_ACCOUNT, FX_LOSS_ACCOUNT } from '@/lib/bookkeeping/ore-rounding'
import { ROT_RUT_RECEIVABLE_ACCOUNT } from '@/lib/invoices/apply-invoice-payment'
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

/**
 * Account roles slice 2 moves read-side and preview sites only. The posting
 * modules keep their own constants for the roles it adds; each is pinned to
 * its role here, so a preview or report that now reads the role and the
 * posting it describes agree to the account, and the posting slice can move
 * the constant onto the role without changing a booking.
 */
describe('posting constants the slice 2 roles describe', () => {
  it.each([
    ['CUSTOMER_ADVANCE_ACCOUNT (overpayment.ts)', CUSTOMER_ADVANCE_ACCOUNT, 'customer_advances', '2420'],
    ['FX_GAIN_ACCOUNT (ore-rounding.ts)', FX_GAIN_ACCOUNT, 'operating_fx_gain', '3960'],
    ['FX_LOSS_ACCOUNT (ore-rounding.ts)', FX_LOSS_ACCOUNT, 'operating_fx_loss', '7960'],
    ['ROT_RUT_RECEIVABLE_ACCOUNT (apply-invoice-payment.ts)', ROT_RUT_RECEIVABLE_ACCOUNT, 'rot_rut_receivable', '1513'],
  ] as const)('%s is its role', (_name, value, role, literal) => {
    expect(value).toBe(literal)
    expect(resolveAccountRole(PINNED_JURISDICTION, role)).toBe(value)
  })
})

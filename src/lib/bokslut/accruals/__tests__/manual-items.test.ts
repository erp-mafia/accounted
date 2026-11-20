import { describe, it, expect } from 'vitest'
import { PERIODISERING_TEMPLATES } from '../templates'
import {
  buildAccrualItems,
  manualEntryToItem,
  newManualAccrualEntry,
  templateOf,
  type ManualAccrualEntry,
} from '../manual-items'

const entry = (kind: ManualAccrualEntry['templateKind'], patch: Partial<ManualAccrualEntry> = {}) => ({
  ...newManualAccrualEntry(templateOf(kind)!, 'e1'),
  amount: '12000',
  description: 'Hyra januari',
  ...patch,
})

describe('manualEntryToItem: parity with the periodisering page', () => {
  // The page mapped each template side onto one POST kind, accounts from the
  // primary (balance) and secondary (result) leg, the bag on the result leg.
  it('maps every side onto its POST kind and legs', () => {
    expect(manualEntryToItem(entry('prepaid_rent', { dimensions: { '1': 'P1' } }))).toEqual({
      kind: 'manual_prepaid_expense',
      amount: 12000,
      expense_account: '5010',
      prepaid_account: '1710',
      description: 'Hyra januari',
      dimensions: { '1': 'P1' },
    })
    expect(manualEntryToItem(entry('deferred_revenue'))).toEqual({
      kind: 'deferred_revenue',
      amount: 12000,
      revenue_account: '3000',
      deferred_account: '2970',
      description: 'Hyra januari',
    })
    expect(manualEntryToItem(entry('accrued_utilities'))).toMatchObject({
      kind: 'accrued_utility',
      expense_account: '5020',
      accrued_account: '2990',
    })
    expect(manualEntryToItem(entry('accrued_interest_expense'))).toMatchObject({
      kind: 'accrued_interest',
      expense_account: '8410',
    })
  })

  it('leaves out an entry without a positive amount, a description or an account', () => {
    expect(manualEntryToItem(entry('prepaid_rent', { amount: '' }))).toBeNull()
    expect(manualEntryToItem(entry('prepaid_rent', { amount: '0' }))).toBeNull()
    expect(manualEntryToItem(entry('prepaid_rent', { description: '  ' }))).toBeNull()
    // The generic kinds start without a cost account: the user names it.
    expect(manualEntryToItem(entry('accrued_expense'))).toBeNull()
    expect(manualEntryToItem(entry('other_prepaid_expense'))).toBeNull()
  })

  it('drops an empty bag', () => {
    expect(manualEntryToItem(entry('prepaid_rent', { dimensions: {} }))).not.toHaveProperty('dimensions')
  })
})

describe('the wizard kinds the shared templates now carry', () => {
  // Parity with the wizard's own kinds: a generic prepaid and accrued cost
  // with accounts the user names, which the page could not post before.
  it('posts a generic prepaid and accrued cost on the accounts typed', () => {
    expect(
      manualEntryToItem(entry('other_prepaid_expense', { secondaryAccount: '6310', primaryAccount: '1730' })),
    ).toEqual({
      kind: 'manual_prepaid_expense',
      amount: 12000,
      expense_account: '6310',
      prepaid_account: '1730',
      description: 'Hyra januari',
    })
    expect(manualEntryToItem(entry('accrued_expense', { secondaryAccount: '6530' }))).toEqual({
      kind: 'manual_accrued_expense',
      amount: 12000,
      expense_account: '6530',
      accrued_account: '2990',
      description: 'Hyra januari',
    })
  })

  it('pre-fills accrued interest on 2960 Upplupna räntekostnader, not the social-fee account 2940', () => {
    expect(templateOf('accrued_interest_expense')?.accrued_account).toBe('2960')
    expect(PERIODISERING_TEMPLATES.every((t) => t.accrued_account !== '2940')).toBe(true)
  })
})

describe('buildAccrualItems', () => {
  it('orders the vacation change, the fee and the manual entries, skipping what is not ready', () => {
    expect(
      buildAccrualItems({
        vacation: true,
        auditFee: { enabled: true, amount: '15 000', liabilityAccount: '2991' },
        manual: [entry('prepaid_rent'), entry('prepaid_rent', { amount: '' })],
      }).map((i) => i.kind),
    ).toEqual(['vacation_liability_change', 'audit_fee', 'manual_prepaid_expense'])
  })

  it('skips a fee that is off or has no positive amount', () => {
    expect(buildAccrualItems({ vacation: false, auditFee: { enabled: false, amount: '9000', liabilityAccount: '2992' }, manual: [] })).toEqual([])
    expect(buildAccrualItems({ vacation: false, auditFee: { enabled: true, amount: '0', liabilityAccount: '2992' }, manual: [] })).toEqual([])
    expect(buildAccrualItems({ vacation: false, auditFee: { enabled: true, amount: '9000', liabilityAccount: '2992' }, manual: [] })).toEqual([
      { kind: 'audit_fee', amount: 9000, liability_account: '2992' },
    ])
  })
})

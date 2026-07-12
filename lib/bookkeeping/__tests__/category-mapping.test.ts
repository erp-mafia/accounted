import { describe, it, expect } from 'vitest'
import {
  getCategoryAccountMapping,
  getExpenseAccountForCategory,
  getDefaultAccountForCategory,
  getDefaultVatTreatmentForCategory,
  buildMappingResultFromCategory,
} from '../category-mapping'
import { BAS_REFERENCE } from '../bas-data'
import { makeTransaction } from '@/tests/helpers'
import type { TransactionCategory, VatTreatment } from '@/types'

describe('getCategoryAccountMapping', () => {
  describe('income_products uses correct account', () => {
    it('maps income_products to 3001 (25% moms)', () => {
      const result = getCategoryAccountMapping('income_products', 1000, true)
      expect(result.creditAccount).toBe('3001')
    })

    it('income_products matches income_services account', () => {
      const products = getCategoryAccountMapping('income_products', 1000, true)
      const services = getCategoryAccountMapping('income_services', 1000, true)
      expect(products.creditAccount).toBe(services.creditAccount)
    })
  })

  describe('expense_office maps to 6110 (Kontorsförbrukning)', () => {
    it('maps expense_office to 6110 (not 5010 Lokalhyra)', () => {
      const result = getCategoryAccountMapping('expense_office', -500, true)
      expect(result.debitAccount).toBe('6110')
    })
  })

  describe('expense_education entity-type-aware', () => {
    it('defaults to 6991 for enskild_firma', () => {
      const result = getCategoryAccountMapping('expense_education', -500, true, 'enskild_firma')
      expect(result.debitAccount).toBe('6991')
    })

    it('uses 7610 for aktiebolag', () => {
      const result = getCategoryAccountMapping('expense_education', -500, true, 'aktiebolag')
      expect(result.debitAccount).toBe('7610')
    })

    it('defaults to 6991 when no entityType provided', () => {
      const result = getCategoryAccountMapping('expense_education', -500, true)
      expect(result.debitAccount).toBe('6991')
    })
  })
})

describe('getExpenseAccountForCategory', () => {
  it('returns null for non-expense categories', () => {
    expect(getExpenseAccountForCategory('income_services')).toBeNull()
  })

  it('returns correct accounts for expense categories', () => {
    expect(getExpenseAccountForCategory('expense_equipment')).toBe('5410')
    expect(getExpenseAccountForCategory('expense_office')).toBe('6110')
    expect(getExpenseAccountForCategory('expense_bank_fees')).toBe('6570')
  })
})

describe('getDefaultAccountForCategory', () => {
  it('returns expense account for expense categories', () => {
    expect(getDefaultAccountForCategory('expense_equipment')).toBe('5410')
    expect(getDefaultAccountForCategory('expense_software')).toBe('5420')
    expect(getDefaultAccountForCategory('expense_travel')).toBe('5890')
    expect(getDefaultAccountForCategory('expense_office')).toBe('6110')
    expect(getDefaultAccountForCategory('expense_bank_fees')).toBe('6570')
  })

  it('returns income account for income categories', () => {
    expect(getDefaultAccountForCategory('income_services')).toBe('3001')
    expect(getDefaultAccountForCategory('income_products')).toBe('3001')
    expect(getDefaultAccountForCategory('income_other')).toBe('3999')
  })

  it('returns private account for enskild firma', () => {
    expect(getDefaultAccountForCategory('private', 'enskild_firma')).toBe('2013')
  })

  it('returns private account for aktiebolag', () => {
    expect(getDefaultAccountForCategory('private', 'aktiebolag')).toBe('2893')
  })

  it('returns entity-specific education account', () => {
    expect(getDefaultAccountForCategory('expense_education', 'enskild_firma')).toBe('6991')
    expect(getDefaultAccountForCategory('expense_education', 'aktiebolag')).toBe('7610')
  })

  it('returns fallback for uncategorized', () => {
    expect(getDefaultAccountForCategory('uncategorized')).toBe('6991')
  })
})

describe('buildMappingResultFromCategory', () => {
  describe('reverse charge handling', () => {
    it('generates fiktiv moms lines for reverse charge expense', () => {
      const tx = makeTransaction({ amount: -1000 })
      const result = buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'reverse_charge')

      expect(result.vat_lines).toHaveLength(2)

      const debitLine = result.vat_lines.find((l) => l.account_number === '2645')
      expect(debitLine).toBeDefined()
      expect(debitLine!.debit_amount).toBe(250)
      expect(debitLine!.credit_amount).toBe(0)

      const creditLine = result.vat_lines.find((l) => l.account_number === '2614')
      expect(creditLine).toBeDefined()
      expect(creditLine!.debit_amount).toBe(0)
      expect(creditLine!.credit_amount).toBe(250)
    })

    it('does not generate regular input VAT (2641) for reverse charge', () => {
      const tx = makeTransaction({ amount: -1000 })
      const result = buildMappingResultFromCategory('expense_equipment', tx, true, 'enskild_firma', 'reverse_charge')

      const hasRegularVat = result.vat_lines.some((l) => l.account_number === '2641')
      expect(hasRegularVat).toBe(false)
    })

    it('does not generate VAT lines for reverse charge on income', () => {
      const tx = makeTransaction({ amount: 1000 })
      const result = buildMappingResultFromCategory('income_services', tx, true, 'enskild_firma', 'reverse_charge')

      expect(result.vat_lines).toHaveLength(0)
    })

    it('does not generate VAT lines for reverse charge on private transactions', () => {
      const tx = makeTransaction({ amount: -1000 })
      const result = buildMappingResultFromCategory('expense_software', tx, false, 'enskild_firma', 'reverse_charge')

      expect(result.vat_lines).toHaveLength(0)
    })
  })
})

describe('buildMappingResultFromCategory vat_amount override (underlagets faktiska moms)', () => {
  // Real-world case: restaurant receipt 415.80 kr incl. dricks. The receipt's
  // actual 12% VAT is 42.43 kr: lower than rate-extraction 44.55 kr, because
  // dricks carries no moms. The override must win over the computed amount.
  it('uses the underlag VAT instead of rate-extraction for an expense', () => {
    const tx = makeTransaction({ amount: -415.8 })
    const result = buildMappingResultFromCategory(
      'expense_representation', tx, true, 'enskild_firma', 'reduced_12', 42.43,
    )

    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2641')
    expect(result.vat_lines[0].debit_amount).toBe(42.43)
    expect(result.vat_lines[0].description).toBe('Ingående moms (enligt underlag)')
  })

  it('without override the computed amount is unchanged (regression)', () => {
    const tx = makeTransaction({ amount: -415.8 })
    const result = buildMappingResultFromCategory(
      'expense_representation', tx, true, 'enskild_firma', 'reduced_12',
    )

    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].debit_amount).toBe(44.55)
    expect(result.vat_lines[0].description).toBe('Ingående moms 12%')
  })

  it('null override behaves like no override', () => {
    const tx = makeTransaction({ amount: -415.8 })
    const result = buildMappingResultFromCategory(
      'expense_representation', tx, true, 'enskild_firma', 'reduced_12', null,
    )
    expect(result.vat_lines[0].debit_amount).toBe(44.55)
  })

  it('rejects override 0, pointing to vat_treatment exempt', () => {
    // A 0-moms document is an exempt supply: booking it as a rate-bearing
    // treatment minus its VAT line would misclassify it in the momsdeklaration.
    const tx = makeTransaction({ amount: -500 })
    expect(() =>
      buildMappingResultFromCategory('expense_office', tx, true, 'enskild_firma', 'standard_25', 0),
    ).toThrow(/exempt/)
  })

  it('overrides output VAT on income', () => {
    const tx = makeTransaction({ amount: 1000 })
    const result = buildMappingResultFromCategory(
      'income_services', tx, true, 'enskild_firma', 'standard_25', 180,
    )

    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2611')
    expect(result.vat_lines[0].credit_amount).toBe(180)
    expect(result.vat_lines[0].description).toBe('Utgående moms (enligt underlag)')
  })

  it('rejects an override above the 25% extraction bound', () => {
    const tx = makeTransaction({ amount: -415.8 })
    // max possible Swedish VAT on 415.80 gross is 83.16 (25% extraction)
    expect(() =>
      buildMappingResultFromCategory('expense_representation', tx, true, 'enskild_firma', 'reduced_12', 100),
    ).toThrow(/exceeds the maximum possible Swedish VAT/)
  })

  it('rejects a negative override', () => {
    const tx = makeTransaction({ amount: -500 })
    expect(() =>
      buildMappingResultFromCategory('expense_office', tx, true, 'enskild_firma', 'standard_25', -1),
    ).toThrow(/positive/)
  })

  it('rejects an override combined with reverse_charge', () => {
    const tx = makeTransaction({ amount: -1000 })
    expect(() =>
      buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'reverse_charge', 50),
    ).toThrow(/cannot be combined/)
  })

  it('treatment incompatibility wins over the bound check (oversized + reverse_charge)', () => {
    const tx = makeTransaction({ amount: -1000 })
    // 500 also exceeds maxVat (200), but the agent's actual mistake is the
    // treatment: the error must say so, not complain about the amount.
    expect(() =>
      buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'reverse_charge', 500),
    ).toThrow(/cannot be combined/)
  })

  it('rejects an override on a VAT-less treatment', () => {
    const tx = makeTransaction({ amount: -1000 })
    expect(() =>
      buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'exempt', 50),
    ).toThrow(/cannot be combined/)
  })

  it('rejects an override on a VAT-exempt default category (bank fees)', () => {
    const tx = makeTransaction({ amount: -100 })
    expect(() =>
      buildMappingResultFromCategory('expense_bank_fees', tx, true, 'enskild_firma', undefined, 10),
    ).toThrow(/cannot be combined/)
  })

  it('rejects an override on private transactions', () => {
    const tx = makeTransaction({ amount: -500 })
    expect(() =>
      buildMappingResultFromCategory('private', tx, false, 'enskild_firma', undefined, 50),
    ).toThrow(/cannot be combined/)
  })
})

describe('buildMappingResultFromCategory returns non-empty accounts', () => {
  const allCategories: TransactionCategory[] = [
    'income_services',
    'income_products',
    'income_other',
    'expense_equipment',
    'expense_software',
    'expense_travel',
    'expense_office',
    'expense_marketing',
    'expense_professional_services',
    'expense_education',
    'expense_bank_fees',
    'expense_card_fees',
    'expense_currency_exchange',
    'expense_other',
    'private',
    'uncategorized',
  ]

  it.each(allCategories)('returns non-empty debit_account and credit_account for "%s"', (category) => {
    const tx = makeTransaction({ amount: category.startsWith('income') ? 1000 : -1000 })
    const isBusiness = category !== 'private'
    const result = buildMappingResultFromCategory(category, tx, isBusiness)

    expect(result.debit_account).toBeTruthy()
    expect(result.credit_account).toBeTruthy()
  })
})

describe('getDefaultVatTreatmentForCategory', () => {
  it('returns standard_25 for regular expense categories', () => {
    expect(getDefaultVatTreatmentForCategory('expense_equipment')).toBe('standard_25')
    expect(getDefaultVatTreatmentForCategory('expense_software')).toBe('standard_25')
    expect(getDefaultVatTreatmentForCategory('expense_travel')).toBe('standard_25')
  })

  it('returns standard_25 for income categories', () => {
    expect(getDefaultVatTreatmentForCategory('income_services')).toBe('standard_25')
    expect(getDefaultVatTreatmentForCategory('income_products')).toBe('standard_25')
  })

  it('returns null for VAT-exempt categories', () => {
    expect(getDefaultVatTreatmentForCategory('expense_bank_fees')).toBeNull()
    expect(getDefaultVatTreatmentForCategory('expense_card_fees')).toBeNull()
    expect(getDefaultVatTreatmentForCategory('expense_currency_exchange')).toBeNull()
  })

  it('returns null for private transactions', () => {
    expect(getDefaultVatTreatmentForCategory('private')).toBeNull()
  })

  it('returns null for uncategorized', () => {
    expect(getDefaultVatTreatmentForCategory('uncategorized')).toBeNull()
  })
})

describe('representation VAT (reduced 12%, ML 13 kap 24-25 §§)', () => {
  it('getDefaultVatTreatmentForCategory returns reduced_12 for representation', () => {
    expect(getDefaultVatTreatmentForCategory('expense_representation')).toBe('reduced_12')
  })

  it('getCategoryAccountMapping has vatTreatment: reduced_12 for representation', () => {
    const result = getCategoryAccountMapping('expense_representation', -500, true)
    expect(result.vatTreatment).toBe('reduced_12')
    expect(result.vatDebitAccount).toBe('2641')
  })

  it('buildMappingResultFromCategory generates 12% VAT line for representation', () => {
    const tx = makeTransaction({ amount: -500 })
    const result = buildMappingResultFromCategory('expense_representation', tx, true)
    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2641')
  })
})

describe('income account resolves by VAT treatment', () => {
  const cases: [VatTreatment, string][] = [
    ['standard_25', '3001'],
    ['reduced_12', '3002'],
    ['reduced_6', '3003'],
    ['export', '3305'],
    ['reverse_charge', '3308'],
    ['exempt', '3004'],
  ]

  it.each(cases)('income_services with %s maps to %s', (vat, expectedAccount) => {
    const result = getCategoryAccountMapping('income_services', 1000, true, 'enskild_firma', vat)
    expect(result.creditAccount).toBe(expectedAccount)
  })

  it.each(cases)('income_products with %s maps to %s', (vat, expectedAccount) => {
    const result = getCategoryAccountMapping('income_products', 1000, true, 'enskild_firma', vat)
    expect(result.creditAccount).toBe(expectedAccount)
  })

  it('income_other always returns 3999 regardless of VAT treatment', () => {
    for (const vat of ['standard_25', 'reduced_12', 'reduced_6', 'export', 'reverse_charge', 'exempt'] as VatTreatment[]) {
      const result = getCategoryAccountMapping('income_other', 1000, true, 'enskild_firma', vat)
      expect(result.creditAccount).toBe('3999')
    }
  })

  it('defaults to 3001 when no vatTreatment provided', () => {
    const result = getCategoryAccountMapping('income_services', 1000, true)
    expect(result.creditAccount).toBe('3001')
  })
})

describe('private transaction accounts by entity type and direction', () => {
  it('EF withdrawal (amount < 0) uses 2013', () => {
    const result = getCategoryAccountMapping('private', -500, false, 'enskild_firma')
    expect(result.debitAccount).toBe('2013')
    expect(result.creditAccount).toBe('1930')
  })

  it('EF deposit (amount > 0) uses 2018', () => {
    const result = getCategoryAccountMapping('private', 500, false, 'enskild_firma')
    expect(result.debitAccount).toBe('1930')
    expect(result.creditAccount).toBe('2018')
  })

  it('AB uses 2893 for both withdrawal and deposit', () => {
    const withdrawal = getCategoryAccountMapping('private', -500, false, 'aktiebolag')
    expect(withdrawal.debitAccount).toBe('2893')

    const deposit = getCategoryAccountMapping('private', 500, false, 'aktiebolag')
    expect(deposit.creditAccount).toBe('2893')
  })

  it('getDefaultAccountForCategory still returns 2013 for EF (default/withdrawal account)', () => {
    expect(getDefaultAccountForCategory('private', 'enskild_firma')).toBe('2013')
  })
})

describe('incoming expense refund (positive amount, expense category)', () => {
  it('getCategoryAccountMapping swaps accounts: bank debited, expense account credited', () => {
    const result = getCategoryAccountMapping('expense_software', 500, true)
    expect(result.debitAccount).toBe('1930')
    expect(result.creditAccount).toBe('5420')
  })

  it('getCategoryAccountMapping sets vatCreditAccount 2641 and clears vatDebitAccount for refund', () => {
    const result = getCategoryAccountMapping('expense_software', 500, true)
    expect(result.vatDebitAccount).toBeNull()
    expect(result.vatCreditAccount).toBe('2641')
  })

  it('VAT-exempt expense refund (bank_fees) has no VAT accounts', () => {
    const result = getCategoryAccountMapping('expense_bank_fees', 100, true)
    expect(result.debitAccount).toBe('1930')
    expect(result.creditAccount).toBe('6570')
    expect(result.vatDebitAccount).toBeNull()
    expect(result.vatCreditAccount).toBeNull()
  })

  it('buildMappingResultFromCategory generates credit line on 2641 for expense refund', () => {
    const tx = makeTransaction({ amount: 1000 })
    const result = buildMappingResultFromCategory('expense_software', tx, true)
    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].account_number).toBe('2641')
    expect(result.vat_lines[0].credit_amount).toBe(200)
    expect(result.vat_lines[0].debit_amount).toBe(0)
  })

  it('buildMappingResultFromCategory uses återföring description for expense refund VAT', () => {
    const tx = makeTransaction({ amount: 1000 })
    const result = buildMappingResultFromCategory('expense_software', tx, true)
    expect(result.vat_lines[0].description).toBe('Återföring ingående moms 25%')
  })

  it('buildMappingResultFromCategory generates no VAT line for VAT-exempt expense refund', () => {
    const tx = makeTransaction({ amount: 100 })
    const result = buildMappingResultFromCategory('expense_bank_fees', tx, true)
    expect(result.vat_lines).toHaveLength(0)
  })

  it('buildMappingResultFromCategory maps debit/credit correctly (bank debited, expense credited)', () => {
    const tx = makeTransaction({ amount: 1250 })
    const result = buildMappingResultFromCategory('expense_software', tx, true)
    expect(result.debit_account).toBe('1930')
    expect(result.credit_account).toBe('5420')
  })

  it('vat_amount override on expense refund uses återföring description', () => {
    const tx = makeTransaction({ amount: 1250 })
    const result = buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'standard_25', 200)
    expect(result.vat_lines).toHaveLength(1)
    expect(result.vat_lines[0].credit_amount).toBe(200)
    expect(result.vat_lines[0].description).toBe('Återföring ingående moms (enligt underlag)')
  })
})

describe('category default → leaf account guarantee', () => {
  // BAS encodes the parent/leaf distinction in account_name via the
  // "(gruppkonto)" suffix. Auditors and Skatteverket downstream reporting
  // expect postings on leaves, not headers: see migration 03d4b740.
  const groupAccountNumbers = new Set<string>()
  for (const acct of BAS_REFERENCE) {
    if (acct.account_name.includes('(gruppkonto)')) {
      groupAccountNumbers.add(acct.account_number)
    }
  }

  const categoriesUnderGuard: TransactionCategory[] = [
    'income_services',
    'income_products',
    'income_other',
    'expense_equipment',
    'expense_software',
    'expense_travel',
    'expense_office',
    'expense_marketing',
    'expense_professional_services',
    'expense_representation',
    'expense_consumables',
    'expense_vehicle',
    'expense_telecom',
    'expense_education',
    'expense_bank_fees',
    'expense_card_fees',
    'expense_currency_exchange',
    'expense_other',
    'private',
    'uncategorized',
  ]

  it.each(categoriesUnderGuard)('%s default does not resolve to a gruppkonto', (category) => {
    const target = getDefaultAccountForCategory(category)
    expect(groupAccountNumbers.has(target)).toBe(false)
  })

  it('uncategorized positive amount does not credit a gruppkonto', () => {
    const result = getCategoryAccountMapping('uncategorized', 1000, true)
    expect(groupAccountNumbers.has(result.creditAccount)).toBe(false)
  })

  it('expense_telecom resolves to 6230 (Datakommunikation, leaf)', () => {
    expect(getDefaultAccountForCategory('expense_telecom')).toBe('6230')
  })

  it('expense_travel resolves to 5890 (Övriga resekostnader, leaf)', () => {
    expect(getDefaultAccountForCategory('expense_travel')).toBe('5890')
  })

  it('income_other resolves to 3999 (Övriga rörelseintäkter, leaf)', () => {
    expect(getDefaultAccountForCategory('income_other')).toBe('3999')
  })
})

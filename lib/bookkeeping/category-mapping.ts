import type { TransactionCategory, MappingResult, VatJournalLine, Transaction, EntityType, VatTreatment } from '@/types'
import { getVatRate, generateReverseChargeLines } from './vat-entries'

/**
 * Maps TransactionCategory to BAS accounts for journal entry creation
 *
 * Account mapping follows Swedish BAS Kontoplan:
 * - 1xxx: Assets
 * - 2xxx: Equity & Liabilities
 * - 3xxx: Revenue
 * - 4xxx: Cost of goods sold
 * - 5xxx: External expenses
 * - 6xxx: Other external expenses
 * - 7xxx: Personnel costs
 * - 8xxx: Financial items
 *
 * Key differences between entity types:
 * - Enskild Firma: Uses 2013 (Eget uttag) for private withdrawals
 * - Aktiebolag: Uses 2893 (Skuld till aktieägare) for owner transactions
 */

interface CategoryAccountMapping {
  debitAccount: string
  creditAccount: string
  vatTreatment: string | null
  vatDebitAccount: string | null
  vatCreditAccount: string | null
}

// Default bank account - typically 1930 (Företagskonto/checkkonto)
const BANK_ACCOUNT = '1930'

// Private/owner transaction accounts by entity type
const PRIVATE_ACCOUNTS: Record<EntityType, string> = {
  enskild_firma: '2013',  // Övriga egna uttag
  aktiebolag: '2893',     // Skuld till aktieägare/delägare
}

// Single source of truth for category -> expense account mapping
const EXPENSE_ACCOUNTS: Record<string, string> = {
  expense_equipment: '5410',           // Förbrukningsinventarier
  expense_software: '5420',            // Programvaror
  expense_travel: '5890',              // Övriga resekostnader (5800 är gruppkonto)
  expense_office: '6110',              // Kontorsförbrukning
  expense_marketing: '5910',           // Annonsering
  expense_professional_services: '6530', // Redovisningstjänster
  expense_representation: '6071',      // Representation, avdragsgill
  expense_consumables: '5460',         // Förbrukningsvaror
  expense_vehicle: '5611',             // Drivmedel bil
  expense_telecom: '6230',             // Datakommunikation (6200 är gruppkonto)
  expense_bank_fees: '6570',           // Bankavgifter
  expense_card_fees: '6570',           // Kortavgifter
  expense_currency_exchange: '7960',   // Valutakursförluster
  expense_other: '6991',              // Övriga avdragsgilla kostnader
}

// Income account mapping
const INCOME_ACCOUNTS: Record<string, string> = {
  income_services: '3001',  // Försäljning tjänster 25%
  income_products: '3001',  // Försäljning varor 25% moms
  income_other: '3999',     // Övriga rörelseintäkter (3900 är gruppkonto)
}

/**
 * Get the expense account for a category, with entity-specific overrides.
 * Education (expense_education) differs: AB uses 7610, EF uses 6991.
 */
function getExpenseAccount(category: string, entityType: EntityType = 'enskild_firma'): string {
  if (category === 'expense_education') {
    return entityType === 'aktiebolag' ? '7610' : '6991'
  }
  return EXPENSE_ACCOUNTS[category] || '6991'
}

/**
 * Get the income account for a category, resolving by VAT treatment.
 * BAS mandates revenue account segregation by VAT rate:
 * 3001=25%, 3002=12%, 3003=6%, 3305=Export, 3308=EU services, 3004=Exempt.
 */
function getIncomeAccount(category: string, vatTreatment?: VatTreatment): string {
  // income_other always maps to 3999 regardless of VAT treatment (3900 är gruppkonto)
  if (category === 'income_other') return '3999'

  if (vatTreatment) {
    switch (vatTreatment) {
      case 'standard_25': return '3001'
      case 'reduced_12': return '3002'
      case 'reduced_6': return '3003'
      case 'export': return '3305'
      case 'reverse_charge': return '3308'
      case 'exempt': return '3004'
    }
  }

  // No vatTreatment provided — fall back to static mapping
  return INCOME_ACCOUNTS[category] || '3999'
}

/**
 * Get account mapping for a transaction category
 *
 * For expenses: Debit expense account, Credit bank (or private for non-business)
 * For income: Debit bank, Credit revenue account
 */
export function getCategoryAccountMapping(
  category: TransactionCategory,
  amount: number,
  isBusiness: boolean,
  entityType: EntityType = 'enskild_firma',
  vatTreatment?: VatTreatment
): CategoryAccountMapping {
  // Private/owner transactions use entity-specific accounts
  // EF: 2013 for withdrawals (uttag), 2018 for deposits (insättningar)
  // AB: 2893 for both directions
  if (!isBusiness) {
    let privateAccount: string
    if (entityType === 'enskild_firma') {
      privateAccount = amount < 0 ? '2013' : '2018'
    } else {
      privateAccount = PRIVATE_ACCOUNTS[entityType] || PRIVATE_ACCOUNTS.enskild_firma
    }
    return {
      debitAccount: amount < 0 ? privateAccount : BANK_ACCOUNT,
      creditAccount: amount < 0 ? BANK_ACCOUNT : privateAccount,
      vatTreatment: null,
      vatDebitAccount: null,
      vatCreditAccount: null,
    }
  }

  // Check if it's an expense category
  if (category.startsWith('expense_')) {
    const expenseAccount = getExpenseAccount(category, entityType)

    // Bank fees, card fees, and currency exchange are VAT-exempt in Sweden
    const vatExemptCategories = ['expense_bank_fees', 'expense_card_fees', 'expense_currency_exchange']
    const isVatExempt = vatExemptCategories.includes(category)

    // Representation defaults to reduced_12 (ML 13 kap 24-25 §§, max 300 SEK/person).
    // Note: income tax deduction was abolished 2017 (IL 16 kap 2 §), but VAT deduction remains.
    const resolvedVat = vatTreatment ?? (isVatExempt ? null : category === 'expense_representation' ? 'reduced_12' : 'standard_25')

    return {
      debitAccount: expenseAccount,
      creditAccount: BANK_ACCOUNT,
      vatTreatment: resolvedVat,
      vatDebitAccount: resolvedVat ? '2641' : null, // Debiterad ingående moms
      vatCreditAccount: null,
    }
  }

  // Check if it's an income category
  if (category.startsWith('income_')) {
    const incomeAccount = getIncomeAccount(category, vatTreatment)

    // Use provided vatTreatment, or default to standard_25
    const resolvedVat = vatTreatment ?? 'standard_25'

    // Determine output VAT account based on rate
    let outputVatAccount: string | null = null
    switch (resolvedVat) {
      case 'standard_25':
        outputVatAccount = '2611' // Utgående moms försäljning 25%
        break
      case 'reduced_12':
        outputVatAccount = '2621' // Utgående moms försäljning 12%
        break
      case 'reduced_6':
        outputVatAccount = '2631' // Utgående moms försäljning 6%
        break
      default:
        outputVatAccount = null
        break
    }

    return {
      debitAccount: BANK_ACCOUNT,
      creditAccount: incomeAccount,
      vatTreatment: resolvedVat,
      vatDebitAccount: null,
      vatCreditAccount: outputVatAccount,
    }
  }

  // Uncategorized - default to misc expense/income based on amount
  if (amount < 0) {
    return {
      debitAccount: '6991',
      creditAccount: BANK_ACCOUNT,
      vatTreatment: null,
      vatDebitAccount: null,
      vatCreditAccount: null,
    }
  } else {
    return {
      debitAccount: BANK_ACCOUNT,
      creditAccount: '3999',
      vatTreatment: null,
      vatDebitAccount: null,
      vatCreditAccount: null,
    }
  }
}

/**
 * Build a MappingResult from a category selection
 * Used by the categorization API to create journal entries
 */
export function buildMappingResultFromCategory(
  category: TransactionCategory,
  transaction: Transaction,
  isBusiness: boolean,
  entityType: EntityType = 'enskild_firma',
  vatTreatment?: VatTreatment
): MappingResult {
  const mapping = getCategoryAccountMapping(category, transaction.amount, isBusiness, entityType, vatTreatment)

  const vatLines: VatJournalLine[] = []

  // Calculate VAT if applicable using the resolved treatment from mapping
  const treatment = mapping.vatTreatment as VatTreatment | null
  if (isBusiness && treatment) {
    const vatRate = getVatRate(treatment)
    if (treatment === 'reverse_charge' && transaction.amount < 0) {
      // EU reverse charge: fiktiv moms (offsetting entries)
      const absAmount = Math.abs(transaction.amount)
      const rcLines = generateReverseChargeLines(absAmount)
      for (const rcl of rcLines) {
        vatLines.push({
          account_number: rcl.account_number,
          debit_amount: rcl.debit_amount,
          credit_amount: rcl.credit_amount,
          description: rcl.line_description || '',
        })
      }
    } else if (vatRate > 0) {
      const grossAmount = Math.abs(transaction.amount)
      const vatAmount = Math.round((grossAmount * vatRate / (1 + vatRate)) * 100) / 100

      if (transaction.amount < 0 && mapping.vatDebitAccount) {
        // Expense: Ingående moms (deductible VAT)
        vatLines.push({
          account_number: mapping.vatDebitAccount,
          debit_amount: vatAmount,
          credit_amount: 0,
          description: `Ingående moms ${vatRate * 100}%`,
        })
      } else if (transaction.amount > 0 && mapping.vatCreditAccount) {
        // Income: Utgående moms (output VAT)
        vatLines.push({
          account_number: mapping.vatCreditAccount,
          debit_amount: 0,
          credit_amount: vatAmount,
          description: `Utgående moms ${vatRate * 100}%`,
        })
      }
    }
  }

  // Generate description
  const categoryLabels: Record<TransactionCategory, string> = {
    income_services: 'Tjänsteförsäljning',
    income_products: 'Varuförsäljning',
    income_other: 'Övrig intäkt',
    expense_equipment: 'Förbrukningsinventarier',
    expense_software: 'Programvara',
    expense_travel: 'Resekostnad',
    expense_office: 'Kontorskostnad',
    expense_marketing: 'Marknadsföring',
    expense_professional_services: 'Konsulttjänst',
    expense_education: 'Utbildning',
    expense_representation: 'Representation',
    expense_consumables: 'Förbrukningsvaror',
    expense_vehicle: 'Bil & drivmedel',
    expense_telecom: 'Telefon & internet',
    expense_bank_fees: 'Bankavgift',
    expense_card_fees: 'Kortavgift',
    expense_currency_exchange: 'Valutaväxling',
    expense_other: 'Övrig kostnad',
    private: 'Privat',
    uncategorized: 'Okategoriserad',
  }

  const description = isBusiness
    ? `${categoryLabels[category] || category}: ${transaction.description}`
    : `Privat: ${transaction.description}`

  return {
    rule: null,
    debit_account: mapping.debitAccount,
    credit_account: mapping.creditAccount,
    risk_level: 'LOW',
    confidence: 1.0, // User explicitly categorized
    requires_review: false,
    default_private: !isBusiness,
    vat_lines: vatLines,
    description,
  }
}

/**
 * Get the expense account number for a category
 * Useful for creating mapping rules
 */
export function getExpenseAccountForCategory(category: TransactionCategory): string | null {
  if (category === 'expense_education') return '6991'
  return EXPENSE_ACCOUNTS[category] || null
}

/**
 * Get the default account number for a category.
 * For expense categories: returns the expense account (debit side).
 * For income categories: returns the revenue account (credit side).
 * For private/uncategorized: returns the entity-specific private or fallback account.
 */
export function getDefaultAccountForCategory(
  category: TransactionCategory,
  entityType: EntityType = 'enskild_firma'
): string {
  if (category === 'private') {
    return PRIVATE_ACCOUNTS[entityType] || PRIVATE_ACCOUNTS.enskild_firma
  }

  if (category.startsWith('expense_')) {
    return getExpenseAccount(category, entityType)
  }

  if (category.startsWith('income_')) {
    return INCOME_ACCOUNTS[category] || '3999'
  }

  // uncategorized
  return '6991'
}

/**
 * Get the default VAT treatment for a category.
 * Bank fees, card fees, and currency exchange are VAT-exempt.
 * All other business categories default to standard 25%.
 */
export function getDefaultVatTreatmentForCategory(
  category: TransactionCategory
): VatTreatment | null {
  if (category === 'private' || category === 'uncategorized') {
    return null
  }

  const vatExemptCategories = ['expense_bank_fees', 'expense_card_fees', 'expense_currency_exchange']
  if (vatExemptCategories.includes(category)) {
    return null
  }

  // Representation defaults to reduced_12 (ML 13 kap 24-25 §§, max 300 SEK/person).
  // Note: income tax deduction was abolished 2017 (IL 16 kap 2 §), but VAT deduction remains.
  if (category === 'expense_representation') {
    return 'reduced_12'
  }

  return 'standard_25'
}

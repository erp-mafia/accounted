import type { TransactionCategory, MappingResult, VatJournalLine, Transaction, EntityType, VatTreatment } from '@/types'
import {
  getVatRate,
  generateReverseChargePurchaseLines,
  DEFAULT_REVERSE_CHARGE_KIND,
  type ReverseChargeKind,
} from './vat-entries'
import { resolveSekAmount } from './currency-utils'
import { roundOre } from '@/lib/money'
import { grossVat } from '@/lib/bookkeeping/gross-split'
import { ownerSettlementAccount, templateAccountForForm } from '@/lib/company/entity-type'
import {
  isNotVatRegistered,
  vatTreatmentForRegistration,
  type VatRegistration,
} from './vat-registration'

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

// Private/owner transaction accounts live in lib/company/entity-type.ts
// (ownerSettlementAccount): EF 2013/2018, AB 2893, ideell förening 2890.

// Single source of truth for category -> expense account mapping
const EXPENSE_ACCOUNTS: Record<string, string> = {
  expense_equipment: '5410',           // Förbrukningsinventarier
  expense_software: '5420',            // Programvaror
  expense_travel: '5890',              // Övriga resekostnader (5800 är gruppkonto)
  expense_office: '6110',              // Kontorsförbrukning
  expense_marketing: '5910',           // Annonsering
  expense_professional_services: '6530', // Redovisningstjänster
  // Representation, ej avdragsgill: what this category books is nearly always
  // a meal, which is not income-tax deductible since 2017 (IL 16 kap. 2 §).
  // 6071 (avdragsgill) is for enklare förtäring and the like (accounted#86).
  expense_representation: '6072',
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
function getExpenseAccount(category: string, entityType: EntityType): string {
  if (category === 'expense_education') {
    // 7610 is a personnel cost: only a form with employees by default books
    // education there; the others take the general external-cost account.
    // A form that books like an aktiebolag (templateColumn 'ab') has
    // employees; the others take the general account.
    return templateAccountForForm(entityType, '6991', '7610') ?? '6991'
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

  // No vatTreatment provided: fall back to static mapping
  return INCOME_ACCOUNTS[category] || '3999'
}

/**
 * What a business category books on its own: an expense category takes money
 * out (debit the cost account, credit the bank), an income category brings
 * money in (debit the bank, credit the revenue account).
 */
type CategoryNature = 'expense' | 'income'

function categoryNature(category: TransactionCategory): CategoryNature | null {
  if (category.startsWith('expense_')) return 'expense'
  if (category.startsWith('income_')) return 'income'
  return null
}

/**
 * True when a bank row runs against its category: money IN on an expense
 * category (the supplier pays back) or money OUT on an income category (the
 * customer is paid back). Such a row is the reversal of the category's own
 * booking, never a booking of the opposite kind: the same accounts on the
 * opposite sides, the moms taken back on the account it was booked on
 * (swedish-daily-bookkeeping, payment-providers.md §10: a refund of a sale
 * reverses the original entry, debit 30xx and 26xx; swedish-invoice-compliance,
 * invoice-rules.md §5: mirror reversal of the original, both for the seller
 * and for the buyer). A zero amount has no direction and books as the
 * category itself.
 */
export function isCategoryReversal(category: TransactionCategory, amount: number): boolean {
  const nature = categoryNature(category)
  if (nature === 'expense') return amount > 0
  if (nature === 'income') return amount < 0
  return false
}

/**
 * Whether a reverse-charge treatment on this row books the buyer's
 * self-assessment (fiktiv moms and the basis pair): only a purchase, money
 * out on an expense category. A sale under reverse charge carries no Swedish
 * moms in either direction (the buyer accounts for it), and a refund from a
 * supplier books no set here.
 */
export function booksReverseChargePurchase(category: TransactionCategory, amount: number): boolean {
  return categoryNature(category) === 'expense' && amount < 0
}

/**
 * The sides of a business category on a bank row: the one place the sign of
 * the amount meets the category's nature. The business account sits on its
 * own side (debit for an expense, credit for an income) and on the opposite
 * side for a reversal; the bank takes the other side, and the moms account
 * stands beside the business account, so a reversal takes the moms back on
 * the account it was booked on:
 *
 *   expense, money out   D cost     D 2641    K bank   (a purchase)
 *   expense, money in    D bank     K cost    K 2641   (the supplier refunds)
 *   income, money in     D bank     K revenue K 26x1   (a sale)
 *   income, money out    D revenue  D 26x1    K bank   (the customer is refunded)
 *
 * The momsdeklaration reads each box off the account's balance
 * (lib/reports/vat-declaration.ts ACCOUNT_RUTA), so a debit on 2611 lowers
 * ruta 10 and a debit on 3001 lowers ruta 05 without any tag on the line.
 */
function orientBusinessMapping(
  nature: CategoryNature,
  reversal: boolean,
  businessAccount: string,
  vatTreatment: string | null,
  vatAccount: string | null,
): CategoryAccountMapping {
  const businessOnDebit = (nature === 'expense') !== reversal
  return {
    debitAccount: businessOnDebit ? businessAccount : BANK_ACCOUNT,
    creditAccount: businessOnDebit ? BANK_ACCOUNT : businessAccount,
    vatTreatment,
    vatDebitAccount: businessOnDebit ? vatAccount : null,
    vatCreditAccount: businessOnDebit ? null : vatAccount,
  }
}

/**
 * Get account mapping for a transaction category
 *
 * For expenses: Debit expense account, Credit bank (or private for non-business)
 * For income: Debit bank, Credit revenue account
 * A row against the category's direction is its reversal (isCategoryReversal).
 *
 * `vatRegistered` is company_settings.vat_registered: an explicit false
 * resolves every rate-bearing treatment to exempt (no 2641, no 26xx, income
 * on the momsfri account), see lib/bookkeeping/vat-registration.ts.
 */
export function getCategoryAccountMapping(
  category: TransactionCategory,
  amount: number,
  isBusiness: boolean,
  entityType: EntityType,
  vatTreatment?: VatTreatment,
  vatRegistered?: VatRegistration
): CategoryAccountMapping {
  // Private/owner transactions use entity-specific accounts
  // EF: 2013 for withdrawals (uttag), 2018 for deposits (insättningar)
  // AB: 2893 for both directions; ideell förening: 2890 (no owner)
  if (!isBusiness) {
    const privateAccount = ownerSettlementAccount(entityType, amount < 0 ? 'withdrawal' : 'contribution')
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
    const resolvedVat = vatTreatmentForRegistration(
      vatTreatment ?? (isVatExempt ? null : category === 'expense_representation' ? 'reduced_12' : 'standard_25'),
      vatRegistered,
    )

    // Debiterad ingående moms (2641): debited on a purchase, credited back
    // when the supplier refunds.
    return orientBusinessMapping(
      'expense',
      isCategoryReversal(category, amount),
      expenseAccount,
      resolvedVat,
      resolvedVat ? '2641' : null,
    )
  }

  // Check if it's an income category
  if (category.startsWith('income_')) {
    // Use provided vatTreatment, or default to standard_25
    const resolvedVat = vatTreatmentForRegistration(vatTreatment ?? 'standard_25', vatRegistered)
    // A non-registered company's sale carries no moms, which is what the
    // exempt revenue account (3004) says; a registered company keeps the
    // static fallback for an omitted treatment.
    const incomeAccount = getIncomeAccount(
      category,
      isNotVatRegistered(vatRegistered) ? resolvedVat : vatTreatment,
    )

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

    // Utgående moms: credited on a sale, debited back on the same account
    // when the customer is refunded (crm#1136: this branch used to ignore the
    // sign, so money out booked as a sale with no moms).
    return orientBusinessMapping(
      'income',
      isCategoryReversal(category, amount),
      incomeAccount,
      resolvedVat,
      outputVatAccount,
    )
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
 *
 * `vatAmountOverride` is the underlag's actual VAT when it differs from the
 * rate-derived amount: e.g. a restaurant receipt where dricks carries no
 * moms, so the document's VAT is lower than rate × gross. It can only replace
 * a rate-based VAT line (standard_25/reduced_12/reduced_6); it never applies
 * to fictive reverse-charge VAT and never conjures a line for treatments
 * without VAT. Zero is rejected: a document with no moms is an exempt supply
 * and must be booked with vat_treatment "exempt" so the momsdeklaration sees
 * the correct classification, not a rate-bearing treatment minus its VAT line.
 *
 * Currency: `vatAmountOverride` is denominated in the TRANSACTION's currency,
 * exactly like `transaction.amount` (it is the figure printed on the underlag).
 * All journal entry lines are SEK, so every VAT figure here goes through the
 * same SEK resolution buildTransactionEntryLines applies to the gross. Before
 * this, a 15.87 USD override validated against the USD gross but posted as
 * 15.87 kr: the entry balanced (the net line absorbed the difference), so
 * nothing downstream could detect the wrong 26xx figure.
 *
 * `reverseChargeKind` picks the basis account of a reverse-charge purchase
 * (ruta 20 EU goods, 21 EU services, 22 non-EU services). A bank line says
 * nothing reliable about the seller's country, so without an explicit kind the
 * purchase books as EU services, the same default the mapping rules use. The
 * basis pair is always booked here: whether the account the cost line finally
 * lands on reports ruta 20-24 itself, and at which momssats, is settled with
 * the company's chart by reconcileRcBasisWithChart
 * (lib/bookkeeping/rc-basis-reconcile.ts).
 */
export function buildMappingResultFromCategory(
  category: TransactionCategory,
  transaction: Transaction,
  isBusiness: boolean,
  entityType: EntityType,
  vatTreatment?: VatTreatment,
  vatAmountOverride?: number | null,
  vatRegistered?: VatRegistration,
  reverseChargeKind?: ReverseChargeKind | null,
): MappingResult {
  const mapping = getCategoryAccountMapping(
    category, transaction.amount, isBusiness, entityType, vatTreatment, vatRegistered,
  )

  const vatLines: VatJournalLine[] = []

  // Calculate VAT if applicable using the resolved treatment from mapping
  const treatment = mapping.vatTreatment as VatTreatment | null
  const hasVatOverride = vatAmountOverride !== undefined && vatAmountOverride !== null

  if (hasVatOverride && isBusiness && isNotVatRegistered(vatRegistered)) {
    // Mirrors the supplier-invoice guard: the moms on the underlag is part of
    // the cost for a company with no deduction right, never a 2641 line.
    throw new Error(
      'vat_amount cannot be booked for a company that is not VAT-registered: it has no deduction ' +
      'right for input VAT (13 kap. ML 2023:200), so the moms on the underlag is part of the cost.'
    )
  }

  // Journal entry lines are SEK; transaction.amount is in transaction.currency.
  // buildTransactionEntryLines nets these VAT lines against the strict
  // resolution of the gross, which agrees with this lenient one on every row
  // it books: the two differ only on a foreign row with no SEK value, and that
  // row is refused there (TX_MISSING_SEK_VALUE) before any line is posted.
  const absAmount = Math.abs(transaction.amount)
  const absSekAmount = Math.abs(resolveSekAmount(
    transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate
  ))

  if (hasVatOverride) {
    // Treatment compatibility first: an invalid override on reverse_charge is
    // a treatment problem, not an amount problem: the agent should get the
    // correction hint that matches the actual mistake.
    if (!isBusiness || !treatment || treatment === 'reverse_charge' || getVatRate(treatment) <= 0) {
      throw new Error(
        `vat_amount cannot be combined with vat_treatment "${treatment ?? 'none'}": ` +
        'it only overrides a rate-based VAT line (standard_25, reduced_12, reduced_6).'
      )
    }
    // typeof re-check is deliberate: at commit time the override comes from
    // jsonb params, so the TS signature doesn't guarantee a number at runtime.
    if (typeof vatAmountOverride !== 'number' || !Number.isFinite(vatAmountOverride) || vatAmountOverride <= 0) {
      throw new Error(
        `vat_amount must be a positive number, got ${vatAmountOverride}. ` +
        'For a document with no moms, use vat_treatment "exempt" instead of vat_amount 0.'
      )
    }
    // 25% is the highest Swedish VAT rate, so rate-extraction at 25% bounds
    // any legitimate document VAT: even on mixed-rate receipts. The bound and
    // the override share the transaction's currency (both come off the
    // underlag), so the comparison stays in that currency.
    const maxVat = grossVat(absAmount, 0.25)
    if (vatAmountOverride > maxVat) {
      const currencyTag = transaction.currency && transaction.currency !== 'SEK'
        ? ` ${transaction.currency}` : ''
      throw new Error(
        `vat_amount ${vatAmountOverride} exceeds the maximum possible Swedish VAT on ${absAmount}${currencyTag} ` +
        `(${maxVat}${currencyTag} at 25%). vat_amount is denominated in the transaction's currency, like belopp. ` +
        `Check the underlag: the override must be the document's actual moms.`
      )
    }
  }

  // A row against the category's direction: the reversal of its own booking.
  const reversal = isBusiness && isCategoryReversal(category, transaction.amount)

  if (isBusiness && treatment) {
    const vatRate = getVatRate(treatment)
    if (treatment === 'reverse_charge' && booksReverseChargePurchase(category, transaction.amount)) {
      // Reverse charge: the complete set, fiktiv moms (2645/2614) AND the
      // basis pair (45xx/4598) for ruta 20-22, 25% of the SEK value: an EUR
      // invoice's fiktiv moms posted off the EUR figure would understate
      // 2614/2645 by the exchange rate. Only a purchase self-assesses: money
      // out on an income category is a refund of a sale that carried no
      // Swedish moms, so it books none either.
      const rcLines = generateReverseChargePurchaseLines({
        base: absSekAmount,
        kind: reverseChargeKind ?? DEFAULT_REVERSE_CHARGE_KIND,
      })
      for (const rcl of rcLines) {
        vatLines.push({
          account_number: rcl.account_number,
          debit_amount: rcl.debit_amount,
          credit_amount: rcl.credit_amount,
          description: rcl.line_description || '',
        })
      }
    } else if (vatRate > 0) {
      // Override: scale from transaction currency to SEK by the same ratio
      // the gross resolved at (amount_sek embeds the bank's actual settlement
      // rate, so a plain exchange_rate multiply could disagree with the gross
      // line). absAmount > 0 is guaranteed here: a positive override on a
      // zero-amount transaction already failed the maxVat bound above.
      const vatAmount = hasVatOverride
        ? roundOre((vatAmountOverride as number) * (absSekAmount / absAmount))
        : grossVat(absSekAmount, vatRate)

      // One moms line, on the account and the side getCategoryAccountMapping
      // gave it: beside the business line, so debited when money goes out
      // (ingående moms on a purchase, utgående moms taken back on a refund of
      // a sale) and credited when money comes in (utgående moms on a sale,
      // ingående moms taken back when the supplier refunds).
      const vatAccount = mapping.vatDebitAccount ?? mapping.vatCreditAccount
      if (vatAmount > 0 && vatAccount) {
        const isInputVat = vatAccount === '2641'
        const label = reversal
          ? (isInputVat ? 'Återföring ingående moms' : 'Återföring utgående moms')
          : (isInputVat ? 'Ingående moms' : 'Utgående moms')
        vatLines.push({
          account_number: vatAccount,
          debit_amount: mapping.vatDebitAccount ? vatAmount : 0,
          credit_amount: mapping.vatDebitAccount ? 0 : vatAmount,
          description: hasVatOverride ? `${label} (enligt underlag)` : `${label} ${vatRate * 100}%`,
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
    // A refund books the category's accounts on the opposite sides. Learned as
    // a rule or a counterparty template, that pair would propose every later
    // purchase or sale from the same counterparty backwards, so no learner
    // takes it (the flag saveUserMappingRule's callers and
    // upsertCounterpartyTemplate already read for a mirrored template match).
    ...(reversal ? { direction_mismatch: true } : {}),
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
  entityType: EntityType
): string {
  if (category === 'private') {
    return ownerSettlementAccount(entityType, 'withdrawal')
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
 * All other business categories default to standard 25%, resolved to exempt
 * for a company that is not VAT-registered (lib/bookkeeping/vat-registration.ts).
 */
export function getDefaultVatTreatmentForCategory(
  category: TransactionCategory,
  vatRegistered?: VatRegistration
): VatTreatment | null {
  return vatTreatmentForRegistration(defaultVatTreatmentForCategory(category), vatRegistered)
}

function defaultVatTreatmentForCategory(category: TransactionCategory): VatTreatment | null {
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

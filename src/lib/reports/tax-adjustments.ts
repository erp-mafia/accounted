/**
 * Tax adjustments the books themselves give, in the ledger kernel: the BAS
 * accounts the chart names as not deductible or not taxable, read from every
 * voucher of the year but the resultatavslut, and the figures saved for the
 * year in fiscal_period_tax_adjustments. INK2S (4.3b/c, 4.5b/c) and the
 * NE-bilaga (R13, R14) read this one detection, so a representation cost or
 * the skattekonto's interest is adjusted the same way on both forms. The
 * year-end block (lib/bokslut/tax-provision/tax-adjustment-service.ts) adds
 * the underskottsregister on top and saves the user's choices.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType, TrialBalanceRow } from '@/types'
import { equalOre, roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { resolveCompanyEntityType, supportsMemberCapital } from '@/lib/company/entity-type'

export type TaxAdjustmentType =
  | 'non_deductible_expense'
  | 'non_taxable_income'
  /** INK2S 4.14 a: outnyttjat underskott från föregående beskattningsår (IL 40 kap. 2 §). */
  | 'deficit_carryforward'
export type TaxAdjustmentSource = 'detected' | 'manual'

/** INK2S rows a detected adjustment can be filed on besides 4.3c and 4.5c: 4.3b and 4.5b. */
export type TaxAdjustmentInk2sField = '7652' | '7753'

export interface TaxAdjustmentItem {
  sourceKey: string
  source: TaxAdjustmentSource
  adjustmentType: TaxAdjustmentType
  description: string
  accountNumber: string | null
  amount: number
  included: boolean
  /** Detected, but counts only once the user ticks it (dividends, crm#1726). */
  needsConfirmation?: boolean
  /** Filed on INK2S 4.3b (7652) or 4.5b (7753) instead of 4.3c or 4.5c. */
  ink2sField?: TaxAdjustmentInk2sField
}

/** The year's adjustments and their sums, before any underskottsregister. */
export interface TaxAdjustmentSums {
  items: TaxAdjustmentItem[]
  nonDeductibleExpenses: number
  nonTaxableIncome: number
  /** Prior years' unused deficit deducted this year (INK2S 4.14 a, SRU 7763). */
  deficitCarryforward: number
  /** The part of nonDeductibleExpenses filed on INK2S 4.3b (write-downs of financial assets). */
  financialWriteDowns?: number
  /** The part of nonTaxableIncome filed on INK2S 4.5b (dividends). */
  dividends?: number
}

export interface DetectedTaxAdjustmentAccount {
  accountNumber: string
  sourceKey: string
  adjustmentType: TaxAdjustmentType
  description: string
  /**
   * The INK2S row the amount is filed on when it is not the adjustment
   * type's catch-all (4.3c for a cost, 4.5c for an income): 4.3b for a
   * write-down of financial assets, 4.5b for a dividend.
   */
  ink2sField?: TaxAdjustmentInk2sField
  /**
   * false: shown unticked until the user confirms it applies. Default is
   * ticked whenever the account carries a balance.
   */
  includedByDefault?: boolean
}

/**
 * Every BAS account the chart itself names as not deductible ("ej
 * avdragsgill") is proposed as an INK2S 4.3c addition, and every account it
 * names as tax-free interest ("Skattefria ränteintäkter") as a 4.5c deduction
 * (crm#1681: 6072 representation and 8314 were missing, so 7653, 7754 and the
 * taxable result were wrong). The BAS name is the rule, so a balance there is
 * ticked by default, as 6992 always was. Skattefria traktamenten and
 * bilersättningar (73xx) are not here: tax-free for the employee, deductible
 * for the company.
 */
const NON_DEDUCTIBLE_EXPENSE_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['5982', 'Ej avdragsgill sponsring'],
  ['6072', 'Representation, ej avdragsgill'],
  ['6342', 'Lämnade skadestånd, ej avdragsgilla'],
  ['6392', 'Övriga riskkostnader, ej avdragsgilla'],
  ['6982', 'Föreningsavgifter, ej avdragsgilla'],
  ['6992', 'Övriga externa kostnader, ej avdragsgilla'],
  ['7622', 'Sjuk- och hälsovård, ej avdragsgill'],
  ['7623', 'Sjukvårdsförsäkring, ej avdragsgill'],
  ['7632', 'Personalrepresentation, ej avdragsgill'],
  ['8423', 'Räntekostnader för skatter och avgifter'],
]

const NON_TAXABLE_INCOME_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['8254', 'Skattefria ränteintäkter, långfristiga tillgångar'],
  ['8314', 'Skattefria ränteintäkter'],
]

/**
 * Write-downs of financial assets: shares in and long-term receivables from
 * other companies, and short-term placements (BAS 8070-8077, 8170-8177,
 * 8270-8273, 8370; INK2R 3.12-3.17). They are added back on INK2S 4.3b:
 * Skatteverket names leaving them in the taxable result one of the common
 * errors in a declaration (ställningstagande 2022-10-27), and a deductible
 * write-down arises only in a few rare cases, such as a placement held as a
 * lagertillgång by a company trading in securities. So a balance is ticked by
 * default, as the "ej avdragsgill" accounts are, and the description names
 * the exception.
 */
const FINANCIAL_WRITE_DOWN_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['8070', 'Nedskrivningar av andelar i och långfristiga fordringar hos koncernföretag'],
  ['8072', 'Nedskrivningar av andelar i dotterföretag'],
  ['8076', 'Nedskrivningar av långfristiga fordringar hos moderföretag'],
  ['8077', 'Nedskrivningar av långfristiga fordringar hos dotterföretag'],
  ['8170', 'Nedskrivningar av andelar i och långfristiga fordringar hos intresseföretag m.fl.'],
  ['8171', 'Nedskrivningar av andelar i intresseföretag'],
  ['8172', 'Nedskrivningar av långfristiga fordringar hos intresseföretag'],
  ['8173', 'Nedskrivningar av andelar i gemensamt styrda företag'],
  ['8174', 'Nedskrivningar av långfristiga fordringar hos gemensamt styrda företag'],
  ['8176', 'Nedskrivningar av andelar i övriga företag med ägarintresse'],
  ['8177', 'Nedskrivningar av långfristiga fordringar hos övriga företag med ägarintresse'],
  ['8270', 'Nedskrivningar av innehav av andelar i och långfristiga fordringar hos andra företag'],
  ['8271', 'Nedskrivningar av andelar i andra företag'],
  ['8272', 'Nedskrivningar av långfristiga fordringar hos andra företag'],
  ['8273', 'Nedskrivningar av övriga värdepapper hos andra företag'],
  ['8370', 'Nedskrivningar av kortfristiga placeringar'],
]

/**
 * A write-down added back when it was made is not taxed when it is reversed,
 * so the återföring of one (BAS 8080-8087, 8180-8187, 8280-8283, 8380) is a
 * 4.5c deduction. Ticked by default for the same reason as the write-downs:
 * the write-down it reverses was almost always not deductible.
 */
const FINANCIAL_WRITE_DOWN_REVERSAL_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['8080', 'Återföringar av nedskrivningar av andelar i och långfristiga fordringar hos koncernföretag'],
  ['8082', 'Återföringar av nedskrivningar av andelar i dotterföretag'],
  ['8086', 'Återföringar av nedskrivningar av långfristiga fordringar hos moderföretag'],
  ['8087', 'Återföringar av nedskrivningar av långfristiga fordringar hos dotterföretag'],
  ['8180', 'Återföringar av nedskrivningar av andelar i och långfristiga fordringar hos intresseföretag m.fl.'],
  ['8181', 'Återföringar av nedskrivningar av andelar i intresseföretag'],
  ['8182', 'Återföringar av nedskrivningar av långfristiga fordringar hos intresseföretag'],
  ['8183', 'Återföringar av nedskrivningar av andelar i gemensamt styrda företag'],
  ['8184', 'Återföringar av nedskrivningar av långfristiga fordringar hos gemensamt styrda företag'],
  ['8186', 'Återföringar av nedskrivningar av andelar i övriga företag med ägarintresse'],
  ['8187', 'Återföringar av nedskrivningar av långfristiga fordringar hos övriga företag med ägarintresse'],
  ['8280', 'Återföringar av nedskrivningar av andelar i och långfristiga fordringar hos andra företag'],
  ['8281', 'Återföringar av nedskrivningar av andelar i andra företag'],
  ['8282', 'Återföringar av nedskrivningar av långfristiga fordringar hos andra företag'],
  ['8283', 'Återföringar av nedskrivningar av övriga värdepapper i andra företag'],
  ['8380', 'Återföringar av nedskrivningar av kortfristiga placeringar'],
]

export const DETECTED_TAX_ADJUSTMENT_ACCOUNTS: readonly DetectedTaxAdjustmentAccount[] = [
  ...NON_DEDUCTIBLE_EXPENSE_ACCOUNTS.map(([accountNumber, description]) => ({
    accountNumber,
    sourceKey: `account:${accountNumber}`,
    adjustmentType: 'non_deductible_expense' as const,
    description,
  })),
  ...NON_TAXABLE_INCOME_ACCOUNTS.map(([accountNumber, description]) => ({
    accountNumber,
    sourceKey: `account:${accountNumber}`,
    adjustmentType: 'non_taxable_income' as const,
    description,
  })),
  ...FINANCIAL_WRITE_DOWN_ACCOUNTS.map(([accountNumber, name]) => ({
    accountNumber,
    sourceKey: `account:${accountNumber}`,
    adjustmentType: 'non_deductible_expense' as const,
    description: `${name}, ej avdragsgill utom för lagertillgångar (INK2S 4.3b)`,
    ink2sField: '7652' as const,
  })),
  ...FINANCIAL_WRITE_DOWN_REVERSAL_ACCOUNTS.map(([accountNumber, name]) => ({
    accountNumber,
    sourceKey: `account:${accountNumber}`,
    adjustmentType: 'non_taxable_income' as const,
    description: `${name}, ej skattepliktig när nedskrivningen inte drogs av`,
  })),
]

/**
 * Membership fees of an ekonomisk förening are not taxable income for the
 * association (Skatteverket, "Deklarera för en ekonomisk förening"): the
 * chart seeds 3901 Medlemsavgifter for them, and the balance is proposed as
 * an INK2S 4.5c deduction. The matching administration cost is not
 * deductible (4.3c); it cannot be derived from the ledger, so the wizard
 * asks for it as a manual adjustment (see the INK2 engine warning).
 */
export const MEMBERSHIP_FEE_ACCOUNT = '3901'

const EKONOMISK_FORENING_DETECTED_ACCOUNTS: readonly DetectedTaxAdjustmentAccount[] = [
  {
    accountNumber: MEMBERSHIP_FEE_ACCOUNT,
    sourceKey: `account:${MEMBERSHIP_FEE_ACCOUNT}`,
    adjustmentType: 'non_taxable_income',
    description: 'Medlemsavgifter, ej skattepliktiga (INK2S 4.5c)',
  },
]

/**
 * Dividends on shares in an aktiebolag (crm#1726). A dividend on a
 * näringsbetingad andel is not taxed (IL 24 kap. 35 §): an unlisted share held
 * as kapitaltillgång always is one, a listed share only with at least 10 % of
 * the votes held for at least a year (24 kap. 33 and 40 §§). The ledger cannot
 * tell which, so each account is offered unticked: ticking it is the user's
 * confirmation. Ticked by default it would also count twice for a company
 * that already typed the dividend into "Ej skattepliktiga intäkter", and tax
 * too little. The proposal asks the question (dividendConfirmationWarning in
 * dispositions-proposal-builder).
 */
const DIVIDEND_ACCOUNT_DESCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['8010', 'Utdelning på andelar i koncernföretag'],
  ['8012', 'Utdelning på andelar i dotterföretag'],
  ['8110', 'Utdelningar på andelar i intresseföretag m.fl.'],
  ['8111', 'Utdelningar på andelar i intresseföretag'],
  ['8112', 'Utdelningar på andelar i gemensamt styrda företag'],
  ['8113', 'Utdelningar på andelar i övriga företag med ägarintresse'],
  ['8210', 'Utdelningar på andelar i andra företag'],
  ['8212', 'Utdelningar, andra företag'],
]

const DIVIDEND_ON_SHARES_ACCOUNTS: readonly DetectedTaxAdjustmentAccount[] =
  DIVIDEND_ACCOUNT_DESCRIPTIONS.map(([accountNumber, name]) => ({
    accountNumber,
    sourceKey: `account:${accountNumber}`,
    adjustmentType: 'non_taxable_income' as const,
    description: `${name}, skattefri om andelarna är näringsbetingade`,
    includedByDefault: false,
    ink2sField: '7753' as const,
  }))

/** Detected-account rules for a legal form; the base list applies to every form. */
export function detectedTaxAdjustmentAccounts(
  entityType: EntityType | null,
): readonly DetectedTaxAdjustmentAccount[] {
  // Member-capital forms (an ekonomisk förening) are financed by members.
  if (entityType !== null && supportsMemberCapital(entityType)) {
    return [...DETECTED_TAX_ADJUSTMENT_ACCOUNTS, ...EKONOMISK_FORENING_DETECTED_ACCOUNTS]
  }
  if (entityType === 'aktiebolag') {
    return [...DETECTED_TAX_ADJUSTMENT_ACCOUNTS, ...DIVIDEND_ON_SHARES_ACCOUNTS]
  }
  return DETECTED_TAX_ADJUSTMENT_ACCOUNTS
}

export async function resolveFormForAdjustments(
  supabase: SupabaseClient,
  companyId: string,
  entityType?: EntityType,
): Promise<EntityType | null> {
  if (entityType) return entityType
  // A failed lookup propagates: silently falling back to the form-neutral
  // rules would drop 3901 for an ekonomisk förening and understate INK2S
  // 4.5c, so the taxable base would be wrong without anyone noticing.
  return resolveCompanyEntityType(supabase, companyId)
}

export const MANUAL_ADJUSTMENTS = [
  {
    sourceKey: 'manual:non_deductible_expenses',
    adjustmentType: 'non_deductible_expense' as const,
    description: 'Ytterligare ej avdragsgilla kostnader',
  },
  {
    sourceKey: 'manual:non_taxable_income',
    adjustmentType: 'non_taxable_income' as const,
    description: 'Ej skattepliktiga intäkter',
  },
  // INK2S 4.14 a (SRU 7763). Stored like the other manual bridges so a
  // company that imported only its recent years can still carry the deficit
  // into the tax provision and the declaration.
  {
    sourceKey: 'manual:deficit_carryforward',
    adjustmentType: 'deficit_carryforward' as const,
    description: 'Outnyttjat underskott från föregående beskattningsår',
  },
] as const

export interface PersistedAdjustmentRow {
  source_key: string
  adjustment_type: TaxAdjustmentType
  source: 'detected' | 'manual'
  description: string
  account_number: string | null
  amount: number | string
  included: boolean
}

export function summarizeTaxAdjustments(items: TaxAdjustmentItem[]): TaxAdjustmentSums {
  let nonDeductibleExpenses = 0
  let nonTaxableIncome = 0
  let deficitCarryforward = 0
  let financialWriteDowns = 0
  let dividends = 0

  for (const item of items) {
    if (!item.included) continue
    if (item.ink2sField === '7652') financialWriteDowns += item.amount
    if (item.ink2sField === '7753') dividends += item.amount
    switch (item.adjustmentType) {
      case 'non_deductible_expense':
        nonDeductibleExpenses += item.amount
        break
      case 'non_taxable_income':
        nonTaxableIncome += item.amount
        break
      case 'deficit_carryforward':
        deficitCarryforward += item.amount
        break
    }
  }

  return {
    items,
    nonDeductibleExpenses: roundOre(nonDeductibleExpenses),
    nonTaxableIncome: roundOre(nonTaxableIncome),
    deficitCarryforward: roundOre(deficitCarryforward),
    financialWriteDowns: roundOre(financialWriteDowns),
    dividends: roundOre(dividends),
  }
}

type TrialBalanceAmounts = Pick<TrialBalanceRow, 'account_number' | 'closing_debit' | 'closing_credit'>

/**
 * Every voucher of the year but the resultatavslut, as the tax base and the
 * declaration read it (tax-base-year-end-vouchers): a bokslut voucher can
 * carry a non-deductible cost too, the kontantmetod year-end carry of an
 * unpaid representation invoice or an accrued one. The bokslut's own tax and
 * dispositions are on accounts this detection never reads.
 */
export async function loadTaxAdjustmentTrialBalance(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
) {
  return generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'exclude-final' })
}

/** The year's saved choices and manual figures; a failed read is never read as "none". */
export async function loadPersistedTaxAdjustments(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<PersistedAdjustmentRow[]> {
  const { data, error } = await supabase
    .from('fiscal_period_tax_adjustments')
    .select('source_key, adjustment_type, source, description, account_number, amount, included')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
  if (error) {
    throw new Error(`Failed to load tax adjustments: ${error.message}`)
  }
  return (data ?? []) as PersistedAdjustmentRow[]
}

/**
 * The detected and manual items for a form. `registerDeductible` is what the
 * underskottsregister says the year deducts (4.14 a less 4.14 b and c), or
 * null without a register: with one, a saved manual figure that differs from
 * it is an override and wins, and `deficitOverridden` says so.
 */
export function buildTaxAdjustmentItems(
  form: EntityType | null,
  trialBalanceRows: readonly TrialBalanceAmounts[],
  persistedRows: readonly PersistedAdjustmentRow[],
  registerDeductible: number | null,
): { items: TaxAdjustmentItem[]; deficitOverridden: boolean } {
  const persistedByKey = new Map(persistedRows.map((row) => [row.source_key, row]))
  const trialBalanceByAccount = new Map(trialBalanceRows.map((row) => [row.account_number, row]))

  const detectedItems: TaxAdjustmentItem[] = detectedTaxAdjustmentAccounts(form).map((config) => {
    const row = trialBalanceByAccount.get(config.accountNumber)
    // An expense account carries its balance on the debit side, a revenue
    // account on the credit side; the adjustment is always the positive
    // balance in the account's own direction.
    const debit = Number(row?.closing_debit) || 0
    const credit = Number(row?.closing_credit) || 0
    const amount = roundOre(
      Math.max(0, config.adjustmentType === 'non_taxable_income' ? credit - debit : debit - credit),
    )
    const persisted = persistedByKey.get(config.sourceKey)
    return {
      sourceKey: config.sourceKey,
      source: 'detected',
      adjustmentType: config.adjustmentType,
      description: config.description,
      accountNumber: config.accountNumber,
      amount,
      included: persisted?.included ?? (config.includedByDefault !== false && amount > 0),
      ...(config.includedByDefault === false ? { needsConfirmation: true } : {}),
      ...(config.ink2sField ? { ink2sField: config.ink2sField } : {}),
    }
  })

  let deficitOverridden = false
  const manualItems: TaxAdjustmentItem[] = MANUAL_ADJUSTMENTS.map((config) => {
    const persisted = persistedByKey.get(config.sourceKey)
    let amount = roundOre(Math.max(0, Number(persisted?.amount) || 0))
    if (config.adjustmentType === 'deficit_carryforward' && registerDeductible !== null) {
      deficitOverridden = amount > 0 && !equalOre(amount, registerDeductible)
      if (!deficitOverridden) amount = registerDeductible
    }
    return {
      sourceKey: config.sourceKey,
      source: 'manual',
      adjustmentType: config.adjustmentType,
      description: config.description,
      accountNumber: null,
      amount,
      included: amount > 0,
    }
  })

  return { items: [...detectedItems, ...manualItems], deficitOverridden }
}

/**
 * The adjustments a form without an underskottsregister files: the NE-bilaga
 * reads its R13 (nonDeductibleExpenses) and R14 (nonTaxableIncome) here.
 * Pass the declaration's own exclude-final trial balance rows to read the
 * books once.
 */
export async function loadBookedTaxAdjustments(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  form: EntityType,
  trialBalanceRows?: readonly TrialBalanceAmounts[],
): Promise<TaxAdjustmentSums> {
  const [rows, persisted] = await Promise.all([
    trialBalanceRows
      ? Promise.resolve(trialBalanceRows)
      : loadTaxAdjustmentTrialBalance(supabase, companyId, fiscalPeriodId).then((tb) => tb.rows),
    loadPersistedTaxAdjustments(supabase, companyId, fiscalPeriodId),
  ])
  return summarizeTaxAdjustments(buildTaxAdjustmentItems(form, rows, persisted, null).items)
}

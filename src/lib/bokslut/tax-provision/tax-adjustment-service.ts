import type { SupabaseClient } from '@supabase/supabase-js'
import { equalOre, roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type {
  TaxAdjustmentItem,
  TaxAdjustmentSnapshot,
  TaxAdjustmentType,
} from '../types'
import type { EntityType } from '@/types'
import { resolveCompanyEntityType, supportsMemberCapital, usesInk2 } from '@/lib/company/entity-type'
import { lossCarryforwardEnabledFor } from '@/lib/env/loss-carryforward-switch'
import { loadRegisterDeficit } from '../loss-carryforward/register'

interface DetectedTaxAdjustmentAccount {
  accountNumber: string
  sourceKey: string
  adjustmentType: TaxAdjustmentType
  description: string
  /**
   * false: shown unticked until the user confirms it applies. Default is
   * ticked whenever the account carries a balance.
   */
  includedByDefault?: boolean
}

export const DETECTED_TAX_ADJUSTMENT_ACCOUNTS: readonly DetectedTaxAdjustmentAccount[] = [
  {
    accountNumber: '6992',
    sourceKey: 'account:6992',
    adjustmentType: 'non_deductible_expense',
    description: 'Övriga externa kostnader, ej avdragsgilla',
  },
  {
    accountNumber: '8423',
    sourceKey: 'account:8423',
    adjustmentType: 'non_deductible_expense',
    description: 'Räntekostnader för skatter och avgifter',
  },
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

async function resolveFormForAdjustments(
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

const MANUAL_ADJUSTMENTS = [
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

interface PersistedAdjustmentRow {
  source_key: string
  adjustment_type: TaxAdjustmentType
  source: 'detected' | 'manual'
  description: string
  account_number: string | null
  amount: number | string
  included: boolean
}

export interface SaveTaxAdjustmentsInput {
  manualAdjustments: {
    nonDeductibleExpenses: number
    nonTaxableIncome: number
    /** INK2S 4.14 a: prior years' unused deficit to deduct this year. */
    deficitCarryforward: number
  }
  /** Keyed by account number; an account missing from the map is excluded. */
  detectedAccounts: Record<string, boolean>
}

export async function loadTaxAdjustmentSnapshot(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  entityType?: EntityType,
): Promise<TaxAdjustmentSnapshot> {
  const form = await resolveFormForAdjustments(supabase, companyId, entityType)
  // The underskottsregister (IL 40 kap.) is read only where its switch is on
  // and the form files INK2; everywhere else 4.14 a is the manual entry alone.
  const registerOpen = form !== null && lossCarryforwardEnabledFor(companyId) && usesInk2(form)
  const [trialBalance, persistedResult, register] = await Promise.all([
    generateTrialBalance(supabase, companyId, fiscalPeriodId, {
      closingEntry: 'exclude-all-year-end',
    }),
    supabase
      .from('fiscal_period_tax_adjustments')
      .select('source_key, adjustment_type, source, description, account_number, amount, included')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId),
    registerOpen ? loadRegisterDeficit(supabase, companyId, fiscalPeriodId) : Promise.resolve(null),
  ])

  if (persistedResult.error) {
    throw new Error(`Failed to load tax adjustments: ${persistedResult.error.message}`)
  }

  const persistedByKey = new Map(
    ((persistedResult.data ?? []) as PersistedAdjustmentRow[]).map((row) => [row.source_key, row]),
  )
  const trialBalanceByAccount = new Map(
    trialBalance.rows.map((row) => [row.account_number, row]),
  )

  const detectedItems: TaxAdjustmentItem[] = detectedTaxAdjustmentAccounts(form).map((config) => {
    const row = trialBalanceByAccount.get(config.accountNumber)
    // An expense account carries its balance on the debit side, a revenue
    // account on the credit side; the adjustment is always the positive
    // balance in the account's own direction.
    const debit = row?.closing_debit ?? 0
    const credit = row?.closing_credit ?? 0
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
    }
  })

  // With a register row for the year, 4.14 a is the register's (4.14 a less
  // the spärrar on 4.14 b and c); a saved manual figure that differs from it
  // is an override and wins, and the snapshot says so.
  let deficitOverridden = false
  const manualItems: TaxAdjustmentItem[] = MANUAL_ADJUSTMENTS.map((config) => {
    const persisted = persistedByKey.get(config.sourceKey)
    let amount = roundOre(Math.max(0, Number(persisted?.amount) || 0))
    if (config.adjustmentType === 'deficit_carryforward' && register) {
      deficitOverridden = amount > 0 && !equalOre(amount, register.deductible)
      if (!deficitOverridden) amount = register.deductible
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

  const snapshot = summarizeTaxAdjustments([...detectedItems, ...manualItems])
  if (!registerOpen) return snapshot
  return { ...snapshot, lossRegister: { row: register, overridden: deficitOverridden } }
}

export async function saveTaxAdjustments(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
  input: SaveTaxAdjustmentsInput,
  entityType?: EntityType,
): Promise<void> {
  const form = await resolveFormForAdjustments(supabase, companyId, entityType)
  const current = await loadTaxAdjustmentSnapshot(supabase, companyId, fiscalPeriodId, form ?? undefined)
  // The figure the register already gives is not stored as an override, so
  // a later change in the register flows into this year; a different figure
  // is stored and wins (loadTaxAdjustmentSnapshot).
  const registerRow = current.lossRegister?.row ?? null
  const deficitCarryforward =
    registerRow && equalOre(roundOre(input.manualAdjustments.deficitCarryforward), registerRow.deductible)
      ? 0
      : input.manualAdjustments.deficitCarryforward
  const detectedAmounts = new Map(
    current.items
      .filter((item) => item.source === 'detected')
      .map((item) => [item.sourceKey, item.amount]),
  )

  const rows = [
    ...detectedTaxAdjustmentAccounts(form).map((config) => ({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: fiscalPeriodId,
      adjustment_type: config.adjustmentType,
      source: 'detected',
      source_key: config.sourceKey,
      description: config.description,
      account_number: config.accountNumber,
      amount: detectedAmounts.get(config.sourceKey) ?? 0,
      included: input.detectedAccounts[config.accountNumber] ?? false,
    })),
    {
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: fiscalPeriodId,
      adjustment_type: 'non_deductible_expense',
      source: 'manual',
      source_key: 'manual:non_deductible_expenses',
      description: 'Ytterligare ej avdragsgilla kostnader',
      account_number: null,
      amount: roundOre(input.manualAdjustments.nonDeductibleExpenses),
      included: input.manualAdjustments.nonDeductibleExpenses > 0,
    },
    {
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: fiscalPeriodId,
      adjustment_type: 'non_taxable_income',
      source: 'manual',
      source_key: 'manual:non_taxable_income',
      description: 'Ej skattepliktiga intäkter',
      account_number: null,
      amount: roundOre(input.manualAdjustments.nonTaxableIncome),
      included: input.manualAdjustments.nonTaxableIncome > 0,
    },
    {
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: fiscalPeriodId,
      adjustment_type: 'deficit_carryforward',
      source: 'manual',
      source_key: 'manual:deficit_carryforward',
      description: 'Outnyttjat underskott från föregående beskattningsår',
      account_number: null,
      amount: roundOre(deficitCarryforward),
      included: deficitCarryforward > 0,
    },
  ]

  const { error } = await supabase
    .from('fiscal_period_tax_adjustments')
    .upsert(rows, { onConflict: 'company_id,fiscal_period_id,source_key' })

  if (error) {
    throw new Error(`Failed to save tax adjustments: ${error.message}`)
  }
}

function summarizeTaxAdjustments(items: TaxAdjustmentItem[]): TaxAdjustmentSnapshot {
  let nonDeductibleExpenses = 0
  let nonTaxableIncome = 0
  let deficitCarryforward = 0

  for (const item of items) {
    if (!item.included) continue
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
  }
}

/**
 * INK2S 4.9 (buildings, markanläggningar and mark on their tax plan) is a
 * tax adjustment like the ones above; re-exported here so the declaration
 * reads every adjustment through this module.
 */
export { loadBuildingTaxAdjustment } from '@/lib/bokslut/assets/building-tax-service'

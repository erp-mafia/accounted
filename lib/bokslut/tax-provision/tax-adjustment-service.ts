import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type {
  BrfTaxContext,
  TaxAdjustmentItem,
  TaxAdjustmentSnapshot,
  TaxAdjustmentType,
} from '../types'
import type { EntityType } from '@/types'
import {
  hasPropertyIncomeExemption,
  isEkonomiskForeningFamily,
  resolveCompanyEntityType,
} from '@/lib/company/entity-type'
import { getTaxProfile } from '@/lib/company/brf-tax-profile'
import {
  computePropertyBlock,
  PROPERTY_BLOCK_SOURCE_KEYS,
  taxationYearOf,
} from '@/lib/brf/privatbostadsforetag'

interface DetectedTaxAdjustmentAccount {
  accountNumber: string
  sourceKey: string
  adjustmentType: TaxAdjustmentType
  description: string
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

/** Detected-account rules for a legal form; the base list applies to every form. */
export function detectedTaxAdjustmentAccounts(
  entityType: EntityType | null,
): readonly DetectedTaxAdjustmentAccount[] {
  if (entityType && isEkonomiskForeningFamily(entityType)) {
    return [...DETECTED_TAX_ADJUSTMENT_ACCOUNTS, ...EKONOMISK_FORENING_DETECTED_ACCOUNTS]
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
  }
  /** Keyed by account number; an account missing from the map is excluded. */
  detectedAccounts: Record<string, boolean>
  /** Keyed by source key for detected items without an account (the
   *  bostadsrättsförening property block); an item missing from the map
   *  keeps its current inclusion. */
  detectedItems?: Record<string, boolean>
}

/**
 * Bostadsrättsförening: the year's privatbostadsföretag assessment and the
 * property block. Read from the pre-closing books ('exclude-final': the
 * final resultatavslut is dropped but avskrivningar and the other year-end
 * postings stay, exactly what the INK2 income statement reports), so the
 * building's depreciation is inside the block it belongs to.
 */
async function loadBrfTaxContext(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<BrfTaxContext> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (periodError) throw new Error(`Failed to load fiscal period: ${periodError.message}`)
  if (!period?.period_end) throw new Error('Fiscal period not found')
  const taxationYear = taxationYearOf(String(period.period_end))
  const [profile, preClosing] = await Promise.all([
    getTaxProfile(supabase, companyId, taxationYear),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'exclude-final' }),
  ])
  const status: BrfTaxContext['status'] =
    profile === null ? 'unassessed' : profile.privatbostadsforetag ? 'akta' : 'oakta'
  const block = computePropertyBlock(preClosing.rows)
  return {
    taxationYear,
    status,
    propertyIncome: status === 'akta' ? block.propertyIncome : 0,
    propertyCosts: status === 'akta' ? block.propertyCosts : 0,
    taxableCapitalIncome: block.taxableCapitalIncome,
  }
}

/** The two reviewer-switchable items that carry the property block of an äkta BRF. */
function brfPropertyBlockItems(
  brf: BrfTaxContext,
  persistedByKey: Map<string, PersistedAdjustmentRow>,
): TaxAdjustmentItem[] {
  if (brf.status !== 'akta') return []
  const configs = [
    {
      sourceKey: PROPERTY_BLOCK_SOURCE_KEYS.income,
      adjustmentType: 'non_taxable_income' as const,
      description: `Fastighetens intäkter, ej skattepliktiga för privatbostadsföretag (IL 39 kap. 25 §, INK2S 4.5c)`,
      amount: brf.propertyIncome,
    },
    {
      sourceKey: PROPERTY_BLOCK_SOURCE_KEYS.costs,
      adjustmentType: 'non_deductible_expense' as const,
      description: `Fastighetens kostnader inklusive räntor och avskrivningar, ej avdragsgilla för privatbostadsföretag (IL 39 kap. 25 §, INK2S 4.3c)`,
      amount: brf.propertyCosts,
    },
  ]
  return configs.map((config) => {
    const persisted = persistedByKey.get(config.sourceKey)
    return {
      sourceKey: config.sourceKey,
      source: 'detected',
      adjustmentType: config.adjustmentType,
      description: config.description,
      accountNumber: null,
      amount: config.amount,
      included: persisted?.included ?? config.amount > 0,
    }
  })
}

export async function loadTaxAdjustmentSnapshot(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  entityType?: EntityType,
): Promise<TaxAdjustmentSnapshot> {
  const form = await resolveFormForAdjustments(supabase, companyId, entityType)
  const [trialBalance, persistedResult] = await Promise.all([
    generateTrialBalance(supabase, companyId, fiscalPeriodId, {
      closingEntry: 'exclude-all-year-end',
    }),
    supabase
      .from('fiscal_period_tax_adjustments')
      .select('source_key, adjustment_type, source, description, account_number, amount, included')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId),
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
      included: persisted?.included ?? amount > 0,
    }
  })

  const brf = form && hasPropertyIncomeExemption(form)
    ? await loadBrfTaxContext(supabase, companyId, fiscalPeriodId)
    : undefined
  const brfItems = brf ? brfPropertyBlockItems(brf, persistedByKey) : []

  const manualItems: TaxAdjustmentItem[] = MANUAL_ADJUSTMENTS.map((config) => {
    const persisted = persistedByKey.get(config.sourceKey)
    const amount = roundOre(Math.max(0, Number(persisted?.amount) || 0))
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

  const snapshot = summarizeTaxAdjustments([...detectedItems, ...brfItems, ...manualItems])
  return brf ? { ...snapshot, brf } : snapshot
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
  const detectedAmounts = new Map(
    current.items
      .filter((item) => item.source === 'detected')
      .map((item) => [item.sourceKey, item.amount]),
  )

  // The property block rows of an äkta bostadsrättsförening are keyed by
  // source key (no account); an item absent from detectedItems keeps the
  // inclusion the snapshot resolved.
  const brfRows = current.items
    .filter((item) => item.source === 'detected' && item.accountNumber === null)
    .map((item) => ({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: fiscalPeriodId,
      adjustment_type: item.adjustmentType,
      source: 'detected',
      source_key: item.sourceKey,
      description: item.description,
      account_number: null,
      amount: item.amount,
      included: input.detectedItems?.[item.sourceKey] ?? item.included,
    }))

  const rows = [
    ...brfRows,
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

  for (const item of items) {
    if (!item.included) continue
    if (item.adjustmentType === 'non_deductible_expense') {
      nonDeductibleExpenses += item.amount
    } else {
      nonTaxableIncome += item.amount
    }
  }

  return {
    items,
    nonDeductibleExpenses: roundOre(nonDeductibleExpenses),
    nonTaxableIncome: roundOre(nonTaxableIncome),
  }
}

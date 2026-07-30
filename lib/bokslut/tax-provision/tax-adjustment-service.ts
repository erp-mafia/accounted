import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type {
  TaxAdjustmentItem,
  TaxAdjustmentSnapshot,
  TaxAdjustmentType,
} from '../types'

export const DETECTED_TAX_ADJUSTMENT_ACCOUNTS = [
  {
    accountNumber: '6992',
    sourceKey: 'account:6992',
    adjustmentType: 'non_deductible_expense' as const,
    description: 'Övriga externa kostnader, ej avdragsgilla',
  },
  {
    accountNumber: '8423',
    sourceKey: 'account:8423',
    adjustmentType: 'non_deductible_expense' as const,
    description: 'Räntekostnader för skatter och avgifter',
  },
] as const

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
  detectedAccounts: Record<(typeof DETECTED_TAX_ADJUSTMENT_ACCOUNTS)[number]['accountNumber'], boolean>
}

export async function loadTaxAdjustmentSnapshot(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<TaxAdjustmentSnapshot> {
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

  const detectedItems: TaxAdjustmentItem[] = DETECTED_TAX_ADJUSTMENT_ACCOUNTS.map((config) => {
    const row = trialBalanceByAccount.get(config.accountNumber)
    const amount = roundOre(Math.max(0, (row?.closing_debit ?? 0) - (row?.closing_credit ?? 0)))
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

  return summarizeTaxAdjustments([...detectedItems, ...manualItems])
}

export async function saveTaxAdjustments(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
  input: SaveTaxAdjustmentsInput,
): Promise<void> {
  const current = await loadTaxAdjustmentSnapshot(supabase, companyId, fiscalPeriodId)
  const detectedAmounts = new Map(
    current.items
      .filter((item) => item.source === 'detected')
      .map((item) => [item.sourceKey, item.amount]),
  )

  const rows = [
    ...DETECTED_TAX_ADJUSTMENT_ACCOUNTS.map((config) => ({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: fiscalPeriodId,
      adjustment_type: config.adjustmentType,
      source: 'detected',
      source_key: config.sourceKey,
      description: config.description,
      account_number: config.accountNumber,
      amount: detectedAmounts.get(config.sourceKey) ?? 0,
      included: input.detectedAccounts[config.accountNumber],
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

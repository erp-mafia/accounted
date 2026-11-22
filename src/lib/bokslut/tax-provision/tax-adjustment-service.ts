import type { SupabaseClient } from '@supabase/supabase-js'
import { equalOre, roundOre } from '@/lib/money'
import type { TaxAdjustmentSnapshot } from '../types'
import type { EntityType } from '@/types'
import { usesInk2 } from '@/lib/company/entity-type'
import { lossCarryforwardEnabledFor } from '@/lib/env/loss-carryforward-switch'
import { loadRegisterDeficit } from '../loss-carryforward/register'
import {
  buildTaxAdjustmentItems,
  detectedTaxAdjustmentAccounts,
  loadPersistedTaxAdjustments,
  loadTaxAdjustmentTrialBalance,
  resolveFormForAdjustments,
  summarizeTaxAdjustments,
} from '@/lib/reports/tax-adjustments'

/**
 * The detection itself (which BAS accounts are adjusted, and how) lives in
 * the ledger kernel, lib/reports/tax-adjustments.ts, so the NE-bilaga reads
 * the same rule. This block adds the underskottsregister and the save.
 */
export {
  DETECTED_TAX_ADJUSTMENT_ACCOUNTS,
  detectedTaxAdjustmentAccounts,
  MEMBERSHIP_FEE_ACCOUNT,
} from '@/lib/reports/tax-adjustments'

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
  const [trialBalance, persisted, register] = await Promise.all([
    loadTaxAdjustmentTrialBalance(supabase, companyId, fiscalPeriodId),
    loadPersistedTaxAdjustments(supabase, companyId, fiscalPeriodId),
    registerOpen ? loadRegisterDeficit(supabase, companyId, fiscalPeriodId) : Promise.resolve(null),
  ])

  // With a register row for the year, 4.14 a is the register's (4.14 a less
  // the spärrar on 4.14 b and c); a saved manual figure that differs from it
  // is an override and wins, and the snapshot says so.
  const { items, deficitOverridden } = buildTaxAdjustmentItems(
    form,
    trialBalance.rows,
    persisted,
    register ? register.deductible : null,
  )
  const snapshot: TaxAdjustmentSnapshot = summarizeTaxAdjustments(items)
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

/**
 * INK2S 4.9 (buildings, markanläggningar and mark on their tax plan) is a
 * tax adjustment like the ones above; re-exported here so the declaration
 * reads every adjustment through this module.
 */
export { loadBuildingTaxAdjustment } from '@/lib/bokslut/assets/building-tax-service'

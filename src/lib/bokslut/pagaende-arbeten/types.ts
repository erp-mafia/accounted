import type { ContractRevenueMethod, ContractRevenueResult } from './calculator'

/**
 * The stored shapes of pågående arbeten (contract_revenue_settings,
 * contract_revenue_contracts) and the year's preview, shared by the service
 * (register.ts) and the page. Pure types: safe in a client component.
 */

export interface ContractRevenueSettings {
  method: ContractRevenueMethod
  revenue_account: string
}

export interface ContractRow {
  id: string
  company_id: string
  name: string
  kind: 'fast_pris' | 'lopande_rakning'
  /** The balansdag the figures below are stated for. */
  figures_as_of: string
  contract_value: number | string
  expected_total_cost: number | string
  costs_to_date: number | string
  billed_to_date: number | string
  retained_amounts: number | string
  reliable_outcome: boolean
  grade_method: 'utgifter' | 'undersokning' | 'fysisk'
  stated_grade: number | string | null
  reimbursable_costs: number | string | null
  value_worked: number | string | null
  substantially_complete: boolean
  created_at?: string
}

export type ContractRowInput = Omit<ContractRow, 'id' | 'company_id' | 'created_at'>

export interface ContractRevenueYearPreview {
  method: ContractRevenueMethod
  balansdag: string
  revenue_account: string
  positions: ContractRevenueResult['positions']
  lines: ContractRevenueResult['lines']
  issues: Array<{ code: string; contract: string }>
  /** Uppdrag whose figures are stated for another day than balansdagen. */
  stated_on_other_day: string[]
}

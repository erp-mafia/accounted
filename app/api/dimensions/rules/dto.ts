/** Shared select + DTO mapper for the account_dimension_rules routes (PR10). */

export const RULE_SELECT =
  'id, account_number, rule_type, value_id, is_active, dimension:dimensions!account_dimension_rules_dimension_id_company_id_fkey(id, sie_dim_no, name), value:dimension_values!account_dimension_rules_value_id_fkey(code, name)'

export interface RawRule {
  id: string
  account_number: string
  rule_type: 'required' | 'default' | 'fixed'
  value_id: string | null
  is_active: boolean
  dimension: { id: string; sie_dim_no: number; name: string }
  value: { code: string; name: string } | null
}

export function toRuleDto(row: RawRule) {
  return {
    account_dimension_rule_id: row.id,
    account_number: row.account_number,
    dimension_id: row.dimension.id,
    sie_dim_no: row.dimension.sie_dim_no,
    dimension_name: row.dimension.name,
    rule_type: row.rule_type,
    value_id: row.value_id,
    value_code: row.value?.code ?? null,
    value_name: row.value?.name ?? null,
    is_active: row.is_active,
  }
}

/**
 * The value rule of an account dimension rule (account_dimension_rules,
 * CHECK adr_value_presence): 'required' carries no value, 'default' and
 * 'fixed' carry the value they apply. One sentence per violation, shared by
 * the request schema (a create) and lib/dimensions/rules-service.ts (an
 * update, checked against the rule's effective type). Pure: no imports.
 */
export const DIMENSION_RULE_TYPES = ['required', 'default', 'fixed'] as const
export type DimensionRuleType = (typeof DIMENSION_RULE_TYPES)[number]

/** The Swedish sentence the user sees when the pair breaks the rule, else null. */
export function ruleValueProblem(ruleType: DimensionRuleType, hasValue: boolean): string | null {
  if (ruleType === 'required' && hasValue) {
    return 'En obligatorisk regel har inget värde: ta bort värdet eller välj Förval eller Låst.'
  }
  if (ruleType !== 'required' && !hasValue) return 'Välj vilket värde regeln ska använda.'
  return null
}

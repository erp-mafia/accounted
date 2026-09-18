/** Zero tracking is explicit, never a way to remove ordinary vacation rights. */
export function validateVacationEntitlement(row: { vacation_rule?: unknown; vacation_days_per_year?: unknown }): string | null {
  if (row.vacation_days_per_year === 0 && row.vacation_rule !== 'none') {
    return 'Noll semesterdagar kräver att semesterhanteringen uttryckligen är avstängd'
  }
  return null
}

/** Older automatic vacation rows have no provenance. Require classification
 * rather than silently deleting a possibly manual payment or paying it twice. */
export function assertVacationLineProvenance(lines: Record<string, unknown>[]): void {
  if (lines.some(li => li.item_type === 'semesterersattning' && !li.calculation_source &&
    li.description === 'Semesterersättning' && li.sort_order === 50)) {
    throw new Error('Klassificera äldre semesterersättningsrader som manuella eller automatiska innan omberäkning')
  }
}

export function isAutomaticVacationLine(line: Record<string, unknown>): boolean {
  return line.item_type === 'semesterersattning' && line.calculation_source === 'vacation_compensation'
}

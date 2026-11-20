/**
 * A proposal's number: pending_operations.operation_number (migration
 * 20261117192101). Per company, counting up in creation order, assigned by
 * the database when the proposal is staged and never changed, so a person
 * and an agent can name the same proposal ("Förslag 128"). Rows are still
 * found by id; the number is never a key.
 *
 * A row has none when it was read before the column existed (the code is
 * live before the migration runs) and when the proposal was decided before
 * the migration. Every surface reads it here and shows nothing for null.
 */
export function operationNumberOf(row: { operation_number?: unknown } | null | undefined): number | null {
  const value = row?.operation_number
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * The operation_number of an answer (a staged envelope, a list row), for a
 * payload to spread: `{}` without one, so an answer never carries a null
 * where older rows have no number.
 */
export function operationNumberField(row: { operation_number?: unknown } | null | undefined): { operation_number?: number } {
  const number = operationNumberOf(row)
  return number === null ? {} : { operation_number: number }
}

/**
 * Date helpers shared by the sandbox seed modules. Seed-internal: the seed
 * works in local-calendar parts on purpose (no toISOString UTC shift).
 */

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Last calendar day of a 1-12 month: day 0 of the next month, leap years included. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * Which rows the Transaktioner "Alla" list shows under each filter chip.
 *
 * An ignored row (is_ignored) is neither booked nor waiting: it has its own
 * chip so it can be found again and restored where the ignore confirmation
 * says it can (crm#1612). Before, it showed under Alla as an unbooked row with
 * a Bokför button and no way to tell it was ignored.
 *
 * Skattekonto rows carry no is_business flag, so only Alla shows them. An
 * ignored skattekonto row is restored on the Skattekonto page (its Ignorerade
 * band); the list fetch never loads them, and one ignored in this session
 * leaves the list instead of showing as unbooked.
 */
export type HistoryFilter = 'all' | 'business' | 'private' | 'ignored'

export function bankRowMatchesHistoryFilter(
  row: { is_business: boolean | null; is_ignored?: boolean | null },
  filter: HistoryFilter,
): boolean {
  const ignored = row.is_ignored === true
  switch (filter) {
    case 'all':
      return true
    case 'ignored':
      return ignored
    case 'business':
      return !ignored && row.is_business === true
    case 'private':
      return !ignored && row.is_business === false
  }
}

export function skattekontoRowMatchesHistoryFilter(
  row: { is_ignored?: boolean | null },
  filter: HistoryFilter,
): boolean {
  return filter === 'all' && row.is_ignored !== true
}

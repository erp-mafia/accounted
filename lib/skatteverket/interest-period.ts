/**
 * Disambiguation of look-alike skattekonto rows.
 *
 * When Skatteverket issues a retroactive omprövningsbeslut it does not send one
 * transaction: it splits the decision across every month it re-charges and
 * sends one transaction per month. Those rows share transaktionsdatum,
 * transaktionstext and belopp, and carry their own transaktionsidentitet. The
 * only human-readable field that separates them is `ranteberakningsdatum`.
 *
 * The skattekonto table shows Datum / Händelse / Belopp, so such a decision
 * renders as N pixel-identical rows. That reads as duplicates from the
 * automatic Skatteverket fetch, which is a well-known failure mode in this
 * market and has cost us at least one customer who booked all of them and then
 * could not tell whether he had to reverse fourteen of them.
 *
 * We surface `ranteberakningsdatum` only on rows where it actually carries
 * information, so it stays an exception marker (design convention 5) rather
 * than noise repeated on every row. A row qualifies when either:
 *   1. its interest date falls in a different month than the date shown in the
 *      Datum column (the retroactive-decision signature), or
 *   2. another row in the same band is otherwise indistinguishable from it.
 *
 * Rule 2 catches the look-alikes the month rule alone would miss, such as a
 * decision split inside a single month. It cannot separate rows that share a
 * ränteberäkningsdatum, or that both lack one, since that is the only field
 * left to distinguish them; in practice Skatteverket gives each month of a
 * decision its own date, which is exactly the case this exists for.
 */

export interface InterestPeriodRow {
  id: string
  /** The date actually rendered in the Datum column for this row. */
  displayDate: string
  transaktionstext: string
  belopp: number
  ranteberakningsdatum: string | null | undefined
}

/** `yyyy-MM` from an ISO date or timestamp; '' when the input is unusable. */
function monthOf(value: string): string {
  if (typeof value !== 'string' || value.length < 7) return ''
  return value.slice(0, 7)
}

/**
 * Identity as the table renders it. Two rows with the same key are
 * indistinguishable to the reader.
 */
function renderedIdentity(row: InterestPeriodRow): string {
  return `${row.displayDate}|${row.transaktionstext}|${row.belopp}`
}

/**
 * Ids of the rows that should display their ränteberäkningsdatum.
 *
 * Pass one band (upcoming / overdue / booked) at a time: rows are only
 * confusable with the rows they are rendered next to.
 */
export function rowsNeedingInterestDate(rows: InterestPeriodRow[]): Set<string> {
  const seen = new Map<string, number>()
  for (const row of rows) {
    const key = renderedIdentity(row)
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }

  const result = new Set<string>()
  for (const row of rows) {
    if (!row.ranteberakningsdatum) continue

    const spansAnotherMonth =
      monthOf(row.ranteberakningsdatum) !== monthOf(row.displayDate)
    const hasTwin = (seen.get(renderedIdentity(row)) ?? 0) > 1

    if (spansAnotherMonth || hasTwin) result.add(row.id)
  }
  return result
}

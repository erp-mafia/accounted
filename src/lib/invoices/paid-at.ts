/**
 * Convert a date-only invoice payment date to the canonical `paid_at` value.
 *
 * `paid_at` is a Postgres `timestamptz`, while payment and transaction dates
 * are calendar dates without a time zone. UTC noon keeps that calendar date
 * stable in UTC, Europe/Stockholm, and every negative UTC offset through
 * UTC-12. Midnight UTC would display as the previous day in American time
 * zones when passed through the shared local-time date formatter.
 */
export function paidAtFromDate(paymentDate: string): string {
  return `${paymentDate}T12:00:00Z`
}

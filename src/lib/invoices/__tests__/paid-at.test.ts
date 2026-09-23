import { describe, expect, it } from 'vitest'
import { paidAtFromDate } from '@/lib/invoices/paid-at'

function dateInTimeZone(timestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

describe('paidAtFromDate', () => {
  it('anchors date-only payments at UTC noon', () => {
    expect(paidAtFromDate('2026-05-12')).toBe('2026-05-12T12:00:00Z')
  })

  it.each(['America/New_York', 'Europe/Stockholm', 'UTC'])(
    'renders the original payment date in %s',
    (timeZone) => {
      const paidAt = paidAtFromDate('2026-05-12')
      expect(dateInTimeZone(paidAt, timeZone)).toBe('2026-05-12')
    },
  )
})

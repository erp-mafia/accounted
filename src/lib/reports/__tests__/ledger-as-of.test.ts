import { describe, it, expect } from 'vitest'
import { parseLedgerAsOfDate } from '../ledger-as-of'

const NOW = new Date('2026-10-13T12:00:00Z')

describe('parseLedgerAsOfDate', () => {
  it.each([undefined, null, ''])('reads %j as "today" (the generators default)', (value) => {
    expect(parseLedgerAsOfDate(value, NOW)).toEqual({ ok: true, asOfDate: undefined })
  })

  it.each(['2026-09-30', '2000-01-01', '2027-12-31', '2024-02-29'])('accepts the real date %s', (value) => {
    expect(parseLedgerAsOfDate(value, NOW)).toEqual({ ok: true, asOfDate: value })
  })

  it.each(['garbage', '2026-9-30', '20260930', '2026-09-30T00:00:00Z', 20260930, { date: '2026-09-30' }])(
    'refuses %j as not YYYY-MM-DD',
    (value) => {
      expect(parseLedgerAsOfDate(value, NOW)).toMatchObject({ ok: false, message: 'Expected YYYY-MM-DD.' })
    },
  )

  // "2025-02-30" used to reach the generator and answer an empty ledger.
  it.each(['2025-02-30', '2026-13-01', '2025-02-29', '2026-04-31'])('refuses the impossible date %s', (value) => {
    expect(parseLedgerAsOfDate(value, NOW)).toEqual({
      ok: false,
      message: 'Not a valid calendar date.',
      messageSv: 'Datumet finns inte i kalendern.',
    })
  })

  it.each(['1999-12-31', '2028-01-01', '9999-12-31'])('refuses %s outside 2000 to next year', (value) => {
    expect(parseLedgerAsOfDate(value, NOW)).toEqual({
      ok: false,
      message: 'Year out of supported range. Accepted: 2000 to 2027.',
      messageSv: 'Året måste ligga mellan 2000 och 2027.',
    })
  })
})

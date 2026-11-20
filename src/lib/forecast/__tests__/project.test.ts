import { describe, expect, it } from 'vitest'
import { forecastEnd, isoWeekLabel, startOfIsoWeek } from '../calendar'
import { projectCashForecast } from '../project'
import type { CashFlow } from '../types'

function flow(date: string, direction: 'in' | 'out', amount: number, overrides: Partial<CashFlow> = {}): CashFlow {
  return {
    date,
    direction,
    amount,
    kind: 'known',
    source: 'customer_invoice',
    estimate: false,
    counterparty: null,
    reference: null,
    ref: null,
    confidence: null,
    ...overrides,
  }
}

describe('ISO weeks', () => {
  it('labels weeks by the year their Thursday falls in', () => {
    expect(isoWeekLabel('2026-10-28')).toBe('2026-W44')
    expect(isoWeekLabel('2026-12-31')).toBe('2026-W53')
    expect(isoWeekLabel('2027-01-03')).toBe('2026-W53')
    expect(isoWeekLabel('2027-01-04')).toBe('2027-W01')
    expect(isoWeekLabel('2025-12-29')).toBe('2026-W01')
  })

  it('starts on Monday and ends 13 weeks later on a Sunday, the current week first', () => {
    expect(startOfIsoWeek('2026-10-28')).toBe('2026-10-26')
    expect(startOfIsoWeek('2026-11-01')).toBe('2026-10-26')
    expect(forecastEnd('2026-10-28', 13)).toBe('2027-01-24')
    expect(forecastEnd('2026-10-28', 1)).toBe('2026-11-01')
  })
})

describe('projectCashForecast', () => {
  const window = { today: '2026-10-28', end: forecastEnd('2026-10-28', 13) }

  it('adds up opening + in - out = closing per day and per ISO week, öre-exact', () => {
    const p = projectCashForecast({
      window,
      weeks: 13,
      opening: 1000.1,
      flows: [
        flow('2026-10-28', 'in', 0.2),
        flow('2026-10-28', 'out', 0.1),
        flow('2026-10-30', 'out', 500),
        flow('2026-11-03', 'in', 250.05),
      ],
    })
    expect(p.days).toHaveLength(30)
    expect(p.days[0]).toEqual({ date: '2026-10-28', opening: 1000.1, inflow: 0.2, outflow: 0.1, closing: 1000.2, lowest: false })
    expect(p.days[2]).toMatchObject({ date: '2026-10-30', opening: 1000.2, outflow: 500, closing: 500.2 })
    expect(p.weeks).toHaveLength(13)
    expect(p.weeks[0]).toMatchObject({ iso_week: '2026-W44', start: '2026-10-26', end: '2026-11-01', opening: 1000.1, inflow: 0.2, outflow: 500.1, closing: 500.2, min_closing: 500.2 })
    expect(p.weeks[1]).toMatchObject({ iso_week: '2026-W45', opening: 500.2, inflow: 250.05, closing: 750.25 })
    expect(p.weeks[12]).toMatchObject({ iso_week: '2027-W03', end: '2027-01-24', closing: 750.25 })
    expect(p.closing).toBe(750.25)
    // Every week chains: the next week opens where the last one closed.
    for (let i = 1; i < p.weeks.length; i++) expect(p.weeks[i].opening).toBe(p.weeks[i - 1].closing)
  })

  it('flags the lowest point, the earliest day on a tie, in the day and the week', () => {
    const p = projectCashForecast({
      window,
      weeks: 13,
      opening: 100,
      flows: [flow('2026-11-02', 'out', 300), flow('2026-11-05', 'in', 300), flow('2026-11-20', 'out', 300)],
    })
    expect(p.lowest).toEqual({ date: '2026-11-02', closing: -200, iso_week: '2026-W45' })
    expect(p.days.filter((d) => d.lowest).map((d) => d.date)).toEqual(['2026-11-02'])
    expect(p.weeks.filter((w) => w.lowest).map((w) => w.iso_week)).toEqual(['2026-W45'])
    // The week's own low is the dip inside it, not its closing.
    expect(p.weeks[1]).toMatchObject({ closing: 100, min_closing: -200 })
  })

  it('projects nothing before today or after the last week, and no zero flows', () => {
    const p = projectCashForecast({
      window,
      weeks: 13,
      opening: 0,
      flows: [flow('2026-10-27', 'in', 99), flow('2027-01-25', 'in', 99), flow('2026-11-01', 'in', 0)],
    })
    expect(p.flows).toEqual([])
    expect(p.closing).toBe(0)
  })

  it('keeps the flows inside the window by date', () => {
    const p = projectCashForecast({
      window,
      weeks: 13,
      opening: 0,
      flows: [flow('2026-11-10', 'in', 1, { reference: 'b' }), flow('2026-11-01', 'in', 1, { reference: 'a' }), flow('2026-11-10', 'out', 1, { reference: 'c' })],
    })
    expect(p.flows.map((f) => f.reference)).toEqual(['a', 'b', 'c'])
  })

  it('shows fewer than 30 days when the horizon is one week', () => {
    const p = projectCashForecast({ window: { today: '2026-10-28', end: forecastEnd('2026-10-28', 1) }, weeks: 1, opening: 5, flows: [] })
    expect(p.days.map((d) => d.date)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
    expect(p.weeks).toHaveLength(1)
  })
})

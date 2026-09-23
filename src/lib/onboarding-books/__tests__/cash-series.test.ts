import { describe, expect, it } from 'vitest'
import { biggestInflow, buildCashSeries, shortLabel } from '../cash-series'

describe('buildCashSeries', () => {
  it('walks back from today so the line ends on the real balance', () => {
    const pts = buildCashSeries({
      transactions: [
        { date: '2026-09-08', amount: -1000, description: 'Hyra' },
        { date: '2026-09-09', amount: 2500, description: 'Nordic Retail AB' },
      ],
      balanceToday: 10000,
      fromDate: '2026-09-07',
      today: '2026-09-10',
    })
    // End-of-day balances: day 9's inflow lifts day 9, day 8's rent lowers day 8.
    expect(pts.map((p) => p.v)).toEqual([8500, 7500, 10000, 10000])
    expect(pts[1].outflow).toBe(1000)
    expect(pts[2].inflow).toBe(2500)
    expect(pts[1].ev).toBe('Hyra')
  })

  it('names only the biggest outflows and keeps the counterpart text short', () => {
    const pts = buildCashSeries({
      transactions: [
        { date: '2026-09-01', amount: -50, description: 'Kaffe' },
        { date: '2026-09-02', amount: -118000, description: 'Löner september, alla anställda' },
        { date: '2026-09-03', amount: -48210, description: 'Skatteverket' },
        { date: '2026-09-04', amount: -36000, description: 'Stadshus Fastigheter AB, hyra' },
      ],
      balanceToday: 0,
      fromDate: '2026-09-01',
      today: '2026-09-05',
      nameOutflows: 2,
    })
    expect(pts.filter((p) => p.ev).map((p) => p.ev)).toEqual(['Löner september', 'Skatteverket'])
  })

  it('returns nothing for an inverted window and rounds to öre', () => {
    expect(buildCashSeries({ transactions: [], balanceToday: 1, fromDate: '2026-09-10', today: '2026-09-01' })).toEqual([])
    const pts = buildCashSeries({
      transactions: [{ date: '2026-09-10', amount: 0.105, description: null }],
      balanceToday: 1,
      fromDate: '2026-09-09',
      today: '2026-09-10',
    })
    // The day's net rounds to öre first (0.105 -> 0.11), then the balance.
    expect(pts[0].v).toBe(0.89)
    expect(pts[1].v).toBe(1)
  })
})

describe('labels', () => {
  it('shortens and falls back', () => {
    expect(shortLabel(null, 16, 'Payment')).toBe('Payment')
    expect(shortLabel('Acme AB, invoice 12')).toBe('Acme AB')
    expect(shortLabel('En väldigt lång motpartstext', 10)).toBe('En väldig…')
  })

  it('uses the caller locale for grouped outflows and unnamed inflows', () => {
    const transactions = [
      { date: '2026-09-01', amount: -10, description: 'Acme AB' },
      { date: '2026-09-01', amount: -20, description: 'Jane Doe' },
    ]
    const points = buildCashSeries({ transactions, balanceToday: 100, fromDate: '2026-09-01', today: '2026-09-01', outflowFallbackLabel: 'Payment' })
    expect(points[0].ev).toBe('Payment')
    expect(biggestInflow([{ date: '2026-09-01', amount: 100, description: null }], 'Deposit')?.label).toBe('Deposit')
  })

  it('biggestInflow picks the largest positive row', () => {
    expect(biggestInflow([
      { date: '2026-09-01', amount: -5, description: 'x' },
      { date: '2026-09-02', amount: 700, description: 'Kund A' },
      { date: '2026-09-03', amount: 900, description: 'Kund B' },
    ])).toEqual({ label: 'Kund B', amount: 900 })
    expect(biggestInflow([])).toBeNull()
  })
})

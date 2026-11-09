import { describe, expect, it } from 'vitest'
import { measured, withinBudget } from './budget'
import { buildDataset, YEAR_ENTRY_COUNTS } from './dataset'

describe('browser performance deadlines', () => {
  it('records completed browser actions with the shared duration format', async () => {
    const info = { annotations: [] as { type: string; description?: string }[] }
    await measured(info, 'ready ledger', 100, async () => {})
    expect(info.annotations).toEqual([{ type: 'duration', description: expect.stringMatching(/^ready ledger: \d+ ms \/ 100 ms$/) }])
  })
  it('does not annotate failed actions as successful timings', async () => {
    const info = { annotations: [] as { type: string; description?: string }[] }
    await expect(measured(info, 'broken ledger', 100, async () => { throw new Error('HTTP 500') })).rejects.toThrow('HTTP 500')
    expect(info.annotations).toEqual([])
  })
  it('returns successful action results and elapsed time', async () => {
    const result = await withinBudget('ready page', 100, async () => 42)
    expect(result.value).toBe(42)
    expect(result.elapsed).toBeLessThan(100)
  })
  it('fails when the action never becomes ready', async () => {
    await expect(withinBudget('stuck page', 15, () => new Promise(() => {}))).rejects.toThrow('exceeded 15 ms')
  })
  it('preserves application failures', async () => {
    await expect(withinBudget('broken page', 100, async () => { throw new Error('HTTP 500') })).rejects.toThrow('HTTP 500')
  })
  it('fails even when synchronous work delays the deadline timer', async () => {
    await expect(withinBudget('blocked page', 5, async () => {
      const until = performance.now() + 20
      while (performance.now() < until) { /* Simulate a blocked event loop. */ }
    })).rejects.toThrow('budget 5 ms')
  })
})

describe('ten-year synthetic fixture', () => {
  it('is deterministic, bounded and spans ten consecutive years', () => {
    const dataset = buildDataset(2026)
    expect(dataset).toEqual(buildDataset(2026))
    expect(dataset.years.map(item => item.year)).toEqual([2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026])
    expect(dataset.total).toBe(3225)
    expect(dataset.years.map(item => item.count)).toEqual(YEAR_ENTRY_COUNTS)
    for (const year of dataset.years) expect(year.content.match(/#VER /g)).toHaveLength(year.count)
    const activeAccounts = new Set([...dataset.years[9].content.matchAll(/#TRANS (\d{4}) /g)].map(match => match[1]))
    expect(activeAccounts.size).toBeGreaterThan(90)
  })
  it('includes a zero-balance historical account without current-year vouchers', () => {
    const dataset = buildDataset(2026)
    const amounts = [...dataset.years[0].content.matchAll(/#TRANS 2081 \{\} (-?\d+)/g)]
      .map(match => Number(match[1]))
    expect(amounts).toHaveLength(2)
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(0)
    expect(dataset.years[9].content).not.toContain('#TRANS 2081 ')
  })
  it('includes paid history and current unpaid invoices due next year', () => {
    const invoices = buildDataset(2030).years.flatMap(year => year.invoices)
    expect(invoices.filter(invoice => invoice.kind === 'supplier')).toHaveLength(450)
    expect(invoices.filter(invoice => invoice.kind === 'customer')).toHaveLength(50)
    const unpaid = invoices.filter(invoice => invoice.unpaid)
    expect(unpaid).toHaveLength(2)
    expect(unpaid.every(invoice => invoice.due === '2031-01-03' && invoice.payment === null)).toBe(true)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerPage } from '../../../scripts/provider-migration/fixtures'
import type { SalesInvoiceDto } from '../dto'
// This is a pagination/correctness test. Staging timing runs keep real throttling.
vi.mock('../rate-limiter', () => ({ TokenBucketRateLimiter: class { async acquire() {} } }))
import { fetchMigrationPage } from '../provider-data-fetcher'

afterEach(() => vi.unstubAllGlobals())
describe('large provider register pagination', () => {
  it.each(['visma', 'bokio'] as const)('reads all 25,000 %s invoices through the real HTTP client and mapper', async provider => {
    const count = 25000, pageSize = provider === 'visma' ? 1000 : 50
    const requested: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      expect(url.hostname).toBe(provider === 'visma' ? 'eaccountingapi.vismaonline.com' : 'api.bokio.se')
      // Bokio's sales register is two endpoints; this run has no credit notes.
      if (url.pathname.endsWith('/credit-notes')) return Response.json(providerPage(provider, 1, 100, 0))
      const page = Number(url.searchParams.get(provider === 'visma' ? '$page' : 'page'))
      const size = Number(url.searchParams.get(provider === 'visma' ? '$pagesize' : 'pageSize'))
      expect(size).toBe(pageSize)
      requested.push(page)
      return Response.json(providerPage(provider, page, size, count))
    }))
    const ids = new Set<string>()
    let next: number | null = 1, lines = 0, totalOre = 0
    while (next !== null) {
      const page = await fetchMigrationPage(provider, 'synthetic-token', 'synthetic-company', 'salesInvoices', next)
      expect(page.total).toBe(count)
      expect(page.items.length).toBeLessThanOrEqual(pageSize)
      for (const record of page.items as SalesInvoiceDto[]) {
        expect(ids.has(record.id)).toBe(false)
        ids.add(record.id)
        lines += record.lines.length
        totalOre += Math.round(record.legalMonetaryTotal.payableAmount.value * 100)
      }
      next = page.nextPage
    }
    expect(requested).toEqual(Array.from({ length: count / pageSize }, (_, i) => i + 1))
    expect(ids.size).toBe(count)
    expect(ids.has('load-24999')).toBe(true)
    expect(lines).toBe(75000)
    expect(totalOre).toBe(937500000)
  })
})

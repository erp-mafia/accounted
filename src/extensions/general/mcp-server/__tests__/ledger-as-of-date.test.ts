/**
 * gnubok_get_ar_ledger and gnubok_get_supplier_ledger check as_of_date by
 * the rules v1 applies (lib/reports/ledger-as-of.ts). They used to pass it
 * through raw: "2025-02-30" answered an empty ledger and a string that is no
 * date put every invoice in the 90+ bucket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { tools } from '../server'

vi.mock('@/lib/reports/ar-ledger', () => ({ generateARLedger: vi.fn() }))
vi.mock('@/lib/reports/supplier-ledger', () => ({ generateSupplierLedger: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateARLedger).mockResolvedValue({ customers: [] } as never)
  vi.mocked(generateSupplierLedger).mockResolvedValue({ suppliers: [] } as never)
})

describe.each([
  ['gnubok_get_ar_ledger', generateARLedger],
  ['gnubok_get_supplier_ledger', generateSupplierLedger],
] as const)('%s: as_of_date', (name, generator) => {
  const tool = tools.find((t) => t.name === name)!

  it.each([
    ['2025-02-30', /Not a valid calendar date/],
    ['garbage', /Expected YYYY-MM-DD/],
    ['1999-12-31', /Year out of supported range/],
  ])('refuses %s with VALIDATION_ERROR before the generator runs', async (value, message) => {
    await expect(
      tool.execute({ as_of_date: value }, 'company-1', 'user-1', {} as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringMatching(message),
      issues: [{ field: 'as_of_date', message: expect.any(String) }],
    })
    expect(generator).not.toHaveBeenCalled()
  })

  it('passes a real date through and leaves an absent one to the generator default', async () => {
    await tool.execute({ as_of_date: '2026-09-30' }, 'company-1', 'user-1', {} as never)
    await tool.execute({}, 'company-1', 'user-1', {} as never)
    expect(generator).toHaveBeenNthCalledWith(1, {}, 'company-1', '2026-09-30')
    expect(generator).toHaveBeenNthCalledWith(2, {}, 'company-1', undefined)
  })
})

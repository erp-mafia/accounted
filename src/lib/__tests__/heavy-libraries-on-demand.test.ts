import { describe, it, expect, vi } from 'vitest'

/**
 * Heavy libraries load where the work happens (a dynamic import), not when a
 * module that every route or a client bundle reaches is evaluated. Each mock
 * passes the real module through and records that it was loaded.
 */
const loaded = vi.hoisted(() => new Set<string>())
vi.mock('xlsx', async (importOriginal) => {
  loaded.add('xlsx')
  return importOriginal()
})
vi.mock('qrcode', async (importOriginal) => {
  loaded.add('qrcode')
  return importOriginal()
})
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  loaded.add('@react-pdf/renderer')
  return importOriginal()
})
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  loaded.add('@anthropic-ai/sdk')
  return importOriginal()
})
vi.mock('@anthropic-ai/bedrock-sdk', async (importOriginal) => {
  loaded.add('@anthropic-ai/bedrock-sdk')
  return importOriginal()
})
vi.mock('ai', async (importOriginal) => {
  loaded.add('ai')
  return importOriginal()
})
vi.mock('@ai-sdk/openai-compatible', async (importOriginal) => {
  loaded.add('@ai-sdk/openai-compatible')
  return importOriginal()
})
vi.mock('@/lib/salary/tax-tables-fallback', async (importOriginal) => {
  loaded.add('tax-tables-fallback')
  return importOriginal()
})

describe('heavy libraries load on demand', () => {
  it('importing the modules that every route or the invoice editor reaches loads none of them', async () => {
    await import('@/lib/ai')
    await import('@/lib/reports/xlsx-export')
    await import('@/lib/import/shared/workbook-reader')
    await import('@/lib/invoices/payment-qr')
    await import('@/lib/invoices/render-invoice-pdf')
    await import('@/lib/salary/tax-tables')
    expect([...loaded]).toEqual([])
  })

  it('loads xlsx when a workbook is built', async () => {
    const { reportToWorkbook, textColumn } = await import('@/lib/reports/xlsx-export')
    await reportToWorkbook([{ name: 'Blad', columns: [textColumn('A')], rows: [['1']], mapRow: (r: string[]) => r }])
    expect(loaded.has('xlsx')).toBe(true)
  })
})

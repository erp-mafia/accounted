/**
 * gnubok_export_sie takes exclude_year_end_closing, the flag the REST and
 * dashboard exports already pass as exclude_closing (crm#1727). The tool's
 * inputSchema only declared fiscal_period_id, so the dispatcher refused the
 * key as unknown and an agent could not hand a file to a receiver that books
 * its own closing. What the flag does to #VER, #UB and #RES is covered in
 * lib/reports/__tests__/sie-export.test.ts; here only the pass-through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateSIEExport } from '@/lib/reports/sie-export'
import { createMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { findUnknownArgKeys } from '../arg-guard'

vi.mock('@/lib/reports/sie-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/sie-export')>()),
  generateSIEExport: vi.fn(),
}))

const tool = tools.find((t) => t.name === 'gnubok_export_sie')!
const PERIOD_ID = '22222222-2222-4222-8222-222222222222'

function companySupabase() {
  const { supabase, mockResult } = createMockSupabase()
  mockResult({ data: { company_name: 'Testbolaget AB', org_number: '556000-0001' } })
  return supabase
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateSIEExport).mockResolvedValue('#FLAGGA 0\r\n#SIETYP 4\r\n')
})

describe('gnubok_export_sie: exclude_year_end_closing', () => {
  it('declares the flag, so the dispatcher no longer refuses it as unknown', () => {
    const schema = tool.inputSchema as { properties: Record<string, { type: string }> }
    expect(schema.properties.exclude_year_end_closing.type).toBe('boolean')
    expect(
      findUnknownArgKeys(tool.inputSchema as Record<string, unknown>, {
        fiscal_period_id: PERIOD_ID,
        exclude_year_end_closing: true,
      }),
    ).toEqual([])
  })

  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])('passes %s to the export as %s and echoes it', async (value, expected) => {
    const args: Record<string, unknown> = { fiscal_period_id: PERIOD_ID }
    if (value !== undefined) args.exclude_year_end_closing = value

    const result = (await tool.execute(args, 'company-1', 'user-1', companySupabase() as never)) as Record<string, unknown>

    expect(generateSIEExport).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      fiscal_period_id: PERIOD_ID,
      company_name: 'Testbolaget AB',
      org_number: '556000-0001',
      exclude_year_end_closing: expected,
    })
    expect(result.exclude_year_end_closing).toBe(expected)
    const declared = Object.keys((tool.outputSchema as { properties: Record<string, unknown> }).properties)
    for (const key of Object.keys(result)) expect(declared, key).toContain(key)
  })

  it.each(['true', 'false', 1])('refuses %j with VALIDATION_ERROR before the export runs', async (value) => {
    await expect(
      tool.execute(
        { fiscal_period_id: PERIOD_ID, exclude_year_end_closing: value },
        'company-1',
        'user-1',
        companySupabase() as never,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      issues: [{ field: 'exclude_year_end_closing', message: expect.any(String) }],
    })
    expect(generateSIEExport).not.toHaveBeenCalled()
  })
})

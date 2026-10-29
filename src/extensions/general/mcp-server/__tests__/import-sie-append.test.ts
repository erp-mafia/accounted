/**
 * gnubok_import_sie with on_existing_year (issue #108): an imported year is
 * topped up with only the file's new vouchers. The argument is checked by
 * hand, the append is planned at staging (a refusal stages nothing) and the
 * staged params carry it to the approval. No new tool: tools/list is at its
 * size ceiling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/import/sie-append', () => ({ planSIEAppend: vi.fn() }))
vi.mock('@/lib/import/sie-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import/sie-jobs')>()),
  resolveSIEFiscalYear: vi.fn(async () => undefined),
}))

import { planSIEAppend } from '@/lib/import/sie-append'
import { tools } from '../server'

const importSie = tools.find((t) => t.name === 'gnubok_import_sie')!

const SIE = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" "3.0"', '#SIETYP 4', '#ORGNR 5566778899', '#RAR 0 20260101 20261231',
  '#KONTO 1930 "Bank"', '#KONTO 3001 "Försäljning"',
  '#VER A 7 20261215 "Faktura 7"', '{', '#TRANS 1930 {} 100.00', '#TRANS 3001 {} -100.00', '}',
].join('\n')

const MAPPINGS = ['1930', '3001'].map((number) => ({
  sourceAccount: number, sourceName: 'Konto', targetAccount: number, targetName: 'Konto',
  confidence: 1, matchType: 'exact', isOverride: false,
}))

const PLAN = {
  fiscalPeriodId: 'period-2026', baseImportId: 'base-import', fiscalYear: { start: '2026-01-01', end: '2026-12-31' },
  counts: { total: 1, present: 0, conflicts: 0, possibleDuplicates: 0, new: 1, toAdd: 1 },
  vouchers: [{ sourceOrdinal: 0, sourceId: 'A7', date: '2026-12-15', description: 'Faktura 7', amount: 100, verdict: 'new',
    series: 'A', matchedVoucher: null, yearEnd: false }],
  vouchersTruncated: false, series: [{ source: 'A', target: 'A', exists: true, vouchers: 1 }], yearSeries: ['A'],
  warnings: [], refusal: null,
}

function stage(args: Record<string, unknown>) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: { org_number: '5566778899' }, error: null }) // companies: the file's own number
  mock.enqueue({ data: { id: 'op-append' }, error: null }) // pending_operations insert
  const result = importSie.execute({ file_content: SIE, filename: 'append.se', mappings: MAPPINGS, ...args },
    'company-1', 'user-1', mock.supabase as never, { type: 'api_key' })
  return { result, mock }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(planSIEAppend).mockResolvedValue(PLAN as never)
})

describe('gnubok_import_sie on_existing_year', () => {
  it('declares the argument as an enum, with no new tool', () => {
    const schema = importSie.inputSchema as { properties: Record<string, { enum?: string[] }> }
    expect(schema.properties.on_existing_year.enum).toEqual(['append', 'append_with_duplicates'])
    expect(tools.filter((t) => t.name.includes('append'))).toEqual([])
  })

  it('refuses a value it does not know, naming the argument', async () => {
    const { result, mock } = stage({ on_existing_year: 'replace' })
    await expect(result).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'on_existing_year' }] })
    expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
    expect(planSIEAppend).not.toHaveBeenCalled()
  })

  it('stages an append with its plan in the preview and the choice in the params', async () => {
    const { result, mock } = stage({ on_existing_year: 'append' })
    const staged = (await result) as { staged: boolean; preview: Record<string, unknown> }
    expect(staged.staged).toBe(true)
    expect(vi.mocked(planSIEAppend).mock.calls[0][4]).toEqual({ includePossibleDuplicates: false })
    expect(staged.preview.append).toMatchObject({ base_import_id: 'base-import', counts: { toAdd: 1 } })
    expect(staged.preview.will).toContain('add 1 new vouchers')
    const params = (mock.findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }).params
    expect(params).toMatchObject({ on_existing_year: 'append', include_possible_duplicates: false })
  })

  it('includes the possible duplicates only with append_with_duplicates', async () => {
    const { result, mock } = stage({ on_existing_year: 'append_with_duplicates' })
    await result
    expect(vi.mocked(planSIEAppend).mock.calls[0][4]).toEqual({ includePossibleDuplicates: true })
    const params = (mock.findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }).params
    expect(params).toMatchObject({ on_existing_year: 'append', include_possible_duplicates: true })
  })

  it('stages nothing when the plan refuses, answering with its code and sentence', async () => {
    vi.mocked(planSIEAppend).mockResolvedValue({ ...PLAN, refusal: {
      code: 'SIE_IMPORT_APPEND_CONFLICT', message: '1 av filens verifikationer har samma nummer: A7.', details: {},
    } } as never)
    const { result, mock } = stage({ on_existing_year: 'append' })
    await expect(result).rejects.toMatchObject({ code: 'SIE_IMPORT_APPEND_CONFLICT', message: '1 av filens verifikationer har samma nummer: A7.' })
    expect(mock.findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('leaves an ordinary import unplanned', async () => {
    const { result } = stage({})
    await result
    expect(planSIEAppend).not.toHaveBeenCalled()
  })
})

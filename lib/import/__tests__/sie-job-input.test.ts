import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { SIEJobMappingsSchema } from '@/lib/api/schemas'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { parseSIEFile } from '../sie-parser'
import { suggestMappings } from '../account-mapper'
import { jobInput, prepareSIEJob } from '../sie-job-preparation'
import type { SIEJob } from '../sie-job-contract'
import { resolveSIEFiscalYear, submitSIEJob, validateSIEAccountingAmounts, validateSIEJobInput } from '../sie-jobs'
import type { AccountMapping } from '../types'

const options = {filename:'ledger.si',createFiscalPeriod:false,importOpeningBalances:false,importTransactions:true}
const mappings:AccountMapping[] = ['1930','3001'].map(number => ({sourceAccount:number,targetAccount:number,
  sourceName:'Account',targetName:'Account',confidence:1,matchType:'exact',isOverride:false}))
const content = '#FLAGGA 0\n#SIETYP 4\n#VER "" "" 20260201 "Unnumbered"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'

describe('SIE durable input boundaries', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('normalizes repeated identical source definitions before metadata upserts', () => {
    const parsed = parseSIEFile('#KONTO 1930 "Bank"\n#KONTO 1930 "Bank"\n#KONTO 3001 "Sales"\n' + content)
    const suggested = suggestMappings(parsed.accounts, BAS_REFERENCE)
    expect(suggested.map(mapping => mapping.sourceAccount)).toEqual(['1930', '1930', '3001'])
    expect(SIEJobMappingsSchema.parse(suggested).map(mapping => mapping.sourceAccount)).toEqual(['1930', '3001'])
  })

  it('preserves accepted mapping checkpoint positions when resuming older duplicate input', () => {
    const unique = Array.from({ length: 101 }, (_, index) => ({ ...mappings[0], sourceAccount: String(1000 + index) }))
    const acceptedMappings = [...unique.slice(0, 60), unique[0], ...unique.slice(60)]
    const fileHash = 'a'.repeat(64)
    const job = { file_hash: fileHash, manifest: { input: {
      version: 1, sourceHash: fileHash, mappings: acceptedMappings, options,
    } } } as unknown as SIEJob
    const resumed = jobInput(job)
    expect(resumed.mappings.map(mapping => mapping.sourceAccount)).toEqual(acceptedMappings.map(mapping => mapping.sourceAccount))
    expect(resumed.mappings.slice(100).map(mapping => mapping.sourceAccount)).toEqual(['1099', '1100'])
  })

  it.each([
    { targetAccount: '1940' },
    { sourceName: 'Conflicting name' },
    { defaultVatTreatment: 'standard_25' as const, vatTreatmentReviewed: true },
  ])('refuses conflicting source mappings before storage or database access: %j', async changes => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const database = { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }
    await expect(submitSIEJob(database as unknown as SupabaseClient, 'company-1', 'user-1', content,
      [...mappings, { ...mappings[0], ...changes }], options)).rejects.toThrow('kontomappning')
    expect(database.from).not.toHaveBeenCalled()
    expect(database.rpc).not.toHaveBeenCalled()
    expect(database.storage.from).not.toHaveBeenCalled()
  })

  it.each([
    '#VER A invalid 20260201 "Damaged voucher"\n{\n#TRANS 1930 {} 10\n#TRANS 3001 {} -10\n}',
    '#TRANS 1930 {} 10',
  ])('refuses a partially parsed file before storage or database access: %s', async malformed => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const partial = '#RAR 0 20260101 20261231\n' + content + '\n' + malformed
    const parsed = parseSIEFile(partial)
    expect(parsed.vouchers).toHaveLength(1)
    expect(parsed.issues.some(issue => issue.severity === 'error')).toBe(true)
    const database = { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }
    await expect(submitSIEJob(database as unknown as SupabaseClient, 'company-1', 'user-1', partial,
      mappings, options)).rejects.toThrow('tolkningsfel')
    expect(database.from).not.toHaveBeenCalled()
    expect(database.rpc).not.toHaveBeenCalled()
    expect(database.storage.from).not.toHaveBeenCalled()
  })

  it.each([
    { record: '#TRANS 1930 {}\n#TRANS 3001 {}', inVoucher: true },
    { record: '#TRANS 1930 {} not-a-number\n#TRANS 3001 {} ""', inVoucher: true },
    { record: '#TRANS 1930 {} 100abc\n#TRANS 3001 {} -100abc', inVoucher: true },
    { record: '#TRANS 1930 {} Infinity\n#TRANS 3001 {} -Infinity', inVoucher: true },
    { record: '#IB 0 1930\n#IB 0 3001\n#UB -1 1930 100\n#UB -1 2091 -100', inVoucher: false },
    { record: '#IB 0 1930 ""\n#IB 0 2091 unknown', inVoucher: false },
    { record: '#UB -1 1930\n#UB -1 2091', inVoucher: false },
    { record: '#UB -1 1930 100\n#UB -1 2091 -100\n#UB -1 1940 invalid', inVoucher: false },
  ])('refuses damaged selected amounts before storage or database access: $record', async ({ record, inVoucher }) => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const source = '#RAR 0 20260101 20261231\n' + (inVoucher ? content.replace('\n}', `\n${record}\n}`) : `${content}\n${record}`)
    const parsed = parseSIEFile(source)
    expect(parsed.issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(parsed.vouchers[0].lines).toHaveLength(2)
    const database = { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }
    await expect(submitSIEJob(database as unknown as SupabaseClient, 'company-1', 'user-1', source,
      mappings, { ...options, importOpeningBalances: true })).rejects.toThrow('ogiltiga belopp')
    expect(database.from).not.toHaveBeenCalled()
    expect(database.rpc).not.toHaveBeenCalled()
    expect(database.storage.from).not.toHaveBeenCalled()
  })

  it('allows unused historical and report warnings alongside corrected active postings', () => {
    const source = '#RAR 0 20260101 20261231\n' + content.replace('#TRANS 1930 {} 100', [
      '#BTRANS 1930 {} 99', '#BTRANS 1930 {}', '#RTRANS 1930 {}',
      '#RTRANS 1930 {} "100,00"', '#TRANS 1930 {} "100,00"',
    ].join('\n')) + '\n#IB -1 1930\n#IB 0 1930\n#UB -1 1930\n#UB 0 1930\n#RES 0 3001'
    const parsed = parseSIEFile(source)
    expect(parsed.vouchers[0].lines.map(line => line.amount)).toEqual([100, -100])
    expect(parsed.vouchers[0].corrections?.added.map(line => line.amount)).toEqual([100])
    expect(() => validateSIEJobInput(source, parsed, mappings, options)).not.toThrow()
  })

  it('does not use malformed prior-year UB when explicit IB or an opening voucher takes precedence', () => {
    const source = '#RAR 0 20260101 20261231\n' + content + '\n#IB 0 1930 0\n#UB -1 1930'
    expect(() => validateSIEJobInput(source, parseSIEFile(source), mappings,
      { ...options, importOpeningBalances: true })).not.toThrow()
    const openingVoucher = '#RAR 0 20260101 20261231\n#UB -1 1930\n#VER A 1 20260101 "Ingående balans"\n{\n#TRANS 1930 {} 100\n#TRANS 2091 {} -100\n}'
    expect(() => validateSIEJobInput(openingVoucher, parseSIEFile(openingVoucher), mappings,
      { ...options, importOpeningBalances: true })).not.toThrow()
  })

  it('rejects damaged active lines that can change opening-source selection in an IB-only import', () => {
    const source = '#RAR 0 20260101 20261231\n#UB -1 1930 100\n#UB -1 2091 -100\n' +
      '#VER A 1 20260101 "Ingående balans"\n{\n#TRANS 1930 {}\n#TRANS 2091 {}\n}'
    expect(() => validateSIEJobInput(source, parseSIEFile(source), mappings,
      { ...options, importOpeningBalances: true, importTransactions: false })).toThrow('ogiltiga belopp')
  })

  it.each([
    '#UB 0 1930', '#RES 0 3001 invalid',
    '#IB 0 1930\n#UB 0 1930 100', '#UB -1 1930\n#UB 0 1930 100',
  ])('validates amounts needed by a transaction-only migration adjustment: %s', record => {
    const parsed = parseSIEFile('#RAR 0 20260101 20261231\n' + content + '\n' + record)
    expect(() => validateSIEJobInput(content, parsed, mappings, options)).not.toThrow()
    expect(() => validateSIEAccountingAmounts(parsed, new Map(mappings.map(mapping => [mapping.sourceAccount, mapping.targetAccount])),
      { ...options, migrationAdjustment: true })).toThrow('ogiltiga belopp')
  })

  it('matches mapped account classes and ignores unused adjustment metadata', () => {
    const accountMap = new Map([['9001', '1930'], ['9002', '3001']])
    const scope = { ...options, importTransactions: false, migrationAdjustment: true }
    expect(() => validateSIEAccountingAmounts(parseSIEFile('#UB 0 9001'), accountMap, scope)).toThrow('ogiltiga belopp')
    expect(() => validateSIEAccountingAmounts(parseSIEFile('#RES 0 9002'), accountMap, scope)).toThrow('ogiltiga belopp')
    expect(() => validateSIEAccountingAmounts(parseSIEFile('#UB 0 9002\n#RES 0 9001\n#UB -1 9001'), accountMap, scope)).not.toThrow()
    expect(() => validateSIEAccountingAmounts(parseSIEFile('#IB 0 1930'), new Map([['1930', '1930']]), scope)).not.toThrow()
  })

  it.each([false, true])('checks adjustment sources before any prepared entry can execute (older snapshot: %s)', async olderSnapshot => {
    const source = '#RAR 0 20260101 20261231\n' + content + '\n#UB 0 1930 invalid'
    const parsed = parseSIEFile(source)
    const fileHash = createHash('sha256').update(source).digest('hex')
    const job = { company_id: 'company-1', file_hash: fileHash, file_storage_path: `company-1/sie-jobs/${fileHash}.se`,
      prepared_through: 1, manifest: { input: { version: 1, sourceHash: fileHash, mappings, options },
        snapshotComplete: true, metadataComplete: true, effectiveOpeningBalances: [],
        preparationTotals: { entries: 1, movements: [], skippedSample: [],
          skippedCounts: { empty: 0, unbalanced: 0, unmapped: 1, singleLine: 0, total: 1 } },
      } } as unknown as SIEJob
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { payload: [{ parsed: { ...parsed, vouchers: [] }, voucherGroups: 0, metadataGroups: 0,
        hasCurrentYearIb: false, sourceSeries: ['A'], ...(olderSnapshot ? {} : { openingBalanceVoucherCandidate: false }) }] } },
      { data: [] }, { data: [] },
    ])
    supabase.storage.from('sie-files').download.mockResolvedValue({ data: new Blob([source]), error: null })
    await expect(prepareSIEJob(supabase as unknown as SupabaseClient, job, Infinity)).rejects.toThrow('ogiltiga belopp')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('preserves older snapshot opening-voucher precedence when revalidating adjustment sources', async () => {
    const source = '#RAR 0 20260101 20261231\n#UB -1 1930 invalid\n#UB 0 1930 0\n' +
      '#VER A 1 20260101 "Ingående balans"\n{\n#TRANS 1930 {} 100\n#TRANS 2091 {} -100\n}'
    const parsed = parseSIEFile(source)
    const fileHash = createHash('sha256').update(source).digest('hex')
    const job = { company_id: 'company-1', file_hash: fileHash, file_storage_path: `company-1/sie-jobs/${fileHash}.se`,
      prepared_through: 1, manifest: { input: { version: 1, sourceHash: fileHash, mappings, options },
        snapshotComplete: true, metadataComplete: true, effectiveOpeningBalances: [],
        preparationTotals: { entries: 1, movements: [], skippedSample: [],
          skippedCounts: { empty: 0, unbalanced: 0, unmapped: 1, singleLine: 0, total: 1 } },
      } } as unknown as SIEJob
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { payload: [{ parsed: { ...parsed, vouchers: [] }, voucherGroups: 0, metadataGroups: 0,
        hasCurrentYearIb: false, sourceSeries: ['A'] }] } },
      { data: [] }, { data: [] }, { data: {} },
    ])
    supabase.storage.from('sie-files').download.mockResolvedValue({ data: new Blob([source]), error: null })
    await expect(prepareSIEJob(supabase as unknown as SupabaseClient, job, Infinity)).resolves.toBe(true)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('seal_sie_import_preparation', expect.any(Object))
  })

  it('preserves omitted voucher identity and resolves the sole containing fiscal period', async () => {
    const parsed = parseSIEFile(content)
    expect(parsed.vouchers).toHaveLength(1)
    expect(parsed.vouchers[0].numberOmitted).toBe(true)
    const {supabase,enqueueMany} = createQueuedMockSupabase()
    enqueueMany([{data:[{period_start:'2026-01-01',period_end:'2026-12-31'}]}])
    await resolveSIEFiscalYear(supabase as unknown as SupabaseClient, 'company-1', parsed)
    expect(parsed.stats.fiscalYearStart).toBe('2026-01-01')
    expect(()=>validateSIEJobInput(content,parsed,mappings,options)).not.toThrow()
  })
  it.each([{periods:[]},{periods:[{period_start:'2026-01-01',period_end:'2026-12-31'},{period_start:'2025-07-01',period_end:'2026-06-30'}]}])(
    'refuses missing or ambiguous containing periods', async ({periods}) => {
      const {supabase,enqueueMany} = createQueuedMockSupabase()
      enqueueMany([{data:periods}])
      await expect(resolveSIEFiscalYear(supabase as unknown as SupabaseClient,'company-1',parseSIEFile(content))).rejects.toThrow('saknar #RAR')
    })
  it('names an oversized voucher before any ledger write', () => {
    const withYear = '#RAR 0 20260101 20261231\n'+content
    const parsed = parseSIEFile(withYear)
    parsed.vouchers[0].lines = Array.from({length:2001},()=>parsed.vouchers[0].lines[0])
    expect(()=>validateSIEJobInput(withYear,parsed,mappings,options)).toThrow('2 000 rader')
  })
})

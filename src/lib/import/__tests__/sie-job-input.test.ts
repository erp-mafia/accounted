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

  it('preserves an unused custom target through submission and worker input validation', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const source = '#RAR 0 20260101 20261231\n#KONTO 9999 "Unused custom account"\n' + content
    const customMappings = [...mappings, {
      ...mappings[1], sourceAccount: '9999', targetAccount: '9999', matchType: 'manual' as const,
    }]
    const fileHash = createHash('sha256').update(source).digest('hex')
    const job = {
      id: 'import-1', job_state: 'queued', file_hash: fileHash,
      manifest: { input: { version: 1, sourceHash: fileHash, mappings: customMappings, options } },
    } as unknown as SIEJob
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'period-1' } }, { data: null }, { data: job }])

    await expect(submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1', source,
      customMappings, options)).resolves.toEqual(job)
    expect(supabase.rpc).toHaveBeenCalledWith('start_sie_import_job', expect.objectContaining({
      p_company_id: 'company-1', p_actor: 'user-1',
      p_manifest: expect.objectContaining({ input: expect.objectContaining({ mappings: customMappings }) }),
    }))
    expect(jobInput(job).mappings).toEqual(customMappings)
  })

  it('seals the used and the own accounts\' mappings, without unused BAS ones, when the import asks (#63)', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const source = '#RAR 0 20260101 20261231\n#KONTO 9999 "Unused custom account"\n#KONTO 2440 "Unused BAS account"\n' + content
    const fullChart = [...mappings, ...['9999', '2440'].map(number => ({ ...mappings[1], sourceAccount: number, targetAccount: number }))]
    const submit = async (submitted: typeof options & { onlyUsedAccounts?: boolean }) => {
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      enqueueMany([{ data: { id: 'period-1' } }, { data: null }, { data: { id: 'import-1', job_state: 'queued' } }])
      await submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1', source, fullChart, submitted)
      return vi.mocked(supabase.rpc).mock.calls[0][1].p_manifest.input
    }

    const usedOnly = await submit({ ...options, onlyUsedAccounts: true })
    // 2440 is unused BAS: left out. 9999 is unused but outside BAS: kept.
    expect(usedOnly.mappings.map((m: AccountMapping) => m.sourceAccount)).toEqual(['1930', '3001', '9999'])
    expect(usedOnly.options.onlyUsedAccounts).toBe(true)
    // The worker reads the sealed input on every lease, so a resumed
    // preparation creates the same accounts.
    const fileHash = createHash('sha256').update(source).digest('hex')
    const sealed = { id: 'import-1', file_hash: fileHash, manifest: { input: { ...usedOnly, sourceHash: fileHash } } } as unknown as SIEJob
    expect(jobInput(sealed).mappings.map(m => m.sourceAccount)).toEqual(['1930', '3001', '9999'])

    // Without the flag the input is what it was before the option existed.
    const whole = await submit(options)
    expect(whole.mappings.map((m: AccountMapping) => m.sourceAccount)).toEqual(['1930', '3001', '9999', '2440'])
    expect(whole.options).not.toHaveProperty('onlyUsedAccounts')
  })

  it('retains an empty target for accounts the import will treat as unmapped', () => {
    const unmapped = { ...mappings[0], targetAccount: '', targetName: '' }
    expect(SIEJobMappingsSchema.parse([unmapped])).toEqual([unmapped])
  })

  it.each(['0099', '9999'])('rejects financial use of target %s before storage or admission', async targetAccount => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const source = '#RAR 0 20260101 20261231\n' + content
    const database = { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }
    await expect(submitSIEJob(database as unknown as SupabaseClient, 'company-1', 'user-1', source,
      [mappings[0], { ...mappings[1], targetAccount }], options)).rejects.toMatchObject({
      code: 'SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS',
    })
    expect(database.from).not.toHaveBeenCalled()
    expect(database.rpc).not.toHaveBeenCalled()
    expect(database.storage.from).not.toHaveBeenCalled()
  })

  it('lets a line-less voucher dated outside the fiscal year through: it is skipped as empty, never posted', () => {
    // One #BTRANS-only voucher dated in the previous year refused the same
    // file three times (Easy Online Stores, 2026-09-16).
    const source = '#RAR 0 20260101 20261231\n' + content +
      '\n#VER "LESSLIE" 2 20250102 "Tomt verifikat"\n{\n#BTRANS 1930 {} 100 20250102\n}'
    expect(() => validateSIEJobInput(source, parseSIEFile(source), mappings, options)).not.toThrow()
  })

  it('still names a voucher with lines that lies outside the fiscal year', () => {
    const source = '#RAR 0 20260101 20261231\n' + content +
      '\n#VER "LESSLIE" 3 20250102 "Fel år"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'
    expect(() => validateSIEJobInput(source, parseSIEFile(source), mappings, options))
      .toThrow('SIE-verifikation LESSLIE3 (2025-01-02) ligger utanför räkenskapsåret.')
  })

  it.each(['#IB 0', '#UB 0', '#RES 0'])('rejects amounts on a non-reportable target in %s', record => {
    const source = '#RAR 0 20260101 20261231\n' + content + `\n${record} 9999 100`
    const custom = [...mappings, { ...mappings[1], sourceAccount: '9999', targetAccount: '9999' }]
    expect(() => validateSIEJobInput(source, parseSIEFile(source), custom,
      { ...options, importOpeningBalances: true })).toThrow('1000-8999')
  })

  it('rejects a non-reportable target for opening balances derived from prior-year UB', () => {
    const source = '#RAR 0 20260101 20261231\n#UB -1 1930 100\n#UB -1 2091 -100'
    expect(() => validateSIEJobInput(source, parseSIEFile(source),
      [{ ...mappings[0], targetAccount: '9999' }, { ...mappings[1], sourceAccount: '2091', targetAccount: '2091' }],
      { ...options, importTransactions: false, importOpeningBalances: true })).toThrow('1000-8999')
  })

  it('accepts a non-BAS source explicitly mapped into a supported report class', () => {
    const source = '#RAR 0 20260101 20261231\n' + content.replaceAll('3001', '9999')
    expect(() => validateSIEJobInput(source, parseSIEFile(source),
      [mappings[0], { ...mappings[1], sourceAccount: '9999' }], options)).not.toThrow()
  })

  it('does not mistake offsetting postings for an unused custom definition', () => {
    const source = '#RAR 0 20260101 20261231\n' + content +
      '\n#VER A 2 20260202 "Internal"\n{\n#TRANS 9999 {} 100\n#TRANS 9999 {} -100\n}'
    expect(() => validateSIEJobInput(source, parseSIEFile(source),
      [...mappings, { ...mappings[1], sourceAccount: '9999', targetAccount: '9999' }], options)).toThrow('1000-8999')
  })

  it('allows zero balances and deselected vouchers on a custom definition', () => {
    const source = '#RAR 0 20260101 20261231\n' + content.replaceAll('3001', '9999') +
      '\n#IB 0 9999 0\n#UB 0 9999 0\n#RES 0 9999 0'
    expect(() => validateSIEJobInput(source, parseSIEFile(source),
      [mappings[0], { ...mappings[1], sourceAccount: '9999', targetAccount: '9999' }],
      { ...options, importTransactions: false, importOpeningBalances: true })).not.toThrow()
  })

  it.each(['new', 'snapshot', 'prepared'] as const)('rejects unsupported targets in %s worker preparation before any write', async stage => {
    const source = '#RAR 0 20260101 20261231\n' + content.replaceAll('3001', '9999')
    const parsed = parseSIEFile(source)
    const fileHash = createHash('sha256').update(source).digest('hex')
    const custom = [mappings[0], { ...mappings[1], sourceAccount: '9999', targetAccount: '9999' }]
    const job = { company_id: 'company-1', file_hash: fileHash, file_storage_path: `company-1/sie-jobs/${fileHash}.se`,
      prepared_through: stage === 'prepared' ? 1 : 0,
      manifest: { input: { version: 1, sourceHash: fileHash, mappings: custom, options },
        snapshotComplete: stage !== 'new', metadataComplete: true, effectiveOpeningBalances: [],
        preparedGroups: stage === 'prepared' ? 1 : 0,
        preparationTotals: { entries: 1, movements: stage === 'prepared' ? [['9999', -100]] : [], skippedSample: [],
          skippedCounts: { empty: 0, unbalanced: 0, unmapped: 0, singleLine: 0, total: 0 } },
      } } as unknown as SIEJob
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    if (stage !== 'new') enqueueMany([
      { data: { payload: [{ parsed: { ...parsed, vouchers: [] }, voucherGroups: 1, metadataGroups: 0,
        hasCurrentYearIb: false, sourceSeries: ['A'], openingBalanceVoucherCandidate: false }] } },
      { data: [] }, { data: [] }, { data: { payload: [JSON.parse(JSON.stringify(parsed.vouchers))] } },
    ])
    supabase.storage.from('sie-files').download.mockResolvedValue({ data: new Blob([source]), error: null })
    await expect(prepareSIEJob(supabase as unknown as SupabaseClient, job, Infinity)).rejects.toMatchObject({
      code: 'SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS',
    })
    expect(supabase.rpc).not.toHaveBeenCalled()
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
  // Fortnox's "Kundfakturor och inbetalningar" export: no #RAR, verifikat over
  // several years. No company year can contain it, and creating one (what the
  // old refusal asked for) never helps: the refusal names the partial export.
  const multiYear = '#FLAGGA 0\n#SIETYP 4\n#PROGRAM "Fortnox" 3.62\n' +
    '#VER B 1 20200115 "Kundfaktura"\n{\n#TRANS 1510 {} 125\n#TRANS 3001 {} -125\n}\n' +
    '#VER C 1 20261103 "Inbetalning"\n{\n#TRANS 1930 {} 125\n#TRANS 1510 {} -125\n}'
  it.each([
    { label: 'the books hold the years the file spans', periods: [
      { period_start: '2020-01-01', period_end: '2020-12-31' }, { period_start: '2026-01-01', period_end: '2026-12-31' }] },
    { label: 'the company has no year yet', periods: [] },
  ])('names a multi-year file without #RAR as a partial export when $label', async ({ periods }) => {
    const {supabase,enqueueMany} = createQueuedMockSupabase()
    enqueueMany([{data:periods}])
    const parsed = parseSIEFile(multiYear)
    const refusal = resolveSIEFiscalYear(supabase as unknown as SupabaseClient,'company-1',parsed)
    await expect(refusal).rejects.toThrow('över mer än ett räkenskapsår (2020-01-15 till 2026-11-03)')
    await expect(refusal).rejects.toThrow('Exportera i stället hela bokföringen som SIE typ 4, en fil per räkenskapsår')
    await expect(refusal).rejects.not.toThrow('Skapa ett räkenskapsår')
    expect(parsed.stats.fiscalYearStart).toBeFalsy()
  })
  it('still asks for a year when the dates fit one and the company has none, naming the dates', async () => {
    const {supabase,enqueueMany} = createQueuedMockSupabase()
    enqueueMany([{data:[]}])
    await expect(resolveSIEFiscalYear(supabase as unknown as SupabaseClient,'company-1',parseSIEFile(content)))
      .rejects.toThrow('Skapa ett räkenskapsår som omfattar filens datum (2026-02-01 till 2026-02-01) först.')
  })
  it('resolves an extended first year of up to 18 months that contains every date', async () => {
    const extended = content.replace('20260201', '20250715') + '\n#VER "" "" 20261220 "Late"\n{\n#TRANS 1930 {} 50\n#TRANS 3001 {} -50\n}'
    const {supabase,enqueueMany} = createQueuedMockSupabase()
    enqueueMany([{data:[{period_start:'2025-07-01',period_end:'2026-12-31'}]}])
    const parsed = parseSIEFile(extended)
    await resolveSIEFiscalYear(supabase as unknown as SupabaseClient,'company-1',parsed)
    expect(parsed.stats).toMatchObject({ fiscalYearStart: '2025-07-01', fiscalYearEnd: '2026-12-31' })
  })
  it('names an oversized voucher before any ledger write', () => {
    const withYear = '#RAR 0 20260101 20261231\n'+content
    const parsed = parseSIEFile(withYear)
    parsed.vouchers[0].lines = Array.from({length:2001},()=>parsed.vouchers[0].lines[0])
    expect(()=>validateSIEJobInput(withYear,parsed,mappings,options)).toThrow('2 000 rader')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { compareSIEOrgNumber } from '../sie-org-number'
import { submitSIEJob } from '../sie-jobs'
import type { SIEJob } from '../sie-job-contract'
import type { AccountMapping } from '../types'

const options = {filename:'ledger.se',createFiscalPeriod:false,importOpeningBalances:false,importTransactions:true}
const mappings:AccountMapping[] = ['1930','3001'].map(number => ({sourceAccount:number,targetAccount:number,
  sourceName:'Account',targetName:'Account',confidence:1,matchType:'exact',isOverride:false}))
const body = '#RAR 0 20260101 20261231\n#VER "" "" 20260201 "Sale"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'
const fileFor = (orgnr?: string) =>
  `#FLAGGA 0\n#SIETYP 4\n#FNAMN "Example AB"\n${orgnr ? `#ORGNR ${orgnr}\n` : ''}${body}`

describe('compareSIEOrgNumber', () => {
  it.each([
    ['556677-8899', '5566778899'],
    ['16556677-8899', '5566778899'],
    ['5566778899', '165566778899'],
    ['19800101-1231', '8001011231'],
    [' 556677 8899 ', '556677-8899'],
  ])('treats %s and %s as one number', (file, company) => {
    expect(compareSIEOrgNumber(file, company).mismatch).toBe(false)
  })

  it('flags two different numbers', () => {
    expect(compareSIEOrgNumber('556677-8899', '5599887766')).toEqual({
      fileOrgNumber: '556677-8899', companyOrgNumber: '5599887766', mismatch: true,
    })
  })

  it.each([
    [null, '5566778899'],
    ['', '5566778899'],
    ['556677-8899', null],
    ['556677-8899', '  '],
  ])('does not compare when a side is missing (%s, %s)', (file, company) => {
    expect(compareSIEOrgNumber(file, company).mismatch).toBe(false)
  })

  it('compares a value that is not org-number shaped as written', () => {
    expect(compareSIEOrgNumber('SE556677889901', '5566778899').mismatch).toBe(true)
    expect(compareSIEOrgNumber('ABC', 'ABC').mismatch).toBe(false)
  })
})

describe('submitSIEJob: the file\'s #ORGNR against the company', () => {
  afterEach(() => vi.unstubAllEnvs())

  function admitting(companyOrg: string | null) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    const job = { id: 'import-1', job_state: 'queued' } as unknown as SIEJob
    // companies, then the period, the predecessor and the start RPC.
    enqueueMany([{ data: { org_number: companyOrg } }, { data: { id: 'period-1' } }, { data: null }, { data: job }])
    return { supabase, job }
  }

  it('refuses another organisation\'s file before storage or admission', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase } = admitting('5599887766')

    await expect(submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1',
      fileFor('556677-8899'), mappings, options)).rejects.toMatchObject({
      code: 'SIE_IMPORT_ORG_NUMBER_MISMATCH',
      details: { file_org_number: '556677-8899', company_org_number: '5599887766', file_company_name: 'Example AB' },
    })
    expect(supabase.storage.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('admits it on an explicit confirmation, which stays out of the job\'s input', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase, job } = admitting('5599887766')

    await expect(submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1',
      fileFor('556677-8899'), mappings, { ...options, confirmOrgNumberMismatch: true })).resolves.toEqual(job)
    const manifest = vi.mocked(supabase.rpc).mock.calls[0][1].p_manifest
    // The retry identity is unchanged; the file's number is kept beside it.
    expect(manifest.input.options).not.toHaveProperty('confirmOrgNumberMismatch')
    expect(manifest.originalSource).toMatchObject({ orgNumber: '556677-8899' })
  })

  it('admits the 12-digit form of the company\'s own number without a confirmation', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase, job } = admitting('5566778899')

    await expect(submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1',
      fileFor('16556677-8899'), mappings, options)).resolves.toEqual(job)
  })

  it('admits a file without #ORGNR and reads no company for it', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    const job = { id: 'import-1', job_state: 'queued' } as unknown as SIEJob
    enqueueMany([{ data: { id: 'period-1' } }, { data: null }, { data: job }])

    await expect(submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1',
      fileFor(), mappings, options)).resolves.toEqual(job)
    expect(findCall('companies', 'select')).toBeUndefined()
    expect(vi.mocked(supabase.rpc).mock.calls[0][1].p_manifest.originalSource).toMatchObject({ orgNumber: null })
  })

  it('admits a file into a company without an org number', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase, job } = admitting(null)

    await expect(submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1',
      fileFor('556677-8899'), mappings, options)).resolves.toEqual(job)
  })
})

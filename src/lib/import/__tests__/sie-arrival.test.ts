import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SIEJob } from '../sie-job-contract'
import { submitSIEJob } from '../sie-jobs'
import type { AccountMapping } from '../types'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const IMPORT_ID = '33333333-3333-4333-8333-333333333333'

const options = { filename: 'bokforing.se', createFiscalPeriod: false, importOpeningBalances: false, importTransactions: true }
const mappings: AccountMapping[] = ['1930', '3001'].map((number) => ({
  sourceAccount: number, targetAccount: number, sourceName: 'Account', targetName: 'Account',
  confidence: 1, matchType: 'exact', isOverride: false,
}))
const content = '#FLAGGA 0\n#SIETYP 4\n#RAR 0 20260101 20261231\n#VER A 1 20260201 "Sale"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

let mock: ReturnType<typeof createQueuedMockSupabase>

/** period, predecessor, the job RPC; then the arrival's lookup and insert. */
function admit(job: Partial<SIEJob> | null = { id: IMPORT_ID, job_state: 'queued' }) {
  mock.enqueueMany([{ data: { id: 'period-1' } }, { data: null }, { data: job }, { data: null }])
  mock.enqueue({ data: [{ id: 'arrival-1', company_id: COMPANY, source: 'sie', source_ref: IMPORT_ID }] })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SIE_IMPORT_JOBS', 'true')
  mock = createQueuedMockSupabase()
})
afterEach(() => vi.unstubAllEnvs())

describe('SIE import arrivals', () => {
  it('records an uploaded file as an sie arrival pointing at the archived original bytes', async () => {
    admit()
    const raw = new TextEncoder().encode(content)
    const file = new File([raw], 'bokforing.se', { type: 'application/octet-stream' })
    const job = await submitSIEJob(mock.supabase as unknown as SupabaseClient, COMPANY, USER, content, mappings, options, file)
    expect(job.id).toBe(IMPORT_ID)

    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({
      company_id: COMPANY,
      source: 'sie',
      source_ref: IMPORT_ID,
      fetched_by: { type: 'user', user_id: USER },
      original_path: `${COMPANY}/sie-originals/${sha(raw)}.se`,
      original_sha256: sha(raw),
      original_mime: 'application/octet-stream',
      original_size: raw.byteLength,
    })
    expect(row.source_meta).toEqual({
      kind: 'sie',
      via: 'app',
      sie_import_id: IMPORT_ID,
      filename: 'bokforing.se',
      file_hash: sha(content),
      original_format: 'original_bytes',
      fiscal_year_start: '2026-01-01',
      fiscal_year_end: '2026-12-31',
      original_bucket: 'sie-files',
    })
  })

  it('points provided text (an MCP approval) at the archived job file, under the door it names', async () => {
    admit()
    await submitSIEJob(mock.supabase as unknown as SupabaseClient, COMPANY, USER, content, mappings, options, undefined, 'sie_file', {
      source: 'sie', via: 'mcp', fetchedBy: { type: 'user', user_id: USER, label: 'mcp-approval' },
    })
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({
      source: 'sie',
      fetched_by: { type: 'user', user_id: USER, label: 'mcp-approval' },
      original_path: `${COMPANY}/sie-jobs/${sha(content)}.se`,
      original_sha256: sha(content),
      original_mime: 'text/plain',
      original_size: Buffer.byteLength(content, 'utf8'),
    })
    expect(row.source_meta).toMatchObject({ via: 'mcp', original_format: 'provided_text' })
  })

  it('records a provider migration as source migration', async () => {
    admit()
    await submitSIEJob(mock.supabase as unknown as SupabaseClient, COMPANY, USER, content, mappings, options, undefined, 'provider_migration', {
      source: 'migration', via: 'provider_migration', fetchedBy: { type: 'user', user_id: USER, label: 'provider-migration' },
    })
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({ source: 'migration', source_ref: IMPORT_ID })
    expect(row.source_meta).toMatchObject({ kind: 'sie', via: 'provider_migration' })
  })

  it('finds the arrival of an identical retry instead of writing a second one', async () => {
    mock.enqueueMany([{ data: { id: 'period-1' } }, { data: null }, { data: { id: IMPORT_ID, job_state: 'queued' } }])
    mock.enqueue({ data: { id: 'arrival-1', company_id: COMPANY, source: 'sie', source_ref: IMPORT_ID } })
    await submitSIEJob(mock.supabase as unknown as SupabaseClient, COMPANY, USER, content, mappings, options)
    expect(mock.findCall('arrivals', 'select')).toBeDefined()
    expect(mock.findCall('arrivals', 'upsert')).toBeUndefined()
  })

  it('admits the import even when the arrival cannot be recorded', async () => {
    mock.enqueueMany([{ data: { id: 'period-1' } }, { data: null }, { data: { id: IMPORT_ID, job_state: 'queued' } }])
    mock.enqueue({ data: null, error: { message: 'relation "arrivals" does not exist' } })
    await expect(
      submitSIEJob(mock.supabase as unknown as SupabaseClient, COMPANY, USER, content, mappings, options),
    ).resolves.toMatchObject({ id: IMPORT_ID })
    expect(mock.findCall('arrivals', 'upsert')).toBeUndefined()
  })

  it('records nothing when the job RPC refuses', async () => {
    mock.enqueueMany([{ data: { id: 'period-1' } }, { data: null }])
    mock.enqueue({ data: null, error: { code: '55000', message: 'Existing SIE import requires reviewed replacement or reconciliation' } })
    await expect(
      submitSIEJob(mock.supabase as unknown as SupabaseClient, COMPANY, USER, content, mappings, options),
    ).rejects.toMatchObject({ code: 'SIE_IMPORT_PERIOD_ALREADY_IMPORTED' })
    expect(mock.findCall('arrivals', 'select')).toBeUndefined()
  })
})

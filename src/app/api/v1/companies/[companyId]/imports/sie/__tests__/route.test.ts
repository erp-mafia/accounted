/**
 * Integration tests for POST /api/v1/companies/:companyId/imports/sie.
 *
 * Regression: the route used to pass [] as account mappings, which
 * durable job admission's mapping-coverage guard rejects for any real file
 * (before that guard existed, every voucher was silently skipped). The
 * route must generate mappings server-side from the file's #KONTO records,
 * like the dashboard execute route does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

const { submitSIEJobMock } = vi.hoisted(() => ({
  submitSIEJobMock: vi.fn(),
}))

vi.mock('@/lib/import/sie-jobs', async (load) => ({
  ...await load<typeof import('@/lib/import/sie-jobs')>(), submitSIEJob: submitSIEJobMock,
}))
vi.mock('next/server', async (load) => ({...await load<typeof import('next/server')>(), after:vi.fn()}))
vi.mock('@/lib/import/sie-job-worker', () => ({runSIEWorker:vi.fn()}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { SIEJobValidationError } from '@/lib/import/sie-jobs'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const VALID_SIE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Import AB"',
  '#ORGNR 5566778899',
  '#RAR 0 20240101 20241231',
  '#KONTO 1930 "Företagskonto Swedbank"',
  '#KONTO 2081 "Aktiekapital"',
  '#KONTO 6110 "Kontorsmaterial"',
  '#IB 0 1930 50000.00',
  '#IB 0 2081 -50000.00',
  '#VER A 1 20240115 "Inköp"',
  '{',
  '#TRANS 6110 {} 1000.00',
  '#TRANS 1930 {} -1000.00',
  '}',
].join('\n')

function makeRequest(options?: Record<string, unknown>, content = VALID_SIE): Request {
  const fd = new FormData()
  fd.append('file', new File([content], 'bok.se', { type: 'application/octet-stream' }))
  if (options) fd.append('options', JSON.stringify(options))
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/imports/sie`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
    body: fd,
  })
}

function callRoute(options?: Record<string, unknown>, content?: string) {
  return POST(makeRequest(options, content), {
    params: Promise.resolve({ companyId: COMPANY_ID }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
  submitSIEJobMock.mockResolvedValue({
    id: 'op-1', job_state: 'queued', fiscal_period_id: 'fp-1',
  })
  mockServiceClient.mockReturnValue(
    makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      sie_account_mappings: { data: [], error: null },
    }),
  )
})

describe('POST /imports/sie', () => {
  it('generates account mappings from #KONTO records instead of passing []', async () => {
    const res = await callRoute()

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.data.operation_id).toBe('op-1')

    expect(submitSIEJobMock).toHaveBeenCalledTimes(1)
    const mappings = submitSIEJobMock.mock.calls[0][4] as Array<{
      sourceAccount: string
      sourceName: string
      targetAccount: string
    }>
    expect(mappings).toHaveLength(3)
    // Identity mappings carrying the file's #KONTO names.
    const m1930 = mappings.find((m) => m.sourceAccount === '1930')!
    expect(m1930.targetAccount).toBe('1930')
    expect(m1930.sourceName).toBe('Företagskonto Swedbank')
  })

  it('defaults updateAccountNames to true', async () => {
    await callRoute()

    const options = submitSIEJobMock.mock.calls[0][5] as Record<string, unknown>
    expect(options.updateAccountNames).toBe(true)
  })

  it('passes updateAccountNames: false through from the options JSON', async () => {
    await callRoute({ updateAccountNames: false })

    const options = submitSIEJobMock.mock.calls[0][5] as Record<string, unknown>
    expect(options.updateAccountNames).toBe(false)
  })

  it('rejects unknown options keys (schema stays strict)', async () => {
    const res = await callRoute({ updateAccountNamez: true })

    expect(res.status).toBe(400)
    expect(submitSIEJobMock).not.toHaveBeenCalled()
  })

  it('passes openingBalanceSeries through and leaves it undefined by default (issue #1882)', async () => {
    await callRoute({ openingBalanceSeries: 'K' })
    let options = submitSIEJobMock.mock.calls[0][5] as Record<string, unknown>
    expect(options.openingBalanceSeries).toBe('K')

    submitSIEJobMock.mockClear()
    await callRoute()
    options = submitSIEJobMock.mock.calls[0][5] as Record<string, unknown>
    // Undefined lets job preparation pick a series the file's own vouchers
    // do not use, instead of a hardcoded default that could collide.
    expect(options.openingBalanceSeries).toBeUndefined()
  })

  it('passes confirmOrgNumberMismatch through and leaves it undefined by default', async () => {
    await callRoute({ confirmOrgNumberMismatch: true })
    expect(submitSIEJobMock.mock.calls[0][5]).toMatchObject({ confirmOrgNumberMismatch: true })

    submitSIEJobMock.mockClear()
    await callRoute()
    expect((submitSIEJobMock.mock.calls[0][5] as Record<string, unknown>).confirmOrgNumberMismatch).toBeUndefined()
  })

  it('answers another organisation\'s file with 409 and both numbers', async () => {
    submitSIEJobMock.mockRejectedValueOnce(new SIEJobValidationError('mismatch', 'SIE_IMPORT_ORG_NUMBER_MISMATCH', {
      file_org_number: '5566778899', company_org_number: '5599887766', file_company_name: 'Import AB',
    }))

    const res = await callRoute()

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SIE_IMPORT_ORG_NUMBER_MISMATCH')
    expect(body.error.details).toMatchObject({ file_org_number: '5566778899', company_org_number: '5599887766' })
  })

  // #3312: the dashboard upload's class 9 decision, not suggestMappings alone.
  const WITH_OBS = VALID_SIE.replace('#KONTO 6110 "Kontorsmaterial"', '#KONTO 6110 "Kontorsmaterial"\n#KONTO 9999 "OBS-konto"') +
    '\n#VER A 2 20240120 "Okänd inbetalning"\n{\n#TRANS 1930 {} 500.00\n#TRANS 9999 {} -500.00\n}'

  it('maps a class 9 account carrying amounts to 2999 instead of refusing it as unmapped', async () => {
    const res = await callRoute(undefined, WITH_OBS)

    expect(res.status).toBe(202)
    const mappings = submitSIEJobMock.mock.calls[0][4] as Array<{ sourceAccount: string; targetAccount: string; matchType: string }>
    expect(mappings.find((m) => m.sourceAccount === '9999')).toMatchObject({ targetAccount: '2999', matchType: 'class' })
  })

  it('replaces a stored class 9 target for an account carrying amounts', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      sie_account_mappings: { data: [{ source_account: '9999', source_name: 'OBS-konto', target_account: '9999', confidence: 1, match_type: 'exact' }], error: null },
    }))

    const res = await callRoute(undefined, WITH_OBS)

    expect(res.status).toBe(202)
    const mappings = submitSIEJobMock.mock.calls[0][4] as Array<{ sourceAccount: string; targetAccount: string }>
    expect(mappings.find((m) => m.sourceAccount === '9999')?.targetAccount).toBe('2999')
  })
})

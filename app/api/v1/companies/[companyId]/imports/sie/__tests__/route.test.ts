/**
 * Integration tests for POST /api/v1/companies/:companyId/imports/sie.
 *
 * Regression: the route used to pass [] as account mappings, which
 * executeSIEImport's mapping-coverage guard rejects for any real file
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

const { executeSIEImportMock, checkDuplicateImportMock, startOperationMock } = vi.hoisted(() => ({
  executeSIEImportMock: vi.fn(),
  checkDuplicateImportMock: vi.fn().mockResolvedValue(null),
  startOperationMock: vi.fn().mockResolvedValue({ id: 'op-1' }),
}))

vi.mock('@/lib/import/sie-import', async () => {
  const actual = await vi.importActual<typeof import('@/lib/import/sie-import')>(
    '@/lib/import/sie-import',
  )
  return {
    ...actual,
    executeSIEImport: executeSIEImportMock,
    checkDuplicateImport: checkDuplicateImportMock,
  }
})
vi.mock('@/lib/api/v1/operations', () => ({
  startOperation: startOperationMock,
  completeOperation: vi.fn().mockResolvedValue(undefined),
  failOperation: vi.fn().mockResolvedValue(undefined),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
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

function makeRequest(options?: Record<string, unknown>): Request {
  const fd = new FormData()
  fd.append('file', new File([VALID_SIE], 'bok.se', { type: 'application/octet-stream' }))
  if (options) fd.append('options', JSON.stringify(options))
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/imports/sie`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
    body: fd,
  })
}

function callRoute(options?: Record<string, unknown>) {
  return POST(makeRequest(options), {
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
  checkDuplicateImportMock.mockResolvedValue(null)
  startOperationMock.mockResolvedValue({ id: 'op-1' })
  executeSIEImportMock.mockResolvedValue({
    success: true,
    importId: 'imp-1',
    fiscalPeriodId: 'fp-1',
    openingBalanceEntryId: 'ob-1',
    journalEntriesCreated: 1,
    journalEntryIds: ['je-1'],
    errors: [],
    warnings: [],
    replacedPriorImport: null,
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

    expect(executeSIEImportMock).toHaveBeenCalledTimes(1)
    const mappings = executeSIEImportMock.mock.calls[0][4] as Array<{
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

    const options = executeSIEImportMock.mock.calls[0][5] as Record<string, unknown>
    expect(options.updateAccountNames).toBe(true)
  })

  it('passes updateAccountNames: false through from the options JSON', async () => {
    await callRoute({ updateAccountNames: false })

    const options = executeSIEImportMock.mock.calls[0][5] as Record<string, unknown>
    expect(options.updateAccountNames).toBe(false)
  })

  it('rejects unknown options keys (schema stays strict)', async () => {
    const res = await callRoute({ updateAccountNamez: true })

    expect(res.status).toBe(400)
    expect(executeSIEImportMock).not.toHaveBeenCalled()
  })
})

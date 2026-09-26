/**
 * Import follow-up actions through the v1 door of the operation registry
 * (src/lib/operations/imports.ts via lib/operations/v1.ts):
 *   POST /imports/bank/:id/undo   imports.bank.undo
 *   POST /imports/sie/:id/undo    imports.sie.undo   (batch storno)
 *   POST /imports/sie/:id/resume  imports.sie.resume
 *
 * The rules under test: owner/admin for the undos (the service role would
 * otherwise skip it), only completed bank imports, booked rows never
 * deleted, SIE undo never deletes (it queues a storno), and a dry run
 * writes nothing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
  // undoBankFileImport escalates to a service client only when the key is set.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
const runWorkerMock = vi.fn()
vi.mock('@/lib/import/sie-job-worker', () => ({ runSIEWorker: (...a: unknown[]) => runWorkerMock(...a) }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as undoBank } from '../bank/[id]/undo/route'
import { POST as undoSie } from '../sie/[id]/undo/route'
import { POST as resumeSie } from '../sie/[id]/resume/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number
}

function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  const rpc = vi.fn((...args: unknown[]) => {
    calls.push({ table: 'rpc', method: 'rpc', args })
    return buildChain(`rpc:${String(args[0])}`)
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const BOOKS = new Set(['transactions', 'bank_file_imports', 'sie_imports', 'journal_entries', 'fiscal_periods'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const IMPORT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/imports`

function request(url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}
const params = (id = IMPORT_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:read', 'transactions:write', 'bookkeeping:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

// ---------------------------------------------------------------------------

describe('POST /imports/bank/:id/undo (imports.bank.undo)', () => {
  const post = (query = '', id = IMPORT_ID) => undoBank(request(`${BASE}/bank/${id}/undo${query}`), params(id))
  const completed = { data: { id: IMPORT_ID, status: 'completed' }, error: null }

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post()).status).toBe(403)
  })

  it('400 on a non-uuid id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post('', 'nope')).status).toBe(400)
  })

  it('404 BANK_FILE_UNDO_NOT_FOUND for an import outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, bank_file_imports: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('BANK_FILE_UNDO_NOT_FOUND')
  })

  it('403 BANK_FILE_UNDO_FORBIDDEN for a member key, even on a dry run', async () => {
    const client = makeClient({ company_members: MEMBER, bank_file_imports: completed })
    mockServiceClient.mockReturnValue(client)
    for (const query of ['', '?dry_run=true']) {
      const res = await post(query)
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('BANK_FILE_UNDO_FORBIDDEN')
    }
    expect(wrote(client)).toBe(false)
  })

  it('409 BANK_FILE_UNDO_NOT_COMPLETED for an import still processing', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, bank_file_imports: { data: { id: IMPORT_ID, status: 'processing' }, error: null } }))
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('BANK_FILE_UNDO_NOT_COMPLETED')
  })

  it('dry run counts deletable, booked and match-history rows and writes nothing', async () => {
    const T1 = '11111111-1111-4111-8111-111111111111'
    const T2 = '22222222-2222-4222-8222-222222222222'
    const T3 = '33333333-3333-4333-8333-333333333333'
    const T4 = '44444444-4444-4444-8444-444444444444'
    const client = makeClient({
      company_members: OWNER,
      bank_file_imports: completed,
      transactions: {
        data: [
          { id: T1, journal_entry_id: null, invoice_id: null, supplier_invoice_id: null },
          { id: T2, journal_entry_id: 'je', invoice_id: null, supplier_invoice_id: null },
          { id: T3, journal_entry_id: null, invoice_id: null, supplier_invoice_id: null },
          { id: T4, journal_entry_id: null, invoice_id: null, supplier_invoice_id: null },
        ],
        error: null,
      },
      invoice_payments: { data: [], error: null },
      supplier_invoice_payments: { data: [], error: null },
      transaction_voucher_links: { data: [{ transaction_id: T3 }], error: null },
      payment_match_log: { data: [{ transaction_id: T4 }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({
      would_delete_transactions: 1,
      skipped_booked: 2,
      skipped_match_history: 1,
      posted_entries_touched: 0,
    })
    expect(wrote(client)).toBe(false)
  })

  it('200 runs the RPC with the API key user as actor and reports what it skipped', async () => {
    const client = makeClient({
      company_members: OWNER,
      bank_file_imports: completed,
      'rpc:undo_bank_file_import': { data: { deleted: 212, skipped_booked: 3, skipped_match_history: 2 }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      bank_file_import_id: IMPORT_ID,
      deleted_transactions: 212,
      skipped_booked: 3,
      skipped_match_history: 2,
    })
    expect(client.rpc).toHaveBeenCalledWith('undo_bank_file_import', { p_company_id: COMPANY_ID, p_import_id: IMPORT_ID, p_user_id: 'user-1' })
  })
})

// ---------------------------------------------------------------------------

describe('POST /imports/sie/:id/undo and /resume', () => {
  const undo = (query = '', id = IMPORT_ID) => undoSie(request(`${BASE}/sie/${id}/undo${query}`), params(id))
  const resume = (query = '') => resumeSie(request(`${BASE}/sie/${IMPORT_ID}/resume${query}`), params())
  const job = (o: Record<string, unknown> = {}) => ({
    data: { id: IMPORT_ID, job_state: 'completed', job_kind: 'import', job_phase: 'finalize', user_id: 'user-2', execution_actor_id: null, fiscal_period_id: PERIOD_ID, ...o },
    error: null,
  })

  it('401 / 403 wrong scope / 400', async () => {
    mockValidate.mockResolvedValueOnce({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await undo()).status).toBe(401)
    mockValidate.mockResolvedValueOnce({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:write'], mode: 'live' })
    expect((await undo()).status).toBe(403)
    expect((await undo('', 'nope')).status).toBe(400)
  })

  it('404 for an import outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, sie_imports: { data: null, error: null } }))
    const res = await undo()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
  })

  it('409 SIE_IMPORT_LEGACY_REVIEW_REQUIRED for a pre-job import', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, sie_imports: job({ job_state: null }) }))
    expect((await (await undo()).json()).error.code).toBe('SIE_IMPORT_LEGACY_REVIEW_REQUIRED')
  })

  it('403 FORBIDDEN for a member key on undo', async () => {
    const client = makeClient({ company_members: MEMBER, sie_imports: job() })
    mockServiceClient.mockReturnValue(client)
    expect((await undo()).status).toBe(403)
    expect(wrote(client)).toBe(false)
  })

  it('409 SIE_IMPORT_ACTION_CONFLICT on a dry run into a locked period', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        sie_imports: [job(), { data: [], error: null }],
        fiscal_periods: { data: { id: PERIOD_ID, is_closed: false, locked_at: '2026-01-01T00:00:00Z', import_hold: null }, error: null },
      }),
    )
    const res = await undo('?dry_run=true')
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SIE_IMPORT_ACTION_CONFLICT')
  })

  it('dry run counts the entries a storno would reverse, deletes nothing, writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      sie_imports: [job(), { data: [], error: null }],
      fiscal_periods: { data: { id: PERIOD_ID, is_closed: false, locked_at: null, import_hold: null }, error: null },
      journal_entries: { data: null, error: null, count: 412 },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await undo('?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({
      method: 'batch_storno',
      posted_entries_to_reverse: 412,
      posted_entries_deleted: 0,
    })
    expect(wrote(client)).toBe(false)
    expect(runWorkerMock).not.toHaveBeenCalled()
  })

  it('200 queues the storno through request_sie_import_undo', async () => {
    const client = makeClient({
      company_members: OWNER,
      sie_imports: job(),
      'rpc:request_sie_import_undo': { data: { id: IMPORT_ID, job_state: 'undoing', job_phase: 'undo' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await undo()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ import_id: IMPORT_ID, action: 'undo', state: 'undoing', phase: 'undo', accepted: true })
    expect(client.rpc).toHaveBeenCalledWith('request_sie_import_undo', { p_company_id: COMPANY_ID, p_import_id: IMPORT_ID, p_actor: 'user-1' })
  })

  it('maps an RPC refusal (55000) to 409 SIE_IMPORT_ACTION_CONFLICT', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        sie_imports: job(),
        'rpc:request_sie_import_undo': { data: null, error: { code: '55000', message: 'Another SIE execution must finish before undo' } },
      }),
    )
    const res = await undo()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SIE_IMPORT_ACTION_CONFLICT')
  })

  it('resume: a member may resume their own run, not another user\'s', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, sie_imports: job({ job_state: 'paused' }) }))
    expect((await resume()).status).toBe(403)

    const client = makeClient({
      company_members: MEMBER,
      sie_imports: job({ job_state: 'paused', user_id: 'user-1' }),
      'rpc:resume_sie_import_job': { data: { id: IMPORT_ID, job_state: 'running', job_phase: 'vouchers' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await resume()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ action: 'resume', state: 'running' })
  })

  it('resume dry run writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, sie_imports: job({ job_state: 'paused' }) })
    mockServiceClient.mockReturnValue(client)
    const res = await resume('?dry_run=true')
    expect((await res.json()).data.preview).toMatchObject({ current_state: 'paused', would_change: true })
    expect(wrote(client)).toBe(false)
  })
})

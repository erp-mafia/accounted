/**
 * Salary-run lifecycle operations through the v1 door of the operation
 * registry (src/lib/operations/salary-run-lifecycle.ts via lib/operations/v1.ts):
 *   POST /api/v1/companies/:companyId/salary-runs/:id/send-payslips
 *   POST /api/v1/companies/:companyId/salary-runs/:id/revert
 *   POST /api/v1/companies/:companyId/salary-runs/:id/unapprove
 *   POST /api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId/expense-claims
 *
 * The rules under test are the services' (lib/salary/payslips/send.ts,
 * lib/salary/run-status-recall.ts, lib/salary/expense-claim-lines.ts): the
 * status each verb starts from, the AGI-filed refusal, the sandbox and
 * capability gates on the email, and a dry run that writes and sends nothing.
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  rotateLinkForEmployee: vi.fn(),
  isSandboxCompany: vi.fn(),
  hasCapability: vi.fn(),
  emit: vi.fn(),
}))
vi.mock('@/lib/email/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/service')>()),
  getEmailService: () => ({ sendEmail: mocks.sendEmail, isConfigured: () => true }),
}))
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForCompany: vi.fn().mockResolvedValue({ fromName: null, fromAddress: null, replyTo: null, brand: null }),
  getBaseUrlForBrand: vi.fn().mockReturnValue('https://app.example.test'),
}))
vi.mock('@/lib/salary/payslips/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payslips/links')>()),
  rotateLinkForEmployee: mocks.rotateLinkForEmployee,
}))
vi.mock('@/lib/sandbox/guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sandbox/guard')>()),
  isSandboxCompany: mocks.isSandboxCompany,
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: mocks.hasCapability,
}))
vi.mock('@/lib/company/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/context')>()),
  getCompanyDisplayName: vi.fn().mockResolvedValue('Ny Firma AB'),
}))
vi.mock('@/lib/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/events')>()),
  eventBus: { emit: mocks.emit, on: vi.fn(), off: vi.fn(), clear: vi.fn() },
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as sendPayslipsRoute } from '../send-payslips/route'
import { POST as revertRoute } from '../revert/route'
import { POST as unapproveRoute } from '../unapprove/route'
import { POST as attachRoute } from '../employees/[employeeId]/expense-claims/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

/** Per-table queue mock that also records every (table, method, args). */
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
    return buildChain('rpc')
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
/** Business tables only: withApiV1's own bookkeeping (idempotency, usage) is not the operation's. */
const BOOKS = new Set([
  'salary_runs',
  'agi_declarations',
  'salary_payslip_deliveries',
  'salary_payslip_links',
  'salary_line_items',
])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => BOOKS.has(c.table) && WRITES.has(c.method))
const writesTo = (client: ReturnType<typeof makeClient>, table: string, method: string) =>
  client.calls.filter((c) => c.table === table && c.method === method)

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMP_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const EMP2_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const CLAIM_ID = '99999999-9999-4999-8999-999999999999'
const LINE_ID = '88888888-8888-4888-8888-888888888888'
const AGI_ID = '77777777-7777-4777-8777-777777777777'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`

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

const runParams = (id = RUN_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })
const employeeParams = (employeeId = EMP_ID) => ({
  params: Promise.resolve({ companyId: COMPANY_ID, id: RUN_ID, employeeId }),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isSandboxCompany.mockResolvedValue(false)
  mocks.hasCapability.mockResolvedValue(true)
  mocks.rotateLinkForEmployee.mockResolvedValue({ token: 'T'.repeat(43) })
  mocks.sendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' })
  mocks.emit.mockResolvedValue(undefined)
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

// ---------------------------------------------------------------------------
// send-payslips
// ---------------------------------------------------------------------------

describe('POST /salary-runs/:id/send-payslips', () => {
  const APPROVED = { id: RUN_ID, status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25' }
  const ROSTER = [
    { employee_id: EMP_ID, employee: { first_name: 'Anna', last_name: 'Andersson', email: 'anna@example.test' } },
    { employee_id: EMP2_ID, employee: { first_name: 'Björn', last_name: 'Berg', email: null } },
  ]
  const client = (overrides: Record<string, TableResp | TableResp[]> = {}) =>
    makeClient({
      company_members: MEMBER,
      salary_runs: { data: APPROVED, error: null },
      companies: { data: { name: 'Bolaget AB', org_number: '5560000000' }, error: null },
      salary_run_employees: { data: ROSTER, error: null },
      ...overrides,
    })
  const post = (query = '', id = RUN_ID) => sendPayslipsRoute(request(`${BASE.replace(RUN_ID, id)}/send-payslips${query}`), runParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without payroll:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['payroll:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(client())
    expect((await post()).status).toBe(403)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR for a non-UUID run id', async () => {
    mockServiceClient.mockReturnValue(client())
    const res = await post('', 'not-a-uuid')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 SALARY_RUN_NOT_FOUND', async () => {
    mockServiceClient.mockReturnValue(client({ salary_runs: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('400 SALARY_PAYSLIPS_SEND_INVALID_STATUS for a run in review, sending nothing', async () => {
    const c = client({ salary_runs: { data: { ...APPROVED, status: 'review' }, error: null } })
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_PAYSLIPS_SEND_INVALID_STATUS')
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(wrote(c)).toBe(false)
  })

  it('403 SALARY_PAYSLIPS_SEND_SANDBOX from the sandbox company, before reading the run', async () => {
    mocks.isSandboxCompany.mockResolvedValue(true)
    const c = client()
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('SALARY_PAYSLIPS_SEND_SANDBOX')
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(wrote(c)).toBe(false)
  })

  it('403 SALARY_PAYSLIPS_SEND_CAPABILITY_BLOCKED without the email_send capability', async () => {
    mocks.hasCapability.mockResolvedValue(false)
    mockServiceClient.mockReturnValue(client())
    const res = await post()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('SALARY_PAYSLIPS_SEND_CAPABILITY_BLOCKED')
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('400 SALARY_PAYSLIPS_NO_EMPLOYEES for an empty run', async () => {
    mockServiceClient.mockReturnValue(client({ salary_run_employees: { data: [], error: null } }))
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SALARY_PAYSLIPS_NO_EMPLOYEES')
  })

  it('a dry run lists recipients and who lacks an email, and sends, rotates and logs nothing', async () => {
    const c = client()
    mockServiceClient.mockReturnValue(c)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      salary_run_id: RUN_ID,
      would_email: 1,
      would_skip_missing_email: 1,
      employees_missing_email: ['Björn Berg'],
      recipients: [
        { employee_id: EMP_ID, employee_name: 'Anna Andersson', has_email: true },
        { employee_id: EMP2_ID, employee_name: 'Björn Berg', has_email: false },
      ],
    })
    // Never the addresses, never a personnummer.
    expect(JSON.stringify(body.data.preview)).not.toContain('anna@example.test')
    expect(JSON.stringify(body.data.preview)).not.toMatch(/personnummer/)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(mocks.rotateLinkForEmployee).not.toHaveBeenCalled()
    expect(wrote(c)).toBe(false)
  })

  it('200: emails a link to each employee with an address, logs every attempt, and reports per employee', async () => {
    const c = client()
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      salary_run_id: RUN_ID,
      sent: 1,
      skipped: 1,
      failed: 0,
      total: 2,
      deliveries: [
        { employee_id: EMP_ID, employee_name: 'Anna Andersson', status: 'sent', error: null },
        { employee_id: EMP2_ID, employee_name: 'Björn Berg', status: 'skipped', error: 'Anställd saknar e-postadress' },
      ],
    })
    expect(mocks.rotateLinkForEmployee).toHaveBeenCalledWith(c, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMP_ID,
      userId: 'user-1',
    })
    const email = mocks.sendEmail.mock.calls[0][0]
    expect(email.to).toBe('anna@example.test')
    expect(email.html).toContain(`https://app.example.test/payslip/${'T'.repeat(43)}`)
    expect(email.attachments).toBeUndefined()
    const logged = writesTo(c, 'salary_payslip_deliveries', 'insert').map((call) => call.args[0])
    expect(logged).toEqual([
      expect.objectContaining({ employee_id: EMP_ID, status: 'sent', user_id: 'user-1', company_id: COMPANY_ID }),
      expect.objectContaining({ employee_id: EMP2_ID, status: 'skipped', email_address: '(saknas)' }),
    ])
  })

  it('a provider failure is logged and reported without stopping the batch', async () => {
    mocks.sendEmail.mockResolvedValue({ success: false, error: 'rate limited' })
    const c = client()
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ sent: 0, failed: 1, skipped: 1 })
    expect(body.data.deliveries[0]).toMatchObject({ status: 'failed', error: 'rate limited' })
  })
})

// ---------------------------------------------------------------------------
// revert (review -> draft)
// ---------------------------------------------------------------------------

describe('POST /salary-runs/:id/revert', () => {
  const post = (query = '', id = RUN_ID) => revertRoute(request(`${BASE.replace(RUN_ID, id)}/revert${query}`), runParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without payroll:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['payroll:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a non-UUID run id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post('', 'run-1')).status).toBe(400)
  })

  it('404 SALARY_RUN_NOT_FOUND', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, salary_runs: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('400 SALARY_RUN_REVERT_NOT_REVIEW for an approved run, writing nothing', async () => {
    const c = makeClient({ company_members: MEMBER, salary_runs: { data: { id: RUN_ID, status: 'approved' }, error: null } })
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_REVERT_NOT_REVIEW')
    expect(body.error.details).toMatchObject({ current_status: 'approved' })
    expect(wrote(c)).toBe(false)
  })

  it('a dry run previews the status change and writes nothing', async () => {
    const c = makeClient({ company_members: MEMBER, salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null } })
    mockServiceClient.mockReturnValue(c)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({ would_change_status_from: 'review', would_change_status_to: 'draft' })
    expect(wrote(c)).toBe(false)
  })

  it('200: flips review to draft, guarded on the status', async () => {
    const c = makeClient({
      company_members: MEMBER,
      salary_runs: [
        { data: { id: RUN_ID, status: 'review' }, error: null },
        { data: { id: RUN_ID, status: 'draft' }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ salary_run_id: RUN_ID, status: 'draft' })
    const update = writesTo(c, 'salary_runs', 'update')
    expect(update).toHaveLength(1)
    expect(update[0].args[0]).toEqual({ status: 'draft' })
    expect(c.calls).toContainEqual({ table: 'salary_runs', method: 'eq', args: ['status', 'review'] })
  })

  it('409 SALARY_RUN_STATUS_CHANGED when the run moves on between the check and the write', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        salary_runs: [
          { data: { id: RUN_ID, status: 'review' }, error: null },
          { data: null, error: { code: 'PGRST116', message: 'no rows' } },
        ],
      }),
    )
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SALARY_RUN_STATUS_CHANGED')
  })
})

// ---------------------------------------------------------------------------
// unapprove (approved -> review)
// ---------------------------------------------------------------------------

describe('POST /salary-runs/:id/unapprove', () => {
  const APPROVED = {
    id: RUN_ID,
    status: 'approved',
    agi_submitted_at: null,
    agi_generated_at: '2026-09-20T10:00:00Z',
    payment_file_format: 'pain001',
    payment_file_generated_at: '2026-09-21T10:00:00Z',
  }
  const post = (query = '', id = RUN_ID) =>
    unapproveRoute(request(`${BASE.replace(RUN_ID, id)}/unapprove${query}`), runParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without payroll:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['payroll:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a non-UUID run id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post('', 'run-1')).status).toBe(400)
  })

  it('404 SALARY_RUN_NOT_FOUND', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, salary_runs: { data: null, error: { code: 'PGRST116', message: 'no rows' } } }),
    )
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('400 SALARY_RUN_UNAPPROVE_NOT_APPROVED for a paid run', async () => {
    const c = makeClient({ company_members: MEMBER, salary_runs: { data: { ...APPROVED, status: 'paid' }, error: null } })
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SALARY_RUN_UNAPPROVE_NOT_APPROVED')
    expect(wrote(c)).toBe(false)
  })

  it.each([
    ['a submitted AGI declaration', { data: { id: AGI_ID, status: 'submitted' }, error: null }, APPROVED],
    ['an AGI awaiting signature', { data: { id: AGI_ID, status: 'pending_signature' }, error: null }, APPROVED],
    ['agi_submitted_at on the run', { data: null, error: null }, { ...APPROVED, agi_submitted_at: '2026-09-22T10:00:00Z' }],
  ])('409 SALARY_RUN_UNAPPROVE_AGI_FILED with %s, even on a dry run', async (_label, agi, run) => {
    for (const query of ['', '?dry_run=true']) {
      const c = makeClient({ company_members: MEMBER, salary_runs: { data: run, error: null }, agi_declarations: agi })
      mockServiceClient.mockReturnValue(c)
      const res = await post(query)
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe('SALARY_RUN_UNAPPROVE_AGI_FILED')
      expect(wrote(c)).toBe(false)
    }
    expect(mocks.emit).not.toHaveBeenCalled()
  })

  it('a dry run names the stale AGI it would delete, the payment file and the payslips sent, and writes nothing', async () => {
    const c = makeClient({
      company_members: MEMBER,
      salary_runs: { data: APPROVED, error: null },
      agi_declarations: { data: { id: AGI_ID, status: 'generated' }, error: null },
      salary_payslip_deliveries: { data: null, error: null, count: 2 },
    })
    mockServiceClient.mockReturnValue(c)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      would_change_status_from: 'approved',
      would_change_status_to: 'review',
      would_delete_agi_declaration_id: AGI_ID,
      payment_file_generated_at: APPROVED.payment_file_generated_at,
      payslips_already_sent: 2,
    })
    expect(body.data.preview.warnings).toHaveLength(2)
    expect(wrote(c)).toBe(false)
    expect(mocks.emit).not.toHaveBeenCalled()
  })

  it('200: back to review, approval and payment-file tracking cleared, stale AGI deleted, event emitted', async () => {
    const c = makeClient({
      company_members: MEMBER,
      salary_runs: [
        { data: APPROVED, error: null },
        { data: { id: RUN_ID, status: 'review' }, error: null },
      ],
      agi_declarations: [
        { data: { id: AGI_ID, status: 'exported' }, error: null },
        { data: [{ id: AGI_ID }], error: null },
      ],
    })
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ salary_run_id: RUN_ID, status: 'review', deleted_agi_declaration_id: AGI_ID })
    expect(writesTo(c, 'salary_runs', 'update')[0].args[0]).toEqual({
      status: 'review',
      approved_by: null,
      approved_at: null,
      agi_generated_at: null,
      payment_file_format: null,
      payment_file_generated_at: null,
    })
    // TOCTOU guard: an AGI filed after the read stops the update.
    expect(c.calls).toContainEqual({ table: 'salary_runs', method: 'is', args: ['agi_submitted_at', null] })
    expect(writesTo(c, 'agi_declarations', 'delete')).toHaveLength(1)
    expect(mocks.emit).toHaveBeenCalledWith({
      type: 'salary_run.approval_reverted',
      payload: {
        salaryRunId: RUN_ID,
        revertedBy: 'user-1',
        deletedAgiDeclarationId: AGI_ID,
        userId: 'user-1',
        companyId: COMPANY_ID,
      },
    })
  })

  it('keeps a rejected AGI declaration (it documents the rejection)', async () => {
    const c = makeClient({
      company_members: MEMBER,
      salary_runs: [
        { data: APPROVED, error: null },
        { data: { id: RUN_ID, status: 'review' }, error: null },
      ],
      agi_declarations: { data: { id: AGI_ID, status: 'rejected' }, error: null },
    })
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data.deleted_agi_declaration_id).toBeNull()
    expect(writesTo(c, 'agi_declarations', 'delete')).toHaveLength(0)
  })

  it('409 SALARY_RUN_STATUS_CHANGED when the run moved on concurrently', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        salary_runs: [
          { data: APPROVED, error: null },
          { data: null, error: { code: 'PGRST116', message: 'no rows' } },
        ],
      }),
    )
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SALARY_RUN_STATUS_CHANGED')
    expect(mocks.emit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// attach expense claims
// ---------------------------------------------------------------------------

describe('POST /salary-runs/:id/employees/:employeeId/expense-claims', () => {
  const CLAIM = { id: CLAIM_ID, description: 'Tågbiljett', expense_date: '2026-09-03', amount_sek: '450.00', liability_account: '2820' }
  const client = (overrides: Record<string, TableResp | TableResp[]> = {}) =>
    makeClient({
      company_members: MEMBER,
      salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
      salary_run_employees: { data: { id: 'sre-1', employee_id: EMP_ID }, error: null },
      expense_claims: { data: [CLAIM], error: null },
      salary_line_items: [
        { data: [], error: null },
        {
          data: [
            {
              id: LINE_ID,
              description: 'Utlägg: Tågbiljett (2026-09-03)',
              amount: 450,
              account_number: '2820',
              source_expense_claim_id: CLAIM_ID,
            },
          ],
          error: null,
        },
      ],
      ...overrides,
    })
  const post = (query = '', employeeId = EMP_ID) =>
    attachRoute(request(`${BASE}/employees/${employeeId}/expense-claims${query}`), employeeParams(employeeId))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without payroll:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['payroll:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(client())
    expect((await post()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a non-UUID employee id', async () => {
    mockServiceClient.mockReturnValue(client())
    expect((await post('', 'emp-1')).status).toBe(400)
  })

  it('404 SALARY_RUN_NOT_FOUND', async () => {
    mockServiceClient.mockReturnValue(client({ salary_runs: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('400 SALARY_RUN_LINE_NOT_DRAFT once the run left draft', async () => {
    const c = client({ salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null } })
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SALARY_RUN_LINE_NOT_DRAFT')
    expect(wrote(c)).toBe(false)
  })

  it('404 SALARY_RUN_EMPLOYEE_NOT_FOUND for an employee not on the run', async () => {
    mockServiceClient.mockReturnValue(client({ salary_run_employees: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SALARY_RUN_EMPLOYEE_NOT_FOUND')
  })

  it('404 SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS when nothing is open', async () => {
    mockServiceClient.mockReturnValue(client({ expense_claims: { data: [], error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS')
  })

  it('a dry run lists the claims that would be added and writes nothing', async () => {
    const c = client()
    mockServiceClient.mockReturnValue(c)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      claim_count: 1,
      total_sek: 450,
      claims: [{ expense_claim_id: CLAIM_ID, amount_sek: 450, liability_account: '2820' }],
    })
    expect(wrote(c)).toBe(false)
  })

  it('201: one tax-free line per claim, amount and account from the claim', async () => {
    const c = client()
    mockServiceClient.mockReturnValue(c)
    const res = await post()
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual({
      salary_run_id: RUN_ID,
      employee_id: EMP_ID,
      claim_count: 1,
      total_sek: 450,
      lines: [
        {
          salary_line_id: LINE_ID,
          expense_claim_id: CLAIM_ID,
          description: 'Utlägg: Tågbiljett (2026-09-03)',
          amount: 450,
          account_number: '2820',
        },
      ],
    })
    const [insert] = writesTo(c, 'salary_line_items', 'insert')
    expect(insert.args[0]).toEqual([
      expect.objectContaining({
        item_type: 'expense_reimbursement',
        amount: 450,
        is_taxable: false,
        is_avgift_basis: false,
        account_number: '2820',
        source_expense_claim_id: CLAIM_ID,
      }),
    ])
  })

  it('409 EXPENSE_CLAIM_ALREADY_ON_PAYSLIP when the claim lands on another payslip concurrently', async () => {
    mockServiceClient.mockReturnValue(
      client({
        salary_line_items: [
          { data: [], error: null },
          { data: null, error: { code: '23505', message: 'duplicate key' } },
        ],
      }),
    )
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('EXPENSE_CLAIM_ALREADY_ON_PAYSLIP')
  })
})

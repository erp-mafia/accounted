/**
 * The v1 stage mode (`?stage=true`, lib/operations/v1.ts + withApiV1).
 *
 * A write whose operation stages over MCP stages over REST too: it runs the
 * dry run only, inserts exactly one pending operation as the calling key and
 * answers 202 with it; nothing is committed. Everywhere else the flag is
 * refused before any handler runs, so a hand-written write can never commit
 * a request its caller sent to be staged. A staged request and a commit of
 * the same body never share an Idempotency-Key cache entry.
 *
 * Fake operations keep the test about the door: the run() is a spy, and the
 * registry is module state local to this file.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

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

// An in-memory idempotency_keys table: the stage/commit separation only shows
// when a stored key carries state from one request to the next.
const idempotency = vi.hoisted(() => ({ store: new Map<string, { hash: string; status: string; body: unknown }>() }))
vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>('@/lib/api/idempotency')
  return {
    ...actual,
    checkIdempotencyKey: vi.fn(async (_s: unknown, _u: string, _c: string, key: string, hash: string) => {
      const hit = idempotency.store.get(key)
      if (!hit) return null
      if (hit.hash !== hash) throw new actual.IdempotencyKeyReuseError(key)
      return { status: hit.status, body: hit.body }
    }),
    storeIdempotencyResponse: vi.fn(
      async (_s: unknown, _u: string, _c: string, key: string, hash: string, status: string, body: unknown) => {
        idempotency.store.set(key, { hash, status, body })
      },
    ),
    // The wrapper claims a key before the write runs (in-flight claims): the
    // same store answers the claim, so a stored stage still refuses a commit.
    claimIdempotencyKey: vi.fn(async (_s: unknown, target: { key: string; requestHash: string }) => {
      const hit = idempotency.store.get(target.key)
      if (hit) {
        if (hit.hash !== target.requestHash) throw new actual.IdempotencyKeyReuseError(target.key)
        return { replay: { status: hit.status, body: hit.body } }
      }
      return {
        claim: {
          complete: async (status: string, body: unknown) => {
            idempotency.store.set(target.key, { hash: target.requestHash, status, body })
          },
          release: async () => {},
        },
      }
    }),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { generateOpenApiSpec, listEndpoints, registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { ok } from '@/lib/api/v1/response'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { defineOperation, type OperationOutcome } from '../types'
import { v1OperationHandler } from '../v1'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STAGED_ID = '33333333-3333-4333-8333-333333333333'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

const DOCS = {
  summary: 'Test fixture.',
  description: 'Fixture operation for the stage mode tests.',
  useWhen: 'never: test fixture',
  doNotUseFor: 'anything outside this test file',
  pitfalls: [],
  example: { response: {} },
}

const stagedRun = vi.fn<(...args: unknown[]) => Promise<OperationOutcome<{ widget_id: string }>>>()
const directRun = vi.fn<(...args: unknown[]) => Promise<OperationOutcome<{ widget_id: string }>>>()
const handWritten = vi.fn()

// Stages over MCP (mcp.stage), so v1 accepts ?stage=true.
const widgetsCreate = defineOperation({
  id: 'widgets.create',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: false,
  docs: DOCS,
  input: z.object({ name: z.string().min(1), pay_to: z.string().optional() }),
  output: z.object({ widget_id: z.string() }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/widgets' },
  mcp: {
    name: 'gnubok_create_widget',
    title: 'Create Widget',
    stage: {
      pendingType: 'create_supplier',
      title: (input) => `Skapa ${String(input.name)}`,
      // What the approver saw is pinned into the staged params.
      pinParams: (input, preview) => ({ ...input, pay_to: preview.pay_to }),
    },
  },
  run: (...args) => stagedRun(...args),
})

// A write with no staging binding: commits directly over every door.
const widgetsRename = defineOperation({
  id: 'widgets.rename',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: true,
  docs: DOCS,
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ widget_id: z.string() }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/widgets/rename' },
  run: (...args) => directRun(...args),
})

const POST_STAGED = v1OperationHandler(widgetsCreate)
const POST_DIRECT = v1OperationHandler(widgetsRename)

// Writes that stage as types only a person approves in the app (risk-tiers.ts
// requiresWebApproval): always for a handover, per action for a case action.
const handoverRun = vi.fn<(...args: unknown[]) => Promise<OperationOutcome<{ case_id: string }>>>()
const caseActionRun = vi.fn<(...args: unknown[]) => Promise<OperationOutcome<{ case_id: string }>>>()
const widgetsHandOver = defineOperation({
  id: 'widgets.hand-over',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'high',
  reversible: false,
  docs: DOCS,
  input: z.object({ invoice_id: z.string() }),
  output: z.object({ case_id: z.string() }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/widgets/hand-over' },
  mcp: { name: 'gnubok_hand_over_widget', title: 'Hand Over Widget', stage: { pendingType: 'open_collection_case', title: () => 'Lämna över' } },
  run: (...args) => handoverRun(...args),
})
const widgetsCaseAction = defineOperation({
  id: 'widgets.case-action',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'high',
  reversible: false,
  docs: DOCS,
  input: z.object({ invoice_id: z.string(), action: z.string() }),
  output: z.object({ case_id: z.string() }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/widgets/case-action' },
  mcp: { name: 'gnubok_widget_case_action', title: 'Widget Case Action', stage: { pendingType: 'collection_case_action', title: () => 'Åtgärd' } },
  run: (...args) => caseActionRun(...args),
})
// A strict input that also has its own reason, as some operations do
// (a customer loss is booked with its reason on the voucher).
const lossRun = vi.fn<(...args: unknown[]) => Promise<OperationOutcome<{ widget_id: string }>>>()
const widgetsWriteOff = defineOperation({
  id: 'widgets.write-off',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: false,
  docs: DOCS,
  input: z.object({ widget_id: z.string(), reason: z.string().min(1) }).strict(),
  output: z.object({ widget_id: z.string() }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/widgets/write-off' },
  mcp: { name: 'gnubok_write_off_widget', title: 'Write Off Widget', stage: { pendingType: 'create_supplier', title: () => 'Skriv av' } },
  run: (...args) => lossRun(...args),
})
const strictRun = vi.fn<(...args: unknown[]) => Promise<OperationOutcome<{ widget_id: string }>>>()
const widgetsStrict = defineOperation({
  id: 'widgets.strict',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: false,
  docs: DOCS,
  input: z.object({ name: z.string().min(1) }).strict(),
  output: z.object({ widget_id: z.string() }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/widgets/strict' },
  mcp: { name: 'gnubok_create_strict_widget', title: 'Create Strict Widget', stage: { pendingType: 'create_supplier', title: () => 'Skapa' } },
  run: (...args) => strictRun(...args),
})
const POST_WRITE_OFF = v1OperationHandler(widgetsWriteOff)
const POST_STRICT = v1OperationHandler(widgetsStrict)

const POST_HAND_OVER = v1OperationHandler(widgetsHandOver)
const POST_CASE_ACTION = v1OperationHandler(widgetsCaseAction)

// A hand-written v1 write (not an operation): never stages.
registerEndpoint({
  operation: 'widgets.hand-written',
  method: 'POST',
  path: '/api/v1/companies/:companyId/widgets/hand-written',
  ...DOCS,
  scope: 'suppliers:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: z.object({}) },
})
const POST_HAND_WRITTEN = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'widgets.hand-written',
  async (_request, ctx) => {
    handWritten()
    return ok({ committed: true }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)

function client() {
  const insertEcho: TableMockResolver = (calls) => {
    const insert = calls.find((c) => c.method === 'insert')
    if (!insert) return { data: null }
    return {
      data: {
        id: STAGED_ID,
        status: 'pending',
        batch_id: null,
        result_data: null,
        rejection_category: null,
        rejection_reason: null,
        created_at: '2026-10-15T10:00:00.000Z',
        resolved_at: null,
        ...(insert.args[0] as Record<string, unknown>),
      },
    }
  }
  const mock = createTableMockSupabase({ company_members: OWNER, pending_operations: insertEcho })
  mockServiceClient.mockReturnValue(mock.supabase)
  return mock
}

function post(path: string, body: unknown, options: { query?: string; key?: string } = {}): Request {
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/${path}${options.query ?? ''}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': options.key ?? crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

function auth(mode: 'live' | 'test' = 'live') {
  return {
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'key-flow',
    apiKeyName: 'Attestflöde',
    scopes: ['suppliers:write'],
    mode,
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    unattendedCommitLimit: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  idempotency.store.clear()
  mockValidate.mockResolvedValue(auth())
  stagedRun.mockImplementation(async (_ctx, input, options) =>
    (options as { dryRun: boolean }).dryRun
      ? { ok: true, dryRun: true, preview: { name: (input as { name: string }).name, pay_to: '5050-1055' } }
      : { ok: true, data: { widget_id: 'w-1' }, created: true },
  )
  directRun.mockResolvedValue({ ok: true, data: { widget_id: 'w-2' } })
  for (const run of [lossRun, strictRun]) {
    run.mockImplementation(async (_ctx, input, options) =>
      (options as { dryRun: boolean }).dryRun
        ? { ok: true, dryRun: true, preview: { ...(input as Record<string, unknown>) } }
        : { ok: true, data: { widget_id: 'w-3' } },
    )
  }
  for (const run of [handoverRun, caseActionRun]) {
    run.mockImplementation(async (_ctx, input, options) =>
      (options as { dryRun: boolean }).dryRun
        ? { ok: true, dryRun: true, preview: { invoice_id: (input as { invoice_id: string }).invoice_id } }
        : { ok: true, data: { case_id: 'case-1' } },
    )
  }
})

describe("v1 stage mode: the stager's reason", () => {
  const REASON = 'Acme AB is on three supplier invoices in the inbox and not in the register yet.'

  it('stores a `reason` from the body on the pending operation, answers it as agent_reason, and never passes it to the operation', async () => {
    const mock = client()

    const res = await POST_STRICT(post('widgets/strict', { name: 'Acme', reason: `  ${REASON}  ` }, { query: '?stage=true' }), params)

    // The strict input would have refused an unknown key: it never saw it.
    expect(res.status).toBe(202)
    expect(strictRun.mock.calls[0][1]).toEqual({ name: 'Acme' })
    const inserts = mock.payloads('pending_operations', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ params: { name: 'Acme' }, agent_reason: REASON })
    const { data } = await res.json()
    expect(data.agent_reason).toBe(REASON)
  })

  it('names no agent_reason column without a reason, and answers agent_reason null', async () => {
    const mock = client()
    const res = await POST_STRICT(post('widgets/strict', { name: 'Acme' }, { query: '?stage=true' }), params)
    expect(res.status).toBe(202)
    expect(mock.payloads('pending_operations', 'insert')[0]).not.toHaveProperty('agent_reason')
    expect((await res.json()).data.agent_reason).toBeNull()
  })

  it('cuts a reason longer than 500 characters at a word boundary instead of refusing the write', async () => {
    const mock = client()
    const long = Array.from({ length: 150 }, (_, i) => `evidence${i}`).join(' ')
    const res = await POST_STRICT(post('widgets/strict', { name: 'Acme', reason: long }, { query: '?stage=true' }), params)
    expect(res.status).toBe(202)
    const stored = (mock.payloads('pending_operations', 'insert')[0] as Record<string, unknown>).agent_reason as string
    expect(Array.from(stored).length).toBeLessThanOrEqual(500)
    expect(long.startsWith(stored.slice(0, -1))).toBe(true)
  })

  it("keeps an operation's own reason as its input and stores it as the agent's reason too", async () => {
    const mock = client()
    const res = await POST_WRITE_OFF(
      post('widgets/write-off', { widget_id: 'w-9', reason: ' Konkurs ' }, { query: '?stage=true' }),
      params,
    )
    expect(res.status).toBe(202)
    expect(lossRun.mock.calls[0][1]).toEqual({ widget_id: 'w-9', reason: ' Konkurs ' })
    expect(mock.payloads('pending_operations', 'insert')[0]).toMatchObject({ agent_reason: 'Konkurs' })
  })

  it('leaves a direct commit alone: the strict input still refuses a stray reason', async () => {
    client()
    const res = await POST_STRICT(post('widgets/strict', { name: 'Acme', reason: REASON }), params)
    expect(res.status).toBe(400)
    expect(strictRun).not.toHaveBeenCalled()
  })

  it('still stages, without the reason, while the agent_reason column is not there yet', async () => {
    const mock = createTableMockSupabase({
      company_members: OWNER,
      pending_operations: (calls) => {
        const insert = calls.find((c) => c.method === 'insert')
        if (!insert) return { data: null }
        const row = insert.args[0] as Record<string, unknown>
        if ('agent_reason' in row) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'agent_reason' column" } }
        return { data: { id: STAGED_ID, status: 'pending', created_at: '2026-10-28T10:00:00.000Z', resolved_at: null, ...row } }
      },
    })
    mockServiceClient.mockReturnValue(mock.supabase)

    const res = await POST_STRICT(post('widgets/strict', { name: 'Acme', reason: REASON }, { query: '?stage=true' }), params)

    expect(res.status).toBe(202)
    const inserts = mock.payloads('pending_operations', 'insert')
    expect(inserts).toHaveLength(2)
    expect(inserts[1]).not.toHaveProperty('agent_reason')
    expect((await res.json()).data.agent_reason).toBeNull()
  })

  it('documents the reason on the stage parameter', () => {
    const spec = generateOpenApiSpec('https://x.test')
    const op = spec.paths['/api/v1/companies/{companyId}/widgets/strict']?.post as { parameters?: Array<{ name: string; description?: string }> }
    expect(op.parameters?.find((p) => p.name === 'stage')?.description).toContain('`reason`')
  })
})

describe('v1 stage mode', () => {
  it('?stage=true stages exactly one pending operation as the key, commits nothing and answers 202', async () => {
    const mock = client()

    const res = await POST_STAGED(post('widgets', { name: 'Acme' }, { query: '?stage=true' }), params)

    expect(res.status).toBe(202)
    const { data } = await res.json()
    expect(data).toMatchObject({
      pending_operation_id: STAGED_ID,
      // The typed handle (lib/handles) beside the unchanged id, as on GET /pending-operations.
      handle: 'pop_33333333333343338333333333333333',
      operation_type: 'create_supplier',
      title: 'Skapa Acme',
      status: 'pending',
      task_state: 'working',
      // The tier of the pending type, from the one table (risk-tiers.ts).
      risk_level: 'medium',
      preview: { name: 'Acme', pay_to: '5050-1055' },
      links: { approve: `/api/v1/companies/${COMPANY_ID}/pending-operations/${STAGED_ID}/approve` },
    })
    // The dry run ran; the commit never did.
    expect(stagedRun).toHaveBeenCalledTimes(1)
    expect(stagedRun.mock.calls[0][2]).toEqual({ dryRun: true })
    const inserts = mock.payloads('pending_operations', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      company_id: COMPANY_ID,
      user_id: 'user-1',
      operation_type: 'create_supplier',
      title: 'Skapa Acme',
      // Pinned from the preview the approver sees.
      params: { name: 'Acme', pay_to: '5050-1055' },
      actor_type: 'api_key',
      actor_id: 'key-flow',
      actor_label: 'Attestflöde',
      risk_level: 'medium',
    })
  })

  it('an OAuth key stages as what it is in every other record, not as its reserved name', async () => {
    mockValidate.mockResolvedValue({ ...auth(), apiKeyName: 'MCP-klient (OAuth)', client: 'claude' })
    const mock = client()

    await POST_STAGED(post('widgets', { name: 'Acme' }, { query: '?stage=true' }), params)

    expect(mock.payloads('pending_operations', 'insert')[0]).toMatchObject({
      actor_type: 'mcp_oauth',
      actor_id: 'key-flow',
      actor_label: 'Claude (Anthropic)',
    })
  })

  it('without the flag the same write commits directly and stages nothing', async () => {
    const mock = client()
    const res = await POST_STAGED(post('widgets', { name: 'Acme' }), params)
    expect(res.status).toBe(201)
    expect(stagedRun.mock.calls[0][2]).toEqual({ dryRun: false })
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('?stage=true with dry_run (or a test key) previews the staging and writes nothing', async () => {
    for (const setup of [{ query: '?stage=true&dry_run=true', mode: 'live' as const }, { query: '?stage=true', mode: 'test' as const }]) {
      mockValidate.mockResolvedValue(auth(setup.mode))
      const mock = client()
      const res = await POST_STAGED(post('widgets', { name: 'Acme' }, { query: setup.query }), params)
      expect(res.status).toBe(200)
      const { data } = await res.json()
      expect(data).toMatchObject({ dry_run: true, preview: { staged: false, operation_type: 'create_supplier', risk_level: 'medium' } })
      expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
    }
  })

  it('a dry run that refuses stages nothing and answers what a direct write would', async () => {
    stagedRun.mockResolvedValue({ ok: false, code: 'SUPPLIER_DUPLICATE_ORG_NUMBER' })
    const mock = client()
    const res = await POST_STAGED(post('widgets', { name: 'Acme' }, { query: '?stage=true' }), params)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await res.json()).error.code).toBe('SUPPLIER_DUPLICATE_ORG_NUMBER')
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('400 STAGE_NOT_SUPPORTED for an operation write without a staging binding, running nothing', async () => {
    const mock = client()
    const res = await POST_DIRECT(post('widgets/rename', { name: 'Acme' }, { query: '?stage=true' }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('STAGE_NOT_SUPPORTED')
    expect(directRun).not.toHaveBeenCalled()
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('400 STAGE_NOT_SUPPORTED for a hand-written write: its handler never runs', async () => {
    client()
    const res = await POST_HAND_WRITTEN(post('widgets/hand-written', {}, { query: '?stage=TRUE' }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('STAGE_NOT_SUPPORTED')
    expect(handWritten).not.toHaveBeenCalled()
  })

  it('400 for a stage value other than true or false: a misspelt flag never commits', async () => {
    client()
    const res = await POST_STAGED(post('widgets', { name: 'Acme' }, { query: '?stage=yes' }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.details.issues[0].field).toBe('stage')
    expect(stagedRun).not.toHaveBeenCalled()

    client()
    expect((await POST_STAGED(post('widgets', { name: 'Acme' }, { query: '?stage=false' }), params)).status).toBe(201)
  })

  it('a staged request and a commit of the same body never share an Idempotency-Key cache entry', async () => {
    const key = crypto.randomUUID()
    client()
    expect((await POST_STAGED(post('widgets', { name: 'Acme' }, { query: '?stage=true', key }), params)).status).toBe(202)

    client()
    const commit = await POST_STAGED(post('widgets', { name: 'Acme' }, { key }), params)
    expect(commit.status).toBe(409)
    expect((await commit.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSE')
    expect(stagedRun).toHaveBeenCalledTimes(1)

    // The same staged request again replays the staging, staging nothing new.
    const mock = client()
    const replay = await POST_STAGED(post('widgets', { name: 'Acme' }, { query: '?stage=true', key }), params)
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true')
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('advertises stage only where it is accepted: query parameter, x-stage-supported and the 202', () => {
    const byOperation = new Map(listEndpoints().map((e) => [e.operation, e]))
    expect(byOperation.get('widgets.create')?.stageSupported).toBe(true)
    expect(byOperation.get('widgets.rename')?.stageSupported).toBe(false)
    expect(byOperation.get('widgets.hand-written')?.stageSupported).toBeUndefined()

    const spec = generateOpenApiSpec('https://x.test')
    const staged = spec.paths['/api/v1/companies/{companyId}/widgets'].post as Record<string, unknown>
    const direct = spec.paths['/api/v1/companies/{companyId}/widgets/rename'].post as Record<string, unknown>
    expect(staged['x-stage-supported']).toBe(true)
    expect(Object.keys(staged.responses as object)).toContain('202')
    expect((staged.parameters as Array<{ name: string }>).map((p) => p.name)).toContain('stage')
    expect(direct['x-stage-supported']).toBeUndefined()
    expect(Object.keys(direct.responses as object)).not.toContain('202')
    expect(spec.components.schemas).toHaveProperty('StagedPendingOperation')
    const stagedView = spec.components.schemas.StagedPendingOperation as {
      properties: { data: { properties: Record<string, { pattern?: string }> } }
    }
    expect(Object.keys(stagedView.properties.data.properties).slice(0, 2)).toEqual(['pending_operation_id', 'handle'])
    expect(stagedView.properties.data.properties.handle?.pattern).toBe('^pop_[0-9a-f]{32}$')
  })
})

describe('v1 stage required: a write only a person approves is never committed from a key', () => {
  const INVOICE = '44444444-4444-4444-8444-444444444444'

  beforeEach(() => {
    mockValidate.mockResolvedValue({ ...auth(), scopes: ['invoices:write'] })
  })

  it('400 STAGE_REQUIRED for a direct handover, before the operation runs', async () => {
    const mock = client()
    const res = await POST_HAND_OVER(post('widgets/hand-over', { invoice_id: INVOICE }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('STAGE_REQUIRED')
    expect(body.error.details).toMatchObject({ operation_type: 'open_collection_case' })
    expect(handoverRun).not.toHaveBeenCalled()
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(0)
  })

  it('a Preview-Token commit is a commit: refused the same way', async () => {
    client()
    const request = post('widgets/hand-over', { invoice_id: INVOICE })
    request.headers.set('Preview-Token', `pv1.${'A'.repeat(43)}`)
    const res = await POST_HAND_OVER(request, params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('STAGE_REQUIRED')
    expect(handoverRun).not.toHaveBeenCalled()
  })

  it('400 STAGE_REQUIRED for an escalating case action, a direct commit for an agent-approvable one', async () => {
    client()
    const escalate = await POST_CASE_ACTION(post('widgets/case-action', { invoice_id: INVOICE, action: 'approve_step' }), params)
    expect(escalate.status).toBe(400)
    expect((await escalate.json()).error.code).toBe('STAGE_REQUIRED')
    expect(caseActionRun).not.toHaveBeenCalled()

    client()
    const pause = await POST_CASE_ACTION(post('widgets/case-action', { invoice_id: INVOICE, action: 'pause' }), params)
    expect(pause.status).toBe(200)
    expect(caseActionRun).toHaveBeenCalledTimes(1)
    expect(caseActionRun.mock.calls[0][2]).toEqual({ dryRun: false })
  })

  it('the dry run and ?stage=true work as for any write', async () => {
    client()
    const dry = await POST_HAND_OVER(post('widgets/hand-over', { invoice_id: INVOICE }, { query: '?dry_run=true' }), params)
    expect(dry.status).toBe(200)
    expect((await dry.json()).data).toMatchObject({ dry_run: true })
    expect(handoverRun.mock.calls[0][2]).toEqual({ dryRun: true })

    const mock = client()
    const staged = await POST_HAND_OVER(post('widgets/hand-over', { invoice_id: INVOICE }, { query: '?stage=true' }), params)
    expect(staged.status).toBe(202)
    expect((await staged.json()).data).toMatchObject({ operation_type: 'open_collection_case', status: 'pending', risk_level: 'high' })
    expect(mock.payloads('pending_operations', 'insert')).toHaveLength(1)
    // Only dry runs ran: nothing was handed over.
    expect(handoverRun.mock.calls.every((call) => (call[2] as { dryRun: boolean }).dryRun)).toBe(true)
  })

  it('a write whose staged type any approver may approve commits directly as before', async () => {
    mockValidate.mockResolvedValue(auth())
    client()
    const res = await POST_STAGED(post('widgets', { name: 'Acme' }), params)
    expect(res.status).toBe(201)
  })
})

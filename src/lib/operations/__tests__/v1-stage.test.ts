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
})

describe('v1 stage mode', () => {
  it('?stage=true stages exactly one pending operation as the key, commits nothing and answers 202', async () => {
    const mock = client()

    const res = await POST_STAGED(post('widgets', { name: 'Acme' }, { query: '?stage=true' }), params)

    expect(res.status).toBe(202)
    const { data } = await res.json()
    expect(data).toMatchObject({
      pending_operation_id: STAGED_ID,
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
  })
})

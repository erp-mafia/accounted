/**
 * Regression suite for the documented v1 "preview, then commit" flow.
 *
 * The contract in `lib/api/v1/dry-run.ts` tells integrators to commit by
 * re-issuing the SAME request without `dry_run=true`, carrying the SAME
 * `Idempotency-Key`. That made the preview and the commit indistinguishable to
 * the idempotency layer (same method, same path, same body): the preview was
 * cached under the commit's hash and the commit replayed it. 200 OK, header
 * `Idempotent-Replayed: true`, `{ dry_run: true, preview }` in the body, and
 * nothing written. An agent reading the status code reported success.
 *
 * These tests exercise the wrapper against an in-memory stand-in for the
 * `idempotency_keys` table, because the bug only appears when a real store
 * carries state from one request to the next: a per-call `vi.fn()` that always
 * returns null can never reproduce it.
 *
 * Mocking follows `tests/helpers.ts` conventions, but the v1 surface never
 * touches `@/lib/supabase/server`: it is API-key authenticated and runs on
 * `createServiceClientNoCookies()` from `@/lib/auth/api-keys`, so that is what
 * is stubbed here (same as `with-api-v1.test.ts`).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

beforeAll(() => {
  // The wrapper's public-scope path fails closed without these; stubbed only
  // to clear the guard (no Supabase instance is contacted).
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return {
    ...actual,
    createClient: vi.fn().mockReturnValue({}),
  }
})

vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>(
    '@/lib/api/idempotency',
  )
  return {
    ...actual,
    checkIdempotencyKey: vi.fn(),
    storeIdempotencyResponse: vi.fn(),
  }
})

import { createServiceClientNoCookies, validateApiKey } from '@/lib/auth/api-keys'
import {
  checkIdempotencyKey,
  IdempotencyKeyReuseError,
  storeIdempotencyResponse,
} from '@/lib/api/idempotency'
import { withApiV1 } from '../with-api-v1'
import { dryRunPreview } from '../dry-run'
import { v1ErrorResponseFromCode } from '../errors'
import { created } from '../response'
import { registerEndpoint } from '../registry'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCheckIdempotency = checkIdempotencyKey as ReturnType<typeof vi.fn>
const mockStoreIdempotency = storeIdempotencyResponse as ReturnType<typeof vi.fn>

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const INVOICES_URL = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices`
const REQUEST_BODY = { customer_id: 'cust-1', amount: 1250 }

// The wrapper reads `dryRunSupported` off the registry when a TEST key writes.
// Registering the pattern here lets the forced-dry-run path run instead of
// short-circuiting to TEST_KEY_WRITE_BLOCKED. Vitest isolates module state per
// test file, so this registration is invisible to the rest of the suite.
registerEndpoint({
  operation: 'invoices.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices',
  summary: 'Create an invoice (test fixture).',
  description: 'Fixture registration used by the dry-run idempotency tests.',
  useWhen: 'never: test fixture',
  doNotUseFor: 'anything outside this test file',
  pitfalls: [],
  example: { response: {} },
  scope: 'invoices:write',
  risk: 'medium',
  idempotent: false,
  reversible: true,
  dryRunSupported: true,
  response: { success: z.object({}) },
})

function makeSupabaseStub(membership: { company_id: string; role: string } | null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: membership, error: null }),
          }),
        }),
      }),
    }),
  }
}

function keyAuth(mode: 'live' | 'test') {
  return {
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: mode === 'test' ? 'ak_test' : 'ak_live',
    apiKeyName: `${mode} key`,
    scopes: ['invoices:write'],
    mode,
  }
}

interface StoredRow {
  requestHash: string
  status: 'success' | 'error'
  body: Record<string, unknown>
}

/**
 * In-memory stand-in for the `idempotency_keys` table. Reproduces the three
 * behaviours the wrapper depends on:
 *   - rows are scoped by (user_id, company_id, key)
 *   - a stored row whose request_hash differs raises IdempotencyKeyReuseError
 *   - insert is first-writer-wins (the unique index swallows the loser)
 */
function installIdempotencyTable(): Map<string, StoredRow> {
  const rows = new Map<string, StoredRow>()
  const rowKey = (userId: string, companyId: string, key: string) =>
    `${userId}::${companyId}::${key}`

  mockCheckIdempotency.mockImplementation(
    async (
      _supabase: unknown,
      userId: string,
      companyId: string,
      key: string,
      requestHash: string,
    ) => {
      const row = rows.get(rowKey(userId, companyId, key))
      if (!row) return null
      if (row.requestHash !== requestHash) throw new IdempotencyKeyReuseError(key)
      return { status: row.status, body: row.body }
    },
  )

  mockStoreIdempotency.mockImplementation(
    async (
      _supabase: unknown,
      userId: string,
      companyId: string,
      key: string,
      requestHash: string,
      status: 'success' | 'error',
      body: Record<string, unknown>,
    ) => {
      const k = rowKey(userId, companyId, key)
      if (rows.has(k)) return
      rows.set(k, { requestHash, status, body })
    },
  )

  return rows
}

/**
 * A write route shaped like the real ones: previews when `ctx.dryRun`, and
 * otherwise performs the side-effect. `committed` is the observable proof that
 * the write actually happened, which is the whole point of this suite.
 */
function makeInvoiceRoute() {
  const committed: string[] = []
  const previews: string[] = []
  let seq = 0

  const route = withApiV1<{ params: Promise<{ companyId: string }> }>(
    'invoices.create',
    async (request, ctx) => {
      const body = (await request.json()) as { customer_id: string }
      if (ctx.dryRun) {
        previews.push(body.customer_id)
        return dryRunPreview(
          { customer_id: body.customer_id },
          { requestId: ctx.requestId, log: ctx.log },
        )
      }
      seq += 1
      const id = `inv-${seq}`
      committed.push(id)
      return created({ id, customer_id: body.customer_id }, { requestId: ctx.requestId })
    },
    { requireScope: 'invoices:write' },
  )

  return { route, committed, previews }
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function postInvoice(opts: {
  key?: string
  dryRunQuery?: boolean
  /** Raw value for the ?dry_run= query param (case-sensitivity matrix). */
  dryRunQueryValue?: string
  dryRunHeader?: boolean
}): Request {
  const headers: Record<string, string> = {
    Authorization: 'Bearer gnubok_sk_x',
    'Content-Type': 'application/json',
  }
  if (opts.key) headers['Idempotency-Key'] = opts.key
  if (opts.dryRunHeader) headers['X-Dry-Run'] = 'true'
  const url =
    opts.dryRunQueryValue !== undefined
      ? `${INVOICES_URL}?dry_run=${opts.dryRunQueryValue}`
      : opts.dryRunQuery
        ? `${INVOICES_URL}?dry_run=true`
        : INVOICES_URL
  return new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(REQUEST_BODY),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockServiceClient.mockReturnValue(makeSupabaseStub({ company_id: COMPANY_ID, role: 'owner' }))
  mockValidate.mockResolvedValue(keyAuth('live'))
  installIdempotencyTable()
})

describe('withApiV1: dry-run then commit on the same Idempotency-Key', () => {
  // THE missing test. Before the fix this returned the cached preview with
  // Idempotent-Replayed: true and `committed` stayed empty.
  it('commits for real after a dry-run preview issued under the same key', async () => {
    const { route, committed, previews } = makeInvoiceRoute()

    const preview = await route(
      postInvoice({ key: 'key-1', dryRunQuery: true }),
      companyParams(COMPANY_ID),
    )
    expect(preview.status).toBe(200)
    expect(preview.headers.get('X-Dry-Run')).toBe('true')
    expect(preview.headers.get('Idempotent-Replayed')).toBeNull()
    const previewBody = await preview.json()
    expect(previewBody.data.dry_run).toBe(true)
    expect(previews).toEqual(['cust-1'])
    expect(committed).toEqual([])

    const commit = await route(postInvoice({ key: 'key-1' }), companyParams(COMPANY_ID))

    expect(commit.status).toBe(201)
    expect(commit.headers.get('Idempotent-Replayed')).toBeNull()
    const commitBody = await commit.json()
    expect(commitBody.data.id).toBe('inv-1')
    expect(commitBody.data.dry_run).toBeUndefined()
    expect(committed).toEqual(['inv-1'])
  })

  it('never writes the dry-run response into the idempotency cache', async () => {
    const { route } = makeInvoiceRoute()

    await route(postInvoice({ key: 'key-2', dryRunQuery: true }), companyParams(COMPANY_ID))

    expect(mockStoreIdempotency).not.toHaveBeenCalled()
  })

  it('does not replay a repeated dry-run: each preview re-runs the handler', async () => {
    const { route, committed, previews } = makeInvoiceRoute()

    const first = await route(
      postInvoice({ key: 'key-3', dryRunQuery: true }),
      companyParams(COMPANY_ID),
    )
    const second = await route(
      postInvoice({ key: 'key-3', dryRunQuery: true }),
      companyParams(COMPANY_ID),
    )

    expect(first.headers.get('Idempotent-Replayed')).toBeNull()
    expect(second.headers.get('Idempotent-Replayed')).toBeNull()
    expect(second.status).toBe(200)
    expect((await second.json()).data.dry_run).toBe(true)
    expect(previews).toHaveLength(2)
    expect(committed).toEqual([])
  })

  // The dry-run flag is part of the request hash, so a key that already
  // committed for real cannot be re-used for a simulation: that would hand back
  // a committed result wearing a preview's clothes. 409 is the honest answer.
  it('rejects a dry-run that re-uses a key which already committed', async () => {
    const { route, committed } = makeInvoiceRoute()

    await route(postInvoice({ key: 'key-4' }), companyParams(COMPANY_ID))
    expect(committed).toEqual(['inv-1'])

    const res = await route(
      postInvoice({ key: 'key-4', dryRunQuery: true }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSE')
    expect(committed).toEqual(['inv-1'])
  })
})

describe('withApiV1: idempotent replay of real commits (must not regress)', () => {
  // Also the lockstep guard for the two hashRequest call sites: the lookup only
  // finds what the store wrote if both hash the same input. Diverge them and
  // this test fails with a second write instead of a replay.
  it('replays the second of two identical commits under the same key', async () => {
    const { route, committed } = makeInvoiceRoute()

    const first = await route(postInvoice({ key: 'key-5' }), companyParams(COMPANY_ID))
    const second = await route(postInvoice({ key: 'key-5' }), companyParams(COMPANY_ID))

    expect(first.status).toBe(201)
    expect(first.headers.get('Idempotent-Replayed')).toBeNull()
    expect(second.headers.get('Idempotent-Replayed')).toBe('true')
    expect((await second.json()).data.id).toBe('inv-1')
    expect(committed).toEqual(['inv-1'])
  })

  // A handler-level 429 (e.g. bank-connections.sync's cooldown) says "not
  // now". Caching it would replay the throttle under the same key until the
  // cache TTL, long after the cooldown itself has passed, and as a 400.
  it('never caches a 429 so a same-key retry after Retry-After runs the handler', async () => {
    let calls = 0
    const route = withApiV1<{ params: Promise<{ companyId: string }> }>(
      'invoices.create',
      async (_request, ctx) => {
        calls += 1
        if (calls === 1) {
          return v1ErrorResponseFromCode('RATE_LIMITED', ctx.log, {
            requestId: ctx.requestId,
            retryAfterSeconds: 1,
          })
        }
        return created({ id: 'inv-after-cooldown' }, { requestId: ctx.requestId })
      },
      { requireScope: 'invoices:write' },
    )

    const first = await route(postInvoice({ key: 'key-7' }), companyParams(COMPANY_ID))
    expect(first.status).toBe(429)
    expect(mockStoreIdempotency).not.toHaveBeenCalled()

    const second = await route(postInvoice({ key: 'key-7' }), companyParams(COMPANY_ID))
    expect(second.status).toBe(201)
    // The real commit is cached as before; only the throttle was not.
    expect(mockStoreIdempotency).toHaveBeenCalledTimes(1)
    expect(second.headers.get('Idempotent-Replayed')).toBeNull()
    expect((await second.json()).data.id).toBe('inv-after-cooldown')
    expect(calls).toBe(2)
  })

  it('still rejects the same key carrying a different body', async () => {
    const { route, committed } = makeInvoiceRoute()

    await route(postInvoice({ key: 'key-6' }), companyParams(COMPANY_ID))

    const changed = new Request(INVOICES_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gnubok_sk_x',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-6',
      },
      body: JSON.stringify({ ...REQUEST_BODY, amount: 9999 }),
    })
    const res = await route(changed, companyParams(COMPANY_ID))

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSE')
    expect(committed).toEqual(['inv-1'])
  })
})

describe('withApiV1: dry-run query flag is case-insensitive', () => {
  // '?dry_run=True' used to fall through the exact-match check and COMMIT for
  // real while the caller believed it previewed: the one direction this flag
  // must never fail in.
  it('previews on ?dry_run=True (mis-cased flag must never commit)', async () => {
    const { route, committed, previews } = makeInvoiceRoute()

    const res = await route(
      postInvoice({ key: 'key-10', dryRunQueryValue: 'True' }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).data.dry_run).toBe(true)
    expect(previews).toHaveLength(1)
    expect(committed).toEqual([])
    expect(mockStoreIdempotency).not.toHaveBeenCalled()
  })

  it('previews on ?dry_run=TRUE as well', async () => {
    const { route, committed } = makeInvoiceRoute()

    const res = await route(
      postInvoice({ key: 'key-11', dryRunQueryValue: 'TRUE' }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).data.dry_run).toBe(true)
    expect(committed).toEqual([])
  })

  it('still commits on non-true values (?dry_run=1, ?dry_run=false)', async () => {
    const { route, committed, previews } = makeInvoiceRoute()

    const one = await route(
      postInvoice({ key: 'key-12', dryRunQueryValue: '1' }),
      companyParams(COMPANY_ID),
    )
    const falsy = await route(
      postInvoice({ key: 'key-13', dryRunQueryValue: 'false' }),
      companyParams(COMPANY_ID),
    )

    expect(one.status).toBe(201)
    expect(falsy.status).toBe(201)
    expect(previews).toHaveLength(0)
    expect(committed).toEqual(['inv-1', 'inv-2'])
  })
})

describe('withApiV1: X-Dry-Run header parity with ?dry_run=true', () => {
  it('previews on the header and still commits on the follow-up request', async () => {
    const { route, committed, previews } = makeInvoiceRoute()

    const preview = await route(
      postInvoice({ key: 'key-7', dryRunHeader: true }),
      companyParams(COMPANY_ID),
    )
    expect(preview.status).toBe(200)
    expect((await preview.json()).data.dry_run).toBe(true)
    expect(previews).toHaveLength(1)
    expect(committed).toEqual([])
    expect(mockStoreIdempotency).not.toHaveBeenCalled()

    const commit = await route(postInvoice({ key: 'key-7' }), companyParams(COMPANY_ID))

    expect(commit.status).toBe(201)
    expect(commit.headers.get('Idempotent-Replayed')).toBeNull()
    expect((await commit.json()).data.id).toBe('inv-1')
    expect(committed).toEqual(['inv-1'])
  })

  it('does not replay a repeated header-driven dry-run', async () => {
    const { route, previews } = makeInvoiceRoute()

    await route(postInvoice({ key: 'key-8', dryRunHeader: true }), companyParams(COMPANY_ID))
    const second = await route(
      postInvoice({ key: 'key-8', dryRunHeader: true }),
      companyParams(COMPANY_ID),
    )

    expect(second.headers.get('Idempotent-Replayed')).toBeNull()
    expect(previews).toHaveLength(2)
  })
})

describe('withApiV1: test keys (forced dry-run) never poison the cache', () => {
  it('lets a live commit through on a key a test key already simulated', async () => {
    const { route, committed, previews } = makeInvoiceRoute()

    mockValidate.mockResolvedValueOnce(keyAuth('test'))
    const simulated = await route(postInvoice({ key: 'key-9' }), companyParams(COMPANY_ID))

    expect(simulated.status).toBe(200)
    expect(simulated.headers.get('X-Gnubok-Mode')).toBe('test')
    expect((await simulated.json()).data.dry_run).toBe(true)
    expect(previews).toHaveLength(1)
    expect(committed).toEqual([])
    expect(mockStoreIdempotency).not.toHaveBeenCalled()

    const commit = await route(postInvoice({ key: 'key-9' }), companyParams(COMPANY_ID))

    expect(commit.status).toBe(201)
    expect(commit.headers.get('Idempotent-Replayed')).toBeNull()
    expect(committed).toEqual(['inv-1'])
  })
})

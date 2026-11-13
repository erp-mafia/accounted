/**
 * Tests for the nightly document integrity-verify cron.
 *
 * Covers the production defects fixed in this route:
 * - the run must fit its budget (maxDuration 300 + batch default 200),
 * - a document whose storage object cannot be downloaded must surface as an
 *   audit incident (INTEGRITY_FAILURE / DOCUMENT_OBJECT_MISSING) AND get a
 *   ledger row so it stops head-blocking the queue,
 * - the queue and the stamp both live in document_integrity_checks: the route
 *   must never write to document_attachments, whose UPDATE trigger
 *   (enforce_period_lock_documents, migration 017) rejects every document
 *   linked to a closed/locked period and wedged the cron at 200/200 rejected,
 * - and a rejected ledger or audit write must be counted, logged and reported
 *   rather than discarded, which is why the stall went unnoticed for weeks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/cron'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

// Every error line of the run, the per-item loggers' included; the real logger still writes.
const logError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  type Logger = ReturnType<typeof actual.createLogger>
  const wrap = (logger: Logger): Logger => ({
    ...logger,
    error: (message: string, ...args: unknown[]) => {
      logError(message, ...args)
      logger.error(message, ...args)
    },
    child: (extra) => wrap(logger.child(extra)),
  })
  return { ...actual, createLogger: (...args: Parameters<typeof actual.createLogger>) => wrap(actual.createLogger(...args)) }
})

interface MockDoc {
  id: string
  user_id: string
  company_id: string
  storage_path: string
  sha256_hash: string
  file_name: string
  last_checked_at: string | null
}

/** What storage-js answers: a StorageApiError (HTTP status, Storage's statusCode) or a StorageUnknownError (no answer). */
type StorageErrorShape = { message: string; status?: number; statusCode?: string; name?: string }

const state = {
  documents: [] as MockDoc[],
  fetchError: null as { message: string } | null,
  downloadResults: new Map<string, { data: unknown; error: StorageErrorShape | null }>(),
  // Answers served before downloadResults, one per download call of the path.
  downloadQueue: new Map<string, Array<{ data: unknown; error: StorageErrorShape | null }>>(),
  downloadCalls: [] as string[],
  onDownload: null as (() => void) | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  ledgerInserts: [] as Array<Record<string, unknown>>,
  ledgerInsertError: null as { message: string; code?: string } | null,
  // The newest ledger result per document, for the "still unreadable" read.
  previousResults: new Map<string, string>(),
  auditInserts: [] as Array<Record<string, unknown>>,
  auditInsertError: null as { message: string } | null,
}

function makeMockClient() {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args })
      return Promise.resolve({
        data: state.fetchError ? null : state.documents,
        error: state.fetchError,
      })
    },
    from: (table: string) => {
      if (table === 'document_integrity_checks') {
        // The newest result of one document: select().eq().order().limit().maybeSingle().
        let documentId = ''
        const read = {
          eq: (_column: string, value: string) => {
            documentId = value
            return read
          },
          order: () => read,
          limit: () => read,
          maybeSingle: () => {
            const result = state.previousResults.get(documentId)
            return Promise.resolve({ data: result ? { result } : null, error: null })
          },
        }
        return {
          insert: (row: Record<string, unknown>) => {
            state.ledgerInserts.push(row)
            return Promise.resolve({ error: state.ledgerInsertError })
          },
          select: () => read,
        }
      }
      if (table === 'audit_log') {
        return {
          insert: (row: Record<string, unknown>) => {
            state.auditInserts.push(row)
            return Promise.resolve({ error: state.auditInsertError })
          },
        }
      }
      if (table === 'document_attachments') {
        // The whole point of the fix: a write here runs through
        // enforce_period_lock_documents() and is rejected for every document
        // linked to a closed/locked period.
        throw new Error('the verify cron must never write to document_attachments')
      }
      throw new Error(`unexpected table: ${table}`)
    },
    storage: {
      from: () => ({
        download: (path: string) => {
          state.downloadCalls.push(path)
          state.onDownload?.()
          const queued = state.downloadQueue.get(path)?.shift()
          return Promise.resolve(
            queued ??
              state.downloadResults.get(path) ?? {
                data: null,
                error: { message: 'Object not found' },
              }
          )
        },
      }),
    },
  }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeMockClient()),
}))

import { GET, maxDuration } from '../route'
import { createCronRequest } from '@/tests/helpers'

function makeDoc(overrides: Partial<MockDoc> = {}): MockDoc {
  return {
    id: 'doc-1',
    user_id: 'user-1',
    company_id: 'company-1',
    storage_path: 'user-1/company-1/inbox/file.pdf',
    sha256_hash: 'deadbeef',
    file_name: 'file.pdf',
    last_checked_at: null,
    ...overrides,
  }
}

/** Register a downloadable object whose bytes hash to the returned sha256. */
function registerObject(path: string, content: string): string {
  const buf = Buffer.from(content, 'utf8')
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  state.downloadResults.set(path, {
    data: { arrayBuffer: async () => arrayBuffer },
    error: null,
  })
  return createHash('sha256').update(buf).digest('hex')
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  delete process.env.DOCUMENT_VERIFY_BATCH_SIZE
  state.documents = []
  state.fetchError = null
  state.downloadResults.clear()
  state.downloadQueue.clear()
  state.downloadCalls = []
  state.onDownload = null
  state.rpcCalls = []
  state.ledgerInserts = []
  state.ledgerInsertError = null
  state.previousResults.clear()
  state.auditInserts = []
  state.auditInsertError = null
})

describe('GET /api/documents/verify/cron', () => {
  it('returns 401 when the cron secret is invalid', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(response.status).toBe(401)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('declares a 300s function budget', () => {
    expect(maxDuration).toBe(300)
  })

  it('draws the batch from the ledger queue, 200 by default, env override honored', async () => {
    await GET(createCronRequest('/api/documents/verify/cron'))
    expect(state.rpcCalls).toEqual([
      { fn: 'next_documents_for_integrity_check', args: { p_limit: 200 } },
    ])

    process.env.DOCUMENT_VERIFY_BATCH_SIZE = '50'
    await GET(createCronRequest('/api/documents/verify/cron'))
    expect(state.rpcCalls[1]).toEqual({
      fn: 'next_documents_for_integrity_check',
      args: { p_limit: 50 },
    })
  })

  it('appends a passed ledger row on a successful verification', async () => {
    const doc = makeDoc()
    const hash = registerObject(doc.storage_path, '%PDF-1.4 demo content')
    state.documents = [{ ...doc, sha256_hash: hash }]

    const response = await GET(createCronRequest('/api/documents/verify/cron'))
    const json = await response.json()

    expect(json).toEqual({
      processed: 1,
      verified: 1,
      failures: 0,
      missingObjects: 0,
      writeFailures: 0,
      errors: 0,
    })
    expect(state.ledgerInserts).toHaveLength(1)
    expect(state.ledgerInserts[0]).toMatchObject({
      document_id: doc.id,
      company_id: doc.company_id,
      result: 'passed',
      expected_sha256: hash,
      computed_sha256: hash,
      storage_path: doc.storage_path,
      detail: null,
    })
    expect(state.ledgerInserts[0].checked_at).toEqual(expect.any(String))
    expect(state.auditInserts).toHaveLength(0)
  })

  it('writes an INTEGRITY_FAILURE audit row and a hash_mismatch ledger row on mismatch', async () => {
    const doc = makeDoc({ sha256_hash: 'not-the-real-hash' })
    registerObject(doc.storage_path, 'tampered content')
    state.documents = [doc]

    const response = await GET(createCronRequest('/api/documents/verify/cron'))
    const json = await response.json()

    expect(json.failures).toBe(1)
    expect(json.missingObjects).toBe(0)
    expect(json.writeFailures).toBe(0)
    expect(state.auditInserts).toHaveLength(1)
    expect(state.auditInserts[0].action).toBe('INTEGRITY_FAILURE')
    expect(String(state.auditInserts[0].description)).not.toContain('DOCUMENT_OBJECT_MISSING')
    expect(state.ledgerInserts).toHaveLength(1)
    expect(state.ledgerInserts[0]).toMatchObject({
      document_id: doc.id,
      result: 'hash_mismatch',
      expected_sha256: 'not-the-real-hash',
    })
  })

  it('verifies via the company-scoped fallback key when a concurrent backfill re-homed the object', async () => {
    // The batch snapshot carries a stale legacy pointer: mid-batch, the
    // Phase B backfill copied the object to the company-scoped key and
    // removed the source. This must NOT produce a permanent false
    // DOCUMENT_OBJECT_MISSING audit row for a healthy document.
    const doc = makeDoc({
      id: 'doc-repointed',
      storage_path: 'documents/user-1/1_receipt.pdf',
    })
    const hash = registerObject('documents/company-1/user-1/1_receipt.pdf', 'healthy bytes')
    state.documents = [{ ...doc, sha256_hash: hash }]

    const response = await GET(createCronRequest('/api/documents/verify/cron'))
    const json = await response.json()

    expect(state.auditInserts).toHaveLength(0)
    expect(state.ledgerInserts.map((row) => row.document_id)).toEqual(['doc-repointed'])
    expect(json).toEqual({
      processed: 1,
      verified: 1,
      failures: 0,
      missingObjects: 0,
      writeFailures: 0,
      errors: 0,
    })
  })

  it('surfaces a missing storage object as an audit incident AND an object_missing ledger row', async () => {
    const missing = makeDoc({ id: 'doc-missing', storage_path: 'user-1/company-1/gone.pdf' })
    const healthy = makeDoc({ id: 'doc-healthy', storage_path: 'user-1/company-1/ok.pdf' })
    const healthyHash = registerObject(healthy.storage_path, 'healthy content')
    state.documents = [missing, { ...healthy, sha256_hash: healthyHash }]

    const response = await GET(createCronRequest('/api/documents/verify/cron'))
    const json = await response.json()

    // The audit row is the incident surface for the missing object.
    expect(state.auditInserts).toHaveLength(1)
    const audit = state.auditInserts[0]
    expect(audit.action).toBe('INTEGRITY_FAILURE')
    expect(audit.record_id).toBe('doc-missing')
    expect(String(audit.description)).toContain('DOCUMENT_OBJECT_MISSING')
    expect(audit.new_state).toMatchObject({ reason: 'DOCUMENT_OBJECT_MISSING' })

    // Both documents get a ledger row: the failing one must stop head-blocking
    // the queue, and the healthy one was verified.
    expect(state.ledgerInserts.map((row) => row.document_id).sort()).toEqual([
      'doc-healthy',
      'doc-missing',
    ])
    expect(state.ledgerInserts.find((row) => row.document_id === 'doc-missing')).toMatchObject({
      result: 'object_missing',
      computed_sha256: null,
    })

    expect(json).toEqual({
      processed: 2,
      verified: 1,
      failures: 0,
      missingObjects: 1,
      writeFailures: 0,
      errors: 1,
    })
  })

  it('does not write a ledger row when the audit insert fails, so it retries next run', async () => {
    const missing = makeDoc({ id: 'doc-missing', storage_path: 'user-1/company-1/gone.pdf' })
    state.documents = [missing]
    state.auditInsertError = { message: 'insert blocked' }

    const response = await GET(createCronRequest('/api/documents/verify/cron'))
    const json = await response.json()

    expect(state.auditInserts).toHaveLength(1)
    expect(state.ledgerInserts).toHaveLength(0)
    expect(json.missingObjects).toBe(0)
    expect(json.writeFailures).toBe(1)
    expect(json.errors).toBe(1)
  })

  it('reports a rejected ledger write instead of swallowing it', async () => {
    const doc = makeDoc()
    const hash = registerObject(doc.storage_path, 'healthy content')
    state.documents = [{ ...doc, sha256_hash: hash }]
    state.ledgerInsertError = { message: 'permission denied for table document_integrity_checks' }

    const response = await GET(createCronRequest('/api/documents/verify/cron'))
    const json = await response.json()

    expect(state.ledgerInserts).toHaveLength(1)
    expect(json).toEqual({
      processed: 1,
      verified: 0,
      failures: 0,
      missingObjects: 0,
      writeFailures: 1,
      errors: 1,
    })
  })

  it('counts a rejected audit write on a hash mismatch as a write failure', async () => {
    const doc = makeDoc({ sha256_hash: 'not-the-real-hash' })
    registerObject(doc.storage_path, 'tampered content')
    state.documents = [doc]
    state.auditInsertError = { message: 'insert blocked' }

    const response = await GET(createCronRequest('/api/documents/verify/cron'))
    const json = await response.json()

    expect(state.auditInserts).toHaveLength(1)
    expect(state.ledgerInserts).toHaveLength(0)
    expect(json.failures).toBe(0)
    expect(json.writeFailures).toBe(1)
    expect(json.errors).toBe(1)
  })

  it('returns an error envelope when the queue fetch fails', async () => {
    state.fetchError = { message: 'db down' }

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
  })

  it('reports zero processed when there is nothing to verify', async () => {
    const response = await GET(createCronRequest('/api/documents/verify/cron'))
    const json = await response.json()

    expect(json).toEqual({ message: 'No documents to verify', processed: 0 })
  })

  it('retries a failed download once before anything is written: a hiccup is not a missing object', async () => {
    const doc = makeDoc()
    const hash = registerObject(doc.storage_path, 'healthy content')
    state.documents = [{ ...doc, sha256_hash: hash }]
    state.downloadQueue.set(doc.storage_path, [{ data: null, error: { message: 'fetch failed', name: 'StorageUnknownError' } }])

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(await response.json()).toEqual({ processed: 1, verified: 1, failures: 0, missingObjects: 0, writeFailures: 0, errors: 0 })
    expect(state.auditInserts).toHaveLength(0)
    expect(state.ledgerInserts).toMatchObject([{ document_id: doc.id, result: 'passed' }])
  })

  it('writes nothing permanent when storage itself fails twice: the document stays in the queue', async () => {
    const doc = makeDoc({ id: 'doc-outage', storage_path: 'user-1/company-1/outage.pdf' })
    state.documents = [doc]
    state.downloadResults.set(doc.storage_path, { data: null, error: { message: 'Bad Gateway', status: 502 } })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(state.auditInserts).toHaveLength(0)
    expect(state.ledgerInserts).toHaveLength(0)
    expect(await response.json()).toEqual({
      processed: 1,
      verified: 0,
      failures: 0,
      missingObjects: 0,
      writeFailures: 0,
      errors: 0,
      storageOutages: 1,
    })
    // The stored key (this one has no other layout), tried twice.
    expect(state.downloadCalls).toEqual([doc.storage_path, doc.storage_path])
    // One error for the run, naming the document; no item error.
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('documents left for the next run: storage could not serve them', {
      storageOutages: 1,
      documentIds: ['doc-outage'],
    })
  })

  // A legacy key: the company-scoped layout is tried after it.
  const LEGACY = 'documents/user-1/1_receipt.pdf'
  const SCOPED = 'documents/company-1/user-1/1_receipt.pdf'

  it.each([
    ['a 5xx', { message: 'Internal Server Error', status: 500, statusCode: '500' }],
    ['a 429', { message: 'Too Many Requests', status: 429, statusCode: '429' }],
    ['a 401', { message: 'Unauthorized', status: 401, statusCode: '401' }],
    ['no answer', { message: 'fetch failed', name: 'StorageUnknownError' }],
  ])('never writes missing when the stored key answered not found and the other key %s', async (_label, otherKey) => {
    state.documents = [makeDoc({ id: 'doc-moved', storage_path: LEGACY })]
    state.downloadResults.set(LEGACY, { data: null, error: { message: 'Object not found', status: 400, statusCode: '404' } })
    state.downloadResults.set(SCOPED, { data: null, error: otherKey })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(state.auditInserts).toHaveLength(0)
    expect(state.ledgerInserts).toHaveLength(0)
    expect(await response.json()).toMatchObject({ processed: 1, missingObjects: 0, errors: 0, storageOutages: 1 })
    expect(state.downloadCalls).toEqual([LEGACY, SCOPED, LEGACY, SCOPED])
  })

  it('records a document storage refuses at every key as unreadable, never missing, so it moves behind the others', async () => {
    const refusal = { message: 'new row violates row-level security policy', status: 403, statusCode: '403' }
    state.documents = [makeDoc({ id: 'doc-refused', storage_path: LEGACY }), makeDoc({ id: 'doc-next', storage_path: 'user-1/company-1/next.pdf' })]
    state.documents[1] = { ...state.documents[1]!, sha256_hash: registerObject('user-1/company-1/next.pdf', 'served') }
    state.downloadResults.set(LEGACY, { data: null, error: refusal })
    state.downloadResults.set(SCOPED, { data: null, error: refusal })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(state.auditInserts).toHaveLength(0)
    // A recorded outcome: the queue (least recently checked first) puts it behind the others.
    expect(state.ledgerInserts).toEqual([
      expect.objectContaining({ document_id: 'doc-refused', result: 'unreadable', computed_sha256: null, detail: expect.stringContaining(refusal.message) }),
      expect.objectContaining({ document_id: 'doc-next', result: 'passed' }),
    ])
    expect(await response.json()).toMatchObject({ processed: 2, verified: 1, missingObjects: 0, errors: 0, unreadable: 1 })
    expect(logError).toHaveBeenCalledWith('documents storage refuses to serve: recorded unreadable, behind the others in the queue', {
      unreadable: 1,
      documentIds: ['doc-refused'],
    })
  })

  it('counts a 400 InvalidKey as not found: no object can be at a key storage rejects', async () => {
    state.documents = [makeDoc({ id: 'doc-gone', storage_path: LEGACY })]
    state.downloadResults.set(LEGACY, { data: null, error: { message: 'Object not found', status: 400, statusCode: '404' } })
    state.downloadResults.set(SCOPED, { data: null, error: { message: 'Invalid key: documents/company-1/user-1/1_receipt.pdf', status: 400, statusCode: 'InvalidKey' } })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(await response.json()).toMatchObject({ processed: 1, missingObjects: 1 })
    expect(state.ledgerInserts).toMatchObject([{ document_id: 'doc-gone', result: 'object_missing' }])
  })

  it('records nothing when one key answered not found and storage refuses the other: left for the next run', async () => {
    state.documents = [makeDoc({ id: 'doc-moved', storage_path: LEGACY })]
    state.downloadResults.set(LEGACY, { data: null, error: { message: 'Object not found', status: 400, statusCode: '404' } })
    state.downloadResults.set(SCOPED, { data: null, error: { message: 'Forbidden', status: 403, statusCode: '403' } })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(state.ledgerInserts).toHaveLength(0)
    expect(state.auditInserts).toHaveLength(0)
    expect(await response.json()).toMatchObject({ processed: 1, missingObjects: 0, storageOutages: 1 })
  })

  it('never stops for documents storage refuses, however many in a row: only a failure of storage itself stops the run', async () => {
    const refused = Array.from({ length: 7 }, (_, i) => makeDoc({ id: `doc-refused-${i}`, storage_path: `user-1/company-1/r${i}.pdf` }))
    const served = makeDoc({ id: 'doc-served', storage_path: 'user-1/company-1/served.pdf' })
    state.documents = [...refused, { ...served, sha256_hash: registerObject(served.storage_path, 'served') }]
    for (const doc of refused) state.downloadResults.set(doc.storage_path, { data: null, error: { message: 'Forbidden', status: 403, statusCode: '403' } })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ processed: 8, verified: 1, unreadable: 7 })
    expect(state.ledgerInserts.map((row) => row.result)).toEqual([...Array(7).fill('unreadable'), 'passed'])
  }, 20_000) // seven real 0.5 s retry pauses

  it('reports an unreadable document once: when its turn comes again and storage still refuses, a warning', async () => {
    state.documents = [makeDoc({ id: 'doc-refused', storage_path: LEGACY })]
    state.previousResults.set('doc-refused', 'unreadable')
    state.downloadResults.set(LEGACY, { data: null, error: { message: 'Forbidden', status: 403, statusCode: '403' } })
    state.downloadResults.set(SCOPED, { data: null, error: { message: 'Forbidden', status: 403, statusCode: '403' } })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(await response.json()).toMatchObject({ unreadable: 1 })
    expect(state.ledgerInserts).toMatchObject([{ document_id: 'doc-refused', result: 'unreadable' }])
    expect(logError).not.toHaveBeenCalled()
  })

  it('leaves an unreadable document in the queue while the ledger does not take the result yet (migration not applied)', async () => {
    state.documents = [makeDoc({ id: 'doc-refused', storage_path: LEGACY })]
    state.downloadResults.set(LEGACY, { data: null, error: { message: 'Forbidden', status: 403, statusCode: '403' } })
    state.downloadResults.set(SCOPED, { data: null, error: { message: 'Forbidden', status: 403, statusCode: '403' } })
    state.ledgerInsertError = { message: 'violates check constraint "document_integrity_checks_result_check"', code: '23514' }

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(await response.json()).toMatchObject({ processed: 1, writeFailures: 0, errors: 0, storageOutages: 1 })
  })

  it('writes missing when every key answered not found, as Storage answers it (400 with statusCode 404)', async () => {
    state.documents = [makeDoc({ id: 'doc-gone', storage_path: LEGACY })]
    for (const path of [LEGACY, SCOPED]) state.downloadResults.set(path, { data: null, error: { message: 'Object not found', status: 400, statusCode: '404' } })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(await response.json()).toMatchObject({ processed: 1, missingObjects: 1 })
    expect(state.auditInserts).toMatchObject([{ action: 'INTEGRITY_FAILURE', record_id: 'doc-gone' }])
    expect(state.ledgerInserts).toMatchObject([{ document_id: 'doc-gone', result: 'object_missing' }])
  })

  it('never takes a missing bucket for a missing document', async () => {
    state.documents = [makeDoc({ id: 'doc-1' })]
    state.downloadResults.set('user-1/company-1/inbox/file.pdf', { data: null, error: { message: 'Bucket not found', status: 400, statusCode: '404' } })

    await GET(createCronRequest('/api/documents/verify/cron'))

    expect(state.auditInserts).toHaveLength(0)
    expect(state.ledgerInserts).toHaveLength(0)
  })

  it('stops after five documents in a row storage could not serve, and answers one error', async () => {
    const docs = Array.from({ length: 8 }, (_, i) => makeDoc({ id: `doc-${i}`, storage_path: `user-1/company-1/${i}.pdf` }))
    state.documents = docs
    for (const doc of docs) state.downloadResults.set(doc.storage_path, { data: null, error: { message: 'Service Unavailable', status: 503 } })

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(response.status).toBe(503)
    expect((await response.json()).error.details).toEqual({
      processed: 5,
      verified: 0,
      failures: 0,
      missingObjects: 0,
      writeFailures: 0,
      errors: 0,
      storageOutages: 5,
      deferred: 3,
    })
    // Two attempts for each of the five, none for the three left in the queue.
    expect(state.downloadCalls).toHaveLength(10)
    expect(state.auditInserts).toHaveLength(0)
    // One error for the whole outage: this answer's. The cron wrapper reports
    // the 503 itself as well (withCronContext); the route adds one line, not
    // one per document.
    expect(logError.mock.calls.filter(([message]) => message !== 'cron run answered an error status')).toHaveLength(1)
    expect(logError).toHaveBeenCalledWith('TRANSIENT_ERROR', expect.stringContaining('storage could not serve 5 documents in a row; 3 left for the next run'), expect.anything())
  }, 20_000) // five real 0.5 s retry pauses

  it('goes on when storage serves a document between failures', async () => {
    const docs = Array.from({ length: 9 }, (_, i) => makeDoc({ id: `doc-${i}`, storage_path: `user-1/company-1/${i}.pdf` }))
    state.documents = docs.map((doc, i) =>
      i === 4 ? { ...doc, sha256_hash: registerObject(doc.storage_path, 'served') } : doc,
    )
    for (const [i, doc] of docs.entries()) {
      if (i !== 4) state.downloadResults.set(doc.storage_path, { data: null, error: { message: 'Service Unavailable', status: 503 } })
    }

    const response = await GET(createCronRequest('/api/documents/verify/cron'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ processed: 9, verified: 1, storageOutages: 8 })
  }, 20_000) // eight real 0.5 s retry pauses

  it('starts no document after 240 s and leaves the rest first in the queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const docs = ['a', 'b', 'c'].map((name) => makeDoc({ id: `doc-${name}`, storage_path: `user-1/company-1/${name}.pdf` }))
      state.documents = docs.map((doc) => ({ ...doc, sha256_hash: registerObject(doc.storage_path, `content ${doc.id}`) }))
      // Every download takes 130 s: the third document would start at 260 s.
      state.onDownload = () => vi.setSystemTime(new Date(Date.now() + 130_000))

      const response = await GET(createCronRequest('/api/documents/verify/cron'))

      expect(await response.json()).toEqual({
        processed: 2,
        verified: 2,
        failures: 0,
        missingObjects: 0,
        writeFailures: 0,
        errors: 0,
        deferred: 1,
      })
      expect(state.ledgerInserts.map((row) => row.document_id)).toEqual(['doc-a', 'doc-b'])
    } finally {
      vi.useRealTimers()
    }
  })
})

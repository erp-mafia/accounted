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

interface MockDoc {
  id: string
  user_id: string
  company_id: string
  storage_path: string
  sha256_hash: string
  file_name: string
  last_checked_at: string | null
}

const state = {
  documents: [] as MockDoc[],
  fetchError: null as { message: string } | null,
  downloadResults: new Map<string, { data: unknown; error: { message: string } | null }>(),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  ledgerInserts: [] as Array<Record<string, unknown>>,
  ledgerInsertError: null as { message: string } | null,
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
        return {
          insert: (row: Record<string, unknown>) => {
            state.ledgerInserts.push(row)
            return Promise.resolve({ error: state.ledgerInsertError })
          },
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
        download: (path: string) =>
          Promise.resolve(
            state.downloadResults.get(path) ?? {
              data: null,
              error: { message: 'Object not found' },
            }
          ),
      }),
    },
  }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeMockClient()),
}))

import { GET, maxDuration } from '../route'

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/documents/verify/cron')
}

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
  state.rpcCalls = []
  state.ledgerInserts = []
  state.ledgerInsertError = null
  state.auditInserts = []
  state.auditInsertError = null
})

describe('GET /api/documents/verify/cron', () => {
  it('returns 401 when the cron secret is invalid', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )

    const response = await GET(cronRequest())

    expect(response.status).toBe(401)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('declares a 300s function budget', () => {
    expect(maxDuration).toBe(300)
  })

  it('draws the batch from the ledger queue, 200 by default, env override honored', async () => {
    await GET(cronRequest())
    expect(state.rpcCalls).toEqual([
      { fn: 'next_documents_for_integrity_check', args: { p_limit: 200 } },
    ])

    process.env.DOCUMENT_VERIFY_BATCH_SIZE = '50'
    await GET(cronRequest())
    expect(state.rpcCalls[1]).toEqual({
      fn: 'next_documents_for_integrity_check',
      args: { p_limit: 50 },
    })
  })

  it('appends a passed ledger row on a successful verification', async () => {
    const doc = makeDoc()
    const hash = registerObject(doc.storage_path, '%PDF-1.4 demo content')
    state.documents = [{ ...doc, sha256_hash: hash }]

    const response = await GET(cronRequest())
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

    const response = await GET(cronRequest())
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

    const response = await GET(cronRequest())
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

    const response = await GET(cronRequest())
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

    const response = await GET(cronRequest())
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

    const response = await GET(cronRequest())
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

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(state.auditInserts).toHaveLength(1)
    expect(state.ledgerInserts).toHaveLength(0)
    expect(json.failures).toBe(0)
    expect(json.writeFailures).toBe(1)
    expect(json.errors).toBe(1)
  })

  it('returns an error envelope when the queue fetch fails', async () => {
    state.fetchError = { message: 'db down' }

    const response = await GET(cronRequest())

    expect(response.status).toBeGreaterThanOrEqual(500)
  })

  it('reports zero processed when there is nothing to verify', async () => {
    const response = await GET(cronRequest())
    const json = await response.json()

    expect(json).toEqual({ message: 'No documents to verify', processed: 0 })
  })
})

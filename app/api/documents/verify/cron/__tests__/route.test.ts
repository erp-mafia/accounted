/**
 * Tests for the nightly document integrity-verify cron.
 *
 * Covers the two production defects fixed in this route:
 * - the run must fit its budget (maxDuration 300 + batch default 200), and
 * - a document whose storage object cannot be downloaded must surface as an
 *   audit incident (INTEGRITY_FAILURE / DOCUMENT_OBJECT_MISSING) AND get its
 *   last_integrity_check_at stamped so it stops head-blocking the
 *   nulls-first queue every night.
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
}

const state = {
  documents: [] as MockDoc[],
  fetchError: null as { message: string } | null,
  downloadResults: new Map<string, { data: unknown; error: { message: string } | null }>(),
  updates: [] as Array<{ values: Record<string, unknown>; id: string }>,
  auditInserts: [] as Array<Record<string, unknown>>,
  auditInsertError: null as { message: string } | null,
  limitCalls: [] as number[],
}

function makeMockClient() {
  return {
    from: (table: string) => {
      if (table === 'document_attachments') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: (n: number) => {
                  state.limitCalls.push(n)
                  return Promise.resolve({ data: state.documents, error: state.fetchError })
                },
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: (_column: string, id: string) => {
              state.updates.push({ values, id })
              return Promise.resolve({ error: null })
            },
          }),
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
  state.updates = []
  state.auditInserts = []
  state.auditInsertError = null
  state.limitCalls = []
})

describe('GET /api/documents/verify/cron', () => {
  it('returns 401 when the cron secret is invalid', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )

    const response = await GET(cronRequest())

    expect(response.status).toBe(401)
    expect(state.limitCalls).toHaveLength(0)
  })

  it('declares a 300s function budget', () => {
    expect(maxDuration).toBe(300)
  })

  it('requests a batch of 200 by default and honors the env override', async () => {
    await GET(cronRequest())
    expect(state.limitCalls).toEqual([200])

    process.env.DOCUMENT_VERIFY_BATCH_SIZE = '50'
    await GET(cronRequest())
    expect(state.limitCalls).toEqual([200, 50])
  })

  it('stamps last_integrity_check_at on a successful verification', async () => {
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
      errors: 0,
    })
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].id).toBe(doc.id)
    expect(state.updates[0].values.last_integrity_check_at).toEqual(expect.any(String))
    expect(state.auditInserts).toHaveLength(0)
  })

  it('writes an INTEGRITY_FAILURE audit row and still stamps on hash mismatch', async () => {
    const doc = makeDoc({ sha256_hash: 'not-the-real-hash' })
    registerObject(doc.storage_path, 'tampered content')
    state.documents = [doc]

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(json.failures).toBe(1)
    expect(json.missingObjects).toBe(0)
    expect(state.updates).toHaveLength(1)
    expect(state.auditInserts).toHaveLength(1)
    expect(state.auditInserts[0].action).toBe('INTEGRITY_FAILURE')
    expect(String(state.auditInserts[0].description)).not.toContain('DOCUMENT_OBJECT_MISSING')
  })

  it('surfaces a missing storage object as an audit incident AND stamps the check', async () => {
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

    // Both documents are stamped: the failing one must stop head-blocking
    // the nulls-first queue, and the healthy one was verified.
    expect(state.updates.map((u) => u.id).sort()).toEqual(['doc-healthy', 'doc-missing'])

    expect(json).toEqual({
      processed: 2,
      verified: 1,
      failures: 0,
      missingObjects: 1,
      errors: 1,
    })
  })

  it('does not stamp a missing object when the audit insert fails, so it retries next run', async () => {
    const missing = makeDoc({ id: 'doc-missing', storage_path: 'user-1/company-1/gone.pdf' })
    state.documents = [missing]
    state.auditInsertError = { message: 'insert blocked' }

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(state.auditInserts).toHaveLength(1)
    expect(state.updates).toHaveLength(0)
    expect(json.missingObjects).toBe(0)
    expect(json.errors).toBe(1)
  })

  it('returns an error envelope when the document fetch fails', async () => {
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

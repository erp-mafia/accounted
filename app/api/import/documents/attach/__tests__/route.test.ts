/**
 * Tests for POST /api/import/documents/attach: archives one underlag file and
 * links it to the SIE-migrated verifikat its filename names.
 *
 * The link is irreversible räkenskapsinformation (BFL 7 kap), so the guards
 * matter more than the happy path: the target must belong to the company, and
 * the automatic path must land where the preview said it would.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const PERIOD_OPEN = '44444444-4444-4444-8444-444444444444'
const PERIOD_OTHER = '55555555-5555-4555-8555-555555555555'

const PERIODS = [
  {
    id: PERIOD_OPEN,
    period_start: '2024-01-01',
    period_end: '2024-12-31',
    is_closed: false,
    locked_at: null,
  },
]

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'

const VOUCHER = {
  id: TARGET_ID,
  fiscal_period_id: PERIOD_OPEN,
  entry_date: '2024-03-14',
  description: 'Inköp kontorsmaterial',
  voucher_series: 'A',
  voucher_number: 47,
  source_voucher_series: 'A',
  source_voucher_number: 31,
}

/** The row the tenant-ownership lookup finds, or null for "not this company". */
let targetEntry: Record<string, unknown> | null = null
/** What the ledger holds for the filename's ref, as the plan would see it. */
let vouchers: Record<string, unknown>[] = []

const supabase = {
  from(table: string) {
    let filteredByNumber = false
    let single = false

    const result = () => {
      if (table === 'fiscal_periods') return { data: PERIODS, error: null, count: PERIODS.length }
      if (single) return { data: targetEntry, error: null }
      return { data: filteredByNumber ? vouchers : [], error: null, count: vouchers.length }
    }

    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'not', 'order', 'limit']) {
      chain[method] = () => chain
    }
    chain.maybeSingle = () => {
      single = true
      return chain
    }
    chain.in = () => {
      filteredByNumber = true
      return chain
    }
    chain.range = () => Promise.resolve(result())
    chain.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(result()).then(onFulfilled)
    return chain
  },
}

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

// Guideline mock: no real Supabase client may ever be constructed in a route
// test, even though this suite injects its double through requireAuth.
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(supabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const getCompanyRoleMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  getCompanyRole: (...args: unknown[]) => getCompanyRoleMock(...args),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const uploadDocumentMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/documents/document-service')>()
  return {
    ...actual,
    uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args),
  }
})

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

function makeRequest(options: {
  fileName?: string
  journalEntryId?: string | null
  /** The year the plan was built against, as the wizard echoes it back. */
  declaredPeriodId?: string | null
  override?: boolean
  withFile?: boolean
  mimeType?: string
}) {
  const form = new FormData()
  if (options.withFile !== false) {
    form.append(
      'file',
      new File(['%PDF-1.4 underlag'], options.fileName ?? 'A31_8c2db060.pdf', {
        type: options.mimeType ?? 'application/pdf',
      }),
    )
  }
  if (options.journalEntryId !== null) {
    form.append('journal_entry_id', options.journalEntryId ?? TARGET_ID)
  }
  if (options.declaredPeriodId !== null) {
    form.append('fiscal_period_id', options.declaredPeriodId ?? PERIOD_OPEN)
  }
  if (options.override) form.append('override', 'true')

  return new Request('http://localhost:3000/api/import/documents/attach', {
    method: 'POST',
    body: form,
  })
}

describe('POST /api/import/documents/attach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    targetEntry = { id: TARGET_ID, fiscal_period_id: PERIOD_OPEN, status: 'posted', source_voucher_series: 'A', source_voucher_number: 31 }
    vouchers = [VOUCHER]
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
    uploadDocumentMock.mockResolvedValue({ id: 'doc-1', file_name: 'A31_8c2db060.pdf' })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await POST(makeRequest({}), emptyParams)

    expect(res.status).toBe(401)
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 when no file was sent', async () => {
    const res = await POST(makeRequest({ withFile: false }), emptyParams)

    expect(res.status).toBe(400)
  })

  it('returns 400 when journal_entry_id is missing or not a uuid', async () => {
    expect((await POST(makeRequest({ journalEntryId: null }), emptyParams)).status).toBe(400)
    expect((await POST(makeRequest({ journalEntryId: 'A31' }), emptyParams)).status).toBe(400)
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the target entry belongs to another company', async () => {
    targetEntry = null

    const res = await POST(makeRequest({}), emptyParams)

    expect(res.status).toBe(404)
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('refuses a target the filename does not resolve to', async () => {
    // The entry exists and is ours, but A31 belongs to a different verifikat:
    // a stale plan in the browser must not scatter underlag permanently.
    vouchers = [{ ...VOUCHER, id: OTHER_ID }]

    const res = await POST(makeRequest({}), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('UNDERLAG_REF_MISMATCH')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the declared fiscal year is missing or not a uuid', async () => {
    expect((await POST(makeRequest({ declaredPeriodId: null }), emptyParams)).status).toBe(400)
    expect((await POST(makeRequest({ declaredPeriodId: '2024' }), emptyParams)).status).toBe(400)
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('refuses a target outside the fiscal year the batch declared', async () => {
    // The user reviewed a plan for one year; this target lives in another.
    // Nothing about the filename can make that acceptable.
    const res = await POST(makeRequest({ declaredPeriodId: PERIOD_OTHER }), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('UNDERLAG_PERIOD_MISMATCH')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('enforces the declared year even on a manual override', async () => {
    // An override is a statement about WHICH verifikat, never about which
    // year, so it must not widen the batch across fiscal years.
    const res = await POST(
      makeRequest({ declaredPeriodId: PERIOD_OTHER, override: true, fileName: 'kvitto.pdf' }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('UNDERLAG_PERIOD_MISMATCH')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('explains a target that never came from a SIE import', async () => {
    targetEntry = { id: TARGET_ID, fiscal_period_id: PERIOD_OPEN, status: 'posted', source_voucher_series: null, source_voucher_number: null }

    const res = await POST(makeRequest({}), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('UNDERLAG_ENTRY_NOT_MIGRATED')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('refuses a target that is not posted, overrides included', async () => {
    // The SIE import posts entries inside its own transaction, so a draft with
    // a source ref should be unreachable. This route does not lean on an
    // invariant enforced in another file: underlag references a verifikation
    // (BFL 5 kap 6-7 §), so the target must BE one.
    targetEntry = { ...targetEntry!, status: 'draft' }

    const auto = await POST(makeRequest({}), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(auto)
    expect(status).toBe(409)
    expect(body.error.code).toBe('UNDERLAG_ENTRY_NOT_POSTED')

    const overridden = await POST(
      makeRequest({ fileName: 'kvitto ica.pdf', override: true }),
      emptyParams,
    )
    expect(overridden.status).toBe(409)
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('accepts a REVERSED target: a storno original keeps its underlag', async () => {
    targetEntry = { ...targetEntry!, status: 'reversed' }

    const res = await POST(makeRequest({}), emptyParams)

    expect(res.status).toBe(200)
    expect(uploadDocumentMock).toHaveBeenCalledOnce()
  })

  it('refuses an override for a filename that resolves to a DIFFERENT target', async () => {
    // The server honors override only for filenames it cannot place. A31.pdf
    // resolves cleanly to another verifikat, so a lying client cannot use
    // override to scatter it.
    vouchers = [{ ...VOUCHER, id: OTHER_ID }]

    const res = await POST(makeRequest({ override: true }), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('UNDERLAG_REF_MISMATCH')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('allows an explicit manual assignment to skip the filename check', async () => {
    targetEntry = { id: TARGET_ID, fiscal_period_id: PERIOD_OPEN, status: 'posted', source_voucher_series: null, source_voucher_number: null }

    const res = await POST(
      makeRequest({ fileName: 'kvitto ica.pdf', override: true }),
      emptyParams,
    )

    expect(res.status).toBe(200)
    expect(uploadDocumentMock).toHaveBeenCalledOnce()
  })

  it('archives and links the file, scoping idempotency to the verifikat', async () => {
    const res = await POST(makeRequest({}), emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('doc-1')

    const [, userId, companyId, file, metadata] = uploadDocumentMock.mock.calls[0]
    expect(userId).toBe('user-1')
    expect(companyId).toBe('company-1')
    expect(file).toMatchObject({ name: 'A31_8c2db060.pdf', type: 'application/pdf' })
    expect(metadata).toMatchObject({
      journal_entry_id: TARGET_ID,
      // Same content on a different verifikat must archive separately, so the
      // key is the entry, not the bytes.
      idempotency_key: TARGET_ID,
      upload_source: 'file_upload',
      // The verifikat is already booked: no per-file model pass (#2188).
      extractionOwner: 'none',
    })
  })

  it('maps the period-lock trigger to a usable error instead of a 500', async () => {
    uploadDocumentMock.mockRejectedValue(
      new Error('Cannot attach documents to entries in a locked/closed fiscal period'),
    )

    const res = await POST(makeRequest({}), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
  })

  it('does not leak storage internals when the archive write fails', async () => {
    uploadDocumentMock.mockRejectedValue(new Error('bucket s3://internal-prod-bucket exploded'))

    const res = await POST(makeRequest({}), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      res,
    )

    expect(status).toBe(500)
    expect(body.error.code).toBe('DOC_UPLOAD_STORAGE_FAILED')
    expect(body.error.message).not.toContain('internal-prod-bucket')
  })
})

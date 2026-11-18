/**
 * Unit tests for gnubok_audit_package.
 *
 * Verifies registration, scope mapping, the estimate-only path, and the
 * size-limit guard. The full archive generation is exercised by
 * lib/reports/full-archive-export tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tools } from '../server'
import { toToolError } from '../tool-result'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { ArchiveTooLargeError } from '@/lib/reports/archive-folder'

vi.mock('@/lib/reports/full-archive-export', () => ({
  generateFullArchive: vi.fn(),
  estimateArchiveSize: vi.fn(),
}))

// The caller's role in the company, read by the shared owner/admin gate.
const mockGetCompanyRole = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return { ...actual, getCompanyRole: (...a: unknown[]) => mockGetCompanyRole(...a) }
})

import {
  generateFullArchive,
  estimateArchiveSize,
} from '@/lib/reports/full-archive-export'

describe('gnubok_audit_package: registration', () => {
  it('is registered', () => {
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')
    expect(tool).toBeDefined()
    expect(tool?.annotations.idempotentHint).toBe(true)
  })

  it('requires fiscal_period_id', () => {
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const schema = tool.inputSchema as { required?: string[] }
    expect(schema.required).toContain('fiscal_period_id')
  })

  it('is mapped to reports:read scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_audit_package).toBe('reports:read')
  })
})

function makePeriodMock(period: Record<string, unknown> | null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: period,
              error: period ? null : { message: 'not found' },
            }),
          }),
        }),
      }),
    }),
    storage: {
      from: vi.fn(),
    },
  } as never
}

describe('gnubok_audit_package: owner or admin only', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The archive carries the period's whole audit log (full snapshots of
  // settings, bank details, suppliers); the dashboard refuses it below
  // owner/admin, and a reports:read key held by a member or viewer did not.
  it.each(['member', 'viewer'])('refuses a %s with FORBIDDEN before any read, estimate or archive', async (role) => {
    mockGetCompanyRole.mockResolvedValue({ ok: true, role, companyId: 'company-1' })
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const supabase = makePeriodMock({ id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' })

    await expect(
      tool.execute({ fiscal_period_id: 'p1' }, 'company-1', 'user-1', supabase),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/ägare eller en administratör/) })
    await expect(
      tool.execute({ fiscal_period_id: 'p1', estimate_only: true }, 'company-1', 'user-1', supabase),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(mockGetCompanyRole).toHaveBeenCalledWith(supabase, 'user-1', { companyId: 'company-1' })
    expect((supabase as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled()
    expect(estimateArchiveSize).not.toHaveBeenCalled()
    expect(generateFullArchive).not.toHaveBeenCalled()
  })

  it('refuses a caller with no membership in the company', async () => {
    mockGetCompanyRole.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) })
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!

    await expect(
      tool.execute({ fiscal_period_id: 'p1', estimate_only: true }, 'company-1', 'user-1', makePeriodMock(null)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(estimateArchiveSize).not.toHaveBeenCalled()
  })

  it.each(['owner', 'admin'])('lets an %s through', async (role) => {
    mockGetCompanyRole.mockResolvedValue({ ok: true, role, companyId: 'company-1' })
    vi.mocked(estimateArchiveSize).mockResolvedValue({ total_bytes: 1024, breakdown: {} as never } as never)
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const supabase = makePeriodMock({ id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' })

    const result = (await tool.execute(
      { fiscal_period_id: 'p1', estimate_only: true }, 'company-1', 'user-1', supabase,
    )) as { estimate_only: boolean }

    expect(result.estimate_only).toBe(true)
    expect(estimateArchiveSize).toHaveBeenCalled()
  })

  it('says so in the description', () => {
    expect(tools.find((t) => t.name === 'gnubok_audit_package')!.description).toMatch(/Owner or admin only/)
  })
})

describe('gnubok_audit_package: execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCompanyRole.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
  })

  it('estimate_only=true returns size estimate without uploading', async () => {
    vi.mocked(estimateArchiveSize).mockResolvedValue({
      total_bytes: 5 * 1024 * 1024,
      breakdown: {} as never,
    } as never)

    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const supabase = makePeriodMock({
      id: 'p1', name: '2026',
      period_start: '2026-01-01', period_end: '2026-12-31',
    })

    const result = (await tool.execute(
      { fiscal_period_id: 'p1', estimate_only: true },
      'company-1',
      'user-1',
      supabase,
    )) as {
      estimate_only: boolean
      download_url: string | null
      download_headers: Record<string, string>
      app_url: string
      size_bytes: number
      within_limit: boolean
    }

    expect(result.estimate_only).toBe(true)
    expect(result.download_url).toBeNull()
    // Always an object, so a client can pass it along without looking.
    expect(result.download_headers).toEqual({})
    // The session route builds the archive on the click, so the user's link
    // is there for an estimate too.
    expect(result.app_url).toMatch(/\/api\/reports\/full-archive\?scope=period&period_id=p1$/)
    expect(result.size_bytes).toBe(5 * 1024 * 1024)
    expect(result.within_limit).toBe(true)
    expect(generateFullArchive).not.toHaveBeenCalled()
  })

  it('throws when archive would exceed size limit and include_documents=true', async () => {
    vi.mocked(estimateArchiveSize).mockResolvedValue({
      total_bytes: 100 * 1024 * 1024,  // > 50 MB limit
      breakdown: {} as never,
    } as never)

    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const supabase = makePeriodMock({
      id: 'p1', name: '2026',
      period_start: '2026-01-01', period_end: '2026-12-31',
    })

    await expect(
      tool.execute(
        { fiscal_period_id: 'p1' },
        'company-1', 'user-1', supabase,
      ),
    ).rejects.toMatchObject({ code: 'AUDIT_PACKAGE_TOO_LARGE', message: expect.stringMatching(/exceed.*MB/) })
  })

  it('refuses before building a package the documents bucket could never store (50 MB), not at the old 80 MB', async () => {
    vi.mocked(estimateArchiveSize).mockResolvedValue({ total_bytes: 60 * 1024 * 1024 } as never)
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const supabase = makePeriodMock({ id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' })

    await expect(tool.execute({ fiscal_period_id: 'p1' }, 'company-1', 'user-1', supabase)).rejects.toMatchObject({
      code: 'AUDIT_PACKAGE_TOO_LARGE',
    })
    expect(generateFullArchive).not.toHaveBeenCalled()

    const estimate = (await tool.execute({ fiscal_period_id: 'p1', estimate_only: true }, 'company-1', 'user-1', supabase)) as {
      size_limit_bytes: number
      within_limit: boolean
    }
    expect(estimate).toMatchObject({ size_limit_bytes: 50 * 1024 * 1024, within_limit: false })
  })

  it('throws when fiscal period is not found', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const supabase = makePeriodMock(null)

    await expect(
      tool.execute(
        { fiscal_period_id: 'nonexistent' },
        'company-1', 'user-1', supabase,
      ),
    ).rejects.toThrow(/Fiscal period not found/)
  })
})

// CASA 2.1.1: the link is served from the app origin and its signed token
// travels in download_headers, never in the URL.
describe('gnubok_audit_package: the download link carries no token', () => {
  const SUPABASE = 'https://pwxtzglxptnnvjrpixpg.supabase.co'

  function makeSignedMock(signedUrl: string) {
    const supabase = makePeriodMock({
      id: 'p1', name: '2026',
      period_start: '2026-01-01', period_end: '2026-12-31',
    }) as unknown as { storage: { from: ReturnType<typeof vi.fn> } }
    supabase.storage.from.mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
      remove: vi.fn(),
      createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl }, error: null }),
    })
    return supabase as never
  }

  const run = (supabase: never, args: Record<string, unknown> = {}) =>
    tools.find((t) => t.name === 'gnubok_audit_package')!.execute({ fiscal_period_id: 'p1', ...args }, 'company-1', 'user-1', supabase) as Promise<{
      download_url: string
      download_headers: Record<string, string>
      download_note?: string
      app_url: string
    }>

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCompanyRole.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
    vi.mocked(estimateArchiveSize).mockResolvedValue({ total_bytes: 1024 } as never)
    vi.mocked(generateFullArchive).mockResolvedValue(new ArrayBuffer(8))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('answers the app-origin URL without the token, the token in download_headers, and how the zip reaches the user', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')

    const result = await run(makeSignedMock(`${SUPABASE}/storage/v1/object/sign/documents/user-1/audit-packages/1_arkiv_2026_p1.zip?token=tok`))

    expect(result.download_url).toBe('https://app.accounted.se/api/storage/sign/documents/user-1/audit-packages/1_arkiv_2026_p1.zip')
    expect(result.download_headers).toEqual({ Authorization: 'Bearer tok' })
    // The link for the user: the session route that builds the same period
    // archive, behind their own login, with no token in it.
    expect(result.app_url).toBe('https://app.accounted.se/api/reports/full-archive?scope=period&period_id=p1')
    expect(result.app_url).not.toContain('tok')
    expect(result.download_note).toMatch(/^Give the user app_url.*owner or admin/)
    expect(result.download_note).toMatch(/download_url with download_headers is for a client.*does not open as a link in a browser/)
  })

  it('asks the session route for the same package: without documents when the call left them out', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')

    const result = await run(
      makeSignedMock(`${SUPABASE}/storage/v1/object/sign/documents/user-1/audit-packages/1_arkiv_2026_p1.zip?token=tok`),
      { include_documents: false },
    )

    expect(result.app_url).toBe('https://app.accounted.se/api/reports/full-archive?scope=period&period_id=p1&include_documents=false')
  })

  it('hands out the raw signed URL with no headers and no note where it cannot be rewritten (self-host without NEXT_PUBLIC_APP_URL)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const signedUrl = `${SUPABASE}/storage/v1/object/sign/documents/user-1/audit-packages/1_arkiv_2026_p1.zip?token=tok`

    const result = await run(makeSignedMock(signedUrl))

    expect(result.download_url).toBe(signedUrl)
    expect(result.download_headers).toEqual({})
    expect(result).not.toHaveProperty('download_note')
    // No origin is known: the path, never a localhost URL.
    expect(result.app_url).toBe('/api/reports/full-archive?scope=period&period_id=p1')
  })

  it('says in the schema that the link needs download_headers and that app_url is the one for the user', () => {
    const properties = (tools.find((t) => t.name === 'gnubok_audit_package')!.outputSchema as {
      properties: Record<string, { description?: string }>
    }).properties
    expect(properties.download_url.description).toContain('download_headers')
    expect(properties.download_url.description).toContain('for the user: app_url')
  })
})

describe('gnubok_audit_package: an archive Storage refuses as too large', () => {
  // The documents bucket caps one file at 50 MB, below the tool's 80 MB
  // estimate gate: an archive between the two was built, then refused by
  // Storage and surfaced as UNKNOWN_ERROR ("Något gick fel. Försök igen."),
  // retry advice for a call that can never succeed.
  function makeUploadMock(uploadError: Record<string, unknown>) {
    const upload = vi.fn().mockResolvedValue({ data: null, error: uploadError })
    const supabase = makePeriodMock({
      id: 'p1', name: '2026',
      period_start: '2026-01-01', period_end: '2026-12-31',
    }) as unknown as { storage: { from: ReturnType<typeof vi.fn> } }
    supabase.storage.from.mockReturnValue({ upload, remove: vi.fn(), createSignedUrl: vi.fn() })
    return supabase as never
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCompanyRole.mockResolvedValue({ ok: true, role: 'admin', companyId: 'company-1' })
    vi.mocked(estimateArchiveSize).mockResolvedValue({ total_bytes: 40 * 1024 * 1024 } as never) // under the 50 MB gate; a bucket cap lowered later
    vi.mocked(generateFullArchive).mockResolvedValue({ byteLength: 57 * 1024 * 1024 } as never)
  })

  async function refusal(args: Record<string, unknown>, uploadError: Record<string, unknown>) {
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const thrown = await tool.execute(args, 'company-1', 'user-1', makeUploadMock(uploadError)).catch((err: unknown) => err)
    return toToolError(thrown).error
  }

  const TOO_LARGE = { message: 'The object exceeded the maximum allowed size', status: 413, statusCode: '413' }

  it('is AUDIT_PACKAGE_TOO_LARGE, not retryable, pointing back at include_documents=false', async () => {
    const error = await refusal({ fiscal_period_id: 'p1' }, TOO_LARGE)

    expect(error).toMatchObject({ code: 'AUDIT_PACKAGE_TOO_LARGE', retryable: false })
    expect(error.message_en).toMatch(/^The 57 MB archive is over the storage limit/)
    expect(error.message_en).toMatch(/include_documents=false/)
    expect(error.message_sv).toMatch(/för stort/)
    expect(error.remediation?.tool).toBe('gnubok_audit_package')
  })

  it('does not suggest include_documents=false when the call already left documents out', async () => {
    const error = await refusal({ fiscal_period_id: 'p1', include_documents: false }, TOO_LARGE)
    expect(error.code).toBe('AUDIT_PACKAGE_TOO_LARGE')
    expect(error.message_en).not.toMatch(/include_documents=false/)
  })

  it('leaves any other upload failure uncoded', async () => {
    const error = await refusal({ fiscal_period_id: 'p1' }, { message: 'Bucket not found', status: 404, statusCode: '404' })
    expect(error.code).not.toBe('AUDIT_PACKAGE_TOO_LARGE')
    expect(error.message_en).toBe('Failed to upload archive: Bucket not found')
  })
})

describe('gnubok_audit_package: a period whose behandlingshistorik alone is too large (crm#1703)', () => {
  // Documents were the only part the estimate counted: a period with 50 000
  // audit rows held them all, then their JSON, then the ZIP, and the function
  // ran out of memory, answering a platform HTML 500 instead of a JSON-RPC
  // result. The build now stops at the cap and the tool answers a typed error.
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCompanyRole.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
    vi.mocked(estimateArchiveSize).mockResolvedValue({ total_bytes: 9 * 1024 * 1024 } as never)
    vi.mocked(generateFullArchive).mockRejectedValue(new ArchiveTooLargeError(50 * 1024 * 1024))
  })

  async function refusal(args: Record<string, unknown>) {
    const tool = tools.find((t) => t.name === 'gnubok_audit_package')!
    const supabase = makePeriodMock({ id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' })
    const thrown = await tool.execute(args, 'company-1', 'user-1', supabase).catch((err: unknown) => err)
    return toToolError(thrown).error
  }

  it('builds with the cap as max_bytes and answers AUDIT_PACKAGE_TOO_LARGE, not retryable', async () => {
    const error = await refusal({ fiscal_period_id: 'p1' })

    expect(generateFullArchive).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      scope: 'period',
      period_id: 'p1',
      include_documents: true,
      max_bytes: 50 * 1024 * 1024,
    })
    expect(error).toMatchObject({ code: 'AUDIT_PACKAGE_TOO_LARGE', retryable: false })
    expect(error.message_en).toMatch(/include_documents=false/)
  })

  it('points at the web archive, not include_documents=false, when documents were already left out', async () => {
    const error = await refusal({ fiscal_period_id: 'p1', include_documents: false })
    expect(error.code).toBe('AUDIT_PACKAGE_TOO_LARGE')
    expect(error.message_en).toMatch(/behandlingshistorik/)
    expect(error.message_en).not.toMatch(/include_documents=false/)
  })

  it('lets any other failure through as it was', async () => {
    vi.mocked(generateFullArchive).mockRejectedValue(new Error('boom'))
    const error = await refusal({ fiscal_period_id: 'p1' })
    expect(error.code).not.toBe('AUDIT_PACKAGE_TOO_LARGE')
  })
})

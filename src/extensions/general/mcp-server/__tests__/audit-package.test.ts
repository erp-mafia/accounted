/**
 * Unit tests for gnubok_audit_package.
 *
 * Verifies registration, scope mapping, the estimate-only path, and the
 * size-limit guard. The full archive generation is exercised by
 * lib/reports/full-archive-export tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
import { toToolError } from '../tool-result'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

vi.mock('@/lib/reports/full-archive-export', () => ({
  generateFullArchive: vi.fn(),
  estimateArchiveSize: vi.fn(),
}))

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

describe('gnubok_audit_package: execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      size_bytes: number
      within_limit: boolean
    }

    expect(result.estimate_only).toBe(true)
    expect(result.download_url).toBeNull()
    expect(result.size_bytes).toBe(5 * 1024 * 1024)
    expect(result.within_limit).toBe(true)
    expect(generateFullArchive).not.toHaveBeenCalled()
  })

  it('throws when archive would exceed size limit and include_documents=true', async () => {
    vi.mocked(estimateArchiveSize).mockResolvedValue({
      total_bytes: 100 * 1024 * 1024,  // > 80 MB limit
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
    vi.mocked(estimateArchiveSize).mockResolvedValue({ total_bytes: 60 * 1024 * 1024 } as never) // under the 80 MB gate
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
